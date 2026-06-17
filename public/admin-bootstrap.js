// ═══════════════════════════════════════════════════════════════════════════
//  iPear Loyalty — Admin Bootstrap
//
//  Phase B/3b: this file holds every script that used to live inline in
//  admin.html. Extracting them lets us drop `script-src 'unsafe-inline'`
//  from the CSP for the admin entry. Loaded as a classic (non-module)
//  script so it runs before the admin-main.js bundle finishes parsing.
//
//  Contents:
//    1. Service Worker registration
//    2. Global error / unhandledrejection telemetry → Worker /client-error
//    3. Build-stamp text (mirrors window.ADMIN_BUILD_TAG into #build-stamp)
// ═══════════════════════════════════════════════════════════════════════════

// 1. Service Worker registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (e) {
      console.warn('[sw] registration failed:', e.message);
    });
  });
}

// 2. Client-side error telemetry (fires once per page load)
(function () {
  var _W = 'https://email-worker.ipear2026.workers.dev';
  var _F = false;
  function _send(payload) {
    if (_F) return;
    _F = true;
    try {
      var body = JSON.stringify(Object.assign({
        page:  location.pathname,
        ua:    navigator.userAgent,
        ts:    new Date().toISOString(),
        build: (window.ADMIN_BUILD_TAG || 'unknown'),
      }, payload));
      if (navigator.sendBeacon) {
        navigator.sendBeacon(_W + '/client-error', body);
      } else {
        fetch(_W + '/client-error', {
          method:  'POST',
          body:    body,
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
        }).catch(function () {});
      }
    } catch (_) {}
  }
  window.onerror = function (msg, src, line, col, err) {
    _send({
      type:    'onerror',
      message: String(msg).slice(0, 500),
      source:  (src || '').slice(-120),
      line:    line,
      col:     col,
      stack:   (err && err.stack || '').slice(0, 800),
    });
  };
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    _send({
      type:    'rejection',
      message: String(r && r.message || r || '').slice(0, 500),
      stack:   (r && r.stack || '').slice(0, 800),
    });
  });
})();

// 3. Build-stamp text (deferred until DOMContentLoaded; #build-stamp is at the
// bottom of <body> so by the time the bundle loads it definitely exists, but
// guarding for safety since admin-main.js loads as type=module — deferred).
function _setBuildStamp() {
  var el = document.getElementById('build-stamp');
  if (el) el.textContent = window.ADMIN_BUILD_TAG || 'unknown';
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _setBuildStamp);
} else {
  _setBuildStamp();
}
