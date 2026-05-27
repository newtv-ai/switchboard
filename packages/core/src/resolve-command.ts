import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/**
 * Windows ConPTY (via node-pty) does NOT consult PATHEXT, so `claude` won't
 * auto-resolve to `claude.cmd` and `node` won't auto-resolve to `node.exe`.
 * Replicate the PATH+PATHEXT search ourselves; on POSIX it's just a PATH walk.
 */
export function resolveCommand(cmd: string): string {
  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return cmd;

  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const isWindows = process.platform === 'win32';
  const exts =
    isWindows && extname(cmd) === ''
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];

  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return cmd;
}
