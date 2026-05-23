/**
 * Switchboard — Adapter SDK
 *
 * This module defines the PUBLIC, STABLE contract that all agent adapters
 * implement. The shape of these types is part of the project's compatibility
 * promise: breaking changes require a major version bump of this package
 * and a migration guide.
 *
 * See SPEC.md §4.3 for the architecture rationale.
 */

// ─── Manifest ──────────────────────────────────────────────────────────────

export interface AgentManifest {
  /** Unique stable id. Used in URLs, config, telemetry. e.g. "claude", "codex". */
  id: string;
  /** Human-facing name shown in the UI. */
  displayName: string;
  /** Icon URL or data URI. */
  iconUrl?: string;
  /** Semver of this adapter package. */
  adapterVersion: string;
  /** Semver range of the underlying agent CLI that this adapter supports. */
  agentVersionRange: string;
  /** Declared optional capabilities — drives UI affordances. */
  capabilities: readonly AgentCapability[];
  /** Optional CLI installation helpers. */
  install?: InstallInfo;
}

export type AgentCapability =
  | 'structured-output'
  | 'approval-flow'
  | 'thinking'
  | 'tool-use'
  | 'diff-output';

export interface InstallInfo {
  /** Returns whether the agent CLI is available and its version. */
  detect: () => Promise<DetectResult>;
  /** Human-readable install hint, e.g. "npm install -g @anthropic-ai/claude-code". */
  hint?: string;
  /**
   * Optional command the user can opt-in to run to install the CLI.
   * The server will NOT execute this automatically — it only surfaces it in the UI.
   */
  autoInstallCommand?: readonly string[];
}

export interface DetectResult {
  installed: boolean;
  version?: string;
  path?: string;
}

// ─── Spawn config ──────────────────────────────────────────────────────────

export interface SpawnOpts {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  /** Optional initial prompt to send to stdin once the process is ready. */
  initialPrompt?: string;
}

export interface SpawnConfig {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
}

// ─── Structured events (L2) ────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; id: string; tool: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError?: boolean }
  | { type: 'approval_request'; id: string; tool?: string; preview?: string }
  | { type: 'diff'; path: string; patch: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'result'; success: boolean; summary?: string };

export type AgentState =
  | 'starting'
  | 'running'
  | 'thinking'
  | 'waiting_for_approval'
  | 'idle'
  | 'error'
  | 'exited';

export interface Parser {
  /**
   * Called with each raw PTY stdout chunk. Returns 0+ structured events.
   * MUST be tolerant of partial chunks (NDJSON records split across reads, etc.).
   */
  feed(chunk: Uint8Array): readonly AgentEvent[];
  /** Adapter's best guess at current state; called after each feed(). */
  getState(): AgentState;
}

// ─── Actions (L3) ──────────────────────────────────────────────────────────

export type SpecialKey =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Backspace'
  | 'Ctrl+C'
  | 'Ctrl+D';

export interface SessionHandle {
  readonly id: string;
  /** Write raw bytes/text to PTY stdin. */
  write(data: string): void;
  /** Send a single special key. */
  sendKey(key: SpecialKey): void;
}

export interface ActionContext {
  session: SessionHandle;
}

export type ActionHandler = (ctx: ActionContext, params?: unknown) => void | Promise<void>;

// ─── Adapter (the main interface) ──────────────────────────────────────────

export interface AgentAdapter {
  manifest: AgentManifest;
  /** Build the command line + env. Core handles the actual PTY spawn. */
  buildCommand(opts: SpawnOpts): SpawnConfig;
  /** Optional L2 structured parser. */
  createParser?: () => Parser;
  /** Optional L3 UI action handlers, keyed by action id. */
  actions?: Readonly<Record<string, ActionHandler>>;
}

// ─── Key sequence helpers ──────────────────────────────────────────────────

/**
 * Maps SpecialKey → ANSI byte sequence the PTY expects.
 * Both core and adapters may import this so the mapping stays consistent.
 */
export const KEY_SEQUENCES: Readonly<Record<SpecialKey, string>> = Object.freeze({
  Enter: '\r',
  Escape: '\x1b',
  Tab: '\t',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Backspace: '\x7f',
  'Ctrl+C': '\x03',
  'Ctrl+D': '\x04',
});

export function keyBytes(key: SpecialKey): string {
  return KEY_SEQUENCES[key];
}
