'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS Stage 2 — customer-lifecycle PURE helpers (owner-only
//  server-authoritative customer deletion / anonymization).
//
//  INVARIANT: customer deletion MUST NOT destroy financial evidence.
//  The financial ledger (ipear_transactions) is append-only; deletion
//  ANONYMIZES PII on each row and RETAINS the immutable financial facts
//  (points/delta/type/date/source/idempotency/before-after). It is NEVER
//  hard-deleted, and clients can never update/delete it (Firestore rules).
//
//  Everything here is pure + unit-testable; the Admin-SDK execution lives in
//  functions/index.js (_adminDeleteCustomerHandler).
// ═══════════════════════════════════════════════════════════════════════════
const { createHash } = require('node:crypto');

// Irreversible pseudonymous tombstone identity. One-way SHA-256 over a stable
// seed (prefer the auth uid, else the customer doc id). NEVER reversible,
// NEVER a raw email/phone/name. Deterministic → idempotent retries produce the
// SAME tombstone, so re-anonymizing a row is a no-op.
function tombstoneId(seed) {
  const s = String(seed == null ? '' : seed);
  const h = createHash('sha256').update('ipear-lifecycle-v1|' + s).digest('hex').slice(0, 24);
  return 'deleted_customer_' + h;
}

// Deterministic lifecycle request id (idempotency + completion-marker key).
// Pure function of the target identity (or an explicit idempotency key), so two
// requests to delete the same customer COMPUTE THE SAME admin_audit doc id.
function lifecycleId(customerId, idempotencyKey) {
  const raw = idempotencyKey ? String(idempotencyKey) : String(customerId || '');
  return 'lifecycle_' + createHash('sha256').update('del|' + raw).digest('hex').slice(0, 40);
}

// PII-bearing fields that get scrubbed from a ledger / redemption row. The
// financial facts (points, totalPoints snapshots, type, amount, delta, date,
// serverTimestamp, source, idempotency refs, before/after) are PRESERVED.
const LEDGER_PII_FIELDS = Object.freeze([
  'customerEmail', 'customerName', 'customerPhone', 'phone', 'email', 'name',
]);

// Build the field-level update that anonymizes ONE ledger/redemption row:
// strip PII, repoint identity to the tombstone, stamp _anonymizedAt. Returns
// null when the row is ALREADY anonymized to this tombstone (idempotent no-op).
// Financial amounts are intentionally untouched — this is the single,
// documented, server-only controlled exception to append-only semantics.
function planLedgerAnonymization(row, tombstone, nowIso) {
  const r = row || {};
  const already = r._anonymizedAt && r.customerId === tombstone && r.customerUid === tombstone;
  if (already) return null;
  const update = {
    customerId: tombstone,
    customerUid: tombstone,
    _anonymizedAt: nowIso,
    _tombstone: tombstone,
  };
  for (const f of LEDGER_PII_FIELDS) {
    if (f in r && r[f] !== null) update[f] = null; // remove PII, keep financial facts
  }
  return update;
}

// Collection-by-collection TECHNICAL lifecycle policy. Legal retention is a
// separate concern and intentionally NOT encoded here.
//   RETAIN_ANONYMIZE  (C) — keep the row as immutable financial/security
//                           evidence; strip PII; repoint to tombstone.
//   ANONYMIZE         (B) — operational record; strip PII, keep the marker.
//   RETAIN_IMMUTABLE  (C) — never modified or deleted by lifecycle (append-only).
//   DELETE            (A) — transient/PII record with no financial evidence.
const LIFECYCLE_POLICY = Object.freeze({
  ipear_transactions:        'RETAIN_ANONYMIZE', // C — append-only financial ledger
  ipear_offer_redemptions:   'RETAIN_ANONYMIZE', // C — financial redemption evidence
  ipear_redemptions:         'RETAIN_ANONYMIZE', // C — financial redemption evidence
  ipear_redemption_requests: 'ANONYMIZE',        // B — operational request PII
  ipear_birthday_claims:     'ANONYMIZE',        // B — idempotency marker; strip PII
  audit_logs:                'ANONYMIZE',        // B/C — keep security log; strip PII
  admin_audit:               'RETAIN_IMMUTABLE',  // C — never touched; append-only
  ipear_referral_queue:      'DELETE',            // A — transient operational marker
  ipear_customers:           'DELETE',            // A — PII profile (balance → ledger)
  // Firebase Auth user:     DELETE (A)
});

module.exports = {
  tombstoneId,
  lifecycleId,
  LEDGER_PII_FIELDS,
  planLedgerAnonymization,
  LIFECYCLE_POLICY,
};
