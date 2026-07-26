import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UploadManager } from './upload-manager.js';

async function fixture(): Promise<{ manager: UploadManager; downloads: string }> {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-upload-test-'));
  const downloads = join(root, 'downloads');
  const manager = new UploadManager(downloads, join(root, 'uploads'), {
    maxUploadSize: 1024,
    maxChunkSize: 5,
    idleTimeoutMs: 1000,
  });
  await manager.init();
  return { manager, downloads };
}

test('publishes only a complete upload and assembles chunks in order', async () => {
  const { manager, downloads } = await fixture();
  const { uploadId } = await manager.create({
    filename: 'result.txt',
    totalSize: 10,
    totalChunks: 2,
  });

  await manager.writeChunk(uploadId, 0, Buffer.from('hello'));
  assert.deepEqual(await readdir(downloads), []);
  await assert.rejects(() => manager.complete(uploadId), /incomplete/);

  await manager.writeChunk(uploadId, 1, Buffer.from('world'));
  const completed = { filename: 'result.txt', bytes: 10 };
  assert.deepEqual(await manager.complete(uploadId), completed);
  assert.deepEqual(await manager.complete(uploadId), completed);
  await manager.cancel(uploadId);
  assert.equal(await readFile(join(downloads, 'result.txt'), 'utf8'), 'helloworld');
});

test('retries identical chunks but rejects conflicting data and filenames', async () => {
  const { manager } = await fixture();
  const first = await manager.create({ filename: 'same.bin', totalSize: 5, totalChunks: 1 });

  await assert.rejects(
    () => manager.create({ filename: 'same.bin', totalSize: 5, totalChunks: 1 }),
    /already in progress/,
  );
  await assert.rejects(
    () => manager.writeChunk(first.uploadId, 0, Buffer.from('tiny')),
    /expected 5/,
  );
  await manager.writeChunk(first.uploadId, 0, Buffer.from('first'));
  await manager.writeChunk(first.uploadId, 0, Buffer.from('first'));
  await assert.rejects(
    () => manager.writeChunk(first.uploadId, 0, Buffer.from('other')),
    /different data/,
  );
});

test('an existing file is only replaced when the client asks for it', async () => {
  const { manager, downloads } = await fixture();
  const first = await manager.create({ filename: 'dup.txt', totalSize: 5, totalChunks: 1 });
  await manager.writeChunk(first.uploadId, 0, Buffer.from('older'));
  await manager.complete(first.uploadId);

  const refused = await manager
    .create({ filename: 'dup.txt', totalSize: 5, totalChunks: 1 })
    .then(() => undefined)
    .catch((err: { statusCode: number; code: string }) => err);
  assert.equal(refused?.statusCode, 409);
  // The UI branches on this code to offer "overwrite?" — prose must not be
  // the contract.
  assert.equal(refused?.code, 'file-exists');
  assert.equal(await readFile(join(downloads, 'dup.txt'), 'utf8'), 'older');

  const second = await manager.create({
    filename: 'dup.txt',
    totalSize: 5,
    totalChunks: 1,
    overwrite: true,
  });
  await manager.writeChunk(second.uploadId, 0, Buffer.from('newer'));
  await manager.complete(second.uploadId);
  assert.equal(await readFile(join(downloads, 'dup.txt'), 'utf8'), 'newer');
  assert.deepEqual(await readdir(downloads), ['dup.txt']);
});

test('the client picks its own chunk size within the server limit', async () => {
  const { manager, downloads } = await fixture();
  // maxChunkSize is 5 in this fixture; a client using 2-byte chunks is fine.
  const { uploadId } = await manager.create({
    filename: 'small-chunks.txt',
    totalSize: 5,
    totalChunks: 3,
    chunkSize: 2,
  });
  await manager.writeChunk(uploadId, 0, Buffer.from('ab'));
  await manager.writeChunk(uploadId, 1, Buffer.from('cd'));
  await assert.rejects(
    () => manager.writeChunk(uploadId, 2, Buffer.from('ef')),
    /expected 1/,
    'the tail chunk is sized from the declared chunkSize',
  );
  await manager.writeChunk(uploadId, 2, Buffer.from('e'));
  await manager.complete(uploadId);
  assert.equal(await readFile(join(downloads, 'small-chunks.txt'), 'utf8'), 'abcde');

  await assert.rejects(
    () =>
      manager.create({
        filename: 'too-big-chunks.txt',
        totalSize: 12,
        totalChunks: 2,
        chunkSize: 6,
      }),
    /chunkSize must be a positive integer no greater than 5/,
  );
  await assert.rejects(
    () =>
      manager.create({
        filename: 'wrong-count.txt',
        totalSize: 5,
        totalChunks: 2,
        chunkSize: 2,
      }),
    /totalChunks must be 3 for 2 byte chunks/,
  );
});

test('reserves a filename before concurrent create calls can pass the disk check', async () => {
  const { manager } = await fixture();
  const attempts = await Promise.allSettled([
    manager.create({ filename: 'concurrent.bin', totalSize: 5, totalChunks: 1 }),
    manager.create({ filename: 'concurrent.bin', totalSize: 5, totalChunks: 1 }),
  ]);

  const fulfilled = attempts.filter(
    (attempt): attempt is PromiseFulfilledResult<{ uploadId: string; filename: string }> =>
      attempt.status === 'fulfilled',
  );
  const rejected = attempts.filter(
    (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
  );
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]?.reason), /already in progress/);

  const uploadId = fulfilled[0]?.value.uploadId;
  assert.ok(uploadId);
  await manager.cancel(uploadId);
});

test('cancel removes partial state without publishing a file', async () => {
  const { manager, downloads } = await fixture();
  const { uploadId } = await manager.create({
    filename: 'cancelled.txt',
    totalSize: 5,
    totalChunks: 1,
  });
  await manager.writeChunk(uploadId, 0, Buffer.from('hello'));
  await manager.cancel(uploadId);

  assert.deepEqual(await readdir(downloads), []);
  await assert.rejects(() => manager.complete(uploadId), /not found or expired/);
});

test('idle sessions release their filename reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-upload-expiry-test-'));
  const manager = new UploadManager(join(root, 'downloads'), join(root, 'uploads'), {
    maxUploadSize: 1024,
    maxChunkSize: 5,
    idleTimeoutMs: 10,
  });
  await manager.init();
  await manager.create({ filename: 'expired.txt', totalSize: 5, totalChunks: 1 });
  await new Promise((resolve) => setTimeout(resolve, 30));

  await assert.doesNotReject(() =>
    manager.create({ filename: 'expired.txt', totalSize: 5, totalChunks: 1 }),
  );
});
