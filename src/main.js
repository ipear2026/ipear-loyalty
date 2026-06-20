// ═══════════════════════════════════════════════════════════════════════════
//  MAIN.JS — Central Orchestrator
// ═══════════════════════════════════════════════════════════════════════════
import { logger, tagLog } from './logger.js';
tagLog('PAGE-LOAD', `🚀 main.js loaded at ${new Date().toISOString()}`);
tagLog('PAGE-LOAD', 'ipear_rem in localStorage:', localStorage.getItem('ipear_rem') || '❌ NOT FOUND');

// ── Module imports ──
import { state } from './state.js';
import {
  esc, showToast, _trackEvent, _trapFocus, _releaseFocus,
  _WORKER_URL, tier, _applyTierColors, _fireConfetti, _fireTierUpConfetti,
  _parseExpiryMs, _isPendingAndActive
} from './utils.js';
import { _t } from './i18n.js';
import { _setPushUI, _syncPushState, _dismissPushOnboard, _acceptPushOnboard, registerServiceWorker } from './push-notifications.js';
import './firebase-init.js';
import {
  renderHomeRewards, renderRewardsList,
  startOffersListener, stopOffersListener, loadOffersData,
  loadLeaderboard, stopLbListener,
  loadHistory, loadHistoryMore,
  generateQR,
  openOfferSheet, closeOfferSheet, offerRedeemStep1, closeOfferConfirm,
  offerGenerateQR, cancelOfferQR, offerGenerateEshopCoupon, _copyEshopCoupon,
  _offerTick, _stopOfferRedeemWatch,
  copyReferral, shareReferral,
  _expandLeaderboard, _collapseLb, _toggleHistory
} from './ui-renderers.js';
import {
  showScreen, _showLogin, autoLogin, _getSavedAccount, _initCheckboxStyle,
  setupReferralAutoFill, togglePassVis, _REM_KEY,
  submitPhone, submitCreatePass, goToPhone,
  openForgotPass, submitForgotPass, backToLogin,
  openRegister, submitRegister, submitOTP, resendOTP, cancelOTP,
  logout, requestAccountDeletion
} from './auth.js';

// ════════════════════════════════════════
//  IN-APP BROWSER DETECTION (silent)
// ════════════════════════════════════════
// Tag Instagram / FB / Messenger / TikTok WebViews silently — no banner, no
// block. `window._inAppBrowser` lets the redemption error path show a clearer
// message ONLY if Firestore actually rejects ("ο browser του Instagram
// μπλοκάρει την εξαργύρωση") instead of a generic failure. Otherwise the
// user experiences the app exactly like in Safari/Chrome.
(function _flagInAppBrowsers() {
  const ua = navigator.userAgent || '';
  const isInsta = /Instagram/i.test(ua);
  const isFB    = /FBAN|FBAV|FB_IAB|FB4A/i.test(ua);
  const isMessenger = /Messenger/i.test(ua);
  const isTikTok = /Bytedance|TikTok|musical_ly/i.test(ua);
  if (!(isInsta || isFB || isMessenger || isTikTok)) return;
  window._inAppBrowser = isInsta ? 'Instagram' : isFB ? 'Facebook' : isMessenger ? 'Messenger' : 'TikTok';
  document.documentElement.classList.add('inapp-browser');
})();

// ════════════════════════════════════════
//  LOCAL STATE (main.js scope)
// ════════════════════════════════════════
let _redeemTimer = null;
let _activeRedemptionDocId = null;
let _redeemSnapshotUnsub = null;
let _liveUnsub = null;
let _lastKnownTierCls = null;

// Expose a safe-to-reload predicate for the SW handshake (push-notifications.js).
// Returns false while a redemption QR is active so a SW update doesn't tear it
// down mid-scan at the till.
window._safeToReloadForSW = function _safeToReloadForSW() {
  return !_activeRedemptionDocId;
};

// ════════════════════════════════════════
//  CUSTOMER DOC MIGRATION (random-ID → UID)
// ════════════════════════════════════════
export async function _migrateCustomerToUid(oldDocId, uid) {
  if (!uid || !oldDocId || oldDocId === uid || window.DEMO) return;
  const db = window._db;
  const newRef = window._doc(db, 'ipear_customers', uid);
  const oldRef = window._doc(db, 'ipear_customers', oldDocId);

  // Fan out the two reads (saves ~150-300ms over the legacy serial path).
  // The old-doc read is "wasted" only when uid-keyed already exists — the
  // fast path we don't care about optimising further.
  const [newSnap, oldSnap] = await Promise.all([
    window._getDoc(newRef),
    window._getDoc(oldRef),
  ]);

  if (newSnap.exists()) {
    state.foundCustomer = { id: uid, ...newSnap.data() };
    return;
  }
  if (!oldSnap.exists()) return;
  const data = oldSnap.data();
  await window._setDoc(newRef, { ...data, uid, _migratedFrom: oldDocId });
  try { await window._deleteDoc(oldRef); } catch(delErr) {
    logger.warn('[migration] Failed to delete old doc', oldDocId, delErr?.code || delErr?.message || delErr);
  }
  state.foundCustomer.id = uid;
  state.foundCustomer.uid = uid;
  state.foundCustomer._migratedFrom = oldDocId;
}

// ════════════════════════════════════════
//  REDEMPTION HELPERS
// ════════════════════════════════════════
function _stopRedeemSnapshot() {
  if (_redeemSnapshotUnsub) { try { _redeemSnapshotUnsub(); } catch(_){} _redeemSnapshotUnsub = null; }
}

function _watchRedemptionDoc(docId) {
  _stopRedeemSnapshot();
  if (!docId || window.DEMO) return;
  try {
    const ref = window._doc(window._db, 'ipear_redemptions', docId);
    _redeemSnapshotUnsub = window._onSnapshot(ref, snap => {
      if (!snap.exists()) {
        _stopRedeemSnapshot();
        clearInterval(_redeemTimer);
        _activeRedemptionDocId = null;
        _redeemInProgress = false;
        document.getElementById('redeem-overlay').style.display = 'none';
        showToast('Η εξαργύρωση ακυρώθηκε από το κατάστημα.', 'red');
        return;
      }
      const d = snap.data();
      if (d.status === 'rejected' || d.status === 'cancelled') {
        _stopRedeemSnapshot();
        clearInterval(_redeemTimer);
        _activeRedemptionDocId = null;
        _redeemInProgress = false;
        document.getElementById('redeem-overlay').style.display = 'none';
        showToast('Η εξαργύρωση ακυρώθηκε από το κατάστημα.', 'red');
        return;
      }
      if (d.used === true || d.status === 'used') {
        _stopRedeemSnapshot();
        clearInterval(_redeemTimer);
        _activeRedemptionDocId = null;
        document.getElementById('redeem-overlay').style.display = 'none';
        showToast('✅ Εξαργύρωση ολοκληρώθηκε!', 'green');
        setTimeout(() => _fireConfetti(), 200);
      }
    });
  } catch(e) { logger.warn('[redeem-watch]', e); }
}

async function _cancelActiveRedemption(reason='cancelled') {
  if (!_activeRedemptionDocId) return;
  const docId = _activeRedemptionDocId;
  _activeRedemptionDocId = null;
  if (window.DEMO) return;
  try {
    await window._deleteDoc(window._doc(window._db, 'ipear_redemptions', docId));
    logger.log('[redeem-cancel] deleted redemption doc:', docId, 'reason:', reason);
  } catch(e) {
    logger.warn('[redeem-cancel] delete failed, falling back to status update:', e.message);
    try {
      await window._updateDoc(window._doc(window._db, 'ipear_redemptions', docId), {
        status: 'cancelled',
        cancelledAt: new Date().toISOString(),
        cancelReason: reason
      });
    } catch(_) {}
  }
}
// Export for auth.js logout
export { _cancelActiveRedemption };

async function _findExistingActivePendingByUser(uid) {
  if (!uid) return null;
  try {
    const snap = await window._getDocs(
      window._query(
        window._col(window._db, 'ipear_redemptions'),
        window._where('customerUid', '==', uid),
        window._where('status', '==', 'pending')
      )
    );
    let found = null;
    snap.forEach(d => {
      if (found) return;
      const data = d.data();
      if (_isPendingAndActive(data)) found = { id: d.id, ...data };
    });
    return found;
  } catch(e) {
    logger.warn('[findPending]', e.message);
    return null;
  }
}

async function _generateUniquePendingCode(maxTries = 3) {
  for (let i = 0; i < maxTries; i++) {
    const _rnd = new Uint32Array(1); crypto.getRandomValues(_rnd);
    const candidate = String(100000 + (_rnd[0] % 900000));
    const uid = state.foundCustomer?.uid || '';
    if (!uid) return candidate;
    try {
      const snap = await window._getDocs(
        window._query(
          window._col(window._db, 'ipear_redemptions'),
          window._where('customerUid', '==', uid),
          window._where('code', '==', candidate),
          window._where('status', '==', 'pending')
        )
      );
      if (snap.empty) return candidate;
    } catch(_) {
      return candidate;
    }
  }
  const _rnd = new Uint32Array(1); crypto.getRandomValues(_rnd);
  return String(100000 + (_rnd[0] % 900000));
}

// ════════════════════════════════════════════════════════════════════
//  ACCOUNT DELETION KICK-OUT
//  Centralised so listener + polling fallback + ghost-autoLogin guard
//  all converge on the same teardown. Critical that we AWAIT signOut
//  and hard-reload — otherwise Firebase Auth's persisted IndexedDB
//  session resurrects on the next page load and the user appears
//  "still signed in" to a deleted account.
// ════════════════════════════════════════════════════════════════════
let _kickInFlight = false;
export async function _kickOutDeletedAccount(reason = 'deleted') {
  if (_kickInFlight) return;
  _kickInFlight = true;
  logger.warn('[kick-out] account no longer exists — reason:', reason);
  _forceCleanup();
  state.foundCustomer = null;
  // Clear EVERY persistence key the customer flow touches. The old code
  // missed ipear_offline_card and any vendor sw key, so a quick reload
  // could rehydrate stale identity from disk.
  try {
    [
      'ipear_rem',
      'ipear_customer_cache',
      'ipear_offline_card',
    ].forEach(k => localStorage.removeItem(k));
  } catch(_) {}
  // Block any concurrent UI from re-rendering against the dead doc.
  try { document.getElementById('redeem-overlay').style.display = 'none'; } catch(_) {}
  try { document.getElementById('offer-qr-overlay').style.display = 'none'; } catch(_) {}
  // AWAIT signOut so the Firebase Auth IndexedDB session is actually
  // torn down before we hand control back. Previously this was fire-
  // and-forget which is the dominant cause of "still signed in after
  // deletion" — the page would reload while signOut was mid-flight.
  try {
    if (window._auth?.currentUser && window._signOut) {
      await window._signOut(window._auth);
      logger.log('[kick-out] signOut completed');
    }
  } catch (e) {
    logger.error('[kick-out] signOut failed — forcing reload anyway:', e?.code || e?.message || e);
  }
  showToast(reason === 'deleted'
    ? '🗑 Ο λογαριασμός σου διαγράφηκε.'
    : '⚠️ Η σύνδεσή σου τερματίστηκε.',
    'red');
  // Hard reload after a short visual delay. We use location.reload(true)
  // semantics (modern: just location.reload) so any in-memory state is
  // wiped and the next boot starts from a clean Firebase Auth state.
  setTimeout(() => {
    try { location.reload(); }
    catch(_) { showScreen('s-phone'); _initCheckboxStyle(); }
  }, 1800);
}

// ════════════════════════════════════════
//  FORCE CLEANUP (all listeners/timers)
// ════════════════════════════════════════
export function _forceCleanup() {
  stopLiveListener();
  _stopExistencePoll();
  stopOffersListener();
  stopLbListener();
  if (state._maintenanceUnsub) { try { state._maintenanceUnsub(); } catch(_) {} state._maintenanceUnsub = null; }
  clearInterval(_redeemTimer); _redeemTimer = null;
  _stopRedeemSnapshot();
  _stopOfferRedeemWatch();
  _activeRedemptionDocId = null;
  try { document.getElementById('redeem-overlay').style.display = 'none'; } catch(_) {}
  try { document.getElementById('offer-qr-overlay').style.display = 'none'; } catch(_) {}
}

// ════════════════════════════════════════
//  REAL-TIME LIVE LISTENER (onSnapshot)
// ════════════════════════════════════════
function startLiveListener() {
  stopLiveListener();
  if (!state.foundCustomer?.id || window.DEMO) return;
  _startExistencePoll();
  startTxLiveListener();
  // HOTFIX: the first snapshot is INITIAL HYDRATION, not a points-change
  // event. Without this guard, users whose state.foundCustomer was
  // pre-populated from a query of a different doc (legacy random-id ≠
  // uid-keyed) — or any path where the live-listener target doc has a
  // different `points` value than the hydrated state — see a spurious
  // ±balance popup on every login (+4730, -600, etc.).
  // The popup must only fire on REAL changes that happen WHILE the user
  // is in the app (worker credits +50/+100, admin add/redeem, etc.).
  let _isFirstFire = true;
  try {
    const ref = window._doc(window._db, 'ipear_customers', state.foundCustomer.id);
    _liveUnsub = window._onSnapshot(ref, snap => {
      try {
      // Guard: state.foundCustomer may have been cleared by a parallel logout
      // / kick-out path between the time this listener was attached and the
      // snapshot firing. Dereferencing .points on null below would throw and
      // be swallowed silently. Bail cleanly instead.
      if (!state.foundCustomer) { logger.log('[live] snapshot fired after foundCustomer cleared — skipping'); return; }
      if (!snap.exists()) {
        // Doc removed by admin OR by the customer's own self-migration
        // delete of the legacy random-id doc. Distinguish the two: a
        // migration delete leaves a uid-keyed doc behind that the auth
        // user can still read. If we can fetch ipear_customers/{auth.uid}
        // and it exists, this is a migration cleanup — re-mount the
        // listener on the new doc and do NOT kick the user out.
        (async () => {
          try {
            const authUid = window._auth?.currentUser?.uid;
            if (authUid && authUid !== state.foundCustomer?.id) {
              const newRef  = window._doc(window._db, 'ipear_customers', authUid);
              const newSnap = await window._getDoc(newRef);
              if (newSnap.exists()) {
                logger.log('[live] legacy doc gone but uid-keyed exists — re-mounting listener on uid');
                state.foundCustomer = { id: authUid, ...newSnap.data() };
                stopLiveListener();
                startLiveListener();
                return;
              }
            }
            // Genuine deletion (no replacement doc): kick out.
            _kickOutDeletedAccount('deleted');
          } catch (e) {
            logger.error('[live] resilience check failed — falling through to kick-out:', e?.code || e?.message || e);
            _kickOutDeletedAccount('deleted');
          }
        })();
        return;
      }
      const data = snap.data();
      const oldPts = state.foundCustomer.points || 0;
      const oldTot = state.foundCustomer.totalPoints || 0;
      const newPts = data.points || 0;
      const newTot = data.totalPoints || 0;
      state.foundCustomer = { ...state.foundCustomer, ...data };
      if (data.blocked) {
        _kickOutDeletedAccount('blocked');
        return;
      }
      if (_isFirstFire) {
        // Initial sync — refresh the header silently, never popup.
        _isFirstFire = false;
        try { _refreshPointsUI(); } catch(_) {}
      } else if (newPts !== oldPts || newTot !== oldTot) {
        // Compare totalPoints too: an admin "add + redeem" that nets to the
        // same `points` still moves `totalPoints`, and the customer should
        // see the history refresh + animation either way.
        _animateLivePointsChange(oldPts, newPts, newTot);
      }
      const _rcEl = document.getElementById('ref-count-val');
      if (_rcEl) _rcEl.textContent = data.referralCount || 0;
      try { localStorage.setItem('ipear_offline_card', JSON.stringify({ name: state.foundCustomer.name, card: state.foundCustomer.card, points: newPts, tier: _lastKnownTierCls || 'bronze', tierIcon: '' })); } catch(_) {}
      } catch(_liveErr) { logger.error('[live] callback error:', _liveErr); }
    },
    // Subscription-level error path. Most relevant code:
    //   • permission-denied — rules now reject our read. Happens when the
    //     doc has been deleted (resource.data is undefined → ownsCustomer
    //     fails) or the customer was un-linked from the uid. Treat as
    //     deletion and kick out.
    //   • unavailable / cancelled — transient, the SDK auto-retries.
    //     Existence-poll fallback covers the case where reconnect drops
    //     a delete event; do nothing here.
    (err) => {
      logger.warn('[live] subscription error:', err?.code || err?.message || err);
      if (err?.code === 'permission-denied') {
        _kickOutDeletedAccount('deleted');
      }
    });
  } catch(e) { logger.warn('[live]', e); }
}

function stopLiveListener() {
  if (_liveUnsub) { try { _liveUnsub(); } catch(_) {} _liveUnsub = null; }
  stopTxLiveListener();
}

// ════════════════════════════════════════════════════════════════════
//  REAL-TIME TRANSACTION LISTENER
//  Filters by customerUid so the index requirement stays a single-field
//  (auto-indexed) lookup — no composite index deploy required. Refreshes
//  history on any add/redeem/expire so the customer never sees a stale
//  ledger after a points event.
//
//  Debounced: rapid back-to-back admin operations (add → redeem in 1s)
//  coalesce into a single loadHistory call, instead of stampeding the
//  history queries and freezing the UI thread on every doc change.
// ════════════════════════════════════════════════════════════════════
let _txLiveUnsub = null;
let _txLiveFirst = true;
let _txLiveDebounceTimer = null;
const _TX_LIVE_DEBOUNCE_MS = 600;
function startTxLiveListener() {
  stopTxLiveListener();
  const uid = state.foundCustomer?.uid;
  if (!uid || window.DEMO) return;
  _txLiveFirst = true;
  try {
    const q = window._query(
      window._col(window._db, 'ipear_transactions'),
      window._where('customerUid', '==', uid)
    );
    _txLiveUnsub = window._onSnapshot(q, () => {
      // Skip the first fire — loadHistory is already triggered by the
      // transition / profile-open path, no need to double up.
      if (_txLiveFirst) { _txLiveFirst = false; return; }
      if (_txLiveDebounceTimer) clearTimeout(_txLiveDebounceTimer);
      _txLiveDebounceTimer = setTimeout(() => {
        _txLiveDebounceTimer = null;
        try { loadHistory(); } catch (e) { logger.warn('[tx-live] loadHistory:', e); }
      }, _TX_LIVE_DEBOUNCE_MS);
    }, err => {
      logger.warn('[tx-live] subscription error:', err?.code || err?.message);
    });
  } catch (e) { logger.warn('[tx-live] init:', e); }
}
function stopTxLiveListener() {
  if (_txLiveUnsub) { try { _txLiveUnsub(); } catch(_) {} _txLiveUnsub = null; }
  if (_txLiveDebounceTimer) { clearTimeout(_txLiveDebounceTimer); _txLiveDebounceTimer = null; }
  _txLiveFirst = true;
}

// ════════════════════════════════════════════════════════════════════
//  EXISTENCE POLLING FALLBACK
//  onSnapshot can miss events when the tab was backgrounded, the device
//  went offline, or the WebSocket reconnect dropped a delta. Belt-and-
//  braces: every 2 min while signed in we re-read the customer doc; if
//  it has gone missing we trigger the same kick-out path as the live
//  listener. Light load (1 read / 2 min / user) and worth it for the
//  GDPR-correctness guarantee.
// ════════════════════════════════════════════════════════════════════
let _existencePollTimer = null;
const _EXISTENCE_POLL_MS = 2 * 60 * 1000;

function _startExistencePoll() {
  _stopExistencePoll();
  if (window.DEMO) return;
  _existencePollTimer = setInterval(async () => {
    const id = state.foundCustomer?.id;
    if (!id) { _stopExistencePoll(); return; }
    try {
      const snap = await window._getDoc(window._doc(window._db, 'ipear_customers', id));
      if (!snap.exists()) {
        logger.warn('[existence-poll] customer doc missing — triggering kick-out');
        _kickOutDeletedAccount('deleted');
      }
    } catch (e) {
      // Permission-denied is the signal that the doc is gone AND we're
      // no longer allowed to read it (rule denied via ownsCustomer).
      // Treat as deletion. Anything else (network / App Check) is a
      // transient failure — silently retry next tick.
      if (e?.code === 'permission-denied') {
        logger.warn('[existence-poll] permission-denied — treating as deleted');
        _kickOutDeletedAccount('deleted');
      } else {
        logger.warn('[existence-poll] transient error, retrying next tick:', e?.code || e?.message || e);
      }
    }
  }, _EXISTENCE_POLL_MS);
}

function _stopExistencePoll() {
  if (_existencePollTimer) { clearInterval(_existencePollTimer); _existencePollTimer = null; }
}

function _isSplashActive() {
  const el = document.getElementById('splash-screen');
  return !!(el && el.classList.contains('active') && !el.classList.contains('fade-out'));
}

function _animateLivePointsChange(oldPts, newPts, newTot) {
  // If the splash is still on screen (typical for credits that land during
  // the 2.8s post-login splash window — auto-retry of /send-welcome and
  // /process-referral fires fast), defer the animation + toast until the
  // splash dismisses. Otherwise the user misses the whole "+50/+100"
  // celebration because it plays behind the splash.
  if (_isSplashActive()) {
    window.addEventListener('splash-hidden', () => {
      _animateLivePointsChange(oldPts, newPts, newTot);
    }, { once: true });
    return;
  }
  const diff = newPts - oldPts;
  const t   = tier(newTot);
  const pct = t.next ? Math.min(100, Math.round(((newTot - t.floor) / (t.next - t.floor)) * 100)) : 100;
  const nName = t.next===1000?'🥈 Silver':t.next===3000?'🥇 Gold':t.next===6000?'💎 Diamond':'👑 Platinum';
  const ptsStr = newPts.toLocaleString('el-GR');
  const totStr = newTot.toLocaleString('el-GR');
  const pctStr = pct + '%';

  _applyTierColors(t.cls);
  _checkTierChange(t.cls);

  switchTab('home');

  const hdrPts = document.getElementById('hdr-pts');
  if (hdrPts) hdrPts.textContent = ptsStr;

  const hPts = document.getElementById('h-pts');
  if (hPts) {
    hPts.style.transition = 'transform .25s,color .25s';
    hPts.style.transform  = 'scale(1.4)';
    hPts.style.color      = diff > 0 ? '#8ae900' : '#ff3b30';
    setTimeout(() => {
      hPts.textContent     = ptsStr;
      hPts.style.transform = 'scale(1)';
      setTimeout(() => { hPts.style.color = ''; hPts.style.transition = ''; }, 400);
    }, 200);
  }
  const el = id => document.getElementById(id);
  if (el('h-tier-icon')) el('h-tier-icon').textContent = t.icon;
  if (el('h-tier-name')) el('h-tier-name').textContent = t.name;
  const fill = el('h-prog-fill');
  if (fill) { fill.style.transition = 'width .6s ease'; fill.style.width = pctStr; }
  if (el('h-prog-pct')) el('h-prog-pct').textContent = pctStr;
  if (el('h-prog-lbl')) el('h-prog-lbl').textContent = t.next
    ? `${totStr} / ${t.next.toLocaleString('el-GR')} → ${nName}`
    : '👑 Platinum — Ανώτατη κατάταξη!';
  renderHomeRewards(newPts);

  if (el('lc-pts'))          el('lc-pts').textContent          = ptsStr;
  if (el('lc-tier-icon'))    el('lc-tier-icon').textContent    = t.icon;
  if (el('lc-tier-name'))    el('lc-tier-name').textContent    = t.name;
  if (el('lc-tier-icon-big'))el('lc-tier-icon-big').textContent= t.icon;

  if (el('rw-pts'))      el('rw-pts').textContent      = ptsStr;
  if (el('rw-tier-icon'))el('rw-tier-icon').textContent = t.icon;
  renderRewardsList(newPts);

  if (el('pr-tier'))  el('pr-tier').textContent  = t.icon + ' ' + t.name;
  if (el('pr-ticon')) el('pr-ticon').textContent = t.icon;
  if (el('pr-tname')) el('pr-tname').textContent = t.name;
  if (el('pr-tpct'))  el('pr-tpct').textContent  = pctStr;
  if (el('pr-tprog')) el('pr-tprog').style.width = pctStr;
  if (el('pr-tsub'))  el('pr-tsub').textContent  = t.next
    ? `${totStr} / ${t.next.toLocaleString('el-GR')} → ${nName}`
    : '👑 Ανώτατη κατάταξη!';

  // Single delayed safety call. The tx live listener catches new ledger
  // rows directly; this 1.5s call covers the rare case where the customer
  // doc snapshot arrives before the matching transaction is queryable.
  // (Originally a 3-step ladder at 0.8/2.5/6s — that was firing 3 full
  // history scans per balance change AND racing the live listener, causing
  // jank on the customer profile during rapid admin activity.)
  setTimeout(() => { try { loadHistory(); } catch(_) {} }, 1500);

  _showLivePointsToast(diff);
}

function _showLivePointsToast(diff) {
  const old = document.getElementById('live-pts-toast');
  if (old) old.remove();

  const el = document.createElement('div');
  el.id = 'live-pts-toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  const isAdd = diff > 0;
  const sign = isAdd ? '+' : '';
  el.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(.6);
    background:${isAdd ? '#111111' : '#ff3b30'};color:${isAdd ? '#8ae900' : '#fff'};
    font-family:var(--font);font-weight:900;font-size:clamp(2rem,8vw,3.5rem);
    padding:28px 44px;border-radius:12px;z-index:9999;text-align:center;
    box-shadow:0 10px 40px rgba(0,0,0,.25);pointer-events:none;
    transition:transform .35s cubic-bezier(.34,1.56,.64,1),opacity .35s;opacity:0;
    letter-spacing:-1px;
    font-variant-numeric:tabular-nums;font-feature-settings:"tnum";
  `;
  el.innerHTML = `${sign}${diff.toLocaleString('el-GR')}<div style="font-size:clamp(.7rem,2.5vw,1rem);margin-top:6px;opacity:.8;letter-spacing:0">πόντοι</div>`;
  document.body.appendChild(el);

  requestAnimationFrame(() => {
    el.style.transform = 'translate(-50%,-50%) scale(1)';
    el.style.opacity = '1';
  });
  setTimeout(() => {
    el.style.transform = 'translate(-50%,-60%) scale(.85)';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }, 2200);
}

// ════════════════════════════════════════
//  TIER CHANGE DETECTION
// ════════════════════════════════════════
function _checkTierChange(newTierCls) {
  if (!_lastKnownTierCls) { _lastKnownTierCls = newTierCls; return; }
  if (newTierCls !== _lastKnownTierCls) {
    const tierOrder = ['bronze','silver','gold','diamond','platinum'];
    const oldIdx = tierOrder.indexOf(_lastKnownTierCls);
    const newIdx = tierOrder.indexOf(newTierCls);
    if (newIdx > oldIdx) {
      setTimeout(_fireTierUpConfetti, 300);
      const names = { silver:'Silver 🥈', gold:'Gold 🥇', diamond:'Diamond 💎', platinum:'Platinum 👑' };
      showToast('🎉 Ανέβηκες στο ' + (names[newTierCls] || newTierCls) + '!', 'green');
      _syncTierToWoo(newTierCls, state.foundCustomer?.totalPoints || 0);
    }
    _lastKnownTierCls = newTierCls;
  }
}

function _syncTierToWoo(tierCls, totalPoints) {
  const authUser = window._auth?.currentUser;
  if (!authUser) return;
  authUser.getIdToken(true).then(idToken => {
    fetch(_WORKER_URL + '/woo-sync-tier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, tier: tierCls, totalPoints })
    }).then(r => r.json()).then(d => {
      if (!d.ok && !d.synced) logger.warn('[tier-sync] skip:', d.reason || d.error || 'unknown');
    }).catch(e => logger.warn('[tier-sync] error:', e.message));
  }).catch(e => logger.warn('[woo-tier-sync] idToken failed:', e.message));
}

// ════════════════════════════════════════
//  TAB SWITCHING
// ════════════════════════════════════════
let _hdrLastY = 0, _hdrBound = null, _hdrRafPending = false;
let _hdrRef = null;
const _HDR_DEAD_ZONE = 8;

export function switchTab(name) {
  if (_hdrRef) _hdrRef.classList.remove('hdr-hidden');
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.bn').forEach(b => {
    b.classList.remove('active');
    b.removeAttribute('aria-current');
  });
  const pane = document.getElementById('t-'+name);
  pane.style.animation = 'none';
  pane.offsetHeight;
  pane.style.animation = '';
  pane.classList.add('active');
  const navBtn = document.getElementById('nav-'+name);
  navBtn.classList.add('active');
  // A11y: aria-current="page" announces the active tab to assistive tech.
  // Matches the visual `active` class — toggled together to stay in sync.
  navBtn.setAttribute('aria-current', 'page');
  pane.scrollTop = 0;
  if (name==='card')    generateQR();
  if (name==='profile') {
    loadLeaderboard();
    _syncPushState();
    // Refresh transactions every time the user opens their profile — worker-
    // driven credits (referral, marketing) land asynchronously and don't
    // trigger _animateLivePointsChange when the first snapshot already shows
    // the updated balance. Without this, users see new points but an empty
    // "Ιστορικό Συναλλαγών" until they fully relaunch the app.
    loadHistory();
  }
  _bindHeaderScroll(pane);
}

function _bindHeaderScroll(pane) {
  if (!pane) return;
  if (!_hdrRef) _hdrRef = document.querySelector('.app-header');
  if (!_hdrRef) return;
  if (_hdrBound) _hdrBound.removeEventListener('scroll', _hdrOnScroll);
  _hdrRef.classList.remove('hdr-hidden');
  _hdrLastY = pane.scrollTop;
  _hdrBound = pane;
  pane.addEventListener('scroll', _hdrOnScroll, {passive:true});
}

function _hdrOnScroll() {
  if (_hdrRafPending) return;
  _hdrRafPending = true;
  requestAnimationFrame(() => {
    _hdrRafPending = false;
    if (!_hdrBound || !_hdrRef) return;
    const y = _hdrBound.scrollTop;
    if (y < 0) { _hdrLastY = 0; return; }
    const delta = y - _hdrLastY;
    if (Math.abs(delta) < _HDR_DEAD_ZONE) return;
    if (delta > 0 && y > 60) _hdrRef.classList.add('hdr-hidden');
    else if (delta < 0) _hdrRef.classList.remove('hdr-hidden');
    _hdrLastY = y;
  });
}

// ════════════════════════════════════════
//  i18n LABELS + GREETING
// ════════════════════════════════════════
function _applyI18nLabels() {
  const map = {
    'hero-pts-lbl': 'points',
    'lc-pts-lbl':   'points_lbl',
    'rpb-lbl':      'rw_avail',
    'logout-btn':   'logout',
  };
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.textContent = _t(key);
  }
}

function _updateGreeting() {
  const hr = new Date().getHours();
  const gr = hr < 12 ? _t('good_morning') : _t('good_evening');
  const el = document.querySelector('.hero-greeting');
  if (el) el.textContent = gr;
}

// ════════════════════════════════════════
//  KEEPALIVE
// ════════════════════════════════════════
let _customerLastActive = Date.now();

function _customerKeepAlive() {
  if (!state.foundCustomer || window.DEMO) return;
  _customerLastActive = Date.now();
  try {
    _updateGreeting();
    startLiveListener();
    startOffersListener();
    try { loadLeaderboard(); } catch(_) {}
    try { _syncPushState(); } catch(_) {}
  } catch(e) { logger.warn('[keepalive] error:', e); }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.foundCustomer) {
    const sleepDuration = Date.now() - _customerLastActive;
    if (sleepDuration > 30 * 60 * 1000) {
      logger.log('[keepalive] customer asleep >30min, reloading...');
      location.reload();
      return;
    }
    setTimeout(_customerKeepAlive, 300);
    if (_redeemExpires) _redeemTick();
    if (typeof _offerTick === 'function') _offerTick();
  } else {
    _customerLastActive = Date.now();
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && state.foundCustomer) {
    logger.log('[keepalive] bfcache restore, reloading...');
    location.reload();
  }
});
window.addEventListener('focus', () => {
  if (state.foundCustomer && !window.DEMO) setTimeout(_customerKeepAlive, 200);
});
window.addEventListener('online', () => {
  if (state.foundCustomer && !window.DEMO) setTimeout(_customerKeepAlive, 500);
});

// ════════════════════════════════════════
//  MAINTENANCE MODE LISTENER
// ════════════════════════════════════════
function _startMaintenanceListener() {
  if (state._maintenanceUnsub || window.DEMO) return;
  const db = window._db; if (!db) return;
  try {
    const ref = window._doc(db, 'settings', 'system');
    state._maintenanceUnsub = window._onSnapshot(ref, snap => {
      if (!snap.exists()) { _setMaintenanceMode(false); return; }
      _setMaintenanceMode(!!snap.data().maintenance);
    }, () => { state._maintenanceUnsub = null; });
  } catch(_) { state._maintenanceUnsub = null; }
}

function _setMaintenanceMode(active) {
  state._maintenanceMode = active;
  document.querySelectorAll('[data-redeem-btn]').forEach(btn => {
    btn.disabled = active;
    if (active) btn.style.opacity = '.4';
    else btn.style.opacity = '';
  });
  if (active) {
    showToast('Το σύστημα αναβαθμίζεται. Παρακαλούμε δοκιμάστε σε λίγο!', 'warn');
  }
}

// ════════════════════════════════════════
//  BIRTHDAY
// ════════════════════════════════════════
const _BDAY_BONUS = 50;

function _showBirthdayToast() {
  const existing = document.getElementById('bday-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'bday-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.55);backdrop-filter:blur(6px);
    animation:fadeIn .35s ease;
  `;

  const name = esc((state.foundCustomer?.name || '').split(' ')[0] || 'φίλε');

  overlay.innerHTML = `
    <div style="
      background:#fff;border-radius:12px;
      padding:36px 32px 28px;max-width:320px;width:90%;
      text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.18);
      animation:slideUp .4s cubic-bezier(.34,1.56,.64,1);
      position:relative;overflow:hidden;
    ">
      <div style="position:absolute;top:0;left:0;right:0;height:6px;
        background:linear-gradient(90deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff,#c77dff)"></div>
      <div style="font-size:64px;line-height:1;margin-bottom:12px">🎂</div>
      <div style="font-size:1.4rem;font-weight:900;color:#111111;margin-bottom:6px;line-height:1.2">
        Χρόνια Πολλά,<br>${name}! 🎉
      </div>
      <div style="font-size:.93rem;color:#555;line-height:1.65;margin-bottom:22px">
        Σου ευχόμαστε χαρούμενα γενέθλια!<br>
        Κέρδισες <strong style="color:#5a9900">+${_BDAY_BONUS} bonus πόντους</strong> 🎉<br>
        Σε περιμένουμε στο iPear! 🍐
      </div>
      <div style="
        background:#f0ffe0;border:2px solid #8ae900;border-radius:8px;
        padding:14px 20px;margin-bottom:22px;
      ">
        <div style="font-size:.72rem;color:#777;text-transform:uppercase;letter-spacing:2px;font-weight:700;margin-bottom:4px">Birthday Bonus</div>
        <div style="font-size:2.2rem;font-weight:900;color:#5a9900;line-height:1">
          +${_BDAY_BONUS}
        </div>
        <div style="font-size:.78rem;color:#767676;margin-top:3px">bonus πόντοι στον λογαριασμό σου 🍐</div>
      </div>
      <button onclick="document.getElementById('bday-overlay').remove()" style="
        width:100%;padding:14px;background:linear-gradient(135deg,#6bb800,#8ae900);
        color:#111111;font-weight:700;font-size:1rem;border:none;border-radius:8px;
        cursor:pointer;letter-spacing:.3px;box-shadow:0 2px 8px rgba(107,184,0,.2);
      ">🎊 Ευχαριστώ!</button>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });
}

async function _awardBirthdayBonus(c) {
  if (!c?.id || window.DEMO) return;
  const year = new Date().getFullYear();
  const key = `ipear_bday_${c.id}_${year}`;
  if (localStorage.getItem(key)) return;
  try {
    const authUid = window._auth?.currentUser?.uid || c.uid || c.id;
    const claimId = authUid + '_' + year;
    await window._setDoc(window._doc(window._db, 'ipear_birthday_claims', claimId), {
      customerId: c.id,
      customerUid: authUid,
      customerName: c.name || '',
      customerEmail: c.email || '',
      card: c.card || '',
      birthday: c.birthday || '',
      year,
      points: _BDAY_BONUS,
      processed: false,
      claimedAt: new Date().toISOString(),
      claimedAtTs: new Date()
    });
    localStorage.setItem(key, '1');
  } catch(e) {
    logger.warn('[birthday] claim error:', e.message);
  }
}

// ════════════════════════════════════════
//  REFRESH POINTS UI
// ════════════════════════════════════════
export function _refreshPointsUI() {
  if (!state.foundCustomer) return;
  const pts = state.foundCustomer.points || 0;
  const ptsStr = pts.toLocaleString('el-GR');
  const el = id => document.getElementById(id);
  if (el('hdr-pts')) el('hdr-pts').textContent = ptsStr;
  if (el('h-pts'))   el('h-pts').textContent = ptsStr;
  if (el('lc-pts'))  el('lc-pts').textContent = ptsStr;
  if (el('rw-pts'))  el('rw-pts').textContent = ptsStr;
  renderHomeRewards(pts);
  renderRewardsList(pts);
}

// ════════════════════════════════════════
//  REDEMPTION
// ════════════════════════════════════════
let _redeemInProgress = false;
let _redeemLastAt = 0;
const _REDEEM_COOLDOWN = 2000;

export async function startRedemption(points, label) {
  if (state._maintenanceMode) { showToast('Το σύστημα αναβαθμίζεται. Παρακαλούμε δοκιμάστε σε λίγο!', 'warn'); return; }
  if (_redeemInProgress) return;
  const now = Date.now();
  if (now - _redeemLastAt < _REDEEM_COOLDOWN) { showToast('⏳ Περίμενε λίγο...'); return; }
  _redeemLastAt = now;
  _redeemInProgress = true;
  try { await _startRedemptionInner(points, label); } catch(e) { showToast('❌ ' + e.message); } finally { _redeemInProgress = false; }
}

async function _startRedemptionInner(points, label) {
  const pts = state.foundCustomer?.points || 0;
  if (!Number.isInteger(points) || points <= 0) { showToast('⚠️ Μη έγκυρο πακέτο εξαργύρωσης.'); return; }
  if (pts < points) { showToast('⚠️ Ανεπαρκείς πόντοι.'); return; }

  await _cancelActiveRedemption('replaced-by-new-code');

  const uid = state.foundCustomer?.uid || '';
  if (uid) {
    let existing = null;
    try { existing = await _findExistingActivePendingByUser(uid); }
    catch(e) { showToast('❌ Σφάλμα σύνδεσης: ' + e.message); return; }
    if (existing) {
      _activeRedemptionDocId = existing.id;
      _watchRedemptionDoc(existing.id);
      const expMs = _parseExpiryMs(existing);
      if (expMs) _startCountdown(new Date(expMs));
      document.getElementById('ro-reward').textContent = existing.label || label;
      document.getElementById('ro-pts').textContent    = (existing.points || points) + ' πόντοι';
      const exCode = String(existing.code || '');
      document.getElementById('ro-code').textContent   = exCode.length === 6 ? exCode.slice(0,3) + ' ' + exCode.slice(3) : exCode;
      const _exOverlay = document.getElementById('redeem-overlay');
      _exOverlay.querySelectorAll('.ro-laser').forEach(l => { l.style.animation = 'none'; l.offsetHeight; l.style.animation = ''; });
      _exOverlay.style.display = 'flex';
      _trapFocus(_exOverlay);
      return;
    }
  }

  const code = await _generateUniquePendingCode();
  if (!code) { showToast('❌ Προσωρινό σφάλμα δημιουργίας κωδικού. Δοκίμασε ξανά.'); return; }

  const _DISC_MAP = {1000:5, 2500:15, 4000:30};
  const discount = _DISC_MAP[points];
  if (!discount) { showToast('⚠️ Μη έγκυρο πακέτο εξαργύρωσης.'); return; }
  const now = new Date();
  const expires = new Date(now.getTime() + 5*60*1000);
  document.getElementById('ro-reward').textContent = label;
  document.getElementById('ro-pts').textContent    = points + ' πόντοι';
  document.getElementById('ro-code').textContent   = code.slice(0,3) + ' ' + code.slice(3);
  const _rdOverlay = document.getElementById('redeem-overlay');
  _rdOverlay.querySelectorAll('.ro-laser').forEach(l => { l.style.animation = 'none'; l.offsetHeight; l.style.animation = ''; });
  _rdOverlay.style.display = 'flex';
  _trapFocus(_rdOverlay);

  const qrEl = document.getElementById('ro-qr');
  qrEl.innerHTML = '';
  try {
    new QRCode(qrEl, {
      text: 'IPEAR-REDEEM:' + code,
      width: 180, height: 180,
      colorDark: '#111111', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch(e) { logger.warn('QR gen error:', e); }

  _startCountdown(expires);

  const authUid = window._auth?.currentUser?.uid;
  if (authUid && state.foundCustomer.id !== authUid) {
    try { await _migrateCustomerToUid(state.foundCustomer.id, authUid); } catch(me) {
      logger.warn('[redeem-migration] failed:', me?.code, me?.message, 'foundId:', state.foundCustomer.id, 'authUid:', authUid);
    }
  }

  const custId = state.foundCustomer.id;
  try {
    const docRef = await window._addDoc(window._col(window._db,'ipear_redemptions'), {
      code, customerId:custId, customerUid:authUid||state.foundCustomer.uid||'',
      customerName:state.foundCustomer.name, card:state.foundCustomer.card,
      points, discount, label,
      status: 'pending',
      createdAt:now.toISOString(), expiresAt:expires.toISOString(), used:false,
      createdAtTs: now,
      expiresAtTs: expires
    });
    _activeRedemptionDocId = docRef.id;
    _watchRedemptionDoc(docRef.id);
  } catch(e) {
    logger.error('[redeem-save] ERROR:', e?.code, e?.message, 'custId:', custId, 'authUid:', authUid);
    // Map Firestore failure codes to actionable Greek copy. The generic
    // "Αποτυχία αποθήκευσης" message previously hid the most common causes
    // (in-app browser permission-denied, expired session, offline).
    let msg = '❌ Αποτυχία αποθήκευσης κωδικού. Δοκίμασε ξανά.';
    if (e?.code === 'permission-denied') {
      msg = window._inAppBrowser
        ? `❌ Ο browser του ${window._inAppBrowser} μπλοκάρει την εξαργύρωση. Άνοιξε την εφαρμογή σε Safari/Chrome.`
        : '❌ Δεν επιτρέπεται η εξαργύρωση. Κάνε logout/login και ξαναδοκίμασε.';
    } else if (e?.code === 'unauthenticated' || !window._auth?.currentUser) {
      msg = '❌ Έληξε η συνεδρία. Κάνε ξανά σύνδεση.';
    } else if (e?.code === 'unavailable' || !navigator.onLine) {
      msg = '📡 Πρόβλημα σύνδεσης. Έλεγξε internet και ξαναδοκίμασε.';
    } else if (e?.message) {
      msg = '❌ ' + e.message;
    }
    showToast(msg, 'red');
    document.getElementById('redeem-overlay').style.display = 'none';
    clearInterval(_redeemTimer);
  }
}

let _redeemExpires = null;

function _redeemTick() {
  const dot = document.getElementById('ro-dot'), tmr = document.getElementById('ro-timer');
  if (!_redeemExpires || !tmr) return;
  const rem = _redeemExpires - Date.now();
  if (rem <= 0) {
    clearInterval(_redeemTimer);
    _redeemExpires = null;
    _stopRedeemSnapshot();
    tmr.textContent = '⏰ Ο κωδικός έληξε'; tmr.className = 'ro-timer exp'; if (dot) dot.style.background = '#ff3b30';
    tmr.setAttribute('aria-live', 'assertive');
    _cancelActiveRedemption('expired');
    return;
  }
  const m = Math.floor(rem / 60000), s = Math.floor((rem % 60000) / 1000);
  tmr.textContent = `Λήγει σε ${m}:${String(s).padStart(2,'0')}`;
  tmr.className = 'ro-timer' + (rem < 60000 ? ' warn' : '');
  if (dot) dot.style.background = rem < 60000 ? '#ff9500' : 'var(--g)';
}

function _startCountdown(expires) {
  clearInterval(_redeemTimer);
  _redeemExpires = expires;
  _redeemTick();
  _redeemTimer = setInterval(_redeemTick, 500);
}

export function cancelRedemption() {
  clearInterval(_redeemTimer);
  _redeemExpires = null;
  _stopRedeemSnapshot();
  const _ro = document.getElementById('redeem-overlay');
  _ro.style.display='none';
  _ro.querySelectorAll('.ro-laser').forEach(l => { l.style.animation = 'none'; l.offsetHeight; l.style.animation = ''; });
  _releaseFocus();
  _cancelActiveRedemption('user-cancelled');
}

// ════════════════════════════════════════
//  CLICK-OUTSIDE + ESCAPE HANDLERS
// ════════════════════════════════════════
document.addEventListener('click', (e) => {
  const ov = document.getElementById('redeem-overlay');
  if (!ov || ov.style.display !== 'flex') return;
  if (e.target === ov) cancelRedemption();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const oqr = document.getElementById('offer-qr-overlay');
  if (oqr && oqr.style.display === 'flex') { cancelOfferQR(); return; }
  const oc = document.getElementById('offer-confirm');
  if (oc && oc.style.display === 'flex') { closeOfferConfirm(); return; }
  const os = document.getElementById('offer-sheet');
  if (os && os.classList.contains('show')) { closeOfferSheet(); return; }
  const ov = document.getElementById('redeem-overlay');
  if (ov && ov.style.display === 'flex') { cancelRedemption(); return; }
  const po = document.getElementById('push-onboard');
  if (po && po.style.display === 'flex') { _dismissPushOnboard(); return; }
});

// ════════════════════════════════════════
//  APP INIT (startApp)
// ════════════════════════════════════════
export async function startApp() {
  if (!state.foundCustomer) {
    logger.error('[startApp] ABORT — foundCustomer is null');
    showToast('⚠️ Δεν φόρτωσε ο λογαριασμός. Κλείσε και ξαναάνοιξε.', 'red');
    return;
  }
  const authUid = window._auth?.currentUser?.uid;
  if (authUid && state.foundCustomer && state.foundCustomer.id !== authUid) {
    try { await _migrateCustomerToUid(state.foundCustomer.id, authUid); } catch(e) { logger.warn('[migration]', e); }
  }
  const c   = state.foundCustomer;
  const pts = c.points||0;
  const tot = c.totalPoints||pts;
  const t   = tier(tot);
  const ini = (c.name||'?').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();
  const pct = t.next ? Math.min(100,Math.round(((tot-t.floor)/(t.next-t.floor))*100)) : 100;

  _applyTierColors(t.cls);
  _lastKnownTierCls = t.cls;

  _applyI18nLabels();

  document.getElementById('hdr-pts').textContent = pts.toLocaleString('el-GR');

  _updateGreeting();
  document.getElementById('h-name').textContent = (c.name||'').split(' ')[0] + ' 👋';
  document.getElementById('h-pts').textContent  = pts.toLocaleString('el-GR');
  document.getElementById('h-tier-icon').textContent = t.icon;
  document.getElementById('h-tier-name').textContent = t.name;
  if (t.next) {
    const nName = t.next===1000?'🥈 Silver':t.next===3000?'🥇 Gold':t.next===6000?'💎 Diamond':'👑 Platinum';
    document.getElementById('h-prog-lbl').textContent = `${tot.toLocaleString('el-GR')} / ${t.next.toLocaleString('el-GR')} → ${nName}`;
    document.getElementById('h-prog-pct').textContent = pct + '%';
  } else {
    document.getElementById('h-prog-lbl').textContent = '👑 Platinum — Ανώτατη κατάταξη!';
    document.getElementById('h-prog-pct').textContent = '100%';
  }
  const _progFill = document.getElementById('h-prog-fill');
  _progFill.style.transition = 'none';
  _progFill.style.width = '0%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    _progFill.style.transition = '';
    _progFill.style.width = pct + '%';
  }));
  renderHomeRewards(pts);

  document.getElementById('lc-tier-icon').textContent     = t.icon;
  document.getElementById('lc-tier-name').textContent     = t.name;
  document.getElementById('lc-tier-icon-big').textContent = t.icon;
  document.getElementById('lc-card-num').textContent      = c.card;
  document.getElementById('lc-name').textContent          = c.name;
  document.getElementById('lc-pts').textContent           = pts.toLocaleString('el-GR');
  document.getElementById('qr-card-num').textContent      = c.card;

  try { localStorage.setItem('ipear_offline_card', JSON.stringify({ name: c.name, card: c.card, points: pts, tier: t.name, tierIcon: t.icon })); } catch(_) {}

  document.getElementById('rw-pts').textContent      = pts.toLocaleString('el-GR');
  document.getElementById('rw-tier-icon').textContent = t.icon;
  renderRewardsList(pts);

  document.getElementById('pr-av').textContent    = ini;
  document.getElementById('pr-name').textContent  = c.name;
  document.getElementById('pr-card').textContent  = c.card;
  document.getElementById('pr-tier').textContent  = t.icon + ' ' + t.name;
  document.getElementById('ref-code').textContent = c.card;
  document.getElementById('ref-count-val').textContent = c.referralCount || 0;
  document.getElementById('pr-ticon').textContent = t.icon;
  document.getElementById('pr-tname').textContent = t.name;
  document.getElementById('pr-tpct').textContent  = pct + '%';
  const _tpFill = document.getElementById('pr-tprog');
  _tpFill.style.transition = 'none';
  _tpFill.style.width = '0%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    _tpFill.style.transition = '';
    _tpFill.style.width = pct + '%';
  }));
  if (t.next) {
    const nName = t.next===1000?'🥈 Silver':t.next===3000?'🥇 Gold':t.next===6000?'💎 Diamond':'👑 Platinum';
    document.getElementById('pr-tsub').textContent = `${tot.toLocaleString('el-GR')} / ${t.next.toLocaleString('el-GR')} → ${nName}`;
  } else {
    document.getElementById('pr-tsub').textContent = '👑 Ανώτατη κατάταξη!';
  }

  loadOffersData();
  loadHistory();
  startLiveListener();
  _startMaintenanceListener();
  _startEmailVerifyFlow();

  if ('Notification' in window && Notification.permission !== 'denied') {
    const pushSection = document.getElementById('push-section');
    if (pushSection) pushSection.style.display = 'block';
    const pushActive = Notification.permission === 'granted' && !!c.fcmToken;
    _setPushUI(pushActive);
  }

  if (c.birthday) {
    const bday = new Date(c.birthday + 'T00:00:00');
    const now  = new Date();
    if (bday.getMonth() === now.getMonth() && bday.getDate() === now.getDate()) {
      setTimeout(_showBirthdayToast, 1500);
      _awardBirthdayBonus(c);
    }
  }

  // Retry any pending signup bonuses that didn't land at registration time
  // (worker outage, Brevo email failure pre-fix, transient 5xx). Both worker
  // endpoints are idempotent via the marketingWelcomeProcessed / referralProcessed
  // flags, so a no-op when the bonus is already credited.
  _retryPendingBonuses(c).catch(() => {});

  _bindHeaderScroll(document.querySelector('.tab-pane.active'));
}

async function _retryPendingBonuses(c) {
  const authUser = window._auth?.currentUser;
  if (!authUser) return;
  const needsWelcome  = c.marketingOptIn === true && c.marketingWelcomeProcessed !== true;
  const needsReferral = !!c.referredBy && c.referralProcessed !== true;
  if (!needsWelcome && !needsReferral) return;
  try {
    const idToken = await authUser.getIdToken(true);
    if (needsWelcome) {
      fetch(_WORKER_URL + '/send-welcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, name: c.name || '', marketingOptIn: true }),
      }).catch(() => {});
    }
    if (needsReferral) {
      fetch(_WORKER_URL + '/process-referral', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }).catch(() => {});
    }
  } catch (e) {
    logger.warn('[retry-bonuses] idToken failed:', e?.message || e);
  }
}

// ════════════════════════════════════════════════════════════════════════
//  EMAIL-VERIFY BANNER + POLLING
// ════════════════════════════════════════════════════════════════════════
//
// Dual-verification model (paired with SMS OTP already done at signup):
//   • SMS OTP confirms phone → gates customer doc creation.
//   • Email verification confirms inbox → gates +50/+100 bonuses
//     (server-side CRIT-1 fix on /send-welcome and /process-referral).
//
// This function shows a persistent top banner whenever the signed-in user
// has emailVerified=false. Polls authUser.reload() every 30s; when the user
// flips to verified, the banner is removed, a success toast is shown, and
// /send-welcome + /process-referral are re-triggered so any pending bonuses
// finally land.
//
// Also auto-detects the return from Firebase's verify page: if URL contains
// `?verified=1` (the continueUrl we asked Firebase to redirect to), we run
// one immediate reload + bonus retrigger before settling into the 30s loop.
let _emailVerifyTimer = null;
let _emailVerifyLastResend = 0;
const _EMAIL_VERIFY_RESEND_COOLDOWN_MS = 60_000;
const _EMAIL_VERIFY_POLL_MS = 30_000;

function _startEmailVerifyFlow() {
  // Email verification removed — SMS OTP at signup is the sole verification.
  // Bonuses are credited immediately by the Worker on /send-welcome and
  // /process-referral calls fired from _finishRegistration. No polling needed.
}

function _stopEmailVerifyPolling() {
  if (_emailVerifyTimer) { clearInterval(_emailVerifyTimer); _emailVerifyTimer = null; }
}

async function _checkEmailVerified(fastPath = false) {
  const authUser = window._auth?.currentUser;
  if (!authUser) { _stopEmailVerifyPolling(); return; }
  try {
    await authUser.reload();
  } catch (e) {
    logger.warn('[verify-poll] reload failed:', e?.message || e);
    return;
  }
  if (authUser.emailVerified !== true) return;

  // ✅ Verified — celebrate, retrigger bonuses, stop polling.
  _stopEmailVerifyPolling();
  _hideEmailVerifyBanner();
  showToast('🎉 Email επιβεβαιώθηκε! Τα bonuses ενεργοποιούνται…', 'green');

  // Retrigger Worker bonuses now that the token will pass emailVerified gate.
  try {
    const idToken = await authUser.getIdToken(true);
    const name = state.foundCustomer?.name || authUser.displayName || '';
    const marketingOptIn = !!state.foundCustomer?.marketingOptIn;
    // /send-welcome — idempotent via marketingWelcomeProcessed
    fetch(_WORKER_URL + '/send-welcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, name, marketingOptIn }),
    }).catch(() => {});
    // /process-referral — idempotent via referralProcessed flag in queue doc
    fetch(_WORKER_URL + '/process-referral', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }).catch(() => {});
  } catch (e) {
    logger.warn('[verify-poll] bonus retrigger failed:', e?.message || e);
  }

  if (fastPath) {
    // Came back via ?verified=1 — give a longer toast trail.
    setTimeout(() => showToast('🎁 Έλεγξε το ιστορικό για τους πόντους που μόλις προστέθηκαν!', 'green'), 2500);
  }
}

function _showEmailVerifyBanner() {
  // Banner removed by request — verification polling keeps running silently so
  // that the +50/+100 bonuses still trigger when the user clicks the email link.
  // Resend button is available in the profile tab if we add one later.
}

function _hideEmailVerifyBanner() {
  const el = document.getElementById('email-verify-banner');
  if (el) el.remove();
  document.body.style.paddingTop = '';
}

async function _resendVerifyEmail() {
  const btn = document.getElementById('email-verify-resend');
  const now = Date.now();
  if (now - _emailVerifyLastResend < _EMAIL_VERIFY_RESEND_COOLDOWN_MS) {
    const sec = Math.ceil((_EMAIL_VERIFY_RESEND_COOLDOWN_MS - (now - _emailVerifyLastResend)) / 1000);
    showToast(`⏳ Δοκίμασε ξανά σε ${sec}s.`, 'orange');
    return;
  }
  _emailVerifyLastResend = now;
  if (btn) { btn.disabled = true; btn.style.opacity = '.6'; btn.textContent = 'Αποστολή…'; }

  try {
    const authUser = window._auth?.currentUser;
    if (!authUser) throw new Error('not signed in');
    const idToken = await authUser.getIdToken(true);
    const res = await fetch(_WORKER_URL + '/send-verification-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.alreadyVerified) {
      _hideEmailVerifyBanner();
      _stopEmailVerifyPolling();
      showToast('✅ Το email σου είναι ήδη επιβεβαιωμένο!', 'green');
      return;
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast('📨 Στάλθηκε! Έλεγξε το inbox σου (και τον φάκελο spam).', 'green');
  } catch (e) {
    logger.warn('[verify-resend] error:', e?.message || e);
    showToast('❌ Αποτυχία αποστολής. Δοκίμασε σε λίγο.', 'red');
    _emailVerifyLastResend = 0; // allow immediate retry on hard failure
  } finally {
    if (btn) {
      setTimeout(() => {
        btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Στείλε ξανά';
      }, 2000);
    }
  }
}

// ════════════════════════════════════════
//  PWA INSTALL
// ════════════════════════════════════════
let _deferredPrompt = null;
const _pwaKey = 'ipear_pwa_dismissed';

function _isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function _isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.matchMedia('(display-mode: fullscreen)').matches  ||
         window.navigator.standalone === true;
}

try { screen.orientation.lock('portrait-primary').catch(() => {}); } catch(_) {}

if (_isStandalone()) {
  document.documentElement.classList.add('pwa-standalone');

  const _sApp = document.getElementById('s-app');
  let _lockedH = 0;

  function _measureFillAvailable() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:-webkit-fill-available;visibility:hidden;pointer-events:none;z-index:-1';
    document.documentElement.appendChild(probe);
    const h = probe.offsetHeight;
    document.documentElement.removeChild(probe);
    return h > 100 ? h : 0;
  }

  function _applyLockedHeight() {
    if (!_lockedH && window.innerWidth < window.innerHeight) {
      _lockedH = _measureFillAvailable() || window.innerHeight;
    }
    if (_lockedH && _sApp) {
      _sApp.style.height = _lockedH + 'px';
    }
  }

  _applyLockedHeight();
  window.addEventListener('resize', () => {
    requestAnimationFrame(_applyLockedHeight);
  }, {passive:true});
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredPrompt = e;
  const ib = document.getElementById('install-app-section');
  if (ib && !_isStandalone()) ib.style.display = '';
});

function _showPWABanner(type) {
  const banner = document.getElementById('pwa-banner');
  document.getElementById('pwa-ios').style.display     = type === 'ios'     ? '' : 'none';
  document.getElementById('pwa-android').style.display = type === 'android' ? '' : 'none';
  banner.style.display = 'block';
}

function dismissPWA() {
  document.getElementById('pwa-banner').style.display = 'none';
  localStorage.setItem(_pwaKey, '1');
}

async function triggerInstall() {
  if (!_deferredPrompt) return;
  _deferredPrompt.prompt();
  const { outcome } = await _deferredPrompt.userChoice;
  if (outcome === 'accepted') {
    dismissPWA();
    const ib = document.getElementById('install-app-section');
    if (ib) ib.style.display = 'none';
  }
  _deferredPrompt = null;
}

function _installApp() {
  if (_deferredPrompt) {
    triggerInstall();
  } else if (_isIOS()) {
    _showPWABanner('ios');
  }
}

// ════════════════════════════════════════
//  DOMContentLoaded
// ════════════════════════════════════════
{
  if (_isIOS() && !_isStandalone()) {
    const ib = document.getElementById('install-app-section');
    if (ib) ib.style.display = '';
  }
  const dayEl  = document.getElementById('reg-bday-d');
  const yearEl = document.getElementById('reg-bday-y');
  if (dayEl) {
    for (let d = 1; d <= 31; d++) {
      const o = document.createElement('option');
      o.value = d; o.textContent = d;
      dayEl.appendChild(o);
    }
  }
  if (yearEl) {
    const curYear = new Date().getFullYear();
    for (let y = curYear - 5; y >= curYear - 100; y--) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y;
      yearEl.appendChild(o);
    }
  }
}

// ════════════════════════════════════════
//  visualViewport nav pinning + keyboard
// ════════════════════════════════════════
(function() {
  const nav  = document.querySelector('.bottom-nav');
  if (!nav) return;
  const standalone = _isStandalone();

  function _pinNav() {
    // Re-detect standalone every tick — iOS sometimes sets navigator.standalone
    // a bit late and the IIFE-time value can be stale.
    const isStd = _isStandalone();
    if (isStd) {
      nav.style.setProperty('position', 'fixed', 'important');
      nav.style.setProperty('left', '0', 'important');
      nav.style.setProperty('right', '0', 'important');
      nav.style.setProperty('height', 'auto', 'important');
      nav.style.setProperty('transform', 'none', 'important');
      nav.style.setProperty('will-change', 'auto', 'important');
      nav.style.setProperty('bottom', '-34px', 'important');
      nav.style.setProperty('padding-bottom', '34px', 'important');
      nav.style.setProperty('box-shadow', 'none', 'important');
      nav.style.setProperty('border-bottom', 'none', 'important');
      const navH = nav.offsetHeight || 58;
      document.querySelectorAll('.tab-pane').forEach(p => {
        p.style.paddingBottom = (navH + 20) + 'px';
      });
      return;
    }
    if (!window.visualViewport) return;
    const vv  = window.visualViewport;
    const hiddenBelow = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
    // Heuristic: only push the nav up if at least 50px is hidden — that's a real
    // Safari URL bar / toolbar. Smaller values are the iPhone home-indicator
    // safe-area which we want flush at bottom:0 (creates the spurious white strip).
    const realToolbar = hiddenBelow >= 50 ? hiddenBelow : 0;
    nav.style.bottom = realToolbar + 'px';
    nav.style.top    = '';
    const navH = nav.offsetHeight || 58;
    document.querySelectorAll('.tab-pane').forEach(p => {
      p.style.paddingBottom = (realToolbar + navH + 24) + 'px';
    });
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', _pinNav, {passive:true});
    window.visualViewport.addEventListener('scroll', _pinNav, {passive:true});
  }
  window.addEventListener('resize', _pinNav, {passive:true});
  _pinNav();
  requestAnimationFrame(_pinNav);
  if (standalone) {
    setTimeout(_pinNav, 100);
    setTimeout(_pinNav, 500);
    setTimeout(_pinNav, 1500);
  }

  const KB_THRESHOLD = 150;
  let _kbOpen = false;

  function _onKbChange() {
    if (!window.visualViewport) return;
    const vvH = window.visualViewport.height;
    const winH = window.innerHeight;
    const isOpen = (winH - vvH) > KB_THRESHOLD;

    if (isOpen && !_kbOpen) {
      _kbOpen = true;
      nav.style.display = 'none';
      requestAnimationFrame(() => {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    } else if (!isOpen && _kbOpen) {
      _kbOpen = false;
      nav.style.display = '';
      _pinNav();
    }
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', _onKbChange, {passive:true});
  }

  document.addEventListener('focusin', (e) => {
    if (!window.visualViewport && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
    }
  }, {passive:true});
})();

// ════════════════════════════════════════
//  SERVICE WORKER
// ════════════════════════════════════════
registerServiceWorker();

// ════════════════════════════════════════
//  FIREBASE-READY HANDLER
// ════════════════════════════════════════
function _handleFirebaseReady() {
  if (_handleFirebaseReady._done) return;
  _handleFirebaseReady._done = true;
  logger.log('%c[MAIN] 🔥 firebase-ready HANDLER RUNNING', 'color:#ff6600;font-weight:bold;font-size:16px');
  if (window.DEMO) {
    const dh = document.getElementById('demo-hint');
    if (dh) dh.style.display = 'block';
  }
  const saved = _getSavedAccount();
  logger.log('%c[MAIN] _getSavedAccount() =', 'color:#ff6600;font-weight:bold;font-size:14px', saved ? JSON.stringify(saved) : 'NULL (no remember-me data)');
  logger.log('%c[MAIN] auth.currentUser =', 'color:#0088ff;font-weight:bold;font-size:14px', window._auth?.currentUser ? '✅ ' + window._auth.currentUser.email : '❌ NULL');
  if (saved) {
    logger.log('%c[MAIN] → Calling autoLogin(' + saved.email + ')', 'color:#00cc00;font-weight:bold;font-size:14px');
    autoLogin(saved.email);
  } else {
    logger.log('%c[MAIN] → No saved account, showing login screen', 'color:#ff0000;font-weight:bold;font-size:14px');
    _showLogin();
  }
  _startMaintenanceListener();
}
_handleFirebaseReady._done = false;

window.addEventListener('firebase-ready', _handleFirebaseReady);

// firebase-init.js uses top-level await and finishes BEFORE this module body runs,
// so the 'firebase-ready' event has already fired — check the flag immediately.
if (window._firebaseReady) {
  logger.log('%c[MAIN] ⚡ firebase-ready already fired (flag=true), running handler immediately', 'color:#ff6600;font-weight:bold;font-size:16px');
  _handleFirebaseReady();
}

// Fallback: if firebase-ready hasn't arrived after 4s (e.g. ad-blocker delays), show login
setTimeout(() => { if (!_handleFirebaseReady._done) _showLogin(); }, 4000);
window.addEventListener('pageshow', (e) => { if (e.persisted && !_handleFirebaseReady._done) _showLogin(); });

setTimeout(() => {
  if (!window._db && !window.DEMO) {
    const err = document.getElementById('phone-err');
    if (err) err.innerHTML = '⚠️ Κάποια στοιχεία δεν φόρτωσαν. Αν χρησιμοποιείτε <b>ad-blocker</b>, απενεργοποιήστε τον για αυτή τη σελίδα και ανανεώστε.';
  }
}, 5000);

// ════════════════════════════════════════
//  REFERRAL URL AUTO-FILL
// ════════════════════════════════════════
setupReferralAutoFill();

// ════════════════════════════════════════
//  WINDOW GLOBALS (for HTML onclick handlers)
// ════════════════════════════════════════
window.switchTab = switchTab;
window.startRedemption = startRedemption;
window.cancelRedemption = cancelRedemption;
window.showScreen = showScreen;
window.logout = logout;
window.requestAccountDeletion = requestAccountDeletion;
window.submitPhone = submitPhone;
window.submitCreatePass = submitCreatePass;
window.goToPhone = goToPhone;
window.openForgotPass = openForgotPass;
window.submitForgotPass = submitForgotPass;
window.backToLogin = backToLogin;
window.openRegister = openRegister;
window.submitRegister = submitRegister;
window.submitOTP = submitOTP;
window.resendOTP = resendOTP;
window.cancelOTP = cancelOTP;
window.togglePassVis = togglePassVis;
window.openOfferSheet = openOfferSheet;
window.closeOfferSheet = closeOfferSheet;
window.offerRedeemStep1 = offerRedeemStep1;
window.closeOfferConfirm = closeOfferConfirm;
window.offerGenerateQR = offerGenerateQR;
window.cancelOfferQR = cancelOfferQR;
window.offerGenerateEshopCoupon = offerGenerateEshopCoupon;
window._copyEshopCoupon = _copyEshopCoupon;
window.copyReferral = copyReferral;
window.shareReferral = shareReferral;
window._expandLeaderboard = _expandLeaderboard;
window._collapseLb = _collapseLb;
window._toggleHistory = _toggleHistory;
window.loadHistoryMore = loadHistoryMore;
window._dismissPushOnboard = _dismissPushOnboard;
window._acceptPushOnboard = _acceptPushOnboard;
window._installApp = _installApp;
window.dismissPWA = dismissPWA;
window.triggerInstall = triggerInstall;
window.generateQR = generateQR;
