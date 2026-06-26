import type { AgentAdapter } from '@switchboard/sdk';
import { detectCommand } from '../detect.js';

/**
 * Google Antigravity CLI adapter (`agy`, Go binary; distinct from the
 * Antigravity IDE which is a VS Code fork).
 *
 * No flag or env-var defaults are applied today:
 *  - alt-screen behaviour of `agy` is undocumented; we'll add `--no-alt-screen`
 *    (or equivalent) only after observing it eats phone-side scrollback.
 *  - There is no `AGY_HOME`-style env var to isolate per-session state.
 *    Config lives in `~/.gemini/antigravity-cli/`, shared with the Gemini CLI.
 *    If concurrent sessions turn out to fight over that dir (e.g. the codex
 *    SQLite-lock pattern), we'll have to overlay `HOME` per spawn.
 *
 * Auth is Google OAuth (`agy` opens a browser on first run). There's no API
 * key support yet — see https://github.com/google-antigravity/antigravity-cli/issues/78
 */
export const antigravityAdapter: AgentAdapter = {
  manifest: {
    id: 'antigravity',
    displayName: 'Antigravity',
    adapterVersion: '0.1.0',
    agentVersionRange: '*',
    capabilities: ['tool-use', 'approval-flow'],
    install: {
      detect: () => detectCommand('agy'),
      hint: 'Install the Google Antigravity CLI (agy) — https://github.com/google-antigravity/antigravity-cli',
    },
  },
  buildCommand: ({ cwd, env }) => ({
    command: 'agy',
    args: [],
    env: {
      ...(process.env as Record<string, string>),
      ...(env ?? {}),
      TERM: 'xterm-256color',
    },
    cwd,
  }),
};
