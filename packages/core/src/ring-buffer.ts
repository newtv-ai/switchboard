/**
 * Fixed-capacity circular byte buffer.
 * Used to retain recent PTY output so a newly attached client can replay it.
 */
export class RingBuffer {
  private readonly buf: Buffer;
  private writePos = 0;
  private filled = false;

  constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new Error('RingBuffer capacity must be positive');
    this.buf = Buffer.alloc(capacity);
  }

  write(chunk: Buffer): void {
    const len = chunk.length;
    if (len === 0) return;

    if (len >= this.capacity) {
      chunk.copy(this.buf, 0, len - this.capacity);
      this.writePos = 0;
      this.filled = true;
      return;
    }

    const room = this.capacity - this.writePos;
    if (len <= room) {
      chunk.copy(this.buf, this.writePos);
      this.writePos = (this.writePos + len) % this.capacity;
      if (len === room) this.filled = true;
    } else {
      chunk.copy(this.buf, this.writePos, 0, room);
      chunk.copy(this.buf, 0, room);
      this.writePos = len - room;
      this.filled = true;
    }
  }

  /** Return all retained bytes in oldest-to-newest order. */
  getAll(): Buffer {
    if (!this.filled) return Buffer.from(this.buf.subarray(0, this.writePos));
    return Buffer.concat([this.buf.subarray(this.writePos), this.buf.subarray(0, this.writePos)]);
  }

  get size(): number {
    return this.filled ? this.capacity : this.writePos;
  }

  clear(): void {
    this.writePos = 0;
    this.filled = false;
  }
}
