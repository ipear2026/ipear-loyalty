import './styles/admin.css';
import { logger } from './logger.js';
// ═══════════════════════════════════════════════════════════════════════════
//  iPear Loyalty — Admin Panel (ES Module Entry Point)
//  Shared core: firebase-init.js (Firebase refs), utils.js (tier)
// ═══════════════════════════════════════════════════════════════════════════
import './firebase-init.js';
import { tier, escHtml, escJs, tierFloor } from './utils.js';
import {
  setAnPeriod,
  loadAnalytics,
  renderAnalytics,
  openDrillDown,
} from './admin/analytics.js';
import { toast, closeM } from './admin/ui.js';
import {
  getWorkerSecret as _getWorkerSecret,
  setWorkerSecret as _setWorkerSecret,
  clearWorkerSecret as _clearWorkerSecret,
} from './admin/worker-secret.js';
import { processBirthdayClaims as _processBirthdayClaims } from './admin/birthday-claims.js';
import { fillPushTpl, sendPushNotification } from './admin/push-fcm.js';
import {
  toggleWorkerConfig,
  saveWorkerConfig,
  testWorkerConnection,
  checkWorkerHealth,
  fillEmailTpl,
  toggleEmailTargetSearch,
  searchEmailOne,
  selectEmailOne,
  sendEmailBulk,
} from './admin/email-worker.js';
import { fillTpl, prepBulk } from './admin/bulk-notifications.js';
import { authState } from './admin/auth-state.js';
import {
  loadOffers,
  previewOfferImage,
  removeOfferImage,
  openOfferModal,
  openOfferEdit,
  saveOffer,
  sendOfferPush,
  toggleOffer,
  deleteOffer,
} from './admin/offers.js';
import {
  initRedemptionVerify,
  verifyCode,
  confirmVerify,
  confirmOfferVerify,
} from './admin/redemption-verify.js';
import {
  initApprovals,
  startApprovalListener,
  stopApprovalListener,
  approveOffer,
  rejectOffer,
} from './admin/approvals.js';
import {
  initPushListener,
  startPushListener as _startPushListener,
  stopPushListener,
} from './admin/push-listener.js';
import { publishLeaderboard as _publishLeaderboard } from './admin/leaderboard.js';
import { exportCSV } from './admin/csv-export.js';
import { startMaintenanceListener, stopMaintenanceListener, toggleKillSwitch } from './admin/kill-switch.js';
import {
  scanOrphans,
  deleteOrphanTxs,
  deleteGhostCustomer,
  deleteSecondaryOrphans,
  runSystemHealthCheck,
  configureSystemHealth,
} from './admin/system-health.js';
import { loadWorkerHealth } from './admin/worker-health.js';
import {
  previewExpirePoints,
  executeExpirePoints,
  previewTierDowngrade,
  executeTierDowngrade,
} from './admin/maintenance.js';
import { getCachedCustomers, setCachedCustomers } from './admin/snapshot-cache.js';
import { loadStats, configureStats } from './admin/stats.js';
import {
  previewSmsBulk,
  previewEmailBulk,
  fillSmsBulkTpl,
  sendSMSBulk,
} from './admin/bulk-messaging-send.js';

// Wire push-listener: keep admin-main's _allCustRows cache in sync.
initPushListener({
  onCustomerChange: (id, data) => {
    const idx = _allCustRows.findIndex((r) => r.id === id);
    if (idx >= 0) {
      _allCustRows[idx].data = data;
      _allCustRows[idx].pts = data.points || 0;
      _allCustRows[idx].tot = data.totalPoints || data.points || 0;
    }
  },
});

// Wire approvals module to admin-main's store context + refresh callbacks.
initApprovals({
  getStoreContext: () => ({ storeId: _storeId, storeName: _storeName }),
  refreshAdminViews: () => {
    loadTx();
    loadStats();
  },
});

// Wire redemption-verify module to admin-main's mutable state (cid/cdata,
// _storeId/_storeName) and refresh callbacks (loadTx/loadStats) without
// leaking those globals into the module itself.
initRedemptionVerify({
  getStoreContext: () => ({ storeId: _storeId, storeName: _storeName }),
  onRedemptionApproved: ({ customerId, newPoints }) => {
    if (cid === customerId && cdata) {
      cdata.points = newPoints;
      renderCust(cdata);
    }
  },
  refreshAdminViews: () => {
    loadTx();
    loadStats();
  },
});

window.ADMIN_BUILD_TAG = 'admin-20260605-a11y1';
logger.log('admin.html loaded', window.ADMIN_BUILD_TAG);

// ── Admin auth wrappers (production — using Firebase refs from firebase-init.js) ──
if (!window.DEMO) {
  window._adminSignIn = async (email, pass) => {
    const cred = await window._signIn(window._auth, email, pass);
    return cred.user;
  };
  window._adminSignOut = window._signOut;
}

// ── Admin demo mode overrides ──
if (window.DEMO) {
  const _DC = [
    {id:'dc1',name:'Νότης Μπουντούρης',phone:'6912345678',card:'IP-00001',points:750,totalPoints:1850,email:'notis@ipear.gr',createdAt:new Date(Date.now()-90*864e5).toISOString()},
    {id:'dc2',name:'Μαρία Κωνσταντίνου',phone:'6923456789',card:'IP-00002',points:2200,totalPoints:3800,email:'maria@demo.gr',createdAt:new Date(Date.now()-180*864e5).toISOString()},
    {id:'dc3',name:'Νίκος Αντωνίου',phone:'6934567890',card:'IP-00003',points:4500,totalPoints:7200,email:'',createdAt:new Date(Date.now()-365*864e5).toISOString()},
  ];
  const _DT = [
    {id:'t1',customerId:'dc1',customerName:'Νότης Μπουντούρης',card:'IP-00001',type:'add',points:150,amount:100,category:'📱 Αξεσουάρ (1x)',date:new Date(Date.now()-2*864e5).toISOString()},
    {id:'t2',customerId:'dc1',customerName:'Νότης Μπουντούρης',card:'IP-00001',type:'add',points:225,amount:150,category:'🔧 Επισκευή (1.5x)',date:new Date(Date.now()-7*864e5).toISOString()},
    {id:'t3',customerId:'dc1',customerName:'Νότης Μπουντούρης',card:'IP-00001',type:'redeem',points:-250,discount:5,date:new Date(Date.now()-15*864e5).toISOString()},
    {id:'t4',customerId:'dc2',customerName:'Μαρία Κωνσταντίνου',card:'IP-00002',type:'add',points:300,amount:200,category:'🎨 Custom Θήκη (1.5x)',date:new Date(Date.now()-864e5).toISOString()},
    {id:'t5',customerId:'dc3',customerName:'Νίκος Αντωνίου',card:'IP-00003',type:'add',points:500,amount:333,category:'🔧 Επισκευή (1.5x)',date:new Date(Date.now()-3*864e5).toISOString()},
  ];
  const _DO = [
    {id:'o1',emoji:'🎁',title:'Διπλοί Πόντοι Σαββατοκύριακο',description:'Αυτό το Σαββατοκύριακο κέρδισε διπλούς πόντους!',startDate:new Date().toISOString().split('T')[0],endDate:new Date(Date.now()+3*864e5).toISOString().split('T')[0],active:true,createdAt:new Date().toISOString()},
  ];
  const snap=a=>({empty:!a.length,size:a.length,forEach:cb=>a.forEach(d=>cb({id:d.id,data:()=>({...d})}))});
  window._db={};
  window._col=(db,n)=>({_n:n});
  window._getDocs=async ref=>{
    const n=ref._n||(ref._ref&&ref._ref._n);
    const args=ref._args||[];
    let data=n==='ipear_customers'?[..._DC]:n==='ipear_transactions'?[..._DT]:n==='ipear_offers'?[..._DO]:n==='ipear_redemptions'?JSON.parse(localStorage.getItem('_ipear_codes')||'[]'):[];
    for(const a of args){
      if(a._t==='w'&&a.op==='==') data=data.filter(d=>String(d[a.f])===String(a.v));
      if(a._t==='o'&&a.dir==='desc') data=[...data].sort((x,y)=>new Date(y.date)-new Date(x.date));
      if(a._t==='l') data=data.slice(0,a.n);
    }
    return snap(data);
  };
  window._query=(ref,...a)=>({_ref:ref,_args:a});
  window._where=(f,op,v)=>({_t:'w',f,op,v});
  window._orderBy=(f,d)=>({_t:'o',f,dir:d});
  window._limit=n=>({_t:'l',n});
  window._addDoc=async(ref,data)=>{const id='d'+Date.now();if(ref._n==='ipear_customers')_DC.push({id,...data});if(ref._n==='ipear_transactions')_DT.push({id,...data});if(ref._n==='ipear_offers')_DO.push({id,...data});return{id};};
  window._updateDoc=async(ref,data)=>{if(ref._col==='ipear_redemptions'){const codes=JSON.parse(localStorage.getItem('_ipear_codes')||'[]');const i=codes.findIndex(d=>d.id===ref._id);if(i>=0){Object.assign(codes[i],data);localStorage.setItem('_ipear_codes',JSON.stringify(codes));}return;}const arr=ref._col==='ipear_customers'?_DC:ref._col==='ipear_transactions'?_DT:_DO;const i=arr.findIndex(d=>d.id===ref._id);if(i>=0)Object.assign(arr[i],data);};
  window._deleteDoc=async(ref)=>{const arr=ref._col==='ipear_customers'?_DC:ref._col==='ipear_transactions'?_DT:_DO;const i=arr.findIndex(d=>d.id===ref._id);if(i>=0)arr.splice(i,1);};
  window._setDoc=async(ref,data)=>{const arr=ref._col==='ipear_customers'?_DC:ref._col==='ipear_transactions'?_DT:_DO;const i=arr.findIndex(d=>d.id===ref._id);if(i>=0)Object.assign(arr[i],data);else arr.push({id:ref._id,...data});};
  window._doc=(db,col,id)=>({_col:col,_id:id});
  const _DEMO_STORES = { 'store-demo': { name: 'iPear Demo', city: 'Demo' } };
  const _DEMO_ADMINS = { 'demo-admin': { storeid: 'store-demo' } };
  window._getDoc=async(ref)=>{
    if(ref._col==='ipear_stores')   { const d=_DEMO_STORES[ref._id]; return {exists:()=>!!d, data:()=>d?{...d}:undefined, id:ref._id}; }
    if(ref._col==='ipear_admins') { const d=_DEMO_ADMINS[ref._id]; return {exists:()=>!!d, data:()=>d?{...d}:undefined, id:ref._id}; }
    const arr=ref._col==='ipear_customers'?_DC:ref._col==='ipear_transactions'?_DT:ref._col==='ipear_offers'?_DO:[];
    const d=arr.find(x=>x.id===ref._id);
    return {exists:()=>!!d, data:()=>d?{...d}:undefined, id:ref._id};
  };
  window._runTransaction = async (db, fn) => {
    const writes = [];
    const txn = {
      get:    (ref)       => window._getDoc(ref),
      update: (ref, data) => { writes.push(() => window._updateDoc(ref, data)); },
      set:    (ref, data) => { writes.push(() => window._setDoc  (ref, data)); },
    };
    const result = await fn(txn);
    for (const w of writes) await w();
    return result;
  };
  window._auth = {};
  window._adminSignIn = async (email, pass) => {
    if (email === 'admin@ipear.gr' && pass === 'admin1234') return { uid: 'demo-admin' };
    throw { code: 'auth/wrong-password' };
  };
  window._adminSignOut = async () => {};
  window._onSnapshot = (ref, cb) => { cb({ forEach:()=>{}, empty:true, size:0 }); return ()=>{}; };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN APPLICATION CODE
// ═══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════
//  LOCK
// ══════════════════════════════════════
let _adminAttempts = 0;
let _adminLockUntil = 0;
let _adminActorUid = null;

// Shared post-auth bootstrap. Used by manual unlock() AND by silent
// _tryAdminAutoRestore() when Firebase Auth carries a live session forward
// (page reload, 30-min sleep recovery, Chrome memory-saver tab restore).
async function _completeAdminAuth(user) {
  _adminActorUid = user?.uid || null;
  authState.actorUid = _adminActorUid;
  _storeId = null; _storeName = '—';
  authState.storeId = null; authState.storeName = '—';

  const adminRef  = window._doc(window._db, 'ipear_admins', user.uid);
  const adminSnap = await window._getDoc(adminRef);
  if (!window.DEMO && !adminSnap.exists()) {
    await window._adminSignOut().catch(() => {});
    throw new Error('not-admin');
  }
  _storeId = adminSnap.data()?.storeid || null;
  authState.storeId = _storeId;

  if (_storeId) {
    try {
      const storeSnap = await window._getDoc(window._doc(window._db, 'ipear_stores', _storeId));
      if (storeSnap.exists()) {
        _storeName = storeSnap.data().name || '—';
        authState.storeName = _storeName;
        const badge = document.getElementById('store-badge');
        if (badge) { badge.textContent = '🏪 ' + _storeName; badge.style.display = 'inline-block'; }
        const regBadge = document.getElementById('reg-store-badge');
        if (regBadge) { regBadge.textContent = '🏪 Εγγραφή για: ' + _storeName; regBadge.style.display = 'block'; }
      }
    } catch(_) {}
  }

  authState.authenticated = true;
  document.getElementById('lock').style.display = 'none';
  document.getElementById('lock-in').value  = '';
  document.getElementById('lock-email').value = '';
  document.getElementById('admin-logout-btn').style.display = 'flex';
  configureSystemHealth({ onDataChanged: loadStats });
  configureStats({ onSnapshot: renderSegments });
  loadStats(); loadTx(); loadAll(); loadOffers(); startApprovalListener(); _startPushListener();
  processReferralQueue(); loadKpiOverview(); startMaintenanceListener(); checkWorkerHealth();
  loadDeletionRequests();
}

// Silent auto-restore: if Firebase Auth has a valid session in the tab's
// IndexedDB (set on first unlock with SESSION persistence), skip the email
// /password lock screen entirely. Falls back to the lock screen on any error.
let _autoRestoreAttempted = false;
async function _tryAdminAutoRestore() {
  if (_autoRestoreAttempted) return;
  _autoRestoreAttempted = true;
  const user = window._auth?.currentUser;
  if (!user) return;  // no session → keep lock screen visible
  logger.log('%c[ADMIN] 🔓 auto-restoring from Firebase session: ' + user.email, 'color:#00cc00;font-weight:bold;font-size:14px');
  try { await _completeAdminAuth(user); }
  catch(e) {
    logger.warn('[ADMIN] auto-restore failed:', e.message);
    // Lock screen is already visible by default — nothing to do
  }
}

// Bootstrap: kick auto-restore as soon as firebase-init.js finishes loading.
// firebase-init uses top-level await so by the time this module runs the flag
// may already be set; otherwise wait for the event.
if (window._firebaseReady) _tryAdminAutoRestore();
else window.addEventListener('firebase-ready', _tryAdminAutoRestore);

async function unlock() {
  const email = document.getElementById('lock-email').value.trim().toLowerCase();
  const pass  = document.getElementById('lock-in').value;
  const err   = document.getElementById('lock-err');
  const btn   = document.getElementById('lock-btn');
  err.textContent = '';
  if (!email || !email.includes('@')) { err.textContent = '⚠️ Εισάγετε email.'; return; }
  if (!pass) { err.textContent = '⚠️ Εισάγετε κωδικό.'; return; }
  if (Date.now() < _adminLockUntil) {
    const secs = Math.ceil((_adminLockUntil - Date.now()) / 1000);
    err.textContent = `🔒 Κλειδωμένο — δοκίμασε σε ${secs}s`; return;
  }
  btn.disabled = true; btn.textContent = '⏳';
  try {
    const user = await window._adminSignIn(email, pass);
    await _completeAdminAuth(user);
  } catch(e) {
    if (e.message === 'not-admin') {
      err.textContent = '⛔ Ο λογαριασμός δεν έχει δικαιώματα admin.';
      btn.disabled = false; btn.textContent = 'Είσοδος →'; return;
    }
    _adminAttempts++;
    if (_adminAttempts >= 5) {
      _adminLockUntil = Date.now() + 60000; // 60s lockout after 5 failures
      _adminAttempts = 0;
    }
    const msgs = {
      'auth/wrong-password':        '❌ Λάθος κωδικός.',
      'auth/user-not-found':        '❌ Δεν βρέθηκε λογαριασμός.',
      'auth/invalid-credential':    '❌ Λάθος email ή κωδικός.',
      'auth/too-many-requests':     '⚠️ Πάρα πολλές προσπάθειες. Δοκίμασε αργότερα.',
      'auth/invalid-email':         '⚠️ Μη έγκυρο email.',
    };
    err.textContent = msgs[e.code] || ('❌ ' + (e.message || e.code));
  }
  btn.disabled = false; btn.textContent = 'Είσοδος →';
}

function adminLogout() {
  try { window._adminSignOut(); } catch(_) {}
  // Stop real-time listeners (prevent leak + stale re-login)
  stopApprovalListener();
  stopPushListener();
  stopMaintenanceListener();
  _adminActorUid = null;
  authState.actorUid = null;
  // Clear session-sensitive runtime state
  authState.authenticated = false;  // H-7: block data-loading after logout
  _activeSegment = null;
  cid = null; cdata = null; msgCh = '';
  _storeId = null; _storeName = '—';
  authState.storeId = null; authState.storeName = '—';
  // Clear sessionStorage (worker secret lives only for this tab session)
  _clearWorkerSecret();
  localStorage.removeItem('ipear_worker_url');
  // Clear UI: customer result
  document.getElementById('cust-result')?.classList.remove('show');
  const sinput = document.getElementById('sinput');
  if (sinput) sinput.value = '';
  // kpi-overview merged into dashboard — no hide needed
  const whEl = document.getElementById('worker-health');
  if (whEl) whEl.style.display = 'none';
  // Clear UI: store badges
  const badge = document.getElementById('store-badge');
  if (badge) { badge.textContent = ''; badge.style.display = 'none'; }
  const regBadge = document.getElementById('reg-store-badge');
  if (regBadge) { regBadge.textContent = ''; regBadge.style.display = 'none'; }
  // Clear UI: lock screen inputs
  document.getElementById('lock-email').value = '';
  document.getElementById('lock-in').value = '';
  document.getElementById('lock-err').textContent = '';
  document.getElementById('admin-logout-btn').style.display = 'none';
  document.getElementById('lock').style.display = 'flex';
  // Return to search tab (safe default)
  showTab('search');
}

// ══════════════════════════════════════
//  XSS GUARD (escHtml + escJs imported from utils.js)
// ══════════════════════════════════════

// ══════════════════════════════════════
//  STATE
// ══════════════════════════════════════
let cid = null, cdata = null, msgCh = '';
let _storeId = null, _storeName = '—';
const DB = () => window._db;
const TABS = ['search','register','customers','transactions','approvals','offers','marketing','stats','system','gdpr'];

// ══════════════════════════════════════
//  ONLINE
// ══════════════════════════════════════
function setOnline(on) {
  document.getElementById('cdot').className = 'conn-dot ' + (on ? 'ok' : 'err');
  document.getElementById('ctxt').textContent = on ? 'Firebase' : 'OFFLINE';
  if (!on) toast('🔴 Χάθηκε το ίντερνετ!', 'error');
}
window.addEventListener('online',  () => { setOnline(true); _adminKeepAliveRefresh(); });
window.addEventListener('offline', () => setOnline(false));
// ── Worker secret helpers  →  moved to ./admin/worker-secret.js ──

setOnline(navigator.onLine);
// firebase-init.js already executed (imported above) — run directly
if (window.DEMO) document.getElementById('lock-demo').style.display = 'block';

// ── KEEPALIVE: auto-refresh data + recover from sleep/background ──────────
let _adminLastRefresh = 0;
const _ADMIN_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

function _adminKeepAliveRefresh() {
  if (!authState.authenticated || !navigator.onLine) return;
  const now = Date.now();
  if (now - _adminLastRefresh < 30000) return; // debounce 30s
  _adminLastRefresh = now;
  try { loadStats(); loadTx(); loadOffers(); startApprovalListener(); _startPushListener(); loadKpiOverview(); checkWorkerHealth(); } catch(e) { logger.warn('[keepalive] refresh error:', e.message); }
  // keepalive refreshed
}

// Periodic refresh every 5 min
setInterval(() => { if (authState.authenticated) _adminKeepAliveRefresh(); }, _ADMIN_REFRESH_INTERVAL);

// Recover from sleep/tab-switch: visibilitychange + pageshow
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && authState.authenticated) {
    // If asleep >30 min, Firestore listeners are dead — full reload
    if (Date.now() - _adminLastRefresh > 30 * 60 * 1000) {
      logger.log('[keepalive] admin was asleep >30min, reloading...');
      location.reload();
      return;
    }
    setTimeout(_adminKeepAliveRefresh, 500);
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && authState.authenticated) {
    logger.log('[keepalive] bfcache restore, reloading...');
    location.reload();
  }
});
window.addEventListener('focus', () => {
  if (authState.authenticated) setTimeout(_adminKeepAliveRefresh, 300);
});

// ══════════════════════════════════════
//  TABS
// ══════════════════════════════════════
function showTab(n) {
  document.querySelectorAll('.tc').forEach(e => e.classList.remove('show'));
  document.querySelectorAll('.tab').forEach(e => e.classList.remove('active'));
  document.getElementById('tab-'+n).classList.add('show');
  const idx = TABS.indexOf(n);
  document.querySelectorAll('.tab')[idx]?.classList.add('active');
  if (n==='stats') { loadStats(); loadAnalytics(); }
  if (n==='transactions') loadTx();
  if (n==='customers') loadAll();
  if (n==='offers') loadOffers();
  if (n==='gdpr') loadDeletionRequests();
  if (n==='system') loadWorkerHealth();
}

async function loadDeletionRequests() {
  const list = document.getElementById('gdpr-list');
  list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray)">⏳ Φόρτωση...</div>';
  try {
    const db = DB(); if (!db) throw new Error('Δεν υπάρχει σύνδεση');
    const snap = await window._getDocs(window._query(
      window._col(db, 'ipear_customers'),
      window._where('deletionRequested', '==', true)
    ));
    if (snap.empty) {
      list.innerHTML = '<div style="text-align:center;padding:28px;color:#888;font-size:.92rem">✅ Δεν υπάρχουν εκκρεμή αιτήματα διαγραφής.</div>';
      _updateGdprBadge(0);
      return;
    }
    _updateGdprBadge(snap.size);
    let html = '<div style="display:grid;gap:10px">';
    snap.forEach(d => {
      const c = d.data();
      const reqDate = c.deletionRequestedAt ? new Date(c.deletionRequestedAt).toLocaleDateString('el-GR') + ' ' + new Date(c.deletionRequestedAt).toLocaleTimeString('el-GR',{hour:'2-digit',minute:'2-digit'}) : '—';
      html += `<div style="display:flex;align-items:center;gap:14px;padding:16px;background:#fff8f8;border:1.5px solid #ffcdd2;border-radius:14px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:.95rem;margin-bottom:2px">${escHtml(c.name || '—')}</div>
          <div style="font-size:.82rem;color:#888">${escHtml(c.email || '')} · ${escHtml(c.phone || '')} · ${escHtml(c.card || '')}</div>
          <div style="font-size:.78rem;color:#bbb;margin-top:2px">Αίτημα: ${reqDate}</div>
        </div>
        <button class="btn" style="background:#dc3545;color:#fff;border-color:#dc3545;font-size:.82rem;padding:10px 16px;white-space:nowrap"
          data-action="gdprDeleteCustomer" data-arg="${escJs(d.id)}" data-arg2="${escJs(c.name || '')}">🗑 Διαγραφή</button>
      </div>`;
    });
    html += '</div>';
    list.innerHTML = html;
  } catch(e) { list.innerHTML = '<div style="color:#c62828;padding:14px">❌ Σφάλμα: ' + escHtml(e.message) + '</div>'; }
}

async function gdprDeleteCustomer(docId, _name) {
  const prevCid = cid; const prevCdata = cdata;
  try {
    const db = DB();
    const doc = await window._getDoc(window._doc(db, 'ipear_customers', docId));
    if (!doc.exists()) { toast('⚠️ Ο πελάτης δεν βρέθηκε.', 'error'); loadDeletionRequests(); return; }
    cid = docId; cdata = doc.data();
    await deleteCust();
    loadDeletionRequests();
  } catch(e) {
    toast('❌ ' + e.message, 'error');
  }
  if (!cid) { cid = prevCid; cdata = prevCdata; }
}

function _updateGdprBadge(count) {
  const badge = document.getElementById('gdpr-badge');
  if (!badge) return;
  if (count > 0) { badge.style.display = ''; badge.textContent = count; }
  else { badge.style.display = 'none'; }
}

// ══════════════════════════════════════
//  TOAST  →  moved to ./admin/ui.js (toast, closeM)
// ══════════════════════════════════════
document.querySelectorAll('.modal-bg').forEach(b=>b.addEventListener('click',e=>{ if(e.target===b)closeM(); }));

// ══════════════════════════════════════
//  REGISTER
// ══════════════════════════════════════
async function register() {
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
      { name,phone,card,email, birthday, points:0,totalPoints:0, blocked:false, referralProcessed:false, referralCount:0, fcmToken:'', referredBy:refCode||'', registeredStoreId:_storeId||null, registeredStoreName:_storeName, createdAt:new Date().toISOString() });
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
              createdByAdmin: _adminActorUid || ''
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
              createdByAdmin: _adminActorUid || ''
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
//  SEARCH
// ══════════════════════════════════════
async function search() {
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

    if (found) { cid=foundId; cdata=found; renderCust(found); }
    else document.getElementById('no-res').style.display='block';
  } catch(e) { toast('❌ '+e.message,'error'); }
  document.getElementById('sspin').classList.remove('show');
}

async function renderCust(d) {
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
              storeId: _storeId || null, storeName: _storeName,
              date: nowIsoBd,
              createdByAdmin: _adminActorUid || ''
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
async function blockCust() {
  if (_blockCustBusy) return;
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
//  ADD POINTS
// ══════════════════════════════════════
function calcPts() {
  const amt=parseFloat(document.getElementById('ma-amt').value)||0;
  const mul=parseFloat(document.getElementById('ma-cat').value)||1;
  const pts=Math.round(amt*mul);
  const el=document.getElementById('pts-calc');
  el.textContent=pts;
  el.style.color = amt > 5000 ? '#ff3b30' : amt > 500 ? '#ff9500' : '';
}
function openAdd() {
  document.getElementById('ma-name').textContent=cdata?.name||'';
  document.getElementById('ma-amt').value='';
  document.getElementById('ma-note').value='';
  document.getElementById('pts-calc').textContent='0';
  document.getElementById('m-add').classList.add('show');
}
let _txnBusy = false;
const _TXN_COOLDOWN = 2000;
let _txnLastAt = 0;
async function confirmAdd() {
  if (_txnBusy) { toast('⏳ Επεξεργασία σε εξέλιξη...','error'); return; }
  if (Date.now() - _txnLastAt < _TXN_COOLDOWN) { toast('⏳ Περίμενε λίγο...','error'); return; }
  if (!authState.authenticated) { toast('⛔ Δεν έχεις συνδεθεί!','error'); return; }
  if (!navigator.onLine) { toast('🔴 Offline','error'); return; }
  _txnBusy = true; _txnLastAt = Date.now();
  const amt=parseFloat(document.getElementById('ma-amt').value);
  const mul=parseFloat(document.getElementById('ma-cat').value)||1;
  const cat=document.getElementById('ma-cat').options[document.getElementById('ma-cat').selectedIndex].text;
  const pts=Math.round(amt*mul);
  const note=document.getElementById('ma-note').value;
  if (!amt||amt<1) { toast('⚠️ Βάλε ποσό αγοράς','error'); _txnBusy = false; return; }
  if (!Number.isFinite(amt)) { toast('⚠️ Μη έγκυρο ποσό','error'); _txnBusy = false; return; }
  if (amt > 5000) { toast('⚠️ Μέγιστο ποσό αγοράς: 5.000€','error'); _txnBusy = false; return; }
  if (amt > 500 && !confirm(`⚠️ Ποσό ${amt.toLocaleString('el-GR')}€ — Σίγουρα;`)) { _txnBusy = false; return; }
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
        storeId: _storeId || null,
        storeName: _storeName,
        date: nowIso,
        createdByAdmin: _adminActorUid || ''
      });
    });
    cdata.points=newPts; cdata.totalPoints=newTot;
    renderCust(cdata); toast(`✅ +${pts} πόντοι για ${cdata.name}`,'success'); closeM();
    _publishLeaderboard(); // refresh leaderboard after points change
  } catch(e) { toast('❌ '+e.message,'error'); }
  finally { _txnBusy = false; if (addBtn) { addBtn.disabled=false; addBtn.textContent='✅ Καταχώρηση'; } }
}

// ══════════════════════════════════════
//  REDEEM
// ══════════════════════════════════════
function openRedeem() {
  document.getElementById('mr-name').textContent=cdata?.name||'';
  document.getElementById('mr-pts').textContent=cdata?.points||0;
  document.getElementById('m-redeem').classList.add('show');
}
async function confirmRedeem() {
  if (_txnBusy) { toast('⏳ Επεξεργασία σε εξέλιξη...','error'); return; }
  if (Date.now() - _txnLastAt < _TXN_COOLDOWN) { toast('⏳ Περίμενε λίγο...','error'); return; }
  if (!authState.authenticated) { toast('⛔ Δεν έχεις συνδεθεί!','error'); return; }
  if (!navigator.onLine) { toast('🔴 Offline','error'); return; }
  _txnBusy = true; _txnLastAt = Date.now();
  const cost = parseInt(document.getElementById('mr-sel').value);
  if (isNaN(cost) || cost <= 0) { toast('⚠️ Επίλεξε πακέτο εξαργύρωσης.','error'); _txnBusy = false; return; }
  if (!Number.isInteger(cost)) { toast('⚠️ Μη έγκυρο ποσό πόντων.','error'); _txnBusy = false; return; }
  const db = DB(), disc = (cost/250)*5;
  const redeemBtn = document.querySelector('#m-redeem .btn-green');
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
        approvedByUid: _adminActorUid || '',
        approvedAt: nowIso,
        customerId: cid,
        customerUid: custData.uid || cdata.uid || '',
        code: null,
        pointsDeducted: cost,
        storeId: _storeId || null,
        storeName: _storeName
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
        storeId: _storeId || null,
        storeName: _storeName,
        date: nowIso,
        approvedByAdmin: _adminActorUid || ''
      });
    });
    cdata.points=newPts; renderCust(cdata);
    toast(`💶 Εξαργύρωση ${disc}€! Αφαιρέθηκαν ${cost} πόντοι.`,'success'); closeM();
    _publishLeaderboard(); // refresh leaderboard after points change
  } catch(e) { toast('❌ '+e.message,'error'); }
  finally { _txnBusy = false; if (redeemBtn) { redeemBtn.disabled=false; redeemBtn.textContent='💶 Εξαργύρωση'; } }
}

// ══════════════════════════════════════
//  DELETE
// ══════════════════════════════════════
let _deleteCustBusy = false;
async function deleteCust() {
  if (_deleteCustBusy) return;
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
    const workerSec = _getWorkerSecret();
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
    cid=null; cdata=null;
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
//  COMMUNICATION
// ══════════════════════════════════════
function openViber() {
  if (!cdata?.phone) { toast('⚠️ Δεν υπάρχει τηλέφωνο!','error'); return; }
  document.getElementById('mv-name').textContent=cdata.name;
  document.getElementById('mv-phone').textContent=cdata.phone;
  document.getElementById('m-viber').classList.add('show');
}
function openSMS() {
  if (!cdata?.phone) { toast('⚠️ Δεν υπάρχει τηλέφωνο!','error'); return; }
  document.getElementById('ms-name').textContent=cdata.name;
  document.getElementById('ms-phone').textContent=cdata.phone;
  document.getElementById('m-sms').classList.add('show');
}
function openEmail() {
  if (!cdata?.email) { toast('⚠️ Δεν υπάρχει email!','error'); return; }
  document.getElementById('me-name').textContent=cdata.name;
  document.getElementById('me-addr').textContent=cdata.email;
  document.getElementById('m-email').classList.add('show');
}

function buildMsg(type, ch) {
  const fn=(cdata?.name||'Πελάτη').split(' ')[0];
  const pts=cdata.points||0, tot=cdata.totalPoints||pts;
  const t=tier(tot);
  const nl=ch==='viber'?'\n':' ';
  const msgs = {
    pts:  `Γεια σου ${fn}!${nl}Έχεις ${pts} διαθέσιμους πόντους στο iPear Loyalty.${nl}Κατάταξη: ${t.icon} ${t.name} (${tot} lifetime).${nl}iPear — ipear.gr 📱`,
    wel:  `Καλωσήρθες στο iPear Loyalty, ${fn}! 📱✨${nl}Ευχαριστούμε για την εγγραφή σου!${nl}1€ = 10 πόντοι. Συλλέγε & κέρδισε εκπτώσεις!`,
    pro:  `Γεια σου ${fn}! 🎁${nl}Ειδική προσφορά μόνο για εσένα στο iPear!${nl}Νέα προϊόντα & custom θήκες σε περιμένουν. 📱`,
  };
  return msgs[type]||'';
}

// ── Viber (two-step: template → compose → deep link + clipboard) ──
function sViber(t) {
  const body = t === 'cust' ? '' : buildMsg(t, 'viber');
  document.getElementById('mv-body').value = body;
  const ph = (cdata?.phone||'').replace(/[\s\-()]/g,'');
  document.getElementById('mv-phone2').textContent = ph.startsWith('+') ? ph : '+30' + ph;
  document.getElementById('mv-tpl').style.display = 'none';
  document.getElementById('mv-compose').style.display = '';
  document.getElementById('mv-cancel').style.display = 'none';
}
function mvBack() {
  document.getElementById('mv-tpl').style.display = '';
  document.getElementById('mv-compose').style.display = 'none';
  document.getElementById('mv-cancel').style.display = '';
}
function sendViberDeepLink() {
  const msg = document.getElementById('mv-body').value.trim();
  if (!msg) { toast('⚠️ Γράψε μήνυμα!', 'error'); return; }
  const ph = (cdata?.phone||'').replace(/[\s\-()]/g,'');
  const intlPh = ph.startsWith('+') ? ph : '+30' + ph;
  window.open(`viber://chat?number=${encodeURIComponent(intlPh)}`, '_blank');
  navigator.clipboard.writeText(msg)
    .then(()  => toast('📱 Άνοιξε Viber! Το μήνυμα αντιγράφηκε στο clipboard.', 'success'))
    .catch(()  => toast('📱 Άνοιξε Viber! Αντέγραψε το μήνυμα χειροκίνητα.', 'success'));
  closeM();
}

// ── SMS (two-step: template → compose → Brevo API via worker) ──
function sSMS(t) {
  const body = t === 'cust' ? '' : buildMsg(t, 'sms');
  document.getElementById('ms-body').value = body;
  document.getElementById('ms-chars').textContent = body.length + '/160';
  document.getElementById('ms-err').textContent = '';
  document.getElementById('ms-tpl').style.display = 'none';
  document.getElementById('ms-compose').style.display = '';
  document.getElementById('ms-cancel').style.display = 'none';
}
function msBack() {
  document.getElementById('ms-tpl').style.display = '';
  document.getElementById('ms-compose').style.display = 'none';
  document.getElementById('ms-cancel').style.display = '';
}
let _smsSendBusy = false;
async function sendSMSIndividual() {
  if (_smsSendBusy) return;
  const workerUrl = localStorage.getItem('ipear_worker_url');
  const workerSec = _getWorkerSecret();
  if (!workerUrl || !workerSec) { toast('⚠️ Ορίστε τον Worker URL στις Ειδοποιήσεις πρώτα!', 'error'); closeM(); return; }
  const message = document.getElementById('ms-body').value.trim();
  const err = document.getElementById('ms-err');
  if (!message) { err.textContent = '⚠️ Συμπλήρωσε μήνυμα'; return; }
  _smsSendBusy = true;
  const btn = document.getElementById('ms-send-btn');
  btn.disabled = true; btn.textContent = '⏳ Αποστολή...';
  err.textContent = '';
  try {
    const smsUrl = workerUrl.replace(/\/$/, '') + '/sms';
    const response = await fetch(smsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${workerSec}` },
      body: JSON.stringify({ phone: cdata.phone, message }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    toast(`✅ SMS εστάλη στον/στην ${cdata.name}!`, 'success');
    closeM();
  } catch(e) {
    err.textContent = '❌ ' + (e.message || 'Σφάλμα αποστολής');
  } finally {
    btn.disabled = false; btn.textContent = '📤 Αποστολή SMS';
    _smsSendBusy = false;
  }
}

// ── Email individual (two-step: template → compose → Brevo API via worker) ──
function sEmail(t) {
  const subj = { pts: 'Οι πόντοι σου — iPear', wel: 'Καλωσήρθες στο iPear Loyalty!', pro: 'Ειδική Προσφορά — iPear' };
  document.getElementById('me-subject').value = subj[t] || '';
  document.getElementById('me-body').value = t === 'cust' ? '' : buildMsg(t, 'email');
  document.getElementById('me-err').textContent = '';
  const btn = document.getElementById('me-send-btn');
  btn.disabled = false; btn.textContent = '📤 Αποστολή';
  document.getElementById('me-tpl').style.display = 'none';
  document.getElementById('me-compose').style.display = '';
  document.getElementById('me-cancel').style.display = 'none';
}
function meBack() {
  document.getElementById('me-tpl').style.display = '';
  document.getElementById('me-compose').style.display = 'none';
  document.getElementById('me-cancel').style.display = '';
}
let _sendEmailIndBusy = false;
async function sendEmailIndividual() {
  if (_sendEmailIndBusy) return;
  const workerUrl = localStorage.getItem('ipear_worker_url');
  const workerSec = _getWorkerSecret();
  if (!workerUrl || !workerSec) { toast('⚠️ Ορίστε τον Worker URL στις Ειδοποιήσεις πρώτα!', 'error'); closeM(); return; }
  const subject = document.getElementById('me-subject').value.trim();
  const message = document.getElementById('me-body').value.trim();
  const err = document.getElementById('me-err');
  if (!subject) { err.textContent = '⚠️ Συμπλήρωσε θέμα'; return; }
  if (!message) { err.textContent = '⚠️ Συμπλήρωσε μήνυμα'; return; }
  _sendEmailIndBusy = true;
  const btn = document.getElementById('me-send-btn');
  btn.disabled = true; btn.textContent = '⏳ Αποστολή...';
  err.textContent = '';
  try {
    const finalMessage = message
      .replace(/\{\{name\}\}/g, '{{params.name}}')
      .replace(/\{\{points\}\}/g, '{{params.points}}');
    const response = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${workerSec}` },
      body: JSON.stringify({
        recipients: [{ email: cdata.email, name: cdata.name, points: String(cdata.points||0) }],
        subject,
        message: finalMessage,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    toast(`✅ Email εστάλη στον/στην ${cdata.name}!`, 'success');
    closeM();
  } catch(e) {
    err.textContent = '❌ ' + (e.message || 'Σφάλμα αποστολής');
    btn.disabled = false; btn.textContent = '📤 Αποστολή';
  }
  finally { _sendEmailIndBusy = false; }
}
function sendCustom() {
  const msg=document.getElementById('cm-txt').value.trim();
  if (!msg) { toast('⚠️ Γράψε μήνυμα!','error'); return; }
  const ph=(cdata?.phone||'').replace(/[\s\-()]/g,'');
  if (msgCh==='viber')  window.open(`viber://forward?text=${encodeURIComponent(msg)}`,'_blank'), toast('📱 Viber!','success');
  if (msgCh==='sms')    window.open(`sms:${ph}?body=${encodeURIComponent(msg)}`,'_blank'), toast('📱 SMS!','success');
  if (msgCh==='email')  window.open(`mailto:${cdata?.email}?subject=iPear Loyalty&body=${encodeURIComponent(msg)}`,'_blank'), toast('✉️ Email!','success');
  document.getElementById('cm-txt').value=''; closeM();
}

// ══════════════════════════════════════
//  EMAIL WORKER  →  moved to ./admin/email-worker.js
// ══════════════════════════════════════

// ══════════════════════════════════════
//  BULK NOTIFICATIONS  →  moved to ./admin/bulk-notifications.js
// ══════════════════════════════════════

// ══════════════════════════════════════
//  ALL CUSTOMERS TABLE
// ══════════════════════════════════════
let _activeSegment = null;

let _allCustRows = []; // cached for client-side search filtering

async function loadAll() {
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

function _filterCustTable() {
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

// ══════════════════════════════════════
//  LEADERBOARD PUBLISH  →  moved to ./admin/leaderboard.js
// ══════════════════════════════════════

function clearSegmentFilter() {
  _activeSegment = null;
  const filterBar = document.getElementById('seg-filter-bar');
  if (filterBar) filterBar.style.display = 'none';
  loadAll();
}
async function quickSel(id) {
  try {
    const snap = await window._getDoc(window._doc(DB(),'ipear_customers',id));
    if (snap.exists()) { cid=id; cdata=snap.data(); showTab('search'); renderCust(cdata); }
  } catch(e) { toast('❌ '+e.message,'error'); }
}

// Process pending referral bonuses written by customer self-registration
const MAX_REFERRALS_PER_USER = 5; // Each user can refer max 5 people
async function processReferralQueue() {
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
        // Write ledger for the NEW customer + lock referralProcessed in one commit.
        // Deterministic id de-dupes vs the self-registration write that may have
        // already happened (set() with same id is a no-op overwrite — fine).
        const ncLedgerId = `referral_queue_out_${q.newCustomerId}`;
        await window._runTransaction(db, async (txn) => {
          const ncRef = window._doc(db, 'ipear_customers', q.newCustomerId);
          const ncSnapLive = await txn.get(ncRef);
          if (!ncSnapLive.exists()) throw new Error('New customer missing');
          txn.update(ncRef, { referralProcessed: true });
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

// ── Stats — extracted to ./admin/stats.js

// ══════════════════════════════════════
//  BIRTHDAY CLAIMS AUTO-PROCESSOR  →  moved to ./admin/birthday-claims.js
// ══════════════════════════════════════

// ══════════════════════════════════════
//  TRANSACTIONS
// ══════════════════════════════════════
let _historyBusy = false;
async function loadTx() {
  if (!authState.authenticated) return;
  if (!navigator.onLine) return;
  if (_historyBusy) { logger.log('[loadTx] ⏳ already loading, ignoring duplicate call'); return; }
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
      else if (t.type==='redeem')    { cls='redeem'; det=`💶 Έκπτωση ${t.discount||''}€`; }
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
//  OFFERS  →  moved to ./admin/offers.js
// ══════════════════════════════════════

// ══════════════════════════════════════
//  VERIFY REDEMPTION CODE  →  moved to ./admin/redemption-verify.js
// ══════════════════════════════════════

// ════════════════════════════════════════
//  OFFER APPROVALS  →  moved to ./admin/approvals.js
// ════════════════════════════════════════
// ════════════════════════════════════════
//  PUSH NOTIFICATIONS — Real-time listener  →  moved to ./admin/push-listener.js
// ════════════════════════════════════════

// confirmOfferVerify  →  moved to ./admin/redemption-verify.js

// ══════════════════════════════════════
//  BACKUP
// ══════════════════════════════════════
async function exportBk() {
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
async function importBk(ev) {
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
      loadStats(); loadTx(); loadAll();
    } catch(err){ toast('❌ '+err.message,'error'); }
    ev.target.value='';
  };
  reader.readAsText(file);
}

// ══════════════════════════════════════
//  ANALYTICS  →  moved to ./admin/analytics.js
// ══════════════════════════════════════

// ══════════════════════════════════════
//  CUSTOMER EDIT
// ══════════════════════════════════════
function openEdit() {
  if (!cdata) return;
  document.getElementById('edit-cid').value = cid;
  document.getElementById('ed-name').value  = cdata.name  || '';
  document.getElementById('ed-phone').value = cdata.phone || '';
  document.getElementById('ed-email').value = cdata.email || '';
  document.getElementById('ed-bday').value  = cdata.birthday || '';
  document.getElementById('m-edit').classList.add('show');
}
async function saveEdit() {
  if (!authState.authenticated) { toast('⛔ Δεν έχεις συνδεθεί!','error'); return; }
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
//  SEGMENTS
// ══════════════════════════════════════
function renderSegments(csnap, tsnap) {
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

function filterBySegment(key) {
  if (!window._segments || !window._segments[key]) return;
  _activeSegment = key;
  const count = window._segments[key].length;
  const label = _SEG_LABELS[key] || key;
  const filterBar = document.getElementById('seg-filter-bar');
  const filterLabel = document.getElementById('seg-filter-label');
  if (filterBar)  { filterBar.style.display = 'flex'; }
  if (filterLabel){ filterLabel.textContent = `🎯 Φίλτρο: ${label} — ${count} πελάτες`; }
  showTab('customers');
  loadAll();
}

// ══════════════════════════════════════
//  CSV EXPORT
// ══════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS (FCM)  →  moved to ./admin/push-fcm.js
// ══════════════════════════════════════════════════════════════════

// ── Bulk messaging (preview + send) — extracted to ./admin/bulk-messaging-send.js
// ── Maintenance (points expiry + tier downgrade) — extracted to ./admin/maintenance.js

// ══════════════════════════════════════
//  PART 2: GOD-MODE KPI OVERVIEW (Fast aggregation — P-1 fix)
// ══════════════════════════════════════
// P-1 fix: use server-side aggregation queries (getCountFromServer + sum())
// for the two KPIs that don't need per-doc iteration. These resolve in ~50ms
// regardless of collection size and cost a fraction of a full collection scan
// (one aggregation read vs. N document reads). loadStats() still runs in
// parallel for the rich tier/redemption/blocked breakdowns that genuinely
// need per-doc data.
let _kpiOverviewBusy = false;
async function loadKpiOverview() {
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

// ── System Health & Orphan Cleanup — extracted to ./admin/system-health.js

// ══════════════════════════════════════
//  PART 3: WORKER HEALTH CHECK  →  moved to ./admin/email-worker.js
// ══════════════════════════════════════

// ══════════════════════════════════════
//  PART 5: KILL SWITCH — extracted to ./admin/kill-switch.js

// exportCSV — extracted to ./admin/csv-export.js

// ═══════════════════════════════════════════════════════════════════════════
//  WINDOW EXPORTS — required for inline HTML event handlers (onclick, etc.)
// ═══════════════════════════════════════════════════════════════════════════
window.unlock = unlock;
window.adminLogout = adminLogout;
window.showTab = showTab;
window.loadWorkerHealth = loadWorkerHealth;
window.search = search;
window.quickSel = quickSel;
window.openAdd = openAdd;
window.confirmAdd = confirmAdd;
window.openRedeem = openRedeem;
window.confirmRedeem = confirmRedeem;
window.openEdit = openEdit;
window.saveEdit = saveEdit;
window.blockCust = blockCust;
window.deleteCust = deleteCust;
window.verifyCode = verifyCode;
window.confirmVerify = confirmVerify;
window.confirmOfferVerify = confirmOfferVerify;
window.register = register;
window.loadStats = loadStats;
window.loadAnalytics = loadAnalytics;
window.loadTx = loadTx;
window.openSMS = openSMS;
window.openEmail = openEmail;
window.openViber = openViber;
window.closeM = closeM;
window.meBack = meBack;
window.msBack = msBack;
window.mvBack = mvBack;
window.fillTpl = fillTpl;
window.fillEmailTpl = fillEmailTpl;
window.fillPushTpl = fillPushTpl;
window.fillSmsBulkTpl = fillSmsBulkTpl;
window.sendCustom = sendCustom;
window.sendSMSIndividual = sendSMSIndividual;
window.sendEmailIndividual = sendEmailIndividual;
window.sendViberDeepLink = sendViberDeepLink;
window.prepBulk = prepBulk;
window.sendSMSBulk = sendSMSBulk;
window.sendEmailBulk = sendEmailBulk;
window.previewSmsBulk = previewSmsBulk;
window.previewEmailBulk = previewEmailBulk;
window.sendPushNotification = sendPushNotification;
window.sEmail = sEmail;
window.sSMS = sSMS;
window.sViber = sViber;
window.selectEmailOne = selectEmailOne;
window.searchEmailOne = searchEmailOne;
window.toggleEmailTargetSearch = toggleEmailTargetSearch;
window.setAnPeriod = setAnPeriod;
window.renderAnalytics = renderAnalytics;
window.exportCSV = exportCSV;
window.exportBk = exportBk;
window.importBk = importBk;
window.openOfferModal = openOfferModal;
window.saveOffer = saveOffer;
window.deleteOffer = deleteOffer;
window.toggleOffer = toggleOffer;
window.openOfferEdit = openOfferEdit;
window.sendOfferPush = sendOfferPush;
window.previewOfferImage = previewOfferImage;
window.removeOfferImage = removeOfferImage;
window.approveOffer = approveOffer;
window.rejectOffer = rejectOffer;
window.openDrillDown = openDrillDown;
window.filterBySegment = filterBySegment;
window.clearSegmentFilter = clearSegmentFilter;
window.calcPts = calcPts;
window._filterCustTable = _filterCustTable;
window.toggleWorkerConfig = toggleWorkerConfig;
window.saveWorkerConfig = saveWorkerConfig;
window.testWorkerConnection = testWorkerConnection;
window.checkWorkerHealth = checkWorkerHealth;
window.toggleKillSwitch = toggleKillSwitch;
window.previewExpirePoints = previewExpirePoints;
window.executeExpirePoints = executeExpirePoints;
window.previewTierDowngrade = previewTierDowngrade;
window.executeTierDowngrade = executeTierDowngrade;
window._scanOrphans = scanOrphans;
window._deleteGhostCustomer = deleteGhostCustomer;
window._deleteOrphanTxs = deleteOrphanTxs;
window._deleteSecondaryOrphans = deleteSecondaryOrphans;
window._runSystemHealthCheck = runSystemHealthCheck;
window.loadDeletionRequests = loadDeletionRequests;
window.gdprDeleteCustomer = gdprDeleteCustomer;

// ═══════════════════════════════════════════════════════════════════════════
//  HIGH-2: Inline-handler delegation
//
//  Phase B/3a — installs a single click + keydown listener that dispatches to
//  the same window.* functions via [data-action] / [data-key-action] attrs.
//  Coexists with existing onclick="fn()" handlers (no breakage) so we can
//  retire them incrementally. Once every admin handler is data-action-driven,
//  Phase B/3b drops `script-src 'unsafe-inline'` from CSP for /admin*.
//
//  Conventions:
//    data-action="fnName"                  → window.fnName()
//    data-action="fnName" data-arg="x"     → window.fnName('x')
//    data-action="fnName" data-arg="x" data-arg2="y" data-arg3="z"
//                                           → window.fnName('x','y','z')
//    data-key-action="fnName"              → same, fired on Enter / Space
//
//  Helper: data-click-target="elementId" simulates a click on another element
//  (replaces inline onclick="document.getElementById('x').click()").
// ═══════════════════════════════════════════════════════════════════════════
// Auto-coerce data-arg strings to native types when they match. The original
// inline handlers (toggleOffer('id', true)) often passed booleans / numbers,
// which would otherwise reach the function as the strings "true"/"false"/"42".
function _coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (v !== '' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
function _resolveArgs(el) {
  const a = [];
  if (el.dataset.arg  !== undefined) a.push(_coerce(el.dataset.arg));
  if (el.dataset.arg2 !== undefined) a.push(_coerce(el.dataset.arg2));
  if (el.dataset.arg3 !== undefined) a.push(_coerce(el.dataset.arg3));
  return a;
}

function _dispatchAction(el, attr, originalEvent) {
  const name = el.dataset[attr];
  // data-click-target lever: trigger another element's click (replaces
  // onclick="document.getElementById('x').click()")
  if (!name && attr === 'action' && el.dataset.clickTarget) {
    const tgt = document.getElementById(el.dataset.clickTarget);
    if (tgt) tgt.click();
    return true;
  }
  if (!name) return false;
  const fn = window[name];
  if (typeof fn !== 'function') {
    logger.warn('[admin-delegate] no handler:', name);
    return false;
  }
  if (originalEvent && typeof originalEvent.preventDefault === 'function') {
    originalEvent.preventDefault();
  }
  try {
    fn(..._resolveArgs(el));
  } catch (e) {
    logger.error('[admin-delegate] handler error:', name, e);
  }
  return true;
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action], [data-click-target]');
  if (!el) return;
  _dispatchAction(el, 'action', e);
}, false);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest('[data-key-action]');
  if (!el) return;
  _dispatchAction(el, 'keyAction', e);
}, false);

// Helpers for the few callers that used non-mechanical inline expressions.
function _refreshStats() { loadStats(); loadAnalytics(); }
function _removeOfferImageEvt(_arg, ev) { removeOfferImage(ev); }
function _togglePasswordVisibility(btn) {
  const i = document.getElementById('lock-in');
  if (!i || !btn) return;
  const on = i.type === 'password';
  i.type = on ? 'text' : 'password';
  const p = btn.querySelector('path');
  const c = btn.querySelector('circle');
  if (p && c) {
    p.setAttribute('d', on
      ? 'M2 12s4-7 10-7c2 0 4 .6 5.6 1.5M22 12s-4 7-10 7c-2 0-4-.6-5.6-1.5M2 2l20 20'
      : 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z');
    c.style.display = on ? 'none' : '';
  }
}
function _focusElement(id) {
  const el = document.getElementById(id);
  if (el) el.focus();
}
window._refreshStats = _refreshStats;
window._removeOfferImageEvt = _removeOfferImageEvt;
window._togglePasswordVisibility = _togglePasswordVisibility;
window._focusElement = _focusElement;

// The removeOfferImage(event) case needs the click event itself. Patch the
// delegator so [data-action="_removeOfferImageEvt"] receives the originalEvent.
// (Generic mechanism so other handlers can opt in via data-pass-event="1".)
function _dispatchActionWithEvent(el, fn, originalEvent) {
  const args = _resolveArgs(el);
  if (el.dataset.passEvent === '1') args.push(originalEvent);
  try { fn(...args); } catch (e) { logger.error('[admin-delegate] handler error', e); }
}
// One more click listener layer — the existing dispatcher above runs first
// and is sufficient for the 99% case; this only fires when data-pass-event is set.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-pass-event="1"]');
  if (!el) return;
  const fn = window[el.dataset.action];
  if (typeof fn !== 'function') return;
  // Prevent double-firing by the upstream dispatcher (which would not pass
  // the event). We stop propagation here so only this listener runs.
  e.preventDefault();
  e.stopImmediatePropagation();
  _dispatchActionWithEvent(el, fn, e);
}, true); // capture phase so we run before the basic dispatcher

// _togglePasswordVisibility needs the clicked button. Pattern via data-pass-self.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action="_togglePasswordVisibility"][data-pass-self="1"]');
  if (!el) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  _togglePasswordVisibility(el);
}, true);
