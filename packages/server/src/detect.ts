import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCommand } from '@switchboard/core';
import type { DetectResult } from '@switchboard/sdk';

const execFileP = promisify(execFile);

/** Pull the first semver-ish token out of a `--version` blob, else the first line. */
function parseVersion(out: string): string | undefined {
  const m = out.match(/\d+\.\d+(?:\.\d+)?/);
  if (m) return m[0];
  const firstLine = out.split(/\r?\n/)[0]?.trim();
  return firstLine || undefined;
}

/**
 * Best-effort `<cmd> --version`. Wrapped in try/catch — a CLI that's on PATH but
 * doesn't support `--version` (or is slow) just yields an undefined version, not
 * a failed detection.
 *
 * Windows: claude/codex are often `.cmd` shims, which recent Node refuses to run
 * via execFile without a shell. Quote the resolved path and go through cmd.exe.
 */
async function tryVersion(resolved: string): Promise<string | undefined> {
  const useShell = process.platform === 'win32';
  const cmd = useShell ? `"${resolved}"` : resolved;
  try {
    const { stdout, stderr } = await execFileP(cmd, ['--version'], {
      timeout: 3000,
      windowsHide: true,
      shell: useShell,
    });
    return parseVersion(`${stdout}\n${stderr}`);
  } catch {
    return undefined;
  }
}

/**
 * Detect whether a CLI command is installed (resolvable on PATH) and, best-effort,
 * its version. `installed` is decided purely by PATH resolution (reusing core's
 * PATHEXT-aware `resolveCommand`); `version` is a bonus.
 */
export async function detectCommand(command: string): Promise<DetectResult> {
  const resolved = resolveCommand(command);
  // resolveCommand returns the input unchanged when nothing is found on PATH.
  if (resolved === command) return { installed: false };
  return { installed: true, path: resolved, version: await tryVersion(resolved) };
}
