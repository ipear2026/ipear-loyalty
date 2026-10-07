// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS Stage 3B — shared admin-browser owner-auth client.
//
//  Replaces the reusable master ADMIN_SECRET (ipear_worker_secret in
//  localStorage) for ACTIVE admin-browser Worker calls. Each privileged
//  request authenticates with:
//    • a FRESH Firebase ID token  (SDK-managed; window._auth.currentUser),
//    • a Firebase App Check token (SDK-managed; window._getAppCheckToken),
//  sent ONLY for that request to the owner-authenticated /admin/v2/* routes.
//
//  Tokens are NEVER persisted (no localStorage / sessionStorage / cookie /
//  IndexedDB / URL). No token is logged. There is NO automatic fallback to the
//  legacy ADMIN_SECRET path (3B.3): callers choose exactly one mode by flag.
//
//  Feature flag ADMIN_OWNER_AUTH (default OFF → legacy path, rollback-safe):
//    • build:   VITE_ADMIN_OWNER_AUTH=1
//    • runtime: window.__ADMIN_OWNER_AUTH = true   (DevTools/testing)
// ═══════════════════════════════════════════════════════════════════════════

export function isOwnerAuthEnabled() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env &&
        String(import.meta.env.VITE_ADMIN_OWNER_AUTH) === '1') return true;
  } catch (_) { /* no import.meta in some contexts */ }
  try {
    if (typeof window !== 'undefined' && window.__ADMIN_OWNER_AUTH === true) return true;
  } catch (_) {}
  return false; // default OFF → legacy ADMIN_SECRET path
}

function _workerUrl() {
  try {
    const u = (localStorage.getItem('ipear_worker_url') || '').replace(/\/$/, '');
    return u;
  } catch (_) { return ''; }
}

// Acquire a fresh ID token + App Check token through the Firebase SDKs.
// Throws a typed Error on any gap so callers fail-closed (never silently
// degrade to the master-secret path).
async function _authHeaders() {
  const auth = (typeof window !== 'undefined') ? window._auth : null;
  const user = auth && auth.currentUser;
  if (!user || typeof user.getIdToken !== 'function') {
    const e = new Error('not-signed-in'); e.code = 'not-signed-in'; throw e;
  }
  let idToken;
  try { idToken = await user.getIdToken(/*forceRefresh*/ false); }
  catch (_) { const e = new Error('idtoken-failed'); e.code = 'idtoken-failed'; throw e; }
  let appCheck = '';
  try {
    if (typeof window._getAppCheckToken === 'function') appCheck = await window._getAppCheckToken(false);
  } catch (_) { const e = new Error('appcheck-failed'); e.code = 'appcheck-failed'; throw e; }
  if (!appCheck) { const e = new Error('appcheck-missing'); e.code = 'appcheck-missing'; throw e; }
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + idToken,
    'X-Firebase-AppCheck': appCheck,
  };
}

// Core owner-authenticated POST to /admin/v2/<route>. Returns the parsed JSON
// body on success; throws an Error with .status / .code on denial or failure.
export async function ownerPost(route, body) {
  const base = _workerUrl();
  if (!base) { const e = new Error('worker-url-missing'); e.code = 'worker-url-missing'; throw e; }
  const headers = await _authHeaders(); // throws → caller handles; no secret fallback
  const res = await fetch(`${base}/admin/v2/${route}`, {
    method: 'POST', headers, body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    const e = new Error((data && (data.code || data.error)) || ('HTTP ' + res.status));
    e.status = res.status; e.code = data && data.code;
    throw e;
  }
  return data;
}

// ── Typed helpers per migrated capability ────────────────────────────────────
export function ownerSendEmail(payload)    { return ownerPost('email', payload); }
export function ownerSendSms(payload)       { return ownerPost('sms', payload); }
export function ownerSendBulkSms(payload)   { return ownerPost('bulk-sms', payload); }
export function ownerDeleteAuthUser(payload){ return ownerPost('delete-auth-user', payload); }
export function ownerExportBackup(payload)  { return ownerPost('export-backup', payload); }
