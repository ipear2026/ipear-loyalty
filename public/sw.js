// ─── bump this version every deploy to bust the cache ────────────────────────
const CACHE_VER = 'ipear-admin-20260615-v6';

// ═══ KILL SWITCH: Nuclear self-destruct for zombie PWA recovery ═════════════
const _KILL_CHECK_URL = 'https://email-worker.ipear2026.workers.dev/sw-kill';
let _killChecked = false;
async function _checkKillSwitch() {
  if (_killChecked) return false;
  _killChecked = true;
  try {
    const res = await fetch(_KILL_CHECK_URL, { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.nuke) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.navigate(c.url));
      return true;
    }
  } catch(_) {}
  return false;
}
const SHELL = ['admin.html', 'manifest.json'];

// ── Install: pre-cache shell ─────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VER)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: check kill switch, delete old caches, take control ────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    _checkKillSwitch().then(nuked => {
      if (nuked) return;
      return caches.keys()
        .then(keys => Promise.all(
          keys.filter(k => k !== CACHE_VER).map(k => caches.delete(k))
        ))
        .then(() => self.clients.claim());
    })
  );
});

// ── Fetch: network-first for HTML, cache-first for assets ────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (!url.startsWith(self.location.origin)) return;

  // Hostname-based bypass for Firebase/CDN — avoids false matches on path segments
  try {
    const { hostname } = new URL(url);
    if (
      hostname.endsWith('googleapis.com') ||
      hostname.endsWith('gstatic.com')    ||
      hostname.endsWith('firebaseio.com') ||
      hostname.endsWith('firebaseapp.com')||
      hostname === 'cdnjs.cloudflare.com'
    ) return;
  } catch (_) { return; }

  // Cross-SW guard: this SW only handles admin; never intercept customer/tablet pages
  if (url.endsWith('customer.html') || url.endsWith('tablet.html')) return;

  const isHTML = e.request.headers.get('accept')?.includes('text/html') ||
                 url.endsWith('.html') || url.endsWith('/admin');

  if (isHTML) {
    // Network-first: always get fresh admin.html, fall back to cache offline
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          if (res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_VER).then(c => c.put(e.request, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('admin.html'))
    );
  } else {
    // Cache-first for assets (manifest, icons, fonts)
    // No HTML fallback for failed asset fetches — returning wrong content type causes errors
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (e.request.method === 'GET' && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_VER).then(c => c.put(e.request, clone)).catch(() => {});
          }
          return res;
        });
      })
    );
  }
});

// ── Listen for messages from client ──────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'NUKE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll())
      .then(cls => cls.forEach(c => c.navigate(c.url)));
  }
});

// ── FCM Push Notifications ─────────────────────────────────────────────────
// This SW (admin) shares scope "/" with sw-customer.js.  When admin.html is
// the last page visited this SW becomes the active controller.  Without a
// push handler, incoming FCM pushes would be silently dropped.
self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch(_) { return; }

  const notif = payload.notification || {};
  const data  = payload.data || {};

  const title = notif.title || data.title || 'iPear Loyalty';
  const body  = notif.body  || data.body  || '';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:  '/icon-192.png',
      badge: '/icon-192.png',
      tag:   data.tag || 'ipear-push',
      data:  data,
    })
  );
});

// ── Notification click → open customer app ──────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = '/customer.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('customer'));
      if (existing) return existing.focus().catch(() => clients.openWindow(url));
      return clients.openWindow(url);
    })
  );
});
