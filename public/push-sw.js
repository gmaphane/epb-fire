/* Fire alerts: shows push notifications even when the app is closed, and opens the right screen on tap.
   Loaded into the generated service worker (vite.config.ts → workbox.importScripts). */
self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = { title: 'EmberWatch', body: event.data && event.data.text() }; }
  const urgent = !!m.urgent;
  // tell any open copy of the app to sync straight away
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'ew-push', kind: m.kind || null }))).catch(() => {});
  event.waitUntil(self.registration.showNotification(m.title || 'EmberWatch', {
    body: m.body || '',
    tag: m.tag || undefined,
    renotify: !!m.tag,
    requireInteraction: urgent,
    silent: false,
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
