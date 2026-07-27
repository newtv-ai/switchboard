import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { WebSocket } from '@fastify/websocket';
import { SessionManager, WrapperBackend } from '@switchboard/core';
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

test('list-only browser connections get lifecycle snapshots, never output churn', async () => {
  const manager = new SessionManager();
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

  // A session that is merely printing must not move the list. This is what
  // made the session list repaint once a second on the phone while any CLI
  // was running.
  const beforeOutput = snapshots().length;
  backend.pushData('activity');
  await delay(30);
  assert.equal(snapshots().length, beforeOutput, 'output alone must not push a snapshot');

  backend.pushExit(0);
  assert.deepEqual(snapshots().at(-1)?.list, []);

  socket.close();
  await manager.shutdown();
});

test('input is refused, not swallowed, while the wrapper transport is down', async () => {
  const manager = new SessionManager();
  manager.registerAdapter(adapter);
  const socket = new FakeSocket();
  bindWebSocket(socket as unknown as WebSocket, manager);

  const backend = new WrapperBackend();
  const written: string[] = [];
  const unbind = backend.bind({
    sendInput: (data) => written.push(data),
    sendResize: () => {},
    sendKill: () => {},
  });
  const session = manager.register({ adapterId: 'test', cwd: process.cwd(), backend });

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'attach', sessionId: session.id })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'online' })));
  assert.deepEqual(written, ['online']);

  unbind();
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'offline' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'offline again' })));

  const frames = socket.sent as Array<{ type: string; connected?: boolean; message?: string }>;
  assert.deepEqual(written, ['online'], 'nothing may be written while unbound');
  assert.deepEqual(
    frames.filter((f) => f.type === 'transport').map((f) => f.connected),
    [false],
  );
  // One notice per outage, not one per keystroke.
  assert.equal(frames.filter((f) => f.type === 'error').length, 1);

  backend.bind({
    sendInput: (data) => written.push(data),
    sendResize: () => {},
    sendKill: () => {},
  });
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'back' })));
  assert.deepEqual(written, ['online', 'back']);
  assert.deepEqual(
    frames.filter((f) => f.type === 'transport').map((f) => f.connected),
    [false, true],
  );

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
