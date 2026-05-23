import fastifyWebsocket from '@fastify/websocket';
import { SessionManager } from '@switchboard/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { antigravityAdapter } from './adapters/antigravity.js';
import { codexAdapter } from './adapters/codex.js';
import { passthroughAdapter } from './adapters/passthrough.js';
import { bindWrap } from './wrap-handler.js';
import { bindWebSocket } from './ws-handler.js';

export interface StartServerOpts {
  host?: string;
  port?: number;
}

export interface StartedServer {
  app: FastifyInstance;
  sessions: SessionManager;
  url: string;
  close: () => Promise<void>;
}

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export async function startServer(opts: StartServerOpts = {}): Promise<StartedServer> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 8787;

  const sessions = new SessionManager();
  sessions.registerAdapter(passthroughAdapter);
  sessions.registerAdapter(codexAdapter);
  sessions.registerAdapter(antigravityAdapter);

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  await app.register(fastifyWebsocket);

  app.get('/health', async () => ({ ok: true, sessions: sessions.list().length }));

  app.get('/adapters', async () => sessions.listAdapters());

  app.get('/sessions', async () => sessions.list());

  // Browser/phone clients attach here.
  app.get('/ws', { websocket: true }, (socket) => {
    bindWebSocket(socket, sessions);
  });

  // Wrapper processes register here. Localhost-only — the wrapper is always
  // co-located with the server (it spawns the PTY in the user's terminal).
  // A remote attacker on /wrap could inject sessions wholesale.
  app.get('/wrap', { websocket: true }, (socket, req) => {
    const ip = req.ip;
    if (!LOCALHOST_IPS.has(ip)) {
      app.log.warn({ ip }, 'rejecting /wrap connection from non-localhost');
      try {
        socket.close(1008, 'wrap endpoint requires localhost');
      } catch {
        // ignore
      }
      return;
    }
    bindWrap(socket, sessions);
  });

  await app.listen({ host, port });

  const url = `http://${host}:${port}`;

  const close = async (): Promise<void> => {
    await sessions.killAll();
    await app.close();
  };

  return { app, sessions, url, close };
}
