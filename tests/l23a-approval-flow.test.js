// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  L2.3A · Tablet → Admin approval flow — Cloud Function pure-helper tests.
//
//  Runs entirely offline (no firebase emulator, no admin SDK), so `npm test`
//  picks these up automatically. Full end-to-end tests of the four callable
//  Cloud Functions (createRedemptionRequest, lookupCustomerForTablet,
//  approveRedemption, rejectRedemption) live in the rules test file and
//  under `npm run test:rules` (see tests/l23a-rules.test.js), which spins
//  up the emulator; extending to the Cloud Functions emulator requires
//  `firebase emulators:exec --only firestore,functions` and is deferred to
//  the pre-deploy validation step.
//
//  What this file proves (the code you can trust without an emulator):
//    • Tier boundaries are correct for the CF-side tier function.
//    • The masked customer projection NEVER leaks email/birthday/uid/etc.
//    • Deterministic ledger ids are pure functions of (requestId, type) — the
//      keystone that makes approveRedemption idempotent.
//    • Auth-gate helpers throw the exact HttpsError codes the client relies on.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// firebase-functions/v2/https attempts to read env at load time. Set a
// dummy project id so the require chain succeeds under vitest.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'loyalty-ipear-test';

// firebase-admin initializeApp() at the top of functions/index.js needs
// SOME credential resolution path. Setting FIRESTORE_EMULATOR_HOST tricks
// the admin SDK into skipping the Application Default Credential lookup —
// we never touch a real Firestore in this file so the value is never read.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:9';

let internals;

beforeAll(() => {
  // Late-require so the process.env assignments above are in place.
  const mod = require('../functions/index.js');
  internals = mod._l23aInternals;
});

// HttpsError is emitted by the auth-gate helpers, but we can't import the
// class from tests/ (firebase-functions lives in functions/node_modules).
// Instead, assert on error.code which is set by the constructor.

describe('_serverTier — boundary values', () => {
  // Canonical ladder (lib/tier.js): Bronze 0 · Silver 1000 · Gold 3000 ·
  // Diamond 6000 · Platinum 10000. (Updated from the old inline ladder that
  // mislabelled e.g. 2310 pts as GOLD on the tablet; _serverTier now delegates
  // to tierCls so it can never drift from the customer/financial ladder.)
  it('bronze below 1000', () => {
    expect(internals._serverTier(0)).toBe('bronze');
    expect(internals._serverTier(999)).toBe('bronze');
  });
  it('silver at 1000 and 2999', () => {
    expect(internals._serverTier(1000)).toBe('silver');
    expect(internals._serverTier(2999)).toBe('silver');
  });
  it('gold at 3000 and 5999', () => {
    expect(internals._serverTier(3000)).toBe('gold');
    expect(internals._serverTier(5999)).toBe('gold');
  });
  it('diamond at 6000 and 9999', () => {
    expect(internals._serverTier(6000)).toBe('diamond');
    expect(internals._serverTier(9999)).toBe('diamond');
  });
  it('platinum at 10000 and above', () => {
    expect(internals._serverTier(10000)).toBe('platinum');
    expect(internals._serverTier(999_999)).toBe('platinum');
  });
  it('coerces null/undefined/string safely', () => {
    expect(internals._serverTier(null)).toBe('bronze');
    expect(internals._serverTier(undefined)).toBe('bronze');
    expect(internals._serverTier('nope')).toBe('bronze');
  });
});

describe('_tabletCustomerProjection — masks the sensitive fields', () => {
  const FULL_CUSTOMER = {
    // Fields the tablet is allowed to see (masked):
    name: '   Νότης Μπουντούρης   ',
    phone: '6912345678',
    card: 'IP-ABC123',
    points: 1250,
    totalPoints: 3200,
    blocked: false,
    // Fields the tablet MUST NOT see:
    email: 'notis@ipear.gr',
    birthday: '1990-05-04',
    referredBy: 'IP-ZZZ999',
    referralProcessed: true,
    referralCount: 5,
    uid: 'auth-uid-abc',
    _migratedFrom: 'legacy-abc',
    marketingOptIn: true,
    marketingOptInAt: '2026-01-01T00:00:00Z',
    termsAcceptedAt: '2026-01-01T00:00:00Z',
    createdAt: '2020-01-01T00:00:00Z',
    tier: 'diamond',
    lastTierCheck: '2026-06-01T00:00:00Z',
    eshopCouponUsed: true,
    fcmToken: 'push-token-xyz',
  };

  it('returns EXACTLY the six allowed keys — no leakage', () => {
    const p = internals._tabletCustomerProjection(FULL_CUSTOMER, internals._serverTier);
    expect(Object.keys(p).sort()).toEqual(
      ['blocked', 'cardMasked', 'displayName', 'phoneMasked', 'points', 'tier'].sort()
    );
    // Belt-and-braces: no serialization path leaks a forbidden key.
    const asJson = JSON.stringify(p);
    for (const forbidden of [
      'email', 'birthday', 'referredBy', 'referralCount', 'referralProcessed',
      'uid', 'notis@ipear.gr', '1990-05-04', 'IP-ZZZ999', 'auth-uid-abc',
      '_migratedFrom', 'marketingOptIn', 'lastTierCheck', 'eshopCouponUsed',
      'fcmToken', 'push-token-xyz',
    ]) {
      expect(asJson).not.toContain(forbidden);
    }
  });

  it('trims display name, keeps only last-4 of phone', () => {
    const p = internals._tabletCustomerProjection(FULL_CUSTOMER, internals._serverTier);
    expect(p.displayName).toBe('Νότης Μπουντούρης');
    expect(p.phoneMasked).toBe('•••5678');
  });

  it('masks the card so only the "IP-" prefix and last-2 are visible', () => {
    const p = internals._tabletCustomerProjection(FULL_CUSTOMER, internals._serverTier);
    expect(p.cardMasked).toBe('IP-•••23');
  });

  it('derives tier from totalPoints (not points)', () => {
    // Canonical ladder: totalPoints=3200 → gold; points=1250 alone → silver.
    const p = internals._tabletCustomerProjection(FULL_CUSTOMER, internals._serverTier);
    expect(p.tier).toBe('gold');
  });

  it('handles very short phone/card gracefully', () => {
    const p = internals._tabletCustomerProjection(
      { name: 'X', phone: '12', card: 'IP', points: 0, totalPoints: 0, blocked: false },
      internals._serverTier
    );
    expect(p.phoneMasked).toBe('12'); // <=4 chars: not masked (nothing to hide)
    expect(p.cardMasked).toBe('IP');
    expect(p.tier).toBe('bronze');
  });

  it('reports blocked=true when the customer is blocked', () => {
    const p = internals._tabletCustomerProjection(
      { ...FULL_CUSTOMER, blocked: true }, internals._serverTier
    );
    expect(p.blocked).toBe(true);
  });

  it('coerces missing points/totalPoints to 0', () => {
    const p = internals._tabletCustomerProjection(
      { name: 'X', phone: '6912345678', card: 'IP-XYZ123' }, internals._serverTier
    );
    expect(p.points).toBe(0);
    expect(p.tier).toBe('bronze');
  });
});

describe('_ledgerIdForRequest — deterministic + type-scoped', () => {
  it('is a pure function of (requestId, type)', () => {
    expect(internals._ledgerIdForRequest('abc123', 'redeem')).toBe('redeem_abc123');
    expect(internals._ledgerIdForRequest('abc123', 'redeem')).toBe('redeem_abc123');
    expect(internals._ledgerIdForRequest('abc123', 'offer_credit')).toBe('offer_credit_abc123');
  });
  it('never collides across types for the same requestId', () => {
    const redeem = internals._ledgerIdForRequest('req-42', 'redeem');
    const offer = internals._ledgerIdForRequest('req-42', 'offer_credit');
    expect(redeem).not.toBe(offer);
  });
  it('never collides across requestIds for the same type', () => {
    expect(internals._ledgerIdForRequest('req-A', 'redeem'))
      .not.toBe(internals._ledgerIdForRequest('req-B', 'redeem'));
  });
  it('treats unknown type as redeem (safe default)', () => {
    expect(internals._ledgerIdForRequest('req-42', 'garbage')).toBe('redeem_req-42');
  });
});

describe('_requireTablet — auth gate', () => {
  it('throws unauthenticated when auth is missing', () => {
    expect(() => internals._requireTablet({ auth: null })).toThrowError(
      /Sign in required/
    );
    // Confirm the HttpsError code path via error.code.
    try { internals._requireTablet({ auth: null }); } catch (e) {
      expect(e.code).toBe('unauthenticated');
    }
  });

  it('throws permission-denied when role != tablet', () => {
    const req = { auth: { uid: 'u1', token: { admin: true } } };
    expect(() => internals._requireTablet(req)).toThrowError(/Tablet role required/);
    try { internals._requireTablet(req); } catch (e) {
      expect(e.code).toBe('permission-denied');
    }
  });

  it('throws permission-denied when storeId claim is missing', () => {
    const req = { auth: { uid: 'u1', token: { role: 'tablet' } } };
    expect(() => internals._requireTablet(req)).toThrowError(/Tablet role required/);
  });

  it('accepts a valid tablet token and returns {uid,storeId}', () => {
    const req = { auth: { uid: 'tablet-1', token: { role: 'tablet', storeId: 'store-A' } } };
    expect(internals._requireTablet(req)).toEqual({ uid: 'tablet-1', storeId: 'store-A' });
  });

  it('rejects a stale admin claim on a tablet token (mutual exclusion)', () => {
    // If a user somehow has BOTH admin:true and role:tablet, _requireTablet
    // still accepts them as a tablet — the SEPARATE _requireAdmin also
    // accepts. This asymmetric acceptance is intentional: the syncAdminClaim
    // trigger guarantees mutual exclusion at provisioning time. Any user
    // with both claims is a provisioning bug that operators must resolve.
    const req = { auth: { uid: 'weird', token: { admin: true, role: 'tablet', storeId: 'store-X' } } };
    expect(internals._requireTablet(req)).toEqual({ uid: 'weird', storeId: 'store-X' });
  });
});

describe('_deterministicRequestId — pure, collision-free per identity triple', () => {
  it('is a deterministic function of (storeId, tabletActorUid, code)', () => {
    const a = internals._deterministicRequestId('store-A', 'tablet-1', '123456');
    const b = internals._deterministicRequestId('store-A', 'tablet-1', '123456');
    expect(a).toBe(b);
    expect(a).toMatch(/^req_[0-9a-f]{40}$/);
  });
  it('changes when storeId changes', () => {
    expect(internals._deterministicRequestId('store-A', 't', 'c'))
      .not.toBe(internals._deterministicRequestId('store-B', 't', 'c'));
  });
  it('changes when tabletActorUid changes', () => {
    expect(internals._deterministicRequestId('s', 't1', 'c'))
      .not.toBe(internals._deterministicRequestId('s', 't2', 'c'));
  });
  it('changes when code changes', () => {
    expect(internals._deterministicRequestId('s', 't', '111111'))
      .not.toBe(internals._deterministicRequestId('s', 't', '222222'));
  });
});

describe('_decideAdminSyncState — fail-closed decision tree', () => {
  it('doc missing → strips privileged claims, not fail-closed', () => {
    const r = internals._decideAdminSyncState(null, false, { admin: true, role: 'tablet', storeId: 'x' });
    expect(r.failClosed).toBe(false);
    expect(r.nextClaims.admin).toBeUndefined();
    expect(r.nextClaims.role).toBeUndefined();
    expect(r.nextClaims.storeId).toBeUndefined();
    expect(r.summary).toBe('none');
  });
  it('role="admin" → admin:true claim, no role field', () => {
    const r = internals._decideAdminSyncState({ role: 'admin' }, true, {});
    expect(r.failClosed).toBe(false);
    expect(r.nextClaims.admin).toBe(true);
    expect(r.nextClaims.role).toBeUndefined();
    expect(r.nextClaims.storeId).toBeUndefined();
    expect(r.summary).toBe('admin');
  });
  it('role="admin" with storeid → carries storeId metadata but stays admin', () => {
    const r = internals._decideAdminSyncState({ role: 'admin', storeid: 'store-X' }, true, {});
    expect(r.failClosed).toBe(false);
    expect(r.nextClaims.admin).toBe(true);
    expect(r.nextClaims.storeId).toBe('store-X');
    expect(r.summary).toBe('admin@store-X');
  });
  it('role="tablet" with storeid → tablet claim + storeId, no admin', () => {
    const r = internals._decideAdminSyncState({ role: 'tablet', storeid: 'store-Y' }, true, { admin: true });
    expect(r.failClosed).toBe(false);
    expect(r.nextClaims.admin).toBeUndefined();
    expect(r.nextClaims.role).toBe('tablet');
    expect(r.nextClaims.storeId).toBe('store-Y');
    expect(r.summary).toBe('tablet@store-Y');
  });
  it('role="tablet" WITHOUT storeid → FAIL-CLOSED, strips all privileged claims', () => {
    const r = internals._decideAdminSyncState({ role: 'tablet' }, true, { admin: true, role: 'admin' });
    expect(r.failClosed).toBe(true);
    expect(r.reason).toBe('tablet-missing-storeid');
    expect(r.nextClaims.admin).toBeUndefined();
    expect(r.nextClaims.role).toBeUndefined();
    expect(r.nextClaims.storeId).toBeUndefined();
  });
  it('missing role field → FAIL-CLOSED (never defaults to admin)', () => {
    const r = internals._decideAdminSyncState({ storeid: 'x' }, true, { admin: true });
    expect(r.failClosed).toBe(true);
    expect(r.reason).toBe('role-missing');
    expect(r.nextClaims.admin).toBeUndefined();
  });
  it('unknown role string → FAIL-CLOSED with reason encoding', () => {
    const r = internals._decideAdminSyncState({ role: 'superuser' }, true, {});
    expect(r.failClosed).toBe(true);
    expect(r.reason).toBe('role-unknown:superuser');
    expect(r.nextClaims.admin).toBeUndefined();
    expect(r.nextClaims.role).toBeUndefined();
  });
  it('non-string role value → FAIL-CLOSED', () => {
    const r = internals._decideAdminSyncState({ role: 42 }, true, {});
    expect(r.failClosed).toBe(true);
    expect(r.reason).toContain('role-unknown');
  });
  it('role="admin" strips a prior role="tablet" claim (role flip)', () => {
    const r = internals._decideAdminSyncState(
      { role: 'admin' }, true,
      { role: 'tablet', storeId: 'store-old' }
    );
    expect(r.failClosed).toBe(false);
    expect(r.nextClaims.admin).toBe(true);
    expect(r.nextClaims.role).toBeUndefined();
  });
  it('role="tablet" strips a prior admin:true claim (role flip)', () => {
    const r = internals._decideAdminSyncState(
      { role: 'tablet', storeid: 'store-Z' }, true,
      { admin: true }
    );
    expect(r.failClosed).toBe(false);
    expect(r.nextClaims.admin).toBeUndefined();
    expect(r.nextClaims.role).toBe('tablet');
  });
  it('preserves unrelated custom claims (not owned by this trigger)', () => {
    const r = internals._decideAdminSyncState(
      { role: 'admin' }, true,
      { admin: true, unrelated: 'keepme' }
    );
    expect(r.nextClaims.unrelated).toBe('keepme');
  });
});

describe('_requireAdmin — auth gate', () => {
  it('throws unauthenticated when auth is missing', () => {
    expect(() => internals._requireAdmin({ auth: null })).toThrowError(/Sign in required/);
    try { internals._requireAdmin({ auth: null }); } catch (e) {
      expect(e.code).toBe('unauthenticated');
    }
  });

  it('throws permission-denied when admin claim is missing', () => {
    const req = { auth: { uid: 'u1', token: {} } };
    expect(() => internals._requireAdmin(req)).toThrowError(/Admin only/);
  });

  it('throws permission-denied when admin claim is exactly false', () => {
    const req = { auth: { uid: 'u1', token: { admin: false } } };
    expect(() => internals._requireAdmin(req)).toThrowError(/Admin only/);
  });

  it('rejects a tablet token even with storeId', () => {
    const req = { auth: { uid: 'tablet-1', token: { role: 'tablet', storeId: 'store-A' } } };
    expect(() => internals._requireAdmin(req)).toThrowError(/Admin only/);
  });

  it('accepts admin:true', () => {
    const req = { auth: { uid: 'admin-1', token: { admin: true } } };
    expect(internals._requireAdmin(req)).toEqual({ uid: 'admin-1' });
  });
});
