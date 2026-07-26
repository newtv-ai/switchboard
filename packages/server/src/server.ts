import fs from 'node:fs';
import path from 'node:path';
import * as nodeUrl from 'node:url';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { type MemberRole, SessionManager } from '@switchboard/core';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
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
import { MAX_UPLOAD_CHUNK_SIZE, UploadError, UploadManager } from './upload-manager.js';
import { WorkflowManager } from './workflow-manager.js';
import { WorkgroupManager } from './workgroup-manager.js';
import { WorkgroupStore } from './workgroup-store.js';
import { bindWorkgroupWs } from './workgroup-ws.js';
import { WrapperRegistry, bindWrap } from './wrap-handler.js';
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

function sendUploadError(reply: FastifyReply, err: unknown) {
  const errno = (err as NodeJS.ErrnoException).code;
  const tooLarge = errno === 'FST_REQ_FILE_TOO_LARGE';
  const statusCode = err instanceof UploadError ? err.statusCode : tooLarge ? 413 : 500;
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  // `code` is what the client branches on (e.g. offering to overwrite);
  // `error` stays human-readable for logs and alerts.
  const code = err instanceof UploadError ? err.code : tooLarge ? 'too-large' : 'internal';
  return reply.code(statusCode).send({ error: message, code });
}

export async function startServer(opts: StartServerOpts = {}): Promise<StartedServer> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 8787;

  const sessions = new SessionManager();
  const wrappers = new WrapperRegistry(sessions);
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
  const uploads = new UploadManager(downloadsDir, path.join(projectRoot, '.switchboard-uploads'));

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 100 * 1024 * 1024,
  });

  await app.register(fastifyWebsocket);

  await uploads.init();

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_UPLOAD_CHUNK_SIZE,
    },
  });

  await app.register(fastifyStatic, {
    root: downloadsDir,
    prefix: '/api/download/',
    setHeaders: (res, path, stat) => {
      res.setHeader('Content-Disposition', 'attachment');
    },
  });

  app.post('/api/uploads', async (req, reply) => {
    const body = (req.body ?? {}) as {
      filename?: string;
      totalSize?: number;
      totalChunks?: number;
      chunkSize?: number;
      overwrite?: boolean;
    };
    try {
      const created = await uploads.create({
        filename: typeof body.filename === 'string' ? body.filename : '',
        totalSize: body.totalSize as number,
        totalChunks: body.totalChunks as number,
        ...(body.chunkSize === undefined ? {} : { chunkSize: body.chunkSize }),
        overwrite: body.overwrite === true,
      });
      return reply.code(201).send(created);
    } catch (err) {
      if (!(err instanceof UploadError)) req.log.error(err);
      return sendUploadError(reply, err);
    }
  });

  app.post('/api/uploads/:uploadId/chunks/:index', async (req, reply) => {
    const { uploadId, index: rawIndex } = req.params as { uploadId: string; index: string };
    try {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: 'No chunk provided' });
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (data.file.truncated) {
        return reply
          .code(413)
          .send({ error: `Chunk exceeds ${MAX_UPLOAD_CHUNK_SIZE} bytes`, code: 'too-large' });
      }
      const index = Number(rawIndex);
      const result = await uploads.writeChunk(uploadId, index, Buffer.concat(chunks));
      return { success: true, index, ...result };
    } catch (err) {
      if (!(err instanceof UploadError)) req.log.error(err);
      return sendUploadError(reply, err);
    }
  });

  app.post('/api/uploads/:uploadId/complete', async (req, reply) => {
    const { uploadId } = req.params as { uploadId: string };
    try {
      const result = await uploads.complete(uploadId);
      req.log.info(`upload complete: ${result.filename} bytes=${result.bytes}`);
      return { success: true, ...result };
    } catch (err) {
      if (!(err instanceof UploadError)) req.log.error(err);
      return sendUploadError(reply, err);
    }
  });

  app.delete('/api/uploads/:uploadId', async (req, reply) => {
    const { uploadId } = req.params as { uploadId: string };
    try {
      await uploads.cancel(uploadId);
      return { success: true };
    } catch (err) {
      if (!(err instanceof UploadError)) req.log.error(err);
      return sendUploadError(reply, err);
    }
  });

  app.post('/api/upload', async (_req, reply) =>
    reply.code(410).send({ error: 'Legacy upload endpoint removed; refresh the web client' }),
  );

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
    const body = (req.body ?? {}) as { adapterId?: string; command?: string };
    const adapterId = typeof body.adapterId === 'string' ? body.adapterId.trim() : undefined;
    const command = typeof body.command === 'string' ? body.command.trim() : undefined;
    if ((!adapterId && !command) || (adapterId && command)) {
      return reply.code(400).send({ error: 'Provide exactly one of adapterId or command' });
    }
    try {
      if (adapterId) return await workgroups.addMember(id, { adapterId });
      if (command) return await workgroups.addMember(id, { command });
      return reply.code(400).send({ error: 'Adapter or command is required' });
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

  // Live workgroup events: a client subscribes to a workgroupId and receives
  // { type: 'workgroup.changed' } whenever it mutates.
  app.get('/workgroups/ws', { websocket: true }, (socket) => {
    bindWorkgroupWs(socket, workgroups);
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
    bindWrap(socket, wrappers);
  });

  await app.listen({ host, port });

  const url = `http://${host}:${port}`;

  const close = async (): Promise<void> => {
    wrappers.dispose();
    await sessions.shutdown();
    await app.close();
  };

  return { app, sessions, url, close };
}
