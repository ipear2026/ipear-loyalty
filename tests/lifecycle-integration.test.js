// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS Stage 2 — customer LIFECYCLE integration (Firestore + Auth
//  emulators). Proves the destructive behavior of adminDeleteCustomer:
//
//   • FINANCIAL EVIDENCE PRESERVED: ipear_transactions rows are RETAINED
//     (count/amount/type/date untouched), PII scrubbed, identity → tombstone.
//   • PII REMOVED: ipear_customers (primary+orphans) deleted; Auth user deleted.
//   • AUDIT: an immutable admin_audit completion event is written.
//   • IDEMPOTENT / RESUMABLE: duplicate + retry calls do not restore PII,
//     do not delete evidence, do not duplicate audit, do not corrupt state.
//   • Auth-already-missing + aux-doc-already-missing tolerated (fail-safe).
//
//  Run:  npm run test:lifecycle
//    (firebase emulators:exec --only firestore,auth 'vitest run tests/lifecycle-integration.test.js')
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, beforeAll, beforeEach, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'loyalty-ipear-life';
const OWNER = 'owner-uid-123';
process.env.OWNER_UIDS = OWNER;

let I, db, getAuth, deleteHandler;

beforeAll(() => {
  const mod = require('../functions/index.js');
  I = mod._l23aInternals;
  db = I.db;
  getAuth = I.getAuth;
  deleteHandler = I._adminDeleteCustomerHandler;
});

async function clearDb() {
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`;
  await fetch(url, { method: 'DELETE' });
  const au = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/accounts`;
  await fetch(au, { method: 'DELETE' }).catch(() => {});
}
beforeEach(clearDb);

const ownerReq = (data) => ({ auth: { uid: OWNER, token: { admin: true } }, data });

async function seedCustomer({ cid = 'C1', uid = 'U1', email = 'jane@ipear.gr', phone = '6900000000', card = 'IP-ABC123', points = 500, withAuth = true } = {}) {
  if (withAuth) { try { await getAuth().createUser({ uid, email }); } catch (_) {} }
  await db.collection('ipear_customers').doc(cid).set({
    uid, email, phone, card, name: 'Jane Doe', points, totalPoints: points, blocked: false,
  });
  return { cid, uid, email, phone, card };
}
async function seedTx(id, over = {}) {
  await db.collection('ipear_transactions').doc(id).set({
    customerId: 'C1', customerUid: 'U1', customerEmail: 'jane@ipear.gr', customerName: 'Jane Doe',
    points: 100, type: 'add', delta: 100, date: '2026-01-01T00:00:00Z', source: 'admin', ...over,
  });
}

describe('§LC1 — happy path: ledger retained + anonymized, PII + Auth deleted, audited', () => {
  it('deletes customer, preserves financial evidence, scrubs PII', { timeout: 30000 }, async () => {
    await seedCustomer();
    await seedTx('tx1', { points: 100, type: 'add' });
    await seedTx('tx2', { points: -40, type: 'redeem' });
    await db.collection('ipear_offer_redemptions').doc('or1').set({ customerUid: 'U1', customerEmail: 'jane@ipear.gr', bonusPoints: 50 });
    await db.collection('ipear_birthday_claims').doc('bc1').set({ customerUid: 'U1', customerEmail: 'jane@ipear.gr', year: 2026 });
    await db.collection('ipear_referral_queue').doc('U1').set({ uid: 'U1', pending: true });
    await db.collection('audit_logs').doc('al1').set({ customerUid: 'U1', action: 'login', email: 'jane@ipear.gr' });

    const res = await deleteHandler(ownerReq({ customerId: 'C1' }));
    expect(res.ok).toBe(true);
    expect(res.idempotent).toBe(false);
    expect(res.tombstone).toMatch(/^deleted_customer_/);
    const T = res.tombstone;

    // customer PII doc GONE
    expect((await db.collection('ipear_customers').doc('C1').get()).exists).toBe(false);

    // LEDGER RETAINED — both rows still present (count preserved)
    const txAll = await db.collection('ipear_transactions').get();
    expect(txAll.size).toBe(2);
    const tx1 = (await db.collection('ipear_transactions').doc('tx1').get()).data();
    // financial facts PRESERVED
    expect(tx1.points).toBe(100);
    expect(tx1.type).toBe('add');
    expect(tx1.delta).toBe(100);
    expect(tx1.date).toBe('2026-01-01T00:00:00Z');
    // PII REMOVED + identity repointed to tombstone
    expect(tx1.customerEmail).toBeNull();
    expect(tx1.customerName).toBeNull();
    expect(tx1.customerId).toBe(T);
    expect(tx1.customerUid).toBe(T);
    expect(tx1._tombstone).toBe(T);
    const tx2 = (await db.collection('ipear_transactions').doc('tx2').get()).data();
    expect(tx2.points).toBe(-40);
    expect(tx2.type).toBe('redeem');

    // redemption evidence retained + anonymized
    const or1 = (await db.collection('ipear_offer_redemptions').doc('or1').get()).data();
    expect(or1.bonusPoints).toBe(50);
    expect(or1.customerEmail).toBeNull();
    expect(or1.customerUid).toBe(T);

    // operational: birthday claim retained + anonymized; audit_log anonymized
    expect((await db.collection('ipear_birthday_claims').doc('bc1').get()).data().customerEmail).toBeNull();
    expect((await db.collection('audit_logs').doc('al1').get()).data().customerUid).toBe(T);

    // transient referral queue DELETED
    expect((await db.collection('ipear_referral_queue').doc('U1').get()).exists).toBe(false);

    // Auth user DELETED
    await expect(getAuth().getUser('U1')).rejects.toMatchObject({ code: 'auth/user-not-found' });

    // immutable audit COMPLETION event written
    const auditSnap = await db.collection('admin_audit').doc(res.lifecycleId).get();
    expect(auditSnap.exists).toBe(true);
    const a = auditSnap.data();
    expect(a.action).toBe('admin_delete_customer');
    expect(a.actorUid).toBe(OWNER);
    expect(a.tombstone).toBe(T);
    expect(a.result).toBe('success');
    expect(a.ledgerRowsAnonymized).toBe(2);
  });
});

describe('§LC2 — idempotency / resumability', () => {
  it('duplicate call → idempotent; ledger NOT re-mutated; audit not duplicated', { timeout: 30000 }, async () => {
    await seedCustomer();
    await seedTx('tx1');
    const r1 = await deleteHandler(ownerReq({ customerId: 'C1' }));
    const T = r1.tombstone;
    const anonAt1 = (await db.collection('ipear_transactions').doc('tx1').get()).data()._anonymizedAt;

    const r2 = await deleteHandler(ownerReq({ customerId: 'C1' }));
    expect(r2.idempotent).toBe(true);
    expect(r2.tombstone).toBe(T);
    // ledger unchanged on the second pass (still 1 row, same anonymization stamp)
    const txAll = await db.collection('ipear_transactions').get();
    expect(txAll.size).toBe(1);
    expect((await db.collection('ipear_transactions').doc('tx1').get()).data()._anonymizedAt).toBe(anonAt1);
    // audit still a single doc
    const audits = await db.collection('admin_audit').get();
    expect(audits.size).toBe(1);
    // customer stays deleted
    expect((await db.collection('ipear_customers').doc('C1').get()).exists).toBe(false);
  });

  it('concurrent duplicate calls → ledger ends with exactly the original rows', { timeout: 30000 }, async () => {
    await seedCustomer();
    await seedTx('tx1'); await seedTx('tx2', { type: 'redeem', points: -10 });
    await Promise.all([
      deleteHandler(ownerReq({ customerId: 'C1' })),
      deleteHandler(ownerReq({ customerId: 'C1' })),
    ]);
    expect((await db.collection('ipear_transactions').get()).size).toBe(2);
    expect((await db.collection('ipear_customers').doc('C1').get()).exists).toBe(false);
  });

  it('resume tail: audit exists but customer doc lingers → deletes it, returns idempotent', { timeout: 30000 }, async () => {
    await seedCustomer();
    await seedTx('tx1');
    await deleteHandler(ownerReq({ customerId: 'C1' }));
    // simulate a crash between audit-write and the final customer-doc delete:
    // re-create the customer doc, then re-invoke → the tail must delete it again.
    await db.collection('ipear_customers').doc('C1').set({ uid: 'U1', email: 'jane@ipear.gr' });
    const r2 = await deleteHandler(ownerReq({ customerId: 'C1' }));
    expect(r2.idempotent).toBe(true);
    expect((await db.collection('ipear_customers').doc('C1').get()).exists).toBe(false);
  });
});

describe('§LC3 — edge cases (fail-safe)', () => {
  it('nonexistent customer → notFound idempotent, no audit, no throw', { timeout: 30000 }, async () => {
    const res = await deleteHandler(ownerReq({ customerId: 'does-not-exist' }));
    expect(res.ok).toBe(true);
    expect(res.notFound).toBe(true);
    expect((await db.collection('admin_audit').get()).size).toBe(0);
  });
  it('Auth user already missing → deletion still succeeds', { timeout: 30000 }, async () => {
    await seedCustomer({ withAuth: false }); // customer doc has uid U1 but no Auth user
    await seedTx('tx1');
    const res = await deleteHandler(ownerReq({ customerId: 'C1' }));
    expect(res.ok).toBe(true);
    expect((await db.collection('ipear_customers').doc('C1').get()).exists).toBe(false);
    expect((await db.collection('ipear_transactions').doc('tx1').get()).data().customerId).toBe(res.tombstone);
  });
  it('auxiliary docs already missing (no tx/redemptions) → succeeds', { timeout: 30000 }, async () => {
    await seedCustomer();
    const res = await deleteHandler(ownerReq({ customerId: 'C1' }));
    expect(res.ok).toBe(true);
    expect(res.ledgerRowsAnonymized).toBe(0);
    await expect(getAuth().getUser('U1')).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });
  it('orphan customer docs sharing email are also deleted; their uid auth removed', { timeout: 30000 }, async () => {
    await seedCustomer({ cid: 'C1', uid: 'U1', email: 'dup@ipear.gr' });
    // orphan doc, different id/uid, same email
    try { await getAuth().createUser({ uid: 'U2', email: 'dup2@ipear.gr' }); } catch (_) {}
    await db.collection('ipear_customers').doc('C2').set({ uid: 'U2', email: 'dup@ipear.gr', phone: '6900000000', card: 'X' });
    const res = await deleteHandler(ownerReq({ customerId: 'C1' }));
    expect(res.ok).toBe(true);
    expect((await db.collection('ipear_customers').doc('C1').get()).exists).toBe(false);
    expect((await db.collection('ipear_customers').doc('C2').get()).exists).toBe(false);
    await expect(getAuth().getUser('U2')).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });
});
