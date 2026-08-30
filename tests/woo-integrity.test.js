// ═══════════════════════════════════════════════════════════════════════════
//  Tests for woo-integrity.js — Phase L1 (audit-corrected suite)
//
//  Coverage requirements from L1 audit:
//    • Auth isolation (WOO_LOYALTY_SECRET only; ADMIN_SECRET rejected)
//    • Cumulative refund reconciliation (rounding-drift proof)
//    • Refund-before-credit path (pre_credit_refunds → net eligible on credit)
//    • Identity freeze (billing email changing to a different customer → 409)
//    • Retry-safety (commit succeeded + response lost → replay, not double-mutation)
//    • KV cache absent / stale / wrong (correctness derives from Firestore)
//    • Concurrent identical credits (contention → replay)
//    • Deterministic audit doc IDs
//    • No business cap on eligibleCents
//    • Secret never appears in any response body / error message
//
//  Run:  cd buildL1/worker && ./node_modules/.bin/vitest run --pool=threads
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleWooCreditOrder, handleWooRefundOrder,
  decideCredit, decideRefund, STATE, _test,
} from '../src/worker/lib/woo-integrity.js';

const { siteHashFromEnv, ledgerDocId, auditCreditDocId, auditRefundDocId, pointsFromCents, verifyWooSecret } = _test;

// ──────────────────────────────────────────────────────────────────────────
//  Timing-safe equal — spec-compatible with the real worker's helper
// ──────────────────────────────────────────────────────────────────────────
async function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return acc === 0;
}

// ──────────────────────────────────────────────────────────────────────────
//  Env / request helpers
// ──────────────────────────────────────────────────────────────────────────
const WOO_SECRET = 'woo-loyalty-secret-XYZ-2026';
const ADMIN_SECRET = 'admin-secret-DEADBEEF-2026';

function mockEnv(o = {}) {
  return {
    WOO_LOYALTY_SECRET: WOO_SECRET,
    ADMIN_SECRET:       ADMIN_SECRET,
    WOO_SITE_URL:       'https://ipear.gr',
    FCM_CLIENT_EMAIL:   'sa@x.iam',
    FCM_PRIVATE_KEY:    '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
    FCM_PROJECT_ID:     'test-project',
    RATE_LIMIT_KV:      { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    ...o,
  };
}

function makeReq(path, body, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (!('Authorization' in h) && !('authorization' in h)) h.Authorization = 'Bearer ' + WOO_SECRET;
  return new Request('https://worker.example' + path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
}

const CORS = { 'Access-Control-Allow-Origin': '*' };
const fakeGetAccessToken = vi.fn(async () => 'FAKE_ACCESS_TOKEN');

function makeDeps() {
  return {
    resp: (data, status = 200, headers = {}) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } }),
    readJson: async (req) => JSON.parse(await req.text()),
    getAccessToken: fakeGetAccessToken,
    timingSafeEqual,
    rebuildLeaderboard: vi.fn(async () => {}),
  };
}

const validCredit = () => ({
  orderId:       '1234',
  email:         'test@example.com',
  eligibleCents: 4560,
  orderCurrency: 'EUR',
  eventNonce:    'credit-1234-4560',
});
const validRefund = () => ({
  orderId:     '1234',
  refundId:    'r-777',
  email:       'test@example.com',
  refundCents: 1500,
  eventNonce:  'refund-1234-r-777',
});

// ═══════════════════════════════════════════════════════════════════════════
//  1 · PURE MATH & IDENTITY
// ═══════════════════════════════════════════════════════════════════════════

describe('1 · points math (integer cents → int points, floor)', () => {
  it('4560 cents → 456 points', () => expect(pointsFromCents(4560)).toBe(456));
  it('0 → 0',                     () => expect(pointsFromCents(0)).toBe(0));
  it('9 → 0 (floor)',              () => expect(pointsFromCents(9)).toBe(0));
  it('1234 → 123 (floor)',         () => expect(pointsFromCents(1234)).toBe(123));
  it('1M€ (100_000_000c) → 10_000_000 points (no cap)', () => expect(pointsFromCents(100_000_000)).toBe(10_000_000));
  it('handles extremely large orders — no arbitrary cap', () => {
    // Identity: pointsFromCents(cents) === floor(cents / 10)
    // 1M€ order = 100_000_000 cents → 10_000_000 points
    expect(pointsFromCents(100_000_000)).toBe(10_000_000);
    // 10M€ order = 1_000_000_000 cents → 100_000_000 points
    expect(pointsFromCents(1_000_000_000)).toBe(100_000_000);
    // 100M€ order (extreme edge) = 10_000_000_000 cents → 1_000_000_000 points
    expect(pointsFromCents(10_000_000_000)).toBe(1_000_000_000);
    // Off-by-one floor sanity
    expect(pointsFromCents(1_000_000_009)).toBe(100_000_000);
  });
});

describe('1 · siteHashFromEnv is server-side only', () => {
  it('deterministic', async () => {
    expect(await siteHashFromEnv({ WOO_SITE_URL: 'https://ipear.gr' }))
      .toBe(await siteHashFromEnv({ WOO_SITE_URL: 'https://ipear.gr' }));
  });
  it('normalizes case + whitespace', async () => {
    expect(await siteHashFromEnv({ WOO_SITE_URL: 'https://ipear.gr' }))
      .toBe(await siteHashFromEnv({ WOO_SITE_URL: '  HTTPS://IPEAR.GR  ' }));
  });
  it('throws 503 when unset (never falls back to request body)', async () => {
    await expect(siteHashFromEnv({})).rejects.toThrow(/WOO_SITE_URL/);
  });
  it('12-char hex', async () => {
    expect(await siteHashFromEnv({ WOO_SITE_URL: 'https://ipear.gr' })).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('1 · deterministic doc IDs', () => {
  it('ledgerDocId is stable', () => expect(ledgerDocId('abc', '1234')).toBe('abc__1234'));
  it('ledgerDocId sanitizes orderId', () => expect(ledgerDocId('abc', 'x/../;\\')).toBe('abc__x'));
  it('auditCreditDocId includes nonce (retry-safe)', () => {
    expect(auditCreditDocId('abc__1', 'credit-1-4560')).toBe('wooc__abc__1__credit-1-4560');
  });
  it('auditRefundDocId includes refundId', () => {
    expect(auditRefundDocId('abc__1', 'r-99')).toBe('woor__abc__1__r-99');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2 · AUTH ISOLATION (blocker 1)
// ═══════════════════════════════════════════════════════════════════════════

describe('2 · Auth isolation — WOO_LOYALTY_SECRET ONLY', () => {
  beforeEach(() => { globalThis.fetch = vi.fn(); });

  it('correct WOO_LOYALTY_SECRET is accepted (proceeds past auth)', async () => {
    // We stop it later at customer lookup (returns 404) — enough to prove auth passed.
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(404);   // "Customer not found" — auth passed
  });

  it('ADMIN_SECRET is REJECTED with 401 (no fallback)', async () => {
    const req = makeReq('/woo-credit-order', validCredit(), { Authorization: 'Bearer ' + ADMIN_SECRET });
    const r = await handleWooCreditOrder(req, mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error).toBe('Unauthorized');
    // Never leak either secret in the response
    expect(JSON.stringify(body)).not.toContain(WOO_SECRET);
    expect(JSON.stringify(body)).not.toContain(ADMIN_SECRET);
  });

  it('missing Authorization header → 401', async () => {
    const req = new Request('https://worker.example/woo-credit-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validCredit()),
    });
    const r = await handleWooCreditOrder(req, mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(401);
    expect((await r.json()).reason).toBe('missing-auth');
  });

  it('wrong secret → 401', async () => {
    const req = makeReq('/woo-credit-order', validCredit(), { Authorization: 'Bearer wrong-secret' });
    const r = await handleWooCreditOrder(req, mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(401);
    expect((await r.json()).reason).toBe('bad-auth');
  });

  it('empty WOO_LOYALTY_SECRET in env → 503, never accepts blank bearer', async () => {
    const env = mockEnv({ WOO_LOYALTY_SECRET: '' });
    const r1 = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit(), { Authorization: 'Bearer ' }), env, CORS, null, makeDeps());
    expect(r1.status).toBe(503);
    const r2 = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), env, CORS, null, makeDeps());
    expect(r2.status).toBe(503);
  });

  it('refund handler has same isolation', async () => {
    globalThis.fetch = vi.fn();
    const r = await handleWooRefundOrder(makeReq('/woo-refund-order', validRefund(), { Authorization: 'Bearer ' + ADMIN_SECRET }), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(401);
  });

  it('verifyWooSecret helper is a timing-safe compare', async () => {
    const env = { WOO_LOYALTY_SECRET: 'abc' };
    const okReq = { headers: { get: () => 'Bearer abc' } };
    const badReq = { headers: { get: () => 'Bearer abd' } };
    expect((await verifyWooSecret(okReq, env, timingSafeEqual)).ok).toBe(true);
    expect((await verifyWooSecret(badReq, env, timingSafeEqual)).ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  3 · decideCredit FSM
// ═══════════════════════════════════════════════════════════════════════════

describe('3 · decideCredit FSM', () => {
  it('absent → apply', () => {
    const d = decideCredit({ state: STATE.ABSENT }, { eligibleCents: 4560, nonce: 'n1' });
    expect(d.kind).toBe('apply');
    expect(d.pointsDelta).toBe(456);
    expect(d.creditedEligibleCents).toBe(4560);
    expect(d.becomes).toBe(STATE.CREDITED);
  });

  it('credited + same nonce + same cents → replay', () => {
    const l = { state: STATE.CREDITED, creditNonce: 'n1', grossEligibleCents: 4560, creditedEligibleCents: 4560, originalPointsAwarded: 456 };
    const d = decideCredit(l, { eligibleCents: 4560, nonce: 'n1' });
    expect(d.kind).toBe('replay');
  });

  it('credited + different nonce + same cents → replay (WP nonce loss safety)', () => {
    const l = { state: STATE.CREDITED, creditNonce: 'n1', grossEligibleCents: 4560, creditedEligibleCents: 4560, originalPointsAwarded: 456 };
    const d = decideCredit(l, { eligibleCents: 4560, nonce: 'n999' });
    expect(d.kind).toBe('replay');
  });

  it('credited + different cents → conflict', () => {
    const l = { state: STATE.CREDITED, creditNonce: 'n1', grossEligibleCents: 4560, creditedEligibleCents: 4560, originalPointsAwarded: 456 };
    const d = decideCredit(l, { eligibleCents: 5000, nonce: 'n2' });
    expect(d.kind).toBe('conflict');
    expect(d.reason).toBe('credited-different-cents');
  });

  it('PRE_REFUNDED + eligible > preRefund → apply net', () => {
    const l = { state: STATE.PRE_REFUNDED, preCreditRefunds: [{ cents: 2000 }, { cents: 500 }] };
    const d = decideCredit(l, { eligibleCents: 4560, nonce: 'n1' });
    expect(d.kind).toBe('apply');
    expect(d.creditedEligibleCents).toBe(4560 - 2500);  // 2060
    expect(d.pointsDelta).toBe(pointsFromCents(2060));  // 206
    expect(d.becomes).toBe(STATE.CREDITED);
  });

  it('PRE_REFUNDED + eligible ≤ preRefund → zero-net (no balance mutation)', () => {
    const l = { state: STATE.PRE_REFUNDED, preCreditRefunds: [{ cents: 5000 }] };
    const d = decideCredit(l, { eligibleCents: 4560, nonce: 'n1' });
    expect(d.kind).toBe('apply');
    expect(d.pointsDelta).toBe(0);
    expect(d.creditedEligibleCents).toBe(0);
    expect(d.becomes).toBe(STATE.ZERO_NET_CREDIT);
  });

  it('REFUNDED + same cents → replay', () => {
    const l = { state: STATE.REFUNDED, creditNonce: 'n1', grossEligibleCents: 4560, creditedEligibleCents: 4560, originalPointsAwarded: 456 };
    const d = decideCredit(l, { eligibleCents: 4560, nonce: 'n2' });
    expect(d.kind).toBe('replay');
  });

  it('CANCELLED → conflict', () => {
    const d = decideCredit({ state: STATE.CANCELLED }, { eligibleCents: 4560, nonce: 'n1' });
    expect(d.kind).toBe('conflict');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  4 · decideRefund FSM + cumulative reconciliation (blocker 3)
// ═══════════════════════════════════════════════════════════════════════════

describe('4 · decideRefund — cumulative reconciliation (no rounding drift)', () => {
  it('classic drift scenario: three partials of 3334+3334+3335 cents on 10003 credit', () => {
    // Credit 10003 cents → 1000 points (floor(1000.3))
    // Naïve per-refund reversal: 333+333+333 = 999 ❌
    // Cumulative:              333+333+334 = 1000 ✓
    let ledger = {
      state: STATE.CREDITED,
      grossEligibleCents: 10003, creditedEligibleCents: 10003, originalPointsAwarded: pointsFromCents(10003),   // 1000
      cumPostCreditRefundedCents: 0, alreadyReversedPoints: 0, refunds: [],
    };

    // Refund 1: 3334
    const d1 = decideRefund(ledger, { refundId: 'r1', refundCents: 3334, nonce: 'x' });
    expect(d1.kind).toBe('apply');
    expect(d1.capped).toBe(3334);
    expect(d1.pointsDelta).toBe(333);   // floor(333.4) − 0
    ledger.cumPostCreditRefundedCents = d1.newCumRefunded;
    ledger.alreadyReversedPoints = d1.newAlreadyReversed;
    ledger.refunds.push({ refundId: 'r1', cents: 3334, points: d1.pointsDelta });

    // Refund 2: 3334
    const d2 = decideRefund(ledger, { refundId: 'r2', refundCents: 3334, nonce: 'x' });
    expect(d2.kind).toBe('apply');
    expect(d2.pointsDelta).toBe(333);   // floor(666.8) − 333 = 666−333 = 333
    ledger.cumPostCreditRefundedCents = d2.newCumRefunded;
    ledger.alreadyReversedPoints = d2.newAlreadyReversed;
    ledger.refunds.push({ refundId: 'r2', cents: 3334, points: d2.pointsDelta });

    // Refund 3: 3335  (total 10003)
    const d3 = decideRefund(ledger, { refundId: 'r3', refundCents: 3335, nonce: 'x' });
    expect(d3.kind).toBe('apply');
    expect(d3.pointsDelta).toBe(334);   // floor(1000.3) − 666 = 1000 − 666 = 334

    const total = d1.pointsDelta + d2.pointsDelta + d3.pointsDelta;
    expect(total).toBe(1000);   // <-- matches original credit exactly, zero drift
  });

  it('duplicate refund (same refundId, same cents) → replay', () => {
    const l = {
      state: STATE.CREDITED, grossEligibleCents: 10000, creditedEligibleCents: 10000, originalPointsAwarded: 1000,
      cumPostCreditRefundedCents: 3000, alreadyReversedPoints: 300, refunds: [{ refundId: 'r1', cents: 3000, points: 300 }],
    };
    const d = decideRefund(l, { refundId: 'r1', refundCents: 3000, nonce: 'x' });
    expect(d.kind).toBe('replay');
    expect(d.pointsDelta).toBe(300);
  });

  it('duplicate refundId with different cents → conflict', () => {
    const l = {
      state: STATE.CREDITED, grossEligibleCents: 10000, creditedEligibleCents: 10000, originalPointsAwarded: 1000,
      cumPostCreditRefundedCents: 3000, alreadyReversedPoints: 300, refunds: [{ refundId: 'r1', cents: 3000, points: 300 }],
    };
    const d = decideRefund(l, { refundId: 'r1', refundCents: 5000, nonce: 'x' });
    expect(d.kind).toBe('conflict');
    expect(d.reason).toBe('refundId-different-cents');
  });

  it('partial refund followed by cancel synthesizes only the DELTA', () => {
    // Credit 10000, partial refund 4000 (→ −400), then cancel-* full reverse
    let l = {
      state: STATE.CREDITED, grossEligibleCents: 10000, creditedEligibleCents: 10000, originalPointsAwarded: 1000,
      cumPostCreditRefundedCents: 0, alreadyReversedPoints: 0, refunds: [],
    };
    const partial = decideRefund(l, { refundId: 'r-partial', refundCents: 4000, nonce: 'x' });
    expect(partial.pointsDelta).toBe(400);
    l.cumPostCreditRefundedCents = partial.newCumRefunded;
    l.alreadyReversedPoints = partial.newAlreadyReversed;
    l.refunds.push({ refundId: 'r-partial', cents: 4000, points: 400 });

    // Cancel = full remaining reverse (refund cents = 10000 total remaining? No — the plugin
    // computes remaining net eligible cents = 10000 − 4000 = 6000 for the synthetic refund.
    const cancel = decideRefund(l, { refundId: 'cancel-1234', refundCents: 6000, nonce: 'x' });
    expect(cancel.pointsDelta).toBe(600);   // remaining 600 points
    expect(cancel.newAlreadyReversed).toBe(1000);   // total matches original
  });

  it('refund would exceed remaining credit — never reverses more than original', () => {
    // Even if the caller sends refundCents > remaining, decideRefund caps at original.
    const l = {
      state: STATE.CREDITED, grossEligibleCents: 10000, creditedEligibleCents: 10000, originalPointsAwarded: 1000,
      cumPostCreditRefundedCents: 8000, alreadyReversedPoints: 800, refunds: [],
    };
    const d = decideRefund(l, { refundId: 'r-huge', refundCents: 99999, nonce: 'x' });
    expect(d.kind).toBe('apply');
    expect(d.pointsDelta).toBe(200);   // 1000 − 800 = 200 (capped)
    expect(d.newAlreadyReversed).toBe(1000);
  });

  it('refund on ABSENT ledger → apply-precredit (record only, no balance mutation)', () => {
    const d = decideRefund({ state: STATE.ABSENT }, { refundId: 'r1', refundCents: 3000, nonce: 'x' });
    expect(d.kind).toBe('apply-precredit');
    expect(d.pointsDelta).toBe(0);
  });

  it('refund on ZERO_NET_CREDIT → apply with zero delta', () => {
    const l = { state: STATE.ZERO_NET_CREDIT, creditedEligibleCents: 0, originalPointsAwarded: 0,
                cumPostCreditRefundedCents: 0, alreadyReversedPoints: 0, refunds: [] };
    const d = decideRefund(l, { refundId: 'r1', refundCents: 500, nonce: 'x' });
    expect(d.kind).toBe('apply');
    expect(d.pointsDelta).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  5 · Input validation
// ═══════════════════════════════════════════════════════════════════════════

describe('5 · Credit input validation', () => {
  const bad = (body) => handleWooCreditOrder(makeReq('/woo-credit-order', body), mockEnv(), CORS, null, makeDeps());
  it('missing orderId', async () => expect((await bad({ ...validCredit(), orderId: '' })).status).toBe(400));
  it('bad email',      async () => expect((await bad({ ...validCredit(), email: 'nope' })).status).toBe(400));
  it('float cents',    async () => expect((await bad({ ...validCredit(), eligibleCents: 45.6 })).status).toBe(400));
  it('negative cents', async () => expect((await bad({ ...validCredit(), eligibleCents: -1 })).status).toBe(400));
  it('missing nonce',  async () => expect((await bad({ ...validCredit(), eventNonce: '' })).status).toBe(400));
  it('no arbitrary business cap (100M€ passes validation)', async () => {
    // We stop it at the customer lookup (404) — enough to prove validation passed.
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const r = await bad({ ...validCredit(), eligibleCents: 100_000_000_00 });   // 100M€ in cents
    expect(r.status).toBe(404);  // customer not found, not 400 cap-rejection
  });
  it('missing WOO_SITE_URL → 503 (does NOT fall back to request)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const env = mockEnv({ WOO_SITE_URL: '' });
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), env, CORS, null, makeDeps());
    expect(r.status).toBe(503);
  });
});

describe('5 · Refund input validation', () => {
  const bad = (body) => handleWooRefundOrder(makeReq('/woo-refund-order', body), mockEnv(), CORS, null, makeDeps());
  it('missing refundId',       async () => expect((await bad({ ...validRefund(), refundId: '' })).status).toBe(400));
  it('non-positive refundCents', async () => expect((await bad({ ...validRefund(), refundCents: 0 })).status).toBe(400));
});

// ═══════════════════════════════════════════════════════════════════════════
//  6 · Integration — happy path + retry-safety + concurrency + KV + identity
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Small in-memory fake of Firestore REST over fetch.
 * Supports: runQuery, beginTransaction, GET doc, commit (with contention model), rollback.
 * Enough for our transaction shape; NOT a full Firestore emulator.
 */
function makeFirestoreFake({ customers = {}, ledger = null, injectContentionOnceFor = null } = {}) {
  let state = {
    customers: JSON.parse(JSON.stringify(customers)),
    ledger:    ledger ? JSON.parse(JSON.stringify(ledger)) : null,
    txns:      {},         // key = full doc name → payload
    // For contention modelling: which commit index should fail with 409 once?
    contentionArmed: !!injectContentionOnceFor,
    contentionTag:   injectContentionOnceFor,
    commits:         [],
  };
  let txCounter = 0;

  async function handle(url, opts = {}) {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();

    if (u.includes(':runQuery')) {
      const parsed = JSON.parse(opts.body);
      const emailFilter = parsed.structuredQuery?.where?.fieldFilter?.value?.stringValue;
      for (const [uid, doc] of Object.entries(state.customers)) {
        if (doc.email === emailFilter) {
          return json([{ document: {
            name: `projects/test-project/databases/(default)/documents/ipear_customers/${uid}`,
            fields: encFields({
              email:       { stringValue: doc.email },
              name:        { stringValue: doc.name || '' },
              card:        { stringValue: doc.card || '' },
              points:      { integerValue: String(doc.points) },
              totalPoints: { integerValue: String(doc.totalPoints || doc.points) },
            }),
          } }]);
        }
      }
      return json([]);
    }

    if (u.includes(':beginTransaction')) {
      const tid = 'tx-' + (++txCounter);
      return json({ transaction: tid });
    }

    if (u.includes(':rollback')) return json({});

    if (u.includes(':commit')) {
      // Contention injection: fail the FIRST commit that matches the tag
      const body = JSON.parse(opts.body);
      if (state.contentionArmed) {
        state.contentionArmed = false;
        return new Response(JSON.stringify({ error: 'ABORTED' }), { status: 409 });
      }
      // Apply writes to fake state
      for (const w of body.writes || []) {
        const name = w.update?.name;
        if (!name) continue;
        if (name.includes('/ipear_customers/')) {
          const uid = name.split('/').pop();
          const fields = decodeFields(w.update.fields);
          state.customers[uid] = { ...state.customers[uid], ...fields };
        } else if (name.includes('/ipear_woo_events/')) {
          const fields = decodeFields(w.update.fields);
          state.ledger = { name, ...fields };
        } else if (name.includes('/ipear_transactions/')) {
          state.txns[name] = decodeFields(w.update.fields);
        }
      }
      state.commits.push(body);
      return json({ commitTime: '2026-08-28T10:00:00Z' });
    }

    if (method === 'GET') {
      if (u.includes('/ipear_woo_events/')) {
        if (!state.ledger) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        return json({ name: state.ledger.name, fields: encFields(state.ledger) });
      }
      if (u.includes('/ipear_customers/')) {
        const uid = u.split('?')[0].split('/').pop();
        const doc = state.customers[uid];
        if (!doc) return new Response('{"error":"not found"}', { status: 404 });
        return json({
          name: `projects/test-project/databases/(default)/documents/ipear_customers/${uid}`,
          fields: encFields({
            email:       { stringValue: doc.email },
            name:        { stringValue: doc.name || '' },
            card:        { stringValue: doc.card || '' },
            points:      { integerValue: String(doc.points) },
            totalPoints: { integerValue: String(doc.totalPoints || doc.points) },
          }),
        });
      }
    }
    return new Response('unexpected ' + u, { status: 500 });
  }

  return { fetch: (url, opts) => handle(url, opts), get state() { return state; } };
}

function json(o) { return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }); }

function encFields(obj) {
  // Accept either already-encoded fields or plain scalars; encode plain values.
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && ('stringValue' in v || 'integerValue' in v || 'mapValue' in v || 'arrayValue' in v || 'booleanValue' in v || 'nullValue' in v || 'doubleValue' in v || 'timestampValue' in v)) {
      out[k] = v; continue;
    }
    if (v === null || v === undefined)          { out[k] = { nullValue: null }; continue; }
    if (typeof v === 'string')                   { out[k] = { stringValue: v }; continue; }
    if (typeof v === 'number' && Number.isInteger(v)) { out[k] = { integerValue: String(v) }; continue; }
    if (typeof v === 'number')                   { out[k] = { doubleValue: v }; continue; }
    if (typeof v === 'boolean')                  { out[k] = { booleanValue: v }; continue; }
    if (Array.isArray(v))                        { out[k] = { arrayValue: { values: v.map(x => encFields({ x }).x) } }; continue; }
    if (typeof v === 'object')                   { out[k] = { mapValue: { fields: encFields(v) } }; continue; }
  }
  return out;
}
function decodeFields(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) {
    if ('stringValue'    in v) out[k] = v.stringValue;
    else if ('integerValue'   in v) out[k] = Number(v.integerValue);
    else if ('doubleValue'    in v) out[k] = Number(v.doubleValue);
    else if ('booleanValue'   in v) out[k] = v.booleanValue;
    else if ('timestampValue' in v) out[k] = v.timestampValue;
    else if ('nullValue'      in v) out[k] = null;
    else if ('mapValue'       in v) out[k] = decodeFields(v.mapValue.fields || {});
    else if ('arrayValue'     in v) out[k] = (v.arrayValue.values || []).map(x => decodeFields({ v: x }).v);
  }
  return out;
}

describe('6 · Credit — happy path with in-memory Firestore', () => {
  let fake;
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', name: 'T', card: 'IP-1', points: 100, totalPoints: 500 } },
    });
    globalThis.fetch = fake.fetch;
    fakeGetAccessToken.mockClear();
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('fresh credit — mutates points, writes ledger + audit tx', async () => {
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.earnedPoints).toBe(456);
    expect(body.newBalance).toBe(556);
    expect(body.state).toBe(STATE.CREDITED);
    expect(fake.state.commits).toHaveLength(1);
    // Ledger persisted
    expect(fake.state.ledger.state).toBe(STATE.CREDITED);
    expect(fake.state.ledger.creditedEligibleCents).toBe(4560);
    expect(fake.state.ledger.originalPointsAwarded).toBe(456);
    expect(fake.state.ledger.creditNonce).toBe('credit-1234-4560');
    // Audit tx has deterministic name
    const auditNames = Object.keys(fake.state.txns);
    expect(auditNames.some(n => n.endsWith('/ipear_transactions/wooc__' + fake.state.ledger.siteHash + '__1234__credit-1234-4560'))).toBe(true);
  });

  it('retry after commit-succeeded / response-lost → Firestore-driven replay, no double mutation', async () => {
    // First call
    const r1 = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    expect(r1.status).toBe(200);
    expect(fake.state.customers.USER1.points).toBe(556);
    const commitsAfter1 = fake.state.commits.length;
    // Second call with SAME nonce — worker never sent us a response the first time
    const r2 = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    const body2 = await r2.json();
    expect(r2.status).toBe(200);
    expect(body2.replay).toBe(true);
    expect(body2.source).toBe('firestore-ledger');  // NOT kv — Firestore is authoritative
    expect(fake.state.customers.USER1.points).toBe(556);
    expect(fake.state.commits.length).toBe(commitsAfter1);
  });

  it('same order with DIFFERENT cents → 409 conflict, no balance mutation', async () => {
    await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    const before = fake.state.customers.USER1.points;
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', { ...validCredit(), eligibleCents: 5000, eventNonce: 'credit-1234-5000' }), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(409);
    expect((await r.json()).reason).toBe('credited-different-cents');
    expect(fake.state.customers.USER1.points).toBe(before);   // unchanged
  });

  it('Firestore commit contention 409 → retried transparently → success (exactly-once)', async () => {
    // Arm one 409 on the first commit; retry loop should recover.
    fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', name: 'T', card: 'IP-1', points: 100 } },
      injectContentionOnceFor: true,
    });
    globalThis.fetch = fake.fetch;
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(200);
    expect(fake.state.customers.USER1.points).toBe(556);   // credited exactly once
    expect(fake.state.commits.length).toBe(1);              // only the successful commit was applied
  });
});

describe('6 · KV is never a correctness gate (blocker 1)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('KV missing → Firestore consulted', async () => {
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
    });
    globalThis.fetch = fake.fetch;
    const env = mockEnv({ RATE_LIMIT_KV: { get: vi.fn(async () => null), put: vi.fn(async () => {}) } });
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), env, CORS, null, makeDeps());
    expect(r.status).toBe(200);
    expect(fake.state.commits.length).toBe(1);
  });

  it('MATCHING KV + ABSENT Firestore → Firestore wins, KV cannot fake a replay', async () => {
    // KV lies: "already credited nonce=n, cents=4560, points=456".
    // Firestore ledger: absent (order never actually credited).
    // Correct behaviour: worker enters Firestore transaction, finds absent
    // ledger, credits fresh, ignores the false KV replay signal.
    const kvGetSpy = vi.fn(async () => JSON.stringify({
      state: STATE.CREDITED,
      creditNonce: 'credit-1234-4560',
      creditedEligibleCents: 4560,
      originalPointsAwarded: 456,
    }));
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
    });
    globalThis.fetch = fake.fetch;
    const env = mockEnv({ RATE_LIMIT_KV: { get: kvGetSpy, put: vi.fn(async () => {}) } });
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), env, CORS, null, makeDeps());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.replay).toBe(false);        // NOT a replay — must be a fresh apply
    expect(body.source).toBe('firestore-ledger');
    expect(fake.state.customers.USER1.points).toBe(556);   // real credit landed
    expect(fake.state.commits).toHaveLength(1);
    expect(fake.state.ledger.state).toBe(STATE.CREDITED);
    // KV MAY have been consulted (or not — it is not required), but did NOT
    // short-circuit the decision.
  });

  it('MATCHING KV + different Firestore state (already REFUNDED) → Firestore wins, no re-credit', async () => {
    // KV says "credited"; Firestore says "refunded". A KV-driven fast path
    // would incorrectly return replay 'credited'. Correct behaviour:
    // consult Firestore, see REFUNDED, refuse (409 conflict) — never re-credit
    // and never mutate the balance.
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
      ledger: {
        name: 'projects/test-project/databases/(default)/documents/ipear_woo_events/HASHZZ__1234',
        siteHash: 'HASHZZ', orderId: '1234',
        customerUid: 'USER1', customerEmail: 'test@example.com',
        state: STATE.REFUNDED, version: 2,
        pointsPerEuro: 10,
        grossEligibleCents: 4560, creditedEligibleCents: 4560, originalPointsAwarded: 456,
        cumPostCreditRefundedCents: 4560, alreadyReversedPoints: 456,
        preCreditRefunds: [], creditNonce: 'credit-1234-4560', creditAt: '2026-01-01T00:00:00Z',
        refunds: [{ refundId: 'r1', cents: 4560, points: 456, at: '2026-01-02T00:00:00Z', nonce: 'x' }],
        createdAt: '2026-01-01T00:00:00Z', lastEventAt: '2026-01-02T00:00:00Z',
      },
    });
    globalThis.fetch = fake.fetch;
    const env = mockEnv({
      RATE_LIMIT_KV: {
        get: vi.fn(async () => JSON.stringify({
          state: STATE.CREDITED,
          creditNonce: 'credit-1234-4560',
          grossEligibleCents: 4560, creditedEligibleCents: 4560, originalPointsAwarded: 456,
        })),
        put: vi.fn(async () => {}),
      },
    });
    // Same-cents replay is still a valid replay per FSM (idempotency). To
    // force a NEW mutation attempt we send different cents so the ledger
    // response is a conflict — proving the ledger, not KV, decided.
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', { ...validCredit(), eligibleCents: 9999, eventNonce: 'credit-1234-9999' }), env, CORS, null, makeDeps());
    expect(r.status).toBe(409);            // real Firestore state governs
    expect(fake.state.customers.USER1.points).toBe(100);   // untouched
    expect(fake.state.commits).toHaveLength(0);
  });

  it('replay-through-Firestore: same nonce twice → second call reads ledger and replays without new commit', async () => {
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
    });
    globalThis.fetch = fake.fetch;
    const env = mockEnv({ RATE_LIMIT_KV: { get: vi.fn(async () => null), put: vi.fn(async () => {}) } });
    const r1 = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), env, CORS, null, makeDeps());
    expect(r1.status).toBe(200);
    const commitsAfter1 = fake.state.commits.length;
    // KV still empty; retry must go to Firestore and replay from ledger
    const r2 = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), env, CORS, null, makeDeps());
    const body2 = await r2.json();
    expect(r2.status).toBe(200);
    expect(body2.replay).toBe(true);
    expect(body2.source).toBe('firestore-ledger');
    expect(fake.state.customers.USER1.points).toBe(556);   // unchanged
    expect(fake.state.commits.length).toBe(commitsAfter1); // no new commit
  });
});

describe('6 · Identity freeze (blocker 5)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('billing email changed to a DIFFERENT customer → 409, points not moved', async () => {
    const fake = makeFirestoreFake({
      customers: {
        USER1: { email: 'first@example.com', points: 100 },
        USER2: { email: 'second@example.com', points: 999 },
      },
      // Pre-existing ledger frozen to USER1
      ledger: {
        name: 'projects/test-project/databases/(default)/documents/ipear_woo_events/HASHZZ__1234',
        siteHash: 'HASHZZ', orderId: '1234',
        customerUid: 'USER1', customerEmail: 'first@example.com',
        state: STATE.CREDITED, version: 1,
        grossEligibleCents: 4560, creditedEligibleCents: 4560, originalPointsAwarded: 456,
        cumPostCreditRefundedCents: 0, alreadyReversedPoints: 0,
        preCreditRefunds: [], creditNonce: 'credit-1234-4560', creditAt: '2026-01-01T00:00:00Z',
        refunds: [], createdAt: '2026-01-01T00:00:00Z', lastEventAt: '2026-01-01T00:00:00Z',
      },
    });
    globalThis.fetch = fake.fetch;
    // Now attempt a credit with USER2's email but same orderId — ledger points at USER1
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', { ...validCredit(), email: 'second@example.com' }), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('identity-mismatch');
    expect(fake.state.customers.USER2.points).toBe(999);   // untouched
  });

  it('guest without account → 404, never auto-creates', async () => {
    const fake = makeFirestoreFake({ customers: {} });    // no matching customer
    globalThis.fetch = fake.fetch;
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(404);
    expect(fake.state.commits.length).toBe(0);
  });
});

describe('6 · Refund-before-credit path (blocker 4)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('refund arrives first → recorded as pre_credit; no balance mutation', async () => {
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
    });
    globalThis.fetch = fake.fetch;
    const r = await handleWooRefundOrder(makeReq('/woo-refund-order', { ...validRefund(), refundCents: 2000 }), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.idemState).toBe('pre-credit-recorded');
    expect(body.state).toBe(STATE.PRE_REFUNDED);
    expect(fake.state.customers.USER1.points).toBe(100);   // no mutation
    expect(fake.state.ledger.state).toBe(STATE.PRE_REFUNDED);
    expect(fake.state.ledger.preCreditRefunds).toHaveLength(1);
  });

  it('credit arrives after pre-credit refund → net eligible applied', async () => {
    // First pre-credit refund of 2000 cents
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
      ledger: {
        name: 'projects/test-project/databases/(default)/documents/ipear_woo_events/HASHZZ__1234',
        siteHash: 'HASHZZ', orderId: '1234', customerUid: '', customerEmail: 'test@example.com',
        state: STATE.PRE_REFUNDED, version: 1,
        creditedEligibleCents: 0, originalPointsAwarded: 0,
        cumPostCreditRefundedCents: 0, alreadyReversedPoints: 0,
        preCreditRefunds: [{ refundId: 'r1', cents: 2000, at: '2026-01-01T00:00:00Z', nonce: 'refund-1234-r1' }],
        creditNonce: '', creditAt: '',
        refunds: [], createdAt: '2026-01-01T00:00:00Z', lastEventAt: '2026-01-01T00:00:00Z',
      },
    });
    globalThis.fetch = fake.fetch;
    // Credit 4560 → net 2560 → 256 points
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.earnedPoints).toBe(256);
    expect(body.creditedEligibleCents).toBe(2560);
    expect(fake.state.customers.USER1.points).toBe(356);   // 100 + 256
    expect(fake.state.ledger.state).toBe(STATE.CREDITED);
  });

  it('fully refunded before credit → zero-net, no balance mutation', async () => {
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
      ledger: {
        name: 'projects/test-project/databases/(default)/documents/ipear_woo_events/HASHZZ__1234',
        siteHash: 'HASHZZ', orderId: '1234', customerUid: '', customerEmail: 'test@example.com',
        state: STATE.PRE_REFUNDED, version: 1,
        creditedEligibleCents: 0, originalPointsAwarded: 0,
        cumPostCreditRefundedCents: 0, alreadyReversedPoints: 0,
        preCreditRefunds: [{ refundId: 'r1', cents: 5000, at: '2026-01-01T00:00:00Z', nonce: 'x' }],
        creditNonce: '', creditAt: '', refunds: [],
        createdAt: '2026-01-01T00:00:00Z', lastEventAt: '2026-01-01T00:00:00Z',
      },
    });
    globalThis.fetch = fake.fetch;
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(200);
    expect((await r.json()).earnedPoints).toBe(0);
    expect(fake.state.customers.USER1.points).toBe(100);   // untouched
    expect(fake.state.ledger.state).toBe(STATE.ZERO_NET_CREDIT);
  });
});

describe('6 · Concurrent identical credits (blocker 8)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('two parallel calls with same nonce → credited exactly once', async () => {
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
      injectContentionOnceFor: true,
    });
    globalThis.fetch = fake.fetch;
    const [r1, r2] = await Promise.all([
      handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps()),
      handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps()),
    ]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    expect(r1.status).toBe(200); expect(r2.status).toBe(200);
    // Exactly one is a fresh apply, exactly one is a replay
    const applies = [b1, b2].filter(b => !b.replay);
    const replays = [b1, b2].filter(b =>  b.replay);
    expect(applies.length).toBe(1);
    expect(replays.length).toBe(1);
    expect(fake.state.customers.USER1.points).toBe(556);   // credited once
  });
});

describe('6 · Point rate FREEZE (blocker 4)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('first credit stores pointsPerEuro in the ledger', async () => {
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
    });
    globalThis.fetch = fake.fetch;
    await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    expect(fake.state.ledger.pointsPerEuro).toBe(10);
    expect(fake.state.ledger.creditedEligibleCents).toBe(4560);
    expect(fake.state.ledger.originalPointsAwarded).toBe(456);
  });

  it('refund uses FROZEN pointsPerEuro from ledger, not global rate', () => {
    // Simulate: ledger was written when pointsPerEuro was 20 (a promotional
    // period). Global constant is 10 (current). Refund must reverse at 20.
    const ledger = {
      state: STATE.CREDITED,
      pointsPerEuro: 20,                          // frozen at credit time
      grossEligibleCents: 10_000, creditedEligibleCents: 10_000,
      originalPointsAwarded: 2000,                 // 20 pts/€ × 100€
      cumPostCreditRefundedCents: 0,
      alreadyReversedPoints: 0,
      refunds: [],
    };
    const d = decideRefund(ledger, { refundId: 'r1', refundCents: 5000, nonce: 'x' });
    expect(d.kind).toBe('apply');
    // 5000 cents × 20 pts/€ / 100 = 1000 points reversed (NOT 500 at current rate)
    expect(d.pointsDelta).toBe(1000);
    expect(d.pointsPerEuro).toBe(20);
  });

  it('legacy ledger with no pointsPerEuro field falls back to current constant', () => {
    // Older ledger doc written before rate-freeze existed; no field present.
    const ledger = {
      state: STATE.CREDITED,
      // pointsPerEuro absent (decodeLedger returns 0)
      pointsPerEuro: 0,
      grossEligibleCents: 4560, creditedEligibleCents: 4560, originalPointsAwarded: 456,
      cumPostCreditRefundedCents: 0, alreadyReversedPoints: 0, refunds: [],
    };
    const d = decideRefund(ledger, { refundId: 'r1', refundCents: 4560, nonce: 'x' });
    expect(d.kind).toBe('apply');
    expect(d.pointsDelta).toBe(456);              // uses current POINTS_PER_EURO=10
    expect(d.pointsPerEuro).toBe(10);
  });
});

describe('7 · Cancel/failed race scenarios (blocker 1 · corrected build 3)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('A · cancel arrives while credit is still queued (ledger absent) → PRE_REFUNDED zero-net authoritative state', async () => {
    // Simulates: order completed, credit AS action queued but not yet run,
    // then cancelled. Plugin's cancel handler sends a refund event first.
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
    });
    globalThis.fetch = fake.fetch;
    const r = await handleWooRefundOrder(makeReq('/woo-refund-order', {
      orderId: '1234', refundId: 'cancel-1234', email: 'test@example.com',
      refundCents: 4560, eventNonce: 'refund-1234-cancel-1234',
    }), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(200);
    expect(fake.state.ledger.state).toBe(STATE.PRE_REFUNDED);
    expect(fake.state.customers.USER1.points).toBe(100);   // untouched
    // Now the queued credit finally runs — should transition to ZERO_NET_CREDIT
    // and NOT credit the balance.
    const r2 = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.state).toBe(STATE.ZERO_NET_CREDIT);
    expect(b2.earnedPoints).toBe(0);
    expect(fake.state.customers.USER1.points).toBe(100);   // still untouched
    expect(fake.state.ledger.originalPointsAwarded).toBe(0);
  });

  it('B · commit succeeded / response lost → cancel arrives → finds CREDITED ledger and reverses fully', async () => {
    // First: a normal credit lands.
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
    });
    globalThis.fetch = fake.fetch;
    await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    expect(fake.state.customers.USER1.points).toBe(556);
    expect(fake.state.ledger.originalPointsAwarded).toBe(456);

    // NOW the plugin's WP meta was NEVER written (response lost). Cancel
    // hook fires — plugin has no idea a credit already succeeded and sends
    // a synthetic cancel request. Worker finds CREDITED and reverses fully.
    const r = await handleWooRefundOrder(makeReq('/woo-refund-order', {
      orderId: '1234', refundId: 'cancel-1234', email: 'test@example.com',
      refundCents: 4560, eventNonce: 'refund-1234-cancel-1234',
    }), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.refundedPoints).toBe(456);   // full reverse
    expect(fake.state.customers.USER1.points).toBe(100);   // back to origin
    expect(fake.state.ledger.state).toBe(STATE.REFUNDED);
    expect(fake.state.ledger.alreadyReversedPoints).toBe(456);
    expect(fake.state.ledger.originalPointsAwarded).toBe(456);   // cap unchanged
  });

  it('C · retry pending → failed comes in → refund action synthesizes full-reverse', async () => {
    // Simulates: credit action ran once with 5xx → retry queued at attempt=2.
    // Before attempt=2 fires, `failed` status hook comes in. Plugin's failed
    // handler triggers reconciliation. Ledger is ABSENT → apply-precredit.
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 200 } },
    });
    globalThis.fetch = fake.fetch;
    const r = await handleWooRefundOrder(makeReq('/woo-refund-order', {
      orderId: '2000', refundId: 'failed-2000', email: 'test@example.com',
      refundCents: 4560, eventNonce: 'refund-2000-failed-2000',
    }), mockEnv(), CORS, null, makeDeps());
    expect(r.status).toBe(200);
    expect(fake.state.ledger.state).toBe(STATE.PRE_REFUNDED);
    expect(fake.state.customers.USER1.points).toBe(200);   // untouched
    // If the retry EVER fires (Action Scheduler didn't dedupe fast enough),
    // it hits ZERO_NET_CREDIT branch.
    const r2 = await handleWooCreditOrder(makeReq('/woo-credit-order', {
      orderId: '2000', email: 'test@example.com',
      eligibleCents: 4560, orderCurrency: 'EUR', eventNonce: 'credit-2000-4560',
    }), mockEnv(), CORS, null, makeDeps());
    expect(r2.status).toBe(200);
    expect((await r2.json()).state).toBe(STATE.ZERO_NET_CREDIT);
    expect(fake.state.customers.USER1.points).toBe(200);
  });

  it('D · duplicate cancel + failed hooks — second call is a replay, no double reversal', async () => {
    // Credit lands.
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
    });
    globalThis.fetch = fake.fetch;
    await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv(), CORS, null, makeDeps());
    // First cancel — full reverse
    await handleWooRefundOrder(makeReq('/woo-refund-order', {
      orderId: '1234', refundId: 'cancel-1234', email: 'test@example.com',
      refundCents: 4560, eventNonce: 'refund-1234-cancel-1234',
    }), mockEnv(), CORS, null, makeDeps());
    expect(fake.state.customers.USER1.points).toBe(100);
    const balAfterCancel = fake.state.customers.USER1.points;
    const commitsAfterCancel = fake.state.commits.length;
    // Second cancel hook re-fires (WP retry, or double-hook trigger) — same refundId
    const r2 = await handleWooRefundOrder(makeReq('/woo-refund-order', {
      orderId: '1234', refundId: 'cancel-1234', email: 'test@example.com',
      refundCents: 4560, eventNonce: 'refund-1234-cancel-1234',
    }), mockEnv(), CORS, null, makeDeps());
    expect(r2.status).toBe(200);
    expect((await r2.json()).replay).toBe(true);
    expect(fake.state.customers.USER1.points).toBe(balAfterCancel);   // unchanged
    expect(fake.state.commits.length).toBe(commitsAfterCancel);        // no new commit
    // Now a `failed` hook fires (DIFFERENT synthetic refundId, but the delta cap kicks in)
    const r3 = await handleWooRefundOrder(makeReq('/woo-refund-order', {
      orderId: '1234', refundId: 'failed-1234', email: 'test@example.com',
      refundCents: 4560, eventNonce: 'refund-1234-failed-1234',
    }), mockEnv(), CORS, null, makeDeps());
    expect(r3.status).toBe(200);
    expect((await r3.json()).refundedPoints).toBe(0);   // already at cap, delta=0
    expect(fake.state.customers.USER1.points).toBe(balAfterCancel);
    expect(fake.state.ledger.alreadyReversedPoints).toBe(456);   // still capped at original
  });
});

describe('7 · Cumulative refund accounting — pre-credit + post-credit + cancel arithmetic', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('exact scenario from spec: pre-refund 2000 → credit 10000 (net 8000 = 800 pts) → post-refund 2000 → cancel', async () => {
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
    });
    globalThis.fetch = fake.fetch;

    // Step 1: pre-credit refund of 2000 cents
    const r1 = await handleWooRefundOrder(makeReq('/woo-refund-order', {
      orderId: '9999', refundId: 'r-pre-1', email: 'test@example.com',
      refundCents: 2000, eventNonce: 'refund-9999-r-pre-1',
    }), mockEnv(), CORS, null, makeDeps());
    expect(r1.status).toBe(200);
    expect(fake.state.ledger.state).toBe(STATE.PRE_REFUNDED);
    expect(fake.state.customers.USER1.points).toBe(100);   // untouched

    // Step 2: credit for 10 000 cents → net 8000 (10000 − 2000) → 800 pts
    const r2 = await handleWooCreditOrder(makeReq('/woo-credit-order', {
      orderId: '9999', email: 'test@example.com', eligibleCents: 10_000,
      orderCurrency: 'EUR', eventNonce: 'credit-9999-10000',
    }), mockEnv(), CORS, null, makeDeps());
    const b2 = await r2.json();
    expect(b2.state).toBe(STATE.CREDITED);
    expect(b2.earnedPoints).toBe(800);
    expect(fake.state.customers.USER1.points).toBe(900);
    // Ledger accounting fields properly separated:
    expect(fake.state.ledger.grossEligibleCents).toBe(10_000);
    expect(fake.state.ledger.preCreditRefundedCentsAtCredit).toBe(2000);
    expect(fake.state.ledger.creditedEligibleCents).toBe(8000);
    expect(fake.state.ledger.originalPointsAwarded).toBe(800);
    expect(fake.state.ledger.cumPostCreditRefundedCents).toBe(0);

    // Step 3: post-credit partial refund of 2000 cents → should reverse
    // ONLY 200 points (2000 * 10 / 100), NOT 400 (which would double-count the pre-credit refund).
    const r3 = await handleWooRefundOrder(makeReq('/woo-refund-order', {
      orderId: '9999', refundId: 'r-post-1', email: 'test@example.com',
      refundCents: 2000, eventNonce: 'refund-9999-r-post-1',
    }), mockEnv(), CORS, null, makeDeps());
    const b3 = await r3.json();
    expect(b3.refundedPoints).toBe(200);
    expect(fake.state.customers.USER1.points).toBe(700);
    expect(fake.state.ledger.cumPostCreditRefundedCents).toBe(2000);
    expect(fake.state.ledger.alreadyReversedPoints).toBe(200);

    // Step 4: cancel remaining. Plugin sends refundCents = remaining
    // (`creditedEligibleCents − cumPostCredit = 8000 − 2000 = 6000`).
    // Worker computes: capped=min(2000+6000, 8000)=8000, target=800, delta=800-200=600.
    const r4 = await handleWooRefundOrder(makeReq('/woo-refund-order', {
      orderId: '9999', refundId: 'cancel-9999', email: 'test@example.com',
      refundCents: 6000, eventNonce: 'refund-9999-cancel-9999',
    }), mockEnv(), CORS, null, makeDeps());
    const b4 = await r4.json();
    expect(b4.refundedPoints).toBe(600);
    expect(fake.state.customers.USER1.points).toBe(100);   // fully back to origin

    // Total reversal == originalPointsAwarded, never exceeded.
    expect(fake.state.ledger.alreadyReversedPoints).toBe(800);
    expect(fake.state.ledger.alreadyReversedPoints).toBe(fake.state.ledger.originalPointsAwarded);
  });

  it('reversal cap: refund cents larger than remaining cannot exceed originalPointsAwarded', () => {
    // Purely at the decision layer — refund exceeding credit is capped.
    const ledger = {
      state: STATE.CREDITED, pointsPerEuro: 10,
      grossEligibleCents: 10_000, creditedEligibleCents: 10_000,
      originalPointsAwarded: 1000,
      cumPostCreditRefundedCents: 900, alreadyReversedPoints: 90,
      refunds: [],
    };
    const d = decideRefund(ledger, { refundId: 'r-huge', refundCents: 999_999, nonce: 'x' });
    expect(d.kind).toBe('apply');
    // Capped: capped=min(900+999999, 10000)=10000, target=1000, delta=1000-90=910
    expect(d.pointsDelta).toBe(910);
    expect(d.newAlreadyReversed).toBe(1000);   // exactly the cap
  });
});

describe('7 · Post-credit accounting fields are immutable across refunds', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('grossEligibleCents, creditedEligibleCents, originalPointsAwarded, preCreditRefundedCentsAtCredit stay frozen after any refund', async () => {
    const fake = makeFirestoreFake({
      customers: { USER1: { email: 'test@example.com', points: 100 } },
    });
    globalThis.fetch = fake.fetch;
    // Pre-refund + credit (matches previous test's setup).
    await handleWooRefundOrder(makeReq('/woo-refund-order', {
      orderId: '8888', refundId: 'r-pre-1', email: 'test@example.com',
      refundCents: 3000, eventNonce: 'refund-8888-r-pre-1',
    }), mockEnv(), CORS, null, makeDeps());
    await handleWooCreditOrder(makeReq('/woo-credit-order', {
      orderId: '8888', email: 'test@example.com', eligibleCents: 10_000,
      orderCurrency: 'EUR', eventNonce: 'credit-8888-10000',
    }), mockEnv(), CORS, null, makeDeps());
    const frozen = {
      grossEligibleCents:             fake.state.ledger.grossEligibleCents,
      creditedEligibleCents:          fake.state.ledger.creditedEligibleCents,
      originalPointsAwarded:          fake.state.ledger.originalPointsAwarded,
      preCreditRefundedCentsAtCredit: fake.state.ledger.preCreditRefundedCentsAtCredit,
      pointsPerEuro:                  fake.state.ledger.pointsPerEuro,
    };
    // Apply two refunds and assert none of the frozen fields moved.
    for (const rid of ['r-post-1', 'r-post-2']) {
      await handleWooRefundOrder(makeReq('/woo-refund-order', {
        orderId: '8888', refundId: rid, email: 'test@example.com',
        refundCents: 1000, eventNonce: 'refund-8888-' + rid,
      }), mockEnv(), CORS, null, makeDeps());
      expect(fake.state.ledger.grossEligibleCents).toBe(frozen.grossEligibleCents);
      expect(fake.state.ledger.creditedEligibleCents).toBe(frozen.creditedEligibleCents);
      expect(fake.state.ledger.originalPointsAwarded).toBe(frozen.originalPointsAwarded);
      expect(fake.state.ledger.preCreditRefundedCentsAtCredit).toBe(frozen.preCreditRefundedCentsAtCredit);
      expect(fake.state.ledger.pointsPerEuro).toBe(frozen.pointsPerEuro);
    }
  });
});

describe('8 · Secret never leaked in errors', () => {
  it('401 response body contains no secret substring', async () => {
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit(), { Authorization: 'Bearer ' + ADMIN_SECRET }), mockEnv(), CORS, null, makeDeps());
    const text = await r.clone().text();
    expect(text).not.toContain(WOO_SECRET);
    expect(text).not.toContain(ADMIN_SECRET);
  });
  it('missing-config 503 body contains no secret substring', async () => {
    const r = await handleWooCreditOrder(makeReq('/woo-credit-order', validCredit()), mockEnv({ WOO_LOYALTY_SECRET: '' }), CORS, null, makeDeps());
    expect(await r.text()).not.toMatch(/(secret|SECRET)=[^&\s]+/);
  });
});
