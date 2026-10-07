'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS Stage 3A — additive owner-grade auth for browser→Worker
//  admin requests. Replaces the reusable master ADMIN_SECRET with:
//    • Firebase ID token, cryptographically verified server-side
//      (Google Identity Toolkit accounts:lookup — validates signature,
//       issuer, audience/project, and expiry for us),
//    • required  admin:true  custom claim,
//    • required  uid ∈ OWNER_UIDS  server-side allowlist,
//    • optional Firebase App Check attestation (RS256 JWT vs Google JWKS).
//
//  FAIL-CLOSED on any missing config, verification error, or ambiguity.
//  Never throws. Never logs tokens/secrets. No secret is stored in the browser
//  (the Firebase SDK manages the ID token; App Check SDK manages its token).
//
//  Stage 3A is ADDITIVE: these verifiers back NEW parallel routes only; the
//  legacy ADMIN_SECRET routes remain untouched for rollback.
// ═══════════════════════════════════════════════════════════════════════════

// Parse the server-side OWNER_UIDS allowlist (comma-separated). Mirrors
// functions/lib/owner.js semantics: trim, drop empties, reject internal
// whitespace, de-dupe. Never reads anything client-controlled.
export function parseOwnerUids(raw) {
  if (typeof raw !== 'string') return [];
  const out = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (t && !/\s/.test(t)) out.push(t);
  }
  return [...new Set(out)];
}

// ── Firebase ID token → verified owner identity ──────────────────────────────
// Returns { ok:true, uid } or { ok:false, code }. `deps.fetch` is injectable
// for tests. Relies on Identity Toolkit to reject expired / forged / modified /
// wrong-project tokens (it returns an error for all of those).
export async function verifyOwnerIdentity(idToken, env, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  if (typeof idToken !== 'string' || !idToken || idToken.length > 8192) {
    return { ok: false, code: 'no-token' };
  }
  if (!env || !env.FIREBASE_API_KEY) return { ok: false, code: 'server-config' };
  const owners = parseOwnerUids(env.OWNER_UIDS);
  if (owners.length === 0) return { ok: false, code: 'owner-unconfigured' };

  let data;
  try {
    const r = await fetchFn(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) },
    );
    if (!r.ok) return { ok: false, code: 'token-invalid' }; // expired/forged/wrong-project → 400
    data = await r.json();
  } catch (_) {
    return { ok: false, code: 'verify-error' };
  }
  const u = data && data.users && data.users[0];
  if (!u || !u.localId) return { ok: false, code: 'token-invalid' };

  let claims = {};
  try { claims = u.customAttributes ? JSON.parse(u.customAttributes) : {}; } catch (_) { claims = {}; }
  if (claims.admin !== true) return { ok: false, code: 'not-admin' };       // customer / tablet / unprivileged
  if (!owners.includes(u.localId)) return { ok: false, code: 'not-owner' }; // admin claim but wrong UID
  return { ok: true, uid: u.localId };
}

// ── base64url helpers (App Check JWT) ────────────────────────────────────────
function _b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _b64urlToString(s) { return new TextDecoder().decode(_b64urlToBytes(s)); }

// Module-level JWKS cache (per isolate). Safe: public keys only.
let _jwksCache = { keys: null, exp: 0 };
export function _resetAppCheckJwksCache() { _jwksCache = { keys: null, exp: 0 }; } // test hook

// ── Firebase App Check token verification (RS256 vs Google JWKS) ──────────────
// Returns { ok:true, appId } or { ok:false, code }. Requires the PUBLIC project
// number (env.FIREBASE_PROJECT_NUMBER). Fail-closed if unconfigured.
export async function verifyAppCheck(token, env, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const now = typeof deps.now === 'number' ? deps.now : Date.now();
  const subtle = (deps.subtle) || (globalThis.crypto && globalThis.crypto.subtle);
  if (typeof token !== 'string' || !token || token.length > 8192) return { ok: false, code: 'appcheck-missing' };
  const projNum = env && env.FIREBASE_PROJECT_NUMBER;
  if (!projNum) return { ok: false, code: 'appcheck-unconfigured' };
  if (!subtle) return { ok: false, code: 'appcheck-no-crypto' };

  try {
    if (!_jwksCache.keys || _jwksCache.exp < now) {
      const r = await fetchFn('https://firebaseappcheck.googleapis.com/v1/jwks');
      if (!r.ok) return { ok: false, code: 'appcheck-jwks' };
      const j = await r.json();
      _jwksCache = { keys: Array.isArray(j.keys) ? j.keys : [], exp: now + 3600_000 };
    }
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, code: 'appcheck-malformed' };
    const header = JSON.parse(_b64urlToString(parts[0]));
    const payload = JSON.parse(_b64urlToString(parts[1]));
    if (header.alg !== 'RS256') return { ok: false, code: 'appcheck-alg' };
    const jwk = _jwksCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, code: 'appcheck-kid' };

    const key = await subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const sig = _b64urlToBytes(parts[2]);
    const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const valid = await subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed);
    if (!valid) return { ok: false, code: 'appcheck-sig' };

    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return { ok: false, code: 'appcheck-expired' };
    if (payload.iss !== `https://firebaseappcheck.googleapis.com/${projNum}`) return { ok: false, code: 'appcheck-iss' };
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(`projects/${projNum}`)) return { ok: false, code: 'appcheck-aud' };
    return { ok: true, appId: payload.sub };
  } catch (_) {
    return { ok: false, code: 'appcheck-error' };
  }
}

// ── Orchestrator: owner identity (+ App Check by default) ─────────────────────
// Returns { ok:true, uid } or { ok:false, status, code }. Reads only request
// headers: `Authorization: Bearer <idToken>` and `X-Firebase-AppCheck: <tok>`.
export async function requireOwner(request, env, opts = {}, deps = {}) {
  const requireAppCheck = opts.requireAppCheck !== false; // default ON for privileged routes
  const authz = request.headers.get('Authorization') || '';
  const idToken = authz.replace(/^Bearer\s+/i, '').trim();

  const id = await verifyOwnerIdentity(idToken, env, deps);
  if (!id.ok) {
    const cfg = id.code === 'server-config' || id.code === 'owner-unconfigured' || id.code === 'verify-error';
    const authz401 = id.code === 'no-token' || id.code === 'token-invalid';
    return { ok: false, status: cfg ? 503 : (authz401 ? 401 : 403), code: id.code };
  }
  if (requireAppCheck) {
    const ac = await verifyAppCheck(request.headers.get('X-Firebase-AppCheck') || '', env, deps);
    if (!ac.ok) {
      const cfg = ac.code === 'appcheck-unconfigured' || ac.code === 'appcheck-no-crypto' || ac.code === 'appcheck-jwks';
      return { ok: false, status: cfg ? 503 : 401, code: ac.code, uid: id.uid };
    }
  }
  return { ok: true, uid: id.uid };
}
