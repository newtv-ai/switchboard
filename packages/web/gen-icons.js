#!/usr/bin/env node
// Generate placeholder PWA icons (dark square + red alarm dot) for the
// manifest, apple-touch-icon, and Web Push notification icon/badge.
// Pure stdlib PNG encoder — no image deps. Replace with real art anytime.
// Run: node packages/web/gen-icons.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function pngCircle(size, bg, fg) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.34;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const px = dx * dx + dy * dy <= r * r ? fg : bg;
      const o = 1 + x * 4;
      row[o] = px[0];
      row[o + 1] = px[1];
      row[o + 2] = px[2];
      row[o + 3] = px[3];
    }
    rows.push(row);
  }
  const idat = deflateSync(Buffer.concat(rows));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const publicDir = join(__dirname, 'public');
mkdirSync(publicDir, { recursive: true });

const DARK = [12, 12, 12, 255];
const RED = [229, 57, 53, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

writeFileSync(join(publicDir, 'icon-192.png'), pngCircle(192, DARK, RED));
writeFileSync(join(publicDir, 'icon-512.png'), pngCircle(512, DARK, RED));
writeFileSync(join(publicDir, 'apple-touch-icon.png'), pngCircle(180, DARK, RED));
writeFileSync(join(publicDir, 'badge-72.png'), pngCircle(72, CLEAR, WHITE));

console.log('Generated PWA icons in', publicDir);
