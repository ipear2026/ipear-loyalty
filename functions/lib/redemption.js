"use strict";
// ───────────────────────────────────────────────────────────────────────────
//  ADMIN FORTRESS Stage 2 — server-authoritative redemption-code verification
//  (admin 6-digit code flow). PURE planners so the full decision surface is
//  unit-testable without the emulator.
//
//  Shares canonical business rules with the tablet approval path:
//   • offer value  → canonicalOfferValue() (same helper canonicalOfferCredit uses
//     → H1 inflation protection; the credited amount comes ONLY from the offer)
//   • reward cost  → re-read from the ipear_rewards catalog (never the redemption
//     doc) — same "catalog-trusted cost" rule the legacy browser path enforced.
//
//  Invariant: the browser supplies only the code; the server resolves the code,
//  the reward/offer, the customer, the amount, and computes the result.
// ───────────────────────────────────────────────────────────────────────────
const { canonicalOfferValue } = require("./offer-credit");

// Shared code-state gate (used / cancelled / rejected / expired). Pure.
function classifyRedemption(doc, nowMs) {
  if (!doc) return { ok: false, reason: "code-not-found" };
  if (doc.used === true || doc.status === "used") return { ok: false, reason: "already-used" };
  if (doc.status === "cancelled" || doc.status === "rejected") return { ok: false, reason: "code-invalid" };
  if (doc.expiresAt) {
    const exp = Date.parse(doc.expiresAt);
    if (Number.isFinite(exp) && nowMs > exp) return { ok: false, reason: "code-expired" };
  }
  return { ok: true };
}

function _ledgerBase(redemption, customer, ctx) {
  const c = customer || {};
  return {
    customerUid: redemption.customerUid || c.uid || "",
    customerEmail: redemption.customerEmail || c.email || "",
    customerName: redemption.customerName || c.name || "",
    card: redemption.card || c.card || "",
    source: "admin_verify_redemption",
    storeId: ctx.storeId || null,
    storeName: ctx.storeName || null,
    date: ctx.nowIso,
    createdByAdmin: ctx.actorUid || "",
    redemptionCode: ctx.code || null,
    redemptionId: ctx.redemptionId || null,
  };
}
function _auditBase(action, redemption, customerId, ctx) {
  return {
    action, operation: action, source: "admin_verify_redemption",
    actorUid: ctx.actorUid || "", verifiedRole: "owner-admin",
    customerId, customerUid: redemption.customerUid || "",
    redemptionId: ctx.redemptionId || null, success: true,
  };
}

// REWARD redemption → debit the catalog-trusted cost. Pure.
//   redemption: ipear_redemptions doc; reward: ipear_rewards doc (or null when
//   the redemption has no rewardId); customer: ipear_customers doc; customerId:
//   the resolved doc id; existingLedger: deterministic-id ledger doc if present.
function planRewardRedeem(redemption, reward, customer, customerId, existingLedger, ctx) {
  const st = classifyRedemption(redemption, ctx.nowMs);
  if (!st.ok) return { ok: false, code: "failed-precondition", reason: st.reason };
  if (existingLedger) return { ok: true, idempotent: true };

  let cost = Math.floor(Number(redemption.points) || 0);
  let discount = Number(redemption.discount) || 0;
  let label = redemption.label || "";
  if (redemption.rewardId) {
    if (!reward) return { ok: false, code: "failed-precondition", reason: "reward-missing" };
    if (reward.isActive === false) return { ok: false, code: "failed-precondition", reason: "reward-inactive" };
    cost = Math.floor(Number(reward.cost)) || cost;
    discount = Number(reward.discount) || discount;
    label = reward.title || label;
  }
  if (!Number.isInteger(cost) || cost <= 0) return { ok: false, code: "failed-precondition", reason: "invalid-cost" };
  if (!customer) return { ok: false, code: "not-found", reason: "customer-not-found" };
  if (customer.blocked === true) return { ok: false, code: "failed-precondition", reason: "customer-blocked" };

  const before = Number(customer.points || 0);
  if (before < cost) return { ok: false, code: "failed-precondition", reason: "insufficient-balance" };
  const after = before - cost;

  return {
    ok: true, idempotent: false, kind: "reward", before, after, amount: -cost,
    redemptionUpdate: { used: true, status: "used", usedAt: ctx.nowIso },
    customerUpdate: { points: after },
    ledger: { ..._ledgerBase(redemption, customer, ctx), customerId, type: "redeem",
      points: -cost, discount, label, method: "admin-verify",
      balanceBefore: before, balanceAfter: after },
    audit: { ..._auditBase("admin_verify_reward", redemption, customerId, ctx),
      amount: -cost, balanceBefore: before, balanceAfter: after },
  };
}

// OFFER redemption → credit the canonical offer value (H1-safe). Pure.
function planOfferRedeem(redemption, offer, customer, customerId, existingLedger, ctx) {
  const st = classifyRedemption(redemption, ctx.nowMs);
  if (!st.ok) return { ok: false, code: "failed-precondition", reason: st.reason };
  if (existingLedger) return { ok: true, idempotent: true };

  // H1: amount from the offer, never the doc/request. nowMs makes the
  // date-aware expiry/scheduled guard deterministic under test.
  const v = canonicalOfferValue(offer, ctx.nowMs);
  if (!v.ok) return { ok: false, code: "failed-precondition", reason: v.reason };
  if (!customer) return { ok: false, code: "not-found", reason: "customer-not-found" };
  if (customer.blocked === true) return { ok: false, code: "failed-precondition", reason: "customer-blocked" };

  const bonus = v.canonicalBonus;
  const before = Number(customer.points || 0);
  const beforeTot = Number(customer.totalPoints || 0);
  const after = before + bonus;
  const afterTot = beforeTot + bonus;

  return {
    ok: true, idempotent: false, kind: "offer", before, after, amount: bonus,
    redemptionUpdate: { used: true, status: "used", usedAt: ctx.nowIso },
    customerUpdate: { points: after, totalPoints: afterTot },
    ledger: { ..._ledgerBase(redemption, customer, ctx), customerId, type: "add",
      points: bonus, category: "🎁 Προσφορά: " + (redemption.offerTitle || ""),
      method: "admin-offer-verify", balanceBefore: before, balanceAfter: after },
    audit: { ..._auditBase("admin_verify_offer", redemption, customerId, ctx),
      amount: bonus, balanceBefore: before, balanceAfter: after },
  };
}

module.exports = { classifyRedemption, planRewardRedeem, planOfferRedeem };
