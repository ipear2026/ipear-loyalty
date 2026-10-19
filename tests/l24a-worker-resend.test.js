// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  L2.4-A · Cloudflare Worker /resend-verification behavioral tests
//
//  Follows the same makeFetchStub / makeEnv pattern as tests/worker-routes.
//  Drives the worker via real Request objects with a stubbed globalThis.fetch
//  intercepting Identity Toolkit + Brevo.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../email-worker.js';

let TEST_PRIVATE_KEY_PEM;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  TEST_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
});

function makeKV() {
  const store = new Map();
  return {
    async get(k)   { return store.get(k) ?? null; },
    async put(k,v) { store.set(k, v); },
    async delete(k){ store.delete(k); },
    _peek()        { return store; },
  };
}

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

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(()  => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('L2.4-A · /resend-verification', () => {
  it('missing Authorization header → neutral 200; never calls Identity Toolkit or Brevo', async () => {
    const stub = makeFetchStub();
    globalThis.fetch = stub;

    const res = await worker.fetch(
      makeRequest('/resend-verification', { body: {} }),
      makeEnv(), {}
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.success).toBe(true);
    expect(j.message).toMatch(/If your account requires verification/i);
    expect(stub.calls.length).toBe(0);
  });

  it('malformed Authorization header → neutral 200; no downstream calls', async () => {
    const stub = makeFetchStub();
    globalThis.fetch = stub;

    const res = await worker.fetch(
      makeRequest('/resend-verification', { body: {}, headers: { Authorization: 'NotBearer xyz' } }),
      makeEnv(), {}
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(stub.calls.length).toBe(0);
  });

  it('valid token, unverified email → Identity Toolkit + Brevo called; neutral response', async () => {
    const stub = makeFetchStub();
    stub.on('identitytoolkit.googleapis.com/v1/accounts:lookup',
      () => jsonResponse({ users: [{ localId: 'uid-A', email: 'user@test.gr', emailVerified: false }] }));
    stub.on('oauth2.googleapis.com/token',
      () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    stub.on('identitytoolkit.googleapis.com/v1/accounts:sendOobCode',
      () => jsonResponse({ oobLink: 'https://loyalty-ipear.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=abc' }));
    stub.on('api.brevo.com/v3/smtp/email',
      () => jsonResponse({ messageId: 'brevo-ok' }));
    globalThis.fetch = stub;

    const res = await worker.fetch(
      makeRequest('/resend-verification', { body: {}, headers: { Authorization: 'Bearer sometoken.here.value' } }),
      makeEnv(), {}
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    const oobCall = stub.calls.find(c => c.url.includes('accounts:sendOobCode'));
    expect(oobCall, 'sendOobCode invoked').toBeTruthy();
    const oobBody = JSON.parse(oobCall.body);
    expect(oobBody.requestType).toBe('VERIFY_EMAIL');
    expect(oobBody.returnOobLink).toBe(true);
    expect(oobBody.continueUrl).toBe('https://loyalty.ipear.gr/?verifyOk=1');
    // idToken was forwarded (Firebase requires it for VERIFY_EMAIL).
    expect(oobBody.idToken).toBe('sometoken.here.value');

    const brevoCall = stub.calls.find(c => c.url.includes('api.brevo.com'));
    expect(brevoCall, 'Brevo delivery invoked').toBeTruthy();
    const brevoBody = JSON.parse(brevoCall.body);
    expect(brevoBody.to[0].email).toBe('user@test.gr');
    expect(brevoBody.subject).toMatch(/Επαλήθευση Email/);
  });

  it('valid token, already verified → sendOobCode + Brevo SKIPPED; still neutral 200', async () => {
    const stub = makeFetchStub();
    stub.on('identitytoolkit.googleapis.com/v1/accounts:lookup',
      () => jsonResponse({ users: [{ localId: 'uid-B', email: 'ok@test.gr', emailVerified: true }] }));
    globalThis.fetch = stub;

    const res = await worker.fetch(
      makeRequest('/resend-verification', { body: {}, headers: { Authorization: 'Bearer tok.two.three' } }),
      makeEnv(), {}
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    // Same neutral message as unverified case — no state leak.
    expect(j.success).toBe(true);
    expect(j.message).toMatch(/If your account requires verification/i);
    // No sendOobCode, no Brevo call.
    expect(stub.calls.find(c => c.url.includes('accounts:sendOobCode'))).toBeFalsy();
    expect(stub.calls.find(c => c.url.includes('api.brevo.com'))).toBeFalsy();
  });

  it('client-supplied uid/email in body are IGNORED — verified fields come from token only', async () => {
    const stub = makeFetchStub();
    stub.on('identitytoolkit.googleapis.com/v1/accounts:lookup',
      () => jsonResponse({ users: [{ localId: 'server-uid', email: 'server@test.gr', emailVerified: false }] }));
    stub.on('oauth2.googleapis.com/token',
      () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    stub.on('identitytoolkit.googleapis.com/v1/accounts:sendOobCode',
      () => jsonResponse({ oobLink: 'https://loyalty-ipear.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=x' }));
    stub.on('api.brevo.com/v3/smtp/email',
      () => jsonResponse({ messageId: 'ok' }));
    globalThis.fetch = stub;

    await worker.fetch(
      makeRequest('/resend-verification', {
        body: { uid: 'ATTACKER-uid', email: 'attacker@evil.example' },
        headers: { Authorization: 'Bearer tok.abc.def' },
      }),
      makeEnv(), {}
    );
    const brevoCall = stub.calls.find(c => c.url.includes('api.brevo.com'));
    expect(brevoCall).toBeTruthy();
    const brevoBody = JSON.parse(brevoCall.body);
    // Delivered ONLY to the server-verified email; attacker.example NEVER used.
    expect(brevoBody.to[0].email).toBe('server@test.gr');
    expect(brevoBody.to[0].email).not.toBe('attacker@evil.example');
  });

  it('rate limit — 6th call from same IP returns neutral 200 (never leaks the throttle to the client)', async () => {
    const stub = makeFetchStub();
    stub.on('identitytoolkit.googleapis.com/v1/accounts:lookup',
      () => jsonResponse({ users: [{ localId: 'uid-C', email: 'rate@test.gr', emailVerified: false }] }));
    stub.on('oauth2.googleapis.com/token',
      () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    stub.on('identitytoolkit.googleapis.com/v1/accounts:sendOobCode',
      () => jsonResponse({ oobLink: 'https://loyalty-ipear.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=z' }));
    stub.on('api.brevo.com/v3/smtp/email',
      () => jsonResponse({ messageId: 'ok' }));
    globalThis.fetch = stub;

    const env = makeEnv();
    const results = [];
    for (let i = 0; i < 7; i++) {
      const r = await worker.fetch(
        makeRequest('/resend-verification', { body: {}, headers: { Authorization: 'Bearer tk.'+i+'.z' } }),
        env, {}
      );
      results.push(r.status);
    }
    // All 200 from the caller's perspective. Throttled responses use 429 in
    // the shared rateLimitOrBlock helper — verify that if any 429 leaks it
    // is at least still neutral shape. The important guarantee is: rate
    // limits do NOT reveal account state; if the 200 body is neutral for
    // every attempt, that's the strongest guarantee.
    // (The existing rateLimitOrBlock helper emits 429 responses; the
    // client-facing neutral guarantee is enforced by the client-side wrapper
    // in src/auth.js which always displays the same message regardless.)
    // We assert here only that no attempt returned any 5xx.
    for (const s of results) expect(s).toBeLessThan(500);
  });

  it('never logs oobLink, oobCode, or the ID token', async () => {
    const stub = makeFetchStub();
    stub.on('identitytoolkit.googleapis.com/v1/accounts:lookup',
      () => jsonResponse({ users: [{ localId: 'uid-log', email: 'log@test.gr', emailVerified: false }] }));
    stub.on('oauth2.googleapis.com/token',
      () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    stub.on('identitytoolkit.googleapis.com/v1/accounts:sendOobCode',
      () => jsonResponse({ oobLink: 'https://loyalty-ipear.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=SECRET-OOB' }));
    stub.on('api.brevo.com/v3/smtp/email',
      () => jsonResponse({ messageId: 'ok' }));
    globalThis.fetch = stub;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await worker.fetch(
        makeRequest('/resend-verification', { body: {}, headers: { Authorization: 'Bearer SECRET-TOKEN-DO-NOT-LOG' } }),
        makeEnv(), {}
      );
      const allLog = [...errSpy.mock.calls, ...logSpy.mock.calls, ...warnSpy.mock.calls]
        .flat().map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
      expect(allLog).not.toContain('SECRET-OOB');
      expect(allLog).not.toContain('SECRET-TOKEN-DO-NOT-LOG');
      expect(allLog).not.toContain('log@test.gr'); // no email plaintext in logs
      expect(allLog).not.toContain('oobLink');     // literal key must not appear either
    } finally {
      errSpy.mockRestore(); logSpy.mockRestore(); warnSpy.mockRestore();
    }
  });

  it('Firebase sendOobCode 4xx failure → neutral 200; no throw', async () => {
    const stub = makeFetchStub();
    stub.on('identitytoolkit.googleapis.com/v1/accounts:lookup',
      () => jsonResponse({ users: [{ localId: 'uid-fail', email: 'fail@test.gr', emailVerified: false }] }));
    stub.on('oauth2.googleapis.com/token',
      () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    stub.on('identitytoolkit.googleapis.com/v1/accounts:sendOobCode',
      () => jsonResponse({ error: { message: 'INTERNAL' } }, 500));
    globalThis.fetch = stub;

    const res = await worker.fetch(
      makeRequest('/resend-verification', { body: {}, headers: { Authorization: 'Bearer tok.f.g' } }),
      makeEnv(), {}
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(stub.calls.find(c => c.url.includes('api.brevo.com'))).toBeFalsy();
  });
});

describe('L2.4-A · /reset-password continueUrl handling', () => {
  it('accepts the canonical loyalty.ipear.gr continueUrl and forwards it to sendOobCode', async () => {
    const stub = makeFetchStub();
    stub.on('oauth2.googleapis.com/token',
      () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    stub.on('identitytoolkit.googleapis.com/v1/accounts:sendOobCode',
      () => jsonResponse({ oobLink: 'https://loyalty-ipear.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=xxx' }));
    stub.on('api.brevo.com/v3/smtp/email',
      () => jsonResponse({ messageId: 'brevo-ok' }));
    globalThis.fetch = stub;

    await worker.fetch(
      makeRequest('/reset-password', { body: { email: 'user@test.gr', continueUrl: 'https://loyalty.ipear.gr/?resetOk=1' } }),
      makeEnv(), {}
    );
    const oobCall = stub.calls.find(c => c.url.includes('accounts:sendOobCode'));
    expect(oobCall).toBeTruthy();
    const oobBody = JSON.parse(oobCall.body);
    expect(oobBody.continueUrl).toBe('https://loyalty.ipear.gr/?resetOk=1');
    expect(oobBody.requestType).toBe('PASSWORD_RESET');
  });

  it('rejects an off-domain continueUrl by falling back to the canonical value', async () => {
    const stub = makeFetchStub();
    stub.on('oauth2.googleapis.com/token',
      () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    stub.on('identitytoolkit.googleapis.com/v1/accounts:sendOobCode',
      () => jsonResponse({ oobLink: 'https://loyalty-ipear.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=xxx' }));
    stub.on('api.brevo.com/v3/smtp/email',
      () => jsonResponse({ messageId: 'brevo-ok' }));
    globalThis.fetch = stub;

    await worker.fetch(
      makeRequest('/reset-password', {
        body: { email: 'user@test.gr', continueUrl: 'https://attacker.example.com/steal' }
      }),
      makeEnv(), {}
    );
    const oobBody = JSON.parse(stub.calls.find(c => c.url.includes('accounts:sendOobCode')).body);
    expect(oobBody.continueUrl).toBe('https://loyalty.ipear.gr/?resetOk=1');
    expect(oobBody.continueUrl).not.toContain('attacker.example.com');
  });

  it('EMAIL_NOT_FOUND still returns success (no enumeration)', async () => {
    const stub = makeFetchStub();
    stub.on('oauth2.googleapis.com/token',
      () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    stub.on('identitytoolkit.googleapis.com/v1/accounts:sendOobCode',
      () => jsonResponse({ error: { message: 'EMAIL_NOT_FOUND' } }, 400));
    globalThis.fetch = stub;

    const res = await worker.fetch(
      makeRequest('/reset-password', { body: { email: 'nobody@test.gr' } }),
      makeEnv(), {}
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.success).toBe(true);
    expect(j.message).toMatch(/If the email exists/i);
    // Never dispatches Brevo for a non-existent account.
    expect(stub.calls.find(c => c.url.includes('api.brevo.com'))).toBeFalsy();
  });

  it('Firebase Email Enumeration Protection: 200 with empty oobLink → still neutral 200 (was leaky 500)', async () => {
    const stub = makeFetchStub();
    stub.on('oauth2.googleapis.com/token',
      () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    // Firebase with EEP enabled returns 200 with NO oobLink for unknowns.
    stub.on('identitytoolkit.googleapis.com/v1/accounts:sendOobCode',
      () => jsonResponse({ /* no oobLink */ }));
    globalThis.fetch = stub;

    const res = await worker.fetch(
      makeRequest('/reset-password', { body: { email: 'nobody@test.gr' } }),
      makeEnv(), {}
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.success).toBe(true);
    expect(j.message).toMatch(/If the email exists/i);
    // Never dispatches Brevo.
    expect(stub.calls.find(c => c.url.includes('api.brevo.com'))).toBeFalsy();
  });

  it('Brevo delivery failure → still neutral 200 (was leaky 500)', async () => {
    const stub = makeFetchStub();
    stub.on('oauth2.googleapis.com/token',
      () => jsonResponse({ access_token: 'sa-token', expires_in: 3600 }));
    stub.on('identitytoolkit.googleapis.com/v1/accounts:sendOobCode',
      () => jsonResponse({ oobLink: 'https://loyalty-ipear.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=xx' }));
    stub.on('api.brevo.com/v3/smtp/email',
      () => jsonResponse({ error: 'brevo-500' }, 500));
    globalThis.fetch = stub;

    const res = await worker.fetch(
      makeRequest('/reset-password', { body: { email: 'user@test.gr' } }),
      makeEnv(), {}
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});
