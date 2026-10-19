// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS Stage 3A — adversarial tests for the additive Worker
//  owner-grade auth verifier (src/worker/lib/owner-auth.js).
//
//  Proves fail-closed behavior for the NEW /admin/v2/* auth path:
//   • Firebase ID token verification + admin claim + OWNER_UID allowlist
//     (Identity Toolkit accounts:lookup stubbed — it is what rejects
//      expired/forged/wrong-project tokens in production).
//   • App Check RS256 JWT verification against a stubbed JWKS, using a REAL
//     keypair so signature / tamper / expiry / iss / aud are genuinely checked.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import {
  parseOwnerUids, verifyOwnerIdentity, verifyAppCheck, requireOwner, _resetAppCheckJwksCache,
} from '../src/worker/lib/owner-auth.js';

const OWNER = 'owner-uid-123';
const ENV = { FIREBASE_API_KEY: 'test-api-key', OWNER_UIDS: OWNER, FIREBASE_PROJECT_NUMBER: '1234567890' };

// ── accounts:lookup stub: inspects the POST body for idToken ─────────────────
function makeIdFetch(tokenToUser) {
  return async (url, opts) => {
    if (!String(url).includes('accounts:lookup')) throw new Error('unexpected url ' + url);
    const body = JSON.parse(opts.body);
    const user = tokenToUser[body.idToken];
    if (!user) return { ok: false, status: 400, json: async () => ({ error: { message: 'INVALID_ID_TOKEN' } }) };
    return { ok: true, status: 200, json: async () => ({ users: [user] }) };
  };
}
const adminUser  = { localId: OWNER, email: 'o@ipear.gr', customAttributes: JSON.stringify({ admin: true }) };
const wrongOwner = { localId: 'other-admin', email: 'a@ipear.gr', customAttributes: JSON.stringify({ admin: true }) };
const customer   = { localId: 'cust-1', email: 'c@ipear.gr' };
const tablet     = { localId: 'tab-1', email: 't@ipear.gr', customAttributes: JSON.stringify({ role: 'tablet', storeId: 's1' }) };
const ownerNoAdmin = { localId: OWNER, email: 'o@ipear.gr', customAttributes: JSON.stringify({}) };

describe('parseOwnerUids', () => {
  it('trims, de-dupes, rejects internal whitespace / empties', () => {
    expect(parseOwnerUids('a, b ,a,, ,c')).toEqual(['a', 'b', 'c']);
    expect(parseOwnerUids('bad uid')).toEqual([]);
    expect(parseOwnerUids('')).toEqual([]);
    expect(parseOwnerUids(undefined)).toEqual([]);
  });
});

describe('verifyOwnerIdentity — fail-closed matrix', () => {
  const deps = { fetch: makeIdFetch({ good: adminUser, wrong: wrongOwner, cust: customer, tab: tablet, ownerNoAdmin }) };
  it('no token → no-token', async () => {
    expect((await verifyOwnerIdentity('', ENV, deps)).code).toBe('no-token');
    expect((await verifyOwnerIdentity('x'.repeat(9000), ENV, deps)).code).toBe('no-token');
  });
  it('server misconfig (no API key) → server-config', async () => {
    expect((await verifyOwnerIdentity('good', { OWNER_UIDS: OWNER }, deps)).code).toBe('server-config');
  });
  it('OWNER_UIDS unset → owner-unconfigured (fail-closed)', async () => {
    expect((await verifyOwnerIdentity('good', { FIREBASE_API_KEY: 'k' }, deps)).code).toBe('owner-unconfigured');
  });
  it('invalid/expired/forged/wrong-project token → token-invalid', async () => {
    expect((await verifyOwnerIdentity('nope', ENV, deps)).code).toBe('token-invalid');
  });
  it('valid customer (no admin claim) → not-admin', async () => {
    expect((await verifyOwnerIdentity('cust', ENV, deps)).code).toBe('not-admin');
  });
  it('valid tablet (role claim, no admin) → not-admin', async () => {
    expect((await verifyOwnerIdentity('tab', ENV, deps)).code).toBe('not-admin');
  });
  it('admin claim but WRONG uid → not-owner', async () => {
    expect((await verifyOwnerIdentity('wrong', ENV, deps)).code).toBe('not-owner');
  });
  it('owner uid but NO admin claim → not-admin', async () => {
    expect((await verifyOwnerIdentity('ownerNoAdmin', ENV, deps)).code).toBe('not-admin');
  });
  it('valid owner admin → ok', async () => {
    const r = await verifyOwnerIdentity('good', ENV, deps);
    expect(r.ok).toBe(true); expect(r.uid).toBe(OWNER);
  });
  it('accounts:lookup network error → verify-error (fail-closed)', async () => {
    const r = await verifyOwnerIdentity('good', ENV, { fetch: async () => { throw new Error('net'); } });
    expect(r.code).toBe('verify-error');
  });
});

// ── App Check: real RS256 keypair + JWK ──────────────────────────────────────
const KID = 'test-kid-1';
let priv, jwk;
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function signAppCheck(payload, { kid = KID, alg = 'RS256' } = {}) {
  const header = b64url(JSON.stringify({ alg, typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const s = createSign('RSA-SHA256'); s.update(header + '.' + body); s.end();
  const sig = b64url(s.sign(priv));
  return `${header}.${body}.${sig}`;
}
function jwksFetch(keys) {
  return async (url) => {
    if (!String(url).includes('/jwks')) throw new Error('unexpected ' + url);
    return { ok: true, status: 200, json: async () => ({ keys }) };
  };
}

describe('verifyAppCheck — real-crypto fail-closed matrix', () => {
  const NOW = 1_800_000_000_000;
  const good = { iss: `https://firebaseappcheck.googleapis.com/${ENV.FIREBASE_PROJECT_NUMBER}`, aud: [`projects/${ENV.FIREBASE_PROJECT_NUMBER}`], exp: Math.floor(NOW / 1000) + 300, sub: 'app-123' };
  beforeEach(() => {
    _resetAppCheckJwksCache();
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    priv = kp.privateKey;
    jwk = { ...kp.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  });
  const deps = () => ({ fetch: jwksFetch([jwk]), now: NOW });

  it('missing token → appcheck-missing', async () => {
    expect((await verifyAppCheck('', ENV, deps())).code).toBe('appcheck-missing');
  });
  it('project number unset → appcheck-unconfigured (fail-closed)', async () => {
    expect((await verifyAppCheck(signAppCheck(good), { FIREBASE_API_KEY: 'k' }, deps())).code).toBe('appcheck-unconfigured');
  });
  it('malformed (not 3 parts) → appcheck-malformed', async () => {
    expect((await verifyAppCheck('a.b', ENV, deps())).code).toBe('appcheck-malformed');
  });
  it('alg != RS256 → appcheck-alg', async () => {
    expect((await verifyAppCheck(signAppCheck(good, { alg: 'HS256' }), ENV, deps())).code).toBe('appcheck-alg');
  });
  it('unknown kid → appcheck-kid', async () => {
    expect((await verifyAppCheck(signAppCheck(good, { kid: 'nope' }), ENV, deps())).code).toBe('appcheck-kid');
  });
  it('tampered payload → appcheck-sig', async () => {
    const t = signAppCheck(good);
    const parts = t.split('.');
    const forged = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    forged.sub = 'attacker';
    parts[1] = b64url(JSON.stringify(forged));
    expect((await verifyAppCheck(parts.join('.'), ENV, deps())).code).toBe('appcheck-sig');
  });
  it('expired → appcheck-expired', async () => {
    expect((await verifyAppCheck(signAppCheck({ ...good, exp: Math.floor(NOW / 1000) - 10 }), ENV, deps())).code).toBe('appcheck-expired');
  });
  it('wrong issuer → appcheck-iss', async () => {
    expect((await verifyAppCheck(signAppCheck({ ...good, iss: 'https://evil/' + ENV.FIREBASE_PROJECT_NUMBER }), ENV, deps())).code).toBe('appcheck-iss');
  });
  it('wrong audience → appcheck-aud', async () => {
    expect((await verifyAppCheck(signAppCheck({ ...good, aud: ['projects/999'] }), ENV, deps())).code).toBe('appcheck-aud');
  });
  it('JWKS endpoint down → appcheck-jwks (fail-closed)', async () => {
    expect((await verifyAppCheck(signAppCheck(good), ENV, { fetch: async () => ({ ok: false, status: 500 }), now: NOW })).code).toBe('appcheck-jwks');
  });
  it('valid App Check token → ok', async () => {
    const r = await verifyAppCheck(signAppCheck(good), ENV, deps());
    expect(r.ok).toBe(true); expect(r.appId).toBe('app-123');
  });
});

describe('requireOwner — orchestration status codes', () => {
  const NOW = 1_800_000_000_000;
  const good = { iss: `https://firebaseappcheck.googleapis.com/${ENV.FIREBASE_PROJECT_NUMBER}`, aud: [`projects/${ENV.FIREBASE_PROJECT_NUMBER}`], exp: Math.floor(NOW / 1000) + 300, sub: 'app-1' };
  beforeEach(() => {
    _resetAppCheckJwksCache();
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    priv = kp.privateKey;
    jwk = { ...kp.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  });
  function req(idToken, appCheck) {
    return { headers: new Map([['Authorization', idToken ? 'Bearer ' + idToken : ''], ['X-Firebase-AppCheck', appCheck || '']]) };
  }
  // Map's .get matches Headers.get signature well enough for the verifier.
  const combinedFetch = (idMap) => async (url, opts) => {
    if (String(url).includes('accounts:lookup')) return makeIdFetch(idMap)(url, opts);
    if (String(url).includes('/jwks')) return jwksFetch([jwk])(url, opts);
    throw new Error('unexpected ' + url);
  };

  it('no identity → 401', async () => {
    const g = await requireOwner(req('', signAppCheck(good)), ENV, {}, { fetch: combinedFetch({}), now: NOW });
    expect(g.ok).toBe(false); expect(g.status).toBe(401); expect(g.code).toBe('no-token');
  });
  it('customer token → 403 not-admin', async () => {
    const g = await requireOwner(req('cust', signAppCheck(good)), ENV, {}, { fetch: combinedFetch({ cust: customer }), now: NOW });
    expect(g.status).toBe(403); expect(g.code).toBe('not-admin');
  });
  it('wrong owner → 403 not-owner', async () => {
    const g = await requireOwner(req('wrong', signAppCheck(good)), ENV, {}, { fetch: combinedFetch({ wrong: wrongOwner }), now: NOW });
    expect(g.status).toBe(403); expect(g.code).toBe('not-owner');
  });
  it('valid owner but missing App Check → 401 appcheck-missing', async () => {
    const g = await requireOwner(req('good', ''), ENV, {}, { fetch: combinedFetch({ good: adminUser }), now: NOW });
    expect(g.status).toBe(401); expect(g.code).toBe('appcheck-missing');
  });
  it('valid owner + valid App Check → ok', async () => {
    const g = await requireOwner(req('good', signAppCheck(good)), ENV, {}, { fetch: combinedFetch({ good: adminUser }), now: NOW });
    expect(g.ok).toBe(true); expect(g.uid).toBe(OWNER);
  });
  it('requireAppCheck:false skips App Check (valid owner → ok)', async () => {
    const g = await requireOwner(req('good', ''), ENV, { requireAppCheck: false }, { fetch: combinedFetch({ good: adminUser }), now: NOW });
    expect(g.ok).toBe(true);
  });
});
