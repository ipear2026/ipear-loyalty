// ═══════════════════════════════════════════════════════════════════════════
//  Shared snapshot cache — customer Firestore reads
//
//  loadStats, search, and the customers tab all want a recent customer
//  snapshot. Without a cache, every tab switch re-runs the same getDocs().
//  Stores the latest snapshot + timestamp; readers ask for it with a
//  max-age (e.g. 5s for search-as-you-type, 30s for the customers table).
// ═══════════════════════════════════════════════════════════════════════════

let _snap = null;
let _at = 0;

/** Return cached snapshot if it's fresher than maxAgeMs, else null. */
export function getCachedCustomers(maxAgeMs) {
  if (_snap && Date.now() - _at < maxAgeMs) return _snap;
  return null;
}

/** Replace the cache (called after a fresh read). */
export function setCachedCustomers(snap) {
  _snap = snap;
  _at = Date.now();
}

/** Drop the cache (call after writes that change customer set). */
export function invalidateCustomers() {
  _snap = null;
  _at = 0;
}
