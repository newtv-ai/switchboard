import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureGo2rtc, getGo2rtcPath } from './go2rtc-bin.js';

const PERSIST_DIR = join(homedir(), '.switchboard');
const PERSIST_FILE = join(PERSIST_DIR, 'cameras.json');

export interface Go2rtcManagerOpts {
  apiPort?: number;
  webrtcPort?: number;
  onLog?: (line: string) => void;
}

export class Go2rtcManager {
  private proc: ChildProcess | null = null;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private binPath: string | null;
  readonly apiBase: string;

  constructor(private readonly opts: Go2rtcManagerOpts = {}) {
    const port = opts.apiPort ?? 1984;
    this.apiBase = `http://127.0.0.1:${port}`;
    this.binPath = getGo2rtcPath();
  }

  get isAvailable(): boolean {
    return this.binPath !== null;
  }

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async start(): Promise<boolean> {
    if (!this.binPath) {
      const downloaded = await ensureGo2rtc(this.opts.onLog);
      if (!downloaded) return false;
      this.binPath = downloaded;
    }
    if (this.isRunning) return true;
    this.stopped = false;
    this.restartCount = 0;
    this.spawnProcess();
    // Wait for go2rtc to be ready
    const ready = await this.waitForReady(8000);
    if (ready) {
      this.startHealthCheck();
      await this.ensurePhoneStream();
      await this.restoreSavedStreams();
    }
    return ready;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.proc) return;
    // Graceful shutdown via API
    try {
      await fetch(`${this.apiBase}/api/exit?code=0`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    } catch {
      // API unreachable, force kill
    }
    // Give it a moment, then force
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (this.proc && this.proc.exitCode === null) {
          this.proc.kill('SIGKILL');
        }
        resolve();
      }, 2000);
      if (this.proc) {
        this.proc.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      } else {
        clearTimeout(t);
        resolve();
      }
    });
    this.proc = null;
  }

  async addStream(name: string, source: string, persist = true): Promise<boolean> {
    try {
      await fetch(
        `${this.apiBase}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(source)}`,
        { method: 'PUT', signal: AbortSignal.timeout(5000) },
      );
      const streams = await this.listStreams();
      const ok = streams !== null && name in streams;
      if (ok && persist && source) {
        savePersistedStream(name, source);
      }
      return ok;
    } catch {
      return false;
    }
  }

  async removeStream(name: string): Promise<boolean> {
    try {
      await fetch(
        `${this.apiBase}/api/streams?dst=${encodeURIComponent(name)}`,
        { method: 'DELETE', signal: AbortSignal.timeout(5000) },
      );
      const streams = await this.listStreams();
      const ok = streams !== null && !(name in streams);
      if (ok) removePersistedStream(name);
      return ok;
    } catch {
      return false;
    }
  }

  async listStreams(): Promise<Record<string, unknown> | null> {
    try {
      const resp = await fetch(`${this.apiBase}/api/streams`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      return await resp.json() as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async getInfo(): Promise<{ version?: string } | null> {
    try {
      const resp = await fetch(`${this.apiBase}/api`, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) return null;
      return await resp.json() as { version?: string };
    } catch {
      return null;
    }
  }

  // --- internal ---

  private spawnProcess(): void {
    if (!this.binPath || this.stopped) return;

    const apiPort = this.opts.apiPort ?? 1984;
    const webrtcPort = this.opts.webrtcPort ?? 8555;

    const config = JSON.stringify({
      api: { listen: `:${apiPort}` },
      webrtc: {
        listen: `:${webrtcPort}`,
        candidates: [`127.0.0.1:${webrtcPort}`],
        ice_servers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        filters: { loopback: true },
      },
    });

    this.proc = spawn(this.binPath, ['-c', config], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) this.opts.onLog?.(`[go2rtc] ${line}`);
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) this.opts.onLog?.(`[go2rtc:err] ${line}`);
    });

    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      this.opts.onLog?.(`[go2rtc] exited with code ${code}, scheduling restart`);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    const delay = Math.min(1000 * 2 ** this.restartCount, 30_000);
    this.restartCount++;
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      this.spawnProcess();
      const ready = await this.waitForReady(5000);
      if (ready && !this.healthTimer) {
        this.startHealthCheck();
        await this.ensurePhoneStream();
      }
    }, delay);
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(async () => {
      const info = await this.getInfo();
      if (!info && this.isRunning) {
        this.opts.onLog?.('[go2rtc] health check failed, process may be hung');
      }
      if (info) this.restartCount = 0;
    }, 10_000);
  }

  private async waitForReady(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.stopped) return false;
      const info = await this.getInfo();
      if (info) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  private async ensurePhoneStream(): Promise<void> {
    await this.addStream('phone_cam', '', false);
  }

  private async restoreSavedStreams(): Promise<void> {
    const saved = loadPersistedStreams();
    for (const [name, source] of Object.entries(saved)) {
      await this.addStream(name, source, false);
    }
    if (Object.keys(saved).length > 0) {
      this.opts.onLog?.(`[go2rtc] restored ${Object.keys(saved).length} saved camera(s)`);
    }
  }
}

function loadPersistedStreams(): Record<string, string> {
  try {
    if (!existsSync(PERSIST_FILE)) return {};
    return JSON.parse(readFileSync(PERSIST_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function savePersistedStream(name: string, source: string): void {
  const data = loadPersistedStreams();
  data[name] = source;
  writePersistedStreams(data);
}

function removePersistedStream(name: string): void {
  const data = loadPersistedStreams();
  delete data[name];
  writePersistedStreams(data);
}

function writePersistedStreams(data: Record<string, string>): void {
  try {
    mkdirSync(PERSIST_DIR, { recursive: true });
    writeFileSync(PERSIST_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // best-effort
  }
}
