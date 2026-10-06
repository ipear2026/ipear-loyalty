"use strict";
// ───────────────────────────────────────────────────────────────────────────
//  ADMIN FORTRESS · Stage 1 — server-authoritative point-mutation core.
//
//  Invariant: NO FINANCIAL MUTATION MAY TRUST THE ADMIN BROWSER TO COMPUTE OR
//  DIRECTLY WRITE THE RESULT. The browser submits an INTENT
//  ({ customerId, operation, amount, reason, idempotencyKey }); the server
//  resolves the customer, reads the authoritative balance, validates the
//  amount, computes the result, enforces idempotency, and writes the ledger +
//  immutable audit row inside one transaction.
//
//  This module is PURE + dependency-free: `validateAdjustInput` guards the
//  intent, and `planAdjustment` turns (current state + validated intent) into
//  the exact writes to commit — so the whole decision surface (auth-independent)
//  is unit-testable without the Firestore emulator.
// ───────────────────────────────────────────────────────────────────────────

// Per-operation server-side magnitude cap (defense-in-depth; AF-8). Tunable by
// env OWNER-side later; conservative default well above legitimate manual ops
// (legacy UI capped a single purchase at 5000€ → ~a few thousand points).
const MAX_ADJUST_MAGNITUDE = 100000;
const MIN_REASON_LEN = 3;
const MAX_REASON_LEN = 300;
const OPERATIONS = new Set(["add", "subtract", "correct"]);

// Validate the client INTENT. Never trusts newBalance / previousBalance / role
// / actorUid / timestamp / ledgerId — those are server-derived downstream.
function validateAdjustInput(data) {
  if (!data || typeof data !== "object") return { ok: false, reason: "bad-input" };
  const { customerId, operation, amount, reason, idempotencyKey } = data;

  if (typeof customerId !== "string" || !customerId.trim() || customerId.length > 200) {
    return { ok: false, reason: "bad-customerId" };
  }
  if (!OPERATIONS.has(operation)) return { ok: false, reason: "bad-operation" };
  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount)) {
    return { ok: false, reason: "bad-amount" };
  }
  if (operation === "add" || operation === "subtract") {
    if (amount <= 0) return { ok: false, reason: "amount-must-be-positive" };
  } else {
    // 'correct' = signed delta; must be non-zero.
    if (amount === 0) return { ok: false, reason: "amount-must-be-nonzero" };
  }
  if (Math.abs(amount) > MAX_ADJUST_MAGNITUDE) return { ok: false, reason: "amount-exceeds-limit" };
  if (typeof reason !== "string" || reason.trim().length < MIN_REASON_LEN || reason.length > MAX_REASON_LEN) {
    return { ok: false, reason: "bad-reason" };
  }
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
    return { ok: false, reason: "bad-idempotencyKey" };
  }
  return {
    ok: true,
    value: { customerId: customerId.trim(), operation, amount, reason: reason.trim(), idempotencyKey },
  };
}

// Signed delta applied to the balance for each operation.
function signedDelta(operation, amount) {
  if (operation === "add") return Math.abs(amount);
  if (operation === "subtract") return -Math.abs(amount);
  return amount; // 'correct' — already signed
}

// Deterministic ids keyed on the idempotency key — identical requests collide
// on the same doc id, so a transaction sees one existing row and no-ops.
function ledgerIdForKey(key) { return `adj_${key}`; }
function auditIdForKey(key) { return `adj_${key}`; }

// Plan the writes for an adjustment. PURE — no Firestore, no auth.
//   state = { exists, blocked, points, totalPoints, customer:{uid,email,name,card} }
//   existingLedger = the current ledger doc data if adj_<key> already exists (idempotency), else null
//   input = validated intent (from validateAdjustInput().value)
//   ctx = { actorUid, storeId, storeName, nowIso }
// Returns one of:
//   { ok:false, code, reason }                         → map to HttpsError
//   { ok:true, idempotent:true, newPoints }            → already applied, no writes
//   { ok:true, idempotent:false, newPoints, delta, before, after, customerUpdate, ledger, audit }
function planAdjustment(state, existingLedger, input, ctx) {
  if (!state || !state.exists) return { ok: false, code: "not-found", reason: "customer-not-found" };
  if (state.blocked === true) return { ok: false, code: "failed-precondition", reason: "customer-blocked" };

  // Idempotency: the deterministic ledger row already exists → do not mutate
  // again; report the previously-committed resulting balance.
  if (existingLedger) {
    const prior = Number(
      existingLedger.balanceAfter != null ? existingLedger.balanceAfter : state.points
    );
    return { ok: true, idempotent: true, newPoints: prior };
  }

  const before = Number(state.points || 0);
  const delta = signedDelta(input.operation, input.amount);
  const after = before + delta;
  if (after < 0) return { ok: false, code: "failed-precondition", reason: "insufficient-balance" };

  // Lifetime `totalPoints` only ever increases (credits), matching legacy
  // semantics (manual redeem/debit never reduced lifetime earned).
  const beforeTotal = Number(state.totalPoints != null ? state.totalPoints : before);
  const afterTotal = delta > 0 ? beforeTotal + delta : beforeTotal;

  const cust = state.customer || {};
  const ledgerType = delta >= 0 ? "add" : "redeem";

  const customerUpdate = { points: after, totalPoints: afterTotal };

  const ledger = {
    customerId: input.customerId,
    customerUid: cust.uid || "",
    customerEmail: cust.email || "",
    customerName: cust.name || "",
    card: cust.card || "",
    type: ledgerType,
    operation: input.operation,
    points: delta,
    amount: 0,
    category: "🛠️ Admin Adjustment",
    note: input.reason,
    method: "admin_adjust",
    source: "admin_callable",
    balanceBefore: before,
    balanceAfter: after,
    idempotencyKey: input.idempotencyKey,
    storeId: ctx.storeId || null,
    storeName: ctx.storeName || null,
    date: ctx.nowIso,
    createdByAdmin: ctx.actorUid || "",
  };

  const audit = {
    action: "admin_adjust",
    operation: input.operation,
    source: "admin_callable",
    actorUid: ctx.actorUid || "",
    verifiedRole: "owner-admin",
    customerId: input.customerId,
    customerUid: cust.uid || "",
    amount: delta,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    balanceBefore: before,
    balanceAfter: after,
    success: true,
    // server timestamp is attached by the handler (FieldValue.serverTimestamp()).
  };

  return { ok: true, idempotent: false, newPoints: after, delta, before, after, customerUpdate, ledger, audit };
}

// ── Server-authoritative batch maintenance (expire / tier_downgrade) ─────────
const { downgradeTarget } = require("./tier");

const MAINT_OPS = new Set(["expire", "tier_downgrade"]);
const MAX_BATCH = 500; // Firestore transaction/batch ceiling; bounded per 2.4.

// Deterministic per-customer ids (match the legacy ids so re-runs across the
// old client path and the new server path collide → never double-apply).
function maintLedgerId(op, customerId, year) {
  return op === "expire" ? `expire_${customerId}_${year}` : `tier_downgrade_${customerId}_${year}`;
}

// Plan one maintenance mutation. PURE (no Firestore, no auth).
//   op          — 'expire' | 'tier_downgrade'
//   customerId  — doc id
//   state       — { exists, points, totalPoints, customer:{uid,email,name,card} }
//   existingLedger — the deterministic ledger doc data if it already exists, else null
//   ctx         — { actorUid, year, nowIso, storeId, storeName }
function planMaintenance(op, customerId, state, existingLedger, ctx) {
  if (!MAINT_OPS.has(op)) return { ok: false, code: "invalid-argument", reason: "bad-op" };
  if (!state || !state.exists) return { ok: false, code: "not-found", reason: "customer-not-found" };
  if (existingLedger) {
    return { ok: true, idempotent: true,
      newPoints: existingLedger.balanceAfter != null ? existingLedger.balanceAfter : undefined };
  }
  const cust = state.customer || {};
  const baseLedger = {
    customerId,
    customerUid: cust.uid || "",
    customerEmail: cust.email || "",
    customerName: cust.name || "",
    card: cust.card || "",
    amount: 0,
    source: "admin_callable",
    storeId: ctx.storeId || null,
    storeName: ctx.storeName || null,
    date: ctx.nowIso,
    createdByAdmin: ctx.actorUid || "",
  };
  const baseAudit = {
    operation: op, source: "admin_callable", actorUid: ctx.actorUid || "",
    verifiedRole: "owner-admin", customerId, customerUid: cust.uid || "", success: true,
  };

  if (op === "expire") {
    const before = Number(state.points || 0);
    if (before <= 0) return { ok: false, code: "failed-precondition", reason: "nothing-to-expire" };
    const delta = -before;
    return {
      ok: true, idempotent: false, before, after: 0, delta,
      customerUpdate: { points: 0 },
      ledger: { ...baseLedger, type: "expire", points: delta, category: "⏳ Εκπνοή Πόντων",
        note: "Μηδενισμός λόγω αδράνειας 12+ μηνών", balanceBefore: before, balanceAfter: 0 },
      audit: { ...baseAudit, action: "admin_expire", amount: delta, balanceBefore: before, balanceAfter: 0 },
    };
  }

  // tier_downgrade — server recomputes the target from the CANONICAL ladder.
  const beforeTot = Number(state.totalPoints != null ? state.totalPoints : (state.points || 0));
  const target = downgradeTarget(beforeTot);
  if (target === null) return { ok: false, code: "failed-precondition", reason: "not-eligible-bronze" };
  if (target >= beforeTot) return { ok: false, code: "failed-precondition", reason: "no-downgrade" };
  const diff = target - beforeTot; // negative (lifetime reduced for inactivity)
  return {
    ok: true, idempotent: false, before: beforeTot, after: target, delta: diff,
    customerUpdate: { totalPoints: target },
    ledger: { ...baseLedger, type: "tier_downgrade", points: diff, category: "📉 Tier Downgrade",
      note: `Tier downgrade λόγω αδράνειας (${ctx.year})`, balanceBefore: beforeTot, balanceAfter: target },
    audit: { ...baseAudit, action: "admin_tier_downgrade", amount: diff, balanceBefore: beforeTot, balanceAfter: target },
  };
}

module.exports = {
  MAX_ADJUST_MAGNITUDE,
  MIN_REASON_LEN,
  MAX_REASON_LEN,
  OPERATIONS,
  MAINT_OPS,
  MAX_BATCH,
  validateAdjustInput,
  signedDelta,
  ledgerIdForKey,
  auditIdForKey,
  maintLedgerId,
  planAdjustment,
  planMaintenance,
};
