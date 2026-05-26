import type { WebSocket } from '@fastify/websocket';
import type { ClientHandle, Session, SessionManager } from '@switchboard/core';
import type { ClientMessage, ServerMessage } from './protocol.js';

/**
 * Handle a single browser/phone WS connection on /ws.
 * One connection attaches to at most one session at a time; to switch
 * sessions, the client opens a new WS.
 */
/** App-level keepalive cadence. Mobile browsers cull WebSockets that go
 *  message-silent for ~10–20 s; this beats that. (Some intermediaries also
 *  ignore protocol-level ping frames, so we send a real JSON message.) */
const KEEPALIVE_MS = 5000;

export function bindWebSocket(socket: WebSocket, sessions: SessionManager): void {
  let session: Session | undefined;
  let handle: ClientHandle | undefined;

  const send = (msg: ServerMessage): void => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(msg));
  };

  const keepalive = setInterval(() => send({ type: 'ping' }), KEEPALIVE_MS);
  if (typeof keepalive.unref === 'function') keepalive.unref();

  const attachTo = (s: Session, initialSize?: { cols: number; rows: number }): void => {
    session = s;
    const adapter = s.adapter.manifest;
    send({
      type: 'ready',
      sessionId: s.id,
      adapter,
      capabilities: adapter.capabilities,
      replay: s.getReplay().toString('utf8'),
      summary: s.summary(),
    });
    handle = s.attach(
      {
        onData: (chunk) => send({ type: 'pty', data: chunk.toString('utf8') }),
        onEvent: (event) => send({ type: 'event', event }),
        onState: (state) => send({ type: 'state', state }),
        onExit: (code, signal) => send({ type: 'exit', code, signal }),
        onResize: (cols, rows) => send({ type: 'pty-resize', cols, rows }),
      },
      initialSize,
    );
  };

  send({ type: 'sessions', list: sessions.list() });

  socket.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString('utf8')) as ClientMessage;
    } catch {
      send({ type: 'error', message: 'invalid JSON frame' });
      return;
    }

    try {
      switch (msg.type) {
        case 'list': {
          send({ type: 'sessions', list: sessions.list() });
          return;
        }
        case 'create': {
          if (session) {
            send({ type: 'error', message: 'already attached to a session' });
            return;
          }
          const s = sessions.spawn({
            adapterId: msg.adapterId,
            cwd: msg.cwd ?? process.cwd(),
            env: msg.env,
            cols: msg.cols,
            rows: msg.rows,
            name: msg.name,
          });
          const size = msg.cols && msg.rows ? { cols: msg.cols, rows: msg.rows } : undefined;
          attachTo(s, size);
          return;
        }
        case 'attach': {
          if (session) {
            send({ type: 'error', message: 'already attached to a session' });
            return;
          }
          const s = sessions.get(msg.sessionId);
          if (!s) {
            send({ type: 'error', message: `unknown session: ${msg.sessionId}` });
            return;
          }
          const size = msg.cols && msg.rows ? { cols: msg.cols, rows: msg.rows } : undefined;
          attachTo(s, size);
          return;
        }
        case 'input': {
          if (!session) {
            send({ type: 'error', message: 'no attached session' });
            return;
          }
          session.write(msg.data);
          return;
        }
        case 'resize': {
          if (!handle) return;
          handle.resize(msg.cols, msg.rows);
          return;
        }
        case 'action': {
          if (!session) {
            send({ type: 'error', message: 'no attached session' });
            return;
          }
          const handler = session.adapter.actions?.[msg.actionId];
          if (!handler) {
            send({ type: 'error', message: `unknown action: ${msg.actionId}` });
            return;
          }
          void Promise.resolve(handler({ session }, msg.params)).catch((err: unknown) => {
            send({
              type: 'error',
              message: `action failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
          return;
        }
        case 'kill': {
          const s = sessions.get(msg.sessionId);
          s?.kill();
          return;
        }
        default: {
          const _exhaustive: never = msg;
          void _exhaustive;
          send({ type: 'error', message: 'unknown message type' });
        }
      }
    } catch (err) {
      send({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const cleanupConnection = (reasonPrefix: string, detail?: string) => {
    clearInterval(keepalive);
    if (process.env.SWITCHBOARD_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `[switchboard:debug] /ws ${reasonPrefix} ${detail || '(none)'} hasHandle=${Boolean(handle)} hasSession=${Boolean(session)}`,
      );
    }
    handle?.detach();
    handle = undefined;
    session = undefined;
  };

  socket.on('close', (code: number, reason: Buffer) => {
    cleanupConnection('close', `code=${code} reason=${reason?.toString('utf8')}`);
    // The session itself stays alive; another client can re-attach by id.
  });

  socket.on('error', (err: Error) => {
    cleanupConnection('error', err.message);
  });
}
