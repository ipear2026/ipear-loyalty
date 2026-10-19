// @vitest-environment node
// ───────────────────────────────────────────────────────────────────────────
//  EXPIRY REMEDIATION (unit) — deterministic, idempotent, NON-financial expiry
//  of stale pending redemption requests, plus a guard locking the canonical
//  tier ladder that _serverTier now delegates to (regression for the live
//  tablet tier hotfix that previously mislabelled 2310 pts as GOLD).
// ───────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  requestDeadlineMs, planRequestExpiry, expiryUpdate,
} = require('../functions/lib/request-expiry.js');
const { tierCls, tierName } = require('../functions/lib/tier.js');

const T0 = Date.parse('2026-10-15T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const tsToDate = (ms) => ({ toDate: () => new Date(ms) }); // admin-SDK Timestamp shape

describe('requestDeadlineMs — field precedence & shapes', () => {
  it('prefers expiresAtTs (admin Timestamp) over expiresAt', () => {
    expect(requestDeadlineMs({ expiresAtTs: tsToDate(T0 + 1000), expiresAt: iso(T0 + 999999) }))
      .toBe(T0 + 1000);
  });
  it('accepts REST {_seconds} and {seconds} shapes', () => {
    expect(requestDeadlineMs({ expiresAtTs: { _seconds: T0 / 1000 } })).toBe(T0);
    expect(requestDeadlineMs({ expiresAtTs: { seconds: T0 / 1000 } })).toBe(T0);
  });
  it('falls back to ISO expiresAt', () => {
    expect(requestDeadlineMs({ expiresAt: iso(T0) })).toBe(T0);
  });
  it('returns NaN when nothing parseable', () => {
    expect(Number.isNaN(requestDeadlineMs({}))).toBe(true);
    expect(Number.isNaN(requestDeadlineMs({ expiresAt: 'nope' }))).toBe(true);
    expect(Number.isNaN(requestDeadlineMs(null))).toBe(true);
  });
});

describe('planRequestExpiry — decision surface', () => {
  it('pending + past deadline → expire', () => {
    expect(planRequestExpiry({ status: 'pending', expiresAtTs: tsToDate(T0 - 1) }, T0))
      .toEqual({ expire: true, reason: 'past-deadline' });
  });
  it('pending + future deadline → still live', () => {
    expect(planRequestExpiry({ status: 'pending', expiresAtTs: tsToDate(T0 + 60000) }, T0).expire)
      .toBe(false);
  });
  it('exactly at deadline is NOT past (now > dl required)', () => {
    expect(planRequestExpiry({ status: 'pending', expiresAtTs: tsToDate(T0) }, T0).expire).toBe(false);
  });
  it('terminal statuses are never expired (idempotent)', () => {
    for (const s of ['approved', 'rejected', 'expired', 'used', 'cancelled']) {
      const r = planRequestExpiry({ status: s, expiresAtTs: tsToDate(T0 - 999999) }, T0);
      expect(r.expire).toBe(false);
      expect(r.reason.startsWith('not-pending')).toBe(true);
    }
  });
  it('pending with no deadline is NOT auto-expired (conservative)', () => {
    expect(planRequestExpiry({ status: 'pending' }, T0)).toEqual({ expire: false, reason: 'no-deadline' });
  });
  it('idempotent: re-running after expiry is a no-op', () => {
    const doc = { status: 'pending', expiresAtTs: tsToDate(T0 - 1) };
    expect(planRequestExpiry(doc, T0).expire).toBe(true);
    Object.assign(doc, expiryUpdate(iso(T0)));
    expect(planRequestExpiry(doc, T0 + 10000).expire).toBe(false);
  });
});

describe('expiryUpdate — financial safety', () => {
  it('carries only non-financial fields', () => {
    const u = expiryUpdate(iso(T0));
    for (const k of ['points', 'totalPoints', 'amount', 'balance', 'balanceAfter',
      'balanceBefore', 'ledgerId', 'newPoints', 'cost', 'rewardCost']) {
      expect(k in u).toBe(false);
    }
    expect(u.status).toBe('expired');
  });
});

describe('canonical tier ladder — _serverTier delegates here', () => {
  it('maps the ladder boundaries correctly', () => {
    expect(tierName(0)).toBe('Bronze');
    expect(tierName(999)).toBe('Bronze');
    expect(tierName(1000)).toBe('Silver');
    expect(tierName(2310)).toBe('Silver');   // the live regression case
    expect(tierName(2999)).toBe('Silver');
    expect(tierName(3000)).toBe('Gold');
    expect(tierName(6000)).toBe('Diamond');
    expect(tierName(10000)).toBe('Platinum');
    expect(tierCls(2310)).toBe('silver');
  });
});
