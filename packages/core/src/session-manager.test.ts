import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentAdapter } from '@switchboard/sdk';
import type { SessionBackend } from './backend.js';
import { SessionManager, type SessionManagerEvent } from './session-manager.js';

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
  killed = false;

  write(): void {}
  resize(): void {}
  kill(): void {
    this.killed = true;
  }
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('publishes lifecycle events but stays silent while a session only prints', async () => {
  const manager = new SessionManager();
  manager.registerAdapter(adapter);
  const events: SessionManagerEvent[] = [];
  manager.subscribe((event) => events.push(event));

  const backend = new FakeBackend();
  const session = manager.register({
    adapterId: 'test',
    cwd: process.cwd(),
    backend,
  });

  assert.deepEqual(
    events.map((event) => event.type),
    ['created'],
  );

  // Output must never be a list event. Every subscriber answers an event by
  // re-sending the whole session list, so a printing CLI would repaint the
  // session list in every open browser for as long as it prints.
  backend.pushData('one');
  backend.pushData('two');
  backend.pushData('three');
  await delay(30);

  assert.deepEqual(
    events.map((event) => event.type),
    ['created'],
  );

  backend.pushExit(0);
  assert.equal(manager.get(session.id), undefined);
  assert.deepEqual(
    events.slice(-3).map((event) => event.type),
    ['updated', 'exited', 'removed'],
  );

  await manager.shutdown();
});

test('shutdown leaves wrapped PTYs alive because the wrapper owns them', async () => {
  const manager = new SessionManager();
  manager.registerAdapter(adapter);
  const backend = new FakeBackend();
  manager.register({
    adapterId: 'test',
    cwd: process.cwd(),
    backend,
  });

  await manager.shutdown();

  assert.equal(backend.killed, false);
  assert.equal(manager.list().length, 0);
});

test('notifies attached clients before manager cleanup disposes an exited Session', () => {
  const manager = new SessionManager();
  manager.registerAdapter(adapter);
  const backend = new FakeBackend();
  const session = manager.register({
    adapterId: 'test',
    cwd: process.cwd(),
    backend,
  });
  let exitCode: number | undefined;
  session.attach({
    onExit: (code) => {
      exitCode = code;
    },
  });

  backend.pushExit(7);

  assert.equal(exitCode, 7);
  assert.equal(manager.get(session.id), undefined);
});

test('drops structured capability claims when the adapter has no parser', () => {
  const manager = new SessionManager();
  const warnings: unknown[][] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    manager.registerAdapter({
      ...adapter,
      manifest: { ...adapter.manifest, capabilities: ['tool-use'] },
    });
  } finally {
    console.warn = realWarn;
  }

  // Registering still succeeds — a bad third-party manifest must not stop the
  // server from booting — but the claim never reaches a client.
  assert.deepEqual(manager.listAdapters()[0]?.capabilities, []);
  assert.equal(warnings.length, 1);
});

test('lists sessions newest-first so live updates cannot reorder rows', async () => {
  const manager = new SessionManager();
  manager.registerAdapter(adapter);
  const olderBackend = new FakeBackend();
  const older = manager.register({ adapterId: 'test', cwd: process.cwd(), backend: olderBackend });
  await delay(2);
  const newer = manager.register({
    adapterId: 'test',
    cwd: process.cwd(),
    backend: new FakeBackend(),
  });

  const order = (): string[] => manager.list().map((s) => s.id);
  assert.deepEqual(order(), [newer.id, older.id]);

  // Output on the older session must not make its row jump to the top.
  olderBackend.pushData('chatty');
  assert.deepEqual(order(), [newer.id, older.id]);

  await manager.shutdown();
});

test('exposes structured capabilities only when that Session enables its parser', async () => {
  const manager = new SessionManager();
  manager.registerAdapter({
    ...adapter,
    manifest: { ...adapter.manifest, id: 'structured', capabilities: ['tool-use'] },
    createParser: () => ({
      feed: () => [],
      getState: () => 'running',
    }),
  });

  const raw = manager.register({
    adapterId: 'structured',
    cwd: process.cwd(),
    backend: new FakeBackend(),
  });
  const structured = manager.register({
    adapterId: 'structured',
    cwd: process.cwd(),
    backend: new FakeBackend(),
    enableParser: true,
  });

  assert.deepEqual(raw.capabilities, []);
  assert.deepEqual(structured.capabilities, ['tool-use']);
  await manager.shutdown();
});
