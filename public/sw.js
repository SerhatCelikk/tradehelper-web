/* TradeHelper Service Worker
 * Handles:
 *   - Skip waiting / claim clients (so updates take effect)
 *   - Notification click → focus or open the app
 *   - Push events (best-effort; this app is fully client-side, so most
 *     notifications are dispatched directly via registration.showNotification)
 */

const SW_VERSION = 'tradehelper-v1';
const CACHE_NAME = 'tradehelper-static-v1';

const STATIC_ASSETS = ['/', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => null))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'TradeHelper Alert', body: 'Condition met.' };
  try {
    if (event.data) {
      data = { ...data, ...event.data.json() };
    }
  } catch (err) {
    /* ignore */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.svg',
      tag: data.tag || 'tradehelper-alert',
      data,
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ('focus' in client) {
          client.focus();
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = event.data;
    self.registration.showNotification(title || 'TradeHelper', {
      body: body || '',
      icon: '/icon.svg',
      tag: tag || 'tradehelper-alert',
    });
  }
});
