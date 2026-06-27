import type { WebSocket } from '@fastify/websocket';
import { contextEvents } from './shared-context.js';
import type { WorkgroupManager } from './workgroup-manager.js';

/** Mobile browsers cull message-silent sockets after ~10–20s; beat that. */
const KEEPALIVE_MS = 5000;

/**
 * A browser viewing a workgroup connects here and sends
 * `{ type: 'subscribe', workgroupId }`. Thereafter it receives
 * `{ type: 'workgroup.changed' }` whenever that workgroup mutates (member/task/
 * workflow/handoff) — from this client, another client, or an agent — so the UI
 * refreshes live instead of relying on a manual button.
 */
export function bindWorkgroupWs(socket: WebSocket, workgroups: WorkgroupManager): void {
  let contextDir: string | null = null;

  const send = (obj: unknown): void => {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      // Socket went away mid-send. Must not throw: send() runs inside the
      // synchronous contextEvents.emit() chained off appendTimeline, so a throw
      // here would reject a mutation that has already succeeded. close() cleans up.
    }
  };

  const onChange = (changedDir: string): void => {
    if (contextDir && changedDir === contextDir) send({ type: 'workgroup.changed' });
  };
  contextEvents.on('change', onChange);

  const keepalive = setInterval(() => send({ type: 'ping' }), KEEPALIVE_MS);
  if (typeof keepalive.unref === 'function') keepalive.unref();

  socket.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString('utf8')) as { type?: string; workgroupId?: string };
      if (msg.type === 'subscribe' && typeof msg.workgroupId === 'string') {
        contextDir = workgroups.get(msg.workgroupId)?.contextDir ?? null;
        send({ type: 'subscribed', ok: contextDir !== null });
      }
    } catch {
      // ignore malformed frames
    }
  });

  socket.on('close', () => {
    contextEvents.off('change', onChange);
    clearInterval(keepalive);
  });
}
