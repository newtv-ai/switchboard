import type { SessionManager } from '@switchboard/core';
import { detectCommand } from './detect.js';

/** One row of the "what AI CLIs are on this machine" scan. */
export interface CliScanResult {
  /** Adapter id when there's a dedicated adapter, else the probed command name. */
  adapterId: string;
  displayName: string;
  /** The command probed (set for adapter-less probes). */
  command?: string;
  path?: string;
  version?: string;
  /** false → no dedicated adapter; would run in passthrough/raw mode. */
  hasAdapter: boolean;
  status: 'available' | 'missing' | 'error';
}

/**
 * Known AI coding CLIs worth probing even though no dedicated adapter exists yet.
 * Probed only when their id isn't already covered by a registered adapter, and
 * reported only when actually found (keeps the list to "what you can use now").
 */
const EXTRA_COMMANDS = ['gemini', 'qwen', 'opencode', 'aider', 'cursor'] as const;

/**
 * Scan the machine for available AI coding CLIs: every registered adapter that
 * can detect itself, plus a probe of well-known adapter-less commands.
 * `passthrough` (the raw shell) is intentionally excluded — it's not an agent.
 */
export async function scanClis(sessions: SessionManager): Promise<CliScanResult[]> {
  const manifests = sessions.listAdapters();

  const adapterScans = manifests.map(async (m): Promise<CliScanResult | null> => {
    if (m.id === 'passthrough') return null;
    const detect = m.install?.detect;
    if (!detect) {
      return { adapterId: m.id, displayName: m.displayName, hasAdapter: true, status: 'error' };
    }
    try {
      const r = await detect();
      return {
        adapterId: m.id,
        displayName: m.displayName,
        path: r.path,
        version: r.version,
        hasAdapter: true,
        status: r.installed ? 'available' : 'missing',
      };
    } catch {
      return { adapterId: m.id, displayName: m.displayName, hasAdapter: true, status: 'error' };
    }
  });

  const adapterIds = new Set(manifests.map((m) => m.id));
  const extraScans = EXTRA_COMMANDS.filter((c) => !adapterIds.has(c)).map(
    async (command): Promise<CliScanResult | null> => {
      const r = await detectCommand(command);
      if (!r.installed) return null;
      return {
        adapterId: command,
        displayName: command,
        command,
        path: r.path,
        version: r.version,
        hasAdapter: false,
        status: 'available',
      };
    },
  );

  const all = await Promise.all([...adapterScans, ...extraScans]);
  return all.filter((r): r is CliScanResult => r !== null);
}
