import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '@switchboard/sdk';
import { detectCommand } from '../detect.js';

/**
 * OpenAI Codex CLI adapter.
 *
 * Two non-obvious defaults are baked in (also applied by wrapper-cli when the
 * user runs `sw run codex` directly):
 *
 *  - `--no-alt-screen`: codex uses the terminal alternate screen by default,
 *    which means the conversation disappears from scrollback when it exits.
 *    For a phone xterm.js viewer, scrollback IS the history — alt-screen
 *    makes the session feel like it has no memory.
 *
 *  - Isolated `CODEX_HOME`: codex stores state + telemetry in a shared SQLite
 *    DB under `~/.codex/`. Two concurrent codex processes deadlock on those
 *    DBs (openai/codex#20213). A per-session temp dir sidesteps it; the cost
 *    is that sessions don't share rollout history, which is fine for our
 *    "each terminal is one session" model.
 */
function freshCodexHome(): string {
  return mkdtempSync(join(tmpdir(), 'switchboard-codex-'));
}

export const codexAdapter: AgentAdapter = {
  manifest: {
    id: 'codex',
    displayName: 'Codex',
    adapterVersion: '0.1.0',
    agentVersionRange: '*',
    capabilities: ['tool-use', 'approval-flow'],
    install: {
      detect: () => detectCommand('codex'),
      hint: 'Install the OpenAI Codex CLI — https://github.com/openai/codex',
    },
  },
  buildCommand: ({ cwd, env }) => ({
    command: 'codex',
    args: ['--no-alt-screen'],
    env: {
      ...(process.env as Record<string, string>),
      ...(env ?? {}),
      TERM: 'xterm-256color',
      CODEX_HOME: freshCodexHome(),
    },
    cwd,
  }),
};
