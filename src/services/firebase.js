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

// Pure SDK functions (no init needed — safe to re-export directly).
export {
  collection, addDoc, setDoc, updateDoc, deleteDoc,
  doc, getDoc, getDocs, query, where, orderBy, limit,
  onSnapshot, runTransaction,
  getCountFromServer, getAggregateFromServer, sum, average,
} from 'firebase/firestore';

export {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  deleteUser,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  linkWithCredential,
  EmailAuthProvider,
} from 'firebase/auth';

// ── Live bindings to the singletons created by firebase-init.js ──
// Cannot use top-level `export const db = window._db;` because firebase-init.js
// may not have finished initializing when this module is first evaluated.
// Getter functions defer the read to call-time.

/** Get the initialized Firestore instance. Throws if Firebase not yet ready. */
export function getDb() {
  if (!window._db) throw new Error('[services/firebase] Firestore not initialized — wait for "firebase-ready" event');
  return window._db;
}

/** Get the initialized Auth instance. Throws if Firebase not yet ready. */
export function getAuth() {
  if (!window._auth) throw new Error('[services/firebase] Auth not initialized — wait for "firebase-ready" event');
  return window._auth;
}

/** True once firebase-init.js has finished initialization. */
export function isReady() {
  return !!window._firebaseReady;
}

// ── Auth convenience wrappers (bind the singleton auth) ──────────

export function signIn(email, password) {
  return window._signIn(getAuth(), email, password);
}

export function signOut() {
  return window._signOut();
}

export function createUser(email, password) {
  return window._createUser(getAuth(), email, password);
}

export function sendPasswordReset(email) {
  return window._sendPassReset(getAuth(), email);
}

export function sendEmailVerif(user) {
  return window._sendEmailVerif(user);
}

export function deleteAuthUser(user) {
  return window._deleteAuthUser(user);
}

export function setPersistenceMode(mode) {
  return window._setPersistenceMode(mode);
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
      if (docSnap.exists()) found = { id: docSnap.id, ...docSnap.data() };
    } catch (e) { noteError('uid-doc', e); }

    if (!found) {
      try {
        const uidSnap = await window._getDocs(
          window._query(window._col(window._db, 'ipear_customers'), window._where('uid', '==', authUid))
        );
        uidSnap.forEach(d => { if (!found) found = { id: d.id, ...d.data() }; });
      } catch (e) { noteError('uid-field', e); }
    }
  }

  if (!found && email) {
    try {
      const snap = await window._getDocs(
        window._query(window._col(window._db, 'ipear_customers'), window._where('email', '==', email))
      );
      snap.forEach(d => { if (!found) found = { id: d.id, ...d.data() }; });
    } catch (e) { noteError('email', e); }
  }

  return { customer: found, error: found ? null : transientError };
}
