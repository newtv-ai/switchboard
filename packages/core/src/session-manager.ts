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

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly adapters = new Map<string, AgentAdapter>();

  registerAdapter(adapter: AgentAdapter): void {
    const id = adapter.manifest.id;
    if (this.adapters.has(id)) {
      throw new Error(`Adapter already registered: ${id}`);
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

  list(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .map((s) => s.summary())
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  async killAll(): Promise<void> {
    for (const s of this.sessions.values()) {
      try {
        s.kill();
      } catch {
        // process may already be dead
      }
      s.dispose();
    }
    this.sessions.clear();
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
      onExit: () => {
        // For v1, sessions are removed on exit. Persistent sessions are
        // deferred (SPEC §9 Q3).
        const s = this.sessions.get(session.id);
        if (s) {
          s.dispose();
          this.sessions.delete(session.id);
        }
      },
    });
    return session;
  }
}
