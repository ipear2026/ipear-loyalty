// @vitest-environment jsdom
// ───────────────────────────────────────────────────────────────────────────
//  OFFER EXPIRATION — browser-side display/filter mirror (src/utils.js).
//  The server (functions/lib/offer-credit.js) is the economic authority; this
//  suite locks the Admin status label + the customer active-offer filter so an
//  expired, still-enabled offer never shows "Ενεργή" and is never presented as
//  redeemable. Same Europe/Athens business-day rule as the server.
// ───────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { offerRuntimeStatus, offerStatusLabel, athensDateStr } from '../src/utils.js';

const T_WITHIN_END_DAY = Date.parse('2026-09-30T20:59:59Z'); // 23:59:59 Athens 30/09
const T_AFTER_END_DAY = Date.parse('2026-09-30T21:00:00Z');  // 00:00:00 Athens 01/10
const T_BEFORE_START = Date.parse('2026-09-30T10:00:00Z');

describe('Admin offer status display', () => {
  it('expired offer with enabled=true → "Έληξε" (NOT "Ενεργή")', () => {
    const o = { active: true, bonusPoints: 50, endDate: '2026-09-30' };
    const status = offerRuntimeStatus(o, T_AFTER_END_DAY);
    expect(status).toBe('expired');
    expect(offerStatusLabel(status)).toBe('Έληξε');
  });
  it('active offer → "Ενεργή"', () => {
    expect(offerStatusLabel(offerRuntimeStatus({ active: true, endDate: '2026-09-30', bonusPoints: 50 }, T_WITHIN_END_DAY))).toBe('Ενεργή');
  });
  it('scheduled offer → "Προγραμματισμένη"', () => {
    expect(offerStatusLabel(offerRuntimeStatus({ active: true, startDate: '2026-12-01', bonusPoints: 50 }, T_BEFORE_START))).toBe('Προγραμματισμένη');
  });
  it('disabled toggle → "Ανενεργή"', () => {
    expect(offerStatusLabel(offerRuntimeStatus({ active: false, bonusPoints: 50 }, T_WITHIN_END_DAY))).toBe('Ανενεργή');
  });
  it('owner extends endDate into the future → becomes active again', () => {
    const extended = { active: true, bonusPoints: 50, endDate: '2027-01-01' };
    expect(offerRuntimeStatus(extended, T_AFTER_END_DAY)).toBe('active');
  });
});

describe('Customer active-offer filter', () => {
  const isActive = (o, now) => offerRuntimeStatus(o, now) === 'active';
  it('excludes expired offers', () => {
    expect(isActive({ active: true, endDate: '2026-09-30', bonusPoints: 50 }, T_AFTER_END_DAY)).toBe(false);
  });
  it('excludes not-yet-started (scheduled) offers', () => {
    expect(isActive({ active: true, startDate: '2026-12-01', bonusPoints: 50 }, T_BEFORE_START)).toBe(false);
  });
  it('includes a currently-valid offer', () => {
    expect(isActive({ active: true, endDate: '2026-09-30', bonusPoints: 50 }, T_WITHIN_END_DAY)).toBe(true);
  });
  it('open-ended enabled offer stays visible', () => {
    expect(isActive({ active: true, bonusPoints: 50 }, T_AFTER_END_DAY)).toBe(true);
  });
});

describe('timezone / day-boundary', () => {
  it('athensDateStr crosses at Athens midnight, not UTC midnight', () => {
    expect(athensDateStr(T_WITHIN_END_DAY)).toBe('2026-09-30');
    expect(athensDateStr(T_AFTER_END_DAY)).toBe('2026-10-01');
  });
});
