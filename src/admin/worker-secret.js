// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Cloudflare Worker secret storage
//
//  Storage tier: localStorage (persistent across tabs, reloads, browser
//  restarts — wiped only by explicit logout, clearWorkerSecret, or the
//  admin manually clearing site data).
//
//  Trade-off history:
//    v1 — in-memory only: lost on every F5, admin had to re-enter constantly.
//    v2 — sessionStorage: survived F5 but died on tab close / new tab.
//    v3 (this) — localStorage: persists indefinitely. Admin enters once per
//                device, cleared on logout via admin-auth.js.
//
//  Security note: a DOM XSS that reaches Storage APIs can exfiltrate the
//  secret. Accepted because (a) the admin surface has a locked CSP, (b) the
//  Worker Secret alone can't touch Firestore data (Firestore rules are the
//  authority — the secret only unlocks the CF Worker's admin endpoints for
//  Auth-user delete + bulk email/SMS), and (c) losing the secret every
//  session was materially breaking the delete flow and admin trust.
//
//  On logout, admin-auth.js calls clearWorkerSecret() so the value doesn't
//  linger on shared devices.
// ═══════════════════════════════════════════════════════════════════════════
const SECRET_KEY = 'ipear_worker_secret';

// In-memory cache mirrors localStorage to avoid a storage read per call
// (getWorkerSecret is hit inside hot paths like push-fcm / bulk-messaging).
let _cached = '';

function _readStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(SECRET_KEY) || '';
    }
  } catch (_) { /* sandboxed / disabled — fall through */ }
  return '';
}

// Hydrate from localStorage on first import (survives everything short of
// explicit logout). Also drop any stale sessionStorage entry from v2 so
// nothing shadows the persistent value.
(function _init() {
  _cached = _readStorage();
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SECRET_KEY);
  } catch (_) {}
})();

export function getWorkerSecret() {
  if (!_cached) _cached = _readStorage();
  return _cached;
}

export function setWorkerSecret(secret) {
  _cached = typeof secret === 'string' ? secret : String(secret || '');
  try {
    if (typeof localStorage !== 'undefined') {
      if (_cached) localStorage.setItem(SECRET_KEY, _cached);
      else localStorage.removeItem(SECRET_KEY);
    }
  } catch (_) { /* sandboxed — cache still works for this tab */ }
}

export function clearWorkerSecret() {
  _cached = '';
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(SECRET_KEY); } catch (_) {}
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SECRET_KEY); } catch (_) {}
}
