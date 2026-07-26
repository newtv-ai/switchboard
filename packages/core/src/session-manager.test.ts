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

test('publishes lifecycle events and throttles activity-only updates', async () => {
  const manager = new SessionManager({ activityBroadcastIntervalMs: 20 });
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

  backend.pushData('one');
  backend.pushData('two');
  backend.pushData('three');
  await delay(30);

  assert.equal(
    events.filter((event) => event.type === 'updated' && event.reason === 'activity').length,
    1,
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

test('rejects structured capability claims when the adapter has no parser', () => {
  const manager = new SessionManager();
  assert.throws(
    () =>
      manager.registerAdapter({
        ...adapter,
        manifest: { ...adapter.manifest, capabilities: ['tool-use'] },
      }),
    /declares structured capabilities without a parser/,
  );
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
