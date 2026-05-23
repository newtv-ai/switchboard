# Switchboard — Project Specification

> **Status**: Draft v0.9 · Last updated: 2026-05-23 · Phase 1 ✅ · Phase 2 ✅ · Phase 3 next
> **This document is the single source of truth.** Any new feature, scope change, or architectural decision MUST be reflected here before/during implementation. If implementation drifts from this doc, the doc is fixed (or the implementation is rolled back). See §11 Change Log for how to update.

---

## 0. TL;DR

A self-hostable web app that lets a developer drive AI coding CLIs (Claude Code, Codex, Antigravity, …) on their dev machine from a phone browser over Tailscale. Plugin-based: each agent ships as an adapter package. Core is agent-agnostic PTY relay so new agents work day-one in raw mode while adapters add semantic UX (chat view, diff viewer, quick-action buttons, push notifications).

**Why this exists** — existing tools either screen-share the desktop (laggy, bad on phones: Tailscale+RustDesk), or are tightly coupled to one agent (slopus/happy = Claude+Codex but no public plugin API, Windows server undocumented, AGPL-ish concerns on derivatives).

---

## 1. Vision & Non-Goals

### 1.1 Vision
"Treat my phone like a CLI remote." The user's daily workflow stays on the desktop terminal — they `cd ~/project && claude` as they always have. Switchboard's job is to **attach a phone (or another browser) to that already-running session**, not to replace the terminal.

A developer should be able to:
- Run `switchboard run claude` (or just `claude` via shell alias) in their normal terminal — TUI behaves identically to a plain `claude` invocation
- Open a phone browser → see all running sessions and attach to any of them
- Type from phone → desktop terminal sees the same input; both stay in sync
- Continue, approve, reject, or redirect agents with one tap
- Get push notifications when an agent finishes or asks for input
- Run **multiple agents in parallel** across different projects, each in its own terminal tab, all visible from the phone

### 1.2 Non-Goals (v1)
We do **not** ship:
- Screen sharing or RDP-style desktop streaming
- A cloud-hosted version (self-host only; cloud is a future business decision)
- Native iOS/Android apps (PWA only — significantly lowers shipping cost)
- E2E encryption / multi-user accounts (single-user, single-machine assumption)
- An LLM proxy or API gateway (we drive existing CLIs, we don't replace them)
- VSCode/IDE plugin (separate scope)

If you find yourself building any of the above, stop and update this section first.

---

## 2. Target User & Constraints

- **Primary user**: a developer with a Windows 11 dev machine, comfortable with `npm` and a terminal. Uses Tailscale for personal mesh networking.
- **Platforms**:
  - Server: **Windows 11 (priority)**, macOS, Linux. Native Node.js, no Docker required.
  - Client: any modern mobile browser (iOS Safari 17+, Android Chrome 120+) and desktop browsers.
- **License**: MIT. All adapter contracts are public-API.
- **Distribution**: single `npm i -g <name>` install. `npx <name>@latest` one-shot also works. No Docker required (Docker may be offered as alternative).

---

## 3. Architecture Overview

Two ways a session enters the SessionManager:

**A. Wrapped (primary use case)** — user runs `switchboard run claude` in their real terminal. The wrapper process owns the PTY locally (so the terminal TUI works as normal); it also opens a WebSocket to the server to register and relay bytes.

**B. Server-spawned (secondary)** — phone/browser asks the server to start a new process. Useful when the user is away from their desk and wants to kick off a fresh task.

Both produce the same `Session` abstraction; the rest of the system (UI, adapters, push notifications) doesn't care which kind it is.

```
                    ╔════════════════════════════════════════╗
                    ║  Wrapped session (Mode A — primary)    ║
                    ╚════════════════════════════════════════╝
   ┌─ User's desktop terminal ──────────────────────────────┐
   │ PS> switchboard run claude                             │
   │   ┌──────────────┐    ┌─────────────────┐              │
   │   │ wrapper proc │◄──►│ claude (PTY)    │  TUI normal  │
   │   └───────┬──────┘    └─────────────────┘              │
   └───────────┼────────────────────────────────────────────┘
               │ WS /wrap  (pty stream + input + resize + exit)
               ▼
        ┌──────────────────────────────────────────┐
        │ Switchboard server                       │
        │                                          │
        │  Session Manager                         │◄── /sessions (REST)
        │   ├── Session #1 (Wrapped, claude)       │
        │   ├── Session #2 (Wrapped, codex)        │
        │   └── Session #3 (Server-spawned)        │
        │                                          │
        │  Adapter Registry (Phase 3)              │
        │   ├── @switchboard/adapter-claude        │
        │   ├── @switchboard/adapter-codex         │
        │   └── @switchboard/adapter-passthrough   │
        └──────────────────┬───────────────────────┘
                           │ WS /ws  (attach + pty + event + input + resize)
                           ▼
                 ┌─────────────────────────┐
                 │ Phone / Browser (PWA)   │
                 │  ├── Session list       │
                 │  ├── Terminal view      │
                 │  └── Chat view (Ph. 3+) │
                 └─────────────────────────┘

                    ╔════════════════════════════════════════╗
                    ║  Server-spawned session (Mode B)       ║
                    ╚════════════════════════════════════════╝
                 [browser] ──create──► server ──node-pty──► claude
                              ▲                  ▲
                              └── attach ────────┘
```

### 3.1 Three-layer model

| Layer | What it does | Agent-aware? | Required? |
|---|---|---|---|
| **L1 — PTY relay** | Stream bytes to/from a PTY (either local via node-pty, or remote via wrapper WS). Works for ANY CLI. | No | Yes |
| **L2 — Structured parser** | Parse agent's structured output (stream-json, etc.) into typed events. | Yes (per adapter) | Optional |
| **L3 — Action injection** | Translate UI button taps ("approve", "stop") into keystrokes/SDK calls. | Yes (per adapter) | Optional |

**Adapters that only implement L1 still work** — the user gets a terminal view, no chat or quick-actions. This is the "raw mode" guarantee.

### 3.2 Session backend pluggability

`Session` accepts a `SessionBackend` interface rather than owning a PTY directly. Two implementations:

- `LocalPtyBackend` — wraps `node-pty`. Used by Mode B (server-spawned).
- `WrapperBackend` — wraps a WebSocket connection from a `switchboard run` wrapper. Used by Mode A.

The rest of the system (Session, SessionManager, parsers, actions, UI) is identical for both. Adding new transport types in the future (e.g. SSH-tunneled wrappers, remote-agent-as-a-service) is a new backend class, no broader refactor.

### 3.2 Why PTY-as-core (not SDK-as-core)
- **New agents work on day one**: Antigravity 2.0 shipped May 19 2026 with no SDK. With PTY-as-core, it works in raw mode immediately while we write the adapter.
- **Agent JSON breakage degrades gracefully**: Codex `--json` is unstable (openai/codex#4776 schema drift, #15451 silently-ignored-with-MCP). If Codex breaks its schema, the user falls back to terminal mode rather than the product breaking.
- **TUI is the canonical UX**: Slash commands, settings menus, login flows assume TUI. Terminal mode preserves all of them. Chat mode is the ergonomic layer on top, not a replacement.

---

## 4. Component Specifications

### 4.1 Core: PTY Relay & Session Manager
- **Package**: `packages/core`
- **Responsibilities**:
  - Spawn agent processes inside PTY (`node-pty`, ConPTY on Windows)
  - Maintain per-session ring buffer (e.g. last 2 MB of output) for reconnects
  - Route input from active WebSocket(s) to PTY stdin
  - Detach session from any connected client — process keeps running after disconnect
  - Resize PTY when client signals window resize
- **Key API**:
  ```typescript
  class SessionManager {
    create(opts: { adapterId: string; cwd: string; env?: Record<string, string> }): Session;
    attach(sessionId: string, ws: WebSocket): Attachment;
    list(): SessionSummary[];
    kill(sessionId: string): Promise<void>;
  }
  ```

### 4.2 Transport: WebSocket Protocols

Two WS endpoints, different purposes:

#### `/ws` — Browser / phone client protocol
- **One WS connection per UI tab.** Multiple tabs/devices can attach to the same session.
- **Client → Server**:
  - `list` — request current session list (server replies with `sessions`)
  - `attach` `{ sessionId }` — subscribe to existing session
  - `create` `{ adapterId, cwd?, env? }` — spawn a new server-managed session (Mode B)
  - `input` `{ data }` — raw keystrokes
  - `resize` `{ cols, rows }`
  - `action` `{ actionId, params? }` — L3 semantic action (adapter translates)
  - `kill` `{ sessionId }`
- **Server → Client**:
  - `sessions` `{ list: SessionSummary[] }`
  - `ready` `{ sessionId, adapter, capabilities, replay }`
  - `pty` `{ data }` — raw ANSI bytes
  - `event` `{ event: AgentEvent }` — structured event (Phase 3+)
  - `state` `{ state: AgentState }`
  - `exit` `{ code, signal? }`
  - `error` `{ message }`

#### `/wrap` — Wrapper-process protocol (Mode A)
- **One WS per wrapper invocation.** The wrapper IS the PTY owner; server is a relay between it and any attached browsers.
- **Wrapper → Server**:
  - `register` `{ adapterId, cwd, name?, command, args, cols, rows, env? }` — initial handshake
  - `pty` `{ data }` — every PTY chunk
  - `exit` `{ code, signal? }`
- **Server → Wrapper**:
  - `registered` `{ sessionId }` — ack with assigned id
  - `input` `{ data }` — input from any attached browser
  - `resize` `{ cols, rows }` — resize request from browser (wrapper may honour or ignore; the local terminal is authoritative for size in v1)
  - `kill` `{ signal? }`
  - `error` `{ message }`

Both `pty` and `event` may be sent for the same agent output — `pty` is always sent; `event` is sent only if the adapter has a parser. Clients choose which to render.

### 4.3 Adapter Layer (THE plugin contract)
- **SDK package**: `packages/sdk` — type definitions only, depended on by all adapters
- **Adapters are npm packages** that default-export an `AgentAdapter`. Built-in adapters live in `packages/adapter-*`; 3rd-party adapters install into `~/.<project>/adapters/` or are referenced by config.

```typescript
// packages/sdk/src/index.ts
export interface AgentAdapter {
  manifest: AgentManifest;

  /** Build the command line + env to spawn the agent.
   *  Core handles the actual node-pty spawn; adapter just configures it. */
  buildCommand(opts: SpawnOpts): SpawnConfig;

  /** Optional L2: produce structured events from raw stdout chunks. */
  createParser?(): Parser;

  /** Optional L3: map UI actions to PTY input or session ops. */
  actions?: Record<string, ActionHandler>;
}

export interface AgentManifest {
  id: string;                // "claude" | "codex" | "antigravity" | ...
  displayName: string;
  iconUrl?: string;
  adapterVersion: string;    // semver of this adapter
  agentVersionRange: string; // semver range of agent CLI this supports, e.g. "^1.0"
  capabilities: AgentCapability[];
  install?: {
    detect(): Promise<DetectResult>;       // is the CLI on PATH? what version?
    hint?: string;                          // human-readable install instructions
    autoInstallCommand?: string[];          // optional: run this to install
  };
}

export type AgentCapability =
  | "structured-output"   // adapter implements createParser
  | "approval-flow"       // adapter can detect waiting-for-approval
  | "thinking"            // adapter emits thinking events
  | "tool-use"            // adapter emits tool_use events
  | "diff-output";        // adapter emits parseable patches

export interface SpawnConfig {
  command: string;        // e.g. "claude"
  args: string[];         // e.g. ["--output-format", "stream-json", ...]
  env: Record<string, string>;
  cwd: string;
}

export interface Parser {
  /** Called with each PTY stdout chunk. Returns 0+ structured events.
   *  Must be tolerant of partial chunks (NDJSON across boundaries, etc.). */
  feed(chunk: Buffer): AgentEvent[];
  /** Adapter's best guess at current state; called after each feed(). */
  getState(): AgentState;
}

export type AgentEvent =
  | { type: "text";             content: string }
  | { type: "thinking";         content: string }
  | { type: "tool_use";         id: string; tool: string; input: unknown }
  | { type: "tool_result";      id: string; output: string; isError?: boolean }
  | { type: "approval_request"; id: string; tool?: string; preview?: string }
  | { type: "diff";             path: string; patch: string }
  | { type: "usage";            inputTokens: number; outputTokens: number }
  | { type: "result";           success: boolean; summary?: string };

export type AgentState = "starting" | "running" | "thinking" | "waiting_for_approval" | "idle" | "error" | "exited";

export type ActionHandler = (ctx: ActionContext, params?: unknown) => Promise<void> | void;
export interface ActionContext {
  session: { id: string; write(data: string): void; sendKey(key: SpecialKey): void };
}
export type SpecialKey = "Enter" | "Escape" | "Tab" | "Up" | "Down" | "Ctrl+C" | "Ctrl+D";
```

**Stability contract**:
- `AgentAdapter`, `AgentManifest`, `AgentEvent`, `AgentState`, `SpecialKey` are **public stable API** as of v1.0.
- Breaking changes require a major bump of `@<scope>/sdk` AND a migration guide in `docs/adapter-migration.md`.
- New optional fields can be added in minor versions.

### 4.4 Frontend: PWA
- **Package**: `packages/web`
- **Stack**: React + Vite + TypeScript + xterm.js + vite-plugin-pwa
- **Two views per session** (toggle):
  - **Chat view**: renders `AgentEvent` stream as chat bubbles; tool_use, diffs, thinking get distinct treatments
  - **Terminal view**: renders raw PTY stream in xterm.js
- **Quick Action Bar**: bottom bar of action buttons. Buttons are sourced from `adapter.actions` keys. Always-present built-ins: send-Esc, send-Ctrl+C, scroll-to-bottom.
- **Per-session card on home screen**: state badge, agent icon, last message preview, last activity timestamp.
- **PWA**: installable to home screen, Web Push notifications when session enters `waiting_for_approval` or `idle` from `running`.
- **Mobile-first**: viewport meta + safe-area insets, virtual-keyboard handling via `visualViewport` API.

### 4.5 Auth & Security
- **Single bearer token** generated on first run, printed to server stdout as a QR code linking to `https://<tailscale-ip>:<port>/pair?t=<token>`
- Token stored in `~/.<project>/config.json` (file perms 600 on Unix, ACL-restricted on Windows)
- Server binds **only to tailscale interface by default** (configurable, but warns loudly if binding 0.0.0.0)
- TLS via self-signed cert auto-generated on first run; users on Tailscale can also rely on Tailscale's own encryption and use HTTP (opt-in flag)
- WebSocket frames over an authenticated connection are trusted; no per-frame auth
- **No multi-user model.** Anyone with the token has full PTY access = RCE. This is the threat model the user accepts.

---

## 5. Built-in Adapters (v1)

### 5.1 `adapter-claude`
- Spawn: `claude --output-format stream-json --input-format stream-json --include-partial-messages`
- Parser: NDJSON line splitter; maps Claude SDK event types to `AgentEvent`
- Actions: `approve`, `reject`, `stop`, `continue`
- Detect: `claude --version`; supports `^1.0` initially
- Env: `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` to mitigate ConPTY rendering issues (anthropics/claude-code#14599)

### 5.2 `adapter-codex`
- Spawn: `codex exec --json` (best-effort; falls back to plain `codex` if `--json` ignored due to MCP — openai/codex#15451)
- Parser: parses NDJSON events, normalizes both legacy (`item_type:assistant_message`) and current (`type:agent_message`) schemas (openai/codex#4776)
- Actions: `approve`, `reject`, `stop`
- Version pin: works against a tested Codex version range; parser falls back to L1 raw mode on schema mismatch (logs a warning, doesn't crash)

### 5.3 `adapter-passthrough`
- The "any-CLI" adapter. Configurable command in config. No parser. No actions beyond send-key.
- This is what unsupported agents (Antigravity v1, Gemini CLI, custom scripts) use until they get a proper adapter.

### 5.4 Future: `adapter-antigravity` (deferred)
- Will land when Antigravity 2.0 has stable output format
- Tracked in §9 Open Questions

---

## 6. Tech Stack & Rationale

| Concern | Choice | Why (and what was rejected) |
|---|---|---|
| Language | TypeScript everywhere | Type-safety across the plugin contract is the load-bearing reason. |
| Runtime | Node.js 22 LTS | node-pty is best supported here; matches ecosystem of all 3 agents. Bun/Deno rejected for native-module compat risk. |
| Monorepo | npm workspaces | Default-everywhere; pnpm/yarn rejected to minimize install friction. |
| Web framework | Fastify + @fastify/websocket | Faster than express; first-class TS; integrated WS. Hono considered but Node-pty interop simpler in Fastify. |
| PTY | node-pty | Industry standard (VSCode uses it). |
| Frontend | React + Vite + xterm.js | xterm.js is required (only mature web terminal). React for component ecosystem + PWA tooling. |
| PWA | vite-plugin-pwa + Workbox | Standard. |
| Push | Web Push API (VAPID) | Works in Chrome (Android) and Safari 16.4+ (iOS). |
| Linter/formatter | Biome | Single tool replaces eslint+prettier; faster. |
| Tests | Vitest | Unifies frontend+backend; same syntax as Jest. |
| Build (backend) | tsup | Zero-config esbuild wrapper. |
| Distribution | npm (`npm i -g`) | One-line install. Single-binary via `pkg`/Bun later as nice-to-have. |
| Config storage | `~/.claude-remote-agent/` (Windows: `%APPDATA%\claude-remote-agent\`) | Standard XDG-ish. |

---

## 7. Repository Structure

```
switchboard/
├── SPEC.md                       ← this file (single source of truth)
├── README.md                     ← public face; user-facing intro
├── CHANGELOG.md                  ← release notes
├── LICENSE                       ← MIT
├── package.json                  ← npm workspaces root
├── tsconfig.base.json
├── biome.json
├── .gitignore
├── packages/
│   ├── sdk/                      ← adapter contract types (depended on by all adapters)
│   ├── core/                     ← PTY relay, session manager, ring buffer
│   ├── server/                   ← Fastify HTTP+WS, auth, adapter registry, CLI entrypoint
│   ├── web/                      ← React PWA
│   ├── adapter-claude/
│   ├── adapter-codex/
│   └── adapter-passthrough/
├── docs/
│   ├── adapter-authoring.md      ← how to write a 3rd-party adapter
│   ├── architecture-decisions.md ← ADRs as they accumulate
│   └── security-model.md         ← threat model details
└── examples/
    └── adapter-template/         ← copy-paste starting point for new adapters
```

---

## 8. Roadmap & Phase Gates

Each phase ends with a **gate** — concrete acceptance criteria. We do not start phase N+1 until phase N's gate passes.

### Phase 1 — Scaffold & PTY Relay MVP  ✅ Completed 2026-05-23
**Scope**: Get a browser on the dev box to attach to a PowerShell session running Claude Code, view output, and send keystrokes.

- [x] npm workspaces monorepo set up, all packages compile
- [x] `packages/sdk`: types compile, exported
- [x] `packages/core`: SessionManager can spawn a PTY, ring buffer works, attach/detach works
- [x] `packages/server`: Fastify + WS, single hardcoded "passthrough" adapter, no auth — boots cleanly
- [x] `packages/web`: minimal page with xterm.js attached over WS — builds cleanly
- [x] `npm run dev` brings the whole thing up on localhost
- [x] **Gate passed 2026-05-23**: live browser test confirmed end-to-end. Claude Code v2.1.146 TUI renders correctly via passthrough adapter — ANSI colors, box-drawing chars, alt-screen buffer all work. **The ConPTY alt-screen workaround (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`) was NOT needed** — risk noted in §5.1 has not materialized in current Claude Code + Windows 11 + node-pty combo.

Deferred to follow-up tasks (documented but not yet built):
- Unit tests for `RingBuffer` wrap logic
- Integration test that drives the WS protocol end-to-end

**Strategic implication for Phase 2**: since raw passthrough renders Claude Code beautifully on desktop, the structured chat view becomes a **phone-UX enhancement**, not a desktop-rendering fix. Mobile (Phase 4) is where it earns its keep. Keep Phase 2 scope tight: parser + chat view as alternate render mode, don't expand it into a feature spree.

### Phase 2 — Wrapper CLI & Session Attach  (target: 3-4 days) — **NEW, REPRIORITIZED**
Replaces what was Phase 2. Driven by the user's actual workflow: desktop terminal stays primary, phone attaches to existing sessions instead of spawning new ones from cold.

- [ ] Refactor `Session` to accept a `SessionBackend` interface
- [ ] `LocalPtyBackend` — extracts current node-pty logic
- [ ] `WrapperBackend` — relays bytes to/from a wrapper WS connection
- [ ] Server: add `/wrap` WS endpoint; wrapper messages `register` / `pty` / `exit` ↔ server messages `registered` / `input` / `resize` / `kill`
- [ ] `switchboard run [-n <name>] <command> [args...]` subcommand of the existing CLI:
  - spawns `<command>` in a local PTY with current cwd/env
  - mirrors PTY → local stdout (TUI works as normal)
  - mirrors stdin → PTY (so the user keeps typing in their terminal)
  - opens WS to `ws://localhost:8787/wrap`, sends `register`, relays PTY chunks
  - on browser `input` from server, writes to PTY (browser typing appears in TUI naturally via echo)
  - exits cleanly on PTY exit or Ctrl+C
- [ ] Web: `list` flow — show session picker on connect; pick one → attach. "+ New" button still calls `create` (Mode B preserved)
- [ ] Update home-screen session listing to show: adapter, cwd, name, state, last-output timestamp
- [x] Engineering complete 2026-05-23. Smoke test confirmed: `switchboard run node --version` → session registered as `wrapped` source, listed in /sessions while alive, cleaned up on exit.
- [x] **Gate passed 2026-05-23**: `switchboard run claude` registers a wrapped session, both phone and desktop browsers see it in the session list, both can attach and view live TUI, bidirectional input sync confirmed (phone types → desktop sees it). Multi-client PTY sizing (max cols + min rows) negotiates a workable shared dimension; quick-actions toolbar hidden on desktop where physical keys exist.

Also surfaced during smoke test:
- node-pty on Windows does NOT consult PATHEXT — `node` won't resolve to `node.exe`, `claude` won't resolve to `claude.cmd`. Fix: PATH+PATHEXT-aware `resolveCommand()` in wrapper-cli. Documented as a Windows-specific gotcha.

Phone-usability follow-ups landed alongside Phase 2 (would otherwise be Phase 5):
- **visualViewport-driven `--app-h`**: layout shrinks above the virtual keyboard. CSS `100dvh` was unreliable on MIUI/Xiaomi browsers; the `window.visualViewport` API gives correct keyboard-aware viewport height across iOS Safari + Android Chrome + MIUI.
- **Quick Actions toolbar**: Esc / Tab / ⇧Tab / ↑↓←→ / Ctrl+C — bytes that phone virtual keyboards can't produce. Each button uses `onPointerDown + preventDefault` to keep focus on the xterm helper textarea (so the IME panel doesn't dismiss between taps).
- **Per-client size tracking with split policy (MAX cols, MIN rows)**: `Session.attach()` now returns a `ClientHandle` and tracks each attached client's reported viewport. `refitToClients()` picks `max(cols)` and `min(rows)` across all attached clients. Rationale: in alt-screen TUIs (claude code, codex), cursor positions ABOVE a small client's row count are clipped and content there literally never enters that client's xterm buffer — so MIN rows is necessary for the input prompt to be reachable on small clients. Cols mismatches clip the right side but the left (where prompts live) renders, so MAX cols keeps wider clients usable.

### Phase 3 — Adapter Plugin System & Claude/Codex Adapters  (target: 3-4 days) — was Phase 2
- [ ] Adapter registry: loads adapters from `packages/adapter-*` at startup; future-proofed for external resolution
- [ ] `adapter-passthrough` formalized as its own package (currently lives in `packages/server`)
- [ ] `adapter-claude` implements L1 (spawn) and L2 (NDJSON parser → AgentEvent) — only for Mode B; Mode A always uses raw stream
- [ ] `adapter-codex` same as above with schema-drift-tolerant parser
- [ ] Wrapper gets a `--adapter <id>` flag that selects which adapter's `buildCommand` to call (instead of running the literal command)
- [ ] Gate: a wrapped Claude session shows raw TUI; a server-spawned Claude session offers terminal-view ↔ chat-view toggle

### Phase 4 — Auth, Security, Pairing  (target: 2 days) — was Phase 3
- [ ] Bearer token generation + storage with restricted perms
- [ ] QR-code pair flow on server stdout
- [ ] Bind to tailscale interface by default; loud warning for 0.0.0.0
- [ ] Self-signed TLS auto-cert
- [ ] Gate: open phone browser on Tailscale → scan QR → land on authenticated session list → fail to access without token

### Phase 5 — Mobile UX & PWA  (target: 4-5 days) — was Phase 4
- [ ] PWA manifest + service worker (installable to home screen)
- [ ] Mobile keyboard handling (visualViewport API, input box stays above keyboard)
- [ ] Quick Action Bar wired to `adapter.actions`
- [ ] Web Push: subscribe on pair, notify on state transitions (`waiting_for_approval`, `idle` from `running`)
- [ ] Chat view styled for thumbs (44px tap targets, swipe gestures)
- [ ] Gate: install to iPhone home screen → start a Claude session → background app → notification fires → tap to open and approve

### Phase 6 — Multi-session & Project Switcher polish  (target: 2-3 days) — was Phase 5
- [ ] Home screen lists all sessions with state badges
- [ ] Create-session flow: pick adapter, pick cwd (autocomplete from recent), pick initial prompt
- [ ] Sessions survive server restart? (Decision: NO for v1 — process tree dies with parent. Persistent sessions deferred. See §9.)
- [ ] Gate: 3 parallel sessions on different projects, switch between them on phone without losing state

### Phase 7 — Polish & Open-source Release  (target: 1 week)
- [ ] README with install gif, feature list, comparison vs alternatives
- [ ] `docs/adapter-authoring.md` with worked example
- [ ] `examples/adapter-template/` ready to fork
- [ ] CI: lint + typecheck + tests + multi-platform build matrix (windows/macos/linux)
- [ ] npm publish under chosen scope (see §10)
- [ ] GitHub release with binaries (optional, via pkg)
- [ ] Gate: a stranger can `npm i -g <name>` on a fresh Windows machine and have it working in under 5 minutes

### Phase 8+ — Future (not committed)
- `adapter-antigravity` when Antigravity 2.0 stabilizes
- Persistent sessions across server restarts (tmux-style hand-off, or detached node child)
- Voice input
- Session sharing (multi-device read-only follow)

---

## 9. Open Questions

| # | Question | Decision needed by | Tentative answer |
|---|---|---|---|
| ~~Q1~~ | ~~Final project name~~ | ~~Before Phase 7~~ | **Resolved 2026-05-23**: `switchboard`. See §10. |
| ~~Q2~~ | ~~npm scope~~ | ~~Before Phase 7~~ | **Resolved 2026-05-23**: `@switchboard/*`. See §10. |
| Q3 | Persistent sessions strategy | Phase 5 design | Defer to v1.1 — for v1, sessions die with server |
| Q4 | Should adapters be sandboxed (separate process)? | Phase 2 design | NO for v1 — adapters are npm code, trust same as core |
| Q5 | Push notification provider — VAPID self-hosted vs a relay service? | Phase 4 | Self-hosted VAPID; user generates keys on first run |
| Q6 | How to handle Claude Code login flow (browser OAuth) over phone WS? | Phase 2 testing | Probably "open this URL on a desktop" message; phones can't drive the localhost callback |
| Q7 | Should we ship a Docker image alongside npm? | Phase 7 | Yes — Dockerfile in repo, optional for users who prefer it |

---

## 10. Naming (Resolved 2026-05-23)

**Project name: `switchboard`** — "总机" in Chinese.

Rationale: old-school telephone-operator metaphor where multiple lines (agents) route through one panel (the user's phone). Captures multi-agent + remote-control-from-anywhere in one image. Distinctive in dev-tools space, no major brand collision.

### Naming map
- Project / repo name: `switchboard`
- npm scope (workspace + future publish): `@switchboard/`
- Internal package names: `@switchboard/{sdk,core,server,web,adapter-claude,adapter-codex,adapter-passthrough}`
- Filesystem folder: any name the user picks at clone time (legacy local path was `Claude Remote Agent` from before the rename; not a constraint for users cloning the public repo)
- GitHub org/repo (TBD before Phase 7): `github.com/switchboard-dev/switchboard` is the working assumption; verify availability before publish
- Domain (TBD before Phase 7): `switchboard.dev` preferred

### Rejected candidates (do not revisit)
- `tether` — collides with Tether (USDT) crypto brand; SEO loss
- `paige` — clever (page + AI) but is a first name; obscure
- `palmpilot` — Palm Inc. trademark legacy
- `claude-remote-agent` (original placeholder) — Anthropic "Claude Agent SDK" name collision; misleading after multi-agent scope expansion

---

## 11. Change Log Discipline

This is the rule for keeping the spec from rotting:

1. **Any new feature**, no matter how small, gets a section/bullet in this doc **before** code is written for it. If it's in code but not in the doc, the doc gets updated immediately.
2. **Any abandoned plan** (something in this doc that we decided NOT to do) gets moved to a "Rejected ideas" section with one-line reason, not deleted. (To prevent revisiting the same dead-ends.)
3. **Any architectural decision** that resolves an Open Question (§9) moves the answer into the main body and removes the question from §9.
4. **Phase gate completion** updates Phase N to "✅ Completed YYYY-MM-DD" and lists what shipped vs what was deferred.
5. **Version bump**: increment the version at the top of this doc on every meaningful change. v0.x = pre-release, v1.0 = first npm publish.

### Recent changes
- 2026-05-23 — v0.9 — **Phase 2 gate PASSED**: live multi-client test confirmed across phone + desktop. Wrapper now honors server-driven resize when running headless (no local TTY), so background wrappers correctly adopt browser-negotiated PTY size. Quick-actions toolbar hidden on viewports ≥ 600px (physical keyboards present).
- 2026-05-23 — v0.8 — **Multi-client session sizing**: `Session.attach()` returns a `ClientHandle`; tracks per-client viewports; PTY refits to `max(cols)` + `min(rows)` across attached clients. Fixes "desktop view becomes phone-narrow when phone last attached" and "phone can't see input prompt when desktop is also attached".
- 2026-05-23 — v0.7 — **Phase 2 mobile-usability fixes** (pulled forward from Phase 5): visualViewport-driven `--app-h` for keyboard-aware layout; QuickActions toolbar (Esc/Tab/⇧Tab/arrows/Ctrl+C) so TUI navigation works without a hardware keyboard.
- 2026-05-23 — v0.6 — **Phase 2 engineering complete**: refactored core to use pluggable `SessionBackend` (LocalPtyBackend / WrapperBackend). Added `/wrap` WS endpoint (localhost-only). Added `switchboard run` subcommand. Refactored web into SessionList + TerminalView. Smoke tested wrapper end-to-end successfully. Live browser gate pending. Also: discovered Windows ConPTY doesn't consult PATHEXT — added `resolveCommand()` helper.
- 2026-05-23 — v0.5 — **Architecture pivot**: primary use case clarified to "wrap an existing desktop terminal", not "spawn from phone". Added Mode A (wrapper) as primary, kept Mode B (server-spawn) as secondary. SPEC §1/§3 vision + architecture rewritten. §4.2 WS protocol now defines two endpoints (`/ws` for browsers, `/wrap` for wrappers). Phase order reshuffled: new Phase 2 = wrapper CLI; old Phase 2 (adapter system) moved to Phase 3; old Phase 6 (Codex) folded into Phase 3. Also: minor mobile UI tweaks landed (CJK clipping fix, side-gutter reduction, mobile font size).
- 2026-05-23 — v0.4 — **Phase 1 gate PASSED**: live browser test confirmed Claude Code TUI renders correctly through passthrough adapter (no alt-screen workaround needed). Added strategic note about Phase 2 priorities — chat view becomes phone-UX play, not desktop fix.
- 2026-05-23 — v0.3 — Phase 1 scaffolded: 4 packages (`sdk`, `core`, `server`, `web`) implemented and building cleanly. Server boots and serves /health, /adapters, /ws; web builds via Vite. Live browser gate pending.
- 2026-05-23 — v0.2 — Project name resolved: `switchboard`. §10 rewritten as decision; archived rejected candidates. Architecture diagram package names updated to `@switchboard/*`. Open Question Q1 closed.
- 2026-05-23 — v0.1 — Initial draft.

### Rejected ideas
- *(none yet)*

---

## 12. References

- slopus/happy — github.com/slopus/happy (primary inspiration; we exist because it lacks a public plugin API and Windows-native server path)
- Claude Agent SDK — code.claude.com/docs/en/agent-sdk
- Codex CLI noninteractive — developers.openai.com/codex/noninteractive
- Codex JSON schema drift — openai/codex#4776, #15451
- Claude Code Windows ConPTY rendering — anthropics/claude-code#14599, #42670
- Antigravity 2.0 launch — developers.googleblog.com/build-with-google-antigravity-...
- Cross-references in memory: [[project-scope]], [[landscape-findings]]
