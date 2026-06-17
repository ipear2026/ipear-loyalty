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
//    4. HIGH-3: Event delegation dispatcher — restores behavior of the
//       inline oninput/onchange/onfocus/onblur/onmouseover/onmouseout
//       handlers that were removed from admin.html so the CSP could drop
//       `script-src 'unsafe-inline'`. Triggers are encoded as data-on-<evt>
//       attributes with a small action vocabulary.
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

// 4. Event delegation for CSP-safe handlers (HIGH-3)
//
// Action vocabulary (value of data-on-<evt> attribute):
//   numeric-sanitize     — strip non-digits from the input value
//   focus-green          — set borderColor to #6bb800
//   blur-default         — set borderColor to var(--border)
//   hover-green          — set borderColor to var(--green)
//   hover-default        — set borderColor to var(--border)
//   count-chars          — write `<len>` or `<len>/<max>` into the element
//                          identified by data-counter-target; max comes from
//                          data-counter-max (optional).
//   call:<fnName>        — invoke window.<fnName>() with no args
//   call:<fnName>:value  — invoke window.<fnName>(el.value)
//   call:<fnName>:event  — invoke window.<fnName>(ev)
(function () {
  function _run(action, el, ev) {
    switch (action) {
      case 'numeric-sanitize':
        el.value = String(el.value || '').replace(/[^0-9 ]/g, '');
        return;
      case 'focus-green':
        el.style.borderColor = '#6bb800';
        return;
      case 'blur-default':
        el.style.borderColor = 'var(--border)';
        return;
      case 'hover-green':
        el.style.borderColor = 'var(--green)';
        return;
      case 'hover-default':
        el.style.borderColor = 'var(--border)';
        return;
      case 'count-chars': {
        var targetId = el.getAttribute('data-counter-target');
        if (!targetId) return;
        var tgt = document.getElementById(targetId);
        if (!tgt) return;
        var max = el.getAttribute('data-counter-max');
        var len = String(el.value || '').length;
        tgt.textContent = max ? (len + '/' + max) : String(len);
        return;
      }
      default: {
        if (action.indexOf('call:') !== 0) return;
        var parts = action.split(':');
        var fnName = parts[1];
        var arg    = parts[2] || '';
        var fn = window[fnName];
        if (typeof fn !== 'function') return;
        if (arg === 'value')      fn(el.value);
        else if (arg === 'event') fn(ev);
        else                      fn();
      }
    }
  }
  function _dispatch(evt, attr) {
    var el = evt.target;
    // Walk up — handlers may sit on container elements (e.g. hover on a div).
    while (el && el.getAttribute) {
      var action = el.getAttribute(attr);
      if (action) { _run(action, el, evt); return; }
      el = el.parentNode;
    }
  }
  var events = [
    { name: 'input',     attr: 'data-on-input',     capture: false },
    { name: 'change',    attr: 'data-on-change',    capture: false },
    { name: 'focus',     attr: 'data-on-focus',     capture: true  }, // focus doesn't bubble
    { name: 'blur',      attr: 'data-on-blur',      capture: true  }, // blur doesn't bubble
    { name: 'mouseover', attr: 'data-on-mouseover', capture: false },
    { name: 'mouseout',  attr: 'data-on-mouseout',  capture: false },
  ];
  for (var i = 0; i < events.length; i++) {
    (function (e) {
      document.addEventListener(e.name, function (ev) { _dispatch(ev, e.attr); }, e.capture);
    })(events[i]);
  }
})();
