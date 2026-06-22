#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  One-shot seeder for the E2E test customer.
//
//  USAGE
//  -----
//  After you've created the Firebase Auth user (e.g. e2e@ipear.test) in
//  Firebase Console → Authentication, run:
//
//    TEST_EMAIL=e2e@ipear.test \
//    FIREBASE_SERVICE_ACCOUNT_JSON=$(base64 -i service-account.json) \
//      node scripts/seed-e2e-customer.js
//
//  What it does
//  ------------
//  1. Looks up the Firebase Auth user by email via Admin SDK.
//  2. Flips emailVerified=true on the auth user (so Firestore rules that
//     gate on it stop pushing the spec to the "needs verification" copy).
//  3. Writes / merges a fully-shaped customer doc keyed BY the auth uid
//     (matches the uid-keyed pattern findCustomerByAuth tries first → no
//     legacy migration ladder needs to run during the test).
//
//  Idempotent: re-running just refreshes points back to the seed value
//  without overwriting fields the user might have edited (name, card).
//
//  Requires the same FIREBASE_SERVICE_ACCOUNT_JSON the spec uses.
// ═══════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const TEST_EMAIL = process.env.TEST_EMAIL;
const SA_RAW = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const SEED_POINTS = parseInt(process.env.E2E_SEED_POINTS || '1500', 10);

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }
if (!TEST_EMAIL) die('TEST_EMAIL is required');
if (!SA_RAW) die('FIREBASE_SERVICE_ACCOUNT_JSON is required (base64 of service account JSON)');

if (!getApps().length) {
  const sa = JSON.parse(Buffer.from(SA_RAW, 'base64').toString('utf8'));
  initializeApp({ credential: cert(sa), projectId: sa.project_id });
}

async function main() {
  const auth = getAuth();
  const db = getFirestore();

  // 1. Find the auth user — must exist already (created via Firebase Console).
  let user;
  try {
    user = await auth.getUserByEmail(TEST_EMAIL);
  } catch (e) {
    die(`No Firebase Auth user with email "${TEST_EMAIL}". ` +
        `Create one first in Firebase Console → Authentication → Add user.`);
  }

  // 2. Flip emailVerified if it isn't already.
  if (!user.emailVerified) {
    await auth.updateUser(user.uid, { emailVerified: true });
    console.log(`✓ emailVerified set on ${TEST_EMAIL}`);
  } else {
    console.log(`✓ emailVerified already true on ${TEST_EMAIL}`);
  }

  // 3. Upsert the customer doc keyed by the auth uid.
  const custRef = db.collection('ipear_customers').doc(user.uid);
  const snap = await custRef.get();
  const exists = snap.exists;
  const existing = exists ? snap.data() : {};

  // Card: keep existing if any, else derive a stable IP-EXXXXX from uid.
  const card = existing.card
    || ('IP-E' + user.uid.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5));

  const payload = {
    uid: user.uid,
    email: TEST_EMAIL,
    name: existing.name || 'E2E Tester',
    card,
    phone: existing.phone || '6900000000',
    points: SEED_POINTS,
    totalPoints: Math.max(existing.totalPoints || 0, SEED_POINTS),
    blocked: false,
    referralProcessed: existing.referralProcessed ?? false,
    referralCount: existing.referralCount || 0,
    fcmToken: existing.fcmToken || '',
    marketingOptIn: existing.marketingOptIn ?? false,
    referredBy: existing.referredBy || '',
    registeredStoreId: existing.registeredStoreId || null,
    registeredStoreName: existing.registeredStoreName || 'E2E Test Store',
    createdAt: existing.createdAt || new Date().toISOString(),
  };

  await custRef.set(payload, { merge: true });
  console.log(`✓ ${exists ? 'Updated' : 'Created'} ipear_customers/${user.uid}`);
  console.log(`  card:        ${card}`);
  console.log(`  points:      ${SEED_POINTS}`);
  console.log(`  totalPoints: ${payload.totalPoints}`);

  // 4. Upsert a dummy rewards-catalog doc so the customer app has at least
  //    one active reward to render. Uses the legacy 1000-pt ladder (cost
  //    1000 → discount 5) so the rule's ladder branch also accepts the
  //    eventual redemption — independent of whether the customer app sends
  //    rewardId or not.
  const rewardId = 'e2e_dummy_5eur';
  const rewardRef = db.collection('ipear_rewards').doc(rewardId);
  const rewardExists = (await rewardRef.get()).exists;
  await rewardRef.set(
    {
      title: '5€ Έκπτωση (E2E)',
      cost: 1000,
      discount: 5,
      icon: '🧪',
      description: 'Auto-seeded by scripts/seed-e2e-customer.js',
      isActive: true,
      order: 1,
      updatedAt: new Date().toISOString(),
      ...(rewardExists ? {} : { createdAt: new Date().toISOString() }),
    },
    { merge: true }
  );
  console.log(`✓ ${rewardExists ? 'Updated' : 'Created'} ipear_rewards/${rewardId}`);

  console.log(`\nReady. Run:  npm run e2e`);
}

main().catch((e) => {
  console.error('✗ Seed failed:', e?.message || e);
  process.exit(1);
});
