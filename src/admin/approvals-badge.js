// ═══════════════════════════════════════════════════════════════════════════
//  L2.3C · Combined approvals nav badge + pulse animator.
//
//  Two independent real-time queues contribute to the top-nav "Εγκρίσεις"
//  badge:
//    (1) src/admin/approvals.js         → pending offer approvals
//    (2) src/admin/l23a-approvals-ui.js → pending tablet redemption requests
//
//  Each listener publishes its current count via setOfferCount / setTabletCount.
//  This module owns the DOM writes on:
//    - #approvals-badge  (numeric badge, position:absolute in admin.html nav)
//    - #tab-btn-approvals (the nav button — pulse animation on it)
//
//  Uses the EXISTING iPear pulse keyframe (`pulse 1s infinite`, defined in
//  src/styles/admin.css) — no new animation, no new colour. Respect for
//  prefers-reduced-motion is inherited from the global rule in admin.css
//  that already neutralizes every animation to 0.01ms; the badge itself
//  stays visible regardless (accessibility: numeric count is the primary
//  signal, animation is only a secondary attention cue).
//
//  aria-label matches the pending count so screen readers announce it
//  correctly (e.g. "Εγκρίσεις — 3 εκκρεμή αιτήματα").
// ═══════════════════════════════════════════════════════════════════════════

const BADGE_ID = 'approvals-badge';
const NAV_BTN_ID = 'tab-btn-approvals';
const PULSE_STYLE = 'pulse 1s infinite';

let _offerCount  = 0;
let _tabletCount = 0;

function _prefersReducedMotion() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
}

function _plural(n) {
  return n === 1 ? '1 εκκρεμές αίτημα' : `${n} εκκρεμή αιτήματα`;
}

function _apply() {
  const total = _offerCount + _tabletCount;
  const badge = (typeof document !== 'undefined') ? document.getElementById(BADGE_ID) : null;
  const btn   = (typeof document !== 'undefined') ? document.getElementById(NAV_BTN_ID) : null;

  if (badge) {
    if (total > 0) {
      badge.style.display = 'inline-block';
      badge.textContent = String(total);
    } else {
      badge.style.display = 'none';
      badge.textContent = '0';
    }
  }
  if (btn) {
    const shouldPulse = total > 0 && !_prefersReducedMotion();
    // Assigning to inline style.animation — same shape as the pre-L2.3C code
    // used in src/admin/approvals.js. Setting to empty string stops it
    // immediately (element inherits no other animation on this class).
    btn.style.animation = shouldPulse ? PULSE_STYLE : '';
    // Accessible label — always reflects the actual count so screen readers
    // announce state changes as the count updates.
    btn.setAttribute(
      'aria-label',
      total > 0 ? `Εγκρίσεις — ${_plural(total)}` : 'Εγκρίσεις'
    );
    // Live region so assistive tech picks up count changes without a full
    // page-navigation event. Politely — not assertively.
    btn.setAttribute('aria-live', 'polite');
  }
}

export function setOfferCount(n) {
  _offerCount = Math.max(0, Number(n) || 0);
  _apply();
}

export function setTabletCount(n) {
  _tabletCount = Math.max(0, Number(n) || 0);
  _apply();
}

// Convenience: reset both counts. Called on admin logout / re-init so a
// residual banner from a previous session cannot linger.
export function resetApprovalsBadge() {
  _offerCount  = 0;
  _tabletCount = 0;
  _apply();
}

// Read-only accessor for tests + diagnostics.
export function getApprovalsCounts() {
  return { offers: _offerCount, tablets: _tabletCount, total: _offerCount + _tabletCount };
}

// Test-only hook — resets internal counters without touching the DOM.
export function __resetForTest() {
  _offerCount  = 0;
  _tabletCount = 0;
}
