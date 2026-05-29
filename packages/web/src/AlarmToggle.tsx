import { useEffect, useState } from 'react';
import { HTTP_BASE } from './ws-url.js';

type State = 'loading' | 'unsupported' | 'idle' | 'subscribed' | 'denied' | 'working';

const SW_URL = '/sw.js';

/** VAPID public keys travel as URL-safe base64; PushManager wants a Uint8Array.
 *  Narrow to `<ArrayBuffer>` so it satisfies BufferSource under TS 5.7+. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * A single bell button that subscribes/unsubscribes this device to fall-alarm
 * Web Push. Self-contained: handles permission, SW registration, the VAPID
 * round-trip, and posting the subscription to the server.
 */
export function AlarmToggle(): JSX.Element | null {
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pushSupported()) {
      setState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setState('denied');
      return;
    }
    // Reflect any subscription that already exists from a previous visit.
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setState(sub ? 'subscribed' : 'idle'))
      .catch(() => setState('idle'));
  }, []);

  const enable = async (): Promise<void> => {
    setError(null);
    setState('working');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setState(perm === 'denied' ? 'denied' : 'idle');
        return;
      }
      await navigator.serviceWorker.register(SW_URL);
      const reg = await navigator.serviceWorker.ready;

      const res = await fetch(`${HTTP_BASE}/api/vapid-public-key`);
      if (!res.ok) throw new Error(`vapid key ${res.status}`);
      const { publicKey } = (await res.json()) as { publicKey: string };

      const appServerKey = urlBase64ToUint8Array(publicKey);
      const subscribe = (): Promise<PushSubscription> =>
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
      // If a subscription created with a different (rotated) VAPID key already
      // exists, subscribe() throws InvalidStateError — drop the stale one and
      // retry, otherwise re-enabling silently never delivers a push.
      const sub = await subscribe().catch(async (e) => {
        if (e instanceof DOMException && e.name === 'InvalidStateError') {
          await (await reg.pushManager.getSubscription())?.unsubscribe();
          return subscribe();
        }
        throw e;
      });

      const postRes = await fetch(`${HTTP_BASE}/api/push-subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub),
      });
      if (!postRes.ok) throw new Error(`subscribe ${postRes.status}`);
      setState('subscribed');
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // Full object (name + stack) to the console for diagnosis; name + message
      // to the visible alert so we can tell the failure CATEGORY apart
      // (NotAllowedError = local permission vs AbortError = push service).
      console.error('[alarm] enable failed:', e);
      const msg = `${e.name}: ${e.message}`;
      setError(msg);
      setState('idle');
      const certIssue = /ssl|certificat|insecure/i.test(msg);
      window.alert(
        `Couldn't enable alarms: ${msg}${
          certIssue
            ? "\n\nLooks cert-related: when the self-signed cert isn't trusted, some browsers refuse to register the service worker. Trust the cert on this device, or front it with a properly-trusted cert (works on any LAN / VPN)."
            : ''
        }`,
      );
    }
  };

  const disable = async (): Promise<void> => {
    setState('working');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        try {
          await fetch(`${HTTP_BASE}/api/push-unsubscribe`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
        } catch {
          // Best-effort server cleanup; the local unsubscribe below is what matters.
        }
        await sub.unsubscribe();
      }
      setState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('subscribed');
    }
  };

  if (state === 'loading') return null;
  if (state === 'unsupported') {
    return (
      <button
        type="button"
        className="btn btn-files"
        disabled
        title="Web Push isn't available here (iOS: Add to Home Screen first, Safari 16.4+)"
      >
        🔕 N/A
      </button>
    );
  }
  if (state === 'denied') {
    return (
      <button
        type="button"
        className="btn btn-files"
        disabled
        title="Notifications are blocked — re-allow them in browser/system settings, then reload"
      >
        🔕 Blocked
      </button>
    );
  }

  const subscribed = state === 'subscribed';
  return (
    <button
      type="button"
      className="btn btn-files"
      onClick={subscribed ? disable : enable}
      disabled={state === 'working'}
      title={
        error
          ? `Last error: ${error}`
          : subscribed
            ? 'Tap to turn off fall alerts'
            : 'Tap to turn on fall alerts'
      }
    >
      {state === 'working' ? '🔔 …' : subscribed ? '🔔 Alarms on' : '🔕 Alarms off'}
    </button>
  );
}
