// ═══════════════════════════════════════════════════════════════════════════
//  iPear Loyalty — Tablet Bootstrap (early error telemetry)
//
//  Phase 19: the early error-telemetry IIFE that used to live inline in the
//  <head> of tablet.html. Extracting it lets the CSP drop
//  `script-src 'unsafe-inline'` for the tablet entry. Loaded as a classic
//  (non-module) script in <head> so it runs as early as the inline block did.
//  Byte-for-byte the former inline IIFE. (The end-of-body login-boot guard is
//  in /tablet-login-boot.js, preserving its original DOM-ready placement.)
// ═══════════════════════════════════════════════════════════════════════════
(function(){
  var _W = 'https://email-worker.ipear2026.workers.dev';
  var _F = false;
  function _send(payload) {
    if (_F) return;
    _F = true;
    try {
      var body = JSON.stringify(Object.assign({
        page: location.pathname,
        ua: navigator.userAgent,
        ts: new Date().toISOString(),
        build: (window.TABLET_BUILD_TAG || window.CUSTOMER_BUILD_TAG || 'unknown')
      }, payload));
      if (navigator.sendBeacon) { navigator.sendBeacon(_W + '/client-error', body); }
      else { fetch(_W + '/client-error', { method:'POST', body:body, headers:{'Content-Type':'application/json'}, keepalive:true }).catch(function(){}); }
    } catch(_){}
  }
  window.onerror = function(msg, src, line, col, err) {
    _send({ type:'onerror', message:String(msg).slice(0,500), source:(src||'').slice(-120), line:line, col:col, stack:(err&&err.stack||'').slice(0,800) });
  };
  window.addEventListener('unhandledrejection', function(ev) {
    var r = ev.reason;
    _send({ type:'rejection', message:String(r&&r.message||r||'').slice(0,500), stack:(r&&r.stack||'').slice(0,800) });
  });
})();
