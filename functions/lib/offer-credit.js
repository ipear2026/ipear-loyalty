// ═══════════════════════════════════════════════════════════════════════════
//  SEC-H1 — Canonical offer-credit decision (pure, no Firebase deps, testable).
//
//  Used by approveRedemption (functions/index.js) for `offer_credit` requests.
//
//  THREAT: a customer creates ipear_offer_redemptions/{code} with a REAL
//  offerId but an inflated bonusPoints (rules only cap it at <=2500, they do
//  NOT bind it to the offer). Without server re-validation, approval would
//  credit the customer-chosen amount.
//
//  POLICY A — current offer value at approval time:
//    The credited amount is derived SOLELY from the authoritative ipear_offers
//    document that the approver re-reads inside the transaction. The customer-
//    supplied / request-captured value is treated as untrusted and must MATCH
//    the canonical value, otherwise the approval is rejected (fail-closed —
//    identical semantics to the card-source reward cost-drift check). This
//    matches the existing admin-client approval path (src/admin/approvals.js),
//    which already re-reads the offer doc as the trusted source, so no business
//    behavior changes — only the Cloud Function path is brought up to parity.
//
//  The client can never decide the amount: canonicalOfferCredit ignores the
//  request value except to reject a mismatch, and returns the server value.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object|null} offer  the ipear_offers doc data (null/undefined if missing)
 * @param {number} requestRewardCost  req.rewardCost (stored NEGATIVE for offer_credit)
 * @returns {{ok: boolean, canonicalBonus?: number, reason?: string}}
 */
/**
 * Canonical server-authoritative offer value (no request comparison). The ONE
 * source of truth for "what is this offer worth", shared by canonicalOfferCredit
 * (tablet approval, which also rejects a mismatched request value) and
 * adminVerifyRedemption (admin code verify, which has no client value to compare
 * — it simply credits the canonical amount). Keeping both on this helper means
 * there is a single canonical offer-value rule, not two.
 * @param {object|null} offer  the ipear_offers doc data
 * @returns {{ok:boolean, canonicalBonus?:number, reason?:string}}
 */
// ── Europe/Athens business-day semantics (DST-safe, no external deps) ────────
// Offer start/end dates are authored as date-only (YYYY-MM-DD) and represent a
// local Greek business day: an offer ending 2026-09-30 stays valid through the
// whole of 30/09 Athens and becomes expired at 00:00 Athens on 01/10. We never
// parse those date-only strings through UTC (which would expire them 2–3h early
// depending on DST). Instead we reduce both "now" and the boundary to an Athens
// calendar date (YYYY-MM-DD) and compare lexically — exact and DST-proof.
function athensDateStr(ms) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

// Normalize a stored offer date to an Athens calendar date string (YYYY-MM-DD),
// or null when absent/unparseable (treated as "no boundary"). Accepts a
// date-only string (used verbatim — it is already a calendar date), an ISO
// string, an epoch (s or ms), or a Firestore Timestamp.
function toAthensDateStr(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? athensDateStr(ms) : null;
  }
  if (typeof v === "number") {
    return Number.isFinite(v) ? athensDateStr(v > 1e12 ? v : v * 1000) : null;
  }
  if (v && typeof v.toDate === "function") {
    try { return athensDateStr(v.toDate().getTime()); } catch (_) { return null; }
  }
  if (v && typeof v.toMillis === "function") {
    try { return athensDateStr(v.toMillis()); } catch (_) { return null; }
  }
  return null;
}

// Authoritative runtime status for an offer. Separates the configured `active`
// toggle from the effective, date-aware status. Pure.
//   returns 'inactive' | 'scheduled' | 'expired' | 'active'
function offerRuntimeStatus(offer, nowMs) {
  if (!offer || typeof offer !== "object" || offer.active !== true) return "inactive";
  const today = athensDateStr(typeof nowMs === "number" ? nowMs : Date.now());
  const start = toAthensDateStr(offer.startDate);
  const end = toAthensDateStr(offer.endDate);
  if (start && today < start) return "scheduled";
  if (end && today > end) return "expired";
  return "active";
}

function canonicalOfferValue(offer, nowMs) {
  if (!offer || typeof offer !== "object") {
    return { ok: false, reason: "offer-missing" };
  }
  // Eligibility — date-aware authoritative status, not just the stored toggle.
  // An expired or not-yet-started offer is NEVER creditable even with
  // active === true (fail-closed, Europe/Athens business-day boundaries).
  const status = offerRuntimeStatus(offer, nowMs);
  if (status !== "active") {
    return {
      ok: false,
      reason: status === "expired" ? "offer-expired"
        : status === "scheduled" ? "offer-scheduled"
          : "offer-ineligible",
    };
  }
  const raw = offer.bonusPoints != null ? offer.bonusPoints : offer.pointsCost;
  const canonical = Math.floor(Number(raw));
  if (!Number.isInteger(canonical) || canonical <= 0) {
    return { ok: false, reason: "invalid-canonical" };
  }
  return { ok: true, canonicalBonus: canonical };
}

function canonicalOfferCredit(offer, requestRewardCost, nowMs) {
  const v = canonicalOfferValue(offer, nowMs);
  if (!v.ok) return v; // offer-missing / offer-expired / offer-scheduled / offer-ineligible / invalid-canonical
  const canonical = v.canonicalBonus;
  // request stores the credit as a NEGATIVE rewardCost.
  const requested = -Number(requestRewardCost);
  if (!Number.isFinite(requested) || requested !== canonical) {
    // Tampered (customer inflated bonusPoints) OR offer edited since the scan.
    // Fail closed — the request must be re-created against the current offer.
    return { ok: false, reason: "value-mismatch", canonicalBonus: canonical };
  }
  return { ok: true, canonicalBonus: canonical };
}

module.exports = {
  canonicalOfferCredit,
  canonicalOfferValue,
  offerRuntimeStatus,
  athensDateStr,
  toAthensDateStr,
};
