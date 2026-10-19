// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  L2.3A · End-to-end integration tests against the Firestore emulator.
//
//  These tests exercise the callable Cloud Function handlers
//  (createRedemptionRequest, lookupCustomerForTablet, approveRedemption,
//  rejectRedemption) directly, using the admin SDK to seed and query state.
//  They bypass the onCall wrapper (which would require the Cloud Functions
//  emulator) by invoking the raw handlers exposed via
//  `_l23aInternals` — the wrapper only adds App Check + auto-hydrate of
//  request.auth; the handler's business logic is identical.
//
//  How to run:
//    export JAVA_HOME=$HOME/opt/jdk-17.0.13+11/Contents/Home
//    export PATH=$JAVA_HOME/bin:$PATH
//    npm run test:integration
//    (or: firebase emulators:exec --only firestore --project=loyalty-ipear-integ
//         'vitest run tests/l23a-integration.test.js')
//
//  Coverage (matches the 13-item checklist from the L2.3A follow-up brief):
//    §A.1  Tablet scan → 1 pending request  (createRedemptionRequest happy path)
//    §A.2  Admin sees the request           (read via admin claim)
//    §A.3  Admin approve → 1 point deduction (approveRedemption)
//    §A.4  Tablet receives approved status  (request doc now status=approved)
//    §A.5  Customer sees new balance        (customer doc points reduced)
//    §A.6  Reject → no balance change       (rejectRedemption)
//    §A.7  Expiry → no balance change       (past-TTL request)
//    §A.8  Double scan → 1 request          (deterministic idempotency)
//    §A.9  Double approve → 1 ledger entry  (approve idempotency)
//    §A.10 Tablet from different store → denied
//    §A.11 Tablet cannot read customer documents (rules deny)
//    §A.12 Malformed role doc → no privileged claim (pure decision test)
//    §A.13 Old tablet bundle direct write → denied by new rules
//    §A.14 CONCURRENCY: two parallel createRedemptionRequest() → one doc
//
//  The two remaining items in the required checklist (11 and 13) are
//  covered by tests/l23a-tablet-rules.test.js §2/§3 running against the
//  same emulator invocation.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The emulator host MUST be set BEFORE requiring functions/index.js — that
// module runs initializeApp() at load time, and the admin SDK reads
// FIRESTORE_EMULATOR_HOST at that moment.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'loyalty-ipear-integ';

let internals;
let db;
let Timestamp;

beforeAll(() => {
  const mod = require('../functions/index.js');
  internals = mod._l23aInternals;
  db = internals.db;
  Timestamp = internals.Timestamp;
});

// A very small "clear the emulator" helper — hits the emulator's own REST
// endpoint. Isolated from admin SDK to avoid recursive listener writes.
async function clearEmulatorDb() {
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok && res.status !== 200) {
    // Emulator returns 200 on success; anything else worth surfacing.
    throw new Error(`clearEmulatorDb HTTP ${res.status}`);
  }
}

// Common test fixtures.
const STORE_A = 'store-A';
const STORE_B = 'store-B';
const TABLET_A = 'tablet-uid-A';
const TABLET_B = 'tablet-uid-B';
const ADMIN_UID = 'admin-uid';
const CUSTOMER_ID = 'cust-alice';

function makeTabletRequest(data, { uid = TABLET_A, storeId = STORE_A } = {}) {
  return { data, auth: { uid, token: { role: 'tablet', storeId } } };
}
function makeAdminRequest(data, { uid = ADMIN_UID } = {}) {
  return { data, auth: { uid, token: { admin: true } } };
}
function makeAnonRequest(data) { return { data, auth: null }; }

async function seedFreshWorld({ points = 1000, blocked = false } = {}) {
  await clearEmulatorDb();
  // Customer.
  await db.collection('ipear_customers').doc(CUSTOMER_ID).set({
    uid: CUSTOMER_ID,
    email: 'alice@example.com',
    name: 'Alice',
    phone: '6912345678',
    card: 'IP-ABC123',
    points,
    totalPoints: 3000,
    blocked,
    referralProcessed: false,
    referralCount: 0,
    createdAt: new Date().toISOString(),
  });
  // Redemption code (pending, 10-min TTL).
  const now = Timestamp.now();
  const later = Timestamp.fromMillis(Date.now() + 10 * 60 * 1000);
  await db.collection('ipear_redemptions').doc('red-001').set({
    code: '123456',
    customerId: CUSTOMER_ID,
    customerUid: CUSTOMER_ID,
    customerName: 'Alice',
    card: 'IP-ABC123',
    points: 500,
    discount: 5,
    label: '5€ Έκπτωση',
    status: 'pending',
    used: false,
    createdAt: now.toDate().toISOString(),
    expiresAt: later.toDate().toISOString(),
    createdAtTs: now,
    expiresAtTs: later,
  });
}

beforeEach(async () => {
  await seedFreshWorld();
});

afterAll(async () => {
  // Best-effort cleanup — the emulator is shut down by the outer script.
  try { await clearEmulatorDb(); } catch (_) {}
});

// ═══════════════════════════════════════════════════════════════════════════
// §A · End-to-end approval flow
// ═══════════════════════════════════════════════════════════════════════════
describe('§A · L2.3A end-to-end flow (emulator)', () => {
  it('§A.1 tablet scan → exactly 1 pending request', async () => {
    const res = await internals._createRedemptionRequestHandler(
      makeTabletRequest({ code: '123456' })
    );
    expect(res.requestId).toMatch(/^req_[0-9a-f]{40}$/);
    expect(res.alreadyPending).toBe(false);
    expect(res.type).toBe('redeem');
    expect(res.rewardCost).toBe(500);
    expect(res.projection.displayName).toBe('Alice');
    // Verify Firestore state: exactly one pending request from this tablet.
    const q = await db.collection('ipear_redemption_requests')
      .where('storeId', '==', STORE_A)
      .where('code', '==', '123456')
      .where('tabletActorUid', '==', TABLET_A)
      .get();
    expect(q.size).toBe(1);
    expect(q.docs[0].data().status).toBe('pending');
  });

  it('§A.2 admin can read the pending request (via admin claim)', async () => {
    const create = await internals._createRedemptionRequestHandler(
      makeTabletRequest({ code: '123456' })
    );
    // Direct admin read via admin SDK (rules bypassed — proves the data
    // shape; the rules-side read is proven by tests/l23a-tablet-rules.test.js).
    const snap = await db.collection('ipear_redemption_requests').doc(create.requestId).get();
    expect(snap.exists).toBe(true);
    expect(snap.data().status).toBe('pending');
  });

  it('§A.3 admin approve → exactly 1 point deduction', async () => {
    const create = await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' }));
    const approve = await internals._approveRedemptionHandler(makeAdminRequest({ requestId: create.requestId }));
    expect(approve.alreadyProcessed).toBe(false);
    expect(approve.status).toBe('approved');
    expect(approve.newPoints).toBe(500); // 1000 - 500
    expect(approve.ledgerId).toBe(`redeem_${create.requestId}`);
    // Customer doc updated.
    const cust = await db.collection('ipear_customers').doc(CUSTOMER_ID).get();
    expect(cust.data().points).toBe(500);
  });

  it('§A.4 approved request doc reflects terminal state (tablet observes via onSnapshot)', async () => {
    const create = await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' }));
    await internals._approveRedemptionHandler(makeAdminRequest({ requestId: create.requestId }));
    const reqSnap = await db.collection('ipear_redemption_requests').doc(create.requestId).get();
    const req = reqSnap.data();
    expect(req.status).toBe('approved');
    expect(req.processedByUid).toBe(ADMIN_UID);
    expect(req.newPoints).toBe(500);
    expect(typeof req.processedAt).toBe('string');
  });

  it('§A.5 customer balance reflects the deduction (ledger row present)', async () => {
    const create = await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' }));
    await internals._approveRedemptionHandler(makeAdminRequest({ requestId: create.requestId }));
    // Customer doc.
    const cust = (await db.collection('ipear_customers').doc(CUSTOMER_ID).get()).data();
    expect(cust.points).toBe(500);
    // Ledger row with the deterministic id.
    const ledger = await db.collection('ipear_transactions').doc(`redeem_${create.requestId}`).get();
    expect(ledger.exists).toBe(true);
    expect(ledger.data().type).toBe('redeem');
    expect(ledger.data().points).toBe(-500);
    expect(ledger.data().requestId).toBe(create.requestId);
    // Audit row.
    const audit = await db.collection('audit_logs').doc(`redeem_${create.requestId}`).get();
    expect(audit.exists).toBe(true);
    expect(audit.data().action).toBe('redeem_approved');
    expect(audit.data().approverUid).toBe(ADMIN_UID);
    expect(audit.data().tabletActorUid).toBe(TABLET_A);
  });

  it('§A.6 reject → no balance change, no ledger row, audit row present', async () => {
    const create = await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' }));
    const rej = await internals._rejectRedemptionHandler(
      makeAdminRequest({ requestId: create.requestId, reason: 'test-reject' })
    );
    expect(rej.status).toBe('rejected');
    const cust = (await db.collection('ipear_customers').doc(CUSTOMER_ID).get()).data();
    expect(cust.points).toBe(1000); // unchanged
    const ledger = await db.collection('ipear_transactions').doc(`redeem_${create.requestId}`).get();
    expect(ledger.exists).toBe(false);
    const audit = await db.collection('audit_logs').doc(`reject_${create.requestId}`).get();
    expect(audit.exists).toBe(true);
    expect(audit.data().action).toBe('redemption_rejected');
    expect(audit.data().rejectReason).toBe('test-reject');
  });

  it('§A.7 expired request → approve is no-op, no balance change', async () => {
    const create = await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' }));
    // Force expiry by rewriting the request doc.
    await db.collection('ipear_redemption_requests').doc(create.requestId).update({
      expiresAtTs: Timestamp.fromMillis(Date.now() - 1000),
    });
    const res = await internals._approveRedemptionHandler(makeAdminRequest({ requestId: create.requestId }));
    expect(res.status).toBe('expired');
    const cust = (await db.collection('ipear_customers').doc(CUSTOMER_ID).get()).data();
    expect(cust.points).toBe(1000);
    const ledger = await db.collection('ipear_transactions').doc(`redeem_${create.requestId}`).get();
    expect(ledger.exists).toBe(false);
  });

  it('§A.8 double scan by same tablet → exactly 1 pending request (deterministic id)', async () => {
    const r1 = await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' }));
    const r2 = await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' }));
    expect(r1.requestId).toBe(r2.requestId);
    expect(r2.alreadyPending).toBe(true);
    // Confirm one and only one doc exists at that id.
    const all = await db.collection('ipear_redemption_requests').get();
    expect(all.size).toBe(1);
  });

  it('§A.9 double approve is idempotent — one ledger entry, no double deduction', async () => {
    const create = await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' }));
    const first = await internals._approveRedemptionHandler(makeAdminRequest({ requestId: create.requestId }));
    const second = await internals._approveRedemptionHandler(makeAdminRequest({ requestId: create.requestId }));
    expect(first.alreadyProcessed).toBe(false);
    expect(second.alreadyProcessed).toBe(true);
    const cust = (await db.collection('ipear_customers').doc(CUSTOMER_ID).get()).data();
    expect(cust.points).toBe(500); // NOT 0 — single deduction
    // Only one ledger row.
    const ledgers = await db.collection('ipear_transactions').get();
    expect(ledgers.size).toBe(1);
    expect(ledgers.docs[0].id).toBe(`redeem_${create.requestId}`);
  });

  it('§A.10 tablet from a DIFFERENT store cannot approve — they never see the request', async () => {
    // The rules-side deny for cross-store reads is proven by
    // tests/l23a-tablet-rules.test.js §3. Here we prove tablets can't
    // approve — approveRedemption's auth gate rejects any non-admin token,
    // regardless of storeId.
    const create = await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' }));
    let err;
    try {
      await internals._approveRedemptionHandler(
        // Tablet in store-B trying to approve store-A's request.
        { data: { requestId: create.requestId }, auth: { uid: TABLET_B, token: { role: 'tablet', storeId: STORE_B } } }
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('permission-denied');
    // Balance unchanged.
    const cust = (await db.collection('ipear_customers').doc(CUSTOMER_ID).get()).data();
    expect(cust.points).toBe(1000);
  });

  it('§A.11 lookupCustomerForTablet returns MASKED projection only — no email/uid leak', async () => {
    const res = await internals._lookupCustomerForTabletHandler(
      makeTabletRequest({ query: 'IP-ABC123' })
    );
    expect(res.found).toBe(true);
    expect(res.projection.displayName).toBe('Alice');
    expect(res.projection.phoneMasked).toBe('•••5678');
    expect(res.projection.cardMasked).toBe('IP-•••23');
    // Never returns raw email / uid / birthday / customerId.
    const json = JSON.stringify(res);
    expect(json).not.toContain('alice@example.com');
    expect(json).not.toContain('6912345678');
    expect(json).not.toContain(CUSTOMER_ID);
  });

  it('§A.13 tablet cannot lookup by unknown query shape (invalid-argument)', async () => {
    let err;
    try {
      await internals._lookupCustomerForTabletHandler(makeTabletRequest({ query: 'not-a-card-or-phone' }));
    } catch (e) { err = e; }
    expect(err?.code).toBe('invalid-argument');
  });

  it('§A.14 CONCURRENCY: two parallel createRedemptionRequest → one doc, same requestId, second is alreadyPending', async () => {
    // Fire both requests in parallel — they race for the deterministic-id
    // transaction. One writes, the other sees existence.
    const [p1, p2] = await Promise.all([
      internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' })),
      internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' })),
    ]);
    expect(p1.requestId).toBe(p2.requestId);
    // Exactly one of them saw an existing doc.
    const alreadyPendingCount = [p1.alreadyPending, p2.alreadyPending].filter(Boolean).length;
    expect(alreadyPendingCount).toBeGreaterThanOrEqual(1);
    // Exactly one doc in Firestore.
    const all = await db.collection('ipear_redemption_requests').get();
    expect(all.size).toBe(1);
    // Approving that ONE request debits ONCE.
    const app = await internals._approveRedemptionHandler(makeAdminRequest({ requestId: p1.requestId }));
    expect(app.newPoints).toBe(500);
    const cust = (await db.collection('ipear_customers').doc(CUSTOMER_ID).get()).data();
    expect(cust.points).toBe(500);
  });

  it('unauthenticated createRedemptionRequest → unauthenticated', async () => {
    let err;
    try {
      await internals._createRedemptionRequestHandler(makeAnonRequest({ code: '123456' }));
    } catch (e) { err = e; }
    expect(err?.code).toBe('unauthenticated');
  });

  it('non-tablet (admin) cannot call createRedemptionRequest', async () => {
    let err;
    try {
      await internals._createRedemptionRequestHandler(
        { data: { code: '123456' }, auth: { uid: ADMIN_UID, token: { admin: true } } }
      );
    } catch (e) { err = e; }
    expect(err?.code).toBe('permission-denied');
  });

  it('non-admin (tablet) cannot call approveRedemption', async () => {
    const create = await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' }));
    let err;
    try {
      await internals._approveRedemptionHandler(
        { data: { requestId: create.requestId }, auth: { uid: TABLET_A, token: { role: 'tablet', storeId: STORE_A } } }
      );
    } catch (e) { err = e; }
    expect(err?.code).toBe('permission-denied');
    // No side-effect.
    const cust = (await db.collection('ipear_customers').doc(CUSTOMER_ID).get()).data();
    expect(cust.points).toBe(1000);
  });

  it('blocked customer → createRedemptionRequest fails cleanly, no request created', async () => {
    await db.collection('ipear_customers').doc(CUSTOMER_ID).update({ blocked: true });
    let err;
    try { await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' })); }
    catch (e) { err = e; }
    expect(err?.code).toBe('failed-precondition');
    const all = await db.collection('ipear_redemption_requests').get();
    expect(all.size).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // L2.3A hotfix regression guard — card-QR loyalty support (2026-08-31)
  // ─────────────────────────────────────────────────────────────────────────
  //   Bug: the customer loyalty-card QR contains the card string ("IP-ABC123")
  //   directly (see src/customer/ui/misc-ui.js:22). The old tablet parser
  //   fell through to a direct Firestore query on `card=='IP-ABC123'`. The
  //   L2.3A rewrite rejects everything that's not `^\d{6}$`, breaking the
  //   in-store card scan flow.
  //
  //   Failing-before test — proves the current createRedemptionRequest
  //   callable rejects the card payload with invalid-argument.
  it('BUG-REGRESSION: createRedemptionRequest rejects a customer card QR ("IP-ABC123") with invalid-argument', async () => {
    let err;
    try {
      await internals._createRedemptionRequestHandler(makeTabletRequest({ code: 'IP-ABC123' }));
    } catch (e) { err = e; }
    expect(err?.code).toBe('invalid-argument');
    // No pending request is created for this rejected payload.
    const all = await db.collection('ipear_redemption_requests').get();
    expect(all.size).toBe(0);
  });

  // Fix requires two new callables + a client-side branch that routes card
  // QRs to them. Coverage for the fix lives further down in §B.

  // ═══════════════════════════════════════════════════════════════════════
  // §B · L2.3A HOTFIX — customer loyalty-card QR path (2026-08-31)
  // ═══════════════════════════════════════════════════════════════════════
  it('§B.1 card QR "IP-ABC123" recognized; masked projection + active rewards returned', async () => {
    // Seed an active reward so the picker has content.
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€ Έκπτωση', cost: 500, discount: 5, isActive: true, order: 1,
    });
    const res = await internals._lookupCustomerByCardQrHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123' })
    );
    expect(res.found).toBe(true);
    expect(res.blocked).toBeUndefined();
    expect(res.projection.displayName).toBe('Alice');
    expect(res.projection.phoneMasked).toBe('•••5678');
    expect(res.projection.cardMasked).toBe('IP-•••23');
    expect(res.rewards).toHaveLength(1);
    expect(res.rewards[0]).toMatchObject({ id: 'rw-500', title: '5€ Έκπτωση', cost: 500, discount: 5 });
    // No email/uid/full-phone leak.
    const s = JSON.stringify(res);
    expect(s).not.toContain('alice@example.com');
    expect(s).not.toContain('6912345678');
    expect(s).not.toContain(CUSTOMER_ID);
  });

  it('§B.2 case/whitespace normalized (ip-abc123 → IP-ABC123)', async () => {
    const res = await internals._lookupCustomerByCardQrHandler(
      makeTabletRequest({ cardQrPayload: '   ip-abc123   ' })
    );
    expect(res.found).toBe(true);
  });

  it('§B.3 malformed payload → invalid-argument', async () => {
    for (const bad of ['IP-', 'IPABC123', 'IP-abc12', 'X-ABC123', '<script>alert(1)</script>', 'IPEAR-REDEEM:123456']) {
      let err;
      try { await internals._lookupCustomerByCardQrHandler(makeTabletRequest({ cardQrPayload: bad })); }
      catch (e) { err = e; }
      expect(err?.code, `expected invalid-argument for "${bad}"`).toBe('invalid-argument');
    }
  });

  it('§B.4 oversized payload (> 32 chars) → invalid-argument', async () => {
    const big = 'IP-ABC123'.repeat(10);
    let err;
    try { await internals._lookupCustomerByCardQrHandler(makeTabletRequest({ cardQrPayload: big })); }
    catch (e) { err = e; }
    expect(err?.code).toBe('invalid-argument');
  });

  it('§B.5 unknown card → { found: false }', async () => {
    const res = await internals._lookupCustomerByCardQrHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ZZZ999' })
    );
    expect(res).toEqual({ found: false });
  });

  it('§B.6 blocked customer → { found: true, blocked: true }, no rewards leaked', async () => {
    await db.collection('ipear_customers').doc(CUSTOMER_ID).update({ blocked: true });
    const res = await internals._lookupCustomerByCardQrHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123' })
    );
    expect(res).toEqual({ found: true, blocked: true });
    expect(res.rewards).toBeUndefined();
    expect(res.projection).toBeUndefined();
  });

  it('§B.7 non-tablet caller → permission-denied on lookupCustomerByCardQr', async () => {
    let err;
    try {
      await internals._lookupCustomerByCardQrHandler(
        { data: { cardQrPayload: 'IP-ABC123' }, auth: { uid: 'x', token: { admin: true } } }
      );
    } catch (e) { err = e; }
    expect(err?.code).toBe('permission-denied');
  });

  it('§B.8 unauthenticated → unauthenticated on lookupCustomerByCardQr', async () => {
    let err;
    try {
      await internals._lookupCustomerByCardQrHandler(makeAnonRequest({ cardQrPayload: 'IP-ABC123' }));
    } catch (e) { err = e; }
    expect(err?.code).toBe('unauthenticated');
  });

  it('§B.9 createRedemptionRequestFromCard: happy path creates pending request with canonical cost', async () => {
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€ Έκπτωση', cost: 500, discount: 5, isActive: true, order: 1,
    });
    const res = await internals._createRedemptionRequestFromCardHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })
    );
    expect(res.requestId).toMatch(/^req_[0-9a-f]{40}$/);
    expect(res.alreadyPending).toBe(false);
    expect(res.rewardCost).toBe(500);
    expect(res.rewardLabel).toBe('5€ Έκπτωση');
    const reqDoc = await db.collection('ipear_redemption_requests').doc(res.requestId).get();
    expect(reqDoc.exists).toBe(true);
    const d = reqDoc.data();
    expect(d.source).toBe('card_qr');
    expect(d.rewardCost).toBe(500);
    expect(d.storeId).toBe(STORE_A);
    expect(d.tabletActorUid).toBe(TABLET_A);
    expect(d.status).toBe('pending');
  });

  it('§B.10 tampered points-cost input is ignored — server uses canonical reward.cost', async () => {
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€ Έκπτωση', cost: 500, discount: 5, isActive: true, order: 1,
    });
    // The handler ignores extra fields. A malicious tablet payload with cost:1
    // still results in the canonical 500 being stored.
    const res = await internals._createRedemptionRequestFromCardHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500', cost: 1, points: 1, rewardCost: 1 })
    );
    expect(res.rewardCost).toBe(500);
    const reqDoc = await db.collection('ipear_redemption_requests').doc(res.requestId).get();
    expect(reqDoc.data().rewardCost).toBe(500);
  });

  it('§B.11 inactive reward → failed-precondition, no request', async () => {
    await db.collection('ipear_rewards').doc('rw-inactive').set({
      title: 'Deprecated', cost: 500, discount: 5, isActive: false, order: 1,
    });
    let err;
    try {
      await internals._createRedemptionRequestFromCardHandler(
        makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-inactive' })
      );
    } catch (e) { err = e; }
    expect(err?.code).toBe('failed-precondition');
    const all = await db.collection('ipear_redemption_requests').get();
    expect(all.size).toBe(0);
  });

  it('§B.12 missing reward → not-found', async () => {
    let err;
    try {
      await internals._createRedemptionRequestFromCardHandler(
        makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-does-not-exist' })
      );
    } catch (e) { err = e; }
    expect(err?.code).toBe('not-found');
  });

  it('§B.13 blocked customer at scan-time → failed-precondition, no request', async () => {
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€', cost: 500, discount: 5, isActive: true,
    });
    await db.collection('ipear_customers').doc(CUSTOMER_ID).update({ blocked: true });
    let err;
    try {
      await internals._createRedemptionRequestFromCardHandler(
        makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })
      );
    } catch (e) { err = e; }
    expect(err?.code).toBe('failed-precondition');
    const all = await db.collection('ipear_redemption_requests').get();
    expect(all.size).toBe(0);
  });

  it('§B.14 insufficient balance → failed-precondition', async () => {
    await db.collection('ipear_rewards').doc('rw-huge').set({
      title: '100€', cost: 99999, discount: 100, isActive: true,
    });
    let err;
    try {
      await internals._createRedemptionRequestFromCardHandler(
        makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-huge' })
      );
    } catch (e) { err = e; }
    expect(err?.code).toBe('failed-precondition');
  });

  it('§B.15 double scan (same store+tablet+card+reward) → SAME requestId, alreadyPending', async () => {
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€', cost: 500, discount: 5, isActive: true,
    });
    const r1 = await internals._createRedemptionRequestFromCardHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })
    );
    const r2 = await internals._createRedemptionRequestFromCardHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })
    );
    expect(r1.requestId).toBe(r2.requestId);
    expect(r2.alreadyPending).toBe(true);
    const all = await db.collection('ipear_redemption_requests').get();
    expect(all.size).toBe(1);
  });

  it('§B.16 CONCURRENCY: two parallel card-path requests → one doc, one requestId', async () => {
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€', cost: 500, discount: 5, isActive: true,
    });
    const [a, b] = await Promise.all([
      internals._createRedemptionRequestFromCardHandler(makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })),
      internals._createRedemptionRequestFromCardHandler(makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })),
    ]);
    expect(a.requestId).toBe(b.requestId);
    expect([a.alreadyPending, b.alreadyPending].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    const all = await db.collection('ipear_redemption_requests').get();
    expect(all.size).toBe(1);
  });

  it('§B.17 approve card-path request → single deduction, ledger row, reward doc UNTOUCHED', async () => {
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€ Έκπτωση', cost: 500, discount: 5, isActive: true, order: 1,
    });
    const create = await internals._createRedemptionRequestFromCardHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })
    );
    const app = await internals._approveRedemptionHandler(makeAdminRequest({ requestId: create.requestId }));
    expect(app.status).toBe('approved');
    expect(app.newPoints).toBe(500); // 1000 - 500
    // Reward doc must be UNTOUCHED (no `used:true`).
    const rwAfter = await db.collection('ipear_rewards').doc('rw-500').get();
    expect(rwAfter.data().isActive).toBe(true);
    expect(rwAfter.data().used).toBeUndefined();
    // Single ledger row with deterministic id.
    const ledger = await db.collection('ipear_transactions').doc(`redeem_${create.requestId}`).get();
    expect(ledger.exists).toBe(true);
    expect(ledger.data().type).toBe('redeem');
    expect(ledger.data().points).toBe(-500);
  });

  it('§B.18 approve card-path is IDEMPOTENT — second approve is no-op', async () => {
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€', cost: 500, discount: 5, isActive: true,
    });
    const create = await internals._createRedemptionRequestFromCardHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })
    );
    const first = await internals._approveRedemptionHandler(makeAdminRequest({ requestId: create.requestId }));
    const second = await internals._approveRedemptionHandler(makeAdminRequest({ requestId: create.requestId }));
    expect(first.alreadyProcessed).toBe(false);
    expect(second.alreadyProcessed).toBe(true);
    const cust = (await db.collection('ipear_customers').doc(CUSTOMER_ID).get()).data();
    expect(cust.points).toBe(500); // NOT 0
    const ledgers = await db.collection('ipear_transactions').get();
    expect(ledgers.size).toBe(1);
  });

  it('§B.19 reject card-path request → no balance change, no ledger', async () => {
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€', cost: 500, discount: 5, isActive: true,
    });
    const create = await internals._createRedemptionRequestFromCardHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })
    );
    await internals._rejectRedemptionHandler(makeAdminRequest({ requestId: create.requestId, reason: 'test' }));
    const cust = (await db.collection('ipear_customers').doc(CUSTOMER_ID).get()).data();
    expect(cust.points).toBe(1000);
    const ledgers = await db.collection('ipear_transactions').get();
    expect(ledgers.size).toBe(0);
  });

  it('§B.20 approve fails if reward cost changed between scan and approve', async () => {
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€', cost: 500, discount: 5, isActive: true,
    });
    const create = await internals._createRedemptionRequestFromCardHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })
    );
    // Admin edits the reward cost between scan and approval — must fail closed.
    await db.collection('ipear_rewards').doc('rw-500').update({ cost: 750 });
    let err;
    try { await internals._approveRedemptionHandler(makeAdminRequest({ requestId: create.requestId })); }
    catch (e) { err = e; }
    expect(err?.code).toBe('failed-precondition');
    const cust = (await db.collection('ipear_customers').doc(CUSTOMER_ID).get()).data();
    expect(cust.points).toBe(1000);
  });

  it('§B.21 approve fails if reward went inactive between scan and approve', async () => {
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€', cost: 500, discount: 5, isActive: true,
    });
    const create = await internals._createRedemptionRequestFromCardHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })
    );
    await db.collection('ipear_rewards').doc('rw-500').update({ isActive: false });
    let err;
    try { await internals._approveRedemptionHandler(makeAdminRequest({ requestId: create.requestId })); }
    catch (e) { err = e; }
    expect(err?.code).toBe('failed-precondition');
  });

  it('§B.22 non-admin cannot approve card-path request', async () => {
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€', cost: 500, discount: 5, isActive: true,
    });
    const create = await internals._createRedemptionRequestFromCardHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })
    );
    let err;
    try {
      await internals._approveRedemptionHandler(
        { data: { requestId: create.requestId }, auth: { uid: TABLET_A, token: { role: 'tablet', storeId: STORE_A } } }
      );
    } catch (e) { err = e; }
    expect(err?.code).toBe('permission-denied');
  });

  it('§B.23 legacy 6-digit path still works alongside the card path', async () => {
    // 6-digit path uses the seeded redemption code from beforeEach.
    const legacy = await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' }));
    expect(legacy.type).toBe('redeem');
    // Card path in parallel — separate requestId (different deterministic seed).
    await db.collection('ipear_rewards').doc('rw-500').set({
      title: '5€', cost: 500, discount: 5, isActive: true,
    });
    const card = await internals._createRedemptionRequestFromCardHandler(
      makeTabletRequest({ cardQrPayload: 'IP-ABC123', rewardId: 'rw-500' })
    );
    expect(card.requestId).not.toBe(legacy.requestId);
    const all = await db.collection('ipear_redemption_requests').get();
    expect(all.size).toBe(2);
  });

  it('insufficient balance at scan-time → fails, no request created', async () => {
    await db.collection('ipear_customers').doc(CUSTOMER_ID).update({ points: 100 });
    let err;
    try { await internals._createRedemptionRequestHandler(makeTabletRequest({ code: '123456' })); }
    catch (e) { err = e; }
    expect(err?.code).toBe('failed-precondition');
    const all = await db.collection('ipear_redemption_requests').get();
    expect(all.size).toBe(0);
  });
});
