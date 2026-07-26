import type { SessionSummary } from '@switchboard/core';
import type { AgentCapability, AgentEvent, AgentManifest, AgentState } from '@switchboard/sdk';

/** Messages a browser/phone client may send on /ws. */
export type ClientMessage =
  | { type: 'list' }
  | {
      type: 'attach';
      sessionId: string;
      /** Initial viewport size so the session can fit to all attached clients from frame 1. */
      cols?: number;
      rows?: number;
    }
  | {
      type: 'create';
      adapterId: string;
      /** Defaults to the server's cwd if omitted. */
      cwd?: string;
      env?: Record<string, string>;
      cols?: number;
      rows?: number;
      name?: string;
    }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'action'; actionId: string; params?: unknown }
  | { type: 'kill'; sessionId: string }
  | { type: 'pong' };

/** Messages the server may send on /ws. */
export type ServerMessage =
  | { type: 'sessions'; list: SessionSummary[] }
  | {
      type: 'ready';
      sessionId: string;
      adapter: AgentManifest;
      capabilities: readonly AgentCapability[];
      /** UTF-8-decoded ring-buffer contents for terminal replay. */
      replay: string;
      summary: SessionSummary;
    }
  | { type: 'pty'; data: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'state'; state: AgentState }
  | { type: 'exit'; code: number; signal?: number }
  | { type: 'error'; message: string }
  /** Actual PTY size after MIN-policy negotiation across all clients. */
  | { type: 'pty-resize'; cols: number; rows: number }
  /** Wrapper transport went down (input is refused) or came back. */
  | { type: 'transport'; connected: boolean }
  /** Server keepalive. Mobile browsers cull WebSockets that are silent for
   *  ~10–20 s (visible as the connection flapping when wrapping idle TUIs
   *  like agy, which — unlike claude — emits no cursor-blink traffic). */
  | { type: 'ping' };

// ─── Wrapper protocol (/wrap endpoint, localhost-only) ───────────────────

/** Messages a wrapper process sends on /wrap. */
export type WrapClientMessage =
  | {
      type: 'register';
      /** Optional only for one-connection compatibility with pre-v1.2 wrappers. */
      wrapperId?: string;
      /** Optional only for one-connection compatibility with pre-v1.2 wrappers. */
      resumeKey?: string;
      adapterId: string;
      cwd: string;
      name?: string;
      cols: number;
      rows: number;
      command: string;
      args: readonly string[];
      env?: Record<string, string>;
      /**
       * Whether wrapper has a local TTY whose size should participate in PTY
       * size negotiation. When true, register treats {cols, rows} as the
       * wrapper's local viewport. When false (headless), wrapper opts out and
       * only browser clients drive the size.
       */
      hasLocalViewport?: boolean;
    }
  | {
      type: 'resume';
      wrapperId: string;
      resumeKey: string;
      sessionId: string;
      cols: number;
      rows: number;
      hasLocalViewport?: boolean;
    }
  | { type: 'pty'; data: string }
  | { type: 'local-resize'; cols: number; rows: number }
  | { type: 'exit'; code: number; signal?: number };

/** Messages the server sends on /wrap. */
export type WrapServerMessage =
  | { type: 'registered'; sessionId: string }
  | { type: 'resumed'; sessionId: string }
  | { type: 'resume-rejected'; reason: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill'; signal?: string }
  | { type: 'error'; message: string };
