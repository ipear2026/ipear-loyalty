// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Authentication, lock screen, session restore, keep-alive
//
//  Extracted from src/admin-main.js during the Sprint 3 god-module split.
//  Owns:
//   • Lock screen flow (manual unlock + 5-fail / 60s lockout)
//   • Silent auto-restore from Firebase Auth IndexedDB session
//   • Logout (signOut + listener cleanup + UI reset)
//   • Online/offline indicator
//   • Keep-alive refresh (5 min interval + visibilitychange + pageshow + focus)
//
//  Cross-domain hooks (configured via initAdminAuth):
//   • onLoginComplete()    — runs after _completeAdminAuth finishes auth +
//                            store resolution. admin-main.js wires the actual
//                            data-loading calls (loadStats, loadTx, loadAll, …).
//   • onLogout()           — runs after auth state cleared. admin-main.js wipes
//                            its local cid/cdata/_storeId/_activeSegment + UI.
//   • keepAliveRefresh()   — runs on online/visibility/focus/interval. Same
//                            split: this module owns timing, caller owns work.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../logger.js';
import { toast } from './ui.js';
import { authState } from './auth-state.js';
import { clearWorkerSecret as _clearWorkerSecret } from './worker-secret.js';

// ── Module state (lockout + actor tracking) ───────────────────────────────
let _adminAttempts = 0;
let _adminLockUntil = 0;
let _autoRestoreAttempted = false;
let _adminLastRefresh = 0;
const _ADMIN_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

// ── Cross-domain hooks (set via initAdminAuth) ────────────────────────────
let _hooks = {
  onLoginComplete: () => {},
  onLogout: () => {},
  keepAliveRefresh: () => {},
};

export function initAdminAuth(hooks) {
  _hooks = { ..._hooks, ...hooks };
}

// ══════════════════════════════════════
//  ONLINE INDICATOR
// ══════════════════════════════════════
export function setOnline(on) {
  document.getElementById('cdot').className = 'conn-dot ' + (on ? 'ok' : 'err');
  document.getElementById('ctxt').textContent = on ? 'Firebase' : 'OFFLINE';
  if (!on) toast('🔴 Χάθηκε το ίντερνετ!', 'error');
}

// ══════════════════════════════════════
//  POST-AUTH BOOTSTRAP
// ══════════════════════════════════════
// Shared post-auth bootstrap. Used by manual unlock() AND by silent
// _tryAdminAutoRestore() when Firebase Auth carries a live session forward
// (page reload, 30-min sleep recovery, Chrome memory-saver tab restore).
export async function _completeAdminAuth(user) {
  authState.actorUid = user?.uid || null;
  authState.storeId = null;
  authState.storeName = '—';

  const adminRef  = window._doc(window._db, 'ipear_admins', user.uid);
  const adminSnap = await window._getDoc(adminRef);
  if (!window.DEMO && !adminSnap.exists()) {
    await window._adminSignOut().catch(() => {});
    throw new Error('not-admin');
  }
  authState.storeId = adminSnap.data()?.storeid || null;

  if (authState.storeId) {
    try {
      const storeSnap = await window._getDoc(window._doc(window._db, 'ipear_stores', authState.storeId));
      if (storeSnap.exists()) {
        authState.storeName = storeSnap.data().name || '—';
        const badge = document.getElementById('store-badge');
        if (badge) { badge.textContent = '🏪 ' + authState.storeName; badge.style.display = 'inline-block'; }
        const regBadge = document.getElementById('reg-store-badge');
        if (regBadge) { regBadge.textContent = '🏪 Εγγραφή για: ' + authState.storeName; regBadge.style.display = 'block'; }
      }
    } catch(_) {}
  }

  authState.authenticated = true;
  document.getElementById('lock').style.display = 'none';
  document.getElementById('lock-in').value  = '';
  document.getElementById('lock-email').value = '';
  document.getElementById('admin-logout-btn').style.display = 'flex';
  _hooks.onLoginComplete();
}

// Silent auto-restore: if Firebase Auth has a valid session in the tab's
// IndexedDB (set on first unlock with SESSION persistence), skip the email
// /password lock screen entirely. Falls back to the lock screen on any error.
export async function _tryAdminAutoRestore() {
  if (_autoRestoreAttempted) return;
  _autoRestoreAttempted = true;
  const user = window._auth?.currentUser;
  if (!user) return;  // no session → keep lock screen visible
  try { await _completeAdminAuth(user); }
  catch(e) {
    logger.warn('[ADMIN] auto-restore failed:', e.message);
    // Lock screen is already visible by default — nothing to do
  }
}

// ══════════════════════════════════════
//  MANUAL UNLOCK
// ══════════════════════════════════════
export async function unlock() {
  const email = document.getElementById('lock-email').value.trim().toLowerCase();
  const pass  = document.getElementById('lock-in').value;
  const err   = document.getElementById('lock-err');
  const btn   = document.getElementById('lock-btn');
  err.textContent = '';
  if (!email || !email.includes('@')) { err.textContent = '⚠️ Εισάγετε email.'; return; }
  if (!pass) { err.textContent = '⚠️ Εισάγετε κωδικό.'; return; }
  if (Date.now() < _adminLockUntil) {
    const secs = Math.ceil((_adminLockUntil - Date.now()) / 1000);
    err.textContent = `🔒 Κλειδωμένο — δοκίμασε σε ${secs}s`; return;
  }
  btn.disabled = true; btn.textContent = '⏳';
  try {
    const user = await window._adminSignIn(email, pass);
    await _completeAdminAuth(user);
  } catch(e) {
    if (e.message === 'not-admin') {
      err.textContent = '⛔ Ο λογαριασμός δεν έχει δικαιώματα admin.';
      btn.disabled = false; btn.textContent = 'Είσοδος →'; return;
    }
    _adminAttempts++;
    if (_adminAttempts >= 5) {
      _adminLockUntil = Date.now() + 60000; // 60s lockout after 5 failures
      _adminAttempts = 0;
    }
    const msgs = {
      'auth/wrong-password':        '❌ Λάθος κωδικός.',
      'auth/user-not-found':        '❌ Δεν βρέθηκε λογαριασμός.',
      'auth/invalid-credential':    '❌ Λάθος email ή κωδικός.',
      'auth/too-many-requests':     '⚠️ Πάρα πολλές προσπάθειες. Δοκίμασε αργότερα.',
      'auth/invalid-email':         '⚠️ Μη έγκυρο email.',
    };
    err.textContent = msgs[e.code] || ('❌ ' + (e.message || e.code));
  }
  btn.disabled = false; btn.textContent = 'Είσοδος →';
}

// ══════════════════════════════════════
//  LOGOUT
// ══════════════════════════════════════
export function adminLogout() {
  try { window._adminSignOut(); } catch(_) {}
  authState.actorUid = null;
  authState.authenticated = false;
  authState.storeId = null;
  authState.storeName = '—';
  // Clear sessionStorage (worker secret lives only for this tab session)
  _clearWorkerSecret();
  localStorage.removeItem('ipear_worker_url');
  // Clear UI: customer result
  document.getElementById('cust-result')?.classList.remove('show');
  const sinput = document.getElementById('sinput');
  if (sinput) sinput.value = '';
  const whEl = document.getElementById('worker-health');
  if (whEl) whEl.style.display = 'none';
  // Clear UI: store badges
  const badge = document.getElementById('store-badge');
  if (badge) { badge.textContent = ''; badge.style.display = 'none'; }
  const regBadge = document.getElementById('reg-store-badge');
  if (regBadge) { regBadge.textContent = ''; regBadge.style.display = 'none'; }
  // Clear UI: lock screen inputs
  document.getElementById('lock-email').value = '';
  document.getElementById('lock-in').value = '';
  document.getElementById('lock-err').textContent = '';
  document.getElementById('admin-logout-btn').style.display = 'none';
  document.getElementById('lock').style.display = 'flex';
  // Caller-owned wipe: domain-specific state (cid/cdata/_activeSegment/_storeId
  // mirror) + listener stops + tab reset. admin-main.js handles those via
  // the onLogout hook so this module stays free of cross-domain imports.
  _hooks.onLogout();
}

// ══════════════════════════════════════
//  KEEP-ALIVE
// ══════════════════════════════════════
// Auto-refresh data + recover from sleep/background.
export function _adminKeepAliveRefresh() {
  if (!authState.authenticated || !navigator.onLine) return;
  const now = Date.now();
  if (now - _adminLastRefresh < 30000) return; // debounce 30s
  _adminLastRefresh = now;
  try { _hooks.keepAliveRefresh(); } catch(e) { logger.warn('[keepalive] refresh error:', e.message); }
}

// ══════════════════════════════════════
//  MODULE SIDE-EFFECTS (run once at import)
// ══════════════════════════════════════
// Online/offline + visibilitychange + pageshow + focus listeners and the
// periodic 5-min interval — these all need to be wired exactly once. ESM
// guarantees single-evaluation per module, so importing admin-auth.js from
// admin-main.js attaches them safely without risk of double-binding.

window.addEventListener('online',  () => { setOnline(true); _adminKeepAliveRefresh(); });
window.addEventListener('offline', () => setOnline(false));

setOnline(navigator.onLine);

// firebase-init.js already executed (imported by admin-main.js) — paint DEMO
// badge synchronously here; the lock screen DOM is in admin.html so it exists
// by the time this module runs.
if (window.DEMO) {
  const demoEl = document.getElementById('lock-demo');
  if (demoEl) demoEl.style.display = 'block';
}

// Bootstrap: kick auto-restore as soon as firebase-init.js finishes loading.
// firebase-init uses top-level await so by the time this module runs the flag
// may already be set; otherwise wait for the event.
if (window._firebaseReady) _tryAdminAutoRestore();
else window.addEventListener('firebase-ready', _tryAdminAutoRestore);

// Periodic refresh every 5 min
setInterval(() => { if (authState.authenticated) _adminKeepAliveRefresh(); }, _ADMIN_REFRESH_INTERVAL);

// Recover from sleep/tab-switch: visibilitychange + pageshow
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && authState.authenticated) {
    // If asleep >30 min, Firestore listeners are dead — full reload
    if (Date.now() - _adminLastRefresh > 30 * 60 * 1000) {
      location.reload();
      return;
    }
    setTimeout(_adminKeepAliveRefresh, 500);
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && authState.authenticated) {
    location.reload();
  }
});
window.addEventListener('focus', () => {
  if (authState.authenticated) setTimeout(_adminKeepAliveRefresh, 300);
});
