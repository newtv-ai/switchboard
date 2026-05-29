import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  ua?: string;
  subscribedAt: number;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface BroadcastResult {
  sent: number;
  removed: number;
  failed: number;
}

/**
 * Owns the VAPID keypair and the set of PWA push subscriptions, and fans a
 * notification out to every subscriber. Keys + subscriptions live as plain
 * JSON under certs/ — no database, mirroring gen-cert.js's "generate on first
 * start, persist to disk" pattern.
 */
export class PushManager {
  private readonly vapid: VapidKeys;
  private readonly subs = new Map<string, PushSubscriptionRecord>();
  private readonly subsPath: string;

  private constructor(
    vapid: VapidKeys,
    subs: PushSubscriptionRecord[],
    subsPath: string,
    contact: string,
  ) {
    this.vapid = vapid;
    this.subsPath = subsPath;
    for (const s of subs) this.subs.set(s.endpoint, s);
    // VAPID "subject" is a protocol-required contact identifier (mailto:/https:).
    webpush.setVapidDetails(`mailto:${contact}`, vapid.publicKey, vapid.privateKey);
  }

  /** Load keys + subscriptions from certsDir, generating the VAPID pair on first run. */
  static create(certsDir: string): PushManager {
    fs.mkdirSync(certsDir, { recursive: true });

    const vapidPath = path.join(certsDir, 'vapid-keys.json');
    let vapid: VapidKeys;
    let regenerated = false;
    if (fs.existsSync(vapidPath)) {
      vapid = JSON.parse(fs.readFileSync(vapidPath, 'utf8')) as VapidKeys;
    } else {
      vapid = webpush.generateVAPIDKeys();
      fs.writeFileSync(vapidPath, JSON.stringify(vapid, null, 2));
      regenerated = true;
    }

    const subsPath = path.join(certsDir, 'push-subscriptions.json');
    let subs: PushSubscriptionRecord[] = [];
    if (fs.existsSync(subsPath)) {
      if (regenerated) {
        // A fresh VAPID pair invalidates every stored subscription (each is
        // bound to the old public key). Drop them; clients must re-subscribe.
        console.warn('[alarm] new VAPID keypair generated — clearing stale push subscriptions');
        fs.rmSync(subsPath, { force: true });
      } else {
        try {
          subs = JSON.parse(fs.readFileSync(subsPath, 'utf8')) as PushSubscriptionRecord[];
        } catch {
          // Corrupt file — start empty rather than crash, but make it visible.
          console.warn(`[alarm] could not parse ${subsPath} — starting with no subscriptions`);
          subs = [];
        }
      }
    }

    const contact = process.env.SWITCHBOARD_VAPID_CONTACT ?? 'admin@example.com';
    return new PushManager(vapid, subs, subsPath, contact);
  }

  get publicKey(): string {
    return this.vapid.publicKey;
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  private persist(): void {
    // Write-then-rename so a crash mid-write can't leave a half-written file
    // that fails to parse on next boot (silently dropping every subscription).
    const tmp = `${this.subsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.subs.values()], null, 2));
    fs.renameSync(tmp, this.subsPath);
  }

  addSubscription(rec: PushSubscriptionRecord): void {
    // Keyed by endpoint, so re-subscribing the same browser updates in place.
    this.subs.set(rec.endpoint, rec);
    this.persist();
  }

  removeSubscription(endpoint: string): void {
    if (this.subs.delete(endpoint)) this.persist();
  }

  /**
   * Send `payload` (a JSON-serialisable object) to every subscriber. Expired
   * subscriptions (404/410) are pruned automatically. Never throws.
   */
  async broadcast(payload: unknown): Promise<BroadcastResult> {
    const body = JSON.stringify(payload);
    const result: BroadcastResult = { sent: 0, removed: 0, failed: 0 };
    await Promise.allSettled(
      // Snapshot the values first so pruning expired subs mid-loop is safe.
      [...this.subs.values()].map(async (sub) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body);
          result.sent++;
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          // 404/410 = subscription gone; 403 = VAPID/auth mismatch (e.g. the
          // server's key rotated). In every case the sub is dead — prune it.
          if (code === 404 || code === 410 || code === 403) {
            this.removeSubscription(sub.endpoint);
            result.removed++;
          } else {
            result.failed++;
          }
        }
      }),
    );
    return result;
  }
}

/**
 * Verify the optional `X-Falldown-Signature: sha256=<hex>` header against the
 * raw request body. MUST use the raw bytes — re-stringifying parsed JSON would
 * change field order/whitespace and break the HMAC.
 */
export function verifyAlarmSignature(
  rawBody: Buffer,
  headerValue: string | undefined,
  secret: string,
): boolean {
  if (!headerValue?.startsWith('sha256=')) return false;
  let given: Buffer;
  try {
    given = Buffer.from(headerValue.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
