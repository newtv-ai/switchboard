import { parse as parsePath } from 'node:path';
import type { WebSocket } from '@fastify/websocket';
import { type Session, type SessionManager, WrapperBackend } from '@switchboard/core';
import type { WrapClientMessage, WrapServerMessage } from './protocol.js';

/**
 * Handle a single wrapper-process WS connection on /wrap.
 *
 * The wrapper:
 *   1. opens this WS
 *   2. sends `register` describing its local PTY
 *   3. streams `pty` chunks of stdout
 *   4. sends `exit` when the process ends
 *
 * In return, the server pushes `input` / `resize` / `kill` whenever any
 * attached browser does the corresponding thing.
 *
 * This endpoint is bound to localhost only (see server.ts) — it grants
 * full session injection rights and must not be exposed.
 */
export function bindWrap(socket: WebSocket, sessions: SessionManager): void {
  let session: Session | undefined;
  let backend: WrapperBackend | undefined;

  const send = (msg: WrapServerMessage): void => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(msg));
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
      if (session) {
        send({ type: 'error', message: 'already registered' });
        return;
      }
      try {
        backend = new WrapperBackend({
          sendInput: (data) => send({ type: 'input', data }),
          sendResize: (cols, rows) => send({ type: 'resize', cols, rows }),
          sendKill: (signal) => send({ type: 'kill', signal }),
        });
        // If the wrapper has a local viewport, seed its size into the
        // negotiation BEFORE sessions.register triggers initial refit.
        if (msg.hasLocalViewport) {
          backend.setLocalSize({ cols: msg.cols, rows: msg.rows });
        }
        session = sessions.register({
          adapterId: msg.adapterId,
          cwd: msg.cwd,
          backend,
          name: msg.name,
          commandName: parsePath(msg.command).name,
        });
        send({ type: 'registered', sessionId: session.id });
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        try {
          socket.close();
        } catch {
          // ignore
        }
      }
      return;
    }

    if (!session || !backend) {
      send({ type: 'error', message: 'register first' });
      return;
    }

    switch (msg.type) {
      case 'pty':
        backend.pushData(Buffer.from(msg.data, 'utf8'));
        return;
      case 'local-resize':
        backend.setLocalSize({ cols: msg.cols, rows: msg.rows });
        return;
      case 'exit':
        backend.pushExit(msg.code, msg.signal);
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
    // Wrapper disconnected unexpectedly — treat as session exit so any attached
    // browsers know to clear it.
    if (backend) {
      backend.pushExit(-1);
      backend = undefined;
    }
    session = undefined;
  });
}
