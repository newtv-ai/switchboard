import type { AgentAdapter } from '@switchboard/sdk';

/**
 * The "any-CLI" adapter. Spawns a plain shell so the user can run anything inside it.
 * Built into the server in Phase 1; will be promoted to its own package in Phase 2.
 *
 * The shell choice is controlled by the SWITCHBOARD_PASSTHROUGH_CMD env var,
 * defaulting to powershell.exe on Windows and the user's $SHELL elsewhere.
 */
const isWindows = process.platform === 'win32';
const defaultCommand =
  process.env.SWITCHBOARD_PASSTHROUGH_CMD ??
  (isWindows ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash'));

export const passthroughAdapter: AgentAdapter = {
  manifest: {
    id: 'passthrough',
    displayName: 'Raw Terminal',
    adapterVersion: '0.1.0',
    agentVersionRange: '*',
    capabilities: [],
  },
  buildCommand: ({ cwd, env }) => ({
    command: defaultCommand,
    args: [],
    env: {
      ...(process.env as Record<string, string>),
      ...(env ?? {}),
      TERM: 'xterm-256color',
    },
    cwd,
  }),
};
