// ═══════════════════════════════════════════════════════════════════════════
//  L2.3A · Admin approval-queue UI (live pending → approve/reject).
//
//  Renders into #l23a-approvals-list. Uses the callable wrappers in
//  src/admin/approval-queue.js which are the only supported approve/reject
//  path under the L2.3A rules.
//
//  L2.3B hardening (2026-09-01) — root cause of 21:58 UTC "frozen" incident
//  was a stale admin tab dispatching approveRedemption callables with
//  `X-Firebase-AppCheck: MISSING`. The framework rejected all 4 attempts
//  with HTTP 401 and no handler ran. Hardening rules applied:
//    1. Pre-flight `await window._appCheckReady()`; on failure show visible
//       reload banner and DO NOT dispatch the callable.
//    2. Inline visible processing / success / error / reload banners —
//       do NOT depend on a global `_adminToast` that may not be wired.
//    3. try/catch/finally, but NEVER blindly re-enable financial actions on
//       success. Row waits for the snapshot to reconcile; if the snapshot
//       hasn't fired within a short window, force a direct doc read and
//       render the actual server state.
//    4. Bounded client timeout (30 s). On timeout: reconcile via direct
//       doc read; NEVER auto-retry a financial mutation.
//    5. Preserve busy/banner state across snapshot re-renders (`_busyIds`
//       + `_bannerById` carried across rebuilds).
//    6. Map `unauthenticated` / `permission-denied` errors to the reload
//       banner because both are the App-Check-header-missing symptom.
//    7. Never expose tokens/secrets via UI or logs.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../logger.js';
import { escHtml } from '../utils.js';
import {
  subscribeToPendingQueue,
  approveRedemption,
  rejectRedemption,
} from './approval-queue.js';
import { setTabletCount } from './approvals-badge.js';

const TARGET_ID = 'l23a-approvals-list';
const BADGE_ID = 'l23a-approvals-badge';
const CALLABLE_TIMEOUT_MS = 30_000;
const RECONCILE_DELAY_MS = 3_000;

let _unsub = null;
const _busyIds = new Set();
// bannerById: requestId → { kind: 'processing'|'success'|'error'|'reload', text: string }
const _bannerById = new Map();

// Injected dependencies for tests (Vitest with jsdom overrides these).
const _deps = {
  approveRedemption,
  rejectRedemption,
  subscribeToPendingQueue,
  // appCheckReady returns Promise<'ready'> or rejects.
  appCheckReady: (ms) =>
    (typeof window !== 'undefined' && typeof window._appCheckReady === 'function')
      ? window._appCheckReady(ms)
      : Promise.resolve('ready'),
  // reconcileRequest(id) → { status, newPoints?, rejectReason? } or throws
  reconcileRequest: null, // wired at first use — see _reconcileOnce
  now: () => Date.now(),
  prompt: (msg, def) => window.prompt(msg, def),
};

// Exported hook for unit tests only. NEVER used in production code paths.
export function __setDepsForTest(overrides) {
  Object.assign(_deps, overrides || {});
}

// Test-only reset of module-level busy/banner state.
export function __resetStateForTest() {
  _busyIds.clear();
  _bannerById.clear();
  if (_unsub) { try { _unsub(); } catch (_) {} _unsub = null; }
}

export function startL23aApprovalListener({ storeId = null } = {}) {
  stopL23aApprovalListener();
  _unsub = _deps.subscribeToPendingQueue({
    storeId,
    onChange: (rows, err) => {
      if (err) logger.warn('[l23a-approvals] listener error:', err?.code || err?.message);
      _render(rows);
      _updateBadge(rows.length);
      // Publish the tablet-requests count into the combined nav badge.
      // The offer-approvals listener publishes its own count via
      // setOfferCount; the badge module sums them.
      setTabletCount(rows.length);
    },
  });
}

export function stopL23aApprovalListener() {
  if (_unsub) { try { _unsub(); } catch (_) {} _unsub = null; }
  // Zero the tablet count so a stale count from a previous session doesn't
  // outlive its listener (logout / auth switch / re-init).
  setTabletCount(0);
}

function _updateBadge(n) {
  const el = document.getElementById(BADGE_ID);
  if (!el) return;
  if (n > 0) { el.style.display = 'inline-block'; el.textContent = String(n); }
  else { el.style.display = 'none'; }
}

// Rebuild the queue DOM. Preserves any in-flight processing/banner state
// for rows whose id is still busy or has a pending banner. Rows that have
// disappeared from the snapshot (terminal state on the server) have their
// banner dropped too — no stale UI.
function _render(rows) {
  const el = document.getElementById(TARGET_ID);
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="empty" style="opacity:.6;padding:16px;text-align:center">Δεν υπάρχουν εκκρεμή αιτήματα</div>';
    // Rows now gone are terminal on the server; clear their busy/banner state.
    _busyIds.clear();
    _bannerById.clear();
    return;
  }
  const idsInSnapshot = new Set(rows.map((r) => r.id));
  // Drop banners for ids no longer in the pending queue — those requests
  // reached a terminal server state (approved/rejected/expired) and the row
  // will be re-rendered as absent below.
  for (const id of [..._bannerById.keys()]) {
    if (!idsInSnapshot.has(id)) _bannerById.delete(id);
  }
  for (const id of [..._busyIds]) {
    if (!idsInSnapshot.has(id)) _busyIds.delete(id);
  }
  el.innerHTML = rows.map((r) => _renderRow(r)).join('');
  el.onclick = _onClick;
}

function _renderRow(r) {
  const now = _deps.now();
  const requestedAtMs =
    r.requestedAtTs?.toMillis?.() ??
    (r.requestedAt ? new Date(r.requestedAt).getTime() : now);
  const agoSec = Math.max(0, Math.round((now - requestedAtMs) / 1000));
  const agoStr = agoSec < 60 ? `${agoSec} δευτ.` : `${Math.round(agoSec / 60)} λεπτά`;

  const expMs =
    r.expiresAtTs?.toMillis?.() ??
    (r.expiresAt ? new Date(r.expiresAt).getTime() : now + 60_000);
  const remainSec = Math.max(0, Math.round((expMs - now) / 1000));
  const remainStr = remainSec > 60 ? `${Math.round(remainSec / 60)}λ` : `${remainSec}δ`;

  const cost = Number(r.rewardCost || 0);
  const costStr = cost > 0
    ? `−${cost} πόντοι`
    : cost < 0
      ? `+${-cost} πόντοι bonus`
      : '';
  const typeIcon = r.type === 'offer_credit' ? '🎁' : '💳';
  const busy = _busyIds.has(r.id);
  const banner = _bannerById.get(r.id) || null;

  const custHint = r.customerId ? String(r.customerId).slice(0, 6) + '…' : '';

  // Actions area: either the two buttons OR a processing indicator
  // (busy=true) OR a persistent banner (result/reload/error).
  let actionsHtml;
  if (banner && banner.kind === 'processing') {
    actionsHtml = `<div data-l23a-banner="processing" style="display:flex;align-items:center;gap:8px;color:#8ae900;font-weight:800">
      <span style="display:inline-block;width:14px;height:14px;border:2px solid #8ae900;border-top-color:transparent;border-radius:50%;animation:l23a-spin 0.9s linear infinite"></span>
      ${escHtml(banner.text || 'Επεξεργασία…')}
    </div>`;
  } else if (banner && (banner.kind === 'success' || banner.kind === 'error' || banner.kind === 'reload')) {
    const bg = banner.kind === 'success' ? '#8ae900' : (banner.kind === 'reload' ? '#ff9500' : '#ff3b30');
    const fg = banner.kind === 'success' ? '#0a0a0a' : '#fff';
    const reloadBtn = banner.kind === 'reload'
      ? ` <button data-l23a-action="reload" style="margin-left:8px;padding:6px 10px;background:#fff;color:#111;border:none;border-radius:8px;font-weight:800;cursor:pointer;font-family:inherit">↻ Reload</button>`
      : '';
    actionsHtml = `<div data-l23a-banner="${escHtml(banner.kind)}" style="padding:8px 12px;background:${bg};color:${fg};border-radius:10px;font-weight:800;font-size:.86rem;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(banner.text || '')}${reloadBtn}</div>`;
  } else {
    actionsHtml = `<div style="display:flex;gap:8px;flex-shrink:0">
      <button data-l23a-action="approve" ${busy ? 'disabled' : ''} style="padding:12px 18px;background:#8ae900;color:#0a0a0a;border:none;border-radius:10px;font-weight:800;font-size:.86rem;cursor:${busy ? 'wait' : 'pointer'};font-family:inherit;opacity:${busy ? 0.5 : 1}">✅ Έγκριση</button>
      <button data-l23a-action="reject" ${busy ? 'disabled' : ''} style="padding:12px 14px;background:rgba(255,59,48,.15);color:#ff3b30;border:1px solid #ff3b30;border-radius:10px;font-weight:700;font-size:.86rem;cursor:${busy ? 'wait' : 'pointer'};font-family:inherit;opacity:${busy ? 0.5 : 1}">✕ Απόρριψη</button>
    </div>`;
  }

  return `<div data-request-id="${escHtml(r.id)}" style="background:#111;border:1.5px solid #8ae900;border-radius:14px;padding:16px;margin-bottom:12px;display:flex;align-items:center;gap:14px;color:#eee">
    <div style="font-size:2rem;flex-shrink:0">${typeIcon}</div>
    <div style="flex:1;min-width:0">
      <div style="color:#8ae900;font-weight:900;font-size:1.02rem;margin-bottom:3px">${escHtml(r.rewardLabel || 'Ανταμοιβή')}</div>
      <div style="color:#fff;font-size:.86rem;margin-bottom:2px">👤 <span style="opacity:.8">${escHtml(custHint)}</span></div>
      <div style="color:#aaa;font-size:.76rem">${escHtml(costStr)} • 📍 ${escHtml(r.storeId || '—')} • πριν ${escHtml(agoStr)} • έως ${escHtml(remainStr)}</div>
    </div>
    ${actionsHtml}
  </div>
  <style>@keyframes l23a-spin{to{transform:rotate(360deg)}}</style>`;
}

// Set the row-level banner and immediately re-render THIS row in place, so
// the visible state is applied without waiting for the next snapshot.
function _setBanner(requestId, kind, text) {
  _bannerById.set(requestId, { kind, text });
  const el = document.getElementById(TARGET_ID);
  if (!el) return;
  const row = el.querySelector(`[data-request-id="${_cssEscape(requestId)}"]`);
  if (!row) return;
  // Replace the actions area (last flex child) via a minimal render on the row.
  // Simplest: replace innerHTML of the whole row by calling _renderRow with
  // the data attributes we've captured on the DOM.
  const label = row.querySelector('[style*="color:#8ae900"]')?.textContent || 'Ανταμοιβή';
  const rowLite = { id: requestId, rewardLabel: label };
  // We only have partial data; rebuild only the actions area for reliability.
  const actionsHost = row.children[row.children.length - 1];
  const banner = _bannerById.get(requestId);
  if (!actionsHost || !banner) return;
  const bg = banner.kind === 'success' ? '#8ae900' : (banner.kind === 'reload' ? '#ff9500' : (banner.kind === 'processing' ? 'transparent' : '#ff3b30'));
  const fg = banner.kind === 'success' ? '#0a0a0a' : '#fff';
  if (banner.kind === 'processing') {
    actionsHost.outerHTML = `<div data-l23a-banner="processing" style="display:flex;align-items:center;gap:8px;color:#8ae900;font-weight:800">
      <span style="display:inline-block;width:14px;height:14px;border:2px solid #8ae900;border-top-color:transparent;border-radius:50%;animation:l23a-spin 0.9s linear infinite"></span>
      ${escHtml(banner.text || 'Επεξεργασία…')}
    </div>`;
  } else {
    const reloadBtn = banner.kind === 'reload'
      ? ` <button data-l23a-action="reload" style="margin-left:8px;padding:6px 10px;background:#fff;color:#111;border:none;border-radius:8px;font-weight:800;cursor:pointer;font-family:inherit">↻ Reload</button>`
      : '';
    actionsHost.outerHTML = `<div data-l23a-banner="${escHtml(banner.kind)}" style="padding:8px 12px;background:${bg};color:${fg};border-radius:10px;font-weight:800;font-size:.86rem;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(banner.text || '')}${reloadBtn}</div>`;
  }
  // Rebind delegated click handler on the container.
  el.onclick = _onClick;
  // Suppress unused variable warnings — rowLite retained for future expansion.
  void rowLite;
}

function _cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// Bounded-timeout race. Callable rejects on timeout with code 'timeout'.
function _withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      const e = new Error('client-timeout');
      e.code = 'timeout';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Read the actual server state for one request. Uses the live Firestore
// SDK exposed on window (same handles src/tablet/approval-flow.js uses)
// so we don't add a dependency here.
async function _reconcileOnce(requestId) {
  if (_deps.reconcileRequest) return _deps.reconcileRequest(requestId);
  const db = window._db;
  if (!db || !window._doc || !window._getDoc) {
    return { status: 'unknown', reason: 'firebase-not-ready' };
  }
  try {
    const snap = await window._getDoc(window._doc(db, 'ipear_redemption_requests', requestId));
    if (!snap.exists()) return { status: 'missing' };
    const d = snap.data();
    return {
      status: d.status || 'unknown',
      newPoints: typeof d.newPoints === 'number' ? d.newPoints : null,
      rejectReason: d.rejectReason || null,
    };
  } catch (e) {
    return { status: 'unknown', reason: e?.code || e?.message || 'read-failed' };
  }
}

// Central error classifier — maps callable + timeout errors to a banner
// kind + user-visible text. Never surfaces raw tokens.
function _classifyError(e) {
  const code = String(e?.code || e?.details?.code || '');
  const msg  = String(e?.message || '').slice(0, 140);
  if (code === 'timeout') {
    return { kind: 'error', text: '⏱ Δεν ήρθε απάντηση σε 30δ — ελέγχω κατάσταση…', reconcile: true };
  }
  if (code.includes('unauthenticated') || code.includes('permission-denied')) {
    return { kind: 'reload', text: '⚠ App Check/δικαιώματα — ξαναφόρτωσε τη σελίδα.' };
  }
  if (code.includes('unavailable') || code.includes('deadline-exceeded')) {
    return { kind: 'error', text: '⚠ Χωρίς σύνδεση — δοκίμασε ξανά όταν είσαι online.', reconcile: true };
  }
  if (code.includes('not-found')) {
    return { kind: 'error', text: '❌ Το αίτημα δεν υπάρχει.' };
  }
  if (code.includes('failed-precondition')) {
    return { kind: 'error', text: '❌ ' + (msg || 'Δεν επιτρέπεται') };
  }
  return { kind: 'error', text: '❌ ' + (msg || code || 'Σφάλμα') };
}

// The single click handler for approve / reject / reload.
async function _onClick(ev) {
  const btn = ev.target?.closest?.('button[data-l23a-action]');
  if (!btn) return;
  ev.preventDefault();

  const action = btn.getAttribute('data-l23a-action');
  if (action === 'reload') {
    try { window.location.reload(); } catch (_) {}
    return;
  }

  const row = btn.closest('[data-request-id]');
  const requestId = row?.getAttribute('data-request-id');
  if (!requestId) return;

  // Hard-guard against double-click / already-processing. SYNCHRONOUS —
  // must run before any `await` so a rapid burst of clicks cannot each
  // slip past the guard while the first is still queuing up its work.
  if (_busyIds.has(requestId)) return;
  if (_bannerById.get(requestId)?.kind === 'processing') return;
  // Take the lock IMMEDIATELY (before the App Check readiness await).
  _busyIds.add(requestId);
  _setBanner(requestId, 'processing', 'Επεξεργασία…');

  // Pre-flight: App Check must be ready. On failure, release lock and
  // show the reload banner, but do NOT dispatch.
  try {
    await _deps.appCheckReady(3_000);
  } catch (_e) {
    _busyIds.delete(requestId);
    _setBanner(requestId, 'reload', '⚠ App Check δεν είναι έτοιμο — ξαναφόρτωσε τη σελίδα.');
    return;
  }

  // If the user is rejecting, prompt for a reason. Cancelling releases
  // the lock without dispatching a callable.
  let reason = '';
  if (action === 'reject') {
    const p = _deps.prompt('Λόγος απόρριψης (προαιρετικό):', '');
    if (p === null) {
      _busyIds.delete(requestId);
      _bannerById.delete(requestId);
      return;
    }
    reason = String(p || '');
  }

  let callablePromise;
  let outcomeKind = null; // 'success' | 'error' | 'reload'
  let outcomeText = '';
  let mustReconcile = false;
  try {
    if (action === 'approve') {
      callablePromise = _deps.approveRedemption(requestId);
    } else if (action === 'reject') {
      callablePromise = _deps.rejectRedemption(requestId, reason.slice(0, 200));
    } else {
      return;
    }
    const res = await _withTimeout(callablePromise, CALLABLE_TIMEOUT_MS);
    // Success — but we NEVER re-enable financial actions. The row waits on
    // the snapshot to drop, or on a reconciliation pass we run just below.
    if (action === 'approve') {
      if (res && res.alreadyProcessed) {
        outcomeKind = 'success';
        outcomeText = `ℹ️ Ήδη ${res.status}`;
      } else {
        const nP = res && typeof res.newPoints === 'number' ? res.newPoints : null;
        outcomeKind = 'success';
        outcomeText = nP != null ? `✅ Εγκρίθηκε · νέο υπόλοιπο: ${nP}` : '✅ Εγκρίθηκε';
      }
    } else {
      outcomeKind = 'success';
      outcomeText = res && res.alreadyProcessed ? `ℹ️ Ήδη ${res.status}` : '❌ Απορρίφθηκε';
    }
  } catch (e) {
    const c = _classifyError(e);
    outcomeKind = c.kind;
    outcomeText = c.text;
    mustReconcile = !!c.reconcile;
  } finally {
    _busyIds.delete(requestId);
    _setBanner(requestId, outcomeKind || 'error', outcomeText || 'Άγνωστο');
  }

  // Post-success reconciliation: if the snapshot hasn't reflected the
  // terminal state within RECONCILE_DELAY_MS, force a direct doc read.
  // This defends against listener/network delivery lag AND detects the
  // "timeout after server commit" case — never triggers an auto-retry.
  if (outcomeKind === 'success' || mustReconcile) {
    setTimeout(async () => {
      // Still shown as pending in the queue snapshot? Verify the actual
      // server state and adjust the banner accordingly. We do this ONLY
      // if the row is still in the DOM (i.e. snapshot hasn't dropped it).
      const el = document.getElementById(TARGET_ID);
      if (!el || !el.querySelector(`[data-request-id="${_cssEscape(requestId)}"]`)) return;
      const state = await _reconcileOnce(requestId);
      if (state.status === 'approved') {
        _setBanner(requestId, 'success',
          typeof state.newPoints === 'number'
            ? `✅ Εγκρίθηκε · νέο υπόλοιπο: ${state.newPoints}`
            : '✅ Εγκρίθηκε');
      } else if (state.status === 'rejected') {
        _setBanner(requestId, 'success', '❌ Απορρίφθηκε');
      } else if (state.status === 'expired') {
        _setBanner(requestId, 'error', '⏱ Έληξε — ζήτησε νέο κωδικό.');
      } else if (state.status === 'pending') {
        // Server did NOT commit. Safe explicit retry now allowed.
        _setBanner(requestId, 'error', '⚠ Δεν εκτελέστηκε — πάτα ξανά για retry.');
        // Do NOT auto-retry. Re-enable buttons by clearing the banner
        // ONLY when the operator explicitly acknowledges (they need to
        // dismiss by clicking Retry, which re-opens the actions).
        // Simplest safe UX: leave banner up, but expose a manual "Retry"
        // by allowing an "action=retry" that clears banner and reopens
        // the actions on the next snapshot re-render. Implemented via
        // dedicated Retry button below.
        _bannerById.set(requestId, {
          kind: 'error',
          text: '⚠ Δεν εκτελέστηκε — πάτα ξανά για retry.',
          canRetry: true,
        });
        // Re-render this row's actions to show a Retry button.
        _addRetryButton(requestId);
      }
    }, RECONCILE_DELAY_MS);
  }
}

function _addRetryButton(requestId) {
  const el = document.getElementById(TARGET_ID);
  const row = el?.querySelector(`[data-request-id="${_cssEscape(requestId)}"]`);
  if (!row) return;
  const host = row.children[row.children.length - 1];
  if (!host) return;
  // Append a small Retry button next to the current banner.
  const retry = document.createElement('button');
  retry.setAttribute('data-l23a-action', 'approve');
  retry.textContent = '↻ Retry Έγκριση';
  retry.style.cssText = 'margin-left:8px;padding:6px 10px;background:#8ae900;color:#0a0a0a;border:none;border-radius:8px;font-weight:800;cursor:pointer;font-family:inherit';
  host.appendChild(retry);
  // Clicking retry: clear busy + banner, then dispatch through _onClick again.
  retry.onclick = (ev) => {
    ev.preventDefault();
    _bannerById.delete(requestId);
    _busyIds.delete(requestId);
    // Re-render the row via a targeted rebuild.
    const dummy = document.createElement('button');
    dummy.setAttribute('data-l23a-action', 'approve');
    row.appendChild(dummy);
    const fakeEv = { target: dummy, preventDefault: () => {} };
    _onClick(fakeEv);
  };
}
