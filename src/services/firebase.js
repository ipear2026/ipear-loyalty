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
//   • customer  — the customer doc if any branch hit, else null
//   • error     — the LAST transient failure observed, or null if every
//                 attempted read succeeded (including "succeeded but empty").
//
// Callers use the error/null distinction to show "σύνδεση απέτυχε" instead
// of a misleading "δεν βρέθηκε λογαριασμός" when App Check / network /
// Firestore is unreachable.
export async function findCustomerByAuth(authUid, email, { logger } = {}) {
  const _log = logger || { warn: () => {} };
  let found = null;
  let lastError = null;

  function noteError(label, e) {
    lastError = { label, code: e?.code || null, message: e?.message || String(e) };
    _log.warn(`[findCustomerByAuth] ${label} failed:`, lastError.code || lastError.message);
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

  return { customer: found, error: found ? null : lastError };
}
