// ═══════════════════════════════════════════════════════════════════════════
//  iPear Loyalty — Customer Bootstrap
//
//  Phase 19: this file holds the error-telemetry bootstrap that used to live
//  inline in index.html. Extracting it lets the CSP drop
//  `script-src 'unsafe-inline'` for the customer entry. Loaded as a classic
//  (non-module) script in <head> so it runs before the main.js module bundle
//  and can catch early errors. Behavior is byte-for-byte the former inline IIFE.
// ═══════════════════════════════════════════════════════════════════════════
(function(){
  var _W = 'https://email-worker.ipear2026.workers.dev';
  var _Q = []; var _F = false;
  function _send(payload) {
    if (_F) return;
    _F = true;
    try {
      var body = JSON.stringify(Object.assign({
        page: location.pathname,
        ua: navigator.userAgent,
        ts: new Date().toISOString(),
        build: (window.CUSTOMER_BUILD_TAG || window.TABLET_BUILD_TAG || 'unknown')
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
    var m = String(r&&r.message||r||'');
    if (m.indexOf('messaging/unsupported-browser') !== -1) return;
    _send({ type:'rejection', message:m.slice(0,500), stack:(r&&r.stack||'').slice(0,800) });
  });
})();
