import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const GO2RTC_VERSION = '1.9.14';
const BIN_DIR = join(homedir(), '.switchboard', 'bin');

function binName(): string {
  return process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc';
}

function localBinPath(): string {
  return join(BIN_DIR, binName());
}

/**
 * Locate the go2rtc binary. Tries in order:
 * 1. ~/.switchboard/bin/go2rtc (auto-downloaded)
 * 2. @camera.ui/go2rtc npm package
 * 3. System PATH
 */
export function getGo2rtcPath(): string | null {
  const local = localBinPath();
  if (existsSync(local)) return local;

  const npmBin = findNpmPackageBin('@camera.ui/go2rtc');
  if (npmBin) return npmBin;

  const pathBin = findOnPath('go2rtc');
  if (pathBin) return pathBin;

  return null;
}

/**
 * Download go2rtc from GitHub Releases if not already present.
 * Returns the binary path, or null on failure.
 */
export async function ensureGo2rtc(
  onLog?: (msg: string) => void,
): Promise<string | null> {
  const existing = getGo2rtcPath();
  if (existing) return existing;

  const url = buildDownloadUrl();
  if (!url) {
    onLog?.(`[go2rtc] unsupported platform: ${process.platform}/${process.arch}`);
    return null;
  }

  onLog?.(`[go2rtc] binary not found — downloading v${GO2RTC_VERSION}...`);

  try {
    mkdirSync(BIN_DIR, { recursive: true });
    const target = localBinPath();
    const tmpFile = target + '.tmp';

    const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status} from ${url}`);
    }

    if (url.endsWith('.zip')) {
      // Download zip to temp, then extract the binary
      const zipFile = tmpFile + '.zip';
      const zipStream = createWriteStream(zipFile);
      // @ts-expect-error ReadableStream/NodeStream interop
      await pipeline(resp.body, zipStream);
      await extractFromZip(zipFile, target);
      try { unlinkSync(zipFile); } catch { /* ignore */ }
    } else {
      // Bare binary (Linux) — direct download
      const fileStream = createWriteStream(tmpFile);
      // @ts-expect-error ReadableStream/NodeStream interop
      await pipeline(resp.body, fileStream);
      if (existsSync(target)) unlinkSync(target);
      renameSync(tmpFile, target);
    }

    if (process.platform !== 'win32') {
      chmodSync(target, 0o755);
    }

    onLog?.(`[go2rtc] downloaded to ${target}`);
    return target;
  } catch (err) {
    onLog?.(`[go2rtc] download failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function buildDownloadUrl(): string | null {
  const base = `https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}`;
  const p = process.platform;
  const a = process.arch;

  if (p === 'win32') {
    if (a === 'x64') return `${base}/go2rtc_win64.zip`;
    if (a === 'arm64') return `${base}/go2rtc_win_arm64.zip`;
    return null;
  }
  if (p === 'darwin') {
    if (a === 'x64') return `${base}/go2rtc_mac_amd64.zip`;
    if (a === 'arm64') return `${base}/go2rtc_mac_arm64.zip`;
    return null;
  }
  if (p === 'linux') {
    if (a === 'x64') return `${base}/go2rtc_linux_amd64`;
    if (a === 'arm64') return `${base}/go2rtc_linux_arm64`;
    if (a === 'arm') return `${base}/go2rtc_linux_arm`;
    return null;
  }
  return null;
}

async function extractFromZip(zipPath: string, targetPath: string): Promise<void> {
  const dir = join(targetPath, '..');
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${dir}' -Force"`,
      { timeout: 30_000, stdio: 'pipe' },
    );
  } else {
    execSync(`unzip -o -j "${zipPath}" -d "${dir}"`, { timeout: 30_000, stdio: 'pipe' });
  }
}

function findNpmPackageBin(pkg: string): string | null {
  try {
    const result = execFileSync(process.execPath, [
      '-e', `process.stdout.write(require.resolve(${JSON.stringify(pkg + '/package.json')}))`,
    ], { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    const pkgDir = join(result.trim(), '..');
    const ext = process.platform === 'win32' ? '.exe' : '';
    const binPath = join(pkgDir, 'bin', `go2rtc${ext}`);
    if (existsSync(binPath)) return binPath;
  } catch {
    // not installed
  }
  return null;
}

function findOnPath(cmd: string): string | null {
  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const isWindows = process.platform === 'win32';
  const exts = isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
