import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';
import fastifyWebsocket from '@fastify/websocket';
import { SessionManager } from '@switchboard/core';
import type { AgentAdapter } from '@switchboard/sdk';
import Fastify from 'fastify';
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

interface Harness {
  sessions: SessionManager;
  connectionCount: () => number;
  dropWrapperConnections(): void;
  close(): Promise<void>;
}

async function startHarness(port: number): Promise<Harness & { port: number }> {
  const sessions = new SessionManager();
  sessions.registerAdapter(adapter);
  const registry = new WrapperRegistry(sessions, { gracePeriodMs: 3000 });
  const app = Fastify({ logger: false });
  const activeSockets = new Set<{ close(code?: number, reason?: string): void }>();
  let connections = 0;

  await app.register(fastifyWebsocket);
  app.get('/wrap', { websocket: true }, (socket) => {
    connections += 1;
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
    bindWrap(socket, registry);
  });
  await app.listen({ host: '127.0.0.1', port });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');

  return {
    port: address.port,
    sessions,
    connectionCount: () => connections,
    dropWrapperConnections: () => {
      for (const socket of activeSockets) socket.close(1012, 'integration test transport drop');
    },
    close: async () => {
      registry.dispose();
      await sessions.shutdown();
      await app.close();
    },
  };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${message}`);
}

function startWrapper(port: number): ChildProcess {
  const serverCli = join(process.cwd(), 'packages', 'server', 'dist', 'index.js');
  const child = spawn(
    process.execPath,
    [
      serverCli,
      'run',
      '--server',
      `ws://127.0.0.1:${port}`,
      process.execPath,
      '-e',
      "process.stdin.resume(); setInterval(() => process.stdout.write('tick\\n'), 100)",
    ],
    {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

test(
  'real wrapper survives ten transport drops and re-registers after server restart',
  { timeout: 35_000 },
  async () => {
    let firstHarness: (Harness & { port: number }) | undefined;
    let secondHarness: (Harness & { port: number }) | undefined;
    let wrapper: ChildProcess | undefined;

    try {
      firstHarness = await startHarness(0);
      wrapper = startWrapper(firstHarness.port);
      await waitFor(() => firstHarness?.sessions.list().length === 1, 'initial registration');
      const firstSessionId = firstHarness.sessions.list()[0]?.id;
      assert.ok(firstSessionId);

      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const activityBeforeDrop =
          firstHarness.sessions.get(firstSessionId)?.lastActivityAt.getTime() ?? 0;
        const expectedConnections = firstHarness.connectionCount() + 1;
        firstHarness.dropWrapperConnections();
        await waitFor(
          () => (firstHarness?.connectionCount() ?? 0) >= expectedConnections,
          `wrapper reconnect ${attempt}`,
        );
        await waitFor(
          () =>
            (firstHarness?.sessions.get(firstSessionId)?.lastActivityAt.getTime() ?? 0) >
            activityBeforeDrop,
          `PTY traffic after reconnect ${attempt}`,
        );
        assert.deepEqual(
          firstHarness.sessions.list().map((session) => session.id),
          [firstSessionId],
        );
      }

      const port = firstHarness.port;
      await firstHarness.close();
      firstHarness = undefined;

      secondHarness = await startHarness(port);
      await waitFor(() => secondHarness?.sessions.list().length === 1, 'post-restart registration');
      const secondSessionId = secondHarness.sessions.list()[0]?.id;
      assert.ok(secondSessionId);
      assert.notEqual(secondSessionId, firstSessionId);

      const wrapperExit = once(wrapper, 'exit');
      secondHarness.sessions.get(secondSessionId)?.kill();
      const [exitCode] = (await wrapperExit) as [number | null];
      assert.notEqual(exitCode, null);
      await waitFor(
        () => secondHarness?.sessions.list().length === 0,
        'wrapper exit cleanup',
        1000,
      );
    } finally {
      if (wrapper?.exitCode === null) wrapper.kill();
      await secondHarness?.close();
      await firstHarness?.close();
    }
  },
);
