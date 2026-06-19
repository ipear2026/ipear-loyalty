import { logger } from './logger.js';
// ═══════════════════════════════════════════════════════════════════════════
//  iPear Loyalty — Tablet / Store POS (ES Module Entry Point)
//  Shared core: firebase-init.js (Firebase refs), utils.js (tier, _parseExpiryMs, focus trap)
// ═══════════════════════════════════════════════════════════════════════════
import './firebase-init.js';
import { tier, _parseExpiryMs, _trapFocus, _releaseFocus, escHtml, tierFloor } from './utils.js';

const TABLET_BUILD_TAG = 'tablet-20260611-a11y2';
window.TABLET_BUILD_TAG = TABLET_BUILD_TAG;
logger.log('tablet.html loaded', TABLET_BUILD_TAG);

// ── Tablet auth wrappers (production — using Firebase refs from firebase-init.js) ──
if (!window.DEMO) {
  window._tabletSignIn = async (email, pass) => {
    const cred = await window._signIn(window._auth, email, pass);
    return cred.user;
  };
  window._tabletSignOut = window._signOut;
}

// ── Tablet demo mode overrides ──
if (window.DEMO) {
  const _DC = [
    {id:'dc1',name:'Νότης Μπουντούρης',phone:'6912345678',card:'IP-00001',points:750,totalPoints:1850,createdAt:new Date(Date.now()-90*864e5).toISOString()},
    {id:'dc2',name:'Μαρία Κωνσταντίνου',phone:'6923456789',card:'IP-00002',points:2200,totalPoints:3800,createdAt:new Date(Date.now()-180*864e5).toISOString()},
    {id:'dc3',name:'Νίκος Αντωνίου',phone:'6934567890',card:'IP-00003',points:4500,totalPoints:7200,createdAt:new Date(Date.now()-365*864e5).toISOString()},
  ];
  const snap=a=>({empty:!a.length,size:a.length,forEach:cb=>a.forEach(d=>cb({id:d.id,data:()=>({...d})}))});
  window._db={};
  window._col=(db,n)=>({_n:n});
  window._getDocs=async(ref)=>{
    const n=ref._n||(ref._ref&&ref._ref._n);
    const args=ref._args||[];
    let data=n==='ipear_customers'?[..._DC]:n==='ipear_redemptions'?JSON.parse(localStorage.getItem('_ipear_codes')||'[]'):[];
    for(const a of args){
      if(a._t==='w'&&a.op==='==') data=data.filter(d=>String(d[a.f])===String(a.v));
    }
    return snap(data);
  };
  window._query=(ref,...a)=>({_ref:ref,_args:a});
  window._where=(f,op,v)=>({_t:'w',f,op,v});
  window._addDoc=async(_ref,_data)=>{const id='d'+Date.now();return{id};};
  window._updateDoc=async(ref,data)=>{if(!ref||!ref._col)return;const arr=ref._col==='ipear_customers'?_DC:ref._col==='ipear_redemptions'?JSON.parse(localStorage.getItem('_ipear_codes')||'[]'):[];const i=arr.findIndex(d=>d.id===ref._id);if(i>=0){Object.assign(arr[i],data);if(ref._col==='ipear_redemptions')localStorage.setItem('_ipear_codes',JSON.stringify(arr));}};
  window._doc=(db,col,id)=>({_col:col,_id:id});
  window._tabletSignIn = async(email,pass)=>{
    if(email==='tablet@ipear.gr'&&pass==='tablet1234') return {uid:'demo-tablet'};
    throw{code:'auth/wrong-password'};
  };
  window._tabletSignOut = async()=>{};
  const _DEMO_STORES  = { 'store-demo': { name: 'iPear Demo', city: 'Demo' } };
  const _DEMO_ADMINS  = { 'demo-tablet': { storeid: 'store-demo' } };
  window._getDoc = async(ref)=>{
    if(!ref||!ref._col)return{exists:()=>false,data:()=>({})};
    if(ref._col==='ipear_admins'){ const d=_DEMO_ADMINS[ref._id]; return {exists:()=>!!d,data:()=>d?{...d}:undefined,id:ref._id}; }
    if(ref._col==='ipear_stores'){ const d=_DEMO_STORES[ref._id]; return {exists:()=>!!d,data:()=>d?{...d}:undefined,id:ref._id}; }
    const arr=ref._col==='ipear_customers'?_DC:JSON.parse(localStorage.getItem('_ipear_codes')||'[]');
    const item=arr.find(d=>d.id===ref._id);
    return item?{exists:()=>true,data:()=>({...item}),id:item.id}:{exists:()=>false};
  };
  window._runTransaction = async (db, fn) => {
    const writes = [];
    const txn = {
      get: (ref) => window._getDoc(ref),
      update: (ref, data) => { writes.push(() => window._updateDoc(ref, data)); },
      set:    (ref, data) => { writes.push(() => window._setDoc  (ref, data)); },
    };
    const result = await fn(txn);
    for (const w of writes) await w();
    return result;
  };
  window._onSnapshot = (_ref, _cb) => { return ()=>{}; };
}

// ═══════════════════════════════════════════════════════════════════════════
//  TABLET APPLICATION CODE
// ═══════════════════════════════════════════════════════════════════════════
// ── Audio Feedback ──
const _sndSuccess = new Audio('snd-success.mp3');
const _sndError   = new Audio('snd-error.mp3');
_sndSuccess.volume = 0.5; _sndSuccess.preload = 'auto';
_sndError.volume   = 0.5; _sndError.preload   = 'auto';
let _sndUnlocked = false;
function _unlockSndOnGesture() {
  if (_sndUnlocked) return;
  _sndUnlocked = true;
  _sndSuccess.muted = true; _sndError.muted = true;
  const p1 = _sndSuccess.play().catch(()=>{});
  const p2 = _sndError.play().catch(()=>{});
  Promise.all([p1, p2]).then(() => {
    _sndSuccess.pause(); _sndSuccess.currentTime = 0; _sndSuccess.muted = false;
    _sndError.pause();   _sndError.currentTime = 0;   _sndError.muted = false;
  }).catch(()=>{ _sndSuccess.muted = false; _sndError.muted = false; });
  document.removeEventListener('touchstart', _unlockSndOnGesture);
  document.removeEventListener('click', _unlockSndOnGesture);
}
document.addEventListener('touchstart', _unlockSndOnGesture, { passive: true });
document.addEventListener('click', _unlockSndOnGesture);

function _playSuccess() {
  try { _sndSuccess.currentTime = 0; _sndSuccess.play().catch(()=>{}); } catch(_) {}
}
function _playError() {
  try { _sndError.currentTime = 0; _sndError.play().catch(()=>{}); } catch(_) {}
}

// ══════════════════════════════════════
//  TABLET LOGIN
// ══════════════════════════════════════
// firebase-init.js already executed (imported above) — run directly
if (window.DEMO) document.getElementById('tl-demo').style.display = 'block';
let _maintenanceMode = false;
let _maintenanceUnsub = null;
_startMaintenanceListener();

// ── Brute-force protection ─────────────────────────────────────────────────
let _tlAttempts = 0, _tlLockedUntil = 0;
const _TL_MAX = 5, _TL_LOCK = 60; // 5 tries → 60 s lockout
let _tabletStoreId = null, _tabletStoreName = '—';
let _tabletActorUid = null;
let _tabletActorEmail = null;
let _redeemSessionId = sessionStorage.getItem('ipear_redeem_session_id') || '';
if (!_redeemSessionId) {
  const rnd = new Uint32Array(1); crypto.getRandomValues(rnd);
  _redeemSessionId = 'tab-' + Date.now() + '-' + rnd[0].toString(16);
  sessionStorage.setItem('ipear_redeem_session_id', _redeemSessionId);
}

async function _workerRedeemGuard(action, extra = {}) {
  const workerUrl = (localStorage.getItem('ipear_worker_url') || '').replace(/\/$/, '');
  const workerSec = sessionStorage.getItem('ipear_worker_secret') || '';
  if (!workerUrl || !workerSec) return { ok: true, skipped: true };
  const res = await fetch(workerUrl + '/admin/redeem-attempt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + workerSec
    },
    body: JSON.stringify({
      source: 'tablet',
      action,
      sessionId: _redeemSessionId,
      actorUid: _tabletActorUid || '',
      ...extra
    })
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) {
    throw new Error(data?.error || 'Πάρα πολλές αποτυχημένες προσπάθειες. Περίμενε 1 λεπτό.');
  }
  if (!res.ok) {
    throw new Error(data?.error || 'Worker guard error');
  }
  return data;
}

// Shared post-auth bootstrap. Used by manual tabletLogin() AND by silent
// _tryTabletAutoRestore() when Firebase Auth carries a live session forward.
async function _completeTabletAuth(user) {
  _tabletActorUid = user?.uid || null;
  _tabletActorEmail = user?.email || null;
  _tabletStoreId = null; _tabletStoreName = '—';

  const adminSnap = await window._getDoc(window._doc(window._db, 'ipear_admins', user.uid));
  if (!adminSnap.exists()) throw new Error('not-admin');
  _tabletStoreId = adminSnap.data()?.storeid || null;
  if (_tabletStoreId) {
    try {
      const storeSnap = await window._getDoc(window._doc(window._db, 'ipear_stores', _tabletStoreId));
      if (storeSnap.exists()) _tabletStoreName = storeSnap.data().name || '—';
    } catch(_) {}
  }

  document.getElementById('tablet-login').style.display = 'none';
  const passEl = document.getElementById('tl-pass'); if (passEl) passEl.value = '';
  _startMaintenanceListener();
  _startPendingOfferListener();
}

// Silent auto-restore: skip the tablet-login screen if Firebase Auth has a
// live session in this tab. Falls back to the login screen on any error.
let _tabletAutoRestoreAttempted = false;
async function _tryTabletAutoRestore() {
  if (_tabletAutoRestoreAttempted) return;
  _tabletAutoRestoreAttempted = true;
  const user = window._auth?.currentUser;
  if (!user) return;
  logger.log('%c[TABLET] 🔓 auto-restoring from Firebase session: ' + user.email, 'color:#00cc00;font-weight:bold;font-size:14px');
  try { await _completeTabletAuth(user); }
  catch(e) { logger.warn('[TABLET] auto-restore failed:', e.message); /* login screen stays visible */ }
}

if (window._firebaseReady) _tryTabletAutoRestore();
else window.addEventListener('firebase-ready', _tryTabletAutoRestore);

async function tabletLogin() {
  const err = document.getElementById('tl-err');
  const btn = document.getElementById('tl-btn');

  if (Date.now() < _tlLockedUntil) {
    const sec = Math.ceil((_tlLockedUntil - Date.now()) / 1000);
    err.textContent = `🔒 Κλείδωμα — περίμενε ${sec} δευτερόλεπτα.`;
    return;
  }

  const email = document.getElementById('tl-email').value.trim().toLowerCase();
  const pass  = document.getElementById('tl-pass').value;
  err.textContent = '';
  if (!email || !pass) { err.textContent = '⚠️ Συμπληρώστε email και κωδικό.'; return; }

  btn.disabled = true; btn.textContent = '⏳ Σύνδεση...';
  try {
    const user = await window._tabletSignIn(email, pass);
    _tlAttempts = 0;
    await _completeTabletAuth(user);
  } catch(e) {
    if (e.message === 'not-admin') {
      err.textContent = '❌ Αυτός ο λογαριασμός δεν είναι tablet admin. Βεβαιώσου ότι το uid είναι στο ipear_admins.';
      btn.disabled = false; btn.textContent = 'Είσοδος →';
      return;
    }
    _tlAttempts++;
    if (_tlAttempts >= _TL_MAX) {
      _tlLockedUntil = Date.now() + _TL_LOCK * 1000;
      _tlAttempts    = 0;
      err.textContent = `🔒 Κλείδωμα ${_TL_LOCK} δευτερολέπτων μετά από πολλές αποτυχίες.`;
    } else {
      const msgs = {
        'auth/wrong-password':     '❌ Λάθος κωδικός.',
        'auth/user-not-found':     '❌ Δεν βρέθηκε λογαριασμός.',
        'auth/invalid-credential': '❌ Λάθος email ή κωδικός.',
        'auth/too-many-requests':  '⚠️ Πάρα πολλές προσπάθειες.',
      };
      const left = _TL_MAX - _tlAttempts;
      const base = msgs[e.code] || ('❌ ' + (e.message || e.code));
      err.textContent = base + (left < _TL_MAX ? `  (${left} απόπειρ${left === 1 ? 'α' : 'ες'} ακόμα)` : '');
    }
  }
  btn.disabled = false; btn.textContent = 'Είσοδος →';
}

// ══════════════════════════════════════
//  QR SCANNER
// ══════════════════════════════════════
let _qrStream = null;
let _qrAnimFrame = null;
let _qrScanning = false;

async function openQRScanner() {
  const overlay = document.getElementById('qr-overlay');
  const video   = document.getElementById('qr-video');

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia-not-supported');
    }
    _qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = _qrStream;
    await video.play();
    overlay.classList.add('show');
    if (typeof _trapFocus === 'function') _trapFocus(overlay);
    _qrScanning = true;
    requestAnimationFrame(_qrScanLoop);
  } catch(e) {
    logger.error('QR camera failed', e);
    let toastMessage = `⚠️ Κάμερα μη διαθέσιμη: ${e && (e.name || e.message || 'unknown error')}. Χρησιμοποιήστε τη χειροκίνητη αναζήτηση.`;
    if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) {
      toastMessage = '⚠️ Πρόσβαση κάμερας αρνήθηκε. Ενεργοποίησε την κάμερα στις ρυθμίσεις του browser για αυτή τη σελίδα και φόρτωσε ξανά, ή χρησιμοποίησε τη χειροκίνητη αναζήτηση.';
    } else if (e && e.name === 'NotFoundError') {
      toastMessage = '⚠️ Δεν βρέθηκε κάμερα στη συσκευή. Χρησιμοποίησε τη χειροκίνητη αναζήτηση.';
    } else if (e && e.name === 'NotSupportedError') {
      toastMessage = '⚠️ Ο browser δεν υποστηρίζει ζωντανή πρόσβαση κάμερας εδώ. Χρησιμοποίησε τη χειροκίνητη αναζήτηση.';
    }
    _showToast(toastMessage);
    const card = document.getElementById('card-input');
    const sinput = document.getElementById('sinput');
    if (card) card.focus();
    else if (sinput) sinput.focus();
  }
}

function _qrScanLoop() {
  if (!_qrScanning) return;
  const video  = document.getElementById('qr-video');
  const canvas = document.getElementById('qr-canvas');
  if (video.readyState !== video.HAVE_ENOUGH_DATA) {
    _qrAnimFrame = requestAnimationFrame(_qrScanLoop); return;
  }
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = window.jsQR && jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
  if (code && code.data) {
    _onQRFound(code.data);
  } else {
    _qrAnimFrame = requestAnimationFrame(_qrScanLoop);
  }
}

function _onQRFound(text) {
  _qrScanning = false;
  // Flash effect (visual only — runs in parallel with the actual work)
  const frame = document.querySelector('.qr-frame');
  const flash = document.createElement('div');
  flash.className = 'qr-found-flash';
  frame.appendChild(flash);
  setTimeout(() => flash.remove(), 500);

  // Start processing IMMEDIATELY — the flash continues in parallel
  closeQRScanner();
  const t = text.trim();
  if (t.startsWith('IPEAR-REDEEM:')) {
    const code = t.replace('IPEAR-REDEEM:', '').trim();
    _showQRRedeemLoading('Έλεγχος κωδικού…');
    handleRedeemQR(code);
  } else if (t.startsWith('IPEAR-OFFER:')) {
    const code = t.replace('IPEAR-OFFER:', '').trim();
    _showQRRedeemLoading('Έλεγχος προσφοράς…');
    handleOfferQR(code);
  } else {
    document.getElementById('sinput').value = t;
    doSearch();
  }
}

// Instant loading overlay so the cashier sees feedback immediately
function _showQRRedeemLoading(title) {
  const overlay  = document.getElementById('qr-redeem-confirm');
  const errBox   = document.getElementById('qrc-error');
  const confirmBtn = document.getElementById('qrc-confirm-btn');
  document.getElementById('qrc-title').textContent    = title || 'Έλεγχος κωδικού…';
  document.getElementById('qrc-customer').textContent = '⏳ Αναμονή…';
  document.getElementById('qrc-reward').textContent   = '';
  document.getElementById('qrc-pts').textContent      = '';
  if (errBox) { errBox.textContent = ''; errBox.style.display = 'none'; }
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.style.opacity = '.4'; confirmBtn.textContent = '⏳ Επεξεργασία…'; }
  overlay.style.display = 'flex';
  if (typeof _trapFocus === 'function') _trapFocus(overlay);
}

function closeQRScanner() {
  _qrScanning = false;
  cancelAnimationFrame(_qrAnimFrame);
  if (_qrStream) { _qrStream.getTracks().forEach(t => t.stop()); _qrStream = null; }
  document.getElementById('qr-video').srcObject = null;
  document.getElementById('qr-overlay').classList.remove('show');
  if (typeof _releaseFocus === 'function') _releaseFocus();
}

function switchToManualSearch() {
  closeQRScanner();
  const card = document.getElementById('card-input');
  const sinput = document.getElementById('sinput');
  setTimeout(() => {
    if (card && card.offsetParent !== null) card.focus();
    else if (sinput) sinput.focus();
  }, 120);
}

// ══════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════
// ══════════════════════════════════════
//  ONLINE STATUS
// ══════════════════════════════════════
function setOnline(on) {
  document.getElementById('cdot').className = 'conn-dot '+(on?'ok':'err');
  document.getElementById('ctxt').textContent = on?'Online':'Offline';
}
window.addEventListener('online',  ()=>{ setOnline(true); _tabletKeepAlive(); });
window.addEventListener('offline', ()=>setOnline(false));
setOnline(navigator.onLine);

// ── KEEPALIVE: recover from sleep/lock/background ──────────────────────
// Tablet stays open all day — must survive iOS/Android sleep cycles.
let _tabletLastPing = 0;

function _tabletKeepAlive() {
  if (!_tabletActorUid || !navigator.onLine) return;
  const now = Date.now();
  if (now - _tabletLastPing < 15000) return; // debounce 15s
  _tabletLastPing = now;
  setOnline(true);
  // keepalive tick
}

// Periodic ping every 3 min — keeps Firestore WebSocket alive
setInterval(() => { if (_tabletActorUid) _tabletKeepAlive(); }, 3 * 60 * 1000);

// Recover from lock/sleep/tab-switch
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && _tabletActorUid) {
    setTimeout(_tabletKeepAlive, 300);
    if (Date.now() - _tabletLastPing > 30 * 60 * 1000) {
      logger.log('[keepalive] tablet was asleep >30min, reloading...');
      location.reload();
      return;
    }
    document.body.classList.remove('page-hidden');
    _startMaintenanceListener();
    _startPendingOfferListener();
  } else if (document.visibilityState === 'hidden') {
    document.body.classList.add('page-hidden');
    if (_tabletActorUid) {
      _stopPendingOfferListener();
      if (_maintenanceUnsub) { try { _maintenanceUnsub(); } catch(_) {} _maintenanceUnsub = null; }
    }
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && _tabletActorUid) {
    // bfcache restore — Firestore listeners are dead, must reload
    logger.log('[keepalive] bfcache restore, reloading...');
    location.reload();
  }
});
window.addEventListener('focus', () => {
  if (_tabletActorUid) setTimeout(_tabletKeepAlive, 200);
});

// ══════════════════════════════════════
//  SEARCH
// ══════════════════════════════════════
async function searchByCard() {
  const raw = document.getElementById('card-input').value.trim().toUpperCase();
  if (!raw) return;
  // Support both "IP-12345" and just "12345"
  const card = raw.startsWith('IP-') ? raw : 'IP-' + raw;
  // Reuse sinput + doSearch by setting the value
  document.getElementById('sinput').value = card;
  await doSearch();
  document.getElementById('card-input').value = '';
}

async function doSearch() {
  const q = document.getElementById('sinput').value.trim();
  if (!q) return;

  // Intercept coded inputs (6 digits, IPEAR-OFFER:, IPEAR-REDEEM:)
  const stripped = q.replace(/\s/g, '');
  if (q.startsWith('IPEAR-OFFER:')) {
    handleOfferQR(q.replace('IPEAR-OFFER:', '').trim());
    return;
  }
  if (q.startsWith('IPEAR-REDEEM:')) {
    handleRedeemQR(q.replace('IPEAR-REDEEM:', '').trim());
    return;
  }
  // 6-digit code → try offer first, then reward
  if (/^\d{6}$/.test(stripped)) {
    try {
      const ofSnap = await window._getDocs(window._query(
        window._col(window._db, 'ipear_offer_redemptions'),
        window._where('code', '==', stripped)
      ));
      if (!ofSnap.empty) { handleOfferQR(stripped); return; }
    } catch(_) {}
    // Not an offer → try reward
    handleRedeemQR(stripped);
    return;
  }

  const qLower = q.toLowerCase();
  const btn = document.getElementById('sbtn');
  btn.innerHTML = '<div class="spin"></div>';
  btn.disabled = true;

  document.getElementById('cust-display').style.display = 'block';
  document.getElementById('not-found').style.display    = 'none';

  try {
    const db   = window._db;
    let found = null;

    // Try exact-match queries first (card, phone) to avoid full-collection scan
    const cardMatch = qLower.match(/^ip-?(.+)$/i);
    const searchFields = [
      cardMatch ? { field: 'card', value: 'IP-' + cardMatch[1].toUpperCase() } : null,
      /^\d{7,}$/.test(q) ? { field: 'phone', value: q } : null,
    ].filter(Boolean);

    for (const sf of searchFields) {
      const snap = await window._getDocs(
        window._query(window._col(db, 'ipear_customers'), window._where(sf.field, '==', sf.value))
      );
      if (!snap.empty) {
        snap.forEach(d => { if (!found) found = { ...d.data(), id: d.id }; });
        break;
      }
    }

    // Fallback: full scan only if targeted queries found nothing
    if (!found) {
      const snap = await window._getDocs(window._col(db, 'ipear_customers'));
      snap.forEach(d => {
        const data = d.data();
        if ([data.name||'', String(data.phone||''), String(data.card||'')]
            .some(s => s.toLowerCase().includes(qLower))) {
          found = { ...data, id: d.id };
        }
      });
    }

    if (found) {
      if (found.blocked) {
        document.getElementById('cust-display').style.display = 'none';
        document.getElementById('not-found').style.display    = 'block';
        document.getElementById('not-found').innerHTML = '<div style="font-size:1.8rem;margin-bottom:10px">🚫</div><div style="font-size:1.1rem;font-weight:700;color:#e53935">Ο πελάτης είναι blocked</div><div style="font-size:.88rem;color:#888;margin-top:8px">Επικοινωνήστε με τον διαχειριστή.</div>';
        showResult();
      } else {
        renderCustomer(found);
        showResult();
      }
    } else {
      document.getElementById('cust-display').style.display = 'none';
      document.getElementById('not-found').style.display    = 'block';
      showResult();
    }
  } catch(e) {
    _showToast('❌ Σφάλμα σύνδεσης: ' + e.message);
  }

  btn.innerHTML = 'Αναζήτηση';
  btn.disabled  = false;
}

function renderCustomer(d) {
  window._foundCustomer = d;
  const pts = d.points || 0;
  const tot = d.totalPoints || pts;
  const ini = (d.name||'?').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();
  const t   = tier(tot);

  document.getElementById('r-av').textContent    = ini;
  document.getElementById('r-name').textContent  = d.name;
  const _ph = d.phone || '';
  document.getElementById('r-phone').textContent = _ph.length > 4 ? '•••' + _ph.slice(-4) : _ph;
  document.getElementById('r-card').textContent  = '📱 ' + d.card;
  document.getElementById('r-pts').textContent   = pts.toLocaleString('el-GR');

  document.getElementById('r-ticon').textContent = t.icon;
  document.getElementById('r-tname').textContent = t.name;

  if (t.next) {
    const floor = tierFloor(tot);
    const pct   = Math.min(100, Math.round(((tot - floor) / (t.next - floor)) * 100));
    const nName = t.next === 1000 ? '🥈 Silver' : t.next === 3000 ? '🥇 Gold' : t.next === 6000 ? '💎 Diamond' : '👑 Platinum';
    document.getElementById('r-tsub').textContent = `${tot.toLocaleString('el-GR')} / ${t.next.toLocaleString('el-GR')} πόντοι για ${nName}`;
    document.getElementById('r-prog').style.width = pct + '%';
  } else {
    document.getElementById('r-tsub').textContent = '🏆 Ανώτατη κατάταξη — Elite Member!';
    document.getElementById('r-prog').style.width = '100%';
  }

  // Rewards
  const rewards = [
    { pts: 1000, label: '5€ Έκπτωση' },
    { pts: 2500, label: '15€ Έκπτωση' },
    { pts: 4000, label: '30€ Έκπτωση' },
  ];
  document.getElementById('r-rewards').innerHTML = rewards.map(r => {
    const ok = pts >= r.pts;
    return `<div class="reward-box ${ok ? 'available' : ''}">
      <div class="r-pts">${escHtml(String(r.pts))} pts</div>
      <div class="r-lbl">${ok ? '✅ ' : '🔒 '}${escHtml(r.label)}</div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════
//  SCREENS
// ══════════════════════════════════════
function showResult() {
  document.getElementById('idle').classList.add('hidden');
  document.getElementById('result-screen').classList.add('show');
}

function goBack() {
  document.getElementById('result-screen').classList.remove('show');
  document.getElementById('idle').classList.remove('hidden');
  document.getElementById('sinput').value = '';
  document.getElementById('sinput').focus();
  // Reset not-found / cust-display
  document.getElementById('cust-display').style.display = 'block';
  document.getElementById('not-found').style.display    = 'none';
  // Auto-focus after transition
  setTimeout(() => document.getElementById('sinput').focus(), 450);
}

// ══════════════════════════════════════
//  REDEEM
// ══════════════════════════════════════
function openRedeemPanel() {
  if (_maintenanceMode) { _showToast('Το σύστημα αναβαθμίζεται. Παρακαλούμε δοκιμάστε σε λίγο!'); return; }
  const c = window._foundCustomer;
  if (!c) return;
  const pts = c.points || 0;
  document.getElementById('rp-name').textContent = c.name;
  document.getElementById('rp-pts').textContent = pts;
  const opts = [
    {cost:1000,disc:5},{cost:2500,disc:15},{cost:4000,disc:30}
  ];
  document.getElementById('rp-options').innerHTML = opts.map(o => {
    const ok = pts >= o.cost;
    return `<div class="rp-opt ${ok ? 'ok' : 'no'}" ${ok ? `role="button" tabindex="0" onclick="confirmTabletRedeem(${Number(o.cost)},${Number(o.disc)})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();confirmTabletRedeem(${Number(o.cost)},${Number(o.disc)})}" aria-label="${o.cost} πόντοι για ${o.disc} ευρώ έκπτωση"` : 'aria-disabled="true"'}>
      <span style="font-weight:700">${escHtml(String(o.cost))} πόντοι</span>
      <span style="font-size:1.2rem;font-weight:900;color:${ok ? '#5a9600' : '#767676'}">${escHtml(String(o.disc))}€ έκπτωση</span>
    </div>`;
  }).join('');
  const rpEl = document.getElementById('redeem-panel');
  rpEl.style.display = 'flex';
  if (typeof _trapFocus === 'function') _trapFocus(rpEl);
}
function closeRedeemPanel() {
  document.getElementById('redeem-panel').style.display = 'none';
  if (typeof _releaseFocus === 'function') _releaseFocus();
}
let _tabletTxnBusy = false;
let _tabletTxnLastAt = 0;
async function confirmTabletRedeem(cost, disc) {
  if (_tabletTxnBusy) { _showToast('⏳ Επεξεργασία σε εξέλιξη...'); return; }
  if (Date.now() - _tabletTxnLastAt < 2000) { _showToast('⏳ Περίμενε λίγο...'); return; }
  if (_maintenanceMode) { _showToast('Το σύστημα αναβαθμίζεται. Παρακαλούμε δοκιμάστε σε λίγο!'); return; }
  const c = window._foundCustomer;
  if (!c || (c.points||0) < cost) return;
  if (!confirm(`Επιβεβαίωση εξαργύρωσης ${cost} πόντων = ${disc}€ έκπτωση για ${c.name};`)) return;
  _tabletTxnBusy = true;
  _tabletTxnLastAt = Date.now();
  const db = window._db;
  try {
    // ── Atomic Transaction (prevents double-spend race condition) ─────
    // Balance update + audit row + customer-facing ledger row share a single
    // Firestore commit. Was previously two separate writes (txn then addDoc)
    // which could leave points deducted with no ledger entry on partial fail.
    let newPts;
    const tabletNowIso = new Date().toISOString();
    const tabletLedgerId = `redeem_manual_tablet_${c.id}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    await window._runTransaction(db, async (txn) => {
      const custRef  = window._doc(db, 'ipear_customers', c.id);
      const custSnap = await txn.get(custRef);
      if (!custSnap.exists()) throw new Error('Ο πελάτης δεν βρέθηκε στη βάση.');
      const cust = custSnap.data();

      if (cust.blocked === true) throw new Error('Ο πελάτης είναι blocked.');
      if ((cust.points || 0) < cost) {
        throw new Error('Ανεπαρκείς πόντοι. Υπόλοιπο: ' + (cust.points||0) + ', Απαιτούνται: ' + cost);
      }

      newPts = Math.max(0, (cust.points || 0) - cost);

      txn.update(custRef, { points: newPts });

      // Audit trail (same transaction)
      const auditRef = window._doc(db, 'audit_logs', 'manual_' + c.id + '_' + Date.now());
      txn.set(auditRef, {
        action: 'manual_redeem', source: 'tablet',
        approvedByUid: _tabletActorUid || '', approvedAt: tabletNowIso,
        customerId: c.id, customerUid: cust.uid || '',
        pointsDeducted: cost, discount: disc,
        storeId: _tabletStoreId || null, storeName: _tabletStoreName
      });

      // Customer-facing ledger entry (same transaction).
      txn.set(window._doc(db, 'ipear_transactions', tabletLedgerId), {
        customerId: c.id, customerUid: c.uid || cust.uid || '',
        customerEmail: cust.email || '',
        customerName: c.name, card: c.card,
        type: 'redeem', points: -cost, discount: disc, method: 'manual',
        storeId: _tabletStoreId || null, storeName: _tabletStoreName,
        date: tabletNowIso,
        approvedByTablet: _tabletActorUid || ''
      });
    });

    window._foundCustomer.points = newPts;
    closeRedeemPanel();
    const ptEl = document.getElementById('r-pts');
    if (ptEl) ptEl.textContent = newPts.toLocaleString('el-GR');
    _playSuccess();
    _showToast('✅ Εξαργύρωση ' + disc + '€ ολοκληρώθηκε! Νέο υπόλοιπο: ' + newPts.toLocaleString('el-GR') + ' πόντοι');
  } catch(e) { _playError(); _showToast('❌ Σφάλμα: ' + e.message); }
  finally { _tabletTxnBusy = false; }
}

// ══════════════════════════════════════
//  QR REDEMPTION CONFIRM FLOW
// ══════════════════════════════════════
let _pendingQRRedeem = null;

async function handleRedeemQR(code) {
  // Validate format: exactly 6 digits
  if (!/^\d{6}$/.test(code)) {
    try { await _workerRedeemGuard('fail', { reason: 'invalid-format' }); } catch(_) {}
    _showQRRedeemOverlay(null, 'Μη έγκυρος QR κωδικός εξαργύρωσης.');
    return;
  }
  const db = window._db;
  try {
    // Run worker rate-limit guard in PARALLEL with the Firestore lookup.
    // If guard throws (429), Promise.all rejects and we land in catch below.
    const [, snap] = await Promise.all([
      _workerRedeemGuard('check'),
      window._getDocs(
        window._query(
          window._col(db, 'ipear_redemptions'),
          window._where('code', '==', code)
        )
      )
    ]);

    if (snap.empty) {
      await _workerRedeemGuard('fail', { reason: 'not-found', code });
      _showQRRedeemOverlay(null, '⚠️ Άκυρος κωδικός ή έχει λήξει.');
      return;
    }

    let redemption = null, redemptionId = null;
    snap.forEach(d => { if (!redemptionId) { redemption = d.data(); redemptionId = d.id; } });

    if (redemption.used) {
      await _workerRedeemGuard('fail', { reason: 'already-used', code });
      _showQRRedeemOverlay(null, 'Αυτός ο κωδικός έχει ήδη χρησιμοποιηθεί.');
      return;
    }

    if (redemption.status === 'cancelled' || redemption.status === 'rejected') {
      await _workerRedeemGuard('fail', { reason: 'cancelled', code });
      _showQRRedeemOverlay(null, '⚠️ Άκυρος κωδικός ή έχει λήξει.');
      return;
    }

    const expiresAtTime = _parseExpiryMs(redemption);
    if (!expiresAtTime || isNaN(expiresAtTime) || Date.now() > expiresAtTime) {
      await _workerRedeemGuard('fail', { reason: 'expired', code });
      _showQRRedeemOverlay(null, '⚠️ Άκυρος κωδικός ή έχει λήξει.');
      return;
    }

    _pendingQRRedeem = { redemptionId, ...redemption };
    _showQRRedeemOverlay(redemption, null);

  } catch(e) {
    _showToast('❌ Σφάλμα ανάκτησης κωδικού: ' + e.message);
  }
}

function _showQRRedeemOverlay(data, error) {
  const overlay  = document.getElementById('qr-redeem-confirm');
  const errBox   = document.getElementById('qrc-error');
  const confirmBtn = document.getElementById('qrc-confirm-btn');

  if (error) {
    _playError();
    document.getElementById('qrc-title').textContent    = 'Μη έγκυρος κωδικός';
    document.getElementById('qrc-customer').textContent = '';
    document.getElementById('qrc-reward').textContent   = '';
    document.getElementById('qrc-pts').textContent      = '';
    errBox.textContent    = '⚠️ ' + error;
    errBox.style.display  = 'block';
    confirmBtn.disabled   = true;
    confirmBtn.style.opacity = '.4';
  } else {
    document.getElementById('qrc-title').textContent    = 'Επιβεβαίωση Εξαργύρωσης';
    document.getElementById('qrc-customer').textContent = '👤 ' + data.customerName;
    document.getElementById('qrc-reward').textContent   = data.label || (data.discount + '€ Έκπτωση');
    document.getElementById('qrc-pts').textContent      = '−' + data.points + ' πόντοι από το υπόλοιπο';
    errBox.style.display   = 'none';
    confirmBtn.disabled    = false;
    confirmBtn.style.opacity = '1';
    confirmBtn.textContent = '✅ Επιβεβαίωση';
    // BUGFIX: restore onclick to confirmQRRedeem (offer flow overrides it to sendOfferForApproval)
    confirmBtn.onclick     = confirmQRRedeem;
  }
  overlay.style.display = 'flex';
  if (typeof _trapFocus === 'function') _trapFocus(overlay);
}

function closeQRRedeemConfirm() {
  document.getElementById('qr-redeem-confirm').style.display = 'none';
  if (typeof _releaseFocus === 'function') _releaseFocus();
  _pendingQRRedeem = null;
  _pendingOfferQR  = null;
  // Reset confirm button to default reward handler
  const btn = document.getElementById('qrc-confirm-btn');
  if (btn) { btn.onclick = confirmQRRedeem; btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '✅ Επιβεβαίωση'; }
}

async function confirmQRRedeem() {
  if (_maintenanceMode) { _showToast('Το σύστημα αναβαθμίζεται. Παρακαλούμε δοκιμάστε σε λίγο!'); return; }
  const p = _pendingQRRedeem;
  if (!p) return;

  const btn = document.getElementById('qrc-confirm-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Επεξεργασία...';

  const db = window._db;
  try {
    await _workerRedeemGuard('check');
    // ── Atomic Firestore Transaction ──────────────────────────────────────
    // All reads + both writes execute as one atomic unit.
    // If ANY check fails the whole transaction rolls back:
    // → no double-spend, no partial state, no orphan deductions.
    // Ledger entry id is pre-generated so it lives in the same Firestore
    // commit as the balance update and the audit row (was previously
    // written via a separate addDoc that could fail post-deduction).
    let newPts, custUid, pointsToDeduct, discount, label, card, resolvedCustId;
    const txLedgerId = `redeem_qr_${p.redemptionId}`;
    await window._runTransaction(db, async (txn) => {

      // 1. Re-read the redemption code INSIDE the transaction
      const redRef  = window._doc(db, 'ipear_redemptions', p.redemptionId);
      const redSnap = await txn.get(redRef);
      if (!redSnap.exists()) throw new Error('⚠️ Άκυρος κωδικός ή έχει λήξει.');
      const redData = redSnap.data();

      // Abort if already used (race-condition guard)
      if (redData.used === true) throw new Error('Αυτός ο κωδικός έχει ήδη χρησιμοποιηθεί.');

      // Abort if cancelled or rejected
      if (redData.status === 'cancelled' || redData.status === 'rejected') throw new Error('⚠️ Άκυρος κωδικός ή έχει λήξει.');

      // Abort if expired
      const expiresAtTime = _parseExpiryMs(redData);
      if (!expiresAtTime || isNaN(expiresAtTime) || Date.now() > expiresAtTime) {
        throw new Error('⚠️ Άκυρος κωδικός ή έχει λήξει.');
      }

      // Strict integer/positive guard
      pointsToDeduct = redData.points;
      if (!Number.isInteger(pointsToDeduct) || pointsToDeduct <= 0) {
        throw new Error('Μη έγκυρο ποσό πόντων προς αφαίρεση.');
      }
      discount = redData.discount;
      label = redData.label || '';
      card = redData.card || p.card || '';

      // 2. Re-read the customer INSIDE the transaction (try customerId, then customerUid fallback)
      let custRef  = window._doc(db, 'ipear_customers', p.customerId);
      let custSnap = await txn.get(custRef);
      if (!custSnap.exists() && p.customerUid && p.customerUid !== p.customerId) {
        custRef  = window._doc(db, 'ipear_customers', p.customerUid);
        custSnap = await txn.get(custRef);
      }
      if (!custSnap.exists()) throw new Error('Ο πελάτης δεν βρέθηκε στη βάση.');
      const cust = custSnap.data();

      if (cust.blocked === true) throw new Error('Ο πελάτης είναι blocked.');

      // Abort if insufficient balance
      if ((cust.points || 0) < pointsToDeduct) {
        throw new Error(`Ανεπαρκείς πόντοι. Υπόλοιπο: ${cust.points || 0}, Απαιτούνται: ${pointsToDeduct}`);
      }

      newPts  = Math.max(0, (cust.points || 0) - pointsToDeduct);
      custUid = cust.uid || p.customerUid || '';
      resolvedCustId = custRef.id;

      // 3. Atomic writes — both commit or both roll back
      const nowIso = new Date().toISOString();
      txn.update(redRef,  { used: true, status: 'used', usedAt: nowIso });
      txn.update(custRef, { points: newPts });

      // Insider threat audit trail in same transaction
      const auditRef = window._doc(db, 'audit_logs', 'redeem_' + p.redemptionId);
      txn.set(auditRef, {
        action: 'redeem_approved',
        source: 'tablet',
        approvedByUid: _tabletActorUid || '',
        approvedAt: nowIso,
        customerId: resolvedCustId,
        customerUid: custUid,
        redemptionId: p.redemptionId,
        code: redData.code || p.code || '',
        pointsDeducted: pointsToDeduct,
        storeId: _tabletStoreId || null,
        storeName: _tabletStoreName
      });

      // Customer-facing ledger entry — atomic with the deduction.
      txn.set(window._doc(db, 'ipear_transactions', txLedgerId), {
        customerId:    resolvedCustId,
        customerUid:   custUid,
        customerEmail: cust.email || '',
        customerName:  p.customerName,
        card:          card,
        type:          'redeem',
        points:        -pointsToDeduct,
        discount:      discount,
        label:         label,
        method:        'qr',
        storeId:       _tabletStoreId || null,
        storeName:     _tabletStoreName,
        date:          nowIso,
        approvedByTablet: _tabletActorUid || ''
      });
    });

    await _workerRedeemGuard('success', { code: p.code || '' });

    // Sync _foundCustomer.id to resolvedCustId after potential fallback
    // so the equality check below works even when tablet used customerUid path
    if (window._foundCustomer && resolvedCustId) {
      window._foundCustomer.id = resolvedCustId;
    }
    // Update displayed customer if same person
    if (window._foundCustomer && window._foundCustomer.id === p.customerId) {
      window._foundCustomer.points = newPts;
      const ptEl = document.getElementById('r-pts');
      if (ptEl) ptEl.textContent = newPts.toLocaleString('el-GR');
    }

    closeQRRedeemConfirm();
    _playSuccess();
    _showToast('✅ Εξαργύρωση ' + (p.label || p.discount + '€') + ' ολοκληρώθηκε!');

  } catch(e) {
    try { await _workerRedeemGuard('fail', { reason: 'confirm-failed' }); } catch(_) {}
    _playError();
    btn.disabled = false;
    btn.textContent = '✅ Επιβεβαίωση';
    const errBox = document.getElementById('qrc-error');
      const errMsg = (e && e.message) ? e.message : 'Άγνωστο σφάλμα.';
      errBox.textContent = '❌ ' + errMsg;
      errBox.style.display = 'block';
  } // closes catch
} // closes confirmQRRedeem

// ════════════════════════════════════════
//  OFFER QR HANDLER — Fortress Mode
//  Offers ADD bonus points (unlike rewards which deduct).
//  Code lookup in Firestore → validate → approve → add points.
// ════════════════════════════════════════
let _pendingOfferQR = null;

async function handleOfferQR(code) {

  // Validate format: exactly 6 digits
  if (!/^\d{6}$/.test(code)) {
    _showOfferResult(null, 'Μη έγκυρος κωδικός προσφοράς.');
    return;
  }

  const db = window._db;
  try {
    // ── STEP 1: Find the pending offer redemption by code ──
    let snap;
    try {
      snap = await window._getDocs(
        window._query(
          window._col(db, 'ipear_offer_redemptions'),
          window._where('code', '==', code)
        )
      );
    } catch(qErr) {
      _showOfferResult(null, 'Firestore query error: ' + (qErr.code || qErr.message));
      return;
    }
    if (snap.empty) {
      _showOfferResult(null, '⚠️ Άκυρος κωδικός ή έχει λήξει.');
      return;
    }

    let redemption = null, redemptionId = null;
    snap.forEach(d => { if (!redemptionId) { redemption = d.data(); redemptionId = d.id; } });

    // ── CHECK 1: Already used? ──
    if (redemption.used) {
      _showOfferResult(null, 'Αυτός ο κωδικός έχει ήδη χρησιμοποιηθεί.');
      return;
    }

    // ── CHECK 2: Cancelled or rejected? ──
    if (redemption.status === 'cancelled' || redemption.status === 'rejected') {
      _showOfferResult(null, '⚠️ Άκυρος κωδικός ή έχει λήξει.');
      return;
    }

    // ── CHECK 3: Time Check (anti-screenshot) — 5 min ──
    const expiresAt = new Date(redemption.expiresAt).getTime();
    if (isNaN(expiresAt) || Date.now() > expiresAt) {
      _showOfferResult(null, '⚠️ Άκυρος κωδικός ή έχει λήξει.');
      return;
    }

    // ── CHECKS 3+4 in PARALLEL: offer active + customer exists ──
    // These two are independent lookups — fire them together to cut
    // ~200-400ms from the iPad approval-modal latency.
    const offerId = redemption.offerId;
    const [offersSnap, custSnapPrimary] = await Promise.all([
      window._getDocs(
        window._query(
          window._col(db, 'ipear_offers'),
          window._where('active', '==', true)
        )
      ),
      window._getDoc(window._doc(db, 'ipear_customers', redemption.customerId))
    ]);
    let offerDoc = null;
    offersSnap.forEach(d => {
      const data = d.data();
      if (d.id === offerId || data.title === offerId) {
        offerDoc = { id: d.id, ...data };
      }
    });
    if (!offerDoc) {
      _showOfferResult(null, 'Η προσφορά δεν είναι πλέον ενεργή.');
      return;
    }

    let custDocId = redemption.customerId;
    let custSnap = custSnapPrimary;
    if (!custSnap.exists() && redemption.customerDocId && redemption.customerDocId !== custDocId) {
      custDocId = redemption.customerDocId;
      custSnap = await window._getDoc(window._doc(db, 'ipear_customers', custDocId));
    }
    if (!custSnap.exists()) {
      _showOfferResult(null, 'Ο πελάτης δεν βρέθηκε.');
      return;
    }
    const cust = custSnap.data();
    if (cust.blocked) {
      _showOfferResult(null, 'Ο πελάτης είναι blocked.');
      return;
    }

    // ── CHECK 5: Single-use — already redeemed before? ──
    // Dual-ID query: check both customerDocId AND customerId to prevent
    // post-migration double-redemption (pre-migration docs use old docId,
    // post-migration docs use auth UID as customerId)
    if (redemption.singleUse || offerDoc.singleUse) {
      const idsToCheck = [custDocId];
      if (redemption.customerId && redemption.customerId !== custDocId) {
        idsToCheck.push(redemption.customerId);
      }
      // Query by customerDocId (covers pre-migration docs)
      const prevByDoc = await window._getDocs(
        window._query(
          window._col(db, 'ipear_offer_redemptions'),
          window._where('offerId', '==', offerDoc.id),
          window._where('customerDocId', '==', custDocId),
          window._where('used', '==', true)
        )
      );
      if (!prevByDoc.empty) {
        _showOfferResult(null, 'Ο πελάτης έχει ήδη χρησιμοποιήσει αυτή την προσφορά.');
        return;
      }
      // Query by customerId if different from customerDocId (covers post-migration docs)
      if (redemption.customerId && redemption.customerId !== custDocId) {
        const prevById = await window._getDocs(
          window._query(
            window._col(db, 'ipear_offer_redemptions'),
            window._where('offerId', '==', offerDoc.id),
            window._where('customerId', '==', redemption.customerId),
            window._where('used', '==', true)
          )
        );
        if (!prevById.empty) {
          _showOfferResult(null, 'Ο πελάτης έχει ήδη χρησιμοποιήσει αυτή την προσφορά.');
          return;
        }
      }
    }

    // SECURITY: Read bonus from TRUSTED offer doc, not user-created redemption doc
    const bonus = Number(offerDoc.bonusPoints) || Number(offerDoc.pointsCost) || 0;
    _pendingOfferQR = {
      redemptionId, offerDoc, bonus,
      customerId: custDocId,
      customerName: redemption.customerName,
      card: redemption.card,
      offerTitle: redemption.offerTitle || offerDoc.title
    };

    _showOfferResult({
      customerName: redemption.customerName,
      offerTitle: redemption.offerTitle || offerDoc.title,
      bonus
    }, null);

  } catch(e) {
    _showOfferResult(null, 'Σφάλμα: ' + (e.message || 'Άγνωστο'));
  }
}

let _offerApprovalUnsub = null;

function _showOfferResult(data, error) {
  const overlay = document.getElementById('qr-redeem-confirm');
  const errBox  = document.getElementById('qrc-error');
  const confirmBtn = document.getElementById('qrc-confirm-btn');

  if (error) {
    document.getElementById('qrc-title').textContent    = '❌ Αποτυχία Προσφοράς';
    document.getElementById('qrc-customer').textContent = '';
    document.getElementById('qrc-reward').textContent   = '';
    document.getElementById('qrc-pts').textContent      = '';
    errBox.textContent   = '⚠️ ' + error;
    errBox.style.display = 'block';
    confirmBtn.disabled  = true;
    confirmBtn.style.opacity = '.4';
    confirmBtn.onclick = null;
  } else {
    document.getElementById('qrc-title').textContent    = '🎁 Προσφορά';
    document.getElementById('qrc-customer').textContent = '👤 ' + data.customerName;
    document.getElementById('qrc-reward').textContent   = data.offerTitle;
    document.getElementById('qrc-pts').textContent      = data.bonus > 0 ? `+${data.bonus} bonus πόντοι` : 'Χωρίς bonus';
    errBox.style.display   = 'none';
    // Button sends to admin for approval instead of direct approve
    confirmBtn.disabled    = false;
    confirmBtn.style.opacity = '1';
    confirmBtn.textContent = '📤 Αποστολή για Έγκριση';
    confirmBtn.onclick     = sendOfferForApproval;
  }
  overlay.style.display = 'flex';
  if (typeof _trapFocus === 'function') _trapFocus(overlay);
}

async function sendOfferForApproval() {
  const p = _pendingOfferQR;
  if (!p) return;

  const btn = document.getElementById('qrc-confirm-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Αποστολή...';

  const db = window._db;
  try {
    // Update redemption doc → status: pending_approval (admin will see it)
    const redRef = window._doc(db, 'ipear_offer_redemptions', p.redemptionId);
    await window._updateDoc(redRef, {
      status: 'pending_approval',
      tabletRequestedAt: new Date().toISOString(),
      tabletStoreId: _tabletStoreId || null,
      tabletStoreName: _tabletStoreName || ''
    });

    // Show waiting state
    document.getElementById('qrc-title').textContent = '⏳ Αναμονή Έγκρισης...';
    document.getElementById('qrc-pts').textContent   = 'Περιμένουμε έγκριση από τον διαχειριστή';
    btn.textContent = '⏳ Αναμονή...';
    btn.disabled = true;
    btn.style.opacity = '.5';
    document.getElementById('qrc-error').style.display = 'none';

    // Start real-time watcher on this doc
    _startOfferApprovalWatcher(p.redemptionId, p);

  } catch(e) {
    btn.disabled = false;
    btn.textContent = '📤 Αποστολή για Έγκριση';
    const errBox = document.getElementById('qrc-error');
    const msg = (e.message || '');
    errBox.textContent = msg.includes('No document') || msg.includes('not-found')
      ? '⚠️ Άκυρος κωδικός ή έχει λήξει.'
      : '❌ ' + (msg || 'Σφάλμα');
    errBox.style.display = 'block';
  }
}

function _startOfferApprovalWatcher(redemptionId, p) {
  // Stop any previous watcher
  if (_offerApprovalUnsub) { try { _offerApprovalUnsub(); } catch(_) {} }

  const ref = window._doc(window._db, 'ipear_offer_redemptions', redemptionId);
  _offerApprovalUnsub = window._onSnapshot(ref, (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();

    if (data.status === 'approved' || (data.used === true && data.status === 'used')) {
      // ✅ APPROVED by admin!
      _stopOfferApprovalWatcher();
      closeQRRedeemConfirm();
      _pendingOfferQR = null;

      // Update displayed customer points
      if (window._foundCustomer && window._foundCustomer.id === p.customerId && p.bonus > 0) {
        window._foundCustomer.points = (window._foundCustomer.points || 0) + p.bonus;
        const ptEl = document.getElementById('r-pts');
        if (ptEl) ptEl.textContent = window._foundCustomer.points.toLocaleString('el-GR');
      }
      _playSuccess();
      _showToast('✅ Εγκρίθηκε! "' + p.offerTitle + '"' + (p.bonus > 0 ? ' — +' + p.bonus + ' πόντοι' : ''));

    } else if (data.status === 'rejected') {
      // ❌ REJECTED by admin
      _stopOfferApprovalWatcher();
      _playError();
      document.getElementById('qrc-title').textContent = '❌ Απορρίφθηκε';
      document.getElementById('qrc-pts').textContent   = 'Ο διαχειριστής απέρριψε την προσφορά';
      document.getElementById('qrc-error').textContent  = '⚠️ ' + (data.rejectReason || 'Απορρίφθηκε');
      document.getElementById('qrc-error').style.display = 'block';
      const btn = document.getElementById('qrc-confirm-btn');
      btn.textContent = 'Κλείσιμο';
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.onclick = () => { closeQRRedeemConfirm(); _pendingOfferQR = null; };
    }
    // else still pending — keep waiting
  }, (err) => {
    logger.error('[offer-watcher]', err);
  });

  // Auto-timeout after 5 minutes
  _offerApprovalTimeout = setTimeout(() => {
    if (_offerApprovalUnsub) {
      _stopOfferApprovalWatcher();
      document.getElementById('qrc-title').textContent = '⏰ Timeout';
      document.getElementById('qrc-pts').textContent   = 'Δεν ελήφθη έγκριση εντός 5 λεπτών';
      const btn = document.getElementById('qrc-confirm-btn');
      btn.textContent = 'Κλείσιμο';
      btn.disabled = false;
      btn.onclick = () => { closeQRRedeemConfirm(); _pendingOfferQR = null; };
    }
  }, 5 * 60 * 1000);
}

let _offerApprovalTimeout = null;
function _stopOfferApprovalWatcher() {
  if (_offerApprovalUnsub) { try { _offerApprovalUnsub(); } catch(_) {} _offerApprovalUnsub = null; }
  if (_offerApprovalTimeout) { clearTimeout(_offerApprovalTimeout); _offerApprovalTimeout = null; }
}

function _showToast(msg) {
  const t = document.createElement('div');
  t.className   = 'ipear-toast';
  t.textContent = msg;
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.setAttribute('aria-atomic', 'true');
  document.body.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .5s'; t.style.opacity = '0'; }, 2500);
  setTimeout(() => t.remove(), 3100);
}

// ══════════════════════════════════════
//  REAL-TIME PENDING OFFER LISTENER
//  Auto-surfaces new customer offer redemptions — no scanning needed.
// ══════════════════════════════════════
let _pendingOfferUnsub = null;
let _pendingOfferSeenIds = new Set();

function _startPendingOfferListener() {
  if (_pendingOfferUnsub || window.DEMO) return;
  const db = window._db;
  try {
    const q = window._query(
      window._col(db, 'ipear_offer_redemptions'),
      window._where('status', '==', 'pending')
    );
    _pendingOfferUnsub = window._onSnapshot(q, snap => {
      snap.docChanges().forEach(change => {
        try {
          if (change.type !== 'added') return;
          const id = change.doc.id;
          if (_pendingOfferSeenIds.has(id)) return;
          _pendingOfferSeenIds.add(id);
          const data = change.doc.data();
          if (!data || !data.code) return;
          const expiresAt = new Date(data.expiresAt).getTime();
          if (isNaN(expiresAt) || Date.now() > expiresAt) return;
          _showIncomingOfferBanner(data, id);
        } catch(e) { logger.warn('[pending-offer-listener] skipping doc:', change.doc?.id, e); }
      });
    }, err => logger.warn('[pending-offer-listener]', err));
  } catch(e) { logger.warn('[pending-offer-listener] setup error:', e); }
}

function _stopPendingOfferListener() {
  if (_pendingOfferUnsub) { try { _pendingOfferUnsub(); } catch(_) {} _pendingOfferUnsub = null; }
}

function _showIncomingOfferBanner(data, docId) {
  const existing = document.getElementById('incoming-offer-' + docId);
  if (existing) return;

  const banner = document.createElement('div');
  banner.id = 'incoming-offer-' + docId;
  banner.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:linear-gradient(135deg,#1a2a00,#2a3a10);border:2px solid #8ae900;border-radius:16px;padding:18px 24px;min-width:340px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,.5);animation:slideDown .4s ease-out;font-family:system-ui,sans-serif';
  const bp = data.bonusPoints || 0;
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px">
      <div style="font-size:2.2rem;flex-shrink:0">🔔</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:.72rem;color:#8ae900;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Νέα Εξαργύρωση Προσφοράς</div>
        <div style="font-size:1rem;font-weight:800;color:#fff;margin-bottom:2px">${_escBanner(data.customerName || 'Πελάτης')}</div>
        <div style="font-size:.85rem;color:rgba(255,255,255,.7)">${_escBanner(data.offerTitle || '')}${bp > 0 ? ' · +' + bp + ' πόντοι' : ''}</div>
        <div style="font-size:1.3rem;font-weight:900;letter-spacing:3px;color:#8ae900;font-family:monospace;margin-top:6px">${data.code.slice(0,3)} ${data.code.slice(3)}</div>
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-top:14px">
      <button onclick="_handleIncomingOffer('${_escBanner(data.code)}','${docId}')" style="flex:1;padding:12px;background:#8ae900;color:#111;border:none;border-radius:10px;font-weight:800;font-size:.9rem;cursor:pointer;min-height:44px">✅ Επεξεργασία</button>
      <button onclick="this.closest('[id^=incoming-offer]').remove()" style="padding:12px 18px;background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:10px;font-weight:700;font-size:.9rem;cursor:pointer;min-height:44px">✕</button>
    </div>`;
  document.body.appendChild(banner);

  setTimeout(() => { if (banner.parentNode) banner.remove(); }, 10 * 60 * 1000);
}

function _escBanner(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function _handleIncomingOffer(code, docId) {
  const el = document.getElementById('incoming-offer-' + docId);
  if (el) el.remove();
  handleOfferQR(code);
}

// ══════════════════════════════════════
//  MAINTENANCE MODE LISTENER (Kill Switch)
// ══════════════════════════════════════
function _startMaintenanceListener() {
  if (_maintenanceUnsub || window.DEMO) return;
  const db = window._db; if (!db) return;
  try {
    const ref = window._doc(db, 'settings', 'system');
    _maintenanceUnsub = window._onSnapshot(ref, snap => {
      if (!snap.exists()) { _setMaintenanceMode(false); return; }
      _setMaintenanceMode(!!snap.data().maintenance);
    }, () => { _maintenanceUnsub = null; });
  } catch(_) { _maintenanceUnsub = null; }
}

function _setMaintenanceMode(active) {
  _maintenanceMode = active;
  document.querySelectorAll('.redeem-btn, [data-redeem-btn]').forEach(btn => {
    btn.disabled = active;
    if (active) { btn.style.opacity = '.4'; btn.style.pointerEvents = 'none'; }
    else { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
  });
  if (active) _showToast('Το σύστημα αναβαθμίζεται. Παρακαλούμε δοκιμάστε σε λίγο!');
}

// ══════════════════════════════════════
//  AUTO-RESET after inactivity (3 min)
// ══════════════════════════════════════
let idleTimer;
function resetTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (document.getElementById('result-screen').classList.contains('show')) {
      goBack();
    }
  }, 3 * 60 * 1000);
}
document.addEventListener('touchstart', resetTimer);
document.addEventListener('mousemove',  resetTimer);
document.addEventListener('keydown',    resetTimer);
resetTimer();

// ════════════════════════════════════════
//  A11Y: ESCAPE KEY CLOSES DIALOGS (WCAG 2.1 SC 2.1.2)
// ════════════════════════════════════════
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Priority order: topmost modal first
  const qrc = document.getElementById('qr-redeem-confirm');
  if (qrc && qrc.style.display === 'flex') { closeQRRedeemConfirm(); return; }
  const rp = document.getElementById('redeem-panel');
  if (rp && rp.style.display === 'flex') { closeRedeemPanel(); return; }
  const qo = document.getElementById('qr-overlay');
  if (qo && qo.classList.contains('show')) { closeQRScanner(); return; }
});


// ═══════════════════════════════════════════════════════════════════════════
//  WINDOW EXPORTS — required for inline HTML event handlers (onclick, etc.)
// ═══════════════════════════════════════════════════════════════════════════
window.tabletLogin = tabletLogin;
window.doSearch = doSearch;
window.searchByCard = searchByCard;
window.switchToManualSearch = switchToManualSearch;
window.openRedeemPanel = openRedeemPanel;
window.closeRedeemPanel = closeRedeemPanel;
window.confirmTabletRedeem = confirmTabletRedeem;
window.openQRScanner = openQRScanner;
window.closeQRScanner = closeQRScanner;
window.confirmQRRedeem = confirmQRRedeem;
window.closeQRRedeemConfirm = closeQRRedeemConfirm;
window.goBack = goBack;
window._handleIncomingOffer = _handleIncomingOffer;

window.dispatchEvent(new Event('tablet-ready'));
