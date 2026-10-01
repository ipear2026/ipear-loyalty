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
const { canonicalOfferCredit } = require('../functions/lib/offer-credit.js');

// req.rewardCost is stored NEGATIVE for offer_credit, so a legitimate request
// for an N-point offer carries rewardCost = -N.
const rc = (n) => -n;

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
