import type { FastifyInstance } from 'fastify';

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = u.username;
    return u.toString();
  } catch {
    return url;
  }
}
import { Go2rtcManager, type Go2rtcManagerOpts } from './go2rtc-manager.js';

export interface CameraModuleOpts extends Go2rtcManagerOpts {
}

export interface CameraModule {
  manager: Go2rtcManager;
  directions: { phoneToDesktop: boolean; desktopToPhone: boolean };
}

/**
 * Register the camera module with a Fastify server.
 * Called via dynamic import() from server.ts — if this package is not
 * installed, the import fails silently and terminal features are unaffected.
 */
export async function register(
  app: FastifyInstance,
  opts?: CameraModuleOpts,
): Promise<CameraModule> {
  const manager = new Go2rtcManager({
    ...opts,
    onLog: (line) => app.log.info(line),
  });

  // start() will auto-download go2rtc from GitHub if not found locally
  const started = await manager.start();
  if (!started) {
    app.log.warn('[camera] go2rtc unavailable — camera features disabled');
    registerCapsRoute(app, manager, false);
    return { manager, directions: { phoneToDesktop: false, desktopToPhone: false } };
  }

  const info = await manager.getInfo();
  app.log.info(`[camera] go2rtc ${info?.version ?? 'unknown'} running on ${manager.apiBase}`);

  // Register HTTP routes
  registerCapsRoute(app, manager, true);
  await registerProxyRoutes(app, manager);

  // Graceful shutdown
  app.addHook('onClose', async () => {
    await manager.stop();
  });

  return { manager, directions: { phoneToDesktop: true, desktopToPhone: true } };
}

function registerCapsRoute(app: FastifyInstance, manager: Go2rtcManager, available: boolean): void {
  app.get('/api/camera/caps', async () => {
    const info = available ? await manager.getInfo() : null;
    return {
      available,
      go2rtcVersion: info?.version ?? null,
      directions: {
        phoneToDesktop: available,
        desktopToPhone: available,
      },
      platform: process.platform,
    };
  });
}

async function registerProxyRoutes(app: FastifyInstance, manager: Go2rtcManager): Promise<void> {
  // Lazy-load @fastify/http-proxy — it's a server dependency, not ours
  const { default: proxy } = await import('@fastify/http-proxy');

  const upstream = manager.apiBase;
  const authPreHandler = async () => {
    // TODO: auth middleware — for now, allow all requests
  };

  // Proxy go2rtc REST API endpoints through Switchboard
  const routes = [
    { prefix: '/api/camera/streams', rewrite: '/api/streams', ws: false },
    { prefix: '/api/camera/webrtc', rewrite: '/api/webrtc', ws: false },
    { prefix: '/api/camera/frame', rewrite: '/api/frame.jpeg', ws: false },
    { prefix: '/api/camera/stream', rewrite: '/api/stream.mp4', ws: false },
  ];

  for (const route of routes) {
    await app.register(proxy, {
      upstream,
      prefix: route.prefix,
      rewritePrefix: route.rewrite,
      websocket: route.ws,
      preHandler: authPreHandler,
    });
  }

  // Proxy go2rtc static web assets (stream.html etc.) — HTTP only.
  // websocket MUST be false: @fastify/http-proxy WS mode conflicts with
  // @fastify/websocket, crashing the server. go2rtc WS signaling goes
  // through Vite's proxy (/go2rtc → 1984) in dev mode instead.
  await app.register(proxy, {
    upstream,
    prefix: '/go2rtc',
    rewritePrefix: '',
    websocket: false,
    preHandler: authPreHandler,
  });

  // Note: WebSocket proxy for go2rtc MSE is deferred — @fastify/http-proxy's
  // websocket mode conflicts with @fastify/websocket on the /ws endpoint.
  // WebRTC WHEP/WHIP uses HTTP POST, so camera viewing works without WS proxy.
  // MSE fallback will need a manual WS proxy in a future phase.

  // Camera source management endpoints (thin wrappers over go2rtc API)
  app.get('/api/camera/sources', async () => {
    const streams = await manager.listStreams();
    if (!streams) return { sources: {} };
    const sanitized: Record<string, unknown> = {};
    for (const [name, val] of Object.entries(streams)) {
      sanitized[name] = typeof val === 'string' ? redactUrl(val) : val;
    }
    return { sources: sanitized };
  });

  app.put<{ Querystring: { name: string; src: string } }>('/api/camera/sources', async (req, reply) => {
    const { name, src } = req.query;
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (name === 'phone_cam') return reply.code(400).send({ error: 'reserved stream name' });
    const safeSchemes = ['rtsp://', 'rtsps://', 'rtmp://', 'http://', 'https://'];
    if (src && !safeSchemes.some((s) => src.toLowerCase().startsWith(s))) {
      return reply.code(400).send({ error: 'only rtsp/rtmp/http(s) URLs are allowed' });
    }
    const ok = await manager.addStream(name, src ?? '');
    return ok ? { success: true } : reply.code(500).send({ error: 'failed to add stream' });
  });

  app.delete<{ Querystring: { name: string } }>('/api/camera/sources', async (req, reply) => {
    const { name } = req.query;
    if (!name) return reply.code(400).send({ error: 'name required' });
    const ok = await manager.removeStream(name);
    return ok ? { success: true } : reply.code(500).send({ error: 'failed to remove stream' });
  });
}

export { Go2rtcManager } from './go2rtc-manager.js';
export type { Go2rtcManagerOpts } from './go2rtc-manager.js';
