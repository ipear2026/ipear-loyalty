// @vitest-environment jsdom
// ═══════════════════════════════════════════════════════════════════════════
//  L2.3B · Admin approval "frozen" regression guard (2026-09-01)
//
//  Behavioral tests for src/admin/l23a-approvals-ui.js.
//
//  These tests replicate the 21:58 UTC production incident conditions using
//  jsdom + mocked callable/AppCheck/Firestore-doc-read dependencies. They
//  prove the click handler:
//    • blocks callable dispatch when App Check is unavailable and shows
//      a visible Reload banner,
//    • surfaces visible processing/success/error banners in place,
//    • runs finally without blindly re-enabling financial actions,
//    • reconciles via a direct doc read after success/timeout,
//    • never automatically retries a financial mutation,
//    • is guarded against double-click (exactly one dispatch),
//    • preserves in-flight processing state across queue re-renders,
//    • maps unauthenticated / permission-denied to the reload banner.
//
//  These are NOT regex/grep tests. They exercise the real click handler
//  via jsdom events with mocked dependencies.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import must come AFTER a placeholder window setup — jsdom is already
// active per // @vitest-environment jsdom, but the module reads
// window._appCheckReady at first click so we don't need to set it up here.
import {
  startL23aApprovalListener,
  stopL23aApprovalListener,
  __setDepsForTest,
  __resetStateForTest,
} from '../src/admin/l23a-approvals-ui.js';

const TARGET_ID = 'l23a-approvals-list';
const BADGE_ID  = 'l23a-approvals-badge';

// A canonical pending row the UI would receive from the queue snapshot.
function makeRow(overrides = {}) {
  return {
    id: 'req_test1234567890abcdef',
    type: 'redeem',
    rewardLabel: 'Test Reward',
    rewardCost: 100,
    storeId: 'store_1',
    customerId: 'cust_ABCDEF12345',
    requestedAt: new Date(Date.now() - 3000).toISOString(),
    requestedAtTs: { toMillis: () => Date.now() - 3000 },
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    expiresAtTs: { toMillis: () => Date.now() + 5 * 60_000 },
    ...overrides,
  };
}

// Test harness — controls the queue snapshot delivery + AppCheck + callable
// + reconcileRequest, and captures how many times each is invoked.
function buildHarness({ appCheckReady, approve, reject, reconcile } = {}) {
  const state = { rows: [], listener: null };
  const calls = {
    approveCalls: 0,
    rejectCalls: 0,
    reconcileCalls: 0,
    lastApproveArg: null,
    lastRejectArg: null,
  };
  __setDepsForTest({
    approveRedemption: async (id) => {
      calls.approveCalls++; calls.lastApproveArg = id;
      return approve ? await approve(id) : { alreadyProcessed: false, status: 'approved', newPoints: 400, ledgerId: 'ledger_x' };
    },
    rejectRedemption: async (id, reason) => {
      calls.rejectCalls++; calls.lastRejectArg = { id, reason };
      return reject ? await reject(id, reason) : { alreadyProcessed: false, status: 'rejected' };
    },
    subscribeToPendingQueue: ({ onChange }) => {
      state.listener = onChange;
      queueMicrotask(() => onChange(state.rows));
      return () => { state.listener = null; };
    },
    appCheckReady: (ms) => (appCheckReady ? appCheckReady(ms) : Promise.resolve('ready')),
    reconcileRequest: async (id) => {
      calls.reconcileCalls++;
      return reconcile ? await reconcile(id) : { status: 'approved', newPoints: 400 };
    },
    now: () => Date.now(),
    prompt: () => '',
  });
  return {
    calls,
    pushSnapshot(rows) {
      state.rows = rows;
      state.listener?.(rows);
    },
  };
}

function mountDom() {
  document.body.innerHTML = `
    <span id="${BADGE_ID}" style="display:none">0</span>
    <div id="${TARGET_ID}"></div>
  `;
}

function findRowButton(requestId, action) {
  return document.querySelector(`[data-request-id="${requestId}"] button[data-l23a-action="${action}"]`);
}

function getRowBanner(requestId) {
  const row = document.querySelector(`[data-request-id="${requestId}"]`);
  if (!row) return null;
  const banner = row.querySelector('[data-l23a-banner]');
  return banner ? { kind: banner.getAttribute('data-l23a-banner'), text: banner.textContent.trim() } : null;
}

async function flush(ms = 0) {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  mountDom();
  __resetStateForTest(); // clear module-level busy/banner state
  // Default: App Check ready.
  window._appCheckReady = () => Promise.resolve('ready');
  window._appCheckStatus = 'ready';
});

afterEach(() => {
  stopL23aApprovalListener();
  __resetStateForTest();
  __setDepsForTest({ reconcileRequest: null }); // reset injected dep
  vi.useRealTimers();
});

describe('L2.3B · admin approval click handler — behavioral', () => {
  it('1. App Check ready → dispatches exactly one callable request', async () => {
    const H = buildHarness();
    startL23aApprovalListener({});
    H.pushSnapshot([makeRow()]);
    await flush();

    const btn = findRowButton('req_test1234567890abcdef', 'approve');
    expect(btn, 'approve button rendered').toBeTruthy();
    btn.click();
    await flush(20);

    expect(H.calls.approveCalls).toBe(1);
    expect(H.calls.lastApproveArg).toBe('req_test1234567890abcdef');
  });

  it('2. App Check unavailable → zero callable requests, visible Reload banner', async () => {
    const H = buildHarness({
      appCheckReady: () => Promise.reject(new Error('appcheck-not-ready:failed')),
    });
    startL23aApprovalListener({});
    H.pushSnapshot([makeRow()]);
    await flush();

    findRowButton('req_test1234567890abcdef', 'approve').click();
    await flush(20);

    expect(H.calls.approveCalls).toBe(0);
    const b = getRowBanner('req_test1234567890abcdef');
    expect(b).toBeTruthy();
    expect(b.kind).toBe('reload');
    expect(b.text).toMatch(/App Check|ξαναφόρτωσε/i);
    // A Reload button must be present.
    const reloadBtn = document.querySelector('button[data-l23a-action="reload"]');
    expect(reloadBtn).toBeTruthy();
  });

  it('3. Callable success → processing → reconciled final state banner', async () => {
    // Delay the mock so the processing state is observable synchronously
    // after the click (would otherwise resolve inside the same microtask).
    const H = buildHarness({
      approve: () => new Promise((r) => setTimeout(() => r(
        { alreadyProcessed: false, status: 'approved', newPoints: 400, ledgerId: 'lg' }
      ), 30)),
      reconcile: async () => ({ status: 'approved', newPoints: 400 }),
    });
    startL23aApprovalListener({});
    H.pushSnapshot([makeRow()]);
    await flush();

    findRowButton('req_test1234567890abcdef', 'approve').click();
    // Processing banner must appear immediately (synchronous lock).
    await flush(0);
    const proc = getRowBanner('req_test1234567890abcdef');
    expect(proc?.kind).toBe('processing');

    // Let the callable resolve.
    await flush(60);
    const done = getRowBanner('req_test1234567890abcdef');
    expect(done?.kind).toBe('success');
    expect(done.text).toMatch(/Εγκρίθηκε.*400/);
  });

  it('4. unauthenticated → visible error banner, no permanent disabled UI', async () => {
    const H = buildHarness({
      approve: async () => { const e = new Error('unauth'); e.code = 'functions/unauthenticated'; throw e; },
    });
    startL23aApprovalListener({});
    H.pushSnapshot([makeRow()]);
    await flush();

    findRowButton('req_test1234567890abcdef', 'approve').click();
    await flush(20);

    const b = getRowBanner('req_test1234567890abcdef');
    expect(b?.kind).toBe('reload');    // unauth → reload banner
    expect(b.text).toMatch(/App Check|ξαναφόρτωσε/i);
    // Ensure NO row anywhere has a disabled button dangling — the actions
    // area has been replaced by the banner.
    expect(document.querySelector('button[data-l23a-action="approve"]:disabled')).toBeFalsy();
  });

  it('5. permission-denied → visible diagnostic (reload)', async () => {
    const H = buildHarness({
      approve: async () => { const e = new Error('denied'); e.code = 'functions/permission-denied'; throw e; },
    });
    startL23aApprovalListener({});
    H.pushSnapshot([makeRow()]);
    await flush();

    findRowButton('req_test1234567890abcdef', 'approve').click();
    await flush(20);

    const b = getRowBanner('req_test1234567890abcdef');
    expect(b?.kind).toBe('reload');
    expect(b.text).toMatch(/App Check|ξαναφόρτωσε/i);
  });

  it('6. timeout while request stays pending → safe explicit Retry after reconciliation', async () => {
    vi.useFakeTimers();
    const H = buildHarness({
      approve: () => new Promise(() => { /* never resolves */ }),
      reconcile: async () => ({ status: 'pending' }), // server never committed
    });
    startL23aApprovalListener({});
    H.pushSnapshot([makeRow()]);
    await vi.advanceTimersByTimeAsync(1);

    findRowButton('req_test1234567890abcdef', 'approve').click();
    await vi.advanceTimersByTimeAsync(1);
    // processing shown
    expect(getRowBanner('req_test1234567890abcdef')?.kind).toBe('processing');
    // Fire the 30s callable timeout.
    await vi.advanceTimersByTimeAsync(30_000);
    // Then the 3s reconciliation delay.
    await vi.advanceTimersByTimeAsync(3_100);
    // Reconciliation ran exactly once, showed the "did not execute — retry" banner.
    expect(H.calls.reconcileCalls).toBe(1);
    const b = getRowBanner('req_test1234567890abcdef');
    expect(b?.kind).toBe('error');
    expect(b.text).toMatch(/Δεν εκτελέστηκε|retry/i);
    // A Retry button was added — explicit operator action required.
    const retryBtn = document.querySelector(`[data-request-id="req_test1234567890abcdef"] button[data-l23a-action="approve"]`);
    expect(retryBtn?.textContent).toMatch(/Retry/);
    // Critically: NO auto-retry has fired — approveCalls still 1.
    expect(H.calls.approveCalls).toBe(1);
  });

  it('7. timeout AFTER server commit → reconcile detects approved, no retry', async () => {
    vi.useFakeTimers();
    const H = buildHarness({
      approve: () => new Promise(() => {}), // callable hangs (client sees timeout)
      reconcile: async () => ({ status: 'approved', newPoints: 400 }), // server DID commit
    });
    startL23aApprovalListener({});
    H.pushSnapshot([makeRow()]);
    await vi.advanceTimersByTimeAsync(1);

    findRowButton('req_test1234567890abcdef', 'approve').click();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(3_100);

    expect(H.calls.reconcileCalls).toBe(1);
    // No retry attempted.
    expect(H.calls.approveCalls).toBe(1);
    const b = getRowBanner('req_test1234567890abcdef');
    expect(b?.kind).toBe('success');
    expect(b.text).toMatch(/Εγκρίθηκε.*400/);
  });

  it('8. double-click → exactly one callable invocation', async () => {
    const H = buildHarness({
      approve: () => new Promise((r) => setTimeout(() => r({ alreadyProcessed: false, status: 'approved', newPoints: 400 }), 50)),
    });
    startL23aApprovalListener({});
    H.pushSnapshot([makeRow()]);
    await flush();

    const btn = findRowButton('req_test1234567890abcdef', 'approve');
    btn.click();
    btn.click();
    btn.click();
    btn.click();
    await flush(80);

    expect(H.calls.approveCalls).toBe(1);
  });

  it('9. queue re-render during in-flight request preserves processing state', async () => {
    vi.useFakeTimers();
    const H = buildHarness({
      approve: () => new Promise(() => {}),
    });
    startL23aApprovalListener({});
    H.pushSnapshot([makeRow()]);
    await vi.advanceTimersByTimeAsync(1);

    findRowButton('req_test1234567890abcdef', 'approve').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(getRowBanner('req_test1234567890abcdef')?.kind).toBe('processing');

    // Snapshot rebuilds the queue (e.g. a new pending row arrives).
    H.pushSnapshot([makeRow(), makeRow({ id: 'req_second_9876543210xyz' })]);
    await vi.advanceTimersByTimeAsync(1);

    // The busy row must STILL show processing (busy state carried across rebuild).
    expect(getRowBanner('req_test1234567890abcdef')?.kind).toBe('processing');
    // The new row shows normal approve/reject buttons.
    expect(findRowButton('req_second_9876543210xyz', 'approve')).toBeTruthy();
    // The busy row must NOT expose an approve/reject button.
    expect(findRowButton('req_test1234567890abcdef', 'approve')).toBeFalsy();
    expect(findRowButton('req_test1234567890abcdef', 'reject')).toBeFalsy();
  });

  it('10. success never re-enables approval on an already-processed request', async () => {
    const H = buildHarness({
      approve: async () => ({ alreadyProcessed: false, status: 'approved', newPoints: 400 }),
      reconcile: async () => ({ status: 'approved', newPoints: 400 }),
    });
    startL23aApprovalListener({});
    H.pushSnapshot([makeRow()]);
    await flush();

    findRowButton('req_test1234567890abcdef', 'approve').click();
    await flush(20);

    // The row shows the success banner and the row's actions area is the
    // banner, NOT approve/reject buttons.
    expect(getRowBanner('req_test1234567890abcdef')?.kind).toBe('success');
    expect(findRowButton('req_test1234567890abcdef', 'approve')).toBeFalsy();
    expect(findRowButton('req_test1234567890abcdef', 'reject')).toBeFalsy();
  });

  it('13. no automatic financial retry — timeout path leaves approveCalls==1', async () => {
    vi.useFakeTimers();
    const H = buildHarness({
      approve: () => new Promise(() => {}),
      reconcile: async () => ({ status: 'pending' }),
    });
    startL23aApprovalListener({});
    H.pushSnapshot([makeRow()]);
    await vi.advanceTimersByTimeAsync(1);
    findRowButton('req_test1234567890abcdef', 'approve').click();
    // Let TWO full timeout cycles pass — proving no auto-retry.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(H.calls.approveCalls).toBe(1);
    // Reconciliation still ran exactly once (from the first timeout).
    expect(H.calls.reconcileCalls).toBe(1);
  });
});

// ── Tablet-side expiry tests (source-level: authoritative expiresAt) ────
// The tablet's expiry logic is guarded by structural source assertions on
// tablet-main.js because tablet-main.js is a large orchestration module
// with heavy jsdom setup requirements. We check the invariants the review
// required: no invented client timeout, uses expiresAt from server.
import fs from 'node:fs';
import path from 'node:path';

const TABLET_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'tablet-main.js'), 'utf8'
);

describe('L2.3B · tablet expiry — uses authoritative server expiresAt', () => {
  it('11. tablet no longer uses the invented _REQUEST_UI_TIMEOUT_MS constant', () => {
    expect(TABLET_SRC).not.toMatch(/_REQUEST_UI_TIMEOUT_MS\s*=/);
  });

  it('11. tablet schedules expiry using the authoritative expiresAt field', () => {
    expect(TABLET_SRC).toMatch(/_scheduleExpiryFlip\s*\(/);
    // Called with res.expiresAt (from createRedemptionRequest) or cRes.expiresAt
    // (from createRedemptionRequestFromCard) — never a hardcoded ms literal.
    expect(TABLET_SRC).toMatch(/_scheduleExpiryFlip\(res\.expiresAt/);
    expect(TABLET_SRC).toMatch(/_scheduleExpiryFlip\(cRes\.expiresAt/);
  });

  it('12. expired modal offers admin-check messaging + closable-locally hint', () => {
    // The expired branch renders the "check admin queue or close" text
    // when needsAdminCheck is set — i.e. the local timer fired without a
    // server-side terminal event.
    expect(TABLET_SRC).toMatch(/needsAdminCheck/);
    expect(TABLET_SRC).toMatch(/έλεγξε την ουρά του Admin|κλείσε αυτό το παράθυρο/);
  });

  it('13. tablet has NO auto-retry / auto-recreate of a financial mutation', () => {
    // No setInterval or automatic re-invocation of createRedemptionRequest*.
    expect(TABLET_SRC).not.toMatch(/setInterval\([^,]*createRedemptionRequest/);
    // Confirm neither of the two request-creating callables is invoked from
    // inside the expiry-flip scheduler function.
    const expiryFn = TABLET_SRC.match(/function _scheduleExpiryFlip[\s\S]+?\n\}\n/);
    expect(expiryFn, '_scheduleExpiryFlip helper present').toBeTruthy();
    expect(expiryFn[0]).not.toMatch(/createRedemptionRequest/);
  });
});
