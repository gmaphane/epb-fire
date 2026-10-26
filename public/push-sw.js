/* Fire alerts: shows push notifications even when the app is closed, and opens the right screen on tap.
   Loaded into the generated service worker (vite.config.ts → workbox.importScripts). */
self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = { title: 'EPB Fire', body: event.data && event.data.text() }; }
  const urgent = !!m.urgent;
  event.waitUntil(self.registration.showNotification(m.title || 'EPB Fire', {
    body: m.body || '',
    tag: m.tag || undefined,
    renotify: !!m.tag,
    requireInteraction: urgent,
    vibrate: urgent ? [500, 200, 500, 200, 800] : [200],
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: m.url || '/#/map' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/#/map';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.focus(); if ('navigate' in c) await c.navigate(url).catch(() => {}); return; } }
    await self.clients.openWindow(url);
  })());
});
