// @vitest-environment node
// Customer-facing transaction label normalization — no backend enum / raw
// English may ever reach the customer; Greek must be natural.
import { describe, it, expect } from 'vitest';
import { cleanTxLabel, txLabel, TYPE_LABEL } from '../src/customer/ui/tx-labels.js';

describe('cleanTxLabel — legacy English + snake_case → natural Greek', () => {
  it.each([
    ['Admin Adjustment',        'Προσαρμογή πόντων'],
    ['admin_adjustment',        'Προσαρμογή πόντων'],
    ['Manual Correction',       'Προσαρμογή πόντων'],
    ['correction',              'Προσαρμογή πόντων'],
    ['Referral Bonus',          'Μπόνους σύστασης'],
    ['referral_bonus',          'Μπόνους σύστασης'],
    ['🎁 Referral Bonus',       'Μπόνους σύστασης'],  // emoji-prefixed legacy
    ['⚠️ Referral Reversal',    'Ακύρωση μπόνους σύστασης'],
    ['Purchase',                'Αγορά'],
    ['purchase',                'Αγορά'],
    ['Birthday Bonus',          'Δώρο γενεθλίων'],
    ['birthday_bonus',          'Δώρο γενεθλίων'],
    ['🎂 Birthday Bonus',       'Δώρο γενεθλίων'],
    ['🎁 Marketing Bonus',      'Μπόνους εγγραφής'],
    ['Tier Downgrade',          'Υποβάθμιση επιπέδου'],
    ['reward_redemption',       'Εξαργύρωση'],
    ['redemption',              'Εξαργύρωση'],
    ['refund_clawback',         'Επιστροφή'],
  ])('%s → %s', (raw, greek) => {
    expect(cleanTxLabel(raw)).toBe(greek);
  });

  it('preserves already-natural-Greek categories and reward/offer titles', () => {
    expect(cleanTxLabel('Αξεσουάρ')).toBe('Αξεσουάρ');
    expect(cleanTxLabel('🎁 Προσφορά: Δωρεάν καφές')).toBe('Προσφορά: Δωρεάν καφές');
    expect(cleanTxLabel('Επισκευή')).toBe('Επισκευή');
  });

  it('never leaks an unknown bare-English/enum value to the customer', () => {
    expect(cleanTxLabel('some_internal_enum')).not.toMatch(/_/);
    expect(cleanTxLabel('WeirdBackendThing')).toBe('Συναλλαγή');
    expect(cleanTxLabel('')).toBe('');
    expect(cleanTxLabel(null)).toBe('');
  });
});

describe('txLabel — whole-transaction resolution', () => {
  it('redeem prefers the reward item title', () => {
    expect(txLabel({ type: 'redeem', label: 'Καλώδιο Baseus' })).toBe('Καλώδιο Baseus');
    expect(txLabel({ type: 'redeem', discount: 5 })).toBe('Έκπτωση 5€');
    expect(txLabel({ type: 'redeem' })).toBe(TYPE_LABEL.redeem);
  });
  it('add with a legacy English category normalizes to Greek', () => {
    expect(txLabel({ type: 'add', category: 'Admin Adjustment' })).toBe('Προσαρμογή πόντων');
  });
  it('falls back to the type label when no category', () => {
    expect(txLabel({ type: 'add' })).toBe('Αγορά');
    expect(txLabel({ type: 'referral' })).toBe('Μπόνους σύστασης');
  });
  it('unknown type + no category → safe generic Greek', () => {
    expect(txLabel({ type: 'mystery' })).toBe('Συναλλαγή');
  });
});

// ── R2 · Woo purchase-refund labels (customer history) ───────────────────────
describe('R2 · Woo refund labels', () => {
  it('new Worker refund category (Greek) → "Επιστροφή αγοράς"', () => {
    expect(txLabel({ type: 'subtract', category: '🛒 Επιστροφή αγοράς', points: 200 }))
      .toBe('Επιστροφή αγοράς');
  });
  it('legacy English Worker category → "Επιστροφή αγοράς"', () => {
    expect(cleanTxLabel('↩︎ E-shop refund')).toBe('Επιστροφή αγοράς');
  });
  it('generic subtract with no category → "Επιστροφή" (legacy compatible)', () => {
    expect(txLabel({ type: 'subtract', points: 100 })).toBe('Επιστροφή');
  });
  it('unrelated manual deduction is NOT relabeled as a purchase refund', () => {
    // An admin "Προσαρμογή πόντων" deduction keeps its own meaning.
    expect(txLabel({ type: 'subtract', category: 'Admin Adjustment', points: 50 }))
      .toBe('Προσαρμογή πόντων');
  });
});
