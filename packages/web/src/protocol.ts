// Mirror of @switchboard/server's protocol.ts — kept in-package so the web
// build doesn't depend on importing from the server package. Stays in sync
// by convention. If types diverge, the next end-to-end test will catch it.

export interface SessionSummary {
  id: string;
  name: string;
  adapterId: string;
  adapterDisplayName: string;
  source: 'spawned' | 'wrapped';
  cwd: string;
  state: AgentState;
  createdAt: string;
  lastActivityAt: string;
  bufferBytes: number;
}

export type AgentState =
  | 'starting'
  | 'running'
  | 'thinking'
  | 'waiting_for_approval'
  | 'idle'
  | 'error'
  | 'exited';

export interface AgentManifest {
  id: string;
  displayName: string;
  iconUrl?: string;
  adapterVersion: string;
  agentVersionRange: string;
  capabilities: readonly string[];
}

export type ClientMessage =
  | { type: 'list' }
  | { type: 'attach'; sessionId: string; cols?: number; rows?: number }
  | {
      type: 'create';
      adapterId: string;
      cwd?: string;
      env?: Record<string, string>;
      cols?: number;
      rows?: number;
      name?: string;
    }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'action'; actionId: string; params?: unknown }
  | { type: 'kill'; sessionId: string };

export type ServerMessage =
  | { type: 'sessions'; list: SessionSummary[] }
  | {
      type: 'ready';
      sessionId: string;
      adapter: AgentManifest;
      capabilities: readonly string[];
      replay: string;
      summary: SessionSummary;
    }
  | { type: 'pty'; data: string }
  | { type: 'event'; event: unknown }
  | { type: 'state'; state: AgentState }
  | { type: 'exit'; code: number; signal?: number }
  | { type: 'error'; message: string }
  | { type: 'ping' };
