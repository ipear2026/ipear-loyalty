// ═══════════════════════════════════════════════════════════════════════════
//  L2.3A · Admin approval-queue client wrapper (callable Cloud Functions).
//
//  The admin UI reads the pending queue directly via Firestore (allowed by
//  the L2.3A rules — admin claim reads any request) and calls these two
//  wrappers to approve or reject.
//
//  Under the L2.3A rules, admin clients CANNOT write ipear_redemption_requests
//  directly — only the callable Cloud Functions (admin SDK) can. This module
//  is the only supported approve/reject path.
//
//  Wiring: src/admin/approvals.js (existing file) should render the queue
//  and delegate approve/reject to the functions below.
// ═══════════════════════════════════════════════════════════════════════════
import {
  collection, query, where, orderBy, limit, onSnapshot,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { logger } from '../logger.js';

// L2.3A callables are deployed to `europe-west1`. Firebase JS SDK defaults
// to `us-central1`; the explicit region argument avoids a 404 → `internal`
// surface. Keep in sync with `region:` in functions/index.js.
const CALLABLE_REGION = 'europe-west1';
function _fns() {
  return getFunctions(window._firebaseApp || undefined, CALLABLE_REGION);
}

// subscribeToPendingQueue({storeId, onChange, max=50})
//   Live listener over ipear_redemption_requests where status=='pending'.
//   Optionally scoped to a storeId (single-store admins).
//   onChange receives an array of request snapshots (already sorted by
//   requestedAtTs asc — oldest first is the fairest queue order).
export function subscribeToPendingQueue({ storeId, onChange, max = 50 }) {
  const db = window._db;
  if (!db) throw new Error('firebase-init not ready');
  const col = collection(db, 'ipear_redemption_requests');
  let q = query(col, where('status', '==', 'pending'));
  if (storeId) q = query(q, where('storeId', '==', storeId));
  q = query(q, orderBy('requestedAtTs', 'asc'), limit(max));
  return onSnapshot(
    q,
    (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
      onChange(rows);
    },
    (err) => {
      logger.warn('[approval-queue] snapshot error:', err?.code || err?.message);
      onChange([], err);
    }
  );
}

// approveRedemption(requestId)
//   Server-side atomic + idempotent approval. Returns:
//     { alreadyProcessed: false, status: 'approved', newPoints, ledgerId }
//     | { alreadyProcessed: true,  status: 'approved' | 'rejected' | 'expired' }
//     | { alreadyProcessed: false, status: 'expired' }
//   Throws on: unauthenticated / permission-denied (not-admin) /
//   invalid-argument (bad requestId) / not-found /
//   failed-precondition (customer blocked, insufficient balance, etc.).
export async function approveRedemption(requestId) {
  const fn = httpsCallable(_fns(), 'approveRedemption');
  const res = await fn({ requestId });
  return res.data;
}

// rejectRedemption(requestId, reason)
//   Server-side idempotent rejection. Returns:
//     { alreadyProcessed: false, status: 'rejected' }
//     | { alreadyProcessed: true, status: <terminal state> }
export async function rejectRedemption(requestId, reason) {
  const fn = httpsCallable(_fns(), 'rejectRedemption');
  const res = await fn({ requestId, reason: String(reason || '').slice(0, 200) });
  return res.data;
}
