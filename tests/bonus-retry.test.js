// @vitest-environment node
// ───────────────────────────────────────────────────────────────────────────
//  Bonus retry-gate (client half of exactly-once) — unit tests.
//  Verifies _retryPendingBonuses only re-fires a bonus while its durable
//  marker is still unset, so an already-credited customer can never re-trigger
//  a duplicate +50 / +100, and a customer whose initial credit failed DOES
//  retry on the next login. Reward amounts/eligibility are unchanged.
// ───────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { pendingBonuses } from '../src/customer/bonus-retry.js';

describe('pendingBonuses — WELCOME gate', () => {
  it('initial success not yet flagged → needs welcome retry', () => {
    expect(pendingBonuses({ marketingOptIn: true }).needsWelcome).toBe(true);
    expect(pendingBonuses({ marketingOptIn: true, marketingWelcomeProcessed: false }).needsWelcome).toBe(true);
  });
  it('already processed → NO welcome retry (no duplicate +50)', () => {
    expect(pendingBonuses({ marketingOptIn: true, marketingWelcomeProcessed: true }).needsWelcome).toBe(false);
  });
  it('not opted into marketing → never a welcome bonus', () => {
    expect(pendingBonuses({ marketingOptIn: false }).needsWelcome).toBe(false);
    expect(pendingBonuses({}).needsWelcome).toBe(false);
  });
});

describe('pendingBonuses — REFERRAL gate', () => {
  it('has referredBy, not yet flagged → needs referral retry', () => {
    expect(pendingBonuses({ referredBy: 'IP-ABC123' }).needsReferral).toBe(true);
    expect(pendingBonuses({ referredBy: 'IP-ABC123', referralProcessed: false }).needsReferral).toBe(true);
  });
  it('referralProcessed already true → NO referral retry (no duplicate +100)', () => {
    expect(pendingBonuses({ referredBy: 'IP-ABC123', referralProcessed: true }).needsReferral).toBe(false);
  });
  it('no referredBy → never a referral bonus', () => {
    expect(pendingBonuses({ referredBy: '' }).needsReferral).toBe(false);
    expect(pendingBonuses({}).needsReferral).toBe(false);
  });
});

describe('pendingBonuses — combined / recovery', () => {
  it('both pending → any=true (initial-failure recovery on login)', () => {
    const r = pendingBonuses({ marketingOptIn: true, referredBy: 'IP-ABC123' });
    expect(r).toEqual({ needsWelcome: true, needsReferral: true, any: true });
  });
  it('both already processed → any=false (fully credited, retry no-ops)', () => {
    const r = pendingBonuses({
      marketingOptIn: true, marketingWelcomeProcessed: true,
      referredBy: 'IP-ABC123', referralProcessed: true,
    });
    expect(r).toEqual({ needsWelcome: false, needsReferral: false, any: false });
  });
  it('welcome done, referral still pending → only referral retries', () => {
    const r = pendingBonuses({
      marketingOptIn: true, marketingWelcomeProcessed: true,
      referredBy: 'IP-ABC123', referralProcessed: false,
    });
    expect(r.needsWelcome).toBe(false);
    expect(r.needsReferral).toBe(true);
  });
  it('null/undefined customer is safe', () => {
    expect(pendingBonuses(null)).toEqual({ needsWelcome: false, needsReferral: false, any: false });
    expect(pendingBonuses(undefined).any).toBe(false);
  });
});
