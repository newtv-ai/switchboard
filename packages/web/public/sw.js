// Switchboard service worker — Web Push for fall-detection alarms.
// Registered on demand by AlarmToggle when the user enables notifications.

self.addEventListener('install', () => {
  // Activate immediately so the first alarm works without a reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || '告警', {
      body: data.body || '',
      tag: data.tag,
      renotify: data.renotify,
      data: { url: data.url || '/' },
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      vibrate: [200, 100, 200],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients
      // includeUncontrolled: the SW may not control the page yet (we register
      // on demand), but we still want to find and focus an open window.
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.startsWith(self.location.origin)) {
            client.postMessage({ type: 'navigate', url });
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
