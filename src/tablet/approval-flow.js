// ═══════════════════════════════════════════════════════════════════════════
//  L2.3A · Tablet approval-flow client wrapper (callable Cloud Functions).
//
//  The tablet client MUST use these wrappers instead of hitting Firestore
//  directly. Under the L2.3A rules, direct customer/redemption/audit reads
//  and writes from a tablet token are DENIED — the four callables below are
//  the only path.
//
//  Wiring: tablet-main.js should replace its current `handleRedeemQR` /
//  `handleOfferQR` / `doSearch` / `searchByCard` / `confirmQRRedeem` /
//  `confirmTabletRedeem` bodies with calls into these functions and stop
//  running `runTransaction` on ipear_customers / ipear_redemptions entirely.
//  See docs/L2.3A-APPROVAL-FLOW.md (planned) for the swap map.
//
//  Every callable requires Firebase Auth AND App Check — enforced server-side
//  by `enforceAppCheck: true` on the CF definition. The client SDK attaches
//  the App Check token automatically.
// ═══════════════════════════════════════════════════════════════════════════
import { getFunctions, httpsCallable } from 'firebase/functions';
import { doc, onSnapshot } from 'firebase/firestore';
import { logger } from '../logger.js';

// L2.3A callables are deployed to `europe-west1`. The Firebase JS Functions
// SDK defaults to `us-central1`; without the explicit region argument every
// call goes to a URL that returns 404, and the SDK reports `code:"internal"`.
// Keep this region string in sync with `region:` in functions/index.js.
const CALLABLE_REGION = 'europe-west1';
function _fns() {
  return getFunctions(window._firebaseApp || undefined, CALLABLE_REGION);
}

// createRedemptionRequest(code)
//   Server-side lookup + pending request creation. Returns:
//     {
//       requestId,          // string, opaque — use to subscribe below
//       alreadyPending,     // boolean, true = we returned an existing request
//       type,               // 'redeem' | 'offer_credit'
//       projection,         // masked customer projection (see docs)
//       rewardLabel,        // string
//       rewardCost,         // positive for redeem, negative for offer_credit
//       expiresAt,          // ISO string
//     }
//   Throws on: unauthenticated / permission-denied (not-tablet) /
//   invalid-argument (bad code shape) / not-found (unknown code) /
//   failed-precondition (used, cancelled, expired, blocked customer,
//   insufficient balance) / resource-exhausted (rate-limited).
export async function createRedemptionRequest(code) {
  const fn = httpsCallable(_fns(), 'createRedemptionRequest');
  const res = await fn({ code });
  return res.data;
}

// lookupCustomerForTablet(query)
//   Exact-match lookup by card ('IP-XXXXXX') or phone (7+ digits). Returns:
//     { found: false } | { found: true, blocked: true } |
//     { found: true, projection: {...} }
export async function lookupCustomerForTablet(query) {
  const fn = httpsCallable(_fns(), 'lookupCustomerForTablet');
  const res = await fn({ query });
  return res.data;
}

// L2.3A hotfix (2026-08-31) — customer loyalty-card QR support.

// lookupCustomerByCardQr(cardQrPayload)
//   The tablet scans the customer's permanent Card-tab QR (payload = the
//   card string, e.g. "IP-ABC123"). The server validates format, looks up
//   the customer, and returns the masked projection PLUS the active
//   rewards catalog (canonical cost + discount from ipear_rewards).
//   Returns:
//     { found: false }
//     | { found: true, blocked: true }
//     | { found: true, projection: {...}, rewards: [{id,title,cost,discount},...] }
export async function lookupCustomerByCardQr(cardQrPayload) {
  const fn = httpsCallable(_fns(), 'lookupCustomerByCardQr');
  const res = await fn({ cardQrPayload });
  return res.data;
}

// createRedemptionRequestFromCard({cardQrPayload, rewardId})
//   After lookup + reward pick, the tablet asks the server to create a
//   pending approval request. The tablet does NOT send the points cost —
//   only the rewardId. The server reads canonical cost from the reward doc.
//   Two rapid scans for the same (store, tablet, card, reward) return the
//   same requestId (deterministic idempotency).
export async function createRedemptionRequestFromCard({ cardQrPayload, rewardId }) {
  const fn = httpsCallable(_fns(), 'createRedemptionRequestFromCard');
  const res = await fn({ cardQrPayload, rewardId });
  return res.data;
}

// subscribeToRequest(requestId, onChange)
//   Live status listener for the tablet's own request document. The rules
//   allow the tablet to read only when tabletActorUid==self AND storeId==own
//   store, so this snapshot works only for the tablet that created the
//   request. Returns the unsubscribe function.
//
//   onChange receives one of:
//     { status: 'pending',    expiresAt, projection, rewardLabel, rewardCost }
//     { status: 'approved',   processedAt, newPoints, ledgerId }
//     { status: 'rejected',   processedAt, rejectReason }
//     { status: 'expired',    processedAt }
//     { status: 'missing' }   // doc deleted / not found
export function subscribeToRequest(requestId, onChange) {
  const db = window._db;
  if (!db) throw new Error('firebase-init not ready');
  const ref = doc(db, 'ipear_redemption_requests', requestId);
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        onChange({ status: 'missing' });
        return;
      }
      const data = snap.data();
      const evt = {
        status: data.status,
        expiresAt: data.expiresAt,
        rewardLabel: data.rewardLabel,
        rewardCost: data.rewardCost,
        processedAt: data.processedAt || null,
        rejectReason: data.rejectReason || null,
        newPoints: typeof data.newPoints === 'number' ? data.newPoints : null,
        ledgerId: data.ledgerId || null,
      };
      onChange(evt);
    },
    (err) => {
      logger.warn('[approval-flow] snapshot error:', err?.code || err?.message);
      // permission-denied on a document the tablet used to own = the CF
      // path was tampered with. Bubble as an 'error' status for the UI.
      onChange({ status: 'error', error: err?.code || err?.message || 'unknown' });
    }
  );
}
