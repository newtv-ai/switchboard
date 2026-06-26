import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as nodeUrl from 'node:url';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { type MemberRole, SessionManager } from '@switchboard/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { antigravityAdapter } from './adapters/antigravity.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { passthroughAdapter } from './adapters/passthrough.js';
import { registerAlarm } from './alarm-handler.js';
import { scanClis } from './cli-scanner.js';
import { PushManager } from './push.js';
import { peekSession } from './session-peek.js';
import { TaskManager } from './task-manager.js';
import { type TaskStatus, TaskStore } from './task-store.js';
import { WorkflowManager } from './workflow-manager.js';
import { WorkgroupManager } from './workgroup-manager.js';
import { WorkgroupStore } from './workgroup-store.js';
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
  sessions.registerAdapter(claudeAdapter);
  sessions.registerAdapter(codexAdapter);
  sessions.registerAdapter(antigravityAdapter);

  const workgroups = new WorkgroupManager(sessions, new WorkgroupStore());
  await workgroups.init();
  const tasks = new TaskManager(sessions, workgroups, new TaskStore());
  await tasks.init();
  const workflows = new WorkflowManager(workgroups, tasks);
  await workflows.init();

  // Calculate project root regardless of where the script was invoked from.
  // __dirname here is either packages/server/src or packages/server/dist.
  // We go up 3 levels to reach the project root.
  const __dirname = path.dirname(nodeUrl.fileURLToPath(import.meta.url));
  const projectRoot = path.join(__dirname, '..', '..', '..');
  const downloadsDir = path.join(projectRoot, 'downloads');

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 100 * 1024 * 1024,
  });

  await app.register(fastifyWebsocket);

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

  app.delete('/api/files/:name', async (req, reply) => {
    const raw = (req.params as { name: string }).name;
    // path.basename strips any '..'/path separators a client tries to sneak in.
    const safe = path.basename(raw);
    if (!safe || safe === '.' || safe === '..') {
      return reply.code(400).send({ error: 'Invalid filename' });
    }
    const target = path.join(downloadsDir, safe);
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) return reply.code(400).send({ error: 'Not a file' });
      fs.unlinkSync(target);
      req.log.info(`delete: ${safe} bytes=${stat.size}`);
      return { success: true, filename: safe };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(404).send({ error: 'File not found' });
      }
      req.log.error(err);
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      return reply.code(500).send({ error: message });
    }
  });

  app.get('/health', async () => ({ ok: true, sessions: sessions.list().length }));

  app.get('/adapters', async () => sessions.listAdapters());

  app.get('/sessions', async () => sessions.list());

  // Scan the machine for available AI coding CLIs (registered adapters that can
  // detect themselves + well-known adapter-less commands). Read-only.
  app.get('/api/scan', async () => scanClis(sessions));

  // --- Workgroups (multi-AI shared-context groups) ---
  app.get('/api/workgroups', async () => workgroups.list());

  app.post('/api/workgroups', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; cwd?: string };
    try {
      return await workgroups.create(body.name ?? '', body.cwd || projectRoot);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  app.get('/api/workgroups/:id', async (req, reply) => {
    const wg = workgroups.get((req.params as { id: string }).id);
    if (!wg) return reply.code(404).send({ error: 'Workgroup not found' });
    return wg;
  });

  // Option B: spawn a fresh CLI session in the workgroup's folder and add it.
  app.post('/api/workgroups/:id/members', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { adapterId?: string };
    if (!body.adapterId) return reply.code(400).send({ error: 'adapterId required' });
    try {
      return await workgroups.addMember(id, body.adapterId);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  app.post('/api/workgroups/:id/members/:sessionId/role', async (req, reply) => {
    const { id, sessionId } = req.params as { id: string; sessionId: string };
    const body = (req.body ?? {}) as { role?: MemberRole };
    if (!body.role) return reply.code(400).send({ error: 'role required' });
    try {
      await workgroups.setRole(id, sessionId, body.role);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  app.delete('/api/workgroups/:id/members/:sessionId', async (req, reply) => {
    const { id, sessionId } = req.params as { id: string; sessionId: string };
    try {
      await workgroups.removeMember(id, sessionId);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // Manual handoff: pass work from one member to another (idea #9).
  app.post('/api/workgroups/:id/handoff', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      fromSessionId?: string;
      toSessionId?: string;
      note?: string;
    };
    if (!body.fromSessionId || !body.toSessionId) {
      return reply.code(400).send({ error: 'fromSessionId and toSessionId required' });
    }
    try {
      return await workgroups.handoff(id, body.fromSessionId, body.toSessionId, body.note);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // --- Tasks within a workgroup ---
  app.get('/api/workgroups/:id/tasks', async (req) =>
    tasks.list((req.params as { id: string }).id),
  );

  app.post('/api/workgroups/:id/tasks', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { title?: string; description?: string };
    if (!body.title && !body.description) {
      return reply.code(400).send({ error: 'title or description required' });
    }
    try {
      return await tasks.create(id, body.title ?? '', body.description ?? '');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // Assign a task to a member session and dispatch it (writes to that PTY's stdin).
  app.post('/api/workgroups/:id/tasks/:taskId/assign', async (req, reply) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    const body = (req.body ?? {}) as { sessionId?: string };
    if (!body.sessionId) return reply.code(400).send({ error: 'sessionId required' });
    try {
      return await tasks.assign(id, taskId, body.sessionId);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  app.post('/api/workgroups/:id/tasks/:taskId/status', async (req, reply) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    const body = (req.body ?? {}) as { status?: TaskStatus; result?: string };
    if (!body.status) return reply.code(400).send({ error: 'status required' });
    try {
      return await tasks.setStatus(id, taskId, body.status, body.result);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // Read-only peek at a session's recent output (approximate, ANSI-stripped).
  app.get('/api/sessions/:id/peek', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.get(id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const lines = Number((req.query as { lines?: string }).lines) || 40;
    return { sessionId: id, lines, text: peekSession(session, lines) };
  });

  // --- Workflow (four-step SOP) within a workgroup ---
  app.get('/api/workgroups/:id/workflow', async (req) => {
    return workflows.get((req.params as { id: string }).id) ?? null;
  });

  app.post('/api/workgroups/:id/workflow/start', async (req, reply) => {
    try {
      return await workflows.start((req.params as { id: string }).id);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  app.post('/api/workgroups/:id/workflow/advance', async (req, reply) => {
    try {
      return await workflows.advance((req.params as { id: string }).id);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // --- Alarm webhook + Web Push (fall-detection notifications) ---
  const certsDir = path.join(projectRoot, 'certs');
  const push = PushManager.create(certsDir);
  const alarmSecret = process.env.SWITCHBOARD_ALARM_SECRET;
  registerAlarm(app, { push, alarmSecret });
  if (alarmSecret) {
    app.log.info(
      `[alarm] webhook ready (HMAC-protected), ${push.subscriptionCount} subscription(s) loaded`,
    );
  } else {
    app.log.warn(
      '[alarm] /api/alarm is UNAUTHENTICATED — set SWITCHBOARD_ALARM_SECRET to require signed requests (recommended when reachable beyond a trusted LAN)',
    );
  }

  // --- Optional camera module (go2rtc sidecar) ---
  try {
    const cam = await import('@switchboard/camera');
    const camMod = await cam.register(app);
    if (camMod.directions.phoneToDesktop || camMod.directions.desktopToPhone) {
      app.log.info('[camera] module loaded — endpoints at /api/camera/*');
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
      app.log.error('[camera] failed to load: %s', (err as Error).message);
    }
  }

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
