// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Dashboard operations
//
//  Extracted from src/admin-main.js during the Sprint 3 god-module split.
//  Owns the four "ops" surfaces shown on the top-level admin dashboard:
//   • processReferralQueue — drain ipear_referral_queue (atomic credit txns)
//   • loadTx               — render the 30-row recent-transactions panel
//   • exportBk / importBk  — JSON backup download + restore
//   • loadKpiOverview      — fast server-side aggregations for the KPI cards
//
//  Cross-domain hooks (configured via initDashboardOps):
//   • reloadAfterImport    — admin-main owns loadAll(); call it after a
//                            successful importBk so the customer table
//                            picks up the restored rows
//
//  loadStats is imported directly from './stats.js' so importBk can fan
//  out its refresh without going through another hook.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../logger.js';
import { escHtml } from '../utils.js';
import { authState } from './auth-state.js';
import { toast } from './ui.js';
import { loadStats } from './stats.js';

const DB = () => window._db;

let _hooks = {
  reloadAfterImport: () => {},
};

export function initDashboardOps(hooks) {
  _hooks = { ..._hooks, ...hooks };
}

// ══════════════════════════════════════
//  REFERRAL QUEUE PROCESSOR
// ══════════════════════════════════════
// Drains ipear_referral_queue entries (processed==false) written by
// customer self-registration. Pays the referrer +100 (atomic balance +
// ledger), then locks referralProcessed on the new customer (atomic flag
// + ledger). Hard cap MAX_REFERRALS_PER_USER prevents farming abuse.
const MAX_REFERRALS_PER_USER = 5; // Each user can refer max 5 people

export async function processReferralQueue() {
  if (!authState.authenticated) return;
  const db = DB(); if (!db) return;
  try {
    const snap = await window._getDocs(
      window._query(window._col(db,'ipear_referral_queue'), window._where('processed','==',false))
    );
    if (snap.empty) return;
    for (const qDoc of snap.docs) {
      const q = qDoc.data();
      const markDone = (extra={}) => window._updateDoc(window._doc(db,'ipear_referral_queue',qDoc.id),
        {processed:true, processedAt:new Date().toISOString(), ...extra}).catch(()=>{});
      try {
        // Verify legitimacy: look up the new customer's doc by stored ID
        if (!q.newCustomerId) { await markDone({skipped:'no-id'}); continue; }
        const ncSnap = await window._getDoc(window._doc(db,'ipear_customers',q.newCustomerId));
        if (!ncSnap.exists()) { await markDone({skipped:'customer-not-found'}); continue; }
        const ncData = ncSnap.data();
        // Skip if already processed OR if the stored data no longer matches the customer doc
        // This prevents duplicate queue entries from paying out more than once
        if (ncData.referralProcessed ||
            ncData.referredBy  !== q.referrerCard ||
            ncData.uid         !== q.newCustomerUid) {
          await markDone({skipped:'already-processed-or-mismatch'}); continue;
        }

        // Award referrer +100 pts + transaction (max 5 referrals per user)
        const refSnap = await window._getDocs(
          window._query(window._col(db,'ipear_customers'), window._where('card','==',q.referrerCard))
        );
        if (!refSnap.empty) {
          let refId, refData;
          refSnap.forEach(d => { refId = d.id; refData = d.data(); });
          const refCount = refData.referralCount || 0;
          if (refCount >= MAX_REFERRALS_PER_USER) {
            // Referrer hit the 5-referral cap — revert new customer's 100 pts too
            const ncCurr = ncData.points || 0;
            const ncTotCurr = ncData.totalPoints || 0;
            if (ncCurr >= 100 && ncTotCurr >= 100) {
              await window._updateDoc(window._doc(db,'ipear_customers',q.newCustomerId),{
                points: ncCurr - 100, totalPoints: ncTotCurr - 100, referralProcessed: true
              });
            }
            await markDone({skipped:'referral-limit-reached', referrerCard:q.referrerCard});
            continue;
          }
          // Atomic referrer credit (balance + ledger in same commit).
          const refQNowIso = new Date().toISOString();
          const refQLedgerId = `referral_queue_in_${refId}_${q.newCustomerId}`;
          await window._runTransaction(db, async (txn) => {
            const refRef = window._doc(db, 'ipear_customers', refId);
            const refLiveSnap = await txn.get(refRef);
            if (!refLiveSnap.exists()) throw new Error('Referrer missing');
            const live = refLiveSnap.data();
            const rPts = (live.points || 0) + 100;
            const rTot = (live.totalPoints || live.points || 0) + 100;
            txn.update(refRef, {
              points: rPts, totalPoints: rTot,
              referralCount: (live.referralCount || 0) + 1
            });
            txn.set(window._doc(db, 'ipear_transactions', refQLedgerId), {
              customerId: refId, customerUid: refData.uid || '',
              customerEmail: refData.email || '', customerName: refData.name,
              card: refData.card, type: 'add', points: 100, amount: 0,
              category: '🎁 Referral Bonus',
              note: `Παραπομπή: ${q.newCustomerCard} (${(live.referralCount||0)+1}/${MAX_REFERRALS_PER_USER})`,
              date: refQNowIso
            });
          });
        }
        // Write balance +100 for the NEW customer + ledger + lock referralProcessed
        // in ONE atomic commit. BUGFIX 2026-07-30: this used to only write the
        // ledger row and set referralProcessed, leaving the actual balance
        // untouched — a leftover from when the client self-credited +100 at
        // signup. Post-CRITICAL-2 the client starts at points=0, so without
        // this credit the new customer was left showing "+100 in history, 0
        // in balance". Deterministic ledger id de-dupes vs any parallel worker
        // credit (set() with same id is a no-op overwrite — fine).
        const ncLedgerId = `referral_queue_out_${q.newCustomerId}`;
        await window._runTransaction(db, async (txn) => {
          const ncRef = window._doc(db, 'ipear_customers', q.newCustomerId);
          const ncSnapLive = await txn.get(ncRef);
          if (!ncSnapLive.exists()) throw new Error('New customer missing');
          const ncLive = ncSnapLive.data();
          // Guard: if the worker's /process-referral already credited via
          // referralProcessed=true, don't double-credit.
          if (ncLive.referralProcessed === true) {
            return;
          }
          const ncPts = (ncLive.points || 0) + 100;
          const ncTot = (ncLive.totalPoints || ncLive.points || 0) + 100;
          txn.update(ncRef, {
            points: ncPts,
            totalPoints: ncTot,
            referralProcessed: true
          });
          txn.set(window._doc(db, 'ipear_transactions', ncLedgerId), {
            customerId: q.newCustomerId, customerUid: q.newCustomerUid || '',
            customerEmail: q.newCustomerEmail || '', customerName: q.newCustomerName,
            card: q.newCustomerCard, type: 'add', points: 100, amount: 0,
            category: '🎁 Referral Bonus',
            note: 'Bonus εγγραφής με referral',
            date: new Date().toISOString()
          });
        });
        await markDone();
      } catch(_) {}
    }
  } catch(_) {}
}

// ══════════════════════════════════════
//  RECENT TRANSACTIONS PANEL
// ══════════════════════════════════════
let _historyBusy = false;
export async function loadTx() {
  if (!authState.authenticated) return;
  if (!navigator.onLine) return;
  if (_historyBusy) return;
  const db=DB(); if(!db) return;
  const el=document.getElementById('txlist');
  const refreshBtn = document.querySelector('button[data-action="loadTx"]');
  _historyBusy = true;
  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.dataset._origText = refreshBtn.innerHTML; refreshBtn.innerHTML = '⏳ Φόρτωση...'; }
  el.innerHTML='<div class="empty"><span class="e">⏳</span>Φόρτωση...</div>';
  try {
    const q=window._query(window._col(db,'ipear_transactions'),window._orderBy('date','desc'),window._limit(30));
    const snap=await window._getDocs(q);
    if (snap.empty) { el.innerHTML='<div class="empty"><span class="e">📭</span>Καμία συναλλαγή ακόμα</div>'; return; }
    let html='';
    snap.forEach(d=>{
      const t=d.data();
      const dt=new Date(t.date);
      const ds=dt.toLocaleDateString('el-GR')+' '+dt.toLocaleTimeString('el-GR',{hour:'2-digit',minute:'2-digit'});
      let det, cls;
      if (t.type==='add')            { cls='add';    det=`🛒 ${t.category||'Αγορά'}`; }
      else if (t.type==='redeem')    {
        // See history-ui.js:186 — prefer the stored reward title (dynamic
        // catalog items like "Καλώδιο Baseus" aren't euro discounts).
        // Legacy manual redeems have no label → fall back to the amount.
        cls='redeem';
        det = t.label ? `🎁 ${t.label}` : `💶 Έκπτωση ${t.discount||''}€`;
      }
      else if (t.type==='expire')    { cls='redeem'; det=`⏳ Εκπνοή Πόντων`; }
      else if (t.type==='tier_downgrade') { cls='redeem'; det=`📉 Tier Downgrade`; }
      else { cls=t.points>=0?'add':'redeem'; det=t.category||t.type||'Συναλλαγή'; }
      if (t.note && t.type!=='tier_downgrade') det+=` · ${t.note}`;
      const ptsSign = t.points>=0?'+':'';
      html+=`<div class="tx-item">
        <div><div class="tx-name">${escHtml(t.customerName||'—')}</div><div class="tx-det">${escHtml(t.card||'—')} · ${escHtml(det)}</div></div>
        <div><div class="tx-pts ${cls}">${ptsSign}${Number(t.points).toLocaleString('el-GR')}</div><div class="tx-date">${ds}</div></div>
      </div>`;
    });
    el.innerHTML=html;
  } catch(e) {
    el.innerHTML='<div class="empty">❌ '+escHtml(e.message)+'</div>';
  } finally {
    _historyBusy = false;
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.innerHTML = refreshBtn.dataset._origText || '🔄 Ανανέωση'; }
  }
}

// ══════════════════════════════════════
//  BACKUP (export + import JSON)
// ══════════════════════════════════════
export async function exportBk() {
  if (!navigator.onLine) { toast('🔴 Offline','error'); return; }
  document.getElementById('exspin').classList.add('show');
  try {
    const db=DB();
    const cs=await window._getDocs(window._col(db,'ipear_customers'));
    const ts=await window._getDocs(window._col(db,'ipear_transactions'));
    const custs=[],txs=[];
    cs.forEach(d=>custs.push({id:d.id,...d.data()}));
    ts.forEach(d=>txs.push({id:d.id,...d.data()}));
    const bk={exportDate:new Date().toISOString(),version:'1.0',system:'iPear Loyalty',data:{customers:custs,transactions:txs}};
    const blob=new Blob([JSON.stringify(bk,null,2)],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    const now=new Date();
    a.download=`iPear_Backup_${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    toast(`✅ Backup εξήχθη! (${custs.length} πελάτες)`,'success');
  } catch(e) { toast('❌ '+e.message,'error'); }
  document.getElementById('exspin').classList.remove('show');
}

export async function importBk(ev) {
  const file=ev.target.files[0]; if(!file) return;
  if (!navigator.onLine) { toast('🔴 Offline','error'); ev.target.value=''; return; }
  if (!confirm('⚠️ Θα προστεθούν δεδομένα από το backup. Συνέχεια;')) { ev.target.value=''; return; }
  const reader=new FileReader();
  reader.onload=async e=>{
    try {
      const bk=JSON.parse(e.target.result);
      if (!bk.data?.customers) { toast('❌ Μη έγκυρο αρχείο!','error'); return; }
      const db=DB();
      const exSnap=await window._getDocs(window._col(db,'ipear_customers'));
      const cards=new Set(); exSnap.forEach(d=>{ if(d.data().card)cards.add(d.data().card); });
      let added=0,skipped=0,txAdded=0;
      for(const c of bk.data.customers){
        const data={...c}; delete data.id;
        if(cards.has(data.card)){skipped++;continue;}
        await window._addDoc(window._col(db,'ipear_customers'),data); added++; cards.add(data.card);
      }
      for(const t of (bk.data.transactions||[])){
        const data={...t}; const origId=data.id; delete data.id;
        await window._setDoc(window._doc(db,'ipear_transactions',origId),data); txAdded++;
      }
      toast(`✅ ${added} πελάτες, ${txAdded} συναλλαγές (παράλειψη: ${skipped})`,'success');
      // Fan out the post-import refresh. loadStats + loadTx ship from this
      // module; loadAll still lives in admin-main.js so it goes through a hook.
      loadStats(); loadTx(); _hooks.reloadAfterImport();
    } catch(err){ toast('❌ '+err.message,'error'); }
    ev.target.value='';
  };
  reader.readAsText(file);
}

// ══════════════════════════════════════
//  KPI OVERVIEW (fast server-side aggregations)
// ══════════════════════════════════════
// P-1 fix: use server-side aggregation queries (getCountFromServer + sum())
// for the two KPIs that don't need per-doc iteration. These resolve in ~50ms
// regardless of collection size and cost a fraction of a full collection scan
// (one aggregation read vs. N document reads). loadStats() still runs in
// parallel for the rich tier/redemption/blocked breakdowns that genuinely
// need per-doc data.
let _kpiOverviewBusy = false;
export async function loadKpiOverview() {
  if (_kpiOverviewBusy) return;
  if (!authState.authenticated) return;
  if (!navigator.onLine) return;
  const db = DB(); if (!db) return;
  if (typeof window._getCountFromServer !== 'function') return;
  _kpiOverviewBusy = true;
  try {
    const customersCol = window._col(db, 'ipear_customers');
    const transactionsCol = window._col(db, 'ipear_transactions');
    const [custCount, txCount, liabAgg] = await Promise.all([
      window._getCountFromServer(customersCol),
      window._getCountFromServer(transactionsCol),
      window._getAggregateFromServer(customersCol, { totalPts: window._sum('points') })
    ]);
    const nCust = custCount.data().count;
    const nTx   = txCount.data().count;
    const liabPts = liabAgg.data().totalPts || 0;
    // These DOM nodes are also written by loadStats — that's fine; whoever
    // finishes last wins, and both produce the same numbers.
    const sc = document.getElementById('sc');
    const sl = document.getElementById('sk-liab');
    const dl = document.getElementById('dash-liab-pts');
    const dt = document.getElementById('dash-total-tx');
    if (sc) sc.textContent = nCust;
    if (sl) sl.textContent = (liabPts * 0.02).toFixed(0) + '€';
    if (dl) dl.textContent = liabPts.toLocaleString('el-GR') + ' πόντοι';
    if (dt) dt.textContent = nTx + ' συναλλαγές';
  } catch(e) {
    logger.warn('[loadKpiOverview] aggregation failed (will fall back to loadStats):', e.message);
  } finally {
    _kpiOverviewBusy = false;
  }
}
