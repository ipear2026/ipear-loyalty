// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  Firestore Security Rules — automated regression suite
//
//  Runs against the local Firestore emulator. The npm script wires it up:
//    $ npm run test:rules
//    → firebase emulators:exec --only firestore 'vitest run tests/firestore-rules.test.js'
//
//  Why not the security-probe script we ran against PROD? That probe only
//  validates rules from an unauthenticated caller's perspective and can't
//  exercise admin-claim paths or seed pre-existing docs (no write access).
//  The emulator lets us:
//    • Seed customer + reward + admin docs via withSecurityRulesDisabled()
//    • Test from any uid + claim combination via authenticatedContext()
//    • Run dozens of cheap assertions without polluting production data
//
//  Coverage focus (per the A+ uplift brief): the three highest-stakes
//  rule paths from the dynamic-rewards refactor.
//
//  Local prerequisites:
//    • Java 17+ (firebase emulator runs on the JVM)
//    • `firebase-tools` devDep (npx finds it via npm)
//    • `@firebase/rules-unit-testing` devDep
//
//  CI: ubuntu-latest has java available; the test-rules workflow job
//  pins openjdk-17 via setup-java for determinism.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, getDocs, addDoc, deleteDoc,
  collection, query, where, Timestamp,
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ID = 'loyalty-ipear-test';
const RULES_PATH = join(process.cwd(), 'firestore.rules');

let testEnv;

// ── Setup / teardown ───────────────────────────────────────────────────────
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(RULES_PATH, 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// ── Test helpers ───────────────────────────────────────────────────────────
// Seed a doc bypassing the rules — equivalent to admin-SDK writes the live
// app's worker / cloud functions perform on bootstrap.
async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const [collectionName, docId] = path.split('/');
    await setDoc(doc(db, collectionName, docId), data);
  });
}

async function seedCustomer(uid, email = `${uid}@test.gr`, points = 5000) {
  await seed(`ipear_customers/${uid}`, {
    uid,
    email,
    name: 'Test User',
    card: `IP-E${uid.toUpperCase().slice(0, 5)}`,
    points,
    totalPoints: points,
    blocked: false,
    createdAt: new Date().toISOString(),
  });
}

async function seedReward(id, { cost, discount, isActive = true, ...extras } = {}) {
  await seed(`ipear_rewards/${id}`, {
    title: `Reward ${id}`,
    cost,
    discount,
    icon: '🎟️',
    description: '',
    isActive,
    order: 1,
    createdAt: new Date().toISOString(),
    ...extras,
  });
}

async function seedAdminWhitelist(uid) {
  await seed(`ipear_admins/${uid}`, { addedAt: new Date().toISOString() });
}

// Build a redemption doc payload that matches the rule's whitelist.
// Callers override `overrides` to flip individual fields for the negative
// scenarios (mismatched ladder pair, bogus rewardId, impersonation, etc.).
function redemptionPayload(customerUid, overrides = {}) {
  const now = new Date();
  const exp = new Date(Date.now() + 5 * 60 * 1000);
  return {
    code: '123456',
    customerId: customerUid,
    customerUid,
    customerName: 'Test User',
    card: 'IP-EABCDE',
    points: 1000,
    discount: 5,
    label: '5€ Έκπτωση',
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: exp.toISOString(),
    used: false,
    createdAtTs: Timestamp.fromDate(now),
    expiresAtTs: Timestamp.fromDate(exp),
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════
//  TEST SUITE 1 — ipear_rewards: READ
// ═════════════════════════════════════════════════════════════════════════
describe('ipear_rewards: READ access', () => {
  it('UNAUTH user cannot read any reward', async () => {
    await seedReward('reward-a', { cost: 1000, discount: 5, isActive: true });
    const unauth = testEnv.unauthenticatedContext();
    await assertFails(getDoc(doc(unauth.firestore(), 'ipear_rewards', 'reward-a')));
  });

  it('AUTH user CAN read an active reward', async () => {
    await seedReward('reward-a', { cost: 1000, discount: 5, isActive: true });
    const user = testEnv.authenticatedContext('alice', { email_verified: true });
    await assertSucceeds(getDoc(doc(user.firestore(), 'ipear_rewards', 'reward-a')));
  });

  it('AUTH user CANNOT read an inactive reward (isActive=false)', async () => {
    await seedReward('reward-draft', { cost: 1000, discount: 5, isActive: false });
    const user = testEnv.authenticatedContext('alice', { email_verified: true });
    await assertFails(getDoc(doc(user.firestore(), 'ipear_rewards', 'reward-draft')));
  });

  it('AUTH user CAN list rewards filtered by isActive==true', async () => {
    await seedReward('reward-a', { cost: 1000, discount: 5, isActive: true });
    await seedReward('reward-b', { cost: 2500, discount: 15, isActive: true });
    await seedReward('reward-draft', { cost: 9000, discount: 50, isActive: false });
    const user = testEnv.authenticatedContext('alice', { email_verified: true });
    const snap = await assertSucceeds(getDocs(
      query(collection(user.firestore(), 'ipear_rewards'), where('isActive', '==', true))
    ));
    expect(snap.size).toBe(2);
  });

  it('ADMIN (whitelist) CAN read inactive draft rewards', async () => {
    await seedReward('reward-draft', { cost: 9000, discount: 50, isActive: false });
    await seedAdminWhitelist('admin-uid');
    const admin = testEnv.authenticatedContext('admin-uid', { email_verified: true });
    await assertSucceeds(getDoc(doc(admin.firestore(), 'ipear_rewards', 'reward-draft')));
  });
});

// ═════════════════════════════════════════════════════════════════════════
//  TEST SUITE 2 — ipear_rewards: WRITE
// ═════════════════════════════════════════════════════════════════════════
describe('ipear_rewards: WRITE access', () => {
  const validRewardPayload = {
    title: 'Reward',
    cost: 1000,
    discount: 5,
    icon: '🎟️',
    description: '',
    isActive: true,
    order: 1,
    createdAt: '2026-06-22T00:00:00.000Z',
  };

  it('NON-ADMIN user cannot create a reward', async () => {
    const user = testEnv.authenticatedContext('alice', { email_verified: true });
    await assertFails(setDoc(
      doc(user.firestore(), 'ipear_rewards', 'malicious-cheap-prize'),
      { ...validRewardPayload, cost: 1, discount: 1000 } // attack: 1pt → 1000€
    ));
  });

  it('NON-ADMIN user cannot update an existing reward', async () => {
    await seedReward('reward-a', { cost: 1000, discount: 5, isActive: true });
    const user = testEnv.authenticatedContext('alice', { email_verified: true });
    await assertFails(setDoc(
      doc(user.firestore(), 'ipear_rewards', 'reward-a'),
      { ...validRewardPayload, cost: 1, discount: 1000 } // attack: tampering
    ));
  });

  it('NON-ADMIN user cannot delete a reward', async () => {
    await seedReward('reward-a', { cost: 1000, discount: 5, isActive: true });
    const user = testEnv.authenticatedContext('alice', { email_verified: true });
    await assertFails(deleteDoc(doc(user.firestore(), 'ipear_rewards', 'reward-a')));
  });

  it('ADMIN (whitelist doc) CAN create a reward', async () => {
    await seedAdminWhitelist('admin-uid');
    const admin = testEnv.authenticatedContext('admin-uid', { email_verified: true });
    await assertSucceeds(setDoc(
      doc(admin.firestore(), 'ipear_rewards', 'new-reward'),
      validRewardPayload
    ));
  });

  it('ADMIN (custom claim admin=true) CAN create a reward', async () => {
    const admin = testEnv.authenticatedContext('admin-claim', {
      email_verified: true,
      admin: true,
    });
    await assertSucceeds(setDoc(
      doc(admin.firestore(), 'ipear_rewards', 'new-reward'),
      validRewardPayload
    ));
  });

  it('ADMIN CAN update + delete rewards', async () => {
    await seedReward('reward-a', { cost: 1000, discount: 5, isActive: true });
    await seedAdminWhitelist('admin-uid');
    const admin = testEnv.authenticatedContext('admin-uid', { email_verified: true });
    await assertSucceeds(setDoc(
      doc(admin.firestore(), 'ipear_rewards', 'reward-a'),
      { ...validRewardPayload, isActive: false } // toggle off
    ));
    await assertSucceeds(deleteDoc(doc(admin.firestore(), 'ipear_rewards', 'reward-a')));
  });
});

// ═════════════════════════════════════════════════════════════════════════
//  TEST SUITE 3 — ipear_redemptions: CREATE (hybrid rule)
//
//  This is the heart of the dynamic-rewards security model. The rule
//  accepts a create if EITHER:
//    (a) `rewardId` points at an active ipear_rewards doc whose cost +
//        discount match the redemption payload (dynamic-catalog path)
//    (b) the `points` + `discount` pair matches the legacy 3-tier ladder
//        (1000→5, 2500→15, 4000→30)
//  Anything else must be denied.
// ═════════════════════════════════════════════════════════════════════════
describe('ipear_redemptions: CREATE — hybrid rule', () => {
  const CUSTOMER_UID = 'alice';

  beforeEach(async () => {
    await seedCustomer(CUSTOMER_UID, 'alice@test.gr', 5000);
  });

  // ── (b) Legacy ladder path ──────────────────────────────────────────────
  it('LEGACY 1000→5 ladder pair (no rewardId) → ALLOWED', async () => {
    const user = testEnv.authenticatedContext(CUSTOMER_UID, { email_verified: true });
    await assertSucceeds(addDoc(
      collection(user.firestore(), 'ipear_redemptions'),
      redemptionPayload(CUSTOMER_UID) // defaults to 1000/5
    ));
  });

  it('LEGACY 2500→15 ladder pair → ALLOWED', async () => {
    const user = testEnv.authenticatedContext(CUSTOMER_UID, { email_verified: true });
    await assertSucceeds(addDoc(
      collection(user.firestore(), 'ipear_redemptions'),
      redemptionPayload(CUSTOMER_UID, { points: 2500, discount: 15 })
    ));
  });

  // ── (a) Dynamic-catalog path ────────────────────────────────────────────
  it('DYNAMIC custom-price reward (rewardId, cost matches) → ALLOWED', async () => {
    await seedReward('custom-1500', { cost: 1500, discount: 8, isActive: true });
    const user = testEnv.authenticatedContext(CUSTOMER_UID, { email_verified: true });
    await assertSucceeds(addDoc(
      collection(user.firestore(), 'ipear_redemptions'),
      redemptionPayload(CUSTOMER_UID, {
        points: 1500,
        discount: 8,
        rewardId: 'custom-1500',
      })
    ));
  });

  // ── ATTACK: off-ladder cost, no rewardId ───────────────────────────────
  it('FAKE cost 100→30 (off ladder, no rewardId) → DENIED', async () => {
    const user = testEnv.authenticatedContext(CUSTOMER_UID, { email_verified: true });
    await assertFails(addDoc(
      collection(user.firestore(), 'ipear_redemptions'),
      redemptionPayload(CUSTOMER_UID, { points: 100, discount: 30 })
    ));
  });

  // ── ATTACK: rewardId points at non-existent doc ─────────────────────────
  it('BOGUS rewardId (doc does not exist) → DENIED', async () => {
    const user = testEnv.authenticatedContext(CUSTOMER_UID, { email_verified: true });
    await assertFails(addDoc(
      collection(user.firestore(), 'ipear_redemptions'),
      redemptionPayload(CUSTOMER_UID, {
        points: 1500,
        discount: 8,
        rewardId: 'NONEXISTENT_REWARD',
      })
    ));
  });

  // ── ATTACK: rewardId valid, but points DON'T match catalog ──────────────
  it('MISMATCH client points (1000) vs catalog cost (1500) → DENIED', async () => {
    await seedReward('custom-1500', { cost: 1500, discount: 8, isActive: true });
    const user = testEnv.authenticatedContext(CUSTOMER_UID, { email_verified: true });
    await assertFails(addDoc(
      collection(user.firestore(), 'ipear_redemptions'),
      redemptionPayload(CUSTOMER_UID, {
        points: 1000, // attack: customer claims cheaper price
        discount: 8,
        rewardId: 'custom-1500',
      })
    ));
  });

  // ── ATTACK: rewardId points at INACTIVE reward ──────────────────────────
  it('INACTIVE rewardId (isActive=false) → DENIED', async () => {
    await seedReward('archived-1500', { cost: 1500, discount: 8, isActive: false });
    const user = testEnv.authenticatedContext(CUSTOMER_UID, { email_verified: true });
    await assertFails(addDoc(
      collection(user.firestore(), 'ipear_redemptions'),
      redemptionPayload(CUSTOMER_UID, {
        points: 1500,
        discount: 8,
        rewardId: 'archived-1500',
      })
    ));
  });

  // ── ATTACK: customerUid != auth.uid (impersonation) ─────────────────────
  it('IMPERSONATION (customerUid != auth.uid) → DENIED', async () => {
    await seedCustomer('victim', 'victim@test.gr', 5000);
    const attacker = testEnv.authenticatedContext('attacker', { email_verified: true });
    await assertFails(addDoc(
      collection(attacker.firestore(), 'ipear_redemptions'),
      redemptionPayload('victim') // both customerId + customerUid set to victim
    ));
  });

  // ── ATTACK: customer is BLOCKED ─────────────────────────────────────────
  it('BLOCKED customer → DENIED', async () => {
    await seed(`ipear_customers/blocked-user`, {
      uid: 'blocked-user',
      email: 'blocked@test.gr',
      name: 'Blocked',
      card: 'IP-EBLOCK',
      points: 5000,
      totalPoints: 5000,
      blocked: true,
      createdAt: new Date().toISOString(),
    });
    const user = testEnv.authenticatedContext('blocked-user', { email_verified: true });
    await assertFails(addDoc(
      collection(user.firestore(), 'ipear_redemptions'),
      redemptionPayload('blocked-user')
    ));
  });

  // ── ATTACK: insufficient points ─────────────────────────────────────────
  it('INSUFFICIENT points (customer has 500, tries to redeem 1000) → DENIED', async () => {
    await seed(`ipear_customers/broke-user`, {
      uid: 'broke-user',
      email: 'broke@test.gr',
      name: 'Broke',
      card: 'IP-EBROKE',
      points: 500,
      totalPoints: 500,
      blocked: false,
      createdAt: new Date().toISOString(),
    });
    const user = testEnv.authenticatedContext('broke-user', { email_verified: true });
    await assertFails(addDoc(
      collection(user.firestore(), 'ipear_redemptions'),
      redemptionPayload('broke-user') // 1000 pts but customer has 500
    ));
  });
});
