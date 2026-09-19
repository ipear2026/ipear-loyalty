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
import { generateKeyPairSync } from 'node:crypto';
import worker from '../email-worker.js';

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

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
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

describe('admin-gated endpoints', () => {
  it.each([
    ['/sms',       { phone: '6900000000', message: 'x' }],
    ['/bulk-sms',  { recipients: [{ phone: '6900000000' }], message: 'x' }],
  ])('%s rejects without ADMIN_SECRET', async (path, body) => {
    const fetchStub = makeFetchStub();
    globalThis.fetch = fetchStub;
    const res = await worker.fetch(makeRequest(path, { body }), makeEnv(), {});
    expect(res.status).toBe(401);
  });

  it.each([
    ['/sms',       { phone: '6900000000', message: 'x' }],
    ['/bulk-sms',  { recipients: [{ phone: '6900000000' }], message: 'x' }],
  ])('%s rejects with WRONG ADMIN_SECRET', async (path, body) => {
    const fetchStub = makeFetchStub();
    globalThis.fetch = fetchStub;
    const res = await worker.fetch(makeRequest(path, {
      body, headers: { Authorization: 'Bearer wrong-secret' }
    }), makeEnv(), {});
    expect(res.status).toBe(401);
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
    globalThis.fetch = stub;

    const res = await worker.fetch(makeRequest('/admin/delete-auth-user', {
      body: { uid: 'uid-del-1', email: 'del@test.gr' },
      headers: { Authorization: 'Bearer test-admin-secret' },
    }), makeEnv(), {});

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
    globalThis.fetch = stub;

    const res = await worker.fetch(makeRequest('/admin/delete-auth-user', {
      body: { uid: 'uid-del-2' },
      headers: { Authorization: 'Bearer test-admin-secret' },
    }), makeEnv(), {});

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    // No commit attempted when nothing matched
    expect(stub.calls.some(c => c.url.includes(':commit'))).toBe(false);
  });

  it('rejects without ADMIN_SECRET', async () => {
    const stub = makeFetchStub();
    globalThis.fetch = stub;
    const res = await worker.fetch(makeRequest('/admin/delete-auth-user', {
      body: { uid: 'x' },
    }), makeEnv(), {});
    expect(res.status).toBe(401);
  });
});
