import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { WebSocket } from '@fastify/websocket';
import { SessionManager } from '@switchboard/core';
import type { AgentAdapter } from '@switchboard/sdk';
import { WrapperRegistry, bindWrap } from './wrap-handler.js';

const adapter: AgentAdapter = {
  manifest: {
    id: 'passthrough',
    displayName: 'Raw Terminal',
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

type SentMessage = Record<string, unknown> & { type: string };

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: SentMessage[] = [];

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as SentMessage);
  }

  close(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }

  receive(message: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }
}

function createManager(): SessionManager {
  const manager = new SessionManager();
  manager.registerAdapter(adapter);
  return manager;
}

function bind(socket: FakeSocket, registry: WrapperRegistry): void {
  bindWrap(socket as unknown as WebSocket, registry);
}

function register(socket: FakeSocket, wrapperId = 'wrapper-1', resumeKey = 'secret-1'): string {
  socket.receive({
    type: 'register',
    wrapperId,
    resumeKey,
    adapterId: 'passthrough',
    cwd: process.cwd(),
    cols: 100,
    rows: 30,
    command: 'test-cli',
    args: [],
    hasLocalViewport: true,
  });
  const message = socket.sent.at(-1);
  assert.equal(message?.type, 'registered');
  assert.equal(typeof message?.sessionId, 'string');
  return message.sessionId as string;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('resume reuses the Session and a stale close cannot detach the new socket', async () => {
  const manager = createManager();
  const registry = new WrapperRegistry(manager, { gracePeriodMs: 30 });
  const first = new FakeSocket();
  bind(first, registry);
  const sessionId = register(first);

  first.receive({ type: 'pty', data: 'before-' });
  first.close();
  assert.ok(manager.get(sessionId));

  const second = new FakeSocket();
  bind(second, registry);
  second.receive({
    type: 'resume',
    wrapperId: 'wrapper-1',
    resumeKey: 'secret-1',
    sessionId,
    cols: 90,
    rows: 25,
    hasLocalViewport: true,
  });

  assert.deepEqual(second.sent.at(-1), { type: 'resumed', sessionId });
  manager.get(sessionId)?.write('remote-input');
  assert.equal(
    second.sent.some((message) => message.type === 'input'),
    true,
  );

  await delay(45);
  assert.equal(manager.list().length, 1);

  second.receive({ type: 'pty', data: 'after' });
  assert.equal(manager.get(sessionId)?.getReplay().toString(), 'before-after');

  second.receive({ type: 'exit', code: 0 });
  assert.equal(manager.list().length, 0);
  registry.dispose();
  await manager.shutdown();
});

test('server restart rejects resume, then accepts a fresh registration without killing the PTY', async () => {
  const oldManager = createManager();
  const oldRegistry = new WrapperRegistry(oldManager, { gracePeriodMs: 30 });
  const oldSocket = new FakeSocket();
  bind(oldSocket, oldRegistry);
  const oldSessionId = register(oldSocket);

  oldRegistry.dispose();
  await oldManager.shutdown();
  assert.equal(
    oldSocket.sent.some((message) => message.type === 'kill'),
    false,
  );

  const newManager = createManager();
  const newRegistry = new WrapperRegistry(newManager, { gracePeriodMs: 30 });
  const newSocket = new FakeSocket();
  bind(newSocket, newRegistry);
  newSocket.receive({
    type: 'resume',
    wrapperId: 'wrapper-1',
    resumeKey: 'secret-1',
    sessionId: oldSessionId,
    cols: 100,
    rows: 30,
    hasLocalViewport: true,
  });
  assert.equal(newSocket.sent.at(-1)?.type, 'resume-rejected');

  const newSessionId = register(newSocket);
  assert.notEqual(newSessionId, oldSessionId);
  assert.equal(newManager.list().length, 1);

  newRegistry.dispose();
  await newManager.shutdown();
});

test('pre-v1.2 wrappers can still perform a one-connection registration', async () => {
  const manager = createManager();
  const registry = new WrapperRegistry(manager, { gracePeriodMs: 20 });
  const socket = new FakeSocket();
  bind(socket, registry);

  socket.receive({
    type: 'register',
    adapterId: 'passthrough',
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    command: 'legacy-cli',
    args: [],
  });

  assert.equal(socket.sent.at(-1)?.type, 'registered');
  assert.equal(manager.list().length, 1);

  socket.close();
  await delay(30);
  assert.equal(manager.list().length, 0);

  registry.dispose();
  await manager.shutdown();
});
