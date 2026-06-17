// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Cloudflare Worker secret storage
//
//  HIGH-1 hardening: the secret is held in a module-scoped variable only.
//  It is NEVER written to localStorage or sessionStorage, so a DOM XSS that
//  reaches `localStorage`/`sessionStorage` cannot exfiltrate it. Trade-off:
//  the secret is lost on full page reload, and the admin must re-enter it
//  once per browser session (acceptable for an admin tool).
//
//  Legacy persisted entries (from earlier versions that used storage) are
//  wiped on module load, so an old value sitting in storage from a previous
//  build cannot be picked up by a future XSS.
// ═══════════════════════════════════════════════════════════════════════════
const SECRET_KEY = 'ipear_worker_secret';

// Module-scoped closure variable. Never persisted.
let _workerSecret = '';

// One-shot wipe of any legacy persisted secret on first import.
(function _wipeLegacyStorage() {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SECRET_KEY);
  } catch (_) { /* sandboxed or disabled — fine */ }
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(SECRET_KEY);
  } catch (_) { /* sandboxed or disabled — fine */ }
})();

export function getWorkerSecret() {
  return _workerSecret;
}

export function setWorkerSecret(secret) {
  _workerSecret = typeof secret === 'string' ? secret : String(secret || '');
}

export function clearWorkerSecret() {
  _workerSecret = '';
  // Defensive wipe of storage too, in case something downstream re-persisted.
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SECRET_KEY); } catch (_) {}
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(SECRET_KEY); } catch (_) {}
}
