// ─── bump this version every deploy to bust the cache ───────────────────────
const CACHE_VER = 'ipear-loyalty-20260615-v55';

// ═══ KILL SWITCH: Nuclear self-destruct for zombie PWA recovery ═════════════
// If the Worker returns { nuke: true }, this SW wipes all caches and unregisters itself.
// Trigger: set KV key "sw_kill" to "true" → GET /sw-kill returns { nuke: true }
// This runs on every fetch so even a broken cached page triggers recovery.
const _KILL_CHECK_URL = 'https://email-worker.ipear2026.workers.dev/sw-kill';
let _killChecked = false;

async function _checkKillSwitch() {
  if (_killChecked) return false;
  _killChecked = true;  // check once per SW lifecycle
  try {
    const res = await fetch(_KILL_CHECK_URL, { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.nuke) {
      console.warn('[SW-KILL] ☠️ Kill switch activated — nuking all caches');
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.navigate(c.url));  // force hard reload
      return true;
    }
  } catch(_) { /* network down — can't check, proceed normally */ }
  return false;
}
const SHELL = [
  'customer.html',
  'snd-success.mp3',
  'snd-error.mp3',
  'manifest-customer.json',
  'icon-192.png',
  'icon-512.png',
  'fonts/zonapro-regular-webfont.woff2',
  'fonts/zonapro-bold-webfont.woff2'
];

// ── Branded offline page (served when network + cache both fail) ────────────
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="el">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<meta name="theme-color" content="#8ae900">
<title>iPear Loyalty — Offline</title>
<style>
  @font-face{font-family:'Zona Pro';src:url('fonts/zonapro-bold-webfont.woff2') format('woff2');font-weight:700;font-display:swap}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Zona Pro',system-ui,sans-serif;background:#F6F6F6;color:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh;padding:24px;text-align:center;-webkit-font-smoothing:antialiased}
  .wrap{max-width:380px;width:100%}
  .logo{font-size:2rem;font-weight:900;letter-spacing:-1px;margin-bottom:8px}
  .logo span{color:#8ae900}
  .icon{font-size:3rem;margin-bottom:12px;animation:float 3s ease-in-out infinite}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
  h1{font-size:1.3rem;font-weight:800;margin-bottom:8px;line-height:1.3}
  p{font-size:.92rem;color:#666;line-height:1.6;margin-bottom:20px}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:#8ae900;color:#111;border:none;border-radius:14px;font-family:inherit;font-weight:800;font-size:.95rem;cursor:pointer;box-shadow:0 4px 16px rgba(138,233,0,.3);transition:transform .12s}
  .btn:active{transform:scale(.96)}
  .status{margin-top:16px;font-size:.78rem;color:#999}
  .pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:#ff3b30;margin-right:6px;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .card-box{background:#fff;border:2px solid #8ae900;border-radius:18px;padding:24px 16px;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,0,0,.06)}
  .card-name{font-size:1.05rem;font-weight:800;margin-bottom:2px}
  .card-num{font-size:.88rem;font-weight:700;letter-spacing:2px;color:#666;margin-bottom:4px}
  .card-pts{font-size:.82rem;color:#8ae900;font-weight:700;margin-bottom:14px}
  #qr-canvas{margin:0 auto}
  .card-hint{font-size:.72rem;color:#999;margin-top:10px}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">i<span>Pear</span></div>
  <div id="card-section"></div>
  <div id="generic-section">
    <div class="icon">📡</div>
    <h1>Offline</h1>
    <p>Συνδέσου σε Wi-Fi ή ενεργοποίησε τα δεδομένα κινητού για να δεις τους πόντους σου.</p>
  </div>
  <button class="btn" onclick="location.reload()">🔄 Δοκίμασε ξανά</button>
  <div class="status"><span class="pulse"></span>Εκτός σύνδεσης</div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  window.addEventListener('online', () => location.reload());
  try {
    var raw = localStorage.getItem('ipear_offline_card');
    if (raw) {
      var c = JSON.parse(raw);
      if (c && c.card) {
        document.getElementById('generic-section').style.display = 'none';
        var h = '<div class="card-box">';
        h += '<div class="card-name">' + (c.tierIcon||'') + ' ' + esc(c.name||'') + '</div>';
        h += '<div class="card-num">' + esc(c.card) + '</div>';
        if (c.points !== undefined) h += '<div class="card-pts">' + Number(c.points).toLocaleString('el-GR') + ' πόντοι</div>';
        h += '<div id="qr-canvas"></div>';
        h += '<div class="card-hint">Δείξε αυτό το QR στο κατάστημα</div>';
        h += '</div>';
        document.getElementById('card-section').innerHTML = h;
        if (typeof QRCode !== 'undefined') {
          new QRCode(document.getElementById('qr-canvas'), {
            text: c.card, width: 180, height: 180,
            colorDark: '#111111', colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
          });
        }
      }
    }
  } catch(e) {}
  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
</script>
</body>
</html>`;

// ── Install: pre-cache app shell ────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VER)
      .then(c => {
        // Cache the offline page alongside the shell
        const offlineRes = new Response(OFFLINE_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
        return Promise.all([
          c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))),
          c.put('/_offline', offlineRes)
        ]);
      })
      .then(() => self.skipWaiting())
  );
});

// ── Activate: check kill switch, delete old caches, take control ────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    _checkKillSwitch().then(nuked => {
      if (nuked) return; // SW is dead, don't continue
      return caches.keys()
        .then(keys => Promise.all(
          keys.filter(k => k !== CACHE_VER).map(k => caches.delete(k))
        ))
        .then(() => self.clients.claim())
        .then(() => self.clients.matchAll({ type: 'window' }))
        .then(clients => {
          // Tell all open tabs a new SW is active.
          // v46+ pages listen for this and reload; older pages ignore it.
          clients.forEach(c => {
            try { c.postMessage({ type: 'SW_UPDATED', version: CACHE_VER }); } catch(_) {}
          });
        });
    })
  );
});

// ── Fetch strategy ──────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Only handle same-origin requests
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

  // Cross-SW guard: this SW only handles customer; never intercept admin/tablet pages
  if (url.endsWith('admin.html') || url.endsWith('tablet.html')) return;

  const isHTML = e.request.headers.get('accept')?.includes('text/html') ||
                 url.endsWith('.html') || url.endsWith('/customer') ||
                 url === self.location.origin + '/';

  if (isHTML) {
    // ── HTML: network-first → cache → branded offline page ──────────────
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          if (res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_VER).then(c => c.put(e.request, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match('customer.html')
            .then(cached => cached || caches.match('/_offline'))
        )
    );
  } else {
    // ── Assets (fonts, icons, manifest): cache-first → network fallback ───
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
  // Nuclear option: admin can trigger via DevTools: navigator.serviceWorker.controller.postMessage('NUKE')
  if (e.data === 'NUKE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll())
      .then(cls => cls.forEach(c => c.navigate(c.url)));
  }
});

// ── FCM Push Notifications (handled in main SW for iOS Safari compatibility) ─
// When a push message arrives while the app is in background/closed,
// show a system notification.
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
