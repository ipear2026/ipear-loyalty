// ═══════════════════════════════════════════════════════════════════════════
//  Customer-facing transaction label mapping (single source of truth).
//
//  Transaction docs store a `category`/`note` written by the admin, tablet or
//  Worker — some historical/legacy values are raw English or backend wording
//  ("🎁 Referral Bonus", "Admin Adjustment", "Marketing Bonus", "Tier
//  Downgrade", snake_case enums). Customers must NEVER see backend enums,
//  snake_case, or internal admin terminology.
//
//    • TYPE_LABEL  — natural-Greek default per transaction `type`.
//    • cleanTxLabel(raw) — normalize a stored category/note string to Greek,
//      preserving already-Greek values and reward titles. Historical docs are
//      never mutated; normalization happens only at render time.
//    • txLabel(tx)  — resolve the final customer label for a transaction,
//      preferring a reward's own item title, else type + normalized category.
// ═══════════════════════════════════════════════════════════════════════════

// Known raw/legacy category phrases AND backend enums → natural customer Greek.
// Keys are compared case-insensitively against the alphabetic core (leading
// emoji/punctuation stripped), and snake_case is matched directly.
const RAW_LABEL_MAP = [
  ['referral reversal',    'Ακύρωση μπόνους σύστασης'],
  ['referral_reversal',    'Ακύρωση μπόνους σύστασης'],
  ['referral bonus',       'Μπόνους σύστασης'],
  ['referral_bonus',       'Μπόνους σύστασης'],
  ['referral',             'Μπόνους σύστασης'],
  ['birthday bonus',       'Δώρο γενεθλίων'],
  ['birthday_bonus',       'Δώρο γενεθλίων'],
  ['birthday',             'Δώρο γενεθλίων'],
  ['marketing bonus',      'Μπόνους εγγραφής'],
  ['marketing_bonus',      'Μπόνους εγγραφής'],
  ['welcome bonus',        'Μπόνους εγγραφής'],
  ['tier downgrade',       'Υποβάθμιση επιπέδου'],
  ['tier_downgrade',       'Υποβάθμιση επιπέδου'],
  ['points expiry',        'Εκπνοή πόντων'],
  ['points_expiry',        'Εκπνοή πόντων'],
  ['expire',               'Εκπνοή πόντων'],
  ['admin adjustment',     'Προσαρμογή πόντων'],
  ['admin_adjustment',     'Προσαρμογή πόντων'],
  ['manual adjustment',    'Προσαρμογή πόντων'],
  ['manual_adjustment',    'Προσαρμογή πόντων'],
  ['manual correction',    'Προσαρμογή πόντων'],
  ['correction',           'Προσαρμογή πόντων'],
  ['adjustment',           'Προσαρμογή πόντων'],
  ['reward redemption',    'Εξαργύρωση'],
  ['reward_redemption',    'Εξαργύρωση'],
  ['redemption',           'Εξαργύρωση'],
  ['reward',               'Εξαργύρωση'],
  ['redeem',               'Εξαργύρωση'],
  ['refund',               'Επιστροφή'],
  ['refund_clawback',      'Επιστροφή'],
  ['clawback',             'Επιστροφή'],
  ['purchase',             'Αγορά'],
  ['order',                'Αγορά'],
  ['add',                  'Αγορά'],
];

// Natural-Greek default label per transaction type.
export const TYPE_LABEL = Object.freeze({
  add:             'Αγορά',
  redeem:          'Εξαργύρωση',
  subtract:        'Επιστροφή',
  refund_clawback: 'Επιστροφή',
  expire:          'Εκπνοή πόντων',
  tier_downgrade:  'Υποβάθμιση επιπέδου',
  referral:        'Μπόνους σύστασης',
  birthday:        'Δώρο γενεθλίων',
});

// Safe Greek fallback for an unrecognised value.
const GENERIC_FALLBACK = 'Συναλλαγή';

// Normalize a stored category/note to a customer-safe Greek label. Already-Greek
// values (e.g. "Αξεσουάρ", "Προσφορά: …", a reward title) pass through with any
// leading decorative emoji dropped for consistency. Returns '' for empty input.
export function cleanTxLabel(raw) {
  if (raw == null) return '';
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s) return '';
  // Alphabetic core: drop leading emoji/symbols, lower-case, for phrase match.
  const core = s.replace(/^[^\p{L}]+/u, '').toLowerCase().trim();
  if (!core) return '';
  for (const [needle, greek] of RAW_LABEL_MAP) {
    if (core === needle || core.startsWith(needle + ' ') || core.startsWith(needle + ':')) return greek;
  }
  // If the whole string is a backend enum (snake_case only), never show it raw.
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(core)) {
    return RAW_LABEL_MAP.find(([k]) => k === core)?.[1] || 'Προσαρμογή πόντων';
  }
  // Greek phrase containing a known English fragment (e.g. "🎁 Referral Bonus").
  for (const [needle, greek] of RAW_LABEL_MAP) {
    if (/[a-z]/.test(needle) && needle.includes(' ') && core.includes(needle)) return greek;
  }
  // Already natural Greek / a reward item title / "Προσφορά: X" — keep as-is
  // (minus any leading emoji we stripped), unless it's bare ASCII with no Greek.
  if (/\p{Script=Greek}/u.test(s)) return s.replace(/^[^\p{L}\d]+/u, '').trim() || s;
  // Bare ASCII word we don't recognise → generic, to avoid leaking English.
  return GENERIC_FALLBACK;
}

// Resolve the final customer-facing label for a transaction object.
export function txLabel(tx) {
  if (!tx || typeof tx !== 'object') return GENERIC_FALLBACK;
  const type = String(tx.type || '');
  // Reward redemptions: prefer the reward's own item title (dynamic catalog).
  if (type === 'redeem') {
    if (tx.label) return String(tx.label);
    if (tx.discount) return `Έκπτωση ${tx.discount}€`;
    return TYPE_LABEL.redeem;
  }
  const fromCategory = cleanTxLabel(tx.category);
  if (fromCategory && fromCategory !== GENERIC_FALLBACK) return fromCategory;
  if (TYPE_LABEL[type]) return TYPE_LABEL[type];
  const fromNote = cleanTxLabel(tx.note);
  if (fromNote && fromNote !== GENERIC_FALLBACK) return fromNote;
  return GENERIC_FALLBACK;
}
