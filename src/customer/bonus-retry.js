// ═══════════════════════════════════════════════════════════════════════════
//  Pure retry-gate for post-signup bonuses — no deps, unit-testable.
//  Used by _retryPendingBonuses (src/main.js) on every login.
//
//  This is the CLIENT half of the exactly-once bonus guarantee. Re-firing the
//  worker endpoints is always safe (they are idempotent server-side via the
//  marketingWelcomeProcessed / referralProcessed markers + queue.processed),
//  but this gate prevents even ATTEMPTING a re-credit once the durable marker
//  has flipped — so a customer who has already been credited never re-triggers
//  the endpoints, and a customer whose initial credit failed DOES retry on the
//  next login.
//
//  Contract (must not change without a matching reward-logic review):
//   • welcome  needs (re)processing  ⇔ opted into marketing AND not yet flagged
//   • referral needs (re)processing  ⇔ has a referredBy code AND not yet flagged
// ═══════════════════════════════════════════════════════════════════════════
export function pendingBonuses(c) {
  const cust = c || {};
  const needsWelcome  = cust.marketingOptIn === true && cust.marketingWelcomeProcessed !== true;
  const needsReferral = !!cust.referredBy && cust.referralProcessed !== true;
  return { needsWelcome, needsReferral, any: needsWelcome || needsReferral };
}
