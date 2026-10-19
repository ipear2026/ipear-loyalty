// Focused unit tests for the semantic-direction resolver in
// src/customer/ui/history-ui.js. These prove the FE-1 fix for the
// order #12809 mis-labelled reversal (green "+200") without any data
// migration or balance mutation.

import { describe, it, expect } from 'vitest';
import {
  resolveTxDirection,
  formatTxAmount,
  POSITIVE_TX_TYPES,
  NEGATIVE_TX_TYPES,
} from '../src/customer/ui/history-ui.js';

// ─── Case-1..15 from the spec ────────────────────────────────────────────────
describe('resolveTxDirection — authoritative-type classification', () => {
  it('case 1: {type:"add", points:200} → positive 200 → renders "+200"', () => {
    const dir = resolveTxDirection({ type: 'add', points: 200 });
    expect(dir).toEqual({ sign: 'positive', magnitude: 200 });
    expect(formatTxAmount({ type: 'add', points: 200 })).toBe('+200');
  });

  it('case 2: {type:"subtract", points:200} → negative 200 → renders "-200" (the #12809 bug)', () => {
    const dir = resolveTxDirection({ type: 'subtract', points: 200 });
    expect(dir).toEqual({ sign: 'negative', magnitude: 200 });
    expect(formatTxAmount({ type: 'subtract', points: 200 })).toBe('-200');
  });

  it('case 3: {type:"subtract", points:-200} → negative 200 → renders "-200" (defensive)', () => {
    const dir = resolveTxDirection({ type: 'subtract', points: -200 });
    expect(dir).toEqual({ sign: 'negative', magnitude: 200 });
    expect(formatTxAmount({ type: 'subtract', points: -200 })).toBe('-200');
  });

  it('case 4: {type:"refund_clawback", points:-200} → negative 200 (legacy shape)', () => {
    const dir = resolveTxDirection({ type: 'refund_clawback', points: -200 });
    expect(dir).toEqual({ sign: 'negative', magnitude: 200 });
    expect(formatTxAmount({ type: 'refund_clawback', points: -200 })).toBe('-200');
  });

  it('case 5: {type:"refund_clawback", points:200} → negative 200 (belt-and-braces)', () => {
    const dir = resolveTxDirection({ type: 'refund_clawback', points: 200 });
    expect(dir).toEqual({ sign: 'negative', magnitude: 200 });
    expect(formatTxAmount({ type: 'refund_clawback', points: 200 })).toBe('-200');
  });

  it('case 6: {type:"redeem", points:-2500} → negative 2500 → renders "-2.500" (Greek thousands)', () => {
    const dir = resolveTxDirection({ type: 'redeem', points: -2500 });
    expect(dir).toEqual({ sign: 'negative', magnitude: 2500 });
    expect(formatTxAmount({ type: 'redeem', points: -2500 })).toBe('-2.500');
  });

  it('case 7: {type:"expire", points:100} → negative 100 → renders "-100"', () => {
    const dir = resolveTxDirection({ type: 'expire', points: 100 });
    expect(dir).toEqual({ sign: 'negative', magnitude: 100 });
    expect(formatTxAmount({ type: 'expire', points: 100 })).toBe('-100');
  });

  it('case 8: {type:"tier_downgrade", points:100} → negative 100 → renders "-100"', () => {
    const dir = resolveTxDirection({ type: 'tier_downgrade', points: 100 });
    expect(dir).toEqual({ sign: 'negative', magnitude: 100 });
    expect(formatTxAmount({ type: 'tier_downgrade', points: 100 })).toBe('-100');
  });

  it('case 9: {type:"referral", points:50} → positive 50 → renders "+50"', () => {
    const dir = resolveTxDirection({ type: 'referral', points: 50 });
    expect(dir).toEqual({ sign: 'positive', magnitude: 50 });
    expect(formatTxAmount({ type: 'referral', points: 50 })).toBe('+50');
  });

  it('case 10: unknown type + positive points → positive (raw-sign fallback, prevents accidental "-" on future types)', () => {
    const dir = resolveTxDirection({ type: 'admin_bonus_future', points: 50 });
    expect(dir).toEqual({ sign: 'positive', magnitude: 50 });
    expect(formatTxAmount({ type: 'admin_bonus_future', points: 50 })).toBe('+50');
  });

  it('case 11: unknown type + negative points → negative (raw-sign fallback)', () => {
    const dir = resolveTxDirection({ type: 'admin_deduct_future', points: -50 });
    expect(dir).toEqual({ sign: 'negative', magnitude: 50 });
    expect(formatTxAmount({ type: 'admin_deduct_future', points: -50 })).toBe('-50');
  });

  it('case 12: zero-point record → sign="zero", no false sign', () => {
    expect(resolveTxDirection({ type: 'zero_test', points: 0 })).toEqual({ sign: 'zero', magnitude: 0 });
    expect(formatTxAmount({ type: 'zero_test', points: 0 })).toBe('0');
    // A missing points field also normalises to 0 without crashing.
    expect(resolveTxDirection({ type: 'unknown' })).toEqual({ sign: 'zero', magnitude: 0 });
    expect(formatTxAmount({ type: 'unknown' })).toBe('0');
  });

  it('case 13: no double minus — "-(-200)" style bugs cannot occur', () => {
    // Both stored-magnitude and stored-signed forms must produce exactly one "-".
    for (const shape of [
      { type: 'subtract',        points: 200 },
      { type: 'subtract',        points: -200 },
      { type: 'refund_clawback', points: 200 },
      { type: 'refund_clawback', points: -200 },
      { type: 'redeem',          points: -200 },
      { type: 'expire',          points: 200 },
    ]) {
      const s = formatTxAmount(shape);
      expect(s.startsWith('-')).toBe(true);
      expect(s.indexOf('--')).toBe(-1);
      expect(s).toBe('-200');
    }
  });

  it('case 14: Greek thousands separator survives (uses "." for thousands in el-GR)', () => {
    expect(formatTxAmount({ type: 'subtract', points: 12345 })).toBe('-12.345');
    expect(formatTxAmount({ type: 'add',      points: 12345 })).toBe('+12.345');
    expect(formatTxAmount({ type: 'redeem',   points: -12345 })).toBe('-12.345');
  });

  it('case 15: non-numeric or missing points is treated as 0, sign="zero"', () => {
    expect(resolveTxDirection({ type: 'add', points: NaN }).sign).toBe('zero');
    expect(resolveTxDirection({ type: 'add', points: 'abc' }).sign).toBe('zero');
    expect(resolveTxDirection({ type: 'add', points: undefined }).sign).toBe('zero');
    expect(resolveTxDirection({ type: 'add', points: null }).sign).toBe('zero');
    expect(resolveTxDirection({ type: 'add' }).sign).toBe('zero');
  });

  it('exports the classification sets so admin/analytics code can reuse them if desired', () => {
    expect(POSITIVE_TX_TYPES.has('add')).toBe(true);
    expect(POSITIVE_TX_TYPES.has('referral')).toBe(true);
    expect(POSITIVE_TX_TYPES.has('subtract')).toBe(false);

    expect(NEGATIVE_TX_TYPES.has('subtract')).toBe(true);
    expect(NEGATIVE_TX_TYPES.has('refund_clawback')).toBe(true);
    expect(NEGATIVE_TX_TYPES.has('redeem')).toBe(true);
    expect(NEGATIVE_TX_TYPES.has('expire')).toBe(true);
    expect(NEGATIVE_TX_TYPES.has('tier_downgrade')).toBe(true);
    expect(NEGATIVE_TX_TYPES.has('add')).toBe(false);
  });

  it('the exact stored shape of order #12809 renders correctly with no migration', () => {
    // What the Worker's handleWooRefundOrder wrote when the operator cancelled
    // order #12809: { type:'subtract', points:200, category:'↩︎ E-shop refund', … }.
    // The resolver must render "-200" without touching the Firestore document.
    const tx = {
      type: 'subtract',
      points: 200,
      category: '↩︎ E-shop refund',
      note: 'WooCommerce Refund #cancel-12809 on Order #12809 (ledger v2)',
      date: '2026-09-05T10:00:00.000Z',
      source: 'woo-integrity/v2',
    };
    expect(formatTxAmount(tx)).toBe('-200');
    expect(resolveTxDirection(tx).sign).toBe('negative');
  });
});
