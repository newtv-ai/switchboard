import type { AgentAdapter, AgentManifest } from '@switchboard/sdk';
import type { SessionBackend } from './backend.js';
import { LocalPtyBackend } from './local-pty-backend.js';
import { resolveCommand } from './resolve-command.js';
import { Session, type SessionSummary } from './session.js';

export interface SpawnOpts {
  adapterId: string;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  cols?: number;
  rows?: number;
  name?: string;
}

export interface SpawnRawOpts {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  cols?: number;
  rows?: number;
  name?: string;
}

export interface RegisterOpts {
  adapterId: string;
  cwd: string;
  backend: SessionBackend;
  name?: string;
  /** Original command basename (e.g. 'claude') for adapter-specific behaviour. */
  commandName?: string;
  /** Wrapped sessions skip the parser by default — TUI output isn't structured. */
  enableParser?: boolean;
}

export interface SessionManagerOpts {
  activityBroadcastIntervalMs?: number;
}

export type SessionManagerEvent =
  | { type: 'created'; sessionId: string }
  | { type: 'updated'; sessionId: string; reason: 'activity' | 'state' | 'transport' }
  | { type: 'exited'; sessionId: string }
  | { type: 'removed'; sessionId: string };

export type SessionManagerListener = (event: SessionManagerEvent) => void;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const DEFAULT_ACTIVITY_BROADCAST_INTERVAL_MS = 1000;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly listeners = new Set<SessionManagerListener>();
  private readonly activityTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastActivityBroadcastAt = new Map<string, number>();
  private readonly activityBroadcastIntervalMs: number;

  constructor(opts: SessionManagerOpts = {}) {
    const interval = opts.activityBroadcastIntervalMs ?? DEFAULT_ACTIVITY_BROADCAST_INTERVAL_MS;
    this.activityBroadcastIntervalMs = Number.isFinite(interval)
      ? Math.max(0, interval)
      : DEFAULT_ACTIVITY_BROADCAST_INTERVAL_MS;
  }

  registerAdapter(adapter: AgentAdapter): void {
    const id = adapter.manifest.id;
    if (this.adapters.has(id)) {
      throw new Error(`Adapter already registered: ${id}`);
    }
    if (adapter.manifest.capabilities.length > 0 && !adapter.createParser) {
      // A capability claim with no parser can never emit the events it
      // promises, so the UI must not advertise it. Drop the claim rather than
      // throwing: a third-party adapter with a bad manifest should lose its
      // structured features, not take the whole server down at startup.
      // eslint-disable-next-line no-console
      console.warn(
        `[switchboard] adapter "${id}" declares capabilities (${adapter.manifest.capabilities.join(', ')}) but has no createParser(); ignoring them`,
      );
      this.adapters.set(id, {
        ...adapter,
        manifest: { ...adapter.manifest, capabilities: [] },
      });
      return;
    }
    this.adapters.set(id, adapter);
  }

  listAdapters(): AgentManifest[] {
    return Array.from(this.adapters.values()).map((a) => a.manifest);
  }

  getAdapter(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Mode B: server spawns a fresh process via node-pty. */
  spawn(opts: SpawnOpts): Session {
    const adapter = this.requireAdapter(opts.adapterId);
    const spawnCfg = adapter.buildCommand({ cwd: opts.cwd, env: opts.env });

    const backend = new LocalPtyBackend({
      command: resolveCommand(spawnCfg.command),
      args: spawnCfg.args,
      env: spawnCfg.env,
      cwd: spawnCfg.cwd,
      cols: opts.cols ?? DEFAULT_COLS,
      rows: opts.rows ?? DEFAULT_ROWS,
    });

    return this.attachSession(
      new Session({
        adapter,
        cwd: opts.cwd,
        backend,
        source: 'spawned',
        name: opts.name,
        enableParser: true,
      }),
    );
  }

  /** Start a detected CLI without a dedicated adapter in raw PTY mode. */
  spawnRaw(opts: SpawnRawOpts): Session {
    const command = opts.command.trim();
    if (!command) throw new Error('Raw command is required');
    const adapter = this.requireAdapter('passthrough');
    const backend = new LocalPtyBackend({
      command: resolveCommand(command),
      args: [...(opts.args ?? [])],
      env: {
        ...(process.env as Record<string, string>),
        ...(opts.env ?? {}),
        TERM: 'xterm-256color',
      },
      cwd: opts.cwd,
      cols: opts.cols ?? DEFAULT_COLS,
      rows: opts.rows ?? DEFAULT_ROWS,
    });

    return this.attachSession(
      new Session({
        adapter,
        cwd: opts.cwd,
        backend,
        source: 'spawned',
        name: opts.name,
        commandName: command,
        enableParser: false,
      }),
    );
  }

  /** Mode A: a wrapper process owns the PTY; we just relay. */
  register(opts: RegisterOpts): Session {
    const adapter = this.requireAdapter(opts.adapterId);
    return this.attachSession(
      new Session({
        adapter,
        cwd: opts.cwd,
        backend: opts.backend,
        source: 'wrapped',
        name: opts.name,
        commandName: opts.commandName,
        // Wrapped sessions are raw TUI by default — running an NDJSON parser
        // on ANSI byte streams would emit nothing and waste cycles.
        enableParser: opts.enableParser ?? false,
      }),
    );
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Newest first, by creation time. Deliberately NOT by lastActivityAt: the
   * list is pushed live now, and sorting by activity makes rows swap places
   * under the user's finger every time a session prints something.
   */
  list(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .map((s) => s.summary())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  subscribe(listener: SessionManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Release server-owned resources during shutdown. Wrapped PTYs belong to
   * their wrapper process and must survive a Switchboard server restart.
   */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.source === 'spawned') {
        try {
          session.kill();
        } catch {
          // process may already be dead
        }
      }
      session.dispose();
    }
    this.sessions.clear();
    this.clearActivityTimers();
    this.listeners.clear();
  }

  private requireAdapter(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown adapter: ${id}`);
    return adapter;
  }

  private attachSession(session: Session): Session {
    this.sessions.set(session.id, session);
    // Cleanup-only listener: no initialSize means it does NOT participate in
    // PTY-size negotiation (see Session.attach docs).
    session.attach({
      onData: () => this.scheduleActivityUpdate(session.id),
      onState: () => this.emit({ type: 'updated', sessionId: session.id, reason: 'state' }),
      onTransport: () => this.emit({ type: 'updated', sessionId: session.id, reason: 'transport' }),
      onExit: () => {
        // For v1, sessions are removed on exit. Persistent sessions are
        // deferred (SPEC §9 Q3).
        const s = this.sessions.get(session.id);
        if (s) {
          this.cancelActivityUpdate(session.id);
          this.emit({ type: 'exited', sessionId: session.id });
          s.dispose();
          this.sessions.delete(session.id);
          this.emit({ type: 'removed', sessionId: session.id });
        }
      },
    });
    this.lastActivityBroadcastAt.set(session.id, Date.now());
    this.emit({ type: 'created', sessionId: session.id });
    return session;
  }

  private scheduleActivityUpdate(sessionId: string): void {
    if (this.activityTimers.has(sessionId)) return;

    const last = this.lastActivityBroadcastAt.get(sessionId) ?? 0;
    const remaining = Math.max(0, this.activityBroadcastIntervalMs - (Date.now() - last));
    const timer = setTimeout(() => {
      this.activityTimers.delete(sessionId);
      if (!this.sessions.has(sessionId)) return;
      this.lastActivityBroadcastAt.set(sessionId, Date.now());
      this.emit({ type: 'updated', sessionId, reason: 'activity' });
    }, remaining);
    if (typeof timer.unref === 'function') timer.unref();
    this.activityTimers.set(sessionId, timer);
  }

  private cancelActivityUpdate(sessionId: string): void {
    const timer = this.activityTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.activityTimers.delete(sessionId);
    this.lastActivityBroadcastAt.delete(sessionId);
  }

  private clearActivityTimers(): void {
    for (const timer of this.activityTimers.values()) clearTimeout(timer);
    this.activityTimers.clear();
    this.lastActivityBroadcastAt.clear();
  }

  private emit(event: SessionManagerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One subscriber must not break Session lifecycle cleanup.
      }
    }
  }
}
