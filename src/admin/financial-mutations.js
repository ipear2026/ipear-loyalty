// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS · Stage 1 — admin UI adapter for server-authoritative
//  financial mutations.
//
//  Feature flag: ADMIN_SERVER_FINANCIAL_MUTATIONS. DEFAULT OFF → the admin UI
//  keeps using the legacy direct-Firestore path (rollback-safe). When ON, the
//  UI submits an INTENT to the `adminAdjustPoints` callable and the server
//  computes + commits the result. The two paths are MUTUALLY EXCLUSIVE — the
//  caller runs exactly one for a given action (see customer-points.js).
//
//  Enable (any one):
//    • build:   VITE_ADMIN_SERVER_FINANCIAL=1
//    • runtime: window.__ADMIN_SERVER_FINANCIAL_MUTATIONS = true   (DevTools/testing)
// ═══════════════════════════════════════════════════════════════════════════
import { getFunctions, httpsCallable } from 'firebase/functions';

const CALLABLE_REGION = 'europe-west1';

function _fns() {
  // Mirror approval-queue.js: fall back to the default app if the global is unset.
  return getFunctions(window._firebaseApp || undefined, CALLABLE_REGION);
}

export function isServerFinancialEnabled() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env &&
        String(import.meta.env.VITE_ADMIN_SERVER_FINANCIAL) === '1') return true;
  } catch (_) { /* no import.meta in some contexts */ }
  try {
    if (typeof window !== 'undefined' && window.__ADMIN_SERVER_FINANCIAL_MUTATIONS === true) return true;
  } catch (_) {}
  return false; // default OFF → legacy direct-write path
}

// Server-side idempotency key. Collisions are astronomically unlikely; the
// server treats a repeated key as the SAME logical mutation (no double-credit).
export function newIdempotencyKey() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return 'ik_' + crypto.randomUUID().replace(/-/g, '');
    }
  } catch (_) {}
  return 'ik_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

// Submit an adjustment INTENT. operation ∈ {'add','subtract','correct'}.
// Returns the callable's data: { ok, idempotent, newPoints, ledgerId }.
export async function serverAdjustPoints({ customerId, operation, amount, reason, idempotencyKey }) {
  const fn = httpsCallable(_fns(), 'adminAdjustPoints');
  const res = await fn({
    customerId,
    operation,
    amount,
    reason,
    idempotencyKey: idempotencyKey || newIdempotencyKey(),
  });
  return res.data;
}

// Server-authoritative batch maintenance. The browser sends only op + the
// reviewed customerId list; the server reads each balance, computes the delta
// (expire → zero; tier_downgrade → canonical ladder), and writes atomically.
// Returns { ok, op, total, applied, idempotent, skipped, failed }.
export async function serverBatchMaintenance({ op, customerIds }) {
  const fn = httpsCallable(_fns(), 'adminBatchMaintenance');
  const res = await fn({ op, customerIds });
  return res.data;
}

// Server-authoritative birthday credit. The server fixes the amount and the
// annual idempotency key — the browser only names the customer.
// Returns { ok, idempotent, newPoints, ledgerId }.
export async function serverBirthdayCredit({ customerId }) {
  const fn = httpsCallable(_fns(), 'adminBirthdayCredit');
  const res = await fn({ customerId });
  return res.data;
}

// Server-authoritative 6-digit redemption-code verification. The server resolves
// the code → reward (debit) / offer (credit), the customer, and the authoritative
// amount. Returns { ok, kind, amount, newPoints, ledgerId, idempotent }.
export async function serverVerifyRedemption({ code }) {
  const fn = httpsCallable(_fns(), 'adminVerifyRedemption');
  const res = await fn({ code });
  return res.data;
}

// Server-authoritative customer deletion / lifecycle. The browser submits ONLY
// the customer identity (deletion intent). The server resolves the full identity
// set, ANONYMIZES the financial ledger (retains immutable evidence), deletes the
// PII docs + Auth user, and writes an immutable audit event. Idempotent.
// Returns { ok, idempotent, tombstone, lifecycleId, customersDeleted?, ... }.
export async function serverDeleteCustomer({ customerId, idempotencyKey }) {
  const fn = httpsCallable(_fns(), 'adminDeleteCustomer');
  const res = await fn({
    customerId,
    idempotencyKey: idempotencyKey || newIdempotencyKey(),
  });
  return res.data;
}
