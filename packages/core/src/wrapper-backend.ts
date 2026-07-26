import type { SessionBackend } from './backend.js';

/**
 * Outgoing channel from server → wrapper process.
 * Implementations send each call as a WS message to the wrapper.
 */
export interface WrapperBackendOutgoing {
  sendInput(data: string): void;
  sendResize(cols: number, rows: number): void;
  sendKill(signal?: string): void;
}

/**
 * Server-side proxy for a PTY that actually lives in a wrapper process.
 * The /wrap WS handler:
 *   - constructs one of these,
 *   - calls pushData() for each `pty` frame from the wrapper,
 *   - calls pushExit() when the wrapper sends `exit`,
 *   - and forwards input/resize/kill TO the wrapper via the `out` channel.
 */
export class WrapperBackend implements SessionBackend {
  private readonly dataHandlers = new Set<(chunk: Buffer) => void>();
  private readonly exitHandlers = new Set<(code: number, signal?: number) => void>();
  private disposed = false;
  private _ownSize: { cols: number; rows: number } | undefined;
  private _ownSizeListener: (() => void) | undefined;
  private out: WrapperBackendOutgoing | undefined;
  private binding: symbol | undefined;

  constructor(out?: WrapperBackendOutgoing) {
    if (out) this.bind(out);
  }

  /**
   * Attach a live wrapper transport. The returned unbind callback is scoped to
   * this exact binding, so a stale socket close cannot detach a newer socket.
   */
  bind(out: WrapperBackendOutgoing): () => void {
    if (this.disposed) return () => {};
    const binding = Symbol('wrapper-transport');
    this.out = out;
    this.binding = binding;
    return () => {
      if (this.binding !== binding) return;
      this.binding = undefined;
      this.out = undefined;
    };
  }

  get isBound(): boolean {
    return !this.disposed && this.out !== undefined;
  }

  // ─── Own-size negotiation (wrapper's local terminal) ─────────────────────

  getOwnSize(): { cols: number; rows: number } | undefined {
    return this._ownSize;
  }

  setOwnSizeListener(listener: () => void): void {
    this._ownSizeListener = listener;
  }

  /** Called by the /wrap handler when the wrapper reports its local-terminal
   *  size on connect or on local-resize. Pass `undefined` to drop participation
   *  (e.g. headless wrappers explicitly opt out). */
  setLocalSize(size: { cols: number; rows: number } | undefined): void {
    if (this.disposed) return;
    this._ownSize = size;
    this._ownSizeListener?.();
  }

  // ─── SessionBackend (browser → wrapper direction) ────────────────────────

  write(data: string): void {
    if (this.disposed) return;
    this.out?.sendInput(data);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols > 0 && rows > 0) this.out?.sendResize(cols, rows);
  }

  kill(signal?: string): void {
    if (this.disposed) return;
    this.out?.sendKill(signal);
  }

  onData(handler: (chunk: Buffer) => void): void {
    this.dataHandlers.add(handler);
  }

  onExit(handler: (code: number, signal?: number) => void): void {
    this.exitHandlers.add(handler);
  }

  dispose(): void {
    this.disposed = true;
    this.binding = undefined;
    this.out = undefined;
    this.dataHandlers.clear();
    this.exitHandlers.clear();
  }

  // ─── Server-side push API (wrapper → browser direction) ──────────────────

  pushData(chunk: Buffer): void {
    if (this.disposed) return;
    for (const h of this.dataHandlers) h(chunk);
  }

  pushExit(code: number, signal?: number): void {
    if (this.disposed) return;
    for (const h of this.exitHandlers) h(code, signal);
  }
}
