// ═══════════════════════════════════════════════════════════════════════════
//  legacy-cutover.test.js — Stage 3F end-state.
//
//  The legacy ADMIN_SECRET loyalty routes (/woo-add-points, /woo-refund-points,
//  /woo-get-user) are PERMANENTLY retired: the Worker contains no ADMIN_SECRET
//  comparison, no kill-switch, and no rollback switch. Every one of these paths
//  returns an unconditional 410 {"error":"endpoint-retired"} regardless of any
//  credential or env flag. The authoritative replacements are /woo-credit-order
//  and /woo-refund-order (WOO_LOYALTY_SECRET) and /woo/v2/get-user
//  (WOO_LOOKUP_SECRET). This file guards against any regression that would
//  revive a master-secret mutation vector.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../email-worker.js';

const ADMIN_SECRET = 'admin-secret-DEADBEEF-2026';
const WOO_SECRET   = 'woo-loyalty-secret-XYZ-2026';

function baseEnv(overrides = {}) {
  return {
    ADMIN_SECRET,                       // still a config string, but no code reads it
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

describe('Stage 3F · legacy ADMIN_SECRET loyalty routes permanently retired', () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    // No network permitted — a 410 must be returned before any downstream call.
    globalThis.fetch = vi.fn(async () => { throw new Error('network call not permitted for a retired route'); });
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  const RETIRED = ['/woo-add-points', '/woo-refund-points', '/woo-get-user'];

  it.each(RETIRED)('%s → 410 endpoint-retired with a correct ADMIN_SECRET (no authority)', async (path) => {
    const r = await worker.fetch(
      req(path, { email: 'x@y.gr', orderTotal: 100, orderId: '1' }, { Authorization: 'Bearer ' + ADMIN_SECRET }),
      baseEnv(), {}
    );
    expect(r.status).toBe(410);
    expect((await r.json()).error).toBe('endpoint-retired');
  });

  it.each(RETIRED)('%s → 410 with NO credential (identical response, no oracle)', async (path) => {
    const r = await worker.fetch(req(path, { email: 'x@y.gr', orderTotal: 100, orderId: '1' }), baseEnv(), {});
    expect(r.status).toBe(410);
  });

  it.each(RETIRED)('%s → 410 even with the dead rollback switch set', async (path) => {
    const r = await worker.fetch(
      req(path, { email: 'x@y.gr', orderTotal: 100, orderId: '1' }, { Authorization: 'Bearer ' + ADMIN_SECRET }),
      baseEnv({ ADMIN_LEGACY_ROUTES_ENABLED: 'true', LOYALTY_LEGACY_MUTATION_DISABLED: 'false' }), {}
    );
    expect(r.status).toBe(410);
  });

  it('post-cutover: ADMIN_SECRET on any legacy mutation endpoint cannot change loyalty balance', async () => {
    for (const p of ['/woo-add-points', '/woo-refund-points']) {
      const r = await worker.fetch(
        req(p, { email: 'x@y.gr', orderTotal: 999, orderId: '1' }, { Authorization: 'Bearer ' + ADMIN_SECRET }),
        baseEnv(), {}
      );
      expect(r.status, `expected 410 for ${p}`).toBe(410);
    }
  });

  it('the authoritative /woo-credit-order is NOT retired (reaches handler; wrong secret → 401)', async () => {
    globalThis.fetch = vi.fn();   // must not be called
    const r = await worker.fetch(
      req('/woo-credit-order', {
        orderId: '1234', email: 'x@y.gr', eligibleCents: 4560,
        orderCurrency: 'EUR', eventNonce: 'credit-1234-4560',
      }, { Authorization: 'Bearer wrong-secret' }),
      baseEnv(), {}
    );
    expect(r.status).not.toBe(410);
    expect(r.status).toBe(401);
  });
});
