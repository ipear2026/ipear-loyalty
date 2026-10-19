// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS · Stage 0/1 — offline adversarial + unit tests.
//
//  Proves (no emulator required):
//   • OWNER gate (owner.js / _requireOwner): fail-closed config, admin-claim +
//     allowlist enforcement, and the full denial matrix.
//   • Adjustment intent validation (admin-financial.js): rejects every tampered
//     / malformed input; never trusts newBalance/role/actor/timestamp/ledgerId.
//   • planAdjustment: server-authoritative compute, idempotency decision,
//     insufficient-balance / blocked / not-found denials, and exact write
//     payloads (ledger + immutable audit) for a valid owner mutation.
//
//  Concurrency (one-commit-per-key) is a Firestore-transaction property proven
//  by the deterministic id here + the emulator/integration layer (deferred to
//  the functions emulator, mirroring approveRedemption).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'loyalty-ipear-test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:9';

const owner = require('../functions/lib/owner.js');
const fin = require('../functions/lib/admin-financial.js');

let internals;
beforeAll(() => { internals = require('../functions/index.js')._l23aInternals; });

const OWNER_UID = 'owner-uid-123';
afterEach(() => { delete process.env.OWNER_UIDS; delete process.env.ADMIN_FINANCIAL_ACTIONS_DISABLED; });

// ── OWNER gate ──────────────────────────────────────────────────────────────
describe('owner.parseOwnerUids', () => {
  it('parses, trims, de-dupes; rejects whitespace/empty', () => {
    expect(owner.parseOwnerUids('a, b ,a,,  ,c')).toEqual(['a', 'b', 'c']);
    expect(owner.parseOwnerUids('')).toEqual([]);
    expect(owner.parseOwnerUids(undefined)).toEqual([]);
    expect(owner.parseOwnerUids('has space')).toEqual([]); // internal space → dropped
  });
});

describe('owner.checkOwner — fail-closed single-owner allowlist', () => {
  it('FAIL-CLOSED when OWNER_UIDS missing/empty', () => {
    expect(owner.checkOwner({ admin: true }, OWNER_UID, '').reason).toBe('owner-config-missing');
    expect(owner.checkOwner({ admin: true }, OWNER_UID, undefined).ok).toBe(false);
  });
  it('denies non-admin even if uid is in the allowlist', () => {
    expect(owner.checkOwner({}, OWNER_UID, OWNER_UID).reason).toBe('not-admin');
    expect(owner.checkOwner({ admin: false }, OWNER_UID, OWNER_UID).ok).toBe(false);
  });
  it('denies admin whose uid is NOT the owner', () => {
    expect(owner.checkOwner({ admin: true }, 'other-admin', OWNER_UID).reason).toBe('not-owner');
  });
  it('allows the configured owner admin', () => {
    expect(owner.checkOwner({ admin: true }, OWNER_UID, `x,${OWNER_UID},y`)).toEqual({ ok: true });
  });
});

describe('_requireOwner (handler gate) — adversarial matrix', () => {
  const call = (req) => { try { internals._requireOwner(req, 'adminAdjustPoints'); return 'ALLOWED'; } catch (e) { return e.code; } };
  it('logged-out → unauthenticated', () => {
    process.env.OWNER_UIDS = OWNER_UID;
    expect(call({ auth: null })).toBe('unauthenticated');
  });
  it('normal user (no claim) → permission-denied', () => {
    process.env.OWNER_UIDS = OWNER_UID;
    expect(call({ auth: { uid: 'u1', token: {} } })).toBe('permission-denied');
  });
  it('verified customer (no admin) → permission-denied', () => {
    process.env.OWNER_UIDS = OWNER_UID;
    expect(call({ auth: { uid: 'u1', token: { email_verified: true } } })).toBe('permission-denied');
  });
  it('tablet role → permission-denied', () => {
    process.env.OWNER_UIDS = OWNER_UID;
    expect(call({ auth: { uid: 't1', token: { role: 'tablet', storeId: 's1' } } })).toBe('permission-denied');
  });
  it('forged admin field in request body is ignored (only verified token counts)', () => {
    process.env.OWNER_UIDS = OWNER_UID;
    // token has NO admin claim; a client-supplied data.admin must not help.
    expect(call({ auth: { uid: 'u1', token: {} }, data: { admin: true } })).toBe('permission-denied');
  });
  it('admin claim but WRONG owner uid → permission-denied', () => {
    process.env.OWNER_UIDS = OWNER_UID;
    expect(call({ auth: { uid: 'rogue-admin', token: { admin: true } } })).toBe('permission-denied');
  });
  it('config missing → fail-closed permission-denied even for real owner', () => {
    expect(call({ auth: { uid: OWNER_UID, token: { admin: true } } })).toBe('permission-denied');
  });
  it('valid owner-admin → ALLOWED', () => {
    process.env.OWNER_UIDS = OWNER_UID;
    expect(call({ auth: { uid: OWNER_UID, token: { admin: true } } })).toBe('ALLOWED');
  });
});

describe('_financialActionsDisabled (kill-switch placeholder)', () => {
  it('defaults to false; true only when env === "true"', () => {
    expect(internals._financialActionsDisabled()).toBe(false);
    process.env.ADMIN_FINANCIAL_ACTIONS_DISABLED = 'true';
    expect(internals._financialActionsDisabled()).toBe(true);
    process.env.ADMIN_FINANCIAL_ACTIONS_DISABLED = 'yes';
    expect(internals._financialActionsDisabled()).toBe(false);
  });
});

// ── Intent validation ────────────────────────────────────────────────────────
describe('validateAdjustInput — rejects tampered/malformed intents', () => {
  const base = { customerId: 'c1', operation: 'add', amount: 10, reason: 'test reason', idempotencyKey: 'ik_abcdefgh' };
  it('accepts a valid intent', () => expect(fin.validateAdjustInput(base).ok).toBe(true));
  it('ignores extra client fields (newBalance/role/actorUid/timestamp/ledgerId)', () => {
    const r = fin.validateAdjustInput({ ...base, newBalance: 999999, role: 'owner', actorUid: 'x', date: '2020', ledgerId: 'y' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ customerId: 'c1', operation: 'add', amount: 10, reason: 'test reason', idempotencyKey: 'ik_abcdefgh' });
  });
  it('rejects bad customerId / operation', () => {
    expect(fin.validateAdjustInput({ ...base, customerId: '' }).reason).toBe('bad-customerId');
    expect(fin.validateAdjustInput({ ...base, operation: 'delete' }).reason).toBe('bad-operation');
    expect(fin.validateAdjustInput({ ...base, operation: 'set' }).reason).toBe('bad-operation');
  });
  it('rejects malformed amounts', () => {
    expect(fin.validateAdjustInput({ ...base, amount: 'x' }).reason).toBe('bad-amount');
    expect(fin.validateAdjustInput({ ...base, amount: 1.5 }).reason).toBe('bad-amount');
    expect(fin.validateAdjustInput({ ...base, amount: NaN }).reason).toBe('bad-amount');
    expect(fin.validateAdjustInput({ ...base, operation: 'add', amount: 0 }).reason).toBe('amount-must-be-positive');
    expect(fin.validateAdjustInput({ ...base, operation: 'subtract', amount: -5 }).reason).toBe('amount-must-be-positive');
    expect(fin.validateAdjustInput({ ...base, operation: 'correct', amount: 0 }).reason).toBe('amount-must-be-nonzero');
  });
  it('enforces the magnitude cap', () => {
    expect(fin.validateAdjustInput({ ...base, amount: fin.MAX_ADJUST_MAGNITUDE + 1 }).reason).toBe('amount-exceeds-limit');
    expect(fin.validateAdjustInput({ ...base, operation: 'correct', amount: -(fin.MAX_ADJUST_MAGNITUDE + 1) }).reason).toBe('amount-exceeds-limit');
  });
  it('requires a sane reason and idempotency key', () => {
    expect(fin.validateAdjustInput({ ...base, reason: 'x' }).reason).toBe('bad-reason');
    expect(fin.validateAdjustInput({ ...base, idempotencyKey: 'short' }).reason).toBe('bad-idempotencyKey');
    expect(fin.validateAdjustInput({ ...base, idempotencyKey: 'has space key' }).reason).toBe('bad-idempotencyKey');
  });
});

// ── planAdjustment (server-authoritative compute + idempotency) ───────────────
describe('planAdjustment — server computes the result, never the client', () => {
  const ctx = { actorUid: OWNER_UID, storeId: null, storeName: null, nowIso: '2026-10-02T00:00:00.000Z' };
  const custState = (over = {}) => ({ exists: true, blocked: false, points: 100, totalPoints: 500, customer: { uid: 'cu', email: 'c@x.gr', name: 'C', card: 'IP-ABC123' }, ...over });
  const inp = (over = {}) => ({ customerId: 'c1', operation: 'add', amount: 50, reason: 'r', idempotencyKey: 'ik_abcdefgh', ...over });

  it('not-found / blocked → deny', () => {
    expect(fin.planAdjustment({ exists: false }, null, inp(), ctx)).toMatchObject({ ok: false, code: 'not-found' });
    expect(fin.planAdjustment(custState({ blocked: true }), null, inp(), ctx)).toMatchObject({ ok: false, code: 'failed-precondition', reason: 'customer-blocked' });
  });
  it('add: result = server balance + delta; totalPoints increases; ledger type add', () => {
    const p = fin.planAdjustment(custState(), null, inp({ operation: 'add', amount: 50 }), ctx);
    expect(p.ok).toBe(true); expect(p.idempotent).toBe(false);
    expect(p.before).toBe(100); expect(p.after).toBe(150); expect(p.newPoints).toBe(150);
    expect(p.customerUpdate).toEqual({ points: 150, totalPoints: 550 });
    expect(p.ledger).toMatchObject({ type: 'add', points: 50, balanceBefore: 100, balanceAfter: 150, source: 'admin_callable', idempotencyKey: 'ik_abcdefgh', createdByAdmin: OWNER_UID });
    expect(p.audit).toMatchObject({ action: 'admin_adjust', actorUid: OWNER_UID, amount: 50, balanceBefore: 100, balanceAfter: 150, success: true, verifiedRole: 'owner-admin' });
  });
  it('subtract: debits; totalPoints unchanged (lifetime); ledger type redeem', () => {
    const p = fin.planAdjustment(custState(), null, inp({ operation: 'subtract', amount: 40 }), ctx);
    expect(p.after).toBe(60);
    expect(p.customerUpdate).toEqual({ points: 60, totalPoints: 500 });
    expect(p.ledger.type).toBe('redeem'); expect(p.ledger.points).toBe(-40);
  });
  it('subtract beyond balance → insufficient-balance deny (no negative state)', () => {
    expect(fin.planAdjustment(custState({ points: 30 }), null, inp({ operation: 'subtract', amount: 50 }), ctx))
      .toMatchObject({ ok: false, code: 'failed-precondition', reason: 'insufficient-balance' });
  });
  it('correct: signed delta; negative does not reduce lifetime', () => {
    const p = fin.planAdjustment(custState(), null, inp({ operation: 'correct', amount: -25 }), ctx);
    expect(p.after).toBe(75); expect(p.customerUpdate.totalPoints).toBe(500); expect(p.ledger.type).toBe('redeem');
  });
  it('IDEMPOTENT: existing ledger row → no writes, returns prior balanceAfter', () => {
    const p = fin.planAdjustment(custState(), { balanceAfter: 150 }, inp(), ctx);
    expect(p).toEqual({ ok: true, idempotent: true, newPoints: 150 });
    expect(p.customerUpdate).toBeUndefined();
  });
  it('deterministic ids collide on the same key (one-commit-per-key mechanism)', () => {
    expect(fin.ledgerIdForKey('ik_zzz')).toBe('adj_ik_zzz');
    expect(fin.auditIdForKey('ik_zzz')).toBe('adj_ik_zzz');
  });
});

// ── Canonical tier ladder (TIER-AUTHORITY: 0/1000/3000/6000/10000) ───────────
const tierLib = require('../functions/lib/tier.js');
describe('canonical tier ladder — every boundary', () => {
  const cases = [
    [0, 0], [999, 0], [1000, 1000], [2999, 1000], [3000, 3000],
    [5999, 3000], [6000, 6000], [9999, 6000], [10000, 10000], [999999, 10000],
  ];
  it('tierFloor matches the authoritative ladder at every boundary', () => {
    for (const [pts, floor] of cases) expect(tierLib.tierFloor(pts)).toBe(floor);
  });
  it('tierName at boundaries', () => {
    expect(tierLib.tierName(999)).toBe('Bronze');
    expect(tierLib.tierName(1000)).toBe('Silver');
    expect(tierLib.tierName(3000)).toBe('Gold');
    expect(tierLib.tierName(6000)).toBe('Diamond');
    expect(tierLib.tierName(10000)).toBe('Platinum');
  });
  it('downgradeTarget drops exactly one tier (floor-1); Bronze → null', () => {
    expect(tierLib.downgradeTarget(500)).toBe(null);   // Bronze → no downgrade
    expect(tierLib.downgradeTarget(999)).toBe(null);
    expect(tierLib.downgradeTarget(1000)).toBe(999);   // Silver → top of Bronze
    expect(tierLib.downgradeTarget(3000)).toBe(2999);  // Gold → top of Silver
    expect(tierLib.downgradeTarget(6000)).toBe(5999);  // Diamond → top of Gold
    expect(tierLib.downgradeTarget(10000)).toBe(9999); // Platinum → top of Diamond
    expect(tierLib.downgradeTarget(15000)).toBe(9999);
  });
});

// ── planMaintenance (expire / tier_downgrade) — server-authoritative batch ────
describe('planMaintenance — expire', () => {
  const ctx = { actorUid: OWNER_UID, year: 2026, nowIso: '2026-10-03T00:00:00.000Z', storeId: null, storeName: null };
  const st = (over={}) => ({ exists:true, points:250, totalPoints:3000, customer:{uid:'cu',email:'c@x.gr',name:'C',card:'IP-ABC'}, ...over });
  it('zeros balance; delta = -current; ledger type expire', () => {
    const p = fin.planMaintenance('expire', 'c1', st(), null, ctx);
    expect(p.ok).toBe(true); expect(p.before).toBe(250); expect(p.after).toBe(0); expect(p.delta).toBe(-250);
    expect(p.customerUpdate).toEqual({ points: 0 });
    expect(p.ledger).toMatchObject({ type:'expire', points:-250, balanceBefore:250, balanceAfter:0, source:'admin_callable' });
    expect(p.audit).toMatchObject({ action:'admin_expire', actorUid:OWNER_UID, success:true });
  });
  it('nothing-to-expire when balance 0 → skip/deny', () => {
    expect(fin.planMaintenance('expire','c1', st({points:0}), null, ctx)).toMatchObject({ ok:false, reason:'nothing-to-expire' });
  });
  it('not-found → deny', () => {
    expect(fin.planMaintenance('expire','c1', { exists:false }, null, ctx)).toMatchObject({ ok:false, code:'not-found' });
  });
  it('idempotent when ledger already exists → no writes', () => {
    const p = fin.planMaintenance('expire','c1', st(), { balanceAfter:0 }, ctx);
    expect(p).toMatchObject({ ok:true, idempotent:true }); expect(p.customerUpdate).toBeUndefined();
  });
});

describe('planMaintenance — tier_downgrade (canonical ladder, no lifetime corruption)', () => {
  const ctx = { actorUid: OWNER_UID, year: 2026, nowIso: '2026-10-03T00:00:00.000Z' };
  const st = (tot) => ({ exists:true, points:100, totalPoints:tot, customer:{uid:'cu'} });
  it('Gold(3000)→2999, Diamond(6000)→5999, Platinum(10000)→9999, Silver(1000)→999', () => {
    expect(fin.planMaintenance('tier_downgrade','c', st(3000), null, ctx).after).toBe(2999);
    expect(fin.planMaintenance('tier_downgrade','c', st(6000), null, ctx).after).toBe(5999);
    expect(fin.planMaintenance('tier_downgrade','c', st(10000), null, ctx).after).toBe(9999);
    expect(fin.planMaintenance('tier_downgrade','c', st(1000), null, ctx).after).toBe(999);
  });
  it('only totalPoints changes (points untouched); diff is negative', () => {
    const p = fin.planMaintenance('tier_downgrade','c', st(6000), null, ctx);
    expect(p.customerUpdate).toEqual({ totalPoints: 5999 }); expect(p.delta).toBe(-1);
    expect(p.ledger).toMatchObject({ type:'tier_downgrade', balanceBefore:6000, balanceAfter:5999 });
  });
  it('Bronze (below 1000) → not eligible, deny', () => {
    expect(fin.planMaintenance('tier_downgrade','c', st(500), null, ctx)).toMatchObject({ ok:false, reason:'not-eligible-bronze' });
  });
  it('idempotent when ledger exists', () => {
    expect(fin.planMaintenance('tier_downgrade','c', st(6000), { balanceAfter:5999 }, ctx)).toMatchObject({ ok:true, idempotent:true });
  });
  it('bad op → invalid-argument', () => {
    expect(fin.planMaintenance('nuke','c', st(6000), null, ctx)).toMatchObject({ ok:false, code:'invalid-argument' });
  });
});

// ── Birthday credit — server-authoritative (gate + validation before any DB) ──
describe('adminBirthdayCredit — owner-gated, server-fixed', () => {
  const h = () => internals._adminBirthdayCreditHandler;
  it('non-owner admin → permission-denied (before any DB access)', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    await expect(h()({ auth: { uid: 'rogue', token: { admin: true } }, data: { customerId: 'c1' } }))
      .rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('logged-out → unauthenticated', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    await expect(h()({ auth: null, data: { customerId: 'c1' } })).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('owner + missing customerId → invalid-argument (server owns amount/key, not the client)', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    await expect(h()({ auth: { uid: OWNER_UID, token: { admin: true } }, data: {} }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });
  it('kill switch → denied', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    process.env.ADMIN_FINANCIAL_ACTIONS_DISABLED = 'true';
    await expect(h()({ auth: { uid: OWNER_UID, token: { admin: true } }, data: { customerId: 'c1' } }))
      .rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

// ── adminVerifyRedemption — reward debit / offer credit (shared canonical logic)
const redeem = require('../functions/lib/redemption.js');
const ctxV = { actorUid: OWNER_UID, nowIso: '2026-10-03T00:00:00.000Z', nowMs: Date.parse('2026-10-03T00:00:00.000Z'), storeId: null, storeName: null, redemptionId: 'r1', code: '123456' };

describe('classifyRedemption — code state', () => {
  it('ok / used / cancelled / expired', () => {
    expect(redeem.classifyRedemption({}, ctxV.nowMs).ok).toBe(true);
    expect(redeem.classifyRedemption({ used: true }, ctxV.nowMs).reason).toBe('already-used');
    expect(redeem.classifyRedemption({ status: 'used' }, ctxV.nowMs).reason).toBe('already-used');
    expect(redeem.classifyRedemption({ status: 'cancelled' }, ctxV.nowMs).reason).toBe('code-invalid');
    expect(redeem.classifyRedemption({ expiresAt: '2020-01-01T00:00:00Z' }, ctxV.nowMs).reason).toBe('code-expired');
    expect(redeem.classifyRedemption(null, ctxV.nowMs).reason).toBe('code-not-found');
  });
});

describe('planRewardRedeem — catalog-trusted debit', () => {
  const cust = (pts) => ({ points: pts, uid: 'cu', email: 'c@x.gr', name: 'C', card: 'IP-ABC' });
  it('debits the CATALOG cost, not the (inflated) redemption doc value', () => {
    const red = { rewardId: 'rw1', points: 10, label: 'X' }; // doc says 10...
    const reward = { cost: 250, discount: 5, title: 'Reward', isActive: true }; // ...catalog says 250
    const p = redeem.planRewardRedeem(red, reward, cust(500), 'c1', null, ctxV);
    expect(p.ok).toBe(true); expect(p.amount).toBe(-250); expect(p.after).toBe(250);
    expect(p.customerUpdate).toEqual({ points: 250 });
    expect(p.ledger).toMatchObject({ type: 'redeem', points: -250, discount: 5, source: 'admin_verify_redemption' });
    expect(p.audit).toMatchObject({ action: 'admin_verify_reward', amount: -250, success: true });
  });
  it('insufficient balance → deny', () => {
    const p = redeem.planRewardRedeem({ rewardId: 'rw1', points: 10 }, { cost: 250, isActive: true }, cust(100), 'c1', null, ctxV);
    expect(p).toMatchObject({ ok: false, reason: 'insufficient-balance' });
  });
  it('inactive / missing reward → deny', () => {
    expect(redeem.planRewardRedeem({ rewardId: 'rw1' }, { cost: 50, isActive: false }, cust(500), 'c1', null, ctxV).reason).toBe('reward-inactive');
    expect(redeem.planRewardRedeem({ rewardId: 'rw1' }, null, cust(500), 'c1', null, ctxV).reason).toBe('reward-missing');
  });
  it('used code / blocked customer / no customer → deny', () => {
    expect(redeem.planRewardRedeem({ used: true }, null, cust(500), 'c1', null, ctxV).reason).toBe('already-used');
    expect(redeem.planRewardRedeem({ rewardId: 'rw1' }, { cost: 50, isActive: true }, { points: 500, blocked: true }, 'c1', null, ctxV).reason).toBe('customer-blocked');
    expect(redeem.planRewardRedeem({ rewardId: 'rw1' }, { cost: 50, isActive: true }, null, 'c1', null, ctxV).reason).toBe('customer-not-found');
  });
  it('idempotent when ledger exists → no writes', () => {
    const p = redeem.planRewardRedeem({ rewardId: 'rw1', points: 50 }, { cost: 50, isActive: true }, cust(500), 'c1', { balanceAfter: 450 }, ctxV);
    expect(p).toMatchObject({ ok: true, idempotent: true }); expect(p.customerUpdate).toBeUndefined();
  });
});

describe('planOfferRedeem — H1-safe canonical credit', () => {
  const cust = () => ({ points: 100, totalPoints: 500, uid: 'cu' });
  it('credits the OFFER value, IGNORING an inflated redemption bonusPoints (no H1 inflation)', () => {
    const red = { offerId: 'of1', bonusPoints: 2500, offerTitle: 'Promo' }; // doc inflated to 2500
    const offer = { active: true, bonusPoints: 50 };                         // canonical = 50
    const p = redeem.planOfferRedeem(red, offer, cust(), 'c1', null, ctxV);
    expect(p.ok).toBe(true); expect(p.amount).toBe(50); // NOT 2500
    expect(p.customerUpdate).toEqual({ points: 150, totalPoints: 550 });
    expect(p.ledger).toMatchObject({ type: 'add', points: 50 });
    expect(p.audit).toMatchObject({ action: 'admin_verify_offer', amount: 50 });
  });
  it('inactive / missing offer → deny (H1 eligibility)', () => {
    expect(redeem.planOfferRedeem({ offerId: 'of1' }, { active: false, bonusPoints: 50 }, cust(), 'c1', null, ctxV).reason).toBe('offer-ineligible');
    expect(redeem.planOfferRedeem({ offerId: 'of1' }, null, cust(), 'c1', null, ctxV).reason).toBe('offer-missing');
  });
  it('blocked customer / used code → deny; idempotent when ledger exists', () => {
    expect(redeem.planOfferRedeem({ offerId: 'of1' }, { active: true, bonusPoints: 50 }, { points: 0, blocked: true }, 'c1', null, ctxV).reason).toBe('customer-blocked');
    expect(redeem.planOfferRedeem({ used: true, offerId: 'of1' }, { active: true, bonusPoints: 50 }, cust(), 'c1', null, ctxV).reason).toBe('already-used');
    expect(redeem.planOfferRedeem({ offerId: 'of1' }, { active: true, bonusPoints: 50 }, cust(), 'c1', { balanceAfter: 150 }, ctxV)).toMatchObject({ ok: true, idempotent: true });
  });
});

describe('adminVerifyRedemption — owner gate (before any DB)', () => {
  const h = () => internals._adminVerifyRedemptionHandler;
  it('non-owner admin → permission-denied', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    await expect(h()({ auth: { uid: 'rogue', token: { admin: true } }, data: { code: '123456' } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('owner + malformed code → invalid-argument (before db lookup)', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    await expect(h()({ auth: { uid: OWNER_UID, token: { admin: true } }, data: { code: 'abc' } })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

// ── canonicalOfferValue shared between both paths (no second authority) ───────
describe('shared canonical offer value', () => {
  const oc = require('../functions/lib/offer-credit.js');
  it('canonicalOfferValue is the single source; canonicalOfferCredit still enforces mismatch', () => {
    expect(oc.canonicalOfferValue({ active: true, bonusPoints: 50 })).toEqual({ ok: true, canonicalBonus: 50 });
    expect(oc.canonicalOfferValue({ active: false, bonusPoints: 50 }).reason).toBe('offer-ineligible');
    // canonicalOfferCredit (tablet path) unchanged: matching request ok, mismatch rejected
    expect(oc.canonicalOfferCredit({ active: true, bonusPoints: 50 }, -50)).toEqual({ ok: true, canonicalBonus: 50 });
    expect(oc.canonicalOfferCredit({ active: true, bonusPoints: 50 }, -2500).reason).toBe('value-mismatch');
  });
});

// ── Callable surface is App-Check-enforced (framework config, like approveRedemption)
describe('fortress callable exports', () => {
  it('all fortress callables registered + handlers exposed', () => {
    const mod = require('../functions/index.js');
    for (const n of ['adminAdjustPoints', 'adminBatchMaintenance', 'adminBirthdayCredit', 'adminVerifyRedemption']) {
      expect(typeof mod[n]).toBe('function');
    }
    for (const h of ['_adminAdjustPointsHandler', '_adminBatchMaintenanceHandler', '_adminBirthdayCreditHandler', '_adminVerifyRedemptionHandler', '_commitAdjustment']) {
      expect(typeof mod._l23aInternals[h]).toBe('function');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS Stage 2 — customer LIFECYCLE (pure: lib + auth gate + input).
//  Destructive Firestore/Auth behavior is proven in the emulator harness
//  (tests/lifecycle-integration.test.js). Here we prove the pure logic and the
//  fail-closed authorization matrix (owner gate throws BEFORE any I/O).
// ═══════════════════════════════════════════════════════════════════════════
const life = require('../functions/lib/lifecycle.js');

describe('lifecycle.tombstoneId / lifecycleId', () => {
  it('tombstone is deterministic, irreversible-shaped, and carries no raw PII', () => {
    const t1 = life.tombstoneId('uid-abc');
    const t2 = life.tombstoneId('uid-abc');
    expect(t1).toBe(t2);                              // deterministic → idempotent
    expect(t1).toMatch(/^deleted_customer_[0-9a-f]{24}$/);
    expect(life.tombstoneId('uid-xyz')).not.toBe(t1); // distinct seeds differ
    // never echoes the raw identifier / email
    expect(life.tombstoneId('victim@ipear.gr')).not.toContain('victim@ipear.gr');
    expect(life.tombstoneId('victim@ipear.gr')).not.toContain('@');
  });
  it('lifecycleId is deterministic per customer (idempotency/completion key)', () => {
    expect(life.lifecycleId('cust1')).toBe(life.lifecycleId('cust1'));
    expect(life.lifecycleId('cust1')).not.toBe(life.lifecycleId('cust2'));
    expect(life.lifecycleId('cust1')).toMatch(/^lifecycle_[0-9a-f]{40}$/);
    // explicit idempotency key overrides the customerId seed
    expect(life.lifecycleId('cust1', 'ik_x')).toBe(life.lifecycleId('cust1', 'ik_x'));
    expect(life.lifecycleId('cust1', 'ik_x')).not.toBe(life.lifecycleId('cust1'));
  });
});

describe('lifecycle.planLedgerAnonymization', () => {
  const T = life.tombstoneId('uid-abc');
  it('strips PII, repoints identity to tombstone, PRESERVES financial facts', () => {
    const row = {
      customerId: 'cust1', customerUid: 'uid-abc', customerEmail: 'a@ipear.gr',
      customerName: 'Jane', customerPhone: '6900000000',
      points: 100, totalPoints: 500, type: 'add', delta: 100, amount: 100,
      date: '2026-01-01', source: 'woo', idempotencyKey: 'ik_1',
      balanceBefore: 400, balanceAfter: 500,
    };
    const u = life.planLedgerAnonymization(row, T, 'NOW');
    // PII removed
    expect(u.customerEmail).toBeNull();
    expect(u.customerName).toBeNull();
    expect(u.customerPhone).toBeNull();
    // identity repointed to the irreversible tombstone
    expect(u.customerId).toBe(T);
    expect(u.customerUid).toBe(T);
    expect(u._anonymizedAt).toBe('NOW');
    expect(u._tombstone).toBe(T);
    // financial facts are NOT in the update (left untouched on the row)
    for (const f of ['points', 'totalPoints', 'type', 'delta', 'amount', 'date', 'source', 'idempotencyKey', 'balanceBefore', 'balanceAfter']) {
      expect(u).not.toHaveProperty(f);
    }
  });
  it('is an idempotent no-op on an already-tombstoned row', () => {
    const done = { customerId: T, customerUid: T, _anonymizedAt: 'NOW', points: 100, type: 'add' };
    expect(life.planLedgerAnonymization(done, T, 'NOW2')).toBeNull();
  });
});

describe('lifecycle.LIFECYCLE_POLICY classification', () => {
  it('ledger + redemption evidence RETAINED, PII docs deleted, admin_audit immutable', () => {
    const P = life.LIFECYCLE_POLICY;
    expect(P.ipear_transactions).toBe('RETAIN_ANONYMIZE');
    expect(P.ipear_offer_redemptions).toBe('RETAIN_ANONYMIZE');
    expect(P.ipear_redemptions).toBe('RETAIN_ANONYMIZE');
    expect(P.admin_audit).toBe('RETAIN_IMMUTABLE');
    expect(P.ipear_customers).toBe('DELETE');
    expect(P.ipear_referral_queue).toBe('DELETE');
    expect(P.audit_logs).toBe('ANONYMIZE');
  });
});

describe('adminDeleteCustomer — fail-closed authorization matrix (pure, pre-I/O)', () => {
  const call = (auth, data = { customerId: 'c1' }) =>
    internals._adminDeleteCustomerHandler({ auth, data });
  it('logged out → unauthenticated', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    await expect(call(null)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('customer (no admin claim) → permission-denied', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    await expect(call({ uid: 'c', token: { email_verified: true } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('tablet role → permission-denied', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    await expect(call({ uid: 't', token: { role: 'tablet' } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('admin claim but WRONG owner uid → permission-denied', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    await expect(call({ uid: 'not-owner', token: { admin: true } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('forged role claim (admin:"true" string) → permission-denied', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    await expect(call({ uid: OWNER_UID, token: { admin: 'true' } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('OWNER_UIDS unset → fail-closed permission-denied even for admin', async () => {
    delete process.env.OWNER_UIDS;
    await expect(call({ uid: OWNER_UID, token: { admin: true } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('valid owner + bad input → invalid-argument (gate passed, validated before I/O)', async () => {
    process.env.OWNER_UIDS = OWNER_UID;
    const ok = { uid: OWNER_UID, token: { admin: true } };
    await expect(call(ok, {})).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(call(ok, { customerId: '' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(call(ok, { customerId: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('adminDeleteCustomer — callable export', () => {
  it('registered as onCall + handler exposed for tests', () => {
    const mod = require('../functions/index.js');
    expect(typeof mod.adminDeleteCustomer).toBe('function');
    expect(typeof mod._l23aInternals._adminDeleteCustomerHandler).toBe('function');
  });
});
