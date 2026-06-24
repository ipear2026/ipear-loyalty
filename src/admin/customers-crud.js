// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Customer CRUD (register / search / render / block / delete / edit
//          / list / segments / segment-filtering)
//
//  Extracted from src/admin-main.js during the Sprint 3 god-module split.
//  Largest of the new modules — owns the entire customer-table surface plus
//  the admin's single-customer detail-card flow.
//
//  Cross-domain hooks (configured via initCustomersCrud):
//   • getScope / setScope — admin-main owns the selected-customer scope
//     (cid + cdata). search/renderCust/blockCust/deleteCust/quickSel/
//     saveEdit all read/write through these so the other admin sub-modules
//     (customer-points, messaging, gdpr) keep seeing the same single source.
//   • showTab              — navigate to the customers tab from filterBySegment
//                            and to the search tab from quickSel.
//   • getWorkerSecret      — read the session-scoped worker secret for the
//                            cascade-delete-auth-user call.
//
//  Store context (storeId / storeName) is read from authState directly —
//  admin-auth.js mirrors them there on login, so no extra hook.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../logger.js';
import { tier, escHtml, escJs, tierFloor } from '../utils.js';
import { authState } from './auth-state.js';
import { toast, closeM } from './ui.js';
import { publishLeaderboard as _publishLeaderboard } from './leaderboard.js';
import { loadStats } from './stats.js';
import { getCachedCustomers, setCachedCustomers } from './snapshot-cache.js';

const DB = () => window._db;
const MAX_REFERRALS_PER_USER = 5; // mirrors dashboard-ops.js processReferralQueue cap

let _hooks = {
  getScope: () => ({ cid: null, cdata: null }),
  setScope: () => {},
  showTab: () => {},
  getWorkerSecret: () => '',
};

export function initCustomersCrud(hooks) {
  _hooks = { ..._hooks, ...hooks };
}

// ══════════════════════════════════════
//  REGISTER (manual customer creation by admin)
// ══════════════════════════════════════
export async function register() {
  if (!authState.authenticated) { toast('⛔ Δεν έχεις συνδεθεί!','error'); return; }
  if (!navigator.onLine) { toast('🔴 Offline','error'); return; }
  const name=document.getElementById('rn').value.trim(),
        phone=document.getElementById('rp').value.trim().replace(/[\s\-()]/g,''),
        card=document.getElementById('rc').value.trim().toUpperCase(),
        email=document.getElementById('re').value.trim().toLowerCase(),
        terms=document.getElementById('rterms').checked;
  if (!name||!phone||!card) { toast('⚠️ Συμπλήρωσε όλα τα υποχρεωτικά!','error'); return; }
  // Validate card format: IP-XXXXXX (exactly 6 uppercase alphanumeric chars)
  if (!/^IP-[A-Z0-9]{6}$/.test(card)) { toast('⚠️ Μορφή κάρτας: IP-XXXXXX (6 κεφαλαία/αριθμοί). π.χ. IP-00001A','error'); return; }
  // Validate Greek mobile phone (10 digits starting with 6)
  if (!/^6\d{9}$/.test(phone)) { toast('⚠️ Το τηλέφωνο πρέπει να είναι ελληνικός αριθμός κινητού (π.χ. 6912345678)','error'); return; }
  // Validate email with basic regex
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('⚠️ Εισάγετε έγκυρο email (π.χ. nikos@email.com)','error'); return; }
  if (!terms)                      { toast('⚠️ Αποδοχή όρων υποχρεωτική!','error'); return; }
  // Validate referral code format if provided
  const refCodeRaw = document.getElementById('rref').value.trim().toUpperCase();
  if (refCodeRaw && !/^IP-[A-Z0-9]{6}$/.test(refCodeRaw)) { toast('⚠️ Ο κωδικός παραπομπής πρέπει να είναι μορφής IP-XXXXXX (π.χ. IP-00001A)','error'); return; }
  const db=DB();
  const ex=await window._getDocs(window._query(window._col(db,'ipear_customers'),window._where('card','==',card)));
  if (!ex.empty) { toast('⚠️ Η κάρτα υπάρχει ήδη!','error'); return; }
  const exP=await window._getDocs(window._query(window._col(db,'ipear_customers'),window._where('phone','==',phone)));
  if (!exP.empty) { toast('⚠️ Το τηλέφωνο υπάρχει ήδη!','error'); return; }
  const exE=await window._getDocs(window._query(window._col(db,'ipear_customers'),window._where('email','==',email)));
  if (!exE.empty) { toast('⚠️ Το email υπάρχει ήδη!','error'); return; }
  document.getElementById('rspin').classList.add('show');
  document.getElementById('reg-btn').disabled=true;
  try {
    const birthday = document.getElementById('rbday').value;
    const refCode  = refCodeRaw;
    const { id: newId } = await window._addDoc(window._col(db,'ipear_customers'),
      { name,phone,card,email, birthday, points:0,totalPoints:0, blocked:false, referralProcessed:false, referralCount:0, fcmToken:'', referredBy:refCode||'', registeredStoreId:authState.storeId||null, registeredStoreName:authState.storeName, createdAt:new Date().toISOString() });
    // Referral bonus: +100 for both (max 5 referrals per referrer)
    if (refCode) {
      const refSnap = await window._getDocs(window._query(window._col(db,'ipear_customers'),window._where('card','==',refCode)));
      if (!refSnap.empty) {
        let referrerAwarded = false;
        for (const rd of refSnap.docs || (() => { const a = []; refSnap.forEach(d => a.push(d)); return a; })()) {
          const rdata = rd.data();
          const refCount = rdata.referralCount || 0;
          if (refCount >= MAX_REFERRALS_PER_USER) {
            toast(`⚠️ Ο referrer (${refCode}) έχει φτάσει το όριο ${MAX_REFERRALS_PER_USER} παραπομπών.`,'error');
            break;
          }
          // Atomic referrer credit: balance + ledger one commit.
          const refNowIso = new Date().toISOString();
          const refLedgerId = `referral_in_${rd.id}_${newId}`;
          await window._runTransaction(db, async (txn) => {
            const refRef = window._doc(db, 'ipear_customers', rd.id);
            const refLiveSnap = await txn.get(refRef);
            if (!refLiveSnap.exists()) throw new Error('Referrer not found');
            const live = refLiveSnap.data();
            const lp = (live.points || 0) + 100;
            const lt = (live.totalPoints || live.points || 0) + 100;
            txn.update(refRef, {
              points: lp, totalPoints: lt,
              referralCount: (live.referralCount || 0) + 1
            });
            txn.set(window._doc(db, 'ipear_transactions', refLedgerId), {
              customerId: rd.id, customerUid: rdata.uid || '',
              customerEmail: rdata.email || '', customerName: rdata.name,
              card: rdata.card, type: 'add', points: 100, amount: 0,
              category: '🎁 Referral Bonus',
              note: `Παραπομπή: ${card} (${(live.referralCount||0)+1}/${MAX_REFERRALS_PER_USER})`,
              date: refNowIso,
              createdByAdmin: authState.actorUid || ''
            });
          });
          referrerAwarded = true;
        }
        if (referrerAwarded) {
          // Atomic new-customer credit: balance + ledger one commit.
          const newCustLedgerId = `referral_out_${newId}`;
          const newCustNowIso   = new Date().toISOString();
          await window._runTransaction(db, async (txn) => {
            const ncRef = window._doc(db, 'ipear_customers', newId);
            const ncSnap = await txn.get(ncRef);
            if (!ncSnap.exists()) throw new Error('Νέος πελάτης δεν βρέθηκε.');
            txn.update(ncRef, { points: 100, totalPoints: 100 });
            txn.set(window._doc(db, 'ipear_transactions', newCustLedgerId), {
              customerId: newId, customerUid: '',
              customerEmail: email, customerName: name, card: card,
              type: 'add', points: 100, amount: 0,
              category: '🎁 Referral Bonus',
              note: `Μπόνους εγγραφής με παραπομπή: ${refCode}`,
              date: newCustNowIso,
              createdByAdmin: authState.actorUid || ''
            });
          });
          toast(`✅ Εγγραφή επιτυχής! +100 πόντοι και στους δύο (referral)! 🎉`,'success');
        } else {
          toast('✅ Εγγραφή επιτυχής! Καλωσήρθε '+name+'! (Referral limit reached)','success');
        }
      } else {
        toast('✅ Εγγραφή επιτυχής! Καλωσήρθε '+name+'!','success');
      }
    } else {
      toast('✅ Εγγραφή επιτυχής! Καλωσήρθε '+name+'!','success');
    }
    ['rn','rp','rc','re','rbday','rref'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    document.getElementById('rterms').checked=false;
    window._emailAllCustomers = null; // invalidate search cache
    loadStats(); loadAll(); // loadAll also publishes leaderboard
  } catch(e) { toast('❌ '+e.message,'error'); }
  finally {
    // IAM-FIX: always restore UI even if catch itself throws
    document.getElementById('rspin').classList.remove('show');
    document.getElementById('reg-btn').disabled=false;
  }
}

// ══════════════════════════════════════
//  SEARCH (card/phone/email/name)
// ══════════════════════════════════════
export async function search() {
  if (!authState.authenticated) { toast('⛔ Δεν έχεις συνδεθεί!','error'); return; }
  if (!navigator.onLine) { toast('🔴 Offline','error'); return; }
  const q=document.getElementById('sinput').value.trim();
  if (!q) { toast('⚠️ Γράψε κάτι','error'); return; }
  document.getElementById('sspin').classList.add('show');
  document.getElementById('cust-result').classList.remove('show');
  document.getElementById('no-res').style.display='none';
  const db = DB();
  try {
    let found=null, foundId=null;

    // ── FAST PATH: exact-match indexed queries (1 read each, not N) ──
    const ql = q.toLowerCase();
    const qUp = q.toUpperCase();

    // 1. Card match (IP-XXXXXX)
    if (/^IP-/i.test(q)) {
      const cardSnap = await window._getDocs(window._query(window._col(db,'ipear_customers'),window._where('card','==',qUp)));
      cardSnap.forEach(d => { if (!found) { found=d.data(); foundId=d.id; } });
    }

    // 2. Phone match (starts with 69 — Greek mobile)
    if (!found && /^\d{4,}$/.test(q)) {
      const phoneSnap = await window._getDocs(window._query(window._col(db,'ipear_customers'),window._where('phone','==',q)));
      phoneSnap.forEach(d => { if (!found) { found=d.data(); foundId=d.id; } });
    }

    // 3. Email match (contains @)
    if (!found && q.includes('@')) {
      const emailSnap = await window._getDocs(window._query(window._col(db,'ipear_customers'),window._where('email','==',ql)));
      emailSnap.forEach(d => { if (!found) { found=d.data(); foundId=d.id; } });
    }

    // 4. FALLBACK: name search — uses cached snapshot if available (< 30s old), else full scan
    if (!found) {
      let snap = getCachedCustomers(30000);
      if (!snap) {
        snap = await window._getDocs(window._col(db, 'ipear_customers'));
        setCachedCustomers(snap);
      }
      snap.forEach(d=>{
        const data=d.data();
        if ([data.name||'',String(data.phone||''),String(data.card||'')]
            .some(s=>s.toLowerCase().includes(ql))) { found=data; foundId=d.id; }
      });
    }

    if (found) { _hooks.setScope({ cid: foundId, cdata: found }); renderCust(found); }
    else document.getElementById('no-res').style.display='block';
  } catch(e) { toast('❌ '+e.message,'error'); }
  document.getElementById('sspin').classList.remove('show');
}

// ══════════════════════════════════════
//  RENDER selected customer detail card
// ══════════════════════════════════════
export async function renderCust(d) {
  const { cid, cdata } = _hooks.getScope();
  const pts=d.points||0, tot=d.totalPoints||pts;
  const ini=(d.name||'?').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();
  const t=tier(tot);
  document.getElementById('r-av').textContent=ini;
  document.getElementById('r-name').textContent=d.name;
  document.getElementById('r-phone').textContent=d.phone;
  document.getElementById('r-email').textContent=d.email||'—';
  document.getElementById('r-ew').style.display=d.email?'':'none';
  document.getElementById('r-date').textContent=d.createdAt?new Date(d.createdAt).toLocaleDateString('el-GR'):'—';
  document.getElementById('r-card').textContent='📱 '+d.card;
  document.getElementById('r-pts').textContent=pts.toLocaleString('el-GR');
  document.getElementById('r-tot').textContent=tot.toLocaleString('el-GR');
  document.getElementById('r-tv').textContent=t.icon+' '+t.name;
  document.getElementById('r-ticon').textContent=t.icon;
  document.getElementById('r-tname').textContent=t.name;
  if (t.next) {
    const floor=tierFloor(tot);
    const pct=Math.min(100,Math.round(((tot-floor)/(t.next-floor))*100));
    document.getElementById('r-tsub').textContent=`${tot.toLocaleString('el-GR')} / ${t.next.toLocaleString('el-GR')} για ${t.next===1000?'🥈 Silver':t.next===3000?'🥇 Gold':t.next===6000?'💎 Diamond':'👑 Platinum'}`;
    document.getElementById('r-prog').style.width=pct+'%';
  } else {
    document.getElementById('r-tsub').textContent='🏆 Ανώτατη κατάταξη!';
    document.getElementById('r-prog').style.width='100%';
  }
  // Birthday check
  if (d.birthday) {
    const today = new Date(), bday = new Date(d.birthday + 'T12:00:00');
    const isBday = today.getDate()===bday.getDate() && today.getMonth()===bday.getMonth();
    if (isBday) {
      toast(`🎂 Σήμερα είναι τα γενέθλια του/της ${d.name}! 🎉`,'success');
      // Auto-add birthday bonus if not already given this year
      const thisYear = today.getFullYear();
      const lastBdayKey = '_bday_'+cid+'_'+thisYear;
      if (!sessionStorage.getItem(lastBdayKey)) {
        sessionStorage.setItem(lastBdayKey,'1');
        if(confirm(`🎂 Γενέθλια ${d.name}!\nΘέλεις να προσθέσεις αυτόματα 200 πόντους ως δώρο γενεθλίων;`)) {
          const db = DB();
          // Atomic: balance + ledger in one commit (was two separate writes).
          // Per-year deterministic id keeps it idempotent on retries / refreshes.
          let newPts, newTot;
          const bdayLedgerId = `birthday_${cid}_${thisYear}`;
          const nowIsoBd = new Date().toISOString();
          await window._runTransaction(db, async (txn) => {
            const ref  = window._doc(db, 'ipear_customers', cid);
            const snap = await txn.get(ref);
            if (!snap.exists()) throw new Error('Πελάτης δεν βρέθηκε.');
            const live = snap.data();
            newPts = (live.points || 0) + 200;
            newTot = (live.totalPoints || live.points || 0) + 200;
            txn.update(ref, { points: newPts, totalPoints: newTot });
            txn.set(window._doc(db, 'ipear_transactions', bdayLedgerId), {
              customerId: cid, customerUid: d.uid || '',
              customerEmail: d.email || '', customerName: d.name, card: d.card,
              type: 'add', points: 200, amount: 0,
              category: '🎂 Birthday Bonus', note: 'Δώρο γενεθλίων',
              storeId: authState.storeId || null, storeName: authState.storeName,
              date: nowIsoBd,
              createdByAdmin: authState.actorUid || ''
            });
          });
          cdata.points = newPts; cdata.totalPoints = newTot;
          renderCust(cdata);
        }
      }
    }
  }
  // Blocked state
  const isBlocked = !!d.blocked;
  const blockedBadge = document.getElementById('r-blocked-badge');
  const blockBtn = document.getElementById('block-btn');
  if (blockedBadge) blockedBadge.style.display = isBlocked ? 'block' : 'none';
  if (blockBtn) { blockBtn.textContent = isBlocked ? '✅ Unblock' : '🚫 Block'; blockBtn.style.background = isBlocked ? '#4caf50' : '#ff9800'; }
  document.getElementById('cust-result').classList.add('show');
}

// ══════════════════════════════════════
//  BLOCK / UNBLOCK
// ══════════════════════════════════════
let _blockCustBusy = false;
export async function blockCust() {
  if (_blockCustBusy) return;
  const { cid, cdata } = _hooks.getScope();
  if (!cid) return;
  const isBlocked = !!cdata?.blocked;
  const action = isBlocked ? 'ξεμπλοκαριστεί' : 'μπλοκαριστεί';
  if (!confirm(`⚠️ Ο πελάτης "${cdata?.name}" θα ${action}.\n\n${isBlocked ? 'Θα μπορεί να συνδεθεί ξανά στο app.' : 'Δεν θα μπορεί να συνδεθεί στο app.'}`)) return;
  _blockCustBusy = true;
  try {
    await window._updateDoc(window._doc(DB(),'ipear_customers',cid), { blocked: !isBlocked });
    cdata.blocked = !isBlocked;
    renderCust(cdata);
    toast(isBlocked ? '✅ Ο πελάτης ξεμπλοκαρίστηκε.' : '🚫 Ο πελάτης μπλοκαρίστηκε.', 'success');
  } catch(e) { toast('❌ ' + e.message, 'error'); }
  finally { _blockCustBusy = false; }
}

// ══════════════════════════════════════
//  DELETE (Firestore + cascade + Firebase Auth)
// ══════════════════════════════════════
let _deleteCustBusy = false;
export async function deleteCust() {
  if (_deleteCustBusy) return;
  const { cid, cdata } = _hooks.getScope();
  if (!cid) return;
  // ── Double-confirmation: type customer name to prevent accidental cascade delete ──
  if (!confirm(`⚠️ Διαγραφή πελάτη "${cdata?.name}";\nΌλοι οι πόντοι χάνονται οριστικά!`)) return;
  const typedName = prompt(`🛑 ΤΕΛΙΚΗ ΕΠΙΒΕΒΑΙΩΣΗ\n\nΓράψε το όνομα του πελάτη για να επιβεβαιώσεις:\n→ "${cdata?.name}"`);
  if (!typedName || typedName.trim().toLowerCase() !== (cdata?.name || '').trim().toLowerCase()) {
    alert('❌ Το όνομα δεν ταιριάζει. Η διαγραφή ακυρώθηκε.');
    return;
  }
  _deleteCustBusy = true;
  try {
    const db = DB();
    const phone = cdata?.phone || '';
    const email = cdata?.email || '';
    const card  = cdata?.card  || '';

    // ── 1. Delete primary Firestore doc ──────────────────────────────
    await window._deleteDoc(window._doc(db,'ipear_customers',cid));

    // ── 2. CASCADE: find & delete ALL remaining docs with same phone/email/card ──
    // Handles migration duplicates (old random-ID doc + new UID-based doc)
    const uidsToDel = new Set();
    const idsToDel = new Set([cid]); // track all customer doc IDs for downstream cleanup
    if (cdata?.uid) uidsToDel.add(cdata.uid);
    const orphanQueries = [];
    if (phone) orphanQueries.push(window._getDocs(window._query(window._col(db,'ipear_customers'),window._where('phone','==',phone))));
    if (email) orphanQueries.push(window._getDocs(window._query(window._col(db,'ipear_customers'),window._where('email','==',email))));
    if (card)  orphanQueries.push(window._getDocs(window._query(window._col(db,'ipear_customers'),window._where('card','==',card))));
    const results = await Promise.allSettled(orphanQueries);
    const orphanDels = [];
    for (const r of results) {
      if (r.status !== 'fulfilled' || r.value.empty) continue;
      r.value.forEach(d => {
        const od = d.data();
        if (od.uid) uidsToDel.add(od.uid);
        idsToDel.add(d.id);
        orphanDels.push(window._deleteDoc(window._doc(db,'ipear_customers',d.id)));
      });
    }
    if (orphanDels.length) await Promise.allSettled(orphanDels);

    // ── 2b. IAM-FIX: CASCADE related collections (transactions, redemptions, queue) ──
    try {
      const relCleanup = [];
      // Transactions — query by customerId for each known doc ID + by customerEmail/customerUid
      const txQueries = [];
      for (const _id of idsToDel) txQueries.push(window._getDocs(window._query(window._col(db,'ipear_transactions'),window._where('customerId','==',_id))));
      if (email) txQueries.push(window._getDocs(window._query(window._col(db,'ipear_transactions'),window._where('customerEmail','==',email))));
      for (const _uid of uidsToDel) txQueries.push(window._getDocs(window._query(window._col(db,'ipear_transactions'),window._where('customerUid','==',_uid))));
      const txResults = await Promise.allSettled(txQueries);
      const seenTxIds = new Set();
      for (const r of txResults) {
        if (r.status !== 'fulfilled' || r.value.empty) continue;
        r.value.forEach(d => { if (!seenTxIds.has(d.id)) { seenTxIds.add(d.id); relCleanup.push(window._deleteDoc(window._doc(db,'ipear_transactions',d.id))); } });
      }
      // Redemptions — query by customerUid
      for (const _uid of uidsToDel) {
        const redQ = await window._getDocs(window._query(window._col(db,'ipear_redemptions'),window._where('customerUid','==',_uid)));
        redQ.forEach(d => relCleanup.push(window._deleteDoc(window._doc(db,'ipear_redemptions',d.id))));
      }
      // Referral queue — keyed by UID
      for (const _uid of uidsToDel) {
        relCleanup.push(window._deleteDoc(window._doc(db,'ipear_referral_queue',_uid)).catch(() => {}));
      }
      // Notifications — query by customerUid (best-effort)
      for (const _uid of uidsToDel) {
        try {
          const nQ = await window._getDocs(window._query(window._col(db,'ipear_notifications'),window._where('customerUid','==',_uid)));
          nQ.forEach(d => relCleanup.push(window._deleteDoc(window._doc(db,'ipear_notifications',d.id))));
        } catch(_) {}
      }
      // GDPR Art.17: Offer redemptions — query by customerId (auth UID)
      for (const _uid of uidsToDel) {
        try {
          const ofQ = await window._getDocs(window._query(window._col(db,'ipear_offer_redemptions'),window._where('customerId','==',_uid)));
          ofQ.forEach(d => relCleanup.push(window._deleteDoc(window._doc(db,'ipear_offer_redemptions',d.id))));
        } catch(_) {}
      }
      // GDPR Art.17: Birthday claims — query by customerUid
      for (const _uid of uidsToDel) {
        try {
          const bdQ = await window._getDocs(window._query(window._col(db,'ipear_birthday_claims'),window._where('customerUid','==',_uid)));
          bdQ.forEach(d => relCleanup.push(window._deleteDoc(window._doc(db,'ipear_birthday_claims',d.id))));
        } catch(_) {}
      }
      if (relCleanup.length) await Promise.allSettled(relCleanup);
      // GDPR Art.17: Anonymize audit_logs (pseudonymization — keep log, strip PII)
      for (const _uid of uidsToDel) {
        try {
          const auditQ = await window._getDocs(window._query(window._col(db,'audit_logs'),window._where('customerUid','==',_uid)));
          const anonOps = [];
          auditQ.forEach(d => anonOps.push(window._updateDoc(window._doc(db,'audit_logs',d.id), {
            customerId: '[DELETED]', customerUid: '[DELETED]', _anonymizedAt: new Date().toISOString()
          })));
          if (anonOps.length) await Promise.allSettled(anonOps);
        } catch(_) {}
      }
    } catch(cascadeErr) { logger.warn('[delete-cascade] partial failure:', cascadeErr?.message); }

    // ── 3. Delete ALL Firebase Auth accounts found ───────────────────
    // The worker uses Identity Toolkit admin API — without this step the email
    // stays locked in Firebase Auth and the customer cannot re-register with
    // the same email. We send BOTH uid (when known) AND email (as fallback)
    // so the worker can resolve legacy customers without a stored uid.
    const workerUrl = localStorage.getItem('ipear_worker_url');
    const workerSec = _hooks.getWorkerSecret();
    let authIssue = null;
    if (!workerUrl || !workerSec) {
      authIssue = 'no-worker';
    } else {
      const endpoint = workerUrl.replace(/\/$/, '') + '/admin/delete-auth-user';
      const headers  = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + workerSec };
      const targets = [];
      // Always include each known uid
      for (const uid of uidsToDel) targets.push({ uid, email });
      // If we never collected a uid, attempt email-only fallback (worker resolves via Identity Toolkit lookup)
      if (!targets.length && email) targets.push({ email });
      const results = await Promise.allSettled(targets.map(payload =>
        fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) })
          .then(async r => {
            if (!r.ok) {
              const body = await r.json().catch(() => ({}));
              throw new Error(body.error || ('HTTP ' + r.status));
            }
            return r.json();
          })
      ));
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) {
        authIssue = 'partial';
        logger.warn('[delete-auth] failures:', failed.map(f => f.reason?.message));
      }
    }

    document.getElementById('cust-result').classList.remove('show');
    document.getElementById('sinput').value='';
    _hooks.setScope({ cid: null, cdata: null });
    if (authIssue === 'no-worker') {
      toast('⚠️ Πελάτης διαγράφηκε από Firestore, αλλά το Firebase Auth account ΠΑΡΑΜΕΝΕΙ — δεν είναι ρυθμισμένο το Worker secret. Διαγράψτε το χειροκίνητα από το Firebase Console για να μπορέσει ο πελάτης να ξαναγραφτεί.','error');
    } else if (authIssue === 'partial') {
      toast('⚠️ Ο πελάτης διαγράφηκε αλλά μέρος των Firebase Auth accounts ίσως παραμένει. Έλεγξε το Firebase Console.','error');
    } else {
      toast('🗑 Ο πελάτης διαγράφηκε.','success');
    }
    loadStats(); loadAll();
  } catch(e) { toast('❌ '+e.message,'error'); }
  finally { _deleteCustBusy = false; }
}

// ══════════════════════════════════════
//  EDIT (name / phone / email / birthday)
// ══════════════════════════════════════
export function openEdit() {
  const { cid, cdata } = _hooks.getScope();
  if (!cdata) return;
  document.getElementById('edit-cid').value = cid;
  document.getElementById('ed-name').value  = cdata.name  || '';
  document.getElementById('ed-phone').value = cdata.phone || '';
  document.getElementById('ed-email').value = cdata.email || '';
  document.getElementById('ed-bday').value  = cdata.birthday || '';
  document.getElementById('m-edit').classList.add('show');
}

export async function saveEdit() {
  if (!authState.authenticated) { toast('⛔ Δεν έχεις συνδεθεί!','error'); return; }
  const { cid, cdata } = _hooks.getScope();
  const name  = document.getElementById('ed-name').value.trim();
  const phone = document.getElementById('ed-phone').value.trim().replace(/[\s\-()]/g,'');
  const email = document.getElementById('ed-email').value.trim().toLowerCase();
  const birthday = document.getElementById('ed-bday').value;
  if (!name || !phone) { toast('⚠️ Όνομα και τηλέφωνο υποχρεωτικά!','error'); return; }
  if (!/^6\d{9}$/.test(phone)) { toast('⚠️ Το τηλέφωνο πρέπει να είναι ελληνικός αριθμός κινητού (π.χ. 6912345678)','error'); return; }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('⚠️ Εισάγετε έγκυρο email','error'); return; }
  // Validate birthday is not in the future
  if (birthday && new Date(birthday) > new Date()) { toast('⚠️ Η ημερομηνία γέννησης δεν μπορεί να είναι στο μέλλον','error'); return; }
  try {
    await window._updateDoc(window._doc(DB(),'ipear_customers',cid), {name,phone,email,birthday});
    Object.assign(cdata, {name,phone,email,birthday});
    renderCust(cdata);
    toast('✅ Τα στοιχεία ενημερώθηκαν!','success'); closeM();
    loadAll();
  } catch(e) { toast('❌ '+e.message,'error'); }
}

// ══════════════════════════════════════
//  CUSTOMERS TABLE (full list, sortable, segment-filterable)
// ══════════════════════════════════════
let _activeSegment = null;
let _allCustRows = []; // cached for client-side search filtering

export async function loadAll() {
  if (!authState.authenticated) return;
  if (!navigator.onLine) return;
  const db=DB(); if(!db) return;
  const tb=document.getElementById('ctbody');
  tb.innerHTML='<tr><td colspan="6" class="empty"><span class="e">⏳</span>Φόρτωση...</td></tr>';
  try {
    let snap = getCachedCustomers(5000);
    if (!snap) { snap = await window._getDocs(window._col(db, 'ipear_customers')); setCachedCustomers(snap); }
    if (snap.empty) { tb.innerHTML='<tr><td colspan="6" class="empty"><span class="e">📭</span>Κανένας πελάτης ακόμα</td></tr>'; _allCustRows=[]; return; }
    // Determine which IDs to show (null = all)
    const filterIds = (_activeSegment && window._segments?.[_activeSegment]) ? new Set(window._segments[_activeSegment]) : null;
    // Collect all rows, then sort by totalPoints descending
    const rows = [];
    snap.forEach(d=>{
      if (filterIds && !filterIds.has(d.id)) return;
      const data=d.data(), pts=data.points||0, tot=data.totalPoints||pts;
      rows.push({ id: d.id, data, pts, tot });
    });
    rows.sort((a,b) => b.tot - a.tot || (a.data.name||'').localeCompare(b.data.name||'','el'));
    _allCustRows = rows;
    _renderCustRows(rows);

    // ── Auto-publish leaderboard for customer app ──
    _publishLeaderboard(snap);

  } catch(e) { tb.innerHTML='<tr><td colspan="6">❌ '+escHtml(e.message)+'</td></tr>'; }
}

function _renderCustRows(rows) {
  const tb=document.getElementById('ctbody');
  if (!rows.length) { tb.innerHTML='<tr><td colspan="6" class="empty"><span class="e">🔍</span>Κανένας πελάτης σε αυτό το segment</td></tr>'; return; }
  let r='';
  rows.forEach(({id,data,pts,tot})=>{
    const t=tier(tot);
    const rowCls = data.blocked ? ' class="row-blocked"' : data.suspicious ? ' class="row-suspicious"' : '';
    const badge = data.blocked ? ' <span class="watchlist-badge wb-blocked">BLOCKED</span>'
                : data.suspicious ? ' <span class="watchlist-badge wb-suspicious">SUSPECT</span>' : '';
    const pushIcon = data.fcmToken ? ' <span class="push-bell" title="Push ενεργό" style="font-size:.7rem;opacity:.7">🔔</span>' : '<span class="push-bell"></span>';
    r+=`<tr${rowCls} data-uid="${id}">
      <td><strong>${escHtml(data.card)}</strong></td><td>${escHtml(data.name)}${pushIcon}${badge}</td><td>${escHtml(data.phone)}</td>
      <td>
        <strong style="color:#4caf50">${pts.toLocaleString('el-GR')}</strong>
        <div style="font-size:.72rem;color:var(--gray)">Σύνολο: ${tot.toLocaleString('el-GR')}</div>
      </td>
      <td><span class="badge ${t.cls}">${t.icon} ${t.name}</span></td>
      <td><button class="btn btn-green btn-sm" data-action="quickSel" data-arg="${escJs(id)}">Επιλογή</button></td>
    </tr>`;
  });
  tb.innerHTML = r;
}

// Window-exposed for the in-table client-side filter (no recompute, just slice _allCustRows)
export function _filterCustTable() {
  const q = (document.getElementById('cust-search')?.value || '').trim().toLowerCase();
  if (!q) { _renderCustRows(_allCustRows); return; }
  const filtered = _allCustRows.filter(({data}) =>
    (data.name||'').toLowerCase().includes(q) ||
    (data.card||'').toLowerCase().includes(q) ||
    (data.phone||'').includes(q) ||
    (data.email||'').toLowerCase().includes(q)
  );
  _renderCustRows(filtered);
}

export function clearSegmentFilter() {
  _activeSegment = null;
  const filterBar = document.getElementById('seg-filter-bar');
  if (filterBar) filterBar.style.display = 'none';
  loadAll();
}

export async function quickSel(id) {
  try {
    const snap = await window._getDoc(window._doc(DB(),'ipear_customers',id));
    if (snap.exists()) {
      _hooks.setScope({ cid: id, cdata: snap.data() });
      _hooks.showTab('search');
      renderCust(snap.data());
    }
  } catch(e) { toast('❌ '+e.message,'error'); }
}

// ══════════════════════════════════════
//  SEGMENTS (RFM-style buckets + chip filter)
// ══════════════════════════════════════
export function renderSegments(csnap, tsnap) {
  const now = new Date();
  const txByCustomer = {};
  tsnap.forEach(d => {
    const tx = d.data();
    if (!txByCustomer[tx.customerId]) txByCustomer[tx.customerId] = [];
    txByCustomer[tx.customerId].push(tx);
  });

  const segs = { champions:[], loyal:[], atRisk:[], dormant:[], newC:[], all:0 };
  segs.all = csnap.size;

  csnap.forEach(d => {
    const c = d.data(); const id = d.id;
    const txs = (txByCustomer[id]||[]).filter(t=>t.type==='add');
    const createdAt = new Date(c.createdAt||0);
    const daysSinceJoin = (now-createdAt)/86400000;

    const last30 = txs.filter(t => (now-new Date(t.date))<30*86400000);
    const lastTx = txs.length ? Math.max(...txs.map(t=>new Date(t.date))) : null;
    const daysSinceLast = lastTx ? (now-lastTx)/86400000 : 999;

    if (daysSinceJoin <= 30) { segs.newC.push(id); return; }
    if (last30.length >= 3)  { segs.champions.push(id); return; }
    if (daysSinceLast <= 60 && (c.totalPoints||0) >= 500) { segs.loyal.push(id); return; }
    if (daysSinceLast >= 60 && daysSinceLast < 90 && (c.points||0) > 0) { segs.atRisk.push(id); return; }
    if (daysSinceLast >= 90)  { segs.dormant.push(id); }
  });

  const defs = [
    { key:'champions', icon:'🏆', label:'Champions',  color:'#8ae900', bg:'#f0ffe0', desc:'3+ αγορές/μήνα' },
    { key:'loyal',     icon:'⚡', label:'Loyal',      color:'#2196f3', bg:'#e3f2fd', desc:'Τακτικοί πελάτες' },
    { key:'newC',      icon:'🆕', label:'Νέοι',       color:'#9c27b0', bg:'#f3e5f5', desc:'< 30 ημέρες' },
    { key:'atRisk',    icon:'⚠️', label:'At Risk',    color:'#ff9800', bg:'#fff3e0', desc:'60-90 ημέρες αδράνεια' },
    { key:'dormant',   icon:'😴', label:'Αδρανείς',   color:'#e53935', bg:'#fff3f3', desc:'90+ ημέρες' },
  ];

  document.getElementById('seg-grid').innerHTML = defs.map(s => `
    <div style="background:${s.bg};border:1.5px solid ${s.color}33;border-radius:13px;padding:14px 12px;cursor:pointer"
         title="${s.desc}" data-action="filterBySegment" data-arg="${s.key}">
      <div style="font-size:1.5rem;margin-bottom:6px">${s.icon}</div>
      <div style="font-size:1.8rem;font-weight:900;color:${s.color};line-height:1">${segs[s.key].length}</div>
      <div style="font-size:.78rem;font-weight:700;color:#555;margin-top:4px">${s.label}</div>
      <div style="font-size:.72rem;color:#888;margin-top:2px">${s.desc}</div>
    </div>
  `).join('') + `
    <div style="background:#f5f5f5;border:1.5px solid #ddd;border-radius:13px;padding:14px 12px">
      <div style="font-size:1.5rem;margin-bottom:6px">👥</div>
      <div style="font-size:1.8rem;font-weight:900;color:#333;line-height:1">${segs.all}</div>
      <div style="font-size:.78rem;font-weight:700;color:#555;margin-top:4px">Σύνολο</div>
      <div style="font-size:.72rem;color:#888;margin-top:2px">Εγγεγραμμένοι</div>
    </div>`;

  // Store for filter use
  window._segments = segs;
}

const _SEG_LABELS = { champions:'🏆 Champions', loyal:'⚡ Loyal', newC:'🆕 Νέοι', atRisk:'⚠️ At Risk', dormant:'😴 Αδρανείς' };

export function filterBySegment(key) {
  if (!window._segments || !window._segments[key]) return;
  _activeSegment = key;
  const count = window._segments[key].length;
  const label = _SEG_LABELS[key] || key;
  const filterBar = document.getElementById('seg-filter-bar');
  const filterLabel = document.getElementById('seg-filter-label');
  if (filterBar)  { filterBar.style.display = 'flex'; }
  if (filterLabel){ filterLabel.textContent = `🎯 Φίλτρο: ${label} — ${count} πελάτες`; }
  _hooks.showTab('customers');
  loadAll();
}
