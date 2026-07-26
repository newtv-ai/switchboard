import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { WebSocket } from '@fastify/websocket';
import { SessionManager } from '@switchboard/core';
import type { SessionBackend } from '@switchboard/core';
import type { AgentAdapter } from '@switchboard/sdk';
import { bindWebSocket } from './ws-handler.js';

const adapter: AgentAdapter = {
  manifest: {
    id: 'test',
    displayName: 'Test',
    adapterVersion: '1.0.0',
    agentVersionRange: '*',
    capabilities: [],
  },
  buildCommand: ({ cwd, env }) => ({
    command: 'unused',
    args: [],
    env: env ?? {},
    cwd,
  }),
};

class FakeBackend implements SessionBackend {
  private readonly dataHandlers = new Set<(chunk: Buffer) => void>();
  private readonly exitHandlers = new Set<(code: number, signal?: number) => void>();

  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(handler: (chunk: Buffer) => void): void {
    this.dataHandlers.add(handler);
  }
  onExit(handler: (code: number, signal?: number) => void): void {
    this.exitHandlers.add(handler);
  }
  dispose(): void {
    this.dataHandlers.clear();
    this.exitHandlers.clear();
  }
  pushData(data: string): void {
    for (const handler of this.dataHandlers) handler(Buffer.from(data));
  }
  pushExit(code: number): void {
    for (const handler of this.exitHandlers) handler(code);
  }
}

interface SessionsMessage {
  type: 'sessions';
  list: Array<{ id: string; bufferBytes: number }>;
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: unknown[] = [];
  failSends = false;

  send(raw: string): void {
    if (this.failSends) throw new Error('socket closed during send');
    this.sent.push(JSON.parse(raw));
  }

  close(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('list-only browser connections receive live Session snapshots', async () => {
  const manager = new SessionManager({ activityBroadcastIntervalMs: 20 });
  manager.registerAdapter(adapter);
  const socket = new FakeSocket();
  bindWebSocket(socket as unknown as WebSocket, manager);

  const snapshots = (): SessionsMessage[] =>
    socket.sent.filter(
      (message): message is SessionsMessage =>
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: string }).type === 'sessions',
    );

  assert.deepEqual(snapshots().at(-1)?.list, []);

  const backend = new FakeBackend();
  const session = manager.register({
    adapterId: 'test',
    cwd: process.cwd(),
    backend,
  });
  assert.equal(snapshots().at(-1)?.list[0]?.id, session.id);

  backend.pushData('activity');
  await delay(30);
  assert.equal(snapshots().at(-1)?.list[0]?.bufferBytes, Buffer.byteLength('activity'));

  backend.pushExit(0);
  assert.deepEqual(snapshots().at(-1)?.list, []);

  socket.close();
  await manager.shutdown();
});

test('a socket close race does not interrupt Session output or cleanup', async () => {
  const manager = new SessionManager();
  manager.registerAdapter(adapter);
  const socket = new FakeSocket();
  bindWebSocket(socket as unknown as WebSocket, manager);

  const backend = new FakeBackend();
  manager.register({
    adapterId: 'test',
    cwd: process.cwd(),
    backend,
  });

  socket.failSends = true;
  assert.doesNotThrow(() => backend.pushData('late output'));
  assert.doesNotThrow(() => backend.pushExit(0));
  assert.deepEqual(manager.list(), []);

  socket.close();
  await manager.shutdown();
});
