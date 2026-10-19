// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS · Stage 1 — admin UI adapter for server-authoritative
//  financial mutations.
//
//  The admin UI submits an INTENT to the `adminAdjustPoints` callable and the
//  server computes + commits the result. The legacy direct-Firestore path is a
//  MUTUALLY EXCLUSIVE emergency rollback only (see customer-points.js).
//
//  HARDENED (regression fix 2026-10-13): the server-authoritative path is now
//  the DEFAULT-ON, fail-safe behaviour. Previously this defaulted OFF, so any
//  Pages build that shipped without VITE_ADMIN_SERVER_FINANCIAL=1 silently
//  reverted every admin financial write to the legacy direct-Firestore path —
//  which the locked firestore.rules DENY, surfacing as "Δεν έχετε δικαίωμα".
//  That footgun is removed: a missing/absent flag can NEVER disable the server
//  path. The legacy path is reachable ONLY via an EXPLICIT, deliberate
//  kill-switch, kept solely as an emergency rollback lever:
//    • build:   VITE_ADMIN_SERVER_FINANCIAL=0            (explicit opt-out)
//    • runtime: window.__ADMIN_SERVER_FINANCIAL_MUTATIONS = false  (DevTools)
//  Any other value (including unset) keeps the server-authoritative path ON.
// ═══════════════════════════════════════════════════════════════════════════
import { getFunctions, httpsCallable } from 'firebase/functions';

const CALLABLE_REGION = 'europe-west1';

function _fns() {
  // Mirror approval-queue.js: fall back to the default app if the global is unset.
  return getFunctions(window._firebaseApp || undefined, CALLABLE_REGION);
}

export function isServerFinancialEnabled() {
  // DEFAULT-ON. Only an EXPLICIT kill-switch returns false; a missing/absent
  // flag can no longer silently disable the server-authoritative path.
  try {
    // Explicit emergency opt-out (build): VITE_ADMIN_SERVER_FINANCIAL=0
    if (typeof import.meta !== 'undefined' && import.meta.env &&
        String(import.meta.env.VITE_ADMIN_SERVER_FINANCIAL) === '0') return false;
  } catch (_) { /* no import.meta in some contexts */ }
  try {
    // Explicit emergency opt-out (runtime): window.__ADMIN_SERVER_FINANCIAL_MUTATIONS === false
    if (typeof window !== 'undefined' && window.__ADMIN_SERVER_FINANCIAL_MUTATIONS === false) return false;
  } catch (_) {}
  return true; // default ON → server-authoritative callable path
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
