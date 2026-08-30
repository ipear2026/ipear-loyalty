// ═══════════════════════════════════════════════════════════════════════════
//  legacy-cutover.test.js — proves Phase D of the removal plan works
//
//  Loads the real worker default export and exercises the router with the
//  `LOYALTY_LEGACY_MUTATION_DISABLED='true'` flag ON. Asserts:
//
//    • /woo-add-points with a valid ADMIN_SECRET → 410 Gone (not 200)
//    • /woo-refund-points with a valid ADMIN_SECRET → 410 Gone
//    • Response body carries `migrate_to` hint
//    • /woo-get-user (read-only) still works with ADMIN_SECRET (not killed)
//    • Flag OFF (or unset) → legacy path resumes normal behaviour
//    • The kill-switch is checked BEFORE the ADMIN_SECRET auth so an attacker
//      holding the admin secret cannot mutate loyalty balance after cutover.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../email-worker.js';

const ADMIN_SECRET = 'admin-secret-DEADBEEF-2026';
const WOO_SECRET   = 'woo-loyalty-secret-XYZ-2026';

function baseEnv(overrides = {}) {
  return {
    ADMIN_SECRET,
    WOO_LOYALTY_SECRET: WOO_SECRET,
    WOO_SITE_URL:       'https://ipear.gr',
    ALLOWED_ORIGINS:    'https://loyalty.ipear.gr',
    FCM_CLIENT_EMAIL:   'sa@x.iam',
    FCM_PRIVATE_KEY:    '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
    FCM_PROJECT_ID:     'test-project',
    RATE_LIMIT_KV:      { get: async () => null, put: async () => {} },
    ...overrides,
  };
}

function req(path, body, headers = {}) {
  return new Request('https://email-worker.example' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://loyalty.ipear.gr', ...headers },
    body: JSON.stringify(body || {}),
  });
}

describe('Phase D · legacy loyalty-mutation kill-switch', () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    // Never hit the network. If any handler tries to fetch after we expect
    // 410, this will throw and fail the test.
    globalThis.fetch = vi.fn(async () => { throw new Error('network call not permitted in kill-switch tests'); });
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('kill-switch ON + valid ADMIN_SECRET on /woo-add-points → 410 Gone, no mutation possible', async () => {
    const env = baseEnv({ LOYALTY_LEGACY_MUTATION_DISABLED: 'true' });
    const r = await worker.fetch(
      req('/woo-add-points', { email: 'x@y.gr', orderTotal: 100, orderId: '1' }, { Authorization: 'Bearer ' + ADMIN_SECRET }),
      env, {}
    );
    expect(r.status).toBe(410);
    const body = await r.json();
    expect(body.error).toBe('gone');
    expect(body.reason).toBe('legacy-mutation-endpoints-removed');
    expect(body.migrate_to).toBe('/woo-credit-order');
  });

  it('kill-switch ON + valid ADMIN_SECRET on /woo-refund-points → 410 Gone', async () => {
    const env = baseEnv({ LOYALTY_LEGACY_MUTATION_DISABLED: 'true' });
    const r = await worker.fetch(
      req('/woo-refund-points', { email: 'x@y.gr', orderTotal: 10, orderId: '1' }, { Authorization: 'Bearer ' + ADMIN_SECRET }),
      env, {}
    );
    expect(r.status).toBe(410);
    expect((await r.json()).migrate_to).toBe('/woo-refund-order');
  });

  it('kill-switch ON — the kill fires BEFORE ADMIN_SECRET check (missing auth ALSO gets 410, not 401)', async () => {
    const env = baseEnv({ LOYALTY_LEGACY_MUTATION_DISABLED: 'true' });
    const r = await worker.fetch(req('/woo-add-points', { email: 'x@y.gr', orderTotal: 100, orderId: '1' }), env, {});
    // Because gone-check runs first, 410 wins even without a bearer. This
    // documents that no code path can reach the mutation after cutover.
    expect(r.status).toBe(410);
  });

  it('kill-switch ON — /woo-get-user (read-only) is NOT killed, ADMIN_SECRET still works', async () => {
    // Read-only endpoint intentionally excluded from the kill list — no mutation risk.
    // We shim fetch so the handler can complete a customer lookup.
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const env = baseEnv({ LOYALTY_LEGACY_MUTATION_DISABLED: 'true' });
    const r = await worker.fetch(
      req('/woo-get-user', { email: 'x@y.gr' }, { Authorization: 'Bearer ' + ADMIN_SECRET }),
      env, {}
    );
    // The exact response depends on the handler's own logic (200 with empty
    // result, or 404). Either way, it is NOT 410.
    expect(r.status).not.toBe(410);
  });

  it('kill-switch OFF → /woo-add-points reaches the (legacy) handler as before', async () => {
    // With the flag unset, the router falls through to the legacy handler.
    // The handler will call Firestore; we shim fetch to return an empty
    // customer query so the request completes with 404 (customer-not-found)
    // rather than a network error. The important assertion is: NOT 410.
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const env = baseEnv();   // no LOYALTY_LEGACY_MUTATION_DISABLED
    const r = await worker.fetch(
      req('/woo-add-points', { email: 'x@y.gr', orderTotal: 100, orderId: '1' }, { Authorization: 'Bearer ' + ADMIN_SECRET }),
      env, {}
    );
    expect(r.status).not.toBe(410);
  });

  it('kill-switch ON does NOT affect the new /woo-credit-order (uses WOO_LOYALTY_SECRET, not ADMIN_SECRET)', async () => {
    // We want to prove the route is NOT killed by the flag. Building a real
    // JWT for a fake PEM is out of scope; unset FCM_PROJECT_ID so the handler
    // hits its own 503 "Server not configured" branch. Any response other
    // than 410 proves the kill-switch did not fire on this path.
    globalThis.fetch = vi.fn();   // must not be called
    const env = baseEnv({ LOYALTY_LEGACY_MUTATION_DISABLED: 'true', FCM_PROJECT_ID: '' });
    const r = await worker.fetch(
      req('/woo-credit-order', {
        orderId: '1234', email: 'x@y.gr', eligibleCents: 4560,
        orderCurrency: 'EUR', eventNonce: 'credit-1234-4560',
      }, { Authorization: 'Bearer ' + WOO_SECRET }),
      env, {}
    );
    expect(r.status).not.toBe(410);
    expect(r.status).toBe(503);   // reached handler, hit config check
  });

  it('post-cutover: ADMIN_SECRET on any mutation endpoint cannot change loyalty balance', async () => {
    // Meta-assertion: enumerate every path that could historically mutate
    // loyalty balance via ADMIN_SECRET. After Phase D, none of them succeed.
    const env = baseEnv({ LOYALTY_LEGACY_MUTATION_DISABLED: 'true' });
    const mutationPaths = ['/woo-add-points', '/woo-refund-points'];
    for (const p of mutationPaths) {
      const r = await worker.fetch(
        req(p, { email: 'x@y.gr', orderTotal: 999, orderId: '1' }, { Authorization: 'Bearer ' + ADMIN_SECRET }),
        env, {}
      );
      expect(r.status, `expected 410 for ${p}`).toBe(410);
    }
  });
});
