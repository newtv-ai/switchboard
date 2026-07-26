import { randomUUID } from 'node:crypto';
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';

export const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;
const STALE_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const COMPLETED_UPLOAD_TTL_MS = 5 * 60 * 1000;

export class UploadError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

interface UploadSession {
  id: string;
  filename: string;
  filenameKey: string;
  totalSize: number;
  totalChunks: number;
  dir: string;
  uploaded: Map<number, number>;
  completing: boolean;
}

export interface CreateUploadOpts {
  filename: string;
  totalSize: number;
  totalChunks: number;
}

export interface UploadManagerOpts {
  maxUploadSize?: number;
  maxChunkSize?: number;
  idleTimeoutMs?: number;
}

/**
 * Keeps incomplete chunks outside the public downloads directory and only
 * publishes a file after all declared chunks have been assembled.
 */
export class UploadManager {
  private readonly sessions = new Map<string, UploadSession>();
  private readonly completed = new Map<string, { filename: string; bytes: number }>();
  private readonly reservedNames = new Set<string>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly maxUploadSize: number;
  private readonly maxChunkSize: number;
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly downloadsDir: string,
    private readonly tempDir: string,
    opts: UploadManagerOpts = {},
  ) {
    this.maxUploadSize = opts.maxUploadSize ?? MAX_UPLOAD_SIZE;
    this.maxChunkSize = opts.maxChunkSize ?? MAX_UPLOAD_CHUNK_SIZE;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async init(): Promise<void> {
    await mkdir(this.downloadsDir, { recursive: true });
    await mkdir(this.tempDir, { recursive: true });
    await this.removeStaleUploads();
  }

  async create(opts: CreateUploadOpts): Promise<{ uploadId: string; filename: string }> {
    const filename = this.safeFilename(opts.filename);
    if (!Number.isSafeInteger(opts.totalSize) || opts.totalSize < 0) {
      throw new UploadError('totalSize must be a non-negative integer', 400);
    }
    if (opts.totalSize > this.maxUploadSize) {
      throw new UploadError(`File exceeds the ${this.maxUploadSize} byte limit`, 413);
    }
    if (!Number.isSafeInteger(opts.totalChunks) || opts.totalChunks < 0) {
      throw new UploadError('totalChunks must be a non-negative integer', 400);
    }
    if ((opts.totalSize === 0) !== (opts.totalChunks === 0)) {
      throw new UploadError('Empty files require zero chunks; non-empty files require chunks', 400);
    }
    const expectedChunks = Math.ceil(opts.totalSize / this.maxChunkSize);
    if (opts.totalChunks !== expectedChunks) {
      throw new UploadError(
        `totalChunks must be ${expectedChunks} for ${this.maxChunkSize} byte chunks`,
        400,
      );
    }

    const filenameKey = this.filenameKey(filename);
    if (this.reservedNames.has(filenameKey)) {
      throw new UploadError(`An upload for "${filename}" is already in progress`, 409);
    }
    this.reservedNames.add(filenameKey);

    try {
      try {
        await access(join(this.downloadsDir, filename));
        throw new UploadError(`File "${filename}" already exists`, 409);
      } catch (err) {
        if (err instanceof UploadError) throw err;
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      const id = randomUUID();
      const dir = join(this.tempDir, id);
      await mkdir(dir);

      const session: UploadSession = {
        id,
        filename,
        filenameKey,
        totalSize: opts.totalSize,
        totalChunks: opts.totalChunks,
        dir,
        uploaded: new Map(),
        completing: false,
      };
      this.sessions.set(id, session);
      this.touch(session);
      return { uploadId: id, filename };
    } catch (err) {
      this.reservedNames.delete(filenameKey);
      throw err;
    }
  }

  async writeChunk(uploadId: string, index: number, data: Buffer): Promise<{ bytes: number }> {
    const session = this.requireSession(uploadId);
    if (session.completing) throw new UploadError('Upload is being finalized', 409);
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.totalChunks) {
      throw new UploadError('Chunk index is out of range', 400);
    }
    if (data.length > this.maxChunkSize) {
      throw new UploadError(`Chunk exceeds the ${this.maxChunkSize} byte limit`, 413);
    }
    const expectedSize =
      index === session.totalChunks - 1
        ? session.totalSize - this.maxChunkSize * (session.totalChunks - 1)
        : this.maxChunkSize;
    if (data.length !== expectedSize) {
      throw new UploadError(
        `Chunk ${index} has ${data.length} bytes; expected ${expectedSize}`,
        400,
      );
    }

    const partPath = join(session.dir, `${index}.part`);
    const tempPath = join(session.dir, `${index}.${randomUUID()}.tmp`);
    await writeFile(tempPath, data, { flag: 'wx' });
    try {
      try {
        await link(tempPath, partPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const existing = await readFile(partPath);
        if (!existing.equals(data)) {
          throw new UploadError(`Chunk ${index} was already uploaded with different data`, 409);
        }
      }
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }

    session.uploaded.set(index, data.length);
    this.touch(session);
    return { bytes: data.length };
  }

  async complete(uploadId: string): Promise<{ filename: string; bytes: number }> {
    const completed = this.completed.get(uploadId);
    if (completed) return completed;
    const session = this.requireSession(uploadId);
    if (session.completing) throw new UploadError('Upload is already being finalized', 409);
    session.completing = true;
    this.clearIdleTimer(session.id);

    const assemblyPath = join(session.dir, 'assembled.tmp');
    try {
      if (session.uploaded.size !== session.totalChunks) {
        throw new UploadError(
          `Upload is incomplete: ${session.uploaded.size}/${session.totalChunks} chunks`,
          409,
        );
      }
      const uploadedBytes = [...session.uploaded.values()].reduce((sum, size) => sum + size, 0);
      if (uploadedBytes !== session.totalSize) {
        throw new UploadError(
          `Uploaded size ${uploadedBytes} does not match declared size ${session.totalSize}`,
          409,
        );
      }

      const handle = await open(assemblyPath, 'wx');
      try {
        for (let index = 0; index < session.totalChunks; index++) {
          await handle.writeFile(await readFile(join(session.dir, `${index}.part`)));
        }
      } finally {
        await handle.close();
      }

      const assembled = await stat(assemblyPath);
      if (assembled.size !== session.totalSize) {
        throw new UploadError('Assembled file size does not match the upload manifest', 409);
      }

      const finalPath = join(this.downloadsDir, session.filename);
      try {
        await link(assemblyPath, finalPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new UploadError(`File "${session.filename}" already exists`, 409);
        }
        throw err;
      }

      const result = { filename: session.filename, bytes: session.totalSize };
      this.release(session);
      this.rememberCompleted(session.id, result);
      await rm(session.dir, { recursive: true, force: true }).catch(() => undefined);
      return result;
    } catch (err) {
      session.completing = false;
      this.touch(session);
      await unlink(assemblyPath).catch(() => undefined);
      throw err;
    }
  }

  async cancel(uploadId: string): Promise<void> {
    if (this.completed.has(uploadId)) return;
    const session = this.requireSession(uploadId);
    if (session.completing) throw new UploadError('Upload is being finalized', 409);
    this.release(session);
    await rm(session.dir, { recursive: true, force: true });
  }

  private requireSession(id: string): UploadSession {
    const session = this.sessions.get(id);
    if (!session) throw new UploadError('Upload session not found or expired', 404);
    return session;
  }

  private release(session: UploadSession): void {
    this.sessions.delete(session.id);
    this.reservedNames.delete(session.filenameKey);
    this.clearIdleTimer(session.id);
  }

  private touch(session: UploadSession): void {
    this.clearIdleTimer(session.id);
    const timer = setTimeout(() => {
      const current = this.sessions.get(session.id);
      if (current !== session || current.completing) return;
      this.release(session);
      void rm(session.dir, { recursive: true, force: true }).catch(() => undefined);
    }, this.idleTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.idleTimers.set(session.id, timer);
  }

  private clearIdleTimer(uploadId: string): void {
    const timer = this.idleTimers.get(uploadId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(uploadId);
  }

  private rememberCompleted(uploadId: string, result: { filename: string; bytes: number }): void {
    this.completed.set(uploadId, result);
    const timer = setTimeout(() => this.completed.delete(uploadId), COMPLETED_UPLOAD_TTL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  private safeFilename(raw: string): string {
    const filename = basename(raw.trim());
    if (!filename || filename === '.' || filename === '..') {
      throw new UploadError('Invalid filename', 400);
    }
    return filename;
  }

  private filenameKey(filename: string): string {
    return process.platform === 'win32' || process.platform === 'darwin'
      ? filename.toLowerCase()
      : filename;
  }

  private async removeStaleUploads(): Promise<void> {
    const cutoff = Date.now() - STALE_UPLOAD_AGE_MS;
    for (const entry of await readdir(this.tempDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.tempDir, entry.name);
      try {
        if ((await stat(dir)).mtimeMs < cutoff) {
          await rm(dir, { recursive: true, force: true });
        }
      } catch {
        // A concurrently removed stale directory needs no further cleanup.
      }
    }
  }
}
