// @vitest-environment node
// ───────────────────────────────────────────────────────────────────────────
//  Integration tests for the Cloudflare Worker (email-worker.js).
//
//  The worker exports `{ fetch, scheduled }`; these tests drive it via real
//  `Request` objects with a stubbed `globalThis.fetch` controlling all
//  downstream services (Firebase Identity Toolkit, Firestore REST, Brevo,
//  FCM). The bugs this session caught — bonus credit coupled to a failed
//  Brevo send, broken push auth, missing admin gate — would have been caught
//  here in CI rather than in production.
// ───────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import worker from '../email-worker.js';
import { _resetAppCheckJwksCache } from '../src/worker/lib/owner-auth.js';

// Worker JWT signing requires a real RSA PEM. Generate one once for the whole
// suite — much simpler than mocking the internal helper.
let TEST_PRIVATE_KEY_PEM;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  TEST_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
});

// ── In-memory KV stub ─────────────────────────────────────────────────────
function makeKV() {
  const store = new Map();
  return {
    async get(k)              { return store.get(k) ?? null; },
    async put(k, v)           { store.set(k, v); },
    async delete(k)           { store.delete(k); },
    _peek()                   { return store; },
  };
}

// ── Test env with the bindings the worker reads ───────────────────────────
function makeEnv(overrides = {}) {
  return {
    ADMIN_SECRET:      'test-admin-secret',
    BREVO_API_KEY:     'test-brevo-key',
    FCM_CLIENT_EMAIL:  'sa@test.iam.gserviceaccount.com',
    FCM_PRIVATE_KEY:   TEST_PRIVATE_KEY_PEM,
    FCM_PROJECT_ID:    'test-project',
    FIREBASE_API_KEY:  'test-fb-api-key',
    SENDER_EMAIL:      'sender@test.gr',
    SENDER_NAME:       'iPear Test',
    ALLOWED_ORIGINS:   'https://test.local',
    APP_URL:           'https://test.local',
    RATE_LIMIT_KV:     makeKV(),
    ...overrides,
  };
}

// ── Fetch router stub. Tests register handlers per URL substring. ────────
function makeFetchStub() {
  const handlers = [];
  const calls = [];
  const stub = vi.fn(async (urlOrReq, opts) => {
    const url = typeof urlOrReq === 'string' ? urlOrReq : urlOrReq.url;
    calls.push({ url, method: opts?.method || 'GET', body: opts?.body });
    for (const { match, respond } of handlers) {
      if (typeof match === 'string' ? url.includes(match) : match.test(url)) {
        return respond({ url, opts });
      }
    }
    throw new Error('no fetch stub matched URL: ' + url);
  });
  stub.on = (match, respond) => { handlers.push({ match, respond }); return stub; };
  stub.calls = calls;
  return stub;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function makeRequest(path, { body, headers = {}, method = 'POST' } = {}) {
  return new Request('https://worker.test' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://test.local', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Helper: stub the OAuth + Identity Toolkit calls the worker needs to
// authenticate. Most handlers need both: getAuthAccessToken for service-
// account-driven Firestore writes, and accounts:lookup for verifying user
// idTokens.
function defaultAuthStubs(stub, { uid = 'uid-user-1', email = 'user@test.gr', phoneNumber = '+306900000000' } = {}) {
  stub.on('oauth2.googleapis.com/token', () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
  stub.on('identitytoolkit.googleapis.com/v1/accounts:lookup', () =>
    jsonResponse({ users: [{ localId: uid, email, phoneNumber }] })
  );
}

// ── Owner-auth (Stage 3A/3B) harness: real RS256 App Check + stubbed identity ──
// Lets integration tests drive the live /admin/v2/* owner routes end-to-end.
const _OWNER_UID = 'owner-uid-1';
const _PROJNUM   = '1234567890';
const _AC_KID    = 'ac-kid-1';
let _acPriv, _acJwk;
beforeAll(() => {
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  _acPriv = kp.privateKey;
  _acJwk  = { ...kp.publicKey.export({ format: 'jwk' }), kid: _AC_KID, alg: 'RS256', use: 'sig' };
});
function _b64u(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function makeAppCheckToken() {
  const header  = _b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: _AC_KID }));
  const payload = _b64u(JSON.stringify({
    iss: `https://firebaseappcheck.googleapis.com/${_PROJNUM}`,
    aud: [`projects/${_PROJNUM}`], exp: Math.floor(Date.now() / 1000) + 300, sub: 'app-xyz',
  }));
  const s = createSign('RSA-SHA256'); s.update(header + '.' + payload); s.end();
  return header + '.' + payload + '.' + _b64u(s.sign(_acPriv));
}
function ownerEnv(over = {}) { return makeEnv({ OWNER_UIDS: _OWNER_UID, FIREBASE_PROJECT_NUMBER: _PROJNUM, ...over }); }
function ownerHeaders() { return { Authorization: 'Bearer owner-idtoken', 'X-Firebase-AppCheck': makeAppCheckToken() }; }
// Register the two fetches owner-auth performs: identity (owner w/ admin:true) + App Check JWKS.
function stubOwnerAuth(stub) {
  stub.on('identitytoolkit.googleapis.com/v1/accounts:lookup', () =>
    jsonResponse({ users: [{ localId: _OWNER_UID, customAttributes: JSON.stringify({ admin: true }) }] }));
  stub.on('firebaseappcheck.googleapis.com/v1/jwks', () => jsonResponse({ keys: [_acJwk] }));
}

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; _resetAppCheckJwksCache(); });
afterEach(()  => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
//  /send-welcome — the regression that triggered this whole session
// ═══════════════════════════════════════════════════════════════════════════

describe('/send-welcome', () => {
  it('credits +50 even when Brevo email send fails (regression guard)', async () => {
    const fetchStub = makeFetchStub();
    defaultAuthStubs(fetchStub);

    let committed = false;
    // STEP 1: mask GET for the idempotency flag — NOT yet processed (flag absent),
    // card present. (Worker replaced the old R-M-W transaction with a mask GET +
    // atomic-increment commit so /send-welcome and /process-referral don't contend.)
    fetchStub.on(/ipear_customers\/uid-user-1\?mask/, () =>
      jsonResponse({ name: 'projects/p/databases/(default)/documents/ipear_customers/uid-user-1',
                     fields: { card: { stringValue: 'IP-AAAAAA' } } })
    );
    fetchStub.on(':commit', () => { committed = true; return jsonResponse({}); });
    fetchStub.on(/ipear_transactions$/, () => jsonResponse({ name: 'tx-doc' }));
    // Leaderboard republish helper inside the handler.
    fetchStub.on(':runQuery', () => jsonResponse([]));
    fetchStub.on(/ipear_leaderboard\/latest/, () => jsonResponse({}));
    // BREVO returns 500 — this is the exact case that silently broke +50.
    fetchStub.on('api.brevo.com/v3/smtp/email', () =>
      jsonResponse({ message: 'quota exceeded' }, 500)
    );
    globalThis.fetch = fetchStub;

    const req = makeRequest('/send-welcome', {
      body: { idToken: 'tok', name: 'User', marketingOptIn: true }
    });
    const res = await worker.fetch(req, makeEnv(), {});
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.bonusAwarded).toBe(true);
    expect(committed).toBe(true);
  });

  it('is idempotent — second call does not double-credit', async () => {
    const fetchStub = makeFetchStub();
    defaultAuthStubs(fetchStub);

    let commits = 0;
    // STEP 1: mask GET returns the flag already set → worker skips the credit commit.
    fetchStub.on(/ipear_customers\/uid-user-1\?mask/, () =>
      jsonResponse({ name: 'projects/p/databases/(default)/documents/ipear_customers/uid-user-1',
                     fields: { marketingWelcomeProcessed: { booleanValue: true },
                               card: { stringValue: 'IP-AAAAAA' } } })
    );
    fetchStub.on(':commit', () => { commits++; return jsonResponse({}); });
    fetchStub.on('api.brevo.com/v3/smtp/email', () => jsonResponse({ messageId: 'ok' }));
    globalThis.fetch = fetchStub;

    const req = makeRequest('/send-welcome', {
      body: { idToken: 'tok', name: 'User', marketingOptIn: true }
    });
    const res = await worker.fetch(req, makeEnv(), {});
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.bonusAwarded).toBe(false);
    expect(commits).toBe(0);
  });

  it('rejects calls without idToken', async () => {
    const fetchStub = makeFetchStub();
    globalThis.fetch = fetchStub;
    const req = makeRequest('/send-welcome', { body: { name: 'X', marketingOptIn: true } });
    const res = await worker.fetch(req, makeEnv(), {});
    expect(res.status).toBe(401);
  });

  it('rejects when token has no phone identity (anti-bonus-mint gate)', async () => {
    const fetchStub = makeFetchStub();
    fetchStub.on('oauth2.googleapis.com', () => jsonResponse({ access_token: 'x' }));
    fetchStub.on('identitytoolkit.googleapis.com/v1/accounts:lookup', () =>
      jsonResponse({ users: [{ localId: 'uid', email: 'e@x.gr' /* no phoneNumber */ }] })
    );
    globalThis.fetch = fetchStub;

    const req = makeRequest('/send-welcome', {
      body: { idToken: 'tok', name: 'X', marketingOptIn: true }
    });
    const res = await worker.fetch(req, makeEnv(), {});
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('phone-not-verified');
  });

  it('accepts a fresh KV phone-receipt when token has no phone identity', async () => {
    const env = makeEnv();
    // Receipt the SPA puts in KV right after /verify-sms-otp succeeds, valid
    // for any caller whose customer doc has phone == "6900000000".
    await env.RATE_LIMIT_KV.put('phone-otp:6900000000',
      JSON.stringify({ verifiedAt: Date.now() }));

    const fetchStub = makeFetchStub();
    fetchStub.on('oauth2.googleapis.com', () => jsonResponse({ access_token: 'x' }));
    fetchStub.on('identitytoolkit.googleapis.com/v1/accounts:lookup', () =>
      jsonResponse({ users: [{ localId: 'uid-r', email: 'e@x.gr' /* no phoneNumber */ }] })
    );
    fetchStub.on(/ipear_customers\/uid-r(?!\/)/, () =>
      jsonResponse({ fields: { phone: { stringValue: '6900000000' } } })
    );
    fetchStub.on(':beginTransaction', () => jsonResponse({ transaction: 'tx-r' }));
    fetchStub.on(/ipear_customers\/uid-r\?transaction=/, () =>
      jsonResponse({ name: 'projects/p/databases/(default)/documents/ipear_customers/uid-r',
                     fields: { points: { integerValue: '0' }, totalPoints: { integerValue: '0' } } })
    );
    fetchStub.on(':commit', () => jsonResponse({}));
    fetchStub.on(':runQuery', () => jsonResponse([]));
    fetchStub.on(/ipear_leaderboard\/latest/, () => jsonResponse({}));
    fetchStub.on(/ipear_transactions$/, () => jsonResponse({}));
    fetchStub.on('api.brevo.com/v3/smtp/email', () => jsonResponse({ messageId: 'ok' }));
    globalThis.fetch = fetchStub;

    const req = makeRequest('/send-welcome', {
      body: { idToken: 'tok', name: 'User', marketingOptIn: true }
    });
    const res = await worker.fetch(req, makeEnv({ RATE_LIMIT_KV: env.RATE_LIMIT_KV }), {});
    expect(res.status).toBe(200);
  });
});

// Note: the /push endpoints (admin broadcast + idToken self-push) were removed
// on 2026-07-31 when the app dropped push notifications (see email-worker.js
// header comment). Their tests were deleted here in the prod-v2.7.0 lineage.

// ═══════════════════════════════════════════════════════════════════════════
//  Admin-gated endpoints reject anonymous calls
// ═══════════════════════════════════════════════════════════════════════════

describe('admin-gated endpoints (Stage 3D — legacy ADMIN_SECRET routes retired)', () => {
  // Default production env has NO ADMIN_LEGACY_ROUTES_ENABLED → legacy routes
  // are retired (410), returned BEFORE any secret compare (no oracle, 3D.9).
  it.each([
    ['/sms',       { phone: '6900000000', message: 'x' }],
    ['/bulk-sms',  { recipients: [{ phone: '6900000000' }], message: 'x' }],
  ])('%s → 410 retired without ADMIN_SECRET (default)', async (path, body) => {
    const fetchStub = makeFetchStub();
    globalThis.fetch = fetchStub;
    const res = await worker.fetch(makeRequest(path, { body }), makeEnv(), {});
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe('endpoint-retired');
  });

  it.each([
    ['/sms',       { phone: '6900000000', message: 'x' }],
    ['/bulk-sms',  { recipients: [{ phone: '6900000000' }], message: 'x' }],
  ])('%s → 410 retired even with CORRECT ADMIN_SECRET (no secret oracle)', async (path, body) => {
    const fetchStub = makeFetchStub();
    globalThis.fetch = fetchStub;
    const res = await worker.fetch(makeRequest(path, {
      body, headers: { Authorization: 'Bearer test-admin-secret' }
    }), makeEnv(), {});
    expect(res.status).toBe(410);
  });

  it.each([
    ['/sms',       { phone: '6900000000', message: 'x' }],
    ['/bulk-sms',  { recipients: [{ phone: '6900000000' }], message: 'x' }],
  ])('%s → 410 even with the (now-removed) rollback switch set (3F: switch is inert)', async (path, body) => {
    const fetchStub = makeFetchStub();
    globalThis.fetch = fetchStub;
    const res = await worker.fetch(makeRequest(path, { body }),
      makeEnv({ ADMIN_LEGACY_ROUTES_ENABLED: 'true' }), {});
    expect(res.status).toBe(410);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  /admin/delete-auth-user — GDPR Art.17 redemption_requests anonymization
//  (redemption_requests denies all client writes in firestore.rules, so the
//   deleted customer's identifiers must be scrubbed server-side here.)
// ═══════════════════════════════════════════════════════════════════════════
describe('/admin/delete-auth-user — redemption_requests anonymization', () => {
  it('deletes the Auth user AND anonymizes the customer PII in redemption_requests', async () => {
    const stub = makeFetchStub();
    const rrName = 'projects/test-project/databases/(default)/documents/ipear_redemption_requests/req_1';
    stub.on('oauth2.googleapis.com/token', () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    stub.on('identitytoolkit.googleapis.com/v1/accounts:delete', () => jsonResponse({}));
    stub.on(':runQuery', () => jsonResponse([{ document: {
      name: rrName,
      fields: { customerUid: { stringValue: 'uid-del-1' }, customerId: { stringValue: 'uid-del-1' },
                rewardCost: { integerValue: '-2500' }, status: { stringValue: 'approved' } },
    } }]));
    stub.on(':commit', () => jsonResponse({ writeResults: [{ updateTime: '2026-09-19T00:00:00Z' }] }));
    stubOwnerAuth(stub);
    globalThis.fetch = stub;

    // Stage 3F: the handler is reached ONLY via the owner-authenticated
    // /admin/v2/delete-auth-user route (Firebase owner identity + App Check).
    const res = await worker.fetch(makeRequest('/admin/v2/delete-auth-user', {
      body: { uid: 'uid-del-1', email: 'del@test.gr' },
      headers: ownerHeaders(),
    }), ownerEnv(), {});

    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.success).toBe(true);
    expect(out.uid).toBe('uid-del-1');

    // Auth deletion happened
    expect(stub.calls.some(c => c.url.includes('accounts:delete'))).toBe(true);
    // A commit anonymized the redemption_requests doc
    const commit = stub.calls.find(c => c.url.includes(':commit'));
    expect(commit).toBeTruthy();
    const w = JSON.parse(commit.body).writes[0];
    expect(w.update.name).toBe(rrName);
    expect(w.update.fields.customerId.stringValue).toBe('[DELETED]');
    expect(w.update.fields.customerUid.stringValue).toBe('[DELETED]');
    expect(w.update.fields._anonymizedAt.stringValue).toBeTruthy();
    // Business/financial fields are NOT in the updateMask → preserved
    expect(w.updateMask.fieldPaths.sort()).toEqual(['_anonymizedAt', 'customerId', 'customerUid']);
  });

  it('still succeeds (does not fail the deletion) when no redemption_requests match', async () => {
    const stub = makeFetchStub();
    stub.on('oauth2.googleapis.com/token', () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    stub.on('identitytoolkit.googleapis.com/v1/accounts:delete', () => jsonResponse({}));
    stub.on(':runQuery', () => jsonResponse([{ readTime: '2026-09-19T00:00:00Z' }])); // no document field = no match
    stubOwnerAuth(stub);
    globalThis.fetch = stub;

    const res = await worker.fetch(makeRequest('/admin/v2/delete-auth-user', {
      body: { uid: 'uid-del-2' },
      headers: ownerHeaders(),
    }), ownerEnv(), {});

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    // No commit attempted when nothing matched
    expect(stub.calls.some(c => c.url.includes(':commit'))).toBe(false);
  });

  it('Stage 3D: legacy /admin/delete-auth-user → 410 retired by default', async () => {
    const stub = makeFetchStub();
    globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/admin/delete-auth-user', {
      body: { uid: 'x' }, headers: { Authorization: 'Bearer test-admin-secret' },
    }), makeEnv(), {});
    expect(res.status).toBe(410);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS Stage 3A — NEW /admin/v2/* owner-auth routes (additive).
//  Prove: routes exist (deny, not 404), fail-closed without config, reject a
//  bare ADMIN_SECRET (no longer sufficient for v2), and dispatch to the handler
//  only for a verified owner + App Check. Legacy ADMIN_SECRET routes are
//  covered unchanged by the suites above (additive-safety).
// ═══════════════════════════════════════════════════════════════════════════
const V2_PATHS = ['/admin/v2/email', '/admin/v2/sms', '/admin/v2/bulk-sms', '/admin/v2/delete-auth-user', '/admin/v2/export-backup'];
const PROJNUM = '1234567890';
function b64u(b) { return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

describe('Stage 3A — /admin/v2 owner-auth routes', () => {
  it.each(V2_PATHS)('%s exists and denies unauthenticated (401, not 404/200)', async (path) => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest(path, { body: {} }), makeEnv(), {});
    expect(res.status).toBe(401);            // no Firebase token → no-token
    expect(res.status).not.toBe(404);        // route EXISTS
    expect(res.status).not.toBe(200);        // never reaches handler
  });

  it('token present but OWNER_UIDS unset → 503 owner-unconfigured (fail-closed config)', async () => {
    const stub = makeFetchStub();
    stub.on('accounts:lookup', () => jsonResponse({ users: [{ localId: 'owner-1', email: 'o@ipear.gr', customAttributes: JSON.stringify({ admin: true }) }] }));
    globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/admin/v2/email', {
      body: {}, headers: { Authorization: 'Bearer sometoken' },
    }), makeEnv({ FIREBASE_PROJECT_NUMBER: PROJNUM }), {}); // no OWNER_UIDS
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('owner-unconfigured');
  });

  it('denies with OWNER_UIDS set but NO Firebase token (401 no-token)', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/admin/v2/email', { body: {} }),
      makeEnv({ OWNER_UIDS: 'owner-1', FIREBASE_PROJECT_NUMBER: PROJNUM }), {});
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('no-token');
  });

  it('a bare ADMIN_SECRET does NOT authorize a v2 route (treated as idToken → token-invalid)', async () => {
    const stub = makeFetchStub();
    stub.on('accounts:lookup', () => jsonResponse({ error: { message: 'INVALID_ID_TOKEN' } }, 400));
    globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/admin/v2/delete-auth-user', {
      body: { uid: 'x' }, headers: { Authorization: 'Bearer test-admin-secret' },
    }), makeEnv({ OWNER_UIDS: 'owner-1', FIREBASE_PROJECT_NUMBER: PROJNUM }), {});
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('token-invalid');
  });

  it('non-owner admin token → 403 not-owner (never reaches handler)', async () => {
    const stub = makeFetchStub();
    stub.on('accounts:lookup', () => jsonResponse({ users: [{ localId: 'other', email: 'a@b.gr', customAttributes: JSON.stringify({ admin: true }) }] }));
    globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/admin/v2/export-backup', {
      body: {}, headers: { Authorization: 'Bearer sometoken' },
    }), makeEnv({ OWNER_UIDS: 'owner-1', FIREBASE_PROJECT_NUMBER: PROJNUM }), {});
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('not-owner');
  });

  it('valid owner + valid App Check → dispatches past the gate (not an auth denial)', async () => {
    // real RS256 App Check token + matching JWKS
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...kp.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
    const now = Date.now();
    const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
    const payload = b64u(JSON.stringify({
      iss: `https://firebaseappcheck.googleapis.com/${PROJNUM}`, aud: [`projects/${PROJNUM}`],
      exp: Math.floor(now / 1000) + 300, sub: 'app-1',
    }));
    const s = createSign('RSA-SHA256'); s.update(header + '.' + payload); s.end();
    const appCheck = `${header}.${payload}.${b64u(s.sign(kp.privateKey))}`;

    const stub = makeFetchStub();
    stub.on('accounts:lookup', () => jsonResponse({ users: [{ localId: 'owner-1', email: 'o@ipear.gr', customAttributes: JSON.stringify({ admin: true }) }] }));
    stub.on('/jwks', () => jsonResponse({ keys: [jwk] }));
    // downstream Brevo (handleEmail) — accept whatever it sends
    stub.on('api.brevo.com', () => jsonResponse({ messageId: 'ok' }, 201));
    globalThis.fetch = stub;

    const res = await worker.fetch(makeRequest('/admin/v2/email', {
      body: { subject: 's', html: '<p>x</p>', recipients: [{ email: 'to@test.gr' }] },
      headers: { Authorization: 'Bearer owner-token', 'X-Firebase-AppCheck': appCheck },
    }), makeEnv({ OWNER_UIDS: 'owner-1', FIREBASE_PROJECT_NUMBER: PROJNUM }), {});
    // The gate passed → we reached handleEmail. Assert it is NOT an auth denial.
    expect([401, 403, 503]).not.toContain(res.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS Stage 3C — scoped read-only Woo lookup /woo/v2/get-user.
//  Proves WOO_LOOKUP_SECRET isolation: it authorizes ONLY the lookup, nothing
//  else; and no other secret authorizes the lookup. No ADMIN_SECRET fallback.
// ═══════════════════════════════════════════════════════════════════════════
const LOOKUP = 'lookup-sec-3c';
const LOYALTY = 'loyalty-sec-3c';
function envWoo(over = {}) { return makeEnv({ WOO_LOOKUP_SECRET: LOOKUP, WOO_LOYALTY_SECRET: LOYALTY, ...over }); }
function stubLookupBackend(stub) {
  stub.on('oauth2.googleapis.com/token', () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
  stub.on(':runQuery', () => jsonResponse([{ document: { fields: {
    name: { stringValue: 'Jane' }, points: { integerValue: '120' },
    totalPoints: { integerValue: '500' }, card: { stringValue: 'IP-ABC123' },
  } } }]));
}

describe('Stage 3C — /woo/v2/get-user (WOO_LOOKUP_SECRET)', () => {
  it('correct lookup secret → 200 minimized record + Cache-Control no-store', async () => {
    const stub = makeFetchStub(); stubLookupBackend(stub); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo/v2/get-user', {
      body: { email: 'jane@ipear.gr' }, headers: { Authorization: `Bearer ${LOOKUP}` },
    }), envWoo(), {});
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const d = await res.json();
    expect(d).toMatchObject({ ok: true, name: 'Jane', points: 120, totalPoints: 500, card: 'IP-ABC123' });
    // minimized — no extra fields leaked
    expect(Object.keys(d).sort()).toEqual(['card', 'name', 'ok', 'points', 'totalPoints']);
  });
  it('missing auth → 401', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo/v2/get-user', { body: { email: 'j@ipear.gr' } }), envWoo(), {});
    expect(res.status).toBe(401);
  });
  it('wrong secret → 401', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo/v2/get-user', { body: { email: 'j@ipear.gr' }, headers: { Authorization: 'Bearer nope' } }), envWoo(), {});
    expect(res.status).toBe(401);
  });
  it('ADMIN_SECRET alone → DENIED on v2 lookup (no fallback)', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo/v2/get-user', { body: { email: 'j@ipear.gr' }, headers: { Authorization: 'Bearer test-admin-secret' } }), envWoo(), {});
    expect(res.status).toBe(401);
  });
  it('WOO_LOYALTY_SECRET → DENIED on lookup', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo/v2/get-user', { body: { email: 'j@ipear.gr' }, headers: { Authorization: `Bearer ${LOYALTY}` } }), envWoo(), {});
    expect(res.status).toBe(401);
  });
  it('WOO_LOOKUP_SECRET unset → 503 fail-closed', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo/v2/get-user', { body: { email: 'j@ipear.gr' }, headers: { Authorization: `Bearer ${LOOKUP}` } }), makeEnv(), {});
    expect(res.status).toBe(503);
  });
  it('GET method → 405', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo/v2/get-user', { method: 'GET', headers: { Authorization: `Bearer ${LOOKUP}` } }), envWoo(), {});
    expect(res.status).toBe(405);
  });
});

describe('Stage 3C — scoped secret isolation (lookup secret cannot do anything else)', () => {
  it('lookup secret → DENIED on /woo-credit-order (needs WOO_LOYALTY_SECRET)', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo-credit-order', { body: { orderId: 1 }, headers: { Authorization: `Bearer ${LOOKUP}` } }), envWoo(), {});
    expect(res.status).toBe(401);
  });
  it('lookup secret → DENIED on legacy /admin/export-backup (Stage 3D: retired → 410)', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/admin/export-backup', { body: {}, headers: { Authorization: `Bearer ${LOOKUP}` } }), envWoo(), {});
    // Stage 3D retired the legacy route (410) before any secret compare — the
    // lookup secret still gains no authority here.
    expect(res.status).toBe(410);
  });
  it('lookup secret → DENIED on /admin/v2/email (owner idToken path)', async () => {
    const stub = makeFetchStub();
    stub.on('accounts:lookup', () => jsonResponse({ error: { message: 'INVALID_ID_TOKEN' } }, 400));
    globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/admin/v2/email', { body: {}, headers: { Authorization: `Bearer ${LOOKUP}` } }),
      envWoo({ OWNER_UIDS: 'owner-1', FIREBASE_PROJECT_NUMBER: '123' }), {});
    expect([401, 403]).toContain(res.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS Stage 3D — RETIRE THE LEGACY ADMIN_SECRET SURFACE.
//  Target: active runtime endpoints accepting ADMIN_SECRET = 0. Every legacy
//  route is fail-closed (410) by default, BEFORE any secret compare (no
//  oracle). create-admin is retired unconditionally (no rollback). The v2
//  owner-auth routes and the scoped Woo routes are unaffected.
// ═══════════════════════════════════════════════════════════════════════════
const LEGACY_SECRET_ROUTES = [
  ['/sms',                     { phone: '6900000000', message: 'x' }],
  ['/bulk-sms',                { recipients: [{ phone: '6900000000' }], message: 'x' }],
  ['/admin/redeem-attempt',    { action: 'check' }],
  ['/admin/delete-auth-user',  { uid: 'x' }],
  ['/admin/export-backup',     {}],
  ['/woo-add-points',          { email: 'a@b.gr', points: 1 }],
  ['/woo-refund-points',       { email: 'a@b.gr', points: 1 }],
  ['/woo-get-user',            { email: 'a@b.gr' }],
  ['/',                        { to: 'a@b.gr', subject: 's', html: 'h' }],
];

describe('Stage 3D — legacy routes retired by default (fail-closed, no oracle)', () => {
  it.each(LEGACY_SECRET_ROUTES)('%s → 410 with NO auth', async (path, body) => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest(path, { body }), makeEnv(), {});
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe('endpoint-retired');
  });

  it.each(LEGACY_SECRET_ROUTES)('%s → 410 even with a CORRECT ADMIN_SECRET (no secret oracle)', async (path, body) => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest(path, {
      body, headers: { Authorization: 'Bearer test-admin-secret' },
    }), makeEnv(), {});
    expect(res.status).toBe(410);
  });

  it.each(LEGACY_SECRET_ROUTES)('%s → 410 with a WRONG ADMIN_SECRET (identical response)', async (path, body) => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest(path, {
      body, headers: { Authorization: 'Bearer definitely-wrong' },
    }), makeEnv(), {});
    expect(res.status).toBe(410);
  });

  it('an UNKNOWN POST path → 410 (default handleEmail fallback is retired)', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/some-unknown-path', {
      body: {}, headers: { Authorization: 'Bearer test-admin-secret' },
    }), makeEnv(), {});
    expect(res.status).toBe(410);
  });

  it('GET /health-deep → 410 retired by default', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/health-deep', {
      method: 'GET', headers: { Authorization: 'Bearer test-admin-secret' },
    }), makeEnv(), {});
    expect(res.status).toBe(410);
  });
});

describe('Stage 3D — create-admin retired UNCONDITIONALLY (no rollback)', () => {
  const body = { email: 'new@admin.gr', password: 'secret123' };
  it.each([
    ['no auth',               {}],
    ['correct ADMIN_SECRET',  { Authorization: 'Bearer test-admin-secret' }],
    ['wrong ADMIN_SECRET',    { Authorization: 'Bearer nope' }],
    ['WOO_LOOKUP_SECRET',     { Authorization: `Bearer ${LOOKUP}` }],
    ['WOO_LOYALTY_SECRET',    { Authorization: `Bearer ${LOYALTY}` }],
  ])('create-admin-user → 410 (%s)', async (_label, headers) => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/admin/create-admin-user', { body, headers }), envWoo(), {});
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe('endpoint-retired');
  });

  it('create-admin-user → STILL 410 even in rollback mode (legacy switch ON)', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/admin/create-admin-user', {
      body, headers: { Authorization: 'Bearer test-admin-secret' },
    }), makeEnv({ ADMIN_LEGACY_ROUTES_ENABLED: 'true' }), {});
    expect(res.status).toBe(410);
  });
});

describe('Stage 3D — /woo-create-coupon moved OFF the ADMIN_SECRET gate (idToken auth)', () => {
  it('no idToken → 400 (reached the handler, NOT a 401 ADMIN_SECRET gate)', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo-create-coupon', {
      body: { discountType: 'percent', discountAmount: 5 },
    }), makeEnv(), {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/idToken/i);
  });

  it('a stale ADMIN_SECRET bearer does NOT gate it (still reaches idToken check → 400)', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo-create-coupon', {
      body: { discountType: 'percent', discountAmount: 5 },
      headers: { Authorization: 'Bearer test-admin-secret' },
    }), makeEnv(), {});
    expect(res.status).toBe(400);
  });
});

describe('Stage 3D — replacements remain reachable (deny, not 404/410)', () => {
  it.each(V2_PATHS)('%s still routes to owner-auth (401/403 without a valid owner token, never 410)', async (path) => {
    const stub = makeFetchStub();
    stub.on('accounts:lookup', () => jsonResponse({ error: { message: 'INVALID_ID_TOKEN' } }, 400));
    globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest(path, {
      body: {}, headers: { Authorization: 'Bearer some-id-token' },
    }), makeEnv({ OWNER_UIDS: 'owner-1', FIREBASE_PROJECT_NUMBER: '123' }), {});
    expect([401, 403]).toContain(res.status);
    expect(res.status).not.toBe(410);
  });

  it('/woo/v2/get-user still works with WOO_LOOKUP_SECRET (unaffected by 3D)', async () => {
    const stub = makeFetchStub(); stubLookupBackend(stub); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo/v2/get-user', {
      body: { email: 'jane@ipear.gr' }, headers: { Authorization: `Bearer ${LOOKUP}` },
    }), envWoo(), {});
    expect(res.status).toBe(200);
  });

  it('/woo-credit-order still gated by WOO_LOYALTY_SECRET (wrong secret → 401, not 410)', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo-credit-order', {
      body: { orderId: 1 }, headers: { Authorization: 'Bearer wrong' },
    }), envWoo(), {});
    expect(res.status).toBe(401);
  });
});

describe('Stage 3F — the rollback switch is permanently inert (ADMIN_SECRET gone)', () => {
  it('ADMIN_LEGACY_ROUTES_ENABLED=true no longer resurrects any legacy route → 410', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    for (const path of ['/admin/redeem-attempt', '/sms', '/woo-get-user', '/woo-add-points']) {
      const res = await worker.fetch(makeRequest(path, {
        body: { action: 'check' }, headers: { Authorization: 'Bearer test-admin-secret' },
      }), makeEnv({ ADMIN_LEGACY_ROUTES_ENABLED: 'true' }), {});
      expect(res.status, `${path} must stay retired even with the dead switch set`).toBe(410);
      expect((await res.json()).error).toBe('endpoint-retired');
    }
  });

  it('/admin/create-admin-user stays 410 with the switch set', async () => {
    const stub = makeFetchStub(); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/admin/create-admin-user', {
      body: { email: 'x@y.gr', password: 'abcdef' }, headers: { Authorization: 'Bearer test-admin-secret' },
    }), makeEnv({ ADMIN_LEGACY_ROUTES_ENABLED: 'true' }), {});
    expect(res.status).toBe(410);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  /woo-create-coupon — hardened, server-AUTHORITATIVE e-shop coupon
//  (Phase 2/3: offer-authoritative discount, idempotent, usage-limited,
//   email-bound, lost-response recovery, forgery-proof)
// ═══════════════════════════════════════════════════════════════════════════
function couponEnv(over = {}) {
  return envWoo({ WOO_URL: 'https://shop.test', WOO_KEY: 'ck_test', WOO_SECRET: 'cs_test', ...over });
}

function stubCouponBackend(stub, {
  uid = 'uid-user-1', email = 'user@test.gr',
  offer = { active: true, title: 'Test Offer', eshopDiscountType: 'percent', eshopDiscountAmount: 5, singleUse: true, endDate: '' },
  offerExists = true,
  existingRedemption = null,
  wooCreate = 'ok',
  wooCouponId = 42,
} = {}) {
  defaultAuthStubs(stub, { uid, email });
  stub.on('ipear_customers/', () => jsonResponse({ fields: { email: { stringValue: email } } }));
  stub.on('ipear_offers/', () => offerExists
    ? jsonResponse({ fields: {
        active:              { booleanValue: offer.active },
        title:               { stringValue: offer.title },
        eshopDiscountType:   { stringValue: offer.eshopDiscountType },
        eshopDiscountAmount: { doubleValue: offer.eshopDiscountAmount },
        singleUse:           { booleanValue: offer.singleUse },
        ...(offer.endDate ? { endDate: { stringValue: offer.endDate } } : {}),
      } })
    : jsonResponse({ error: { status: 'NOT_FOUND' } }, 404));
  stub.on('ipear_offer_redemptions/', ({ opts }) => {
    if ((opts?.method || 'GET') === 'GET') {
      return existingRedemption
        ? jsonResponse({ fields: {
            status:    { stringValue: existingRedemption.status },
            code:      { stringValue: existingRedemption.code },
            expiresAt: { stringValue: '2099-01-01' },
          } })
        : jsonResponse({ error: { status: 'NOT_FOUND' } }, 404);
    }
    return jsonResponse({ name: 'patched' }); // PATCH reserve/done
  });
  stub.on('ipear_security_events', () => jsonResponse({ name: 'sec' }));
  stub.on(/wc\/v3\/coupons/, ({ url, opts }) => {
    const method = opts?.method || 'GET';
    if (method === 'GET') {
      const m = url.match(/[?&]code=([^&]+)/);
      const c = m ? decodeURIComponent(m[1]) : 'x';
      return jsonResponse([{ id: wooCouponId, code: c.toLowerCase() }]);
    }
    if (wooCreate === 'fail') return jsonResponse({ code: 'woo_error', message: 'boom' }, 500);
    if (wooCreate === 'exists')
      return new Response(JSON.stringify({ code: 'woocommerce_rest_coupon_code_already_exists', message: 'already exists' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } });
    const posted = (opts?.body && JSON.parse(opts.body).code) || 'ipear-xxxx';
    return jsonResponse({ id: wooCouponId, code: String(posted).toLowerCase() }, 201);
  });
}

function couponReq(body) {
  return makeRequest('/woo-create-coupon', { body: { idToken: 'id-token', ...body } });
}

describe('/woo-create-coupon — hardened server-authoritative e-shop coupon', () => {
  it('valid active offer → coupon with discount FROM THE OFFER + usage limits + email restriction', async () => {
    const stub = makeFetchStub(); stubCouponBackend(stub); globalThis.fetch = stub;
    const res = await worker.fetch(couponReq({ offerId: 'offer-1', discountType: 'fixed_cart', discountAmount: 999 }), couponEnv(), {});
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.discountType).toBe('percent'); // from offer, NOT client 'fixed_cart'
    expect(j.discountAmount).toBe(5);       // from offer, NOT client 999
    expect(j.code).toMatch(/^ipear-[0-9a-f]{10}$/i);
    const post = stub.calls.find(c => /wc\/v3\/coupons/.test(c.url) && c.method === 'POST');
    const payload = JSON.parse(post.body);
    expect(payload.individual_use).toBe(true);
    expect(payload.usage_limit).toBe(1);
    expect(payload.usage_limit_per_user).toBe(1);
    expect(payload.email_restrictions).toEqual(['user@test.gr']);
    expect(payload.amount).toBe('5');
    expect(payload.discount_type).toBe('percent');
  });

  it('client CANNOT forge the discount — a €100 fixed request still yields the €5 percent offer', async () => {
    const stub = makeFetchStub();
    stubCouponBackend(stub, { offer: { active: true, title: 'O', eshopDiscountType: 'percent', eshopDiscountAmount: 5, singleUse: true, endDate: '' } });
    globalThis.fetch = stub;
    const res = await worker.fetch(couponReq({ offerId: 'offer-1', discountType: 'fixed_cart', discountAmount: 100 }), couponEnv(), {});
    const j = await res.json();
    expect(j.discountAmount).toBe(5);
    expect(j.discountType).toBe('percent');
  });

  it('offer discount above the hard cap is clamped (defence in depth)', async () => {
    const stub = makeFetchStub();
    stubCouponBackend(stub, { offer: { active: true, title: 'O', eshopDiscountType: 'percent', eshopDiscountAmount: 200, singleUse: true, endDate: '' } });
    globalThis.fetch = stub;
    const res = await worker.fetch(couponReq({ offerId: 'offer-1' }), couponEnv(), {});
    expect((await res.json()).discountAmount).toBe(50);
  });

  it('missing offerId → 400', async () => {
    const stub = makeFetchStub(); defaultAuthStubs(stub); globalThis.fetch = stub;
    const res = await worker.fetch(couponReq({}), couponEnv(), {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/offerId/i);
  });

  it('inactive offer → 403 (no coupon created)', async () => {
    const stub = makeFetchStub();
    stubCouponBackend(stub, { offer: { active: false, title: 'O', eshopDiscountType: 'percent', eshopDiscountAmount: 5, singleUse: true, endDate: '' } });
    globalThis.fetch = stub;
    const res = await worker.fetch(couponReq({ offerId: 'offer-1' }), couponEnv(), {});
    expect(res.status).toBe(403);
    expect(stub.calls.find(c => /wc\/v3\/coupons/.test(c.url) && c.method === 'POST')).toBeUndefined();
  });

  it('expired offer → 410', async () => {
    const stub = makeFetchStub();
    stubCouponBackend(stub, { offer: { active: true, title: 'O', eshopDiscountType: 'percent', eshopDiscountAmount: 5, singleUse: true, endDate: '2000-01-01' } });
    globalThis.fetch = stub;
    const res = await worker.fetch(couponReq({ offerId: 'offer-1' }), couponEnv(), {});
    expect(res.status).toBe(410);
  });

  it('offer without an e-shop coupon → 400', async () => {
    const stub = makeFetchStub();
    stubCouponBackend(stub, { offer: { active: true, title: 'O', eshopDiscountType: '', eshopDiscountAmount: 0, singleUse: true, endDate: '' } });
    globalThis.fetch = stub;
    const res = await worker.fetch(couponReq({ offerId: 'offer-1' }), couponEnv(), {});
    expect(res.status).toBe(400);
  });

  it('offer not found → 404 and NO coupon created', async () => {
    const stub = makeFetchStub(); stubCouponBackend(stub, { offerExists: false }); globalThis.fetch = stub;
    const res = await worker.fetch(couponReq({ offerId: 'ghost' }), couponEnv(), {});
    expect(res.status).toBe(404);
    expect(stub.calls.find(c => /wc\/v3\/coupons/.test(c.url) && c.method === 'POST')).toBeUndefined();
  });

  it('idempotent replay — an already-created redemption returns the SAME code, no new Woo coupon', async () => {
    const stub = makeFetchStub();
    stubCouponBackend(stub, { existingRedemption: { status: 'created', code: 'IPEAR-DEADBEEF01' } });
    globalThis.fetch = stub;
    const res = await worker.fetch(couponReq({ offerId: 'offer-1' }), couponEnv(), {});
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.replay).toBe(true);
    expect(j.code).toBe('IPEAR-DEADBEEF01');
    expect(stub.calls.find(c => /wc\/v3\/coupons/.test(c.url) && c.method === 'POST')).toBeUndefined();
  });

  it('Woo "code already exists" → recovers the existing coupon (lost-response / concurrency safety)', async () => {
    const stub = makeFetchStub(); stubCouponBackend(stub, { wooCreate: 'exists' }); globalThis.fetch = stub;
    const res = await worker.fetch(couponReq({ offerId: 'offer-1' }), couponEnv(), {});
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.code).toMatch(/^ipear-[0-9a-f]{10}$/i);
    expect(stub.calls.find(c => /wc\/v3\/coupons\?code=/.test(c.url))).toBeTruthy();
  });

  it('Woo create hard failure → 502, fail closed', async () => {
    const stub = makeFetchStub(); stubCouponBackend(stub, { wooCreate: 'fail' }); globalThis.fetch = stub;
    const res = await worker.fetch(couponReq({ offerId: 'offer-1' }), couponEnv(), {});
    expect(res.status).toBe(502);
  });

  it('coupon code is deterministic for (offer, customer) — same inputs → same code', async () => {
    const run = async () => {
      const stub = makeFetchStub(); stubCouponBackend(stub); globalThis.fetch = stub;
      const res = await worker.fetch(couponReq({ offerId: 'offer-1' }), couponEnv(), {});
      return (await res.json()).code;
    };
    const a = await run(); const b = await run();
    expect(a).toBe(b);
    expect(a).toMatch(/^ipear-[0-9a-f]{10}$/i);
  });

  it('different customers get DIFFERENT codes for the same offer', async () => {
    const codeFor = async (uid) => {
      const stub = makeFetchStub(); stubCouponBackend(stub, { uid, email: uid + '@test.gr' }); globalThis.fetch = stub;
      const res = await worker.fetch(couponReq({ offerId: 'offer-1' }), couponEnv(), {});
      return (await res.json()).code;
    };
    expect(await codeFor('uid-A')).not.toBe(await codeFor('uid-B'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  /woo-reward-coupon — POINTS-BASED e-shop reward (flow B), SERVER-AUTHORITATIVE
//  open-redemption model. Idempotency/recovery is proven WITHOUT any client key
//  (the server pointer ipear_reward_redemption_active is the source of truth).
// ═══════════════════════════════════════════════════════════════════════════
function stubRewardBackend(stub, opts = {}) {
  const {
    uid = 'uid-user-1', email = 'user@test.gr', blocked = false,
    points = 1000, custUpdateTime = '2026-01-01T00:00:00Z',
    reward = { isActive: true, eshopEligible: true, cost: 500, discount: 5, title: '5 euro' },
    rewardExists = true,
    pointer = null,        // null | { gen, status, redemptionId, completedAt }
    pointerSeq = null,     // array of pointer states for successive GETs (concurrency)
    redemptionDoc = null,  // ipear_offer_redemptions/{id} GET body (replay within window)
    ledgerExists = false,  // charge-ledger GET
    compExists = false,
    pointerCasFail = false,
    wooCreate = 'ok',
    wooCouponId = 77,
  } = opts;

  const S = { pointerGets: 0, pointerCommits: 0, chargeCommits: 0, compCommits: 0 };
  stub._rw = S;

  defaultAuthStubs(stub, { uid, email });

  stub.on('ipear_rewards/', () => rewardExists
    ? jsonResponse({ fields: {
        isActive: { booleanValue: reward.isActive }, eshopEligible: { booleanValue: reward.eshopEligible },
        cost: { integerValue: String(reward.cost) }, discount: { doubleValue: reward.discount }, title: { stringValue: reward.title },
      } })
    : jsonResponse({ error: { status: 'NOT_FOUND' } }, 404));

  stub.on('ipear_reward_redemption_active/', () => {
    const p = pointerSeq ? pointerSeq[Math.min(S.pointerGets, pointerSeq.length - 1)] : pointer;
    S.pointerGets++;
    if (!p) return jsonResponse({ error: { status: 'NOT_FOUND' } }, 404);
    return jsonResponse({ updateTime: '2026-01-01T00:00:00Z', fields: {
      gen: { integerValue: String(p.gen) }, status: { stringValue: p.status },
      redemptionId: { stringValue: p.redemptionId || ('rwdcpn__rw-1__' + uid + '__g' + p.gen) },
      ...(p.completedAt ? { completedAt: { stringValue: p.completedAt } } : {}),
    } });
  });

  stub.on('ipear_offer_redemptions/', ({ opts }) => {
    if ((opts?.method || 'GET') === 'GET') {
      return redemptionDoc
        ? jsonResponse({ fields: {
            status: { stringValue: redemptionDoc.status }, code: { stringValue: redemptionDoc.code || 'IPEAR-RXXXXXXXXX' },
            discountAmount: { doubleValue: redemptionDoc.discountAmount ?? 5 }, pointsSpent: { integerValue: String(redemptionDoc.pointsSpent ?? 500) },
            expiresAt: { stringValue: redemptionDoc.expiresAt || '2099-01-01' },
          } })
        : jsonResponse({ error: { status: 'NOT_FOUND' } }, 404);
    }
    return jsonResponse({ name: 'patched' });
  });

  stub.on('ipear_customers/', () => jsonResponse({
    fields: { email: { stringValue: email }, points: { integerValue: String(points) }, blocked: { booleanValue: blocked }, name: { stringValue: 'Tester' }, card: { stringValue: 'IP-TEST' } },
    updateTime: custUpdateTime,
  }));

  stub.on('ipear_transactions/', ({ url }) => {
    if (/rwdcpn_comp__/.test(url)) return compExists ? jsonResponse({ fields: {} }) : jsonResponse({ error: { status: 'NOT_FOUND' } }, 404);
    return ledgerExists ? jsonResponse({ fields: {} }) : jsonResponse({ error: { status: 'NOT_FOUND' } }, 404);
  });

  stub.on('ipear_security_events', () => jsonResponse({ name: 'sec' }));

  stub.on(':commit', ({ opts }) => {
    let b = {}; try { b = JSON.parse(opts.body); } catch (_) {}
    const names = (b.writes || []).map(w => w.update?.name || '').join(' ');
    const touchesCustomer = /ipear_customers/.test(names);
    if (/ipear_reward_redemption_active/.test(names) && !touchesCustomer) {
      S.pointerCommits++;
      if (pointerCasFail && S.pointerCommits === 1) return jsonResponse({ error: { code: 400, message: 'failed precondition' } }, 400);
      return jsonResponse({ commitTime: 't', writeResults: [] });
    }
    if (/rwdcpn_comp__/.test(names)) { S.compCommits++; return jsonResponse({ commitTime: 't' }); }
    S.chargeCommits++;
    return jsonResponse({ commitTime: 't', writeResults: [] });
  });

  stub.on(/wc\/v3\/coupons/, ({ url, opts }) => {
    const method = opts?.method || 'GET';
    if (method === 'GET') { const m = url.match(/[?&]code=([^&]+)/); return jsonResponse([{ id: wooCouponId, code: (m ? decodeURIComponent(m[1]) : 'x').toLowerCase() }]); }
    if (wooCreate === 'fail') return jsonResponse({ code: 'woo_error', message: 'boom' }, 500);
    if (wooCreate === 'exists') return new Response(JSON.stringify({ code: 'woocommerce_rest_coupon_code_already_exists', message: 'already exists' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const posted = (opts?.body && JSON.parse(opts.body).code) || 'ipear-rxxx';
    return jsonResponse({ id: wooCouponId, code: String(posted).toLowerCase() }, 201);
  });
}

// NOTE: no idempotencyKey — the server is authoritative. Tests prove recovery
// without any client-held key.
function rewardReq(body) { return makeRequest('/woo-reward-coupon', { body: { idToken: 'id-token', rewardId: 'rw-1', ...body } }); }
function chargeCommit(stub) {
  return stub.calls.filter(c => c.url.includes(':commit')).map(c => { try { return JSON.parse(c.body); } catch (_) { return {}; } })
    .find(b => (b.writes || []).some(w => /ipear_customers/.test(w.update?.name || '')) && (b.writes || []).some(w => /ipear_transactions/.test(w.update?.name || '')));
}

describe('/woo-reward-coupon — flow B, server-authoritative open-redemption model', () => {
  it('fresh redemption → deducts points once (atomic, points-only) + fixed_cart coupon', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub, { points: 1000, reward: { isActive: true, eshopEligible: true, cost: 500, discount: 5, title: '5€' } });
    globalThis.fetch = stub;
    const res = await worker.fetch(rewardReq({}), couponEnv(), {});
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true); expect(j.pointsSpent).toBe(500); expect(j.newBalance).toBe(500); expect(j.discountAmount).toBe(5);
    expect(j.code).toMatch(/^ipear-r[0-9a-f]{10}$/i);
    const cc = chargeCommit(stub);
    const custW = cc.writes.find(w => /ipear_customers/.test(w.update.name));
    expect(custW.update.fields.points.integerValue).toBe('500');
    expect(custW.updateMask.fieldPaths).toEqual(['points']);          // totalPoints untouched
    const ledW = cc.writes.find(w => /ipear_transactions/.test(w.update.name));
    expect(ledW.currentDocument.exists).toBe(false);
    expect(ledW.update.fields.type.stringValue).toBe('redeem');
    expect(ledW.update.fields.points.integerValue).toBe('-500');
    const post = stub.calls.find(c => /wc\/v3\/coupons/.test(c.url) && c.method === 'POST');
    const p = JSON.parse(post.body);
    expect(p.discount_type).toBe('fixed_cart'); expect(p.amount).toBe('5');
    expect(p.usage_limit).toBe(1); expect(p.usage_limit_per_user).toBe(1); expect(p.email_restrictions).toEqual(['user@test.gr']);
  });

  it('idempotencyKey NOT required (server authoritative)', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub); globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/woo-reward-coupon', { body: { idToken: 'id-token', rewardId: 'rw-1' } }), couponEnv(), {});
    expect(res.status).toBe(200);
  });

  it('OPEN redemption + ledger exists (first charge done, Woo lost) → key-less retry RESUMES: no 2nd charge', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub, { pointer: { gen: 1, status: 'open', redemptionId: 'rwdcpn__rw-1__uid-user-1__g1' }, ledgerExists: true });
    globalThis.fetch = stub;
    const res = await worker.fetch(rewardReq({}), couponEnv(), {});
    expect(res.status).toBe(200);
    expect(stub._rw.chargeCommits).toBe(0);           // NO second charge
    expect(stub.calls.find(c => /wc\/v3\/coupons/.test(c.url) && c.method === 'POST')).toBeTruthy(); // coupon (re)created idempotently
  });

  it('OPEN redemption + charge not yet committed → resumes and charges exactly once', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub, { pointer: { gen: 1, status: 'open', redemptionId: 'rwdcpn__rw-1__uid-user-1__g1' }, ledgerExists: false });
    globalThis.fetch = stub;
    const res = await worker.fetch(rewardReq({}), couponEnv(), {});
    expect(res.status).toBe(200);
    expect(stub._rw.chargeCommits).toBe(1);
  });

  it('COMPLETED within recovery window → key-less retry REPLAYS same coupon, no charge, no new coupon', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub, {
      pointer: { gen: 1, status: 'completed', redemptionId: 'rwdcpn__rw-1__uid-user-1__g1', completedAt: new Date().toISOString() },
      redemptionDoc: { status: 'created', code: 'IPEAR-RDEADBEEF0', discountAmount: 5, pointsSpent: 500 },
    });
    globalThis.fetch = stub;
    const res = await worker.fetch(rewardReq({}), couponEnv(), {});
    const j = await res.json();
    expect(j.replay).toBe(true); expect(j.code).toBe('IPEAR-RDEADBEEF0');
    expect(stub._rw.chargeCommits).toBe(0);
    expect(stub.calls.find(c => /wc\/v3\/coupons/.test(c.url) && c.method === 'POST')).toBeUndefined();
  });

  it('COMPLETED past the recovery window → a deliberate NEW redemption (gen+1) charges again', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub, {
      pointer: { gen: 1, status: 'completed', redemptionId: 'rwdcpn__rw-1__uid-user-1__g1', completedAt: '2020-01-01T00:00:00Z' },
      ledgerExists: false,
    });
    globalThis.fetch = stub;
    const res = await worker.fetch(rewardReq({}), couponEnv(), {});
    expect(res.status).toBe(200);
    expect(stub._rw.chargeCommits).toBe(1);
    const cc = chargeCommit(stub);
    expect(cc.writes.find(w => /ipear_transactions/.test(w.update.name)).update.fields.generation.integerValue).toBe('2');
  });

  it('COMPENSATED prior → a new redemption is allowed (gen+1), charges again', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub, { pointer: { gen: 1, status: 'compensated', redemptionId: 'rwdcpn__rw-1__uid-user-1__g1' }, ledgerExists: false });
    globalThis.fetch = stub;
    const res = await worker.fetch(rewardReq({}), couponEnv(), {});
    expect(res.status).toBe(200);
    expect(stub._rw.chargeCommits).toBe(1);
  });

  it('concurrency — pointer CAS lost → RESUMES the winner (no 2nd charge)', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub, {
      pointerSeq: [null, { gen: 1, status: 'open', redemptionId: 'rwdcpn__rw-1__uid-user-1__g1' }],
      pointerCasFail: true, ledgerExists: true,
    });
    globalThis.fetch = stub;
    const res = await worker.fetch(rewardReq({}), couponEnv(), {});
    expect(res.status).toBe(200);
    expect(stub._rw.chargeCommits).toBe(0); // winner already charged; we resume
  });

  it('Woo "code exists" (first response lost) → recovers the same coupon', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub, { wooCreate: 'exists' }); globalThis.fetch = stub;
    const res = await worker.fetch(rewardReq({}), couponEnv(), {});
    expect(res.status).toBe(200);
    expect(stub.calls.find(c => /wc\/v3\/coupons\?code=/.test(c.url))).toBeTruthy();
  });

  it('Woo hard failure → COMPENSATES (refund +cost, immutable reversal) then 502', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub, { wooCreate: 'fail' }); globalThis.fetch = stub;
    const res = await worker.fetch(rewardReq({}), couponEnv(), {});
    expect(res.status).toBe(502);
    expect(stub._rw.compCommits).toBe(1);
    const comp = stub.calls.filter(c => c.url.includes(':commit')).map(c => JSON.parse(c.body)).find(b => (b.writes || []).some(w => /rwdcpn_comp__/.test(w.update?.name || '')));
    const compLed = comp.writes.find(w => /ipear_transactions/.test(w.update.name));
    expect(compLed.currentDocument.exists).toBe(false);
    expect(compLed.update.fields.type.stringValue).toBe('add');
    expect(compLed.update.fields.points.integerValue).toBe('500');
  });

  it('compensation idempotent — comp ledger already exists → no duplicate refund', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub, { wooCreate: 'fail', compExists: true }); globalThis.fetch = stub;
    const res = await worker.fetch(rewardReq({}), couponEnv(), {});
    expect(res.status).toBe(502);
    expect(stub._rw.compCommits).toBe(0); // already refunded → no second compensation commit
  });

  it('insufficient points → 409, NO charge, NO coupon', async () => {
    const stub = makeFetchStub(); stubRewardBackend(stub, { points: 100, reward: { isActive: true, eshopEligible: true, cost: 500, discount: 5, title: '5€' } });
    globalThis.fetch = stub;
    const res = await worker.fetch(rewardReq({}), couponEnv(), {});
    expect(res.status).toBe(409);
    expect(stub._rw.chargeCommits).toBe(0);
    expect(stub.calls.find(c => /wc\/v3\/coupons/.test(c.url) && c.method === 'POST')).toBeUndefined();
  });

  it('reward not active → 403; not e-shop eligible → 403; not found → 404', async () => {
    let stub = makeFetchStub(); stubRewardBackend(stub, { reward: { isActive: false, eshopEligible: true, cost: 500, discount: 5, title: 'x' } }); globalThis.fetch = stub;
    expect((await worker.fetch(rewardReq({}), couponEnv(), {})).status).toBe(403);
    stub = makeFetchStub(); stubRewardBackend(stub, { reward: { isActive: true, eshopEligible: false, cost: 500, discount: 5, title: 'x' } }); globalThis.fetch = stub;
    expect((await worker.fetch(rewardReq({}), couponEnv(), {})).status).toBe(403);
    stub = makeFetchStub(); stubRewardBackend(stub, { rewardExists: false }); globalThis.fetch = stub;
    expect((await worker.fetch(rewardReq({ rewardId: 'ghost' }), couponEnv(), {})).status).toBe(404);
  });

  it('missing rewardId → 400', async () => {
    const stub = makeFetchStub(); defaultAuthStubs(stub); globalThis.fetch = stub;
    expect((await worker.fetch(makeRequest('/woo-reward-coupon', { body: { idToken: 'id-token' } }), couponEnv(), {})).status).toBe(400);
  });

  it('coupon code deterministic per generation', async () => {
    const run = async () => {
      const stub = makeFetchStub(); stubRewardBackend(stub); globalThis.fetch = stub;
      return (await (await worker.fetch(rewardReq({}), couponEnv(), {})).json()).code;
    };
    expect(await run()).toBe(await run());
  });
});
