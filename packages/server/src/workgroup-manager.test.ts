import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Session, SessionManager, SpawnRawOpts, Workgroup } from '@switchboard/core';
import { WorkgroupManager } from './workgroup-manager.js';
import type { WorkgroupStore } from './workgroup-store.js';

test('adapter-less workgroup members use raw passthrough spawning', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-workgroup-test-'));
  let rawOpts: SpawnRawOpts | undefined;
  const sessions = {
    get: () => undefined,
    spawn: () => {
      throw new Error('adapter spawn should not be used');
    },
    spawnRaw: (opts: SpawnRawOpts) => {
      rawOpts = opts;
      return { id: 'raw-session' } as Session;
    },
  } as unknown as SessionManager;
  const store = {
    loadAll: async () => [],
    save: async (_workgroup: Workgroup) => undefined,
  } as unknown as WorkgroupStore;
  const manager = new WorkgroupManager(sessions, store);
  const workgroup = await manager.create('raw-test', cwd);

  const member = await manager.addMember(workgroup.id, { command: 'gemini' });

  assert.equal(rawOpts?.command, 'gemini');
  assert.equal(rawOpts?.cwd, cwd);
  assert.equal(member.adapterId, 'gemini');
  assert.equal(member.sessionId, 'raw-session');
});
