import { randomUUID, timingSafeEqual } from 'node:crypto';
import { parse as parsePath } from 'node:path';
import type { WebSocket } from '@fastify/websocket';
import {
  type Session,
  type SessionManager,
  WrapperBackend,
  type WrapperBackendOutgoing,
} from '@switchboard/core';
import type { WrapClientMessage, WrapServerMessage } from './protocol.js';

const DEFAULT_GRACE_PERIOD_MS = 30_000;

export interface WrapperRegistryOpts {
  gracePeriodMs?: number;
}

interface WrapperRecord {
  wrapperId: string;
  resumeKey: string;
  session: Session;
  backend: WrapperBackend;
  activeConnectionId?: string;
  closeTransport?: () => void;
  unbindTransport?: () => void;
  disconnectTimer?: NodeJS.Timeout;
}

interface WrapperRegistration {
  wrapperId?: string;
  resumeKey?: string;
  adapterId: string;
  cwd: string;
  name?: string;
  cols: number;
  rows: number;
  command: string;
  hasLocalViewport?: boolean;
}

interface WrapperResume {
  wrapperId: string;
  resumeKey: string;
  sessionId: string;
}

interface WrapperViewport {
  cols: number;
  rows: number;
  hasLocalViewport?: boolean;
}

/**
 * Server-process-local identity registry for wrapper-owned PTYs. Sessions
 * remain stable while WebSocket transports are replaced underneath them.
 */
export class WrapperRegistry {
  private readonly records = new Map<string, WrapperRecord>();
  private readonly gracePeriodMs: number;

  constructor(
    private readonly sessions: SessionManager,
    opts: WrapperRegistryOpts = {},
  ) {
    this.gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  }

  register(msg: WrapperRegistration): WrapperRecord {
    assertRegistration(msg);
    assertViewport(msg);

    let wrapperId: string;
    let resumeKey: string;
    if (msg.wrapperId === undefined && msg.resumeKey === undefined) {
      // Pre-v1.2 wrappers can still register, but cannot know these generated
      // credentials and therefore retain their original one-connection behavior.
      wrapperId = `legacy-${randomUUID()}`;
      resumeKey = randomUUID();
    } else if (
      typeof msg.wrapperId === 'string' &&
      msg.wrapperId.length > 0 &&
      typeof msg.resumeKey === 'string' &&
      msg.resumeKey.length > 0
    ) {
      wrapperId = msg.wrapperId;
      resumeKey = msg.resumeKey;
    } else {
      throw new Error('wrapperId and resumeKey must be provided together');
    }
    if (this.records.has(wrapperId)) {
      throw new Error('wrapper is already registered; use resume');
    }

    const backend = new WrapperBackend();
    const session = this.sessions.register({
      adapterId: msg.adapterId,
      cwd: msg.cwd,
      backend,
      name: msg.name,
      commandName: parsePath(msg.command).name,
    });
    const record: WrapperRecord = {
      wrapperId,
      resumeKey,
      session,
      backend,
    };
    this.records.set(wrapperId, record);
    return record;
  }

  resume(msg: WrapperResume): WrapperRecord | undefined {
    if (
      typeof msg.wrapperId !== 'string' ||
      typeof msg.resumeKey !== 'string' ||
      typeof msg.sessionId !== 'string'
    ) {
      return undefined;
    }
    const record = this.records.get(msg.wrapperId);
    if (!record) return undefined;
    if (record.session.id !== msg.sessionId) return undefined;
    if (!equalSecret(record.resumeKey, msg.resumeKey)) return undefined;
    if (this.sessions.get(record.session.id) !== record.session) return undefined;
    return record;
  }

  bind(
    record: WrapperRecord,
    connectionId: string,
    outgoing: WrapperBackendOutgoing,
    viewport: WrapperViewport,
    closeTransport: () => void,
  ): void {
    assertViewport(viewport);
    if (this.records.get(record.wrapperId) !== record) {
      throw new Error('wrapper registration is no longer active');
    }

    if (record.disconnectTimer) {
      clearTimeout(record.disconnectTimer);
      record.disconnectTimer = undefined;
    }

    const previousConnectionId = record.activeConnectionId;
    const previousClose = record.closeTransport;
    record.unbindTransport?.();

    record.activeConnectionId = connectionId;
    record.closeTransport = closeTransport;
    record.unbindTransport = record.backend.bind(outgoing);
    record.backend.setLocalSize(
      viewport.hasLocalViewport ? { cols: viewport.cols, rows: viewport.rows } : undefined,
    );

    if (previousConnectionId && previousConnectionId !== connectionId) {
      previousClose?.();
    }
  }

  disconnect(record: WrapperRecord, connectionId: string): void {
    if (this.records.get(record.wrapperId) !== record) return;
    if (record.activeConnectionId !== connectionId) return;

    record.unbindTransport?.();
    record.unbindTransport = undefined;
    record.activeConnectionId = undefined;
    record.closeTransport = undefined;

    const timer = setTimeout(() => {
      if (this.records.get(record.wrapperId) !== record) return;
      if (record.activeConnectionId) return;
      this.records.delete(record.wrapperId);
      record.disconnectTimer = undefined;
      record.backend.pushExit(-1);
    }, this.gracePeriodMs);
    if (typeof timer.unref === 'function') timer.unref();
    record.disconnectTimer = timer;
  }

  complete(record: WrapperRecord, connectionId: string, code: number, signal?: number): void {
    if (this.records.get(record.wrapperId) !== record) return;
    if (record.activeConnectionId !== connectionId) return;

    if (record.disconnectTimer) clearTimeout(record.disconnectTimer);
    record.disconnectTimer = undefined;
    record.unbindTransport?.();
    record.unbindTransport = undefined;
    record.activeConnectionId = undefined;
    record.closeTransport = undefined;
    this.records.delete(record.wrapperId);
    record.backend.pushExit(code, signal);
  }

  dispose(): void {
    for (const record of this.records.values()) {
      if (record.disconnectTimer) clearTimeout(record.disconnectTimer);
      record.unbindTransport?.();
      record.disconnectTimer = undefined;
      record.unbindTransport = undefined;
      record.activeConnectionId = undefined;
      record.closeTransport = undefined;
    }
    this.records.clear();
  }
}

/**
 * Handle one physical wrapper WebSocket. A wrapper may establish several of
 * these sequentially while keeping the same local PTY and logical identity.
 */
export function bindWrap(socket: WebSocket, registry: WrapperRegistry): void {
  const connectionId = randomUUID();
  let record: WrapperRecord | undefined;

  const send = (msg: WrapServerMessage): void => {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // The close handler owns transport cleanup.
    }
  };

  const outgoing: WrapperBackendOutgoing = {
    sendInput: (data) => send({ type: 'input', data }),
    sendResize: (cols, rows) => send({ type: 'resize', cols, rows }),
    sendKill: (signal) => send({ type: 'kill', signal }),
  };

  const activate = (nextRecord: WrapperRecord, viewport: WrapperViewport): void => {
    registry.bind(nextRecord, connectionId, outgoing, viewport, () => {
      try {
        socket.close(1012, 'superseded by a newer wrapper connection');
      } catch {
        // ignore
      }
    });
    record = nextRecord;
  };

  socket.on('message', (raw: Buffer) => {
    let msg: WrapClientMessage;
    try {
      msg = JSON.parse(raw.toString('utf8')) as WrapClientMessage;
    } catch {
      send({ type: 'error', message: 'invalid JSON frame' });
      return;
    }

    if (msg.type === 'register') {
      if (record) {
        send({ type: 'error', message: 'already registered' });
        return;
      }
      try {
        const nextRecord = registry.register(msg);
        activate(nextRecord, msg);
        send({ type: 'registered', sessionId: nextRecord.session.id });
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === 'resume') {
      if (record) {
        send({ type: 'error', message: 'already registered' });
        return;
      }
      const nextRecord = registry.resume(msg);
      if (!nextRecord) {
        send({ type: 'resume-rejected', reason: 'session or credentials are no longer valid' });
        return;
      }
      try {
        activate(nextRecord, msg);
        send({ type: 'resumed', sessionId: nextRecord.session.id });
      } catch (err) {
        send({
          type: 'resume-rejected',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (!record) {
      send({ type: 'error', message: 'register or resume first' });
      return;
    }

    switch (msg.type) {
      case 'pty':
        if (typeof msg.data !== 'string') {
          send({ type: 'error', message: 'pty data must be a string' });
          return;
        }
        record.backend.pushData(Buffer.from(msg.data, 'utf8'));
        return;
      case 'local-resize':
        try {
          assertViewport(msg);
        } catch (err) {
          send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          return;
        }
        record.backend.setLocalSize({ cols: msg.cols, rows: msg.rows });
        return;
      case 'exit':
        if (
          !Number.isInteger(msg.code) ||
          (msg.signal !== undefined && !Number.isInteger(msg.signal))
        ) {
          send({ type: 'error', message: 'exit code and signal must be integers' });
          return;
        }
        registry.complete(record, connectionId, msg.code, msg.signal);
        record = undefined;
        try {
          socket.close();
        } catch {
          // ignore
        }
        return;
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  });

  socket.on('close', () => {
    if (!record) return;
    registry.disconnect(record, connectionId);
    record = undefined;
  });
}

function equalSecret(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  if (expectedBytes.length === 0 || expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

function assertRegistration(msg: WrapperRegistration): void {
  if (
    typeof msg.adapterId !== 'string' ||
    msg.adapterId.length === 0 ||
    typeof msg.cwd !== 'string' ||
    msg.cwd.length === 0 ||
    typeof msg.command !== 'string' ||
    msg.command.length === 0
  ) {
    throw new Error('adapterId, cwd, and command are required');
  }
}

function assertViewport(viewport: WrapperViewport): void {
  if (
    (viewport.hasLocalViewport !== undefined && typeof viewport.hasLocalViewport !== 'boolean') ||
    !Number.isInteger(viewport.cols) ||
    !Number.isInteger(viewport.rows) ||
    viewport.cols <= 0 ||
    viewport.rows <= 0 ||
    viewport.cols > 10_000 ||
    viewport.rows > 10_000
  ) {
    throw new Error('cols and rows must be positive integers no greater than 10000');
  }
}
