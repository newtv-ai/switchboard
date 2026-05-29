import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type PushManager, verifyAlarmSignature } from './push.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request body bytes, captured for HMAC verification on /api/alarm. */
    rawBody?: Buffer;
  }
}

export interface AlarmDeps {
  push: PushManager;
  /** When set, /api/alarm requires a valid X-Falldown-Signature header. */
  alarmSecret?: string;
}

/**
 * Shape of the JSON an alarm source POSTs. All fields optional; only `alarm_type`
 * shapes the notification text — the rest are logged for debugging.
 */
interface AlarmPayload {
  event?: string;
  timestamp?: number;
  frame_idx?: number;
  track_id?: number;
  bbox?: [number, number, number, number];
  bbox_confidence?: number;
  stgcn_action?: string | null;
  stgcn_fall_prob?: number;
  source?: string;
  /** Human label to show, e.g. "跌倒" / "暴力". Omitted → defaults to "跌倒". */
  alarm_type?: string;
}

interface IncomingSubscription {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

/**
 * Registers the fall-alarm webhook and the PWA push-subscription endpoints:
 *   POST /api/alarm            ← the detector (or any source) fires here
 *   GET  /api/vapid-public-key → PWA reads the key before subscribing
 *   POST /api/push-subscribe   ← PWA registers its PushSubscription
 *   POST /api/push-unsubscribe ← PWA drops it when the user toggles alarms off
 */
export function registerAlarm(app: FastifyInstance, deps: AlarmDeps): void {
  const { push, alarmSecret } = deps;

  // IMPORTANT: everything goes inside an ENCAPSULATED plugin context.
  // We need a custom application/json parser to capture the raw body for the
  // HMAC check, but registering one on the ROOT instance makes the camera
  // module's @fastify/http-proxy throw FST_ERR_CTP_ALREADY_PRESENT when it
  // registers its own json parser (it inherits ours from root). Keeping our
  // parser in a child context means root stays on the built-in default and the
  // two never collide. Do NOT hoist this to the root app.
  app.register(async (scope) => {
    // Capture the raw body so /api/alarm can HMAC the exact bytes, while these
    // routes still receive a normally-parsed object via req.body.
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req: FastifyRequest, body: Buffer, done) => {
        req.rawBody = body;
        try {
          done(null, body.length > 0 ? JSON.parse(body.toString('utf8')) : {});
        } catch {
          // Malformed JSON is a client error (400), not a server fault (500).
          const err = new Error('Invalid JSON') as Error & { statusCode?: number };
          err.statusCode = 400;
          done(err, undefined);
        }
      },
    );

    scope.get('/api/vapid-public-key', async () => ({ publicKey: push.publicKey }));

    scope.post('/api/push-subscribe', async (req, reply) => {
      const sub = req.body as IncomingSubscription;
      const endpoint = sub?.endpoint;
      const p256dh = sub?.keys?.p256dh;
      const auth = sub?.keys?.auth;
      // Validate types + sane bounds so we never persist garbage that would
      // only blow up later inside web-push at send time.
      if (
        typeof endpoint !== 'string' ||
        !endpoint.startsWith('https://') ||
        endpoint.length > 2048 ||
        typeof p256dh !== 'string' ||
        p256dh.length > 256 ||
        typeof auth !== 'string' ||
        auth.length > 256
      ) {
        return reply.code(400).send({ error: 'Invalid subscription' });
      }
      push.addSubscription({
        endpoint,
        keys: { p256dh, auth },
        ua: req.headers['user-agent'],
        subscribedAt: Date.now(),
      });
      req.log.info(`push-subscribe: total=${push.subscriptionCount}`);
      return reply.code(201).send({ ok: true });
    });

    scope.post('/api/push-unsubscribe', async (req, reply) => {
      const { endpoint } = (req.body ?? {}) as IncomingSubscription;
      if (!endpoint) {
        return reply.code(400).send({ error: 'Missing endpoint' });
      }
      push.removeSubscription(endpoint);
      return reply.code(204).send();
    });

    scope.post('/api/alarm', async (req, reply) => {
      if (alarmSecret) {
        const sig = req.headers['x-falldown-signature'];
        const header = Array.isArray(sig) ? sig[0] : sig;
        if (!req.rawBody || !verifyAlarmSignature(req.rawBody, header, alarmSecret)) {
          req.log.warn('alarm: signature verification failed');
          return reply.code(401).send({ error: 'Invalid signature' });
        }
      }

      const alarm = (req.body ?? {}) as AlarmPayload;
      req.log.info(
        `alarm: type=${alarm.alarm_type} event=${alarm.event} track=${alarm.track_id} action=${alarm.stgcn_action} prob=${alarm.stgcn_fall_prob} source=${alarm.source}`,
      );

      // The notification label is whatever the upstream sends in `alarm_type`
      // (e.g. "跌倒", "暴力"); fall back to "跌倒" so a detector that omits the
      // field keeps working. Trim + cap so a bad upstream
      // can't push a giant string into the notification.
      const raw = typeof alarm.alarm_type === 'string' ? alarm.alarm_type : '';
      const label = raw.trim().slice(0, 24) || '跌倒';
      // alarm.timestamp is a VIDEO offset (seconds), not wall-clock — use the
      // server's receive time for the human-facing notification instead.
      const payload = {
        title: `检测到${label}`,
        body: `${new Date().toLocaleTimeString()} 摄像头检测到${label}，点击查看`,
        url: '/?view=camera',
        tag: `${label}-${alarm.track_id ?? 'x'}`,
        renotify: true,
      };
      const result = await push.broadcast(payload);
      req.log.info(
        `alarm: pushed sent=${result.sent} removed=${result.removed} failed=${result.failed}`,
      );
      return reply.code(204).send();
    });
  });
}
