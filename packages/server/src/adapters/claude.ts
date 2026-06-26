import type { AgentAdapter } from '@switchboard/sdk';
import { detectCommand } from '../detect.js';

/**
 * Anthropic Claude Code CLI adapter.
 *
 * Until now `claude` had no dedicated adapter — `sw run claude` registers as
 * `passthrough` (see wrapper-cli.ts) and stays raw TUI. This adapter gives
 * `claude` a first-class id so the CLI scanner can report it as a known agent
 * and the (future) workgroup can target it by name / server-spawn it.
 *
 * No structured parser yet — runs as a raw TUI like the other built-in adapters.
 */
export const claudeAdapter: AgentAdapter = {
  manifest: {
    id: 'claude',
    displayName: 'Claude Code',
    adapterVersion: '0.1.0',
    agentVersionRange: '*',
    capabilities: [],
    install: {
      detect: () => detectCommand('claude'),
      hint: 'npm install -g @anthropic-ai/claude-code',
    },
  },
  buildCommand: ({ cwd, env }) => ({
    command: 'claude',
    args: [],
    env: {
      ...(process.env as Record<string, string>),
      ...(env ?? {}),
      TERM: 'xterm-256color',
    },
    cwd,
  }),
};
