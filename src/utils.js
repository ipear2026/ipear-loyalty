// ════════════════════════════════════════
//  WORKER URL (single source of truth)
// ════════════════════════════════════════
export const _WORKER_URL = window._IPEAR_WORKER_URL
  || localStorage.getItem('ipear_worker_url')
  || import.meta.env.VITE_WORKER_URL
  || 'https://email-worker.ipear2026.workers.dev';

// ════════════════════════════════════════
//  XSS GUARD — escape user-supplied strings before innerHTML
// ════════════════════════════════════════
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

// ════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════
let _toastT;
export function showToast(msg, cls='') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + cls + ' show';
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.remove('show'), 2800);
}
window.toast = showToast;

// ═══════════════════════════════════════════════════════════════════════════
//  Zero-Cookie Business Funnel Analytics
// ═══════════════════════════════════════════════════════════════════════════
export function _trackEvent(name) {
  try {
    const url = _WORKER_URL + '/log-event';
    const body = JSON.stringify({ event: name });
    if (navigator.sendBeacon) { navigator.sendBeacon(url, body); }
    else { fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {}); }
  } catch(_) { /* analytics must never break the app */ }
}

// ════════════════════════════════════════
//  A11Y: FOCUS TRAP FOR MODALS (WCAG 2.1 SC 2.4.3 / 2.1.2)
// ════════════════════════════════════════
let _focusTrapEl = null;
let _focusTrapPrev = null;

export function _trapFocus(dialogEl) {
  _focusTrapPrev = document.activeElement;
  _focusTrapEl = dialogEl;
  const first = dialogEl.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (first) setTimeout(() => first.focus(), 50);
}

export function _releaseFocus() {
  _focusTrapEl = null;
  if (_focusTrapPrev && _focusTrapPrev.focus) {
    try { _focusTrapPrev.focus(); } catch(_) {}
  }
  _focusTrapPrev = null;
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !_focusTrapEl) return;
  const focusable = _focusTrapEl.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

// ════════════════════════════════════════
//  DATE / STATUS HELPERS
// ════════════════════════════════════════
export function _parseExpiryMs(redemption) {
  if (!redemption) return null;
  if (redemption.expiresAtTs?.toMillis) return redemption.expiresAtTs.toMillis();
  if (redemption.expiresAtTs instanceof Date) return redemption.expiresAtTs.getTime();
  if (typeof redemption.expiresAtTs === 'string') {
    const t = new Date(redemption.expiresAtTs).getTime();
    if (!isNaN(t)) return t;
  }
  if (redemption.expiresAt) {
    const t = new Date(redemption.expiresAt).getTime();
    if (!isNaN(t)) return t;
  }
  if (redemption.createdAt) {
    const c = new Date(redemption.createdAt).getTime();
    if (!isNaN(c)) return c + 5 * 60 * 1000;
  }
  return null;
}

export function _isPendingAndActive(redemption) {
  if (!redemption || redemption.used === true) return false;
  if ((redemption.status || 'pending') !== 'pending') return false;
  const exp = _parseExpiryMs(redemption);
  return !!exp && Date.now() <= exp;
}

// ════════════════════════════════════════
//  TIER HELPER
// ════════════════════════════════════════
export function tier(t) {
  if (t>=10000) return {name:'Platinum', icon:'👑',cls:'platinum', next:null,  floor:10000};
  if (t>=6000)  return {name:'Diamond',  icon:'💎',cls:'diamond',  next:10000, floor:6000};
  if (t>=3000)  return {name:'Gold',     icon:'🥇',cls:'gold',     next:6000,  floor:3000};
  if (t>=1000)  return {name:'Silver',   icon:'🥈',cls:'silver',   next:3000,  floor:1000};
  return               {name:'Bronze',   icon:'🥉',cls:'bronze',   next:1000,  floor:0};
}

// Canonical tier floor for a given lifetime-points total. Mirrors tier().floor;
// exported so callers (and the boundary test) share one source of truth.
export function tierFloor(t) {
  return tier(t).floor;
}

export function _applyTierColors(cls) {
  const tiers = ['bronze','silver','gold','diamond','platinum'];
  const els = [
    document.querySelector('.hero-card'),
    document.querySelector('.loyalty-card'),
    document.querySelector('.profile-head'),
    document.querySelector('.rewards-pts-bar')
  ];
  els.forEach(el => {
    if (!el) return;
    tiers.forEach(c => el.classList.remove('tier-'+c));
    el.classList.add('tier-'+cls);
  });
}

// ── Reduced-motion gate (WCAG 2.3.3 / iOS Reduce Motion / Android Animations off) ─
function _prefersReducedMotion() {
  try {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) { return false; }
}

// ── Haptic feedback — Android + some PWAs. Silently no-ops elsewhere ─────
// Pattern presets keep call sites consistent and let us tune feel in one place.
const _HAPTIC_PATTERNS = {
  tap:     [10],            // single tap (button press)
  success: [10, 30, 10],    // QR scanned, points credited, redemption complete
  pop:     [6],             // reward card tap, chip nav, copy
  warn:    [12, 18, 12],    // soft warning before a non-blocking error toast
};
export function _haptic(kind = 'tap') {
  // Honour the user's reduced-motion preference — haptics are motion too.
  if (_prefersReducedMotion()) return;
  if (!navigator.vibrate) return;
  const pattern = _HAPTIC_PATTERNS[kind] || _HAPTIC_PATTERNS.tap;
  try { navigator.vibrate(pattern); } catch (_) { /* private mode / SecurityError */ }
}

// ── Count-up animation for live-changing numbers ─────────────────────────
// Drives a single numeric element from `from` → `to` over `duration` ms,
// formatted via toLocaleString('el-GR'). Cancels any in-flight count-up on
// the same element so back-to-back balance changes don't double-tween.
// `prefix` is prepended verbatim (e.g. '+' for delta toasts); not part of
// the interpolation.
const _animateNumberHandles = new WeakMap();
export function _animateNumber(el, from, to, { duration = 700, prefix = '' } = {}) {
  if (!el) return;
  const cancel = _animateNumberHandles.get(el);
  if (cancel) cancelAnimationFrame(cancel);
  // Reduced motion: snap to final value, no tween.
  if (_prefersReducedMotion() || from === to) {
    el.textContent = prefix + Number(to).toLocaleString('el-GR');
    _animateNumberHandles.delete(el);
    return;
  }
  const start = performance.now();
  const delta = to - from;
  // easeOutCubic — feels snappy at the start, settles smoothly at the end.
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const v = Math.round(from + delta * ease(t));
    el.textContent = prefix + v.toLocaleString('el-GR');
    if (t < 1) {
      _animateNumberHandles.set(el, requestAnimationFrame(tick));
    } else {
      _animateNumberHandles.delete(el);
    }
  }
  _animateNumberHandles.set(el, requestAnimationFrame(tick));
}

// ── Confetti helper — fires branded green/gold burst ─────────────────────
export function _fireConfetti(opts = {}) {
  if (typeof confetti !== 'function') return;
  const defaults = { particleCount: 120, spread: 80, origin: { y: 0.6 }, zIndex: 9999, colors: ['#8ae900','#6bb800','#ffd700','#ffffff','#111111'] };
  confetti({ ...defaults, ...opts });
}

export function _fireTierUpConfetti() {
  if (typeof confetti !== 'function') return;
  confetti({ particleCount: 80, angle: 60, spread: 55, origin: { x: 0, y: 0.65 }, zIndex: 9999, colors: ['#8ae900','#ffd700','#6bb800'] });
  confetti({ particleCount: 80, angle: 120, spread: 55, origin: { x: 1, y: 0.65 }, zIndex: 9999, colors: ['#8ae900','#ffd700','#6bb800'] });
}

// ════════════════════════════════════════
//  SHARED HTML ESCAPE (admin + tablet DRY)
// ════════════════════════════════════════
export const escHtml = esc;

// Safe escape for embedding inside a JS string literal in an HTML attribute
// (e.g. onclick="doStuff('${escJs(value)}')"). Wraps + strips the quotes.
export function escJs(s) {
  return JSON.stringify(String(s ?? '')).slice(1, -1);
}

// tierFloor removed — the `floor` field is now returned by tier() itself,
// so callers use `tier(tot).floor` instead of duplicating the ladder.
// ── Friendly error mapping (Admin + Tablet + Customer) ───────────────────────
//  Maps raw Firebase / HTTP / network errors to a natural-Greek, operator-safe
//  message. Technical detail stays in console/diagnostic logs (callers still
//  logger.warn the raw error); only the UI toast uses this. Never throws.
export function friendlyError(e) {
  const raw = (e && (e.code || e.message)) ? String(e.code || e.message) : String(e ?? '');
  const s = raw.toLowerCase();
  // Permission / auth
  if (s.includes('permission') || s.includes('insufficient') || s.includes('unauthenticated') ||
      s.includes('unauthorized') || s.includes('forbidden') || s.includes('403') || s.includes('401') ||
      s.includes('app-check') || s.includes('appcheck'))
    return 'Δεν έχετε δικαίωμα για αυτή την ενέργεια.';
  // Network / offline
  if (s.includes('network') || s.includes('failed to fetch') || s.includes('offline') ||
      s.includes('unavailable') || s.includes('load failed') || s.includes('err_'))
    return 'Δεν ήταν δυνατή η σύνδεση. Δοκιμάστε ξανά.';
  // Timeout / aborted
  if (s.includes('timeout') || s.includes('timed out') || s.includes('deadline') || s.includes('abort'))
    return 'Η ενέργεια άργησε περισσότερο από το αναμενόμενο. Δοκιμάστε ξανά.';
  // Not found
  if (s.includes('not-found') || s.includes('not found') || s.includes('404') || s.includes('no document'))
    return 'Δεν βρέθηκε το στοιχείο.';
  // Rate limit / exhausted
  if (s.includes('resource-exhausted') || s.includes('too many') || s.includes('rate') || s.includes('429'))
    return 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.';
  // Already Greek (contains Greek letters) → trust the caller's message
  if (/[Ͱ-Ͽ]/.test(raw)) return raw;
  // Generic fallback — never leak a bare English/technical string
  return 'Κάτι πήγε στραβά. Δοκιμάστε ξανά.';
}

// ── Offer validity (Europe/Athens business-day semantics) ────────────────────
// Browser mirror of functions/lib/offer-credit.js#offerRuntimeStatus — the
// server is the economic authority; this drives truthful Admin status display
// and the customer active-offers filter. Date-only offer boundaries (YYYY-MM-DD)
// are Greek business days: an offer ending 2026-09-30 is valid through all of
// 30/09 Athens and expired from 00:00 Athens on 01/10. DST-safe via Intl.
export function athensDateStr(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

export function toAthensDateStr(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? athensDateStr(ms) : null;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? athensDateStr(v > 1e12 ? v : v * 1000) : null;
  }
  if (v && typeof v.toDate === 'function') {
    try { return athensDateStr(v.toDate().getTime()); } catch (_) { return null; }
  }
  if (v && typeof v.toMillis === 'function') {
    try { return athensDateStr(v.toMillis()); } catch (_) { return null; }
  }
  return null;
}

// returns 'inactive' | 'scheduled' | 'expired' | 'active'
export function offerRuntimeStatus(offer, nowMs) {
  if (!offer || typeof offer !== 'object' || offer.active !== true) return 'inactive';
  const today = athensDateStr(typeof nowMs === 'number' ? nowMs : Date.now());
  const start = toAthensDateStr(offer.startDate);
  const end = toAthensDateStr(offer.endDate);
  if (start && today < start) return 'scheduled';
  if (end && today > end) return 'expired';
  return 'active';
}

// Greek label for an offer runtime status (Admin display).
export function offerStatusLabel(status) {
  return status === 'active' ? 'Ενεργή'
    : status === 'scheduled' ? 'Προγραμματισμένη'
      : status === 'expired' ? 'Έληξε'
        : 'Ανενεργή';
}
