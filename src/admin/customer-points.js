// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Manual point credit / debit (atomic ledger transactions)
//
//  Extracted from src/admin-main.js during the Sprint 3 god-module split.
//  Owns the 5 functions that manipulate the customer balance directly from
//  the admin UI (no QR involved):
//   • calcPts        — live preview of amount × multiplier → points
//   • openAdd        — populate + open the "Add points" modal
//   • confirmAdd     — atomic balance credit + ledger write (1 commit)
//   • openRedeem     — populate + open the "Redeem points" modal
//   • confirmRedeem  — atomic balance debit + audit_log + ledger (1 commit)
//
//  Cross-domain hooks (configured via initCustomerPoints):
//   • getScope       — read admin-main's selected customer (cid + cdata)
//   • renderCust     — re-paint the customer card with mutated cdata
//
//  Store context (storeId / storeName) is read straight from authState —
//  admin-auth.js mirrors the resolved store into authState on login, so we
//  avoid an extra hook for it.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../logger.js';
import { friendlyError } from '../utils.js';
import { authState } from './auth-state.js';
import { toast, closeM } from './ui.js';
import { publishLeaderboard as _publishLeaderboard } from './leaderboard.js';
// ADMIN FORTRESS Stage 1 — server-authoritative path (feature-flagged, OFF by default).
import { isServerFinancialEnabled, serverAdjustPoints, newIdempotencyKey } from './financial-mutations.js';

const DB = () => window._db;

// Cross-domain hooks (set via initCustomerPoints)
let _hooks = {
  getScope: () => ({ cid: null, cdata: null }),
  renderCust: () => {},
};

export function initCustomerPoints(hooks) {
  _hooks = { ..._hooks, ...hooks };
}

// Shared txn guard so the credit + debit flows can't fire concurrently from
// the same admin session (e.g. double-click on the "Καταχώρηση" button).
let _txnBusy = false;
const _TXN_COOLDOWN = 2000;
let _txnLastAt = 0;

// ══════════════════════════════════════
//  ADD POINTS
// ══════════════════════════════════════
export function calcPts() {
  const amt=parseFloat(document.getElementById('ma-amt').value)||0;
  const mul=parseFloat(document.getElementById('ma-cat').value)||1;
  const pts=Math.round(amt*mul);
  const el=document.getElementById('pts-calc');
  el.textContent=pts;
  el.style.color = amt > 5000 ? '#ff3b30' : amt > 500 ? '#ff9500' : '';
}

export function openAdd() {
  const { cdata } = _hooks.getScope();
  document.getElementById('ma-name').textContent=cdata?.name||'';
  document.getElementById('ma-amt').value='';
  document.getElementById('ma-note').value='';
  document.getElementById('pts-calc').textContent='0';
  document.getElementById('m-add').classList.add('show');
}

export async function confirmAdd() {
  if (_txnBusy) { toast('⏳ Επεξεργασία σε εξέλιξη...','error'); return; }
  if (Date.now() - _txnLastAt < _TXN_COOLDOWN) { toast('⏳ Περίμενε λίγο...','error'); return; }
  if (!authState.authenticated) { toast('⛔ Δεν έχεις συνδεθεί!','error'); return; }
  if (!navigator.onLine) { toast('🔴 Offline','error'); return; }
  _txnBusy = true; _txnLastAt = Date.now();
  const { cid, cdata } = _hooks.getScope();
  const amt=parseFloat(document.getElementById('ma-amt').value);
  const mul=parseFloat(document.getElementById('ma-cat').value)||1;
  const cat=document.getElementById('ma-cat').options[document.getElementById('ma-cat').selectedIndex].text;
  const pts=Math.round(amt*mul);
  const note=document.getElementById('ma-note').value;
  if (!amt||amt<1) { toast('⚠️ Βάλε ποσό αγοράς','error'); _txnBusy = false; return; }
  if (!Number.isFinite(amt)) { toast('⚠️ Μη έγκυρο ποσό','error'); _txnBusy = false; return; }
  if (amt > 5000) { toast('⚠️ Μέγιστο ποσό αγοράς: 5.000€','error'); _txnBusy = false; return; }
  if (amt > 500 && !confirm(`⚠️ Ποσό ${amt.toLocaleString('el-GR')}€ — Σίγουρα;`)) { _txnBusy = false; return; }

  // ── ADMIN FORTRESS Stage 1 — server-authoritative path (feature-flagged) ──
  //    When enabled, submit an INTENT to the adminAdjustPoints callable; the
  //    server resolves the customer, computes the balance, and writes the
  //    ledger + immutable audit row. Mutually exclusive with the legacy path.
  if (isServerFinancialEnabled()) {
    const addBtnS = document.querySelector('#m-add .btn-green');
    if (addBtnS) { addBtnS.disabled = true; addBtnS.textContent = '⏳'; }
    try {
      const r = await serverAdjustPoints({
        customerId: cid,
        operation: 'add',
        amount: pts,
        reason: (cat || 'manual-add') + (note ? (' — ' + note) : ''),
        idempotencyKey: newIdempotencyKey(),
      });
      const np = Number(r && r.newPoints);
      if (Number.isFinite(np)) {
        cdata.points = np;
        cdata.totalPoints = (cdata.totalPoints || 0) + pts;
      }
      _hooks.renderCust(cdata);
      toast(`✅ +${pts} πόντοι για ${cdata.name}`, 'success'); closeM();
      _publishLeaderboard();
    } catch (e) {
      logger.warn('[confirmAdd:server] failed:', e?.message);
      toast('❌ ' + (e?.message || 'Σφάλμα διακομιστή'), 'error');
    } finally {
      _txnBusy = false;
      if (addBtnS) { addBtnS.disabled = false; addBtnS.textContent = '✅ Καταχώρηση'; }
    }
    return; // never fall through to the legacy direct-write path
  }

  const db=DB();
  const addBtn = document.querySelector('#m-add .btn-green');
  if (addBtn) { addBtn.disabled=true; addBtn.textContent='⏳'; }
  try {
    // ── Atomic Transaction — balance update + ledger entry committed together.
    //    Previously the ipear_transactions write happened AFTER runTransaction,
    //    so a failure between the two left points credited with no audit row.
    //    Both writes now share one Firestore commit (max 500 writes / txn,
    //    we use 2). Pre-generated id keeps the set() retry-safe across
    //    Firestore's internal txn re-attempts on contention.
    let newPts, newTot;
    const nowIso = new Date().toISOString();
    const txDocId = `add_${cid}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    await window._runTransaction(db, async (txn) => {
      const custRef = window._doc(db, 'ipear_customers', cid);
      const snap = await txn.get(custRef);
      if (!snap.exists()) throw new Error('Πελάτης δεν βρέθηκε.');
      const live = snap.data();
      newPts = (live.points || 0) + pts;
      newTot = (live.totalPoints || live.points || 0) + pts;
      txn.update(custRef, { points: newPts, totalPoints: newTot });
      txn.set(window._doc(db, 'ipear_transactions', txDocId), {
        customerId: cid,
        customerUid: cdata.uid || '',
        customerEmail: cdata.email || '',
        customerName: cdata.name,
        card: cdata.card,
        type: 'add',
        points: pts,
        amount: amt,
        category: cat,
        note,
        storeId: authState.storeId || null,
        storeName: authState.storeName,
        date: nowIso,
        createdByAdmin: authState.actorUid || ''
      });
    });
    cdata.points=newPts; cdata.totalPoints=newTot;
    _hooks.renderCust(cdata); toast(`✅ +${pts} πόντοι για ${cdata.name}`,'success'); closeM();
    _publishLeaderboard(); // refresh leaderboard after points change
  } catch(e) {
    logger.warn('[confirmAdd] failed:', e?.message);
    toast('❌ ' + friendlyError(e),'error');
  }
  finally { _txnBusy = false; if (addBtn) { addBtn.disabled=false; addBtn.textContent='✅ Καταχώρηση'; } }
}

// ══════════════════════════════════════
//  REDEEM
// ══════════════════════════════════════
export function openRedeem() {
  const { cdata } = _hooks.getScope();
  document.getElementById('mr-name').textContent=cdata?.name||'';
  document.getElementById('mr-pts').textContent=cdata?.points||0;
  document.getElementById('m-redeem').classList.add('show');
}

export async function confirmRedeem() {
  if (_txnBusy) { toast('⏳ Επεξεργασία σε εξέλιξη...','error'); return; }
  if (Date.now() - _txnLastAt < _TXN_COOLDOWN) { toast('⏳ Περίμενε λίγο...','error'); return; }
  if (!authState.authenticated) { toast('⛔ Δεν έχεις συνδεθεί!','error'); return; }
  if (!navigator.onLine) { toast('🔴 Offline','error'); return; }
  _txnBusy = true; _txnLastAt = Date.now();
  const { cid, cdata } = _hooks.getScope();
  const cost = parseInt(document.getElementById('mr-sel').value);
  if (isNaN(cost) || cost <= 0) { toast('⚠️ Επίλεξε πακέτο εξαργύρωσης.','error'); _txnBusy = false; return; }
  if (!Number.isInteger(cost)) { toast('⚠️ Μη έγκυρο ποσό πόντων.','error'); _txnBusy = false; return; }
  const db = DB(), disc = (cost/250)*5;
  const redeemBtn = document.querySelector('#m-redeem .btn-green');

  // ── ADMIN FORTRESS Stage 1 — server-authoritative path (feature-flagged) ──
  //    Mutually exclusive with the legacy direct-write path below.
  if (isServerFinancialEnabled()) {
    if (redeemBtn) { redeemBtn.disabled = true; redeemBtn.textContent = '⏳'; }
    try {
      const r = await serverAdjustPoints({
        customerId: cid,
        operation: 'subtract',
        amount: cost,
        reason: `manual-redeem ${disc}€`,
        idempotencyKey: newIdempotencyKey(),
      });
      const np = Number(r && r.newPoints);
      if (Number.isFinite(np)) { cdata.points = np; }
      _hooks.renderCust(cdata);
      toast(`💶 Εξαργύρωση ${disc}€! Αφαιρέθηκαν ${cost} πόντοι.`, 'success'); closeM();
      _publishLeaderboard();
    } catch (e) {
      logger.warn('[confirmRedeem:server] failed:', e?.message);
      toast('❌ ' + (e?.message || 'Σφάλμα διακομιστή'), 'error');
    } finally {
      _txnBusy = false;
      if (redeemBtn) { redeemBtn.disabled = false; redeemBtn.textContent = '💶 Εξαργύρωση'; }
    }
    return; // never fall through to the legacy direct-write path
  }

  if (redeemBtn) { redeemBtn.disabled=true; redeemBtn.textContent='⏳'; }
  try {
    // ── Atomic Transaction — balance + audit log + ledger entry in one commit.
    //    Previously the ipear_transactions write happened OUTSIDE runTransaction,
    //    so a failure between the two left points deducted with no customer-
    //    facing ledger row. Now all three writes share the same commit.
    let newPts;
    const nowIso = new Date().toISOString();
    const txDocId = `redeem_manual_${cid}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    await window._runTransaction(db, async (txn) => {
      const custRef  = window._doc(db, 'ipear_customers', cid);
      const custSnap = await txn.get(custRef);
      if (!custSnap.exists()) throw new Error('Πελάτης δεν βρέθηκε.');
      const custData = custSnap.data();
      if (custData.blocked === true) throw new Error('Ο πελάτης είναι blocked.');
      const currentPts = custData.points || 0;
      if (currentPts < cost) throw new Error(`Ανεπαρκείς πόντοι (${currentPts} < ${cost})`);
      newPts = Math.max(0, currentPts - cost);
      txn.update(custRef, { points: newPts });

      const auditRef = window._doc(db, 'audit_logs', `manual_redeem_${cid}_${nowIso.replace(/[^0-9]/g,'')}`);
      txn.set(auditRef, {
        action: 'manual_redeem',
        source: 'admin',
        approvedByUid: authState.actorUid || '',
        approvedAt: nowIso,
        customerId: cid,
        customerUid: custData.uid || cdata.uid || '',
        code: null,
        pointsDeducted: cost,
        storeId: authState.storeId || null,
        storeName: authState.storeName
      });

      txn.set(window._doc(db, 'ipear_transactions', txDocId), {
        customerId: cid,
        customerUid: custData.uid || cdata.uid || '',
        customerEmail: cdata.email || '',
        customerName: cdata.name,
        card: cdata.card,
        type: 'redeem',
        points: -cost,
        discount: disc,
        method: 'manual',
        storeId: authState.storeId || null,
        storeName: authState.storeName,
        date: nowIso,
        approvedByAdmin: authState.actorUid || ''
      });
    });
    cdata.points=newPts; _hooks.renderCust(cdata);
    toast(`💶 Εξαργύρωση ${disc}€! Αφαιρέθηκαν ${cost} πόντοι.`,'success'); closeM();
    _publishLeaderboard(); // refresh leaderboard after points change
  } catch(e) {
    logger.warn('[confirmRedeem] failed:', e?.message);
    toast('❌ ' + friendlyError(e),'error');
  }
  finally { _txnBusy = false; if (redeemBtn) { redeemBtn.disabled=false; redeemBtn.textContent='💶 Εξαργύρωση'; } }
}
