// @vitest-environment node
// ───────────────────────────────────────────────────────────────────────────
//  SEC-H1 — canonical offer-credit authority (unit).
//  The credited bonus must be derived from the authoritative ipear_offers doc,
//  never from the customer-supplied offer_redemption / request value. No input
//  may yield more points than the offer's real, server-side value.
//
//  Flow-level guarantees (replayed/concurrent approval, A→B isolation) are
//  provided by approveRedemption's deterministic ledger id + runTransaction +
//  the Firestore rules (customerUid==auth.uid on create); this suite locks the
//  VALUE-authority decision that those layers delegate to.
// ───────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  canonicalOfferCredit,
  canonicalOfferValue,
  offerRuntimeStatus,
  athensDateStr,
} = require('../functions/lib/offer-credit.js');
const { planOfferRedeem, planRewardRedeem } = require('../functions/lib/redemption.js');

// req.rewardCost is stored NEGATIVE for offer_credit, so a legitimate request
// for an N-point offer carries rewardCost = -N.
const rc = (n) => -n;

// Fixed instants around the Athens day-boundary of 2026-09-30 (summer, UTC+3):
//   30/09 Athens = [2026-09-29T21:00Z .. 2026-09-30T20:59:59.999Z].
const T_WITHIN_END_DAY = Date.parse('2026-09-30T20:59:59Z'); // 23:59:59 Athens 30/09
const T_AFTER_END_DAY = Date.parse('2026-09-30T21:00:00Z');  // 00:00:00 Athens 01/10
const T_BEFORE_START = Date.parse('2026-09-30T10:00:00Z');   // well before a Dec start

describe('canonicalOfferCredit — valid', () => {
  it('valid offer credit (request matches offer) → ok, server value', () => {
    const r = canonicalOfferCredit({ active: true, bonusPoints: 50 }, rc(50));
    expect(r).toEqual({ ok: true, canonicalBonus: 50 });
  });
  it('falls back to pointsCost when bonusPoints absent', () => {
    expect(canonicalOfferCredit({ active: true, pointsCost: 120 }, rc(120)))
      .toEqual({ ok: true, canonicalBonus: 120 });
  });
  it('admin-set high offer value is trusted (server-controlled)', () => {
    expect(canonicalOfferCredit({ active: true, bonusPoints: 3000 }, rc(3000)).ok).toBe(true);
  });
  it('floors fractional offer values', () => {
    expect(canonicalOfferCredit({ active: true, bonusPoints: 50.9 }, rc(50)).canonicalBonus).toBe(50);
  });
});

describe('canonicalOfferCredit — tampered / abusive request values are rejected', () => {
  it('client INFLATED bonusPoints (50 → 2500) → rejected', () => {
    const r = canonicalOfferCredit({ active: true, bonusPoints: 50 }, rc(2500));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('value-mismatch');
    expect(r.canonicalBonus).toBe(50); // server value, not the tampered one
  });
  it('client value above the 2500 rules cap → rejected', () => {
    expect(canonicalOfferCredit({ active: true, bonusPoints: 50 }, rc(9999)).ok).toBe(false);
  });
  it('zero value → rejected', () => {
    expect(canonicalOfferCredit({ active: true, bonusPoints: 50 }, rc(0)).ok).toBe(false);
  });
  it('negative requested value (wrong-sign rewardCost) → rejected', () => {
    expect(canonicalOfferCredit({ active: true, bonusPoints: 50 }, 50).ok).toBe(false);
  });
  it('NaN / non-finite request value → rejected', () => {
    expect(canonicalOfferCredit({ active: true, bonusPoints: 50 }, NaN).ok).toBe(false);
  });
});

describe('canonicalOfferCredit — offer eligibility', () => {
  it('nonexistent offer → rejected', () => {
    expect(canonicalOfferCredit(null, rc(50))).toEqual({ ok: false, reason: 'offer-missing' });
    expect(canonicalOfferCredit(undefined, rc(50)).ok).toBe(false);
  });
  it('disabled/ineligible offer (active !== true) → rejected', () => {
    expect(canonicalOfferCredit({ active: false, bonusPoints: 50 }, rc(50)).reason).toBe('offer-ineligible');
    expect(canonicalOfferCredit({ bonusPoints: 50 }, rc(50)).reason).toBe('offer-ineligible');
  });
  it('offer with non-positive / invalid canonical value → rejected', () => {
    expect(canonicalOfferCredit({ active: true, bonusPoints: 0 }, rc(0)).reason).toBe('invalid-canonical');
    expect(canonicalOfferCredit({ active: true, bonusPoints: -5 }, rc(-5)).reason).toBe('invalid-canonical');
    expect(canonicalOfferCredit({ active: true, bonusPoints: 'x' }, rc(50)).reason).toBe('invalid-canonical');
  });
  it('offer value CHANGED after the scan (admin edit 50 → 100) → rejected, re-scan', () => {
    // request captured 50; offer now says 100 → mismatch, fail closed.
    const r = canonicalOfferCredit({ active: true, bonusPoints: 100 }, rc(50));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('value-mismatch');
    expect(r.canonicalBonus).toBe(100);
  });
  it('malformed offer (not an object) → rejected', () => {
    expect(canonicalOfferCredit('nope', rc(50)).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  OFFER EXPIRATION — date-aware authority (Europe/Athens business day).
//  The credited amount must fail closed for expired / not-yet-started offers,
//  regardless of a stored active===true toggle or any client-supplied state.
// ─────────────────────────────────────────────────────────────────────────────
describe('offerRuntimeStatus — authoritative status', () => {
  const base = { active: true, bonusPoints: 50 };
  it('enabled, no dates → active (open-ended)', () => {
    expect(offerRuntimeStatus(base, T_AFTER_END_DAY)).toBe('active');
  });
  it('enabled, within end day (one second before expiry) → active', () => {
    expect(offerRuntimeStatus({ ...base, endDate: '2026-09-30' }, T_WITHIN_END_DAY)).toBe('active');
  });
  it('enabled, day after end → expired', () => {
    expect(offerRuntimeStatus({ ...base, endDate: '2026-09-30' }, T_AFTER_END_DAY)).toBe('expired');
  });
  it('enabled, start in the future → scheduled', () => {
    expect(offerRuntimeStatus({ ...base, startDate: '2026-12-01' }, T_BEFORE_START)).toBe('scheduled');
  });
  it('disabled (active=false) but date-valid → inactive', () => {
    expect(offerRuntimeStatus({ ...base, active: false, endDate: '2099-01-01' }, T_WITHIN_END_DAY)).toBe('inactive');
  });
  it('accepts Firestore-Timestamp-like endDate', () => {
    const ts = { toMillis: () => Date.parse('2026-09-30T20:59:59Z') };
    expect(offerRuntimeStatus({ ...base, endDate: ts }, T_AFTER_END_DAY)).toBe('expired');
  });
  it('winter DST boundary (UTC+2): end 2026-01-15 valid at 21:59Z, expired at 22:00Z', () => {
    const o = { ...base, endDate: '2026-01-15' };
    expect(offerRuntimeStatus(o, Date.parse('2026-01-15T21:59:00Z'))).toBe('active');
    expect(offerRuntimeStatus(o, Date.parse('2026-01-15T22:00:00Z'))).toBe('expired');
  });
  it('athensDateStr yields YYYY-MM-DD across the boundary', () => {
    expect(athensDateStr(T_WITHIN_END_DAY)).toBe('2026-09-30');
    expect(athensDateStr(T_AFTER_END_DAY)).toBe('2026-10-01');
  });
});

describe('canonicalOfferValue / canonicalOfferCredit — expiration fails closed', () => {
  const offer = { active: true, bonusPoints: 50, endDate: '2026-09-30' };

  it('redeem one second before expiry → allowed', () => {
    expect(canonicalOfferCredit(offer, rc(50), T_WITHIN_END_DAY))
      .toEqual({ ok: true, canonicalBonus: 50 });
  });
  it('redeem after expiry → denied (offer-expired)', () => {
    const r = canonicalOfferCredit(offer, rc(50), T_AFTER_END_DAY);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('offer-expired');
  });
  it('disabled but date-valid → denied (offer-ineligible)', () => {
    const r = canonicalOfferCredit({ active: false, bonusPoints: 50, endDate: '2099-01-01' }, rc(50), T_WITHIN_END_DAY);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('offer-ineligible');
  });
  it('future/scheduled offer → denied (offer-scheduled)', () => {
    const r = canonicalOfferCredit({ active: true, bonusPoints: 50, startDate: '2026-12-01' }, rc(50), T_BEFORE_START);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('offer-scheduled');
  });
  it('expired offer with a request value that otherwise matches → still denied (no client active override possible)', () => {
    // The amount comes from the offer doc; even a perfectly matching request
    // value cannot resurrect an expired offer.
    const r = canonicalOfferValue(offer, T_AFTER_END_DAY);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('offer-expired');
  });
  it('replayed old code after expiry (offer long past) → denied', () => {
    const past = { active: true, bonusPoints: 50, endDate: '2020-01-01' };
    expect(canonicalOfferCredit(past, rc(50), T_AFTER_END_DAY).reason).toBe('offer-expired');
  });
});

describe('planOfferRedeem (adminVerifyRedemption path) — expiration fails closed', () => {
  const ctx = (nowMs) => ({ nowMs, nowIso: new Date(nowMs).toISOString(), actorUid: 'owner', storeId: 's1' });
  const customer = { points: 100, totalPoints: 100 };
  const redemption = { offerId: 'OF1', offerTitle: 'X', customerUid: 'U1' };

  it('within end day → credits canonical bonus', () => {
    const p = planOfferRedeem(redemption, { active: true, bonusPoints: 50, endDate: '2026-09-30' }, customer, 'C1', null, ctx(T_WITHIN_END_DAY));
    expect(p.ok).toBe(true);
    expect(p.amount).toBe(50);
  });
  it('after expiry → denied (offer-expired), no economic effect', () => {
    const p = planOfferRedeem(redemption, { active: true, bonusPoints: 50, endDate: '2026-09-30' }, customer, 'C1', null, ctx(T_AFTER_END_DAY));
    expect(p.ok).toBe(false);
    expect(p.reason).toBe('offer-expired');
    expect(p.customerUpdate).toBeUndefined();
  });
  it('scheduled → denied (offer-scheduled)', () => {
    const p = planOfferRedeem(redemption, { active: true, bonusPoints: 50, startDate: '2026-12-01' }, customer, 'C1', null, ctx(T_BEFORE_START));
    expect(p.ok).toBe(false);
    expect(p.reason).toBe('offer-scheduled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  R2 · Negative-balance redemption safety (server-authoritative decision layer)
// ─────────────────────────────────────────────────────────────────────────────
describe('R2 · negative balance cannot redeem (planRewardRedeem)', () => {
  const ctx = (nowMs) => ({ nowMs, nowIso: new Date(nowMs).toISOString(), actorUid: 'owner', storeId: 's1' });
  const reward = (cost) => ({ isActive: true, cost, title: 'R', discount: 0 });
  const redemption = { rewardId: 'RW1', customerUid: 'U1' };

  it('A · points -400, reward cost 1 → DENIED (insufficient-balance)', () => {
    const p = planRewardRedeem(redemption, reward(1), { points: -400 }, 'C1', null, ctx(Date.now()));
    expect(p.ok).toBe(false);
    expect(p.reason).toBe('insufficient-balance');
  });
  it('B · after earning back to 100, reward cost 50 → ALLOWED', () => {
    const p = planRewardRedeem(redemption, reward(50), { points: 100 }, 'C1', null, ctx(Date.now()));
    expect(p.ok).toBe(true);
    expect(p.after).toBe(50);
  });
  it('B-edge · exact balance equals cost → ALLOWED (boundary)', () => {
    const p = planRewardRedeem(redemption, reward(50), { points: 50 }, 'C1', null, ctx(Date.now()));
    expect(p.ok).toBe(true);
    expect(p.after).toBe(0);
  });
  it('C · negative balance may still RECEIVE a non-points offer bonus (not blanket-blocked)', () => {
    const p = planOfferRedeem(
      { offerId: 'OF1', offerTitle: 'X', customerUid: 'U1' },
      { active: true, bonusPoints: 50 },
      { points: -400, totalPoints: 1000 }, 'C1', null,
      { nowMs: Date.now(), nowIso: new Date().toISOString(), actorUid: 'owner' },
    );
    expect(p.ok).toBe(true);     // earning is allowed while negative
    expect(p.amount).toBe(50);
    expect(p.after).toBe(-350);  // -400 + 50, truthful
  });
});
