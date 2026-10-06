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
function canonicalOfferValue(offer) {
  if (!offer || typeof offer !== "object") {
    return { ok: false, reason: "offer-missing" };
  }
  // Eligibility — parity with the admin-client approval path (active === true).
  if (offer.active !== true) {
    return { ok: false, reason: "offer-ineligible" };
  }
  const raw = offer.bonusPoints != null ? offer.bonusPoints : offer.pointsCost;
  const canonical = Math.floor(Number(raw));
  if (!Number.isInteger(canonical) || canonical <= 0) {
    return { ok: false, reason: "invalid-canonical" };
  }
  return { ok: true, canonicalBonus: canonical };
}

function canonicalOfferCredit(offer, requestRewardCost) {
  const v = canonicalOfferValue(offer);
  if (!v.ok) return v; // offer-missing / offer-ineligible / invalid-canonical
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

module.exports = { canonicalOfferCredit, canonicalOfferValue };
