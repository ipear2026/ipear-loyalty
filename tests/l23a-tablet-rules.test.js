// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  L2.3A · Firestore Security Rules — tablet approval-flow regression suite.
//
//  Runs against the local Firestore emulator via
//    $ npm run test:rules
//    → firebase emulators:exec --only firestore 'vitest run tests/**/*.test.js'
//
//  The rules diff this file exercises:
//    1. `isAdmin()` now requires the `admin: true` custom claim ONLY.
//       The transitional `ipear_admins/{uid}` doc fallback AND the hardcoded
//       email allow-list (`admin@ipear.gr` / `tablet@ipear.gr` /
//       `ipear2026@gmail.com`) are both removed.
//    2. New `isTablet()` = `role: 'tablet'` + `storeId` claims.
//    3. New collection `ipear_redemption_requests`: reads gated by admin
//       claim OR (tablet's own actorUid + own storeId); all client writes
//       denied (server-side Admin SDK is the only writer).
//    4. Every previously `isAdmin()`-gated write no longer accepts tablets
//       (they only had it via the email allow-list, which is gone).
//
//  "Failing-before / passing-after" evidence:
//    • Tests in §1 explicitly demonstrate that the OLD tri-path admin
//      surface (seeded doc, email allow-list) is now DENIED.
//    • Tests in §2 demonstrate the tablet is locked out of the collections
//      it could reach before via the email allow-list.
//    • Tests in §3 exercise the new collection end-to-end.
//
//  Local prerequisites (same as tests/firestore-rules.test.js):
//    • Java 17+ (the Firestore emulator runs on the JVM)
//    • `firebase-tools` devDep
//    • `@firebase/rules-unit-testing` devDep (installed)
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc,
  Timestamp,
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ID = 'loyalty-ipear-l23a';
const RULES_PATH = join(process.cwd(), 'firestore.rules');

let testEnv;

// Common auth-token shapes reused across tests.
const claimsAdmin  = { admin: true };
const claimsTablet = { role: 'tablet', storeId: 'store-A' };
const claimsTabletB = { role: 'tablet', storeId: 'store-B' };
const claimsCustomer = { email_verified: true };
// Legacy shapes the OLD isAdmin() used to accept; the new rules must reject
// all three.
const claimsLegacyAllowlistedEmail = { email_verified: true, email: 'tablet@ipear.gr' };

// Seeded customer, redemption, and request docs live under fixed IDs so
// individual tests can address them without spelunking.
const CUSTOMER_ID = 'cust-alice';
const CUSTOMER_UID = CUSTOMER_ID;
const REDEMPTION_ID = 'red-001';
const REDEMPTION_CODE = '123456';
const REQUEST_ID_TABLET_A = 'req-store-A-tablet-1';
const REQUEST_ID_TABLET_B = 'req-store-B-tablet-2';
const TABLET_UID_A = 'tablet-1';
const TABLET_UID_A_OTHER = 'tablet-1-other'; // same store, different actor
const TABLET_UID_B = 'tablet-2';
const ADMIN_UID = 'admin-1';

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

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    // Customer with 3000 total / 1200 current points.
    await setDoc(doc(db, 'ipear_customers', CUSTOMER_ID), {
      uid: CUSTOMER_UID,
      email: 'alice@example.com',
      name: 'Alice Wonderland',
      phone: '6912345678',
      card: 'IP-ABC123',
      points: 1200,
      totalPoints: 3000,
      birthday: '1990-05-04',
      blocked: false,
      referralProcessed: false,
      referralCount: 0,
      marketingOptIn: true,
      createdAt: '2020-01-01T00:00:00Z',
    });

    // Pending redemption code.
    const now = Timestamp.now();
    const later = Timestamp.fromMillis(Date.now() + 10 * 60 * 1000);
    await setDoc(doc(db, 'ipear_redemptions', REDEMPTION_ID), {
      code: REDEMPTION_CODE,
      customerId: CUSTOMER_ID,
      customerUid: CUSTOMER_UID,
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

    // Legacy ipear_admins docs — under the OLD rules these gave any UID
    // full admin power. Under the NEW rules they are metadata only (the
    // authoritative signal is the `admin: true` custom claim). We seed one
    // to prove that the doc's mere presence no longer grants admin.
    await setDoc(doc(db, 'ipear_admins', 'legacy-doc-uid'), {
      addedAt: '2026-01-01T00:00:00Z',
    });

    // Two pending approval requests: one owned by tablet-1 in store-A,
    // one by tablet-2 in store-B. Used to prove the read-scoping rules.
    await setDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_A), {
      type: 'redeem',
      code: REDEMPTION_CODE,
      storeId: 'store-A',
      tabletActorUid: TABLET_UID_A,
      customerId: CUSTOMER_ID,
      customerUid: CUSTOMER_UID,
      rewardId: null,
      rewardLabel: '5€ Έκπτωση',
      rewardCost: 500,
      redemptionRefPath: `ipear_redemptions/${REDEMPTION_ID}`,
      status: 'pending',
      requestedAt: now.toDate().toISOString(),
      requestedAtTs: now,
      expiresAt: later.toDate().toISOString(),
      expiresAtTs: later,
    });
    await setDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_B), {
      type: 'redeem',
      code: REDEMPTION_CODE,
      storeId: 'store-B',
      tabletActorUid: TABLET_UID_B,
      customerId: CUSTOMER_ID,
      customerUid: CUSTOMER_UID,
      rewardId: null,
      rewardLabel: '5€ Έκπτωση',
      rewardCost: 500,
      redemptionRefPath: `ipear_redemptions/${REDEMPTION_ID}`,
      status: 'pending',
      requestedAt: now.toDate().toISOString(),
      requestedAtTs: now,
      expiresAt: later.toDate().toISOString(),
      expiresAtTs: later,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §1 · isAdmin() is now claim-only — the legacy fallbacks are GONE
// ═══════════════════════════════════════════════════════════════════════════
describe('§1 · isAdmin() claim-only enforcement (failing-before, passing-after)', () => {
  it('OLD path: seeded ipear_admins/{uid} doc without claim → DENIED admin operations', async () => {
    // Under OLD rules this uid was admin via `exists(...)`. Under new rules
    // it isn't — because there is no `admin: true` claim on the token.
    const legacy = testEnv.authenticatedContext('legacy-doc-uid', { email_verified: true });
    const db = legacy.firestore();
    // Admin-gated read on audit_logs:
    await assertFails(getDoc(doc(db, 'audit_logs', 'anything')));
    // Admin-gated read on ipear_analytics:
    await assertFails(getDoc(doc(db, 'ipear_analytics', 'today')));
    // Admin-gated update on another customer:
    await assertFails(updateDoc(doc(db, 'ipear_customers', CUSTOMER_ID), {
      points: 9999, blocked: true,
    }));
  });

  it('OLD path: hardcoded email allow-list (tablet@ipear.gr) → DENIED admin operations', async () => {
    // Under the OLD rules this token was admin. Under the new rules it isn't.
    const legacy = testEnv.authenticatedContext('legacy-email-uid', claimsLegacyAllowlistedEmail);
    const db = legacy.firestore();
    await assertFails(getDoc(doc(db, 'audit_logs', 'anything')));
    await assertFails(updateDoc(doc(db, 'ipear_customers', CUSTOMER_ID), {
      points: 9999,
    }));
  });

  it('NEW path: admin:true claim → ALLOWED admin ops, but DIRECT balance write DENIED (§6b lock)', async () => {
    const admin = testEnv.authenticatedContext(ADMIN_UID, claimsAdmin);
    const db = admin.firestore();
    await assertSucceeds(getDoc(doc(db, 'ipear_customers', CUSTOMER_ID)));
    // ADMIN FORTRESS §6b: a valid admin session may NOT directly mutate the
    // loyalty balance — financial state is server-authoritative only.
    await assertFails(updateDoc(doc(db, 'ipear_customers', CUSTOMER_ID), {
      points: 999,
    }));
    // Non-financial admin edits remain ALLOWED (block / name / tier / suspicious):
    await assertSucceeds(updateDoc(doc(db, 'ipear_customers', CUSTOMER_ID), {
      blocked: true,
    }));
    // audit_logs create by admin remains allowed (not the locked admin_audit):
    await assertSucceeds(setDoc(doc(db, 'audit_logs', 'test-audit-1'), {
      action: 'test',
      approverUid: ADMIN_UID,
      createdAt: new Date().toISOString(),
    }));
  });

  it('Tablet claim (role=tablet) never satisfies isAdmin() — cannot read audit_logs', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(getDoc(doc(db, 'audit_logs', 'anything')));
    await assertFails(getDoc(doc(db, 'ipear_analytics', 'today')));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 · Tablet is locked out of every collection it could reach before
// ═══════════════════════════════════════════════════════════════════════════
describe('§2 · Tablet lockout (failing-before, passing-after)', () => {
  it('tablet cannot READ ipear_customers directly (no field-level projection)', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(getDoc(doc(db, 'ipear_customers', CUSTOMER_ID)));
  });

  it('tablet cannot UPDATE ipear_customers', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(updateDoc(doc(db, 'ipear_customers', CUSTOMER_ID), {
      points: 0,
    }));
  });

  it('tablet cannot CREATE ipear_transactions (ledger)', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(setDoc(doc(db, 'ipear_transactions', 'tablet-cant-do-this'), {
      customerId: CUSTOMER_ID,
      type: 'redeem',
      points: -500,
      date: new Date().toISOString(),
    }));
  });

  it('tablet cannot CREATE audit_logs', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(setDoc(doc(db, 'audit_logs', 'tablet-cant-do-this'), {
      action: 'redeem_approved',
      approverUid: TABLET_UID_A,
      createdAt: new Date().toISOString(),
    }));
  });

  it('tablet cannot UPDATE ipear_redemptions.used = true (was allowed via admin allow-list)', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(updateDoc(doc(db, 'ipear_redemptions', REDEMPTION_ID), {
      used: true, status: 'used', usedAt: new Date().toISOString(),
    }));
  });

  it('tablet cannot READ ipear_redemptions directly (no customerUid match)', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(getDoc(doc(db, 'ipear_redemptions', REDEMPTION_ID)));
  });

  it('tablet cannot WRITE settings / offers / rewards / stores / admins', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(setDoc(doc(db, 'settings', 'system'), { maintenance: true }));
    await assertFails(setDoc(doc(db, 'ipear_offers', 'evil-offer'), {
      title: 'FREE POINTS', active: true, bonusPoints: 100000,
    }));
    await assertFails(setDoc(doc(db, 'ipear_rewards', 'evil-reward'), {
      cost: 1, discount: 30, isActive: true, title: 'evil',
    }));
    await assertFails(setDoc(doc(db, 'ipear_stores', 'evil-store'), {
      name: 'evil', city: 'evil',
    }));
    await assertFails(setDoc(doc(db, 'ipear_admins', 'promote-self'), {
      addedAt: new Date().toISOString(),
    }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 · New collection ipear_redemption_requests
// ═══════════════════════════════════════════════════════════════════════════
describe('§3 · ipear_redemption_requests read scoping + write lockdown', () => {
  it('admin (claim) can READ any request', async () => {
    const admin = testEnv.authenticatedContext(ADMIN_UID, claimsAdmin);
    const db = admin.firestore();
    await assertSucceeds(getDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_A)));
    await assertSucceeds(getDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_B)));
  });

  it('tablet-1 (store-A) can READ OWN request (own actorUid + own storeId)', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertSucceeds(getDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_A)));
  });

  it('tablet-1 (store-A) CANNOT read another actor\'s request in same store', async () => {
    // First seed a request from a DIFFERENT actor in store-A.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'ipear_redemption_requests', 'req-store-A-other'), {
        type: 'redeem', code: REDEMPTION_CODE, storeId: 'store-A',
        tabletActorUid: TABLET_UID_A_OTHER,
        customerId: CUSTOMER_ID, customerUid: CUSTOMER_UID,
        rewardCost: 500, rewardLabel: '5€',
        redemptionRefPath: `ipear_redemptions/${REDEMPTION_ID}`,
        status: 'pending',
        expiresAtTs: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
      });
    });
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(getDoc(doc(db, 'ipear_redemption_requests', 'req-store-A-other')));
  });

  it('tablet-A cannot READ a request from store-B', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(getDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_B)));
  });

  it('tablet-B (with matching actorUid) cannot READ store-A request', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTabletB);
    const db = tablet.firestore();
    // Even though this token's uid == TABLET_UID_A which matches the request's
    // tabletActorUid, the storeId claim mismatches → DENIED.
    await assertFails(getDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_A)));
  });

  it('unauthenticated cannot READ any request', async () => {
    const anon = testEnv.unauthenticatedContext();
    const db = anon.firestore();
    await assertFails(getDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_A)));
  });

  it('customer (not admin, not tablet) cannot READ any request', async () => {
    const customer = testEnv.authenticatedContext(CUSTOMER_UID, claimsCustomer);
    const db = customer.firestore();
    await assertFails(getDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_A)));
  });

  it('tablet CANNOT CREATE requests (write reserved for admin SDK / CF)', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(setDoc(doc(db, 'ipear_redemption_requests', 'sneaky-request'), {
      type: 'redeem', code: REDEMPTION_CODE, storeId: 'store-A',
      tabletActorUid: TABLET_UID_A,
      customerId: CUSTOMER_ID, customerUid: CUSTOMER_UID,
      rewardCost: 500, rewardLabel: '5€',
      redemptionRefPath: `ipear_redemptions/${REDEMPTION_ID}`,
      status: 'pending',
      expiresAtTs: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
    }));
  });

  it('tablet CANNOT UPDATE own request (approve/reject reserved for admin SDK / CF)', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(updateDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_A), {
      status: 'approved',
    }));
  });

  it('tablet CANNOT DELETE own request', async () => {
    const tablet = testEnv.authenticatedContext(TABLET_UID_A, claimsTablet);
    const db = tablet.firestore();
    await assertFails(deleteDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_A)));
  });

  it('admin CANNOT CREATE requests from the client (admin SDK only)', async () => {
    const admin = testEnv.authenticatedContext(ADMIN_UID, claimsAdmin);
    const db = admin.firestore();
    await assertFails(setDoc(doc(db, 'ipear_redemption_requests', 'admin-sneaky'), {
      type: 'redeem', code: REDEMPTION_CODE, storeId: 'store-A',
      tabletActorUid: ADMIN_UID,
      customerId: CUSTOMER_ID, customerUid: CUSTOMER_UID,
      rewardCost: 500, rewardLabel: '5€',
      redemptionRefPath: `ipear_redemptions/${REDEMPTION_ID}`,
      status: 'pending',
      expiresAtTs: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
    }));
  });

  it('admin CANNOT UPDATE requests from the client (admin SDK only)', async () => {
    const admin = testEnv.authenticatedContext(ADMIN_UID, claimsAdmin);
    const db = admin.firestore();
    await assertFails(updateDoc(doc(db, 'ipear_redemption_requests', REQUEST_ID_TABLET_A), {
      status: 'approved',
    }));
  });

  it('with rules disabled (admin SDK simulation), writes SUCCEED — proves the CF path works', async () => {
    // The `withSecurityRulesDisabled` context emulates the Admin SDK path
    // used by the callable Cloud Functions. Nothing here contradicts §3.
    let ok = true;
    try {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'ipear_redemption_requests', 'server-side-created'), {
          type: 'redeem', code: '999999', storeId: 'store-A',
          tabletActorUid: TABLET_UID_A,
          customerId: CUSTOMER_ID, customerUid: CUSTOMER_UID,
          rewardCost: 500, rewardLabel: '5€',
          redemptionRefPath: `ipear_redemptions/${REDEMPTION_ID}`,
          status: 'pending',
          expiresAtTs: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
        });
      });
    } catch (_) {
      ok = false;
    }
    expect(ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 · Legacy customer paths still work (regression guard)
// ═══════════════════════════════════════════════════════════════════════════
describe('§4 · Customer flow regression guard (unchanged after L2.3A)', () => {
  it('customer reads OWN doc via uid path', async () => {
    const alice = testEnv.authenticatedContext(CUSTOMER_UID, claimsCustomer);
    const db = alice.firestore();
    await assertSucceeds(getDoc(doc(db, 'ipear_customers', CUSTOMER_ID)));
  });

  it('customer cannot read another customer\'s doc', async () => {
    const bob = testEnv.authenticatedContext('bob-uid', { email_verified: true });
    const db = bob.firestore();
    await assertFails(getDoc(doc(db, 'ipear_customers', CUSTOMER_ID)));
  });

  it('customer cannot flip financial fields on OWN doc', async () => {
    const alice = testEnv.authenticatedContext(CUSTOMER_UID, claimsCustomer);
    const db = alice.firestore();
    await assertFails(updateDoc(doc(db, 'ipear_customers', CUSTOMER_ID), {
      points: 99999, blocked: false,
    }));
  });

  it('customer can create OWN redemption code (legacy ladder branch)', async () => {
    const alice = testEnv.authenticatedContext(CUSTOMER_UID, claimsCustomer);
    const db = alice.firestore();
    const now = Timestamp.now();
    const later = Timestamp.fromMillis(Date.now() + 5 * 60 * 1000);
    await assertSucceeds(setDoc(doc(db, 'ipear_redemptions', 'red-new'), {
      code: '654321',
      customerId: CUSTOMER_ID,
      customerUid: CUSTOMER_UID,
      customerName: 'Alice',
      card: 'IP-ABC123',
      points: 1000,
      discount: 5,
      label: '5€ Έκπτωση',
      status: 'pending',
      used: false,
      createdAt: now.toDate().toISOString(),
      expiresAt: later.toDate().toISOString(),
      createdAtTs: now,
      expiresAtTs: later,
    }));
  });
});
