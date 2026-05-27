import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename as pathBasename } from 'node:path';
import * as nodePty from 'node-pty';
import WebSocket from 'ws';
import { resolveCommand } from '@switchboard/core';
import type { WrapClientMessage, WrapServerMessage } from './protocol.js';

interface WrapperOptions {
  name: string | undefined;
  /** Undefined when the user did not pass `--adapter`; resolved from the
   *  command name (e.g. `codex` → 'codex') in that case. */
  adapterId: string | undefined;
  serverUrl: string;
  command: string;
  args: string[];
}

/** Strip platform-specific executable suffixes for matching/display. */
function cleanCommandBasename(cmd: string): string {
  const raw = pathBasename(cmd);
  return raw.replace(/\.(exe|cmd|bat|com|ps1)$/i, '');
}

function resolveAdapterId(explicit: string | undefined, commandBasename: string): string {
  if (explicit) return explicit;
  if (commandBasename === 'codex') return 'codex';
  if (commandBasename === 'agy') return 'antigravity';
  return 'passthrough';
}

/**
 * Apply adapter-specific defaults to spawn args/env.
 *
 * Currently only `codex` needs this — see adapters/codex.ts for the rationale.
 * Kept inline (not delegated to the SDK adapter) because the wrapper-cli runs
 * in the user's terminal BEFORE the WS connects, so it can't load the server's
 * adapter registry.
 */
function applyAdapterDefaults(
  adapterId: string,
  args: readonly string[],
  baseEnv: Record<string, string>,
): { args: string[]; env: Record<string, string> } {
  if (adapterId !== 'codex') return { args: [...args], env: { ...baseEnv } };

  const env = { ...baseEnv };
  if (!env.CODEX_HOME) {
    env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'switchboard-codex-'));
  }
  const nextArgs = args.includes('--no-alt-screen') ? [...args] : ['--no-alt-screen', ...args];
  return { args: nextArgs, env };
}

/**
 * `switchboard run [options] <command> [args...]`
 *
 * Spawn <command> in a PTY locally, mirror it to the user's terminal (so the
 * TUI works normally), AND open a WS to the server's /wrap endpoint so any
 * browser/phone client attached via /ws sees the same output and can type back.
 */
export async function runWrapper(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const resolvedCommand = resolveCommand(opts.command);
  const commandBasename = cleanCommandBasename(opts.command);
  const adapterId = resolveAdapterId(opts.adapterId, commandBasename);
  const { args: spawnArgs, env: spawnEnv } = applyAdapterDefaults(
    adapterId,
    opts.args,
    process.env as Record<string, string>,
  );

  // Spawn first so the user sees their CLI start immediately even if the
  // server is slow to respond.
  const pty = nodePty.spawn(resolvedCommand, spawnArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: spawnEnv,
  });

  // Default session name reflects WHAT'S RUNNING (`sw run claude` →
  // `claude@my-project`), not the wrapper adapter id.
  const defaultName = `${commandBasename}@${pathBasename(process.cwd()) || 'root'}`;
  const sessionName = opts.name ?? defaultName;

  const wsUrl = `${opts.serverUrl}/wrap`;
  const ws = new WebSocket(wsUrl);

  let connected = false;
  let exited = false;
  // After a server-driven resize we write `CSI 8;rows;cols t` so the local
  // Windows Terminal physically follows the new PTY size — without this the
  // window stays at its old size and the new content clips or leaves blank
  // space, and after phone-detach the user sees "desktop didn't restore".
  // Both our CSI 8 and any claude-emitted CSI 8 fire stdout 'resize' echoes;
  // suppress them via this Map (single var would get clobbered by rapid
  // back-to-back resizes, e.g. phone attach 47x30 then keyboard 47x22).
  const recentPendingResizes = new Map<string, NodeJS.Timeout>();
  const PENDING_TTL_MS = 1500;
  const markPendingResize = (cols: number, rows: number): void => {
    const key = `${cols}x${rows}`;
    const existing = recentPendingResizes.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => recentPendingResizes.delete(key), PENDING_TTL_MS);
    if (typeof t.unref === 'function') t.unref();
    recentPendingResizes.set(key, t);
  };
  const consumePendingResize = (cols: number, rows: number): boolean => {
    const key = `${cols}x${rows}`;
    const t = recentPendingResizes.get(key);
    if (!t) return false;
    clearTimeout(t);
    recentPendingResizes.delete(key);
    return true;
  };

  const sendWs = (msg: WrapClientMessage): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore — connection going down
    }
  };

  const restoreTerminal = (): void => {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    process.stdin.pause();
  };

  const cleanup = (code: number, signal?: number): void => {
    if (exited) return;
    exited = true;
    sendWs({ type: 'exit', code, signal });
    try {
      ws.close();
    } catch {
      // ignore
    }
    restoreTerminal();
    process.exit(code);
  };

  // hasLocalViewport tells the server whether wrapper's stdout corresponds to
  // a real terminal the user is watching. True for `sw run claude` in a real
  // PowerShell; false when wrapper runs headless (background / piped).
  const hasLocalViewport = Boolean(process.stdin.isTTY);

  ws.on('open', () => {
    connected = true;
    sendWs({
      type: 'register',
      adapterId,
      cwd: process.cwd(),
      name: sessionName,
      cols,
      rows,
      command: opts.command,
      args: opts.args,
      hasLocalViewport,
    });
  });

  ws.on('error', (err: Error) => {
    if (!connected) {
      process.stderr.write(
        `\n[switchboard] cannot reach server at ${wsUrl}: ${err.message}\n[switchboard] is the server running? Try: switchboard\n\n`,
      );
      pty.kill();
      restoreTerminal();
      process.exit(1);
    }
    // After connection: log but don't kill the local session.
    process.stderr.write(`\n[switchboard] WS error: ${err.message}\n`);
  });

  ws.on('message', (raw: Buffer) => {
    let msg: WrapServerMessage;
    try {
      msg = JSON.parse(raw.toString('utf8')) as WrapServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'registered':
        // Silent — printing here would interleave with claude's TUI.
        // The session appears in the phone client's list automatically.
        return;
      case 'input':
        pty.write(msg.data);
        return;
      case 'kill':
        try {
          pty.kill(msg.signal);
        } catch {
          // ignore
        }
        return;
      case 'resize':
        markPendingResize(msg.cols, msg.rows);
        try {
          pty.resize(msg.cols, msg.rows);
        } catch {
          // ignore
        }
        if (hasLocalViewport) {
          try {
            process.stdout.write(`\x1b[8;${msg.rows};${msg.cols}t`);
          } catch {
            // ignore
          }
        }
        return;
      case 'error':
        process.stderr.write(`\n[switchboard] server error: ${msg.message}\n`);
        return;
    }
  });

  // PTY → user's terminal AND server.
  pty.onData((data) => {
    process.stdout.write(data);
    sendWs({ type: 'pty', data });
  });

  pty.onExit(({ exitCode, signal }) => cleanup(exitCode, signal));

  // User's terminal → PTY. Raw mode so individual keystrokes pass through,
  // including arrow keys, Esc, Tab, Ctrl+C (which goes to claude, not us).
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('data', (chunk: Buffer) => {
    // Windows ConPTY translates the BackSpace key to 0x08 (Ctrl+H / BS), but
    // xterm-style TUIs (claude, codex) bind 0x08 to `backward-kill-word` and
    // 0x7f (DEL) to `backward-delete-char`. Bare claude in Windows Terminal
    // receives 0x7f directly; the inner node-pty ConPTY does not perform that
    // translation, so we do it here. Effect: one BackSpace = one character
    // (CJK words no longer get word-deleted, English runs no longer get
    // killed in one stroke).
    let translated: Buffer = chunk;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x08) {
        if (translated === chunk) translated = Buffer.from(chunk);
        translated[i] = 0x7f;
      }
    }
    pty.write(translated.toString('utf8'));
  });

  // User-initiated local terminal resize → report new size to server for MIN
  // negotiation. Echoes of server-driven resizes (matched via the pending Map)
  // are suppressed; without this they'd overwrite the wrapper's true ownSize
  // and break phone-detach restore.
  process.stdout.on('resize', () => {
    if (!hasLocalViewport) return;
    const newCols = process.stdout.columns || 80;
    const newRows = process.stdout.rows || 24;
    if (consumePendingResize(newCols, newRows)) return;
    sendWs({ type: 'local-resize', cols: newCols, rows: newRows });
  });

  // Defensive: if the user's terminal kills us with a signal, still send exit.
  process.on('SIGINT', () => cleanup(130));
  process.on('SIGTERM', () => cleanup(143));
  process.on('SIGHUP', () => cleanup(129));
}

function parseArgs(argv: string[]): WrapperOptions {
  let name: string | undefined;
  let adapterId: string | undefined;
  let serverUrl = 'ws://127.0.0.1:8787';
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if ((a === '-n' || a === '--name') && i + 1 < argv.length) {
      name = argv[i + 1];
      i += 2;
    } else if (a === '--adapter' && i + 1 < argv.length) {
      adapterId = argv[i + 1] as string;
      i += 2;
    } else if (a === '--server' && i + 1 < argv.length) {
      serverUrl = argv[i + 1] as string;
      i += 2;
    } else if (a === '-h' || a === '--help') {
      printRunHelp();
      process.exit(0);
    } else if (a === '--') {
      i++;
      break;
    } else {
      break;
    }
  }
  if (i >= argv.length) {
    process.stderr.write('Usage: switchboard run [options] <command> [args...]\n');
    process.stderr.write('Try `switchboard run --help` for details.\n');
    process.exit(2);
  }
  return {
    name,
    adapterId,
    serverUrl,
    command: argv[i] as string,
    args: argv.slice(i + 1),
  };
}

function printRunHelp(): void {
  process.stdout.write(`switchboard run [options] <command> [args...]

Wrap a process so it can be controlled from Switchboard clients.

Options:
  -n, --name <name>      Display name (default: <command>@<cwd-basename>)
      --adapter <id>     Adapter id (auto: codex/agy detected, else 'passthrough')
      --server <url>     Switchboard server WS base URL (default: ws://127.0.0.1:8787)
  -h, --help             Show this help

Examples:
  switchboard run claude
  switchboard run -n proj-x claude
  switchboard run codex                       # auto-applies --no-alt-screen + isolated CODEX_HOME
  switchboard run agy                         # Google Antigravity CLI (agy binary)
  switchboard run -- some-cmd --some-flag     # use -- to disambiguate flags
`);
}
