import './styles/admin.css';
import { logger } from './logger.js';
// ═══════════════════════════════════════════════════════════════════════════
//  iPear Loyalty — Admin Panel (ES Module Entry Point)
//  Shared core: firebase-init.js (Firebase refs), utils.js (tier)
// ═══════════════════════════════════════════════════════════════════════════
import './firebase-init.js';
import {
  setAnPeriod,
  loadAnalytics,
  renderAnalytics,
  openDrillDown,
} from './admin/analytics.js';
import { toast, closeM } from './admin/ui.js';
import { initAdminAuth, unlock, adminLogout } from './admin/admin-auth.js';
import { initGdpr, loadDeletionRequests, gdprDeleteCustomer } from './admin/gdpr.js';
import {
  initCustomerPoints,
  calcPts, openAdd, confirmAdd, openRedeem, confirmRedeem,
} from './admin/customer-points.js';
import {
  initMessaging,
  openViber, openSMS, openEmail,
  sViber, mvBack, sendViberDeepLink,
  sSMS, msBack, sendSMSIndividual,
  sEmail, meBack, sendEmailIndividual,
  sendCustom,
} from './admin/messaging.js';
import {
  initDashboardOps,
  processReferralQueue, loadTx, exportBk, importBk, loadKpiOverview,
} from './admin/dashboard-ops.js';
import {
  initCustomersCrud,
  register, search, renderCust, blockCust, deleteCust,
  openEdit, saveEdit, loadAll, _filterCustTable,
  clearSegmentFilter, quickSel, renderSegments, filterBySegment,
  updateCachedCustomerRow, resetCustomersScope,
} from './admin/customers-crud.js';
import {
  getWorkerSecret as _getWorkerSecret,
  setWorkerSecret as _setWorkerSecret,
} from './admin/worker-secret.js';
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
  loadRewards,
  openRewardModal,
  openRewardEdit,
  saveReward,
  toggleReward,
  deleteReward,
  previewRewardImage,
  removeRewardImage,
} from './admin/rewards-admin.js';
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
import { loadStats, configureStats } from './admin/stats.js';
import {
  previewSmsBulk,
  previewEmailBulk,
  fillSmsBulkTpl,
  sendSMSBulk,
} from './admin/bulk-messaging-send.js';

// Wire push-listener: keep the customers-crud table cache in sync.
initPushListener({
  onCustomerChange: (id, data) => updateCachedCustomerRow(id, data),
});

// Wire approvals + redemption-verify modules. Store context resolved from
// authState directly — admin-auth.js mirrors storeId/storeName there on
// login, so we don't need to keep a local copy in admin-main anymore.
initApprovals({
  getStoreContext: () => ({ storeId: authState.storeId, storeName: authState.storeName }),
  refreshAdminViews: () => { loadTx(); loadStats(); },
});

initRedemptionVerify({
  getStoreContext: () => ({ storeId: authState.storeId, storeName: authState.storeName }),
  onRedemptionApproved: ({ customerId, newPoints }) => {
    if (cid === customerId && cdata) {
      cdata.points = newPoints;
      renderCust(cdata);
    }
  },
  refreshAdminViews: () => { loadTx(); loadStats(); },
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
//  LOCK / AUTH — moved to ./admin/admin-auth.js
// ══════════════════════════════════════
// Cross-domain wiring: admin-auth.js owns the lock screen, session restore,
// keep-alive timers, and online/offline indicator. Domain-specific work
// (data loading, listener teardown, store-id mirror sync) is injected here
// via hooks so admin-auth.js stays free of cross-module imports.
initAdminAuth({
  onLoginComplete: () => {
    configureSystemHealth({ onDataChanged: loadStats });
    configureStats({ onSnapshot: renderSegments });
    loadStats(); loadTx(); loadAll(); loadOffers(); startApprovalListener(); _startPushListener();
    processReferralQueue(); loadKpiOverview(); startMaintenanceListener(); checkWorkerHealth();
    loadDeletionRequests();
  },
  onLogout: () => {
    // Stop real-time listeners (prevent leak + stale re-login)
    stopApprovalListener();
    stopPushListener();
    stopMaintenanceListener();
    // Wipe admin-main's per-customer scope + the cached segment table
    cid = null; cdata = null; msgCh = '';
    resetCustomersScope();
    // authState.storeId/Name + actorUid + authenticated are already cleared
    // by admin-auth.js's adminLogout() before this hook fires.
    // Return to search tab (safe default)
    showTab('search');
  },
  keepAliveRefresh: () => {
    loadStats(); loadTx(); loadOffers(); startApprovalListener(); _startPushListener();
    loadKpiOverview(); checkWorkerHealth();
  },
});

// ══════════════════════════════════════
//  XSS GUARD (escHtml + escJs imported from utils.js)
// ══════════════════════════════════════

// ══════════════════════════════════════
//  STATE — admin-main as the live customer-scope owner
// ══════════════════════════════════════
// cid + cdata: selected customer for the search/edit/block/delete/messaging/
//   customer-points/gdpr modules. Read via getScope hooks across modules.
// msgCh: currently-active messaging channel ('viber' | 'sms' | 'email'),
//   consumed by messaging.js#sendCustom.
// Store context (storeId / storeName) lives in authState — all modules read
// it from there directly. admin-auth.js mirrors it on login.
let cid = null, cdata = null, msgCh = '';
const TABS = ['search','register','customers','transactions','approvals','offers','rewards','marketing','stats','system','gdpr'];

// ── Online indicator + keep-alive moved to ./admin/admin-auth.js ──

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
  if (n==='rewards') loadRewards();
  if (n==='gdpr') loadDeletionRequests();
  if (n==='system') loadWorkerHealth();
}

// loadDeletionRequests / gdprDeleteCustomer / _updateGdprBadge moved to
// ./admin/gdpr.js. cid/cdata + deleteCust still live here, so the gdpr
// module borrows them via hooks (see initGdpr call near the auth setup).
initGdpr({
  getCidCdata: () => ({ cid, cdata }),
  setCidCdata: ({ cid: newCid, cdata: newCdata }) => { cid = newCid; cdata = newCdata; },
  deleteCust: () => deleteCust(),
});

// Customer point credit/debit lives in ./admin/customer-points.js. Inject the
// live customer scope + the renderer so the module doesn't have to know about
// admin-main's local state. Store context is read from authState directly.
initCustomerPoints({
  getScope: () => ({ cid, cdata }),
  renderCust: (data) => renderCust(data),
});

// Per-customer messaging (Viber/SMS/Email) lives in ./admin/messaging.js.
// Inject the live customer + channel state, and the worker secret getter so
// the module doesn't have to import worker-secret.js itself.
initMessaging({
  getScope: () => ({ cdata, msgCh }),
  getWorkerSecret: () => _getWorkerSecret(),
});

// Dashboard ops (KPI / recent-tx / backup / referral queue) live in
// ./admin/dashboard-ops.js. importBk's customer-table refresh goes through
// the reloadAfterImport hook so dashboard-ops doesn't need to know about
// admin-main's loadAll() (which moves to customers-crud.js in commit 6).
initDashboardOps({
  reloadAfterImport: () => loadAll(),
});

// Customer CRUD owns the largest domain — search/render/edit/block/delete/
// list/segments. Scope (cid/cdata), tab navigation, and worker secret get
// injected so the module stays free of admin-main internals.
initCustomersCrud({
  getScope: () => ({ cid, cdata }),
  setScope: ({ cid: newCid, cdata: newCdata }) => { cid = newCid; cdata = newCdata; },
  showTab: (n) => showTab(n),
  getWorkerSecret: () => _getWorkerSecret(),
});

// Modal click-outside dismissal — every .modal-bg closes on background click.
document.querySelectorAll('.modal-bg').forEach(b=>b.addEventListener('click',e=>{ if(e.target===b)closeM(); }));

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
window.openRewardModal = openRewardModal;
window.openRewardEdit = openRewardEdit;
window.saveReward = saveReward;
window.toggleReward = toggleReward;
window.deleteReward = deleteReward;
window.sendOfferPush = sendOfferPush;
window.previewOfferImage = previewOfferImage;
window.removeOfferImage = removeOfferImage;
window.previewRewardImage = previewRewardImage;
window.removeRewardImage = removeRewardImage;
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
function _removeRewardImageEvt(_arg, ev) { removeRewardImage(ev); }
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
window._removeRewardImageEvt = _removeRewardImageEvt;
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
