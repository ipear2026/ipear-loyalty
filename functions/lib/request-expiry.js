"use strict";
// ───────────────────────────────────────────────────────────────────────────
//  EXPIRY REMEDIATION — pure planner for deterministic, idempotent expiry of
//  stale PENDING redemption *requests* (ipear_redemption_requests).
//
//  INVARIANT: this module NEVER mutates financial state. It only transitions a
//  request's status "pending" -> "expired" once that request's own deadline has
//  passed. Terminal statuses (approved/rejected/expired/used/cancelled) are
//  untouched, so the cleanup is idempotent — re-running it is a no-op on
//  anything already resolved. It mirrors approveRedemption's own TTL guard, so
//  cleanup and approval can never disagree about whether a request is expired.
//
//  Pure + dependency-free → unit-testable without the emulator.
// ───────────────────────────────────────────────────────────────────────────

// Authoritative deadline in ms. Prefers the Firestore Timestamp (expiresAtTs),
// falling back to the ISO string (expiresAt) — the same precedence
// approveRedemption uses. Accepts the admin-SDK Timestamp (toDate) and the
// REST/{_seconds|seconds} shapes so the planner works in tests and in prod.
function requestDeadlineMs(req) {
  if (!req) return NaN;
  const ts = req.expiresAtTs;
  if (ts && typeof ts.toDate === "function") {
    const d = ts.toDate();
    if (d && Number.isFinite(d.getTime())) return d.getTime();
  }
  if (ts && typeof ts._seconds === "number") return ts._seconds * 1000;
  if (ts && typeof ts.seconds === "number") return Number(ts.seconds) * 1000;
  if (req.expiresAt) {
    const t = Date.parse(req.expiresAt);
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}

// Decide whether ONE request should be expired by the cleanup job.
//   - Only 'pending' requests are eligible; terminal states are skipped.
//   - Expire ONLY when a FINITE deadline exists AND now > deadline.
//   - Conservative: a pending request with no parseable deadline is NOT
//     auto-expired here — it is left to approval-time guards (which already
//     fail-closed). This stops cleanup from nuking malformed docs.
function planRequestExpiry(req, nowMs) {
  if (!req) return { expire: false, reason: "no-doc" };
  if (req.status !== "pending") return { expire: false, reason: "not-pending:" + String(req.status) };
  const dl = requestDeadlineMs(req);
  if (!Number.isFinite(dl)) return { expire: false, reason: "no-deadline" };
  if (nowMs > dl) return { expire: true, reason: "past-deadline" };
  return { expire: false, reason: "still-live" };
}

// The ONLY field-level mutation cleanup performs. Non-financial by construction
// — contains no points/totalPoints/amount/ledger keys.
function expiryUpdate(nowIso) {
  return {
    status: "expired",
    processedAt: nowIso,
    expiredBy: "cleanup-scheduler",
    cleanupReason: "ttl-elapsed",
  };
}

module.exports = { requestDeadlineMs, planRequestExpiry, expiryUpdate };
