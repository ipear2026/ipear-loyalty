// ═══════════════════════════════════════════════════════════════════════════
//  iPear Loyalty — Firebase Cloud Messaging Service Worker
// ═══════════════════════════════════════════════════════════════════════════

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyBNnRTmoR5ZIrJAXz3IwQbvXQZFgdt5zvY",
  authDomain:        "loyalty-ipear.firebaseapp.com",
  projectId:         "loyalty-ipear",
  storageBucket:     "loyalty-ipear.firebasestorage.app",
  messagingSenderId: "927652567960",
  appId:             "1:927652567960:web:8330b9de98d4ef215ca9ed"
});

const messaging = firebase.messaging();

// Validate that a URL is a safe same-origin relative path (no open-redirect via push)
function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  // Allow only relative paths starting with /
  if (!url.startsWith('/')) return false;
  // Reject protocol-relative and data URIs that slip through
  if (url.startsWith('//') || url.startsWith('/\\')) return false;
  return true;
}

// ── Background message handler ────────────────────────────────────────────
messaging.onBackgroundMessage(payload => {
  // Support both notification messages and data-only messages
  const notif = payload.notification || {};
  const data  = payload.data         || {};

  const title = notif.title || data.title || 'iPear Loyalty';
  const body  = notif.body  || data.body  || '';
  const icon  = notif.icon  || '/icon-192.png';

  self.registration.showNotification(title, {
    body,
    icon,
    badge: '/icon-192.png',
    tag:   data.tag || 'ipear-push',
    data:  data,
    actions: [
      { action: 'open',    title: 'Άνοιγμα' },
      { action: 'dismiss', title: 'Αργότερα' }
    ]
  });
});

// ── Notification click handler ────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const rawUrl  = event.notification.data?.url;
  const safeUrl = isSafeUrl(rawUrl) ? rawUrl : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('index') || c.url.endsWith('/'));
      if (existing) return existing.focus().catch(() => clients.openWindow(safeUrl));
      return clients.openWindow(safeUrl);
    })
  );
});
