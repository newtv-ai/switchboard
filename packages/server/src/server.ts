import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as nodeUrl from 'node:url';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
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
    bodyLimit: 100 * 1024 * 1024, // 100MB limit to easily accommodate 5MB chunks
  });

  await app.register(fastifyWebsocket);

  // Calculate project root regardless of where the script was invoked from.
  // __dirname here is either packages/server/src or packages/server/dist.
  // We go up 3 levels to reach the project root.
  const __dirname = path.dirname(nodeUrl.fileURLToPath(import.meta.url));
  const projectRoot = path.join(__dirname, '..', '..', '..');
  const downloadsDir = path.join(projectRoot, 'downloads');

  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 10 * 1024 * 1024 * 1024, // 10 GB limit
    },
  });

  await app.register(fastifyStatic, {
    root: downloadsDir,
    prefix: '/api/download/',
    setHeaders: (res, path, stat) => {
      res.setHeader('Content-Disposition', 'attachment');
    },
  });

  app.post('/api/upload', async (req, reply) => {
    const t0 = Date.now();
    try {
      const data = await req.file();
      if (!data) {
        return reply.code(400).send({ error: 'No file provided' });
      }

      const filename = data.filename;
      // Prevent directory traversal attacks
      const sanitizedFilename = path.basename(filename);
      const destPath = path.join(downloadsDir, sanitizedFilename);

      const isAppend = req.headers['x-upload-append'] === 'true';
      const flags = isAppend ? 'a' : 'w';

      // Count bytes flowing through so we can log throughput per chunk.
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          cb(null, chunk);
        },
      });

      await pipeline(data.file, counter, fs.createWriteStream(destPath, { flags }));

      const ms = Date.now() - t0;
      const mbps = ms > 0 ? (bytes / 1024 / 1024 / (ms / 1000)).toFixed(2) : 'inf';
      req.log.info(
        `upload: ${sanitizedFilename} append=${isAppend} bytes=${bytes} took=${ms}ms (${mbps} MB/s)`,
      );

      return { success: true, filename: sanitizedFilename, bytes, durationMs: ms };
    } catch (err) {
      req.log.error(err);
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      // Do NOT include err.stack in the response — leaks internal paths.
      return reply.code(500).send({ error: message });
    }
  });

  app.get('/api/files', async () => {
    const entries = fs.readdirSync(downloadsDir);
    const result: Array<{ name: string; size: number; mtime: number }> = [];
    for (const name of entries) {
      const stat = fs.statSync(path.join(downloadsDir, name));
      if (!stat.isFile()) continue;
      result.push({ name, size: stat.size, mtime: stat.mtimeMs });
    }
    return result;
  });

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
