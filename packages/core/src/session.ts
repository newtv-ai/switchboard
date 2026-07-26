import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  type AgentAdapter,
  type AgentCapability,
  type AgentEvent,
  type AgentState,
  type Parser,
  type SessionHandle,
  type SpecialKey,
  keyBytes,
} from '@switchboard/sdk';
import type { SessionBackend } from './backend.js';
import { RingBuffer } from './ring-buffer.js';

export type SessionSource = 'spawned' | 'wrapped';

export interface CreateSessionOpts {
  adapter: AgentAdapter;
  cwd: string;
  backend: SessionBackend;
  source: SessionSource;
  name?: string;
  /** Original command basename (e.g. 'claude', 'codex') for adapter-specific behaviour. */
  commandName?: string;
  enableParser?: boolean;
  bufferSize?: number;
}

export interface SessionListener {
  onData?(chunk: Buffer): void;
  onEvent?(event: AgentEvent): void;
  onState?(state: AgentState): void;
  onExit?(code: number, signal?: number): void;
  /** Called after the PTY is resized (refit negotiation result). */
  onResize?(cols: number, rows: number): void;
  /**
   * Called when the backend transport connects or disconnects (wrapper
   * reconnecting). While disconnected, writes are refused rather than dropped.
   */
  onTransport?(connected: boolean): void;
}

export interface ClientHandle {
  /** Update this client's reported viewport so the PTY can re-fit to all attached clients. */
  resize(cols: number, rows: number): void;
  /** Stop receiving events and stop contributing to the PTY size computation. */
  detach(): void;
}

export interface SessionSummary {
  id: string;
  name: string;
  adapterId: string;
  adapterDisplayName: string;
  source: SessionSource;
  cwd: string;
  state: AgentState;
  createdAt: string;
  lastActivityAt: string;
  bufferBytes: number;
  /** false while a wrapped Session's transport is mid-reconnect. */
  connected: boolean;
}

const DEFAULT_BUFFER_SIZE = 2 * 1024 * 1024;

interface ClientRecord {
  listener: SessionListener;
  size?: { cols: number; rows: number };
}

export class Session implements SessionHandle {
  readonly id: string;
  readonly name: string;
  readonly adapter: AgentAdapter;
  readonly cwd: string;
  readonly source: SessionSource;
  readonly commandName?: string;
  readonly createdAt: Date;

  private readonly backend: SessionBackend;
  private readonly buffer: RingBuffer;
  private readonly parser: Parser | undefined;
  private readonly clients = new Map<string, ClientRecord>();

  private _state: AgentState = 'starting';
  private _lastActivityAt: Date;

  constructor(opts: CreateSessionOpts) {
    this.id = randomUUID();
    this.adapter = opts.adapter;
    this.cwd = opts.cwd;
    this.source = opts.source;
    this.commandName = opts.commandName;
    this.name = opts.name ?? `${opts.adapter.manifest.id}@${basename(opts.cwd) || 'root'}`;
    this.createdAt = new Date();
    this._lastActivityAt = this.createdAt;
    this.backend = opts.backend;
    this.buffer = new RingBuffer(opts.bufferSize ?? DEFAULT_BUFFER_SIZE);

    const wantParser = opts.enableParser ?? true;
    this.parser = wantParser ? opts.adapter.createParser?.() : undefined;

    this.transitionState('running');

    this.backend.onData((chunk) => {
      this.buffer.write(chunk);
      this._lastActivityAt = new Date();
      const clients = [...this.clients.values()];
      for (const c of clients) c.listener.onData?.(chunk);

      if (this.parser) {
        let events: readonly AgentEvent[] = [];
        try {
          events = this.parser.feed(chunk);
        } catch {
          events = [];
        }
        for (const ev of events) {
          for (const c of clients) c.listener.onEvent?.(ev);
        }
        const next = this.parser.getState();
        if (next !== this._state) this.transitionState(next);
      }
    });

    this.backend.onExit((code, signal) => {
      this.transitionState('exited');
      for (const c of [...this.clients.values()]) c.listener.onExit?.(code, signal);
    });

    // Backends with their own viewport (e.g. a wrapper's local terminal)
    // participate in the size negotiation alongside attached browser clients.
    this.backend.setOwnSizeListener?.(() => this.refitToClients());

    this.backend.setConnectionListener?.(() => {
      const connected = this.connected;
      for (const c of [...this.clients.values()]) c.listener.onTransport?.(connected);
    });
  }

  // ─── SessionHandle (write paths) ─────────────────────────────────────────

  /** @returns false when the backend transport is down and the data was NOT
   *  delivered — callers surface that instead of pretending it was typed. */
  write(data: string): boolean {
    if (!this.connected) return false;
    this.backend.write(data);
    return true;
  }

  sendKey(key: SpecialKey): boolean {
    return this.write(keyBytes(key));
  }

  // ─── Attach / detach ─────────────────────────────────────────────────────

  /**
   * Attach a client. If `initialSize` is provided, this client contributes to
   * the PTY size negotiation (max across all sized clients wins). Listeners
   * without an initialSize (e.g. the SessionManager's exit-cleanup listener)
   * don't participate in sizing.
   */
  attach(listener: SessionListener, initialSize?: { cols: number; rows: number }): ClientHandle {
    const clientId = randomUUID();
    // Local copy: the resize() closure buffers the latest size here until the
    // grace-period timeout marks the client ready (avoids reassigning the param).
    let pendingSize = initialSize;
    let isReady = !pendingSize;
    this.clients.set(clientId, { listener, size: undefined });
    if (pendingSize) {
      const t = setTimeout(() => {
        const client = this.clients.get(clientId);
        if (client) {
          isReady = true;
          client.size = pendingSize;
          this.refitToClients();
        }
      }, 1200);
      if (typeof t.unref === 'function') t.unref();
    }

    return {
      resize: (cols, rows) => {
        const c = this.clients.get(clientId);
        if (!c) return;
        if (!isReady) {
          pendingSize = { cols, rows };
          return;
        }
        c.size = { cols, rows };
        this.refitToClients();
      },
      detach: () => {
        const had = this.clients.get(clientId);
        this.clients.delete(clientId);
        if (process.env.SWITCHBOARD_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(
            `[switchboard:debug] detach session=${this.id.slice(0, 8)} client=${clientId.slice(0, 8)} hadSize=${JSON.stringify(had?.size)} remaining=${this.clients.size}`,
          );
        }
        if (had?.size) this.refitToClients();
      },
    };
  }

  /** Number of browser/phone clients currently attached (excludes backend). */
  get clientCount(): number {
    return this.clients.size;
  }

  // ─── Control ─────────────────────────────────────────────────────────────

  /** @returns false when the request could not reach the process (see write). */
  kill(signal?: string): boolean {
    if (!this.connected) return false;
    this.backend.kill(signal);
    return true;
  }

  /** False while a wrapped Session's transport is between sockets. */
  get connected(): boolean {
    return this.backend.isConnected?.() ?? true;
  }

  /** Bytes retained for replay on attach. */
  getReplay(): Buffer {
    return this.buffer.getAll();
  }

  get state(): AgentState {
    return this._state;
  }

  get lastActivityAt(): Date {
    return this._lastActivityAt;
  }

  get capabilities(): readonly AgentCapability[] {
    return this.parser ? this.adapter.manifest.capabilities : [];
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      name: this.name,
      adapterId: this.adapter.manifest.id,
      adapterDisplayName: this.adapter.manifest.displayName,
      source: this.source,
      cwd: this.cwd,
      state: this._state,
      createdAt: this.createdAt.toISOString(),
      lastActivityAt: this._lastActivityAt.toISOString(),
      bufferBytes: this.buffer.size,
      connected: this.connected,
    };
  }

  dispose(): void {
    this.clients.clear();
    this.backend.dispose();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private refitToClients(): void {
    // PTY size policy: MIN cols + MIN rows across all attached clients.
    //
    // I tried MAX cols (so wider clients render fully) — but xterm.js can't
    // sanely render PTY content wider than its own column count. Cursor moves
    // to col N where N > xterm.cols get clipped/wrapped to undefined positions,
    // producing scrambled output (overlapping fragments of slash command names
    // and descriptions). The narrow client becomes unusable.
    //
    // MIN cols means the PTY is sized for the SMALLEST attached client. Wider
    // clients (e.g. desktop browser) see claude's TUI rendered at the small
    // size, with extra empty space on the right. That's visually awkward on
    // desktop but everything renders CORRECTLY. The tradeoff favours the
    // smaller client — which matches the project's primary use case (phone is
    // the constrained primary device; desktop is auxiliary).
    let minCols = Number.POSITIVE_INFINITY;
    let minRows = Number.POSITIVE_INFINITY;
    let count = 0;
    for (const c of this.clients.values()) {
      if (!c.size) continue;
      count++;
      if (c.size.cols < minCols) minCols = c.size.cols;
      if (c.size.rows < minRows) minRows = c.size.rows;
    }
    // Backend's own viewport (wrapper's local terminal):
    //   - COLS: always participates in MIN — wider-than-xterm content scrambles
    //   - ROWS: only used as FALLBACK when no browser client has reported size.
    //     The desktop terminal scrolls natively so taller output is harmless,
    //     but clamping rows to the desktop's small viewport wastes the bottom
    //     of every mobile screen.
    const ownSize = this.backend.getOwnSize?.();
    if (ownSize) {
      if (ownSize.cols < minCols) minCols = ownSize.cols;
      if (count === 0) {
        // No browser client — use wrapper's rows as fallback
        if (ownSize.rows < minRows) minRows = ownSize.rows;
      }
      count++;
    }
    if (count > 0 && Number.isFinite(minCols) && Number.isFinite(minRows)) {
      if (process.env.SWITCHBOARD_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(
          `[switchboard:debug] refit session=${this.id.slice(0, 8)} clients=${this.clients.size} ownSize=${JSON.stringify(this.backend.getOwnSize?.())} -> resize(${minCols},${minRows})`,
        );
      }
      this.backend.resize(minCols, minRows);
      for (const c of [...this.clients.values()]) c.listener.onResize?.(minCols, minRows);
    }
  }

  private transitionState(next: AgentState): void {
    if (next === this._state) return;
    this._state = next;
    for (const c of [...this.clients.values()]) c.listener.onState?.(next);
  }
}
