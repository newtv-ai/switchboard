import * as nodePty from 'node-pty';
import type { SessionBackend } from './backend.js';

export interface LocalPtyOpts {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  cols: number;
  rows: number;
}

export class LocalPtyBackend implements SessionBackend {
  private readonly pty: nodePty.IPty;

  constructor(opts: LocalPtyOpts) {
    this.pty = nodePty.spawn(opts.command, [...opts.args], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: { ...opts.env },
    });
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.pty.resize(cols, rows);
  }

  kill(signal?: string): void {
    try {
      this.pty.kill(signal);
    } catch {
      // process may already be dead
    }
  }

  onData(handler: (chunk: Buffer) => void): void {
    this.pty.onData((data) => handler(Buffer.from(data, 'utf8')));
  }

  onExit(handler: (code: number, signal?: number) => void): void {
    this.pty.onExit(({ exitCode, signal }) => handler(exitCode, signal));
  }

  dispose(): void {
    // node-pty cleans up listeners when the process exits;
    // calling kill() in dispose risks double-kill races, so we leave it.
  }
}
