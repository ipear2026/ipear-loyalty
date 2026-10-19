// ═══════════════════════════════════════════════════════════════════════════
//  iPear Loyalty — Firebase Services (canonical SDK exports)
//
//  Why this file exists:
//    Until P1, modules talked to Firebase via `window._db`, `window._signIn`,
//    `window._getDocs`, etc. — set by firebase-init.js on boot. That made
//    modules implicitly depend on a global namespace, untestable in isolation,
//    and impossible to tree-shake.
//
//    This module re-exports the same SDK surface as a typed import API.
//    `db` and `auth` are exposed as getters that read the live values set
//    by firebase-init.js so legacy bootstrap order keeps working.
//
//  Migration policy:
//    NEW code must import from here. Legacy code keeps using window._*
//    until incrementally migrated. firebase-init.js still sets the globals
//    for backwards compat.
// ═══════════════════════════════════════════════════════════════════════════

// Pure SDK re-exports — only the symbols currently used by admin modules.
// If you need another Firestore/Auth symbol, prefer a direct import from
// 'firebase/firestore' or 'firebase/auth' instead of expanding this list.
export {
  collection, doc, setDoc, deleteDoc,
  getDocs, query, where,
  onSnapshot, runTransaction,
} from 'firebase/firestore';

/** Get the initialized Firebase Auth instance. Throws if Firebase not yet ready. */
export function getAuth() {
  if (!window._auth) throw new Error('[services/firebase] Auth not initialized — wait for "firebase-ready" event');
  return window._auth;
}

/** Get the initialized Firestore instance. Throws if Firebase not yet ready. */
export function getDb() {
  if (!window._db) throw new Error('[services/firebase] Firestore not initialized — wait for "firebase-ready" event');
  return window._db;
}

// ── Customer lookup ladder (HIGH-1 / SMS-only compatible) ───────────
//
// Resolution order:
//   1. doc(ipear_customers/{uid})                  — new uid-keyed docs
//   2. query where uid == authUid                  — uid-field-only migrated
//   3. query where email == email                  — legacy email-keyed
//
// Returns `{ customer, error }`:
//   • customer    — the customer doc if any branch hit, else null
//   • error       — `null` if every read succeeded (including "succeeded
//                   but empty") OR if all failures were `permission-denied`
//                   (which Firestore returns for queries that no longer
//                   have any matching docs the caller can read — the
//                   semantic equivalent of "not found" for our flow).
//                   A non-null error means a TRANSIENT failure (network,
//                   App Check, Firestore unavailable) — caller should
//                   surface a "connection error" UI instead of "no account".
//
// Why permission-denied is treated as "not found":
//   After account deletion the customer's Firestore docs are gone, so
//   the email-where query has no matching docs. Firestore rejects the
//   query entirely (rather than returning empty) because the rule's
//   isVerifiedAuth() branch cannot be satisfied for a missing resource.
//   Conflating that with a network error sends users into a confusing
//   "App Check problem" message when their account simply does not
//   exist. Treating it as not-found is the correct UX.
// ═══════════════════════════════════════════════════════════════════════════
//  HIGH-1 (Pen-Test 2026-06-24): Customer-app field whitelist
//
//  The customer doc rule allows the owner to read their own document, but
//  Firestore can't project fields server-side — the entire doc reaches the
//  client. We can't hide it from the Network tab (architectural fix tracked
//  for Sprint 4 = split customer / customer_internal collections), but we
//  CAN keep the admin-only fields out of in-app state + localStorage so
//  they're not surfaced via DevTools Console / Application tabs.
//
//  Excluded fields (deliberately NOT in the whitelist):
//   • suspicious        — fraud watchlist flag set by admin. Leaking this
//                         to the customer defeats the entire feature.
//   • _migratedFrom     — internal data-model metadata (legacy doc id).
//   • registeredStoreId — which store onboarded the customer. Will become
//   • registeredStoreName intelligence once iPear adds more stores.
//
//  ⚠️ MAINTENANCE: when the Worker (email-worker.js) adds a NEW server-set
//      flag to ipear_customers that the CUSTOMER APP reads to gate a retry
//      (e.g. "send X if Y is not set"), that flag MUST be added here. Missing
//      a flag turns into a per-login spam loop because the client sees
//      `undefined !== true` and re-fires. See the 2026-06-25 regression:
//      marketingWelcomeProcessed was missed → welcome-email per login.
//      Reference _retryPendingBonuses in src/main.js for the pattern.
//
//  Kept (customer needs them for UI):
//   • Identity / profile (name, phone, email, card, uid, birthday)
//   • Financial state   (points, totalPoints, tier, lastTierCheck)
//   • Consent           (marketingOptIn*, termsAcceptedAt)
//   • Lifecycle flags   (blocked, deletionRequested*, eshopCouponUsed,
//                        referralCount, referralProcessed, createdAt)
// ═══════════════════════════════════════════════════════════════════════════
const _CUSTOMER_SAFE_FIELDS = [
  'name', 'phone', 'email', 'card', 'uid',
  'points', 'totalPoints', 'tier', 'lastTierCheck',
  'birthday', 'blocked', 'createdAt',
  'referralCount', 'referralProcessed', 'eshopCouponUsed',
  'marketingOptIn', 'marketingOptInAt', 'termsAcceptedAt',
  // marketingWelcomeProcessed / marketingWelcomeAt are owned by the Worker
  // (set inside /send-welcome's atomic transaction) but the customer client
  // MUST be able to read them — _retryPendingBonuses gates the
  // /send-welcome retry on the customer-app side using these flags. Leaving
  // them out of the whitelist caused a welcome-email spam loop: client
  // saw `undefined !== true`, retried, worker skipped the bonus credit but
  // still sent the email. (Pen-Test regression fix, 2026-06-25.)
  'marketingWelcomeProcessed', 'marketingWelcomeAt',
  'notificationsEnabled', 'deletionRequested', 'deletionRequestedAt',
];

function _pickCustomerFields(raw) {
  const out = {};
  for (const k of _CUSTOMER_SAFE_FIELDS) {
    if (k in raw) out[k] = raw[k];
  }
  return out;
}

export async function findCustomerByAuth(authUid, email, { logger } = {}) {
  const _log = logger || { warn: () => {} };
  let found = null;
  let transientError = null;

  function noteError(label, e) {
    const code = e?.code || null;
    _log.warn(`[findCustomerByAuth] ${label} failed:`, code || e?.message || e);
    // permission-denied = the caller has no claim to read this collection
    // for this query shape — semantically "no account exists for me",
    // not a network/App Check problem. Do not bubble it up as transient.
    if (code === 'permission-denied') return;
    transientError = { label, code, message: e?.message || String(e) };
  }

  if (authUid) {
    try {
      const docSnap = await window._getDoc(window._doc(window._db, 'ipear_customers', authUid));
      if (docSnap.exists()) found = { id: docSnap.id, ..._pickCustomerFields(docSnap.data()) };
    } catch (e) { noteError('uid-doc', e); }

    if (!found) {
      try {
        const uidSnap = await window._getDocs(
          window._query(window._col(window._db, 'ipear_customers'), window._where('uid', '==', authUid))
        );
        uidSnap.forEach(d => { if (!found) found = { id: d.id, ..._pickCustomerFields(d.data()) }; });
      } catch (e) { noteError('uid-field', e); }
    }
  }

  if (!found && email) {
    try {
      const snap = await window._getDocs(
        window._query(window._col(window._db, 'ipear_customers'), window._where('email', '==', email))
      );
      snap.forEach(d => { if (!found) found = { id: d.id, ..._pickCustomerFields(d.data()) }; });
    } catch (e) { noteError('email', e); }
  }

  return { customer: found, error: found ? null : transientError };
}
