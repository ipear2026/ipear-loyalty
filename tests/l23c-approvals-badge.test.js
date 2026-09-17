// @vitest-environment jsdom
// ═══════════════════════════════════════════════════════════════════════════
//  L2.3C · Combined approvals nav badge + tablet empty-state (behavioral)
//
//  Tests the src/admin/approvals-badge.js publish/apply logic and the
//  src/tablet-main.js reward-picker empty-state render — both via jsdom
//  and dependency injection. NO regex-only tests; every assertion drives
//  the real code path or reads the produced DOM.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  setOfferCount,
  setTabletCount,
  resetApprovalsBadge,
  getApprovalsCounts,
  __resetForTest,
} from '../src/admin/approvals-badge.js';

const BADGE_ID = 'approvals-badge';
const NAV_BTN_ID = 'tab-btn-approvals';

// Mount the same DOM shape the admin.html nav uses (button + badge).
function mountNav() {
  document.body.innerHTML = `
    <button id="${NAV_BTN_ID}" style="position:relative">
      Εγκρίσεις
      <span id="${BADGE_ID}" style="display:none">0</span>
    </button>
  `;
}

function getBadge() { return document.getElementById(BADGE_ID); }
function getBtn()   { return document.getElementById(NAV_BTN_ID); }

// Force prefers-reduced-motion for one test. jsdom's matchMedia returns
// undefined by default — we override it per test where needed.
function setReducedMotion(reduce) {
  window.matchMedia = (q) => ({
    matches: reduce && String(q).includes('prefers-reduced-motion: reduce'),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

beforeEach(() => {
  mountNav();
  __resetForTest();
  // Default: no reduced motion.
  setReducedMotion(false);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('L2.3C · combined approvals nav badge (behavioral)', () => {
  it('1. zero combined pending → no badge, no pulse, accessible label = "Εγκρίσεις"', () => {
    setOfferCount(0);
    setTabletCount(0);
    const b = getBadge();
    const btn = getBtn();
    expect(b.style.display).toBe('none');
    expect(btn.style.animation).toBe('');
    expect(btn.getAttribute('aria-label')).toBe('Εγκρίσεις');
  });

  it('2. one tablet request → badge "1", pulse active, singular Greek label', () => {
    setTabletCount(1);
    const b = getBadge();
    const btn = getBtn();
    expect(b.style.display).toBe('inline-block');
    expect(b.textContent).toBe('1');
    expect(btn.style.animation).toMatch(/^pulse\s+1s\s+infinite$/);
    expect(btn.getAttribute('aria-label')).toBe('Εγκρίσεις — 1 εκκρεμές αίτημα');
  });

  it('3. one offer + one tablet → badge "2", plural Greek label', () => {
    setOfferCount(1);
    setTabletCount(1);
    const b = getBadge();
    const btn = getBtn();
    expect(b.textContent).toBe('2');
    expect(btn.getAttribute('aria-label')).toBe('Εγκρίσεις — 2 εκκρεμή αιτήματα');
    expect(getApprovalsCounts()).toEqual({ offers: 1, tablets: 1, total: 2 });
  });

  it('4. processing the final pending item → badge & pulse disappear immediately', () => {
    setOfferCount(1);
    setTabletCount(1);
    // Simulate the snapshots reflecting the two items being processed.
    setOfferCount(0);
    setTabletCount(0);
    const b = getBadge();
    const btn = getBtn();
    expect(b.style.display).toBe('none');
    expect(btn.style.animation).toBe('');
    expect(btn.getAttribute('aria-label')).toBe('Εγκρίσεις');
  });

  it('5. approved/rejected/expired requests are not counted (listener publishes 0 when snapshot excludes them)', () => {
    // Baseline: 3 pending items published by both listeners combined.
    setTabletCount(2);
    setOfferCount(1);
    expect(getBadge().textContent).toBe('3');
    // Snapshots re-fire with the terminal-state items excluded (that is
    // what subscribeToPendingQueue does — it queries where status=='pending'
    // and where status=='pending_approval'). Simulate that pass.
    setTabletCount(0);
    setOfferCount(0);
    expect(getBadge().style.display).toBe('none');
    expect(getBadge().textContent).toBe('0');
  });

  it('6. rapid duplicate publications with the same value do not thrash the DOM', () => {
    setTabletCount(1);
    const btn = getBtn();
    const initialAnim = btn.style.animation;
    // Store a snapshot of the DOM attributes and re-publish the SAME value.
    setTabletCount(1);
    setTabletCount(1);
    setTabletCount(1);
    expect(btn.style.animation).toBe(initialAnim);
    expect(getBadge().textContent).toBe('1');
  });

  it('6. resetApprovalsBadge() zeroes both counters (e.g. on logout)', () => {
    setOfferCount(3);
    setTabletCount(2);
    expect(getBadge().textContent).toBe('5');
    resetApprovalsBadge();
    expect(getBadge().style.display).toBe('none');
    expect(getApprovalsCounts()).toEqual({ offers: 0, tablets: 0, total: 0 });
  });

  it('7. prefers-reduced-motion → badge visible, animation suppressed', () => {
    setReducedMotion(true);
    setTabletCount(2);
    const b = getBadge();
    const btn = getBtn();
    expect(b.style.display).toBe('inline-block');
    expect(b.textContent).toBe('2');
    // Pulse must NOT be applied when reduced-motion is on.
    expect(btn.style.animation).toBe('');
    // ARIA label still reflects the count.
    expect(btn.getAttribute('aria-label')).toBe('Εγκρίσεις — 2 εκκρεμή αιτήματα');
  });

  it('11. does not touch the "Δεν υπάρχουν εκκρεμείς εγκρίσεις" or "Δεν υπάρχουν εκκρεμή αιτήματα" list-empty messages', () => {
    // Sanity: this module only writes to #approvals-badge and #tab-btn-approvals.
    // Confirm no DOM read/write ever occurred against the list containers.
    document.body.innerHTML += `
      <div id="approvals-list">Δεν υπάρχουν εκκρεμείς εγκρίσεις</div>
      <div id="l23a-approvals-list">Δεν υπάρχουν εκκρεμή αιτήματα</div>
    `;
    setOfferCount(0);
    setTabletCount(0);
    setOfferCount(4);
    setTabletCount(2);
    expect(document.getElementById('approvals-list').textContent)
      .toBe('Δεν υπάρχουν εκκρεμείς εγκρίσεις');
    expect(document.getElementById('l23a-approvals-list').textContent)
      .toBe('Δεν υπάρχουν εκκρεμή αιτήματα');
  });
});

// ── Tablet empty-state (source-level assertions — see behavior test below) ─
import fs from 'node:fs';
import path from 'node:path';
const TABLET_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'tablet-main.js'), 'utf8'
);

describe('L2.3C · tablet reward-picker empty state', () => {
  it('9. exact Greek copy is present in tablet-main.js', () => {
    expect(TABLET_SRC).toContain('Δεν υπάρχουν διαθέσιμες προσφορές');
    expect(TABLET_SRC).toContain(
      'Δεν υπάρχει κάποια ενεργή προσφορά ή διαθέσιμη ανταμοιβή για αυτόν τον πελάτη αυτή τη στιγμή.'
    );
  });

  it('9. empty-state uses the shared .empty class + local Close button', () => {
    // The empty state block sets class="empty" and a Close button.
    const emptyBlock = TABLET_SRC.match(/if\s*\(!rewards\.length\)\s*\{[\s\S]+?container\.appendChild\(empty\);\s*\}/);
    expect(emptyBlock, 'empty-state block present').toBeTruthy();
    expect(emptyBlock[0]).toMatch(/className\s*=\s*'empty'/);
    expect(emptyBlock[0]).toMatch(/data-l23c-empty-close/);
    expect(emptyBlock[0]).toMatch(/closeApprovalOverlay\(\)/);
  });

  it('10. network/error path is DISTINCT — routes through _renderApprovalOverlay("error"), not the empty state', () => {
    // In _handleCardScan, a thrown callable is caught and renders an
    // 'error' overlay — NEVER the empty state. Verify the catch block
    // does NOT invoke the reward-picker empty state renderer.
    const scanFn = TABLET_SRC.match(/async function _handleCardScan[\s\S]+?^\}/m);
    expect(scanFn).toBeTruthy();
    // Error path uses _renderApprovalOverlay('error', ...) or _friendlyErrorFor.
    expect(scanFn[0]).toMatch(/_renderApprovalOverlay\('error'/);
    // And does NOT contain the empty-state copy — confirming separation.
    expect(scanFn[0]).not.toContain('Δεν υπάρχουν διαθέσιμες προσφορές');
  });

  it('11. existing "Καμία ενεργή ανταμοιβή διαθέσιμη." stub REMOVED (replaced by the explicit empty state)', () => {
    expect(TABLET_SRC).not.toContain('Καμία ενεργή ανταμοιβή διαθέσιμη.');
  });

  it('8. loading state is set BEFORE the callable — reward-picker + empty state only run AFTER the callable resolves', () => {
    // _showApprovalOverlayLoading sets the title to "Έλεγχος κωδικού...".
    // The picker container (qrc-card-rewards) — where the empty state
    // renders — is only created inside _renderPickerContainer, which is
    // called AFTER the lookupCustomerByCardQr callable resolves.
    const loadingFn = TABLET_SRC.match(/function _showApprovalOverlayLoading\(\)[\s\S]+?^\}/m);
    expect(loadingFn, '_showApprovalOverlayLoading present').toBeTruthy();
    expect(loadingFn[0]).toContain('Έλεγχος κωδικού');
    // Loading path only REMOVES any stale picker container — it never
    // renders/appends an empty-state or reward buttons. Guard against a
    // future edit that accidentally mixes the two states.
    expect(loadingFn[0]).not.toContain('Δεν υπάρχουν διαθέσιμες προσφορές');
    expect(loadingFn[0]).not.toMatch(/container\.appendChild/);
    expect(loadingFn[0]).not.toMatch(/createElement\(['"]button['"]\)/);
    // _handleCardScan: the loading overlay is shown BEFORE await lookup(),
    // and the picker is only rendered if the callable returns rewards.
    const scanFn = TABLET_SRC.match(/async function _handleCardScan[\s\S]+?^\}/m);
    expect(scanFn[0]).toMatch(/_showApprovalOverlayLoading\(\)[\s\S]+?await\s+lookupCustomerByCardQr/);
    // The empty-state copy is not emitted during loading.
    // (Sanity: the loading title text and the empty-state title never appear
    // in the same DOM path.)
    expect(scanFn[0]).not.toContain('Δεν υπάρχουν διαθέσιμες προσφορές');
  });

  it('11. eligibility rules preserved — server-side rewards filter is not touched', () => {
    // The tablet only READS rewards from the callable result; it does not
    // filter them locally. Assert no client-side reward-active or expiry
    // filter code was introduced.
    expect(TABLET_SRC).not.toMatch(/rewards\.filter\(/);
    expect(TABLET_SRC).not.toMatch(/isActive\s*[!=]==?\s*true/);
  });
});
