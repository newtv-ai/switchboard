import assert from 'node:assert/strict';
import test from 'node:test';
import { WrapperBackend, type WrapperBackendOutgoing } from './wrapper-backend.js';

function channel(target: string[]): WrapperBackendOutgoing {
  return {
    sendInput: (data) => target.push(`input:${data}`),
    sendResize: (cols, rows) => target.push(`resize:${cols}x${rows}`),
    sendKill: (signal) => target.push(`kill:${signal ?? ''}`),
  };
}

test('stale unbind cannot detach a newer wrapper transport', () => {
  const first: string[] = [];
  const second: string[] = [];
  const backend = new WrapperBackend();

  const unbindFirst = backend.bind(channel(first));
  backend.write('a');

  const unbindSecond = backend.bind(channel(second));
  unbindFirst();
  backend.write('b');
  backend.resize(80, 24);

  assert.deepEqual(first, ['input:a']);
  assert.deepEqual(second, ['input:b', 'resize:80x24']);
  assert.equal(backend.isBound, true);

  unbindSecond();
  backend.write('ignored');
  assert.equal(backend.isBound, false);
  assert.deepEqual(second, ['input:b', 'resize:80x24']);
});

test('connection changes are reported once per real transition', () => {
  const sink: string[] = [];
  const transitions: boolean[] = [];
  const backend = new WrapperBackend();
  backend.setConnectionListener(() => transitions.push(backend.isConnected()));

  assert.equal(backend.isConnected(), false);

  const unbindFirst = backend.bind(channel(sink));
  // Superseding transport: still connected the whole time, so no flap is
  // reported to the Session (and no spurious "offline" banner on the phone).
  const unbindSecond = backend.bind(channel(sink));
  unbindFirst();
  assert.deepEqual(transitions, [true]);
  assert.equal(backend.isConnected(), true);

  unbindSecond();
  assert.deepEqual(transitions, [true, false]);
  assert.equal(backend.isConnected(), false);
});
