// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS Stage 2 — §6b FINANCIAL RULE LOCK proof (emulator).
//  Loads the PLANNED locked ruleset (firestore.rules.locked) and proves the
//  cutover invariant: no browser client — including a valid admin session —
//  can directly mutate loyalty financial state; server (Admin SDK) is
//  unaffected; reads / signup / non-balance admin edits remain intact.
//  NOT a production deploy — emulator only.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, deleteDoc, updateDoc, collection, query, where } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ID = 'loyalty-ipear-locked-test';
const RULES_PATH = join(process.cwd(), 'firestore.rules.locked'); // the LOCKED ruleset
let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(RULES_PATH, 'utf8') },
  });
});
afterAll(async () => { if (testEnv) await testEnv.cleanup(); });
beforeEach(async () => { await testEnv.clearFirestore(); });

async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const [c, d] = path.split('/'); await setDoc(doc(ctx.firestore(), c, d), data);
  });
}
const CUST = 'cust-uid', ADMIN = 'admin-uid', TAB = 'tab-uid';
const custCtx = () => testEnv.authenticatedContext(CUST, { email: 'c@ipear.gr', email_verified: true });
const adminCtx = () => testEnv.authenticatedContext(ADMIN, { email: 'a@ipear.gr', email_verified: true, admin: true });
const tabletCtx = () => testEnv.authenticatedContext(TAB, { email: 't@ipear.gr', email_verified: true, role: 'tablet', storeId: 'store_1' });
const anonCtx = () => testEnv.unauthenticatedContext();

async function seedCustomer(uid = CUST, email = 'c@ipear.gr', points = 500) {
  await seed(`ipear_customers/${uid}`, { uid, email, name: 'C', card: 'IP-ABC123', points, totalPoints: points, blocked: false, referralProcessed: false, referralCount: 0, createdAt: new Date().toISOString() });
}
async function seedTx(id = 'tx1', over = {}) {
  await seed(`ipear_transactions/${id}`, { customerId: CUST, customerUid: CUST, customerEmail: 'c@ipear.gr', type: 'add', points: 100, date: new Date().toISOString(), ...over });
}
async function seedAdmin() { await seed(`ipear_admins/${ADMIN}`, { addedAt: new Date().toISOString() }); }

// ── 1–4: direct customer-balance writes DENIED for every client ──────────────
describe('§6b — customer balance (points/totalPoints/referralCount) writes', () => {
  it('customer direct points write → DENIED', async () => {
    await seedCustomer();
    await assertFails(updateDoc(doc(custCtx().firestore(), 'ipear_customers', CUST), { points: 99999 }));
  });
  it('tablet direct points write → DENIED', async () => {
    await seedCustomer();
    await assertFails(updateDoc(doc(tabletCtx().firestore(), 'ipear_customers', CUST), { points: 99999 }));
  });
  it('ADMIN direct points write → DENIED (the lock)', async () => {
    await seedCustomer(); await seedAdmin();
    await assertFails(updateDoc(doc(adminCtx().firestore(), 'ipear_customers', CUST), { points: 99999 }));
  });
  it('ADMIN totalPoints / referralCount write → DENIED', async () => {
    await seedCustomer(); await seedAdmin();
    await assertFails(updateDoc(doc(adminCtx().firestore(), 'ipear_customers', CUST), { totalPoints: 99999 }));
    await assertFails(updateDoc(doc(adminCtx().firestore(), 'ipear_customers', CUST), { referralCount: 5 }));
  });
  it('ADMIN NON-balance edits still ALLOWED (block / name / suspicious / tier)', async () => {
    await seedCustomer(); await seedAdmin();
    await assertSucceeds(updateDoc(doc(adminCtx().firestore(), 'ipear_customers', CUST), { blocked: true }));
    await assertSucceeds(updateDoc(doc(adminCtx().firestore(), 'ipear_customers', CUST), { name: 'New Name' }));
    await assertSucceeds(updateDoc(doc(adminCtx().firestore(), 'ipear_customers', CUST), { suspicious: true }));
    await assertSucceeds(updateDoc(doc(adminCtx().firestore(), 'ipear_customers', CUST), { tier: 'gold' }));
  });
});

// ── 5–7: ipear_transactions ledger is append-only + server-only ──────────────
describe('§6b — ipear_transactions client write DENIED', () => {
  it('ADMIN client create → DENIED', async () => {
    await seedAdmin();
    await assertFails(setDoc(doc(adminCtx().firestore(), 'ipear_transactions', 'new1'), { customerId: CUST, type: 'add', points: 100 }));
  });
  it('ADMIN client update → DENIED', async () => {
    await seedTx(); await seedAdmin();
    await assertFails(updateDoc(doc(adminCtx().firestore(), 'ipear_transactions', 'tx1'), { points: 1 }));
  });
  it('ADMIN client delete → DENIED (no evidence erasure)', async () => {
    await seedTx(); await seedAdmin();
    await assertFails(deleteDoc(doc(adminCtx().firestore(), 'ipear_transactions', 'tx1')));
  });
});

// ── 8: admin_audit immutable from every client ───────────────────────────────
describe('§6b — admin_audit client-immutable', () => {
  it('ADMIN create / update / delete → DENIED', async () => {
    await seedAdmin(); await seed('admin_audit/a1', { action: 'x', actorUid: ADMIN });
    await assertFails(setDoc(doc(adminCtx().firestore(), 'admin_audit', 'a2'), { action: 'forged' }));
    await assertFails(updateDoc(doc(adminCtx().firestore(), 'admin_audit', 'a1'), { action: 'tampered' }));
    await assertFails(deleteDoc(doc(adminCtx().firestore(), 'admin_audit', 'a1')));
  });
});

// ── 9–11: reads preserved ────────────────────────────────────────────────────
describe('§6b — reads remain intact', () => {
  it('customer reads own doc + own transactions (uid) → ALLOWED', async () => {
    await seedCustomer(); await seedTx();
    await assertSucceeds(getDoc(doc(custCtx().firestore(), 'ipear_customers', CUST)));
    await assertSucceeds(getDocs(query(collection(custCtx().firestore(), 'ipear_transactions'), where('customerUid', '==', CUST))));
  });
  it('verified customer reads own transactions by email → ALLOWED; cross-customer → DENIED', async () => {
    await seedTx('txE', { customerUid: 'someone-else', customerEmail: 'c@ipear.gr' });
    await assertSucceeds(getDocs(query(collection(custCtx().firestore(), 'ipear_transactions'), where('customerEmail', '==', 'c@ipear.gr'))));
    await seedTx('txX', { customerId: 'victim', customerUid: 'victim', customerEmail: 'victim@ipear.gr' });
    await assertFails(getDoc(doc(custCtx().firestore(), 'ipear_transactions', 'txX')));
  });
  it('admin reads customers / transactions / admin_audit → ALLOWED', async () => {
    await seedCustomer(); await seedTx(); await seedAdmin(); await seed('admin_audit/a1', { action: 'x' });
    const a = adminCtx().firestore();
    await assertSucceeds(getDoc(doc(a, 'ipear_customers', CUST)));
    await assertSucceeds(getDoc(doc(a, 'ipear_transactions', 'tx1')));
    await assertSucceeds(getDoc(doc(a, 'admin_audit', 'a1')));
  });
});

// ── 12–13: signup / bootstrap + admin create balance guard ───────────────────
describe('§6b — signup + admin-create balance guard', () => {
  it('customer self-signup create (points==0) → ALLOWED; (points>0) → DENIED', async () => {
    const ok = { uid: CUST, email: 'c@ipear.gr', name: 'C', card: 'IP-ABC123', points: 0, totalPoints: 0, blocked: false, referralProcessed: false, referralCount: 0, referredBy: '', marketingOptIn: false, createdAt: new Date().toISOString() };
    await assertSucceeds(setDoc(doc(custCtx().firestore(), 'ipear_customers', CUST), ok));
    await testEnv.clearFirestore();
    await assertFails(setDoc(doc(custCtx().firestore(), 'ipear_customers', CUST), { ...ok, points: 100, totalPoints: 100 }));
  });
  it('ADMIN create with points==0 → ALLOWED; points>0 → DENIED (no mint via create)', async () => {
    await seedAdmin();
    await assertSucceeds(setDoc(doc(adminCtx().firestore(), 'ipear_customers', 'newcust1'), { uid: 'newcust1', email: 'n@ipear.gr', name: 'N', card: 'IP-NEW001', points: 0, totalPoints: 0, blocked: false }));
    await testEnv.clearFirestore(); await seedAdmin();
    await assertFails(setDoc(doc(adminCtx().firestore(), 'ipear_customers', 'newcust2'), { uid: 'newcust2', email: 'n2@ipear.gr', name: 'N2', card: 'IP-NEW002', points: 500, totalPoints: 500, blocked: false }));
  });
});

// ── 14: server Admin SDK unaffected (bypasses rules) ─────────────────────────
describe('§6b — server Admin SDK is the sole financial writer (unaffected)', () => {
  it('service-account (rules-disabled) can still write points + ledger', async () => {
    await seedCustomer();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await assertSucceeds(updateDoc(doc(db, 'ipear_customers', CUST), { points: 999 }));
      await assertSucceeds(setDoc(doc(db, 'ipear_transactions', 'srv1'), { customerId: CUST, type: 'add', points: 10 }));
      await assertSucceeds(setDoc(doc(db, 'admin_audit', 'srv-audit'), { action: 'admin_adjust', actorUid: 'owner' }));
    });
  });
});
