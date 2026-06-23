import { showToast, _WORKER_URL } from './utils.js';
import { state } from './state.js';
import { logger, tagLog } from './logger.js';

// ═══════════════════════════════════════════════════════════════════════════
//  Firebase SDK — bundled via npm (tree-shaken, version-pinned)
// ═══════════════════════════════════════════════════════════════════════════
import { initializeApp } from 'firebase/app';
import {
  getFirestore, collection, addDoc, setDoc, updateDoc, deleteDoc,
  doc, getDoc, getDocs, query, where, orderBy, limit, startAfter,
  onSnapshot, runTransaction,
  getCountFromServer, getAggregateFromServer, sum, average,
} from 'firebase/firestore';
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, sendEmailVerification, signOut, deleteUser,
  RecaptchaVerifier, signInWithPhoneNumber,
  linkWithCredential, EmailAuthProvider,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
} from 'firebase/auth';
import {
  getMessaging, getToken, onMessage, isSupported as fcmIsSupported,
} from 'firebase/messaging';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';

// Build-time env only. No production-key fallbacks: a missing or placeholder
// VITE_FB_API_KEY routes the app into DEMO mode (see IS_DEMO below) instead of
// silently using prod credentials. CI uses .env.example placeholders → DEMO.
export const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FB_API_KEY            ?? 'YOUR_API_KEY',
  authDomain:        import.meta.env.VITE_FB_AUTH_DOMAIN        ?? '',
  projectId:         import.meta.env.VITE_FB_PROJECT_ID         ?? '',
  storageBucket:     import.meta.env.VITE_FB_STORAGE_BUCKET     ?? '',
  messagingSenderId: import.meta.env.VITE_FB_MSG_SENDER_ID      ?? '',
  appId:             import.meta.env.VITE_FB_APP_ID             ?? '',
};
export const CUSTOMER_BUILD_TAG = 'customer-20260615-v55';
window.CUSTOMER_BUILD_TAG = CUSTOMER_BUILD_TAG;
logger.log('customer.html loaded', CUSTOMER_BUILD_TAG);

export const VAPID_KEY = import.meta.env.VITE_FCM_VAPID_KEY ?? '';

// E2E-FIX: capture silent promise rejections for diagnostics
window.addEventListener('unhandledrejection', (ev) => {
  logger.warn('[unhandled-rejection]', ev.reason?.message || ev.reason);
});

// Safety fallback: ensure _togglePush always exists on window (overridden below)
if (!window._togglePush) {
  window._togglePush = () => {
    if (typeof window._enablePush === 'function') window._enablePush();
    else window.toast && window.toast('⚠️ Ειδοποιήσεις μη διαθέσιμες','red');
  };
}

const IS_DEMO = !firebaseConfig.apiKey
  || firebaseConfig.apiKey === 'YOUR_API_KEY'
  || /^AIzaSy?X{3,}/i.test(firebaseConfig.apiKey);
if (IS_DEMO) {
  window.DEMO=true;
  const _DC=[
    {id:'dc1',name:'Νότης Μπουντούρης',phone:'6912345678',card:'IP-00001',points:750,totalPoints:1850,createdAt:new Date(Date.now()-90*864e5).toISOString(),email:'notis@ipear.gr'},
    {id:'dc2',name:'Μαρία Κωνσταντίνου',phone:'6923456789',card:'IP-00002',points:2200,totalPoints:3800,createdAt:new Date(Date.now()-180*864e5).toISOString(),email:'maria@example.com'},
  ];
  const _DT=[
    {id:'t1',customerId:'dc1',type:'add',points:150,amount:100,category:'📱 Αξεσουάρ (1x)',date:new Date(Date.now()-2*864e5).toISOString()},
    {id:'t2',customerId:'dc1',type:'add',points:225,amount:150,category:'🔧 Επισκευή (1.5x)',date:new Date(Date.now()-7*864e5).toISOString()},
    {id:'t3',customerId:'dc1',type:'redeem',points:-250,discount:5,date:new Date(Date.now()-15*864e5).toISOString()},
    {id:'t4',customerId:'dc1',type:'add',points:375,amount:250,category:'🎨 Custom Θήκη (1.5x)',date:new Date(Date.now()-30*864e5).toISOString()},
    {id:'t5',customerId:'dc2',type:'add',points:300,amount:200,category:'📱 Αξεσουάρ (1x)',date:new Date(Date.now()-864e5).toISOString()},
  ];
  const _DO=[
    {id:'o1',emoji:'🎁',title:'Διπλοί Πόντοι Σαββατοκύριακο',description:'Αυτό το Σαββατοκύριακο κέρδισε διπλούς πόντους σε κάθε αγορά!',startDate:new Date().toISOString().split('T')[0],endDate:new Date(Date.now()+3*864e5).toISOString().split('T')[0],active:true},
    {id:'o2',emoji:'📱',title:'Νέα iPhone 16 Αξεσουάρ',description:'Custom θήκες & αξεσουάρ για iPhone 16 μόλις έφτασαν στο iPear!',active:true,endDate:''},
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
  window._startAfter=cur=>({_t:'sa',cur});
  window._addDoc=async(ref,data)=>{const id='d'+Date.now();if(ref._n==='ipear_redemptions'){const codes=JSON.parse(localStorage.getItem('_ipear_codes')||'[]');codes.push({id,...data});localStorage.setItem('_ipear_codes',JSON.stringify(codes));}return{id};};
  window._setDoc=async(ref,data)=>{const arr=ref._col==='ipear_customers'?_DC:[];const i=arr.findIndex(d=>d.id===ref._id);if(i>=0)Object.assign(arr[i],data);else if(ref._col==='ipear_customers')arr.push({id:ref._id,...data});};
  window._deleteDoc=async(ref)=>{if(ref._col==='ipear_customers'){const i=_DC.findIndex(d=>d.id===ref._id);if(i>=0)_DC.splice(i,1);}};
  window._runTransaction=async(db,fn)=>{const txn={get:async(r)=>{const arr=r._col==='ipear_customers'?_DC:[];const d=arr.find(x=>x.id===r._id);return{exists:()=>!!d,data:()=>d||{}};},set:(r,d)=>{window._setDoc(r,d);},update:(r,d)=>{window._updateDoc(r,d);},delete:(r)=>{window._deleteDoc(r);}};await fn(txn);};
  window._updateDoc=async(ref,data)=>{
    if(!ref||!ref._col)return;
    if(ref._col==='ipear_customers'){
      const i=_DC.findIndex(d=>d.id===ref._id);
      if(i>=0) Object.assign(_DC[i],data);
      return;
    }
    if(ref._col==='ipear_redemptions'){
      const codes=JSON.parse(localStorage.getItem('_ipear_codes')||'[]');
      const i=codes.findIndex(d=>d.id===ref._id);
      if(i>=0){
        Object.assign(codes[i],data);
        localStorage.setItem('_ipear_codes',JSON.stringify(codes));
      }
    }
  };
  window._doc=(db,col,id)=>({_col:col,_id:id});
  window._auth = {};
  window._signIn = async (auth, email, password) => {
    const c = _DC.find(d => d.email === email);
    if (!c) throw {code:'auth/user-not-found'};
    if (password !== (c.authPass || 'demo1234')) throw {code:'auth/wrong-password'};
    return { user: { uid: c.id, email } };
  };
  window._createUser = async (auth, email, password) => {
    const c = _DC.find(d => d.email === email);
    if (c) {
      c.authPass = password;
      return { user: { uid: c.id, email } };
    } else {
      const id = 'dc_' + Date.now();
      const card = 'IP-S' + Math.random().toString(36).slice(2,7).toUpperCase();
      _DC.push({ id, email, name: email.split('@')[0], phone: '', card, points: 0, totalPoints: 0, createdAt: new Date().toISOString(), uid: id, authPass: password });
      return { user: { uid: id, email } };
    }
  };
  window._sendPassReset = async (auth, email) => {
    const c = _DC.find(d => d.email === email);
    if (!c) throw {code:'auth/user-not-found'};
  };
  window._signOut = async () => {};
  window._onSnapshot = (_ref, _cb) => () => {};
  window._sendEmailVerif = async () => {};
  window._deleteAuthUser = async () => {};
  window._getDoc = async () => ({ exists: () => false, data: () => ({}) });
  window._requestPush = window._enablePush = async () => showToast('🔔 Push notifications: demo mode','green');
  window._disablePush = async () => showToast('🔕 Push disabled: demo mode','green');
  window._togglePush = () => { if (state.foundCustomer?.fcmToken) window._disablePush(); else window._enablePush(); };
  // S-2 fix: demo stub takes string mode, persistence constants no longer exposed
  window._setPersistenceMode = async () => {};
  window._RecaptchaVerifier = class { constructor(){} clear(){} };
  window._sendPhoneOTP = async (_auth, _phone) => ({ confirm: async code => code === '123456' ? {user:{uid:'demo-phone-'+Date.now()}} : (() => { throw {code:'auth/invalid-verification-code'}; })() });
  window._linkCredential = async (user) => user;
  window._emailCredential = () => ({});
  window.dispatchEvent(new Event('firebase-ready'));
} else {
  const app=initializeApp(firebaseConfig);
  const db=getFirestore(app);
  window._db=db; window._col=collection; window._getDocs=getDocs;
  window._query=query; window._where=where; window._orderBy=orderBy;
  window._limit=limit; window._startAfter=startAfter; window._addDoc=addDoc;
  window._updateDoc=updateDoc; window._setDoc=setDoc; window._doc=doc;
  window._deleteDoc=deleteDoc; window._runTransaction=runTransaction;
  window._getDoc=getDoc; window._onSnapshot=onSnapshot;
  // P-1: server-side aggregation helpers (zero per-doc read cost)
  window._getCountFromServer = getCountFromServer;
  window._getAggregateFromServer = getAggregateFromServer;
  window._sum = sum; window._average = average;
  const auth = getAuth(app);
  // Persistence policy:
  //   • /tablet — kiosk device, MUST keep session across tab/browser restarts
  //     and share across tabs. Forces LOCAL regardless of remember-me flag.
  //   • everywhere else — customer/admin sites. LOCAL only if the user opted
  //     into "remember me" (ipear_rem flag); else SESSION (per-tab) for
  //     stronger logout-on-close semantics.
  // Without this carve-out, opening /tablet in a new Chrome tab created a
  // fresh empty sessionStorage → no auth user → every Firestore read failed
  // with "Missing or insufficient permissions" (same wording as a rules
  // denial, hard to diagnose).
  const _isTablet = typeof location !== 'undefined' && /^\/tablet(\.html)?(\/|$)/.test(location.pathname);
  const _hasRememberMe = !!localStorage.getItem('ipear_rem');
  const _initPersist = (_isTablet || _hasRememberMe) ? browserLocalPersistence : browserSessionPersistence;
  await setPersistence(auth, _initPersist);
  tagLog('INIT', `✅ Persistence at init: ${_initPersist === browserLocalPersistence ? 'LOCAL 👑' : 'SESSION ⏳'} (tablet=${_isTablet}, rememberMe=${_hasRememberMe})`);
  window._auth = auth;
  window._signIn = signInWithEmailAndPassword;
  window._createUser = createUserWithEmailAndPassword;
  window._sendPassReset = sendPasswordResetEmail;
  window._signOut = () => signOut(auth);
  window._sendEmailVerif = (user) => user ? sendEmailVerification(user) : Promise.resolve();
  window._deleteAuthUser = (user) => deleteUser(user);
  window._RecaptchaVerifier = RecaptchaVerifier;
  window._sendPhoneOTP = signInWithPhoneNumber;
  window._linkCredential = linkWithCredential;
  window._emailCredential = EmailAuthProvider.credential;
  // S-2 fix: closure-scoped persistence constants. Expose a single string-mode
  // entry point only; persistence objects no longer reachable from DevTools.
  window._setPersistenceMode = async (mode) => {
    const isLocal = mode === 'local';
    const target = isLocal ? browserLocalPersistence : browserSessionPersistence;
    const label  = isLocal ? 'LOCAL 👑' : 'SESSION ⏳';
    tagLog('PERSIST', `FIRING PERSISTENCE MODE: ${label}`);
    await setPersistence(auth, target);
    tagLog('PERSIST', `PERSISTENCE SUCCESSFUL ✅ mode=${label}`);
  };

  // ── Firebase App Check (reCAPTCHA v3) ────────────────────────────────
  // Emergency kill-switch: 2026-06-23 the reCAPTCHA endpoint started
  // returning 400 for this project's site key (likely domain
  // registration issue in the reCAPTCHA admin console — to verify, check
  // https://www.google.com/recaptcha/admin and confirm ipear-loyalty.pages.dev
  // is in the allow-list for site key 6LeOaQot...). When App Check init
  // fails OR the reCAPTCHA fetch fails, Firebase Auth's
  // _getAppCheckToken() throws on every token refresh, which manifests
  // as red errors in the console even though App Check enforcement on
  // Firestore is OFF.
  //
  // Until reCAPTCHA is healthy: skip init when VITE_APP_CHECK_KEY is
  // unset, looks like a placeholder, OR VITE_APP_CHECK_DISABLED=1.
  // Re-enable by setting VITE_APP_CHECK_KEY to a working key and
  // VITE_APP_CHECK_DISABLED=0 (or unsetting it). Firestore reads/writes
  // are not gated on App Check at the rules level — the only protection
  // we lose is the "monitor mode" telemetry until this is resolved.
  const _AC_KEY = import.meta.env.VITE_APP_CHECK_KEY ?? '';
  const _AC_DISABLED = String(import.meta.env.VITE_APP_CHECK_DISABLED ?? '').trim() === '1';
  const _AC_KEY_LOOKS_REAL = _AC_KEY && _AC_KEY.length > 30 && !/X{4,}/.test(_AC_KEY);
  if (_AC_DISABLED) {
    logger.log('[app-check] ⏭️ skipped (VITE_APP_CHECK_DISABLED=1)');
  } else if (!_AC_KEY_LOOKS_REAL) {
    logger.log('[app-check] ⏭️ skipped (VITE_APP_CHECK_KEY missing or placeholder)');
  } else {
    try {
      initializeAppCheck(app, { provider: new ReCaptchaV3Provider(_AC_KEY), isTokenAutoRefreshEnabled: true });
      logger.log('[app-check] ✅ initialized');
    } catch(e) { logger.warn('[app-check] init failed:', e.message); }
  }

  // ── FCM Push Notifications ────────────────────────────────────────────
  let _messaging = null;
  try {
    const _fcmOk = await fcmIsSupported();
    if (_fcmOk) {
      _messaging = getMessaging(app);
    } else {
      logger.warn('[fcm] Push not supported on this browser');
    }
  } catch(e) { logger.warn('[fcm] messaging init failed:', e.message); }

  if (_messaging) {
    onMessage(_messaging, payload => {
      const n = payload.notification || {};
      showToast(`🔔 ${n.title||'iPear'}: ${n.body||''}`, 'green');
    });
  }

  // ── Push notifications with state machine + timeout ──
  let _pushBusy = false;

  function _withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
  }

  window._enablePush = async () => {
    if (_pushBusy) return;
    if (!_messaging) return showToast('❌ Messaging μη διαθέσιμο','red');
    if (!VAPID_KEY || VAPID_KEY === 'YOUR_FCM_VAPID_KEY') return showToast('⚠️ VAPID key δεν έχει οριστεί','red');

    // iOS Safari does NOT deliver web push unless the site is installed as a
    // PWA (Home Screen). Without this check the user grants permission, we
    // store a token, the toggle shows "on" — but no notification ever lands.
    // Apple has required PWA-install for web push since iOS 16.4 and this is
    // not negotiable, so block clearly here rather than letting the user blame
    // the app.
    const _ua = navigator.userAgent || '';
    const _isIOS = /iphone|ipad|ipod/i.test(_ua);
    const _isStandalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      window.matchMedia?.('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true;
    if (_isIOS && !_isStandalone) {
      return showToast('📱 Για iPhone: πρόσθεσε πρώτα την εφαρμογή στην Αρχική Οθόνη (Safari → Κοινοποίηση → Προσθήκη στην Αρχική Οθόνη). Μετά άνοιξέ την από το εικονίδιο και ενεργοποίησε ξανά.', 'red');
    }

    _pushBusy = true;
    const { _setPushUI, _PUSH_TIMEOUT_MS } = await import('./push-notifications.js');
    _setPushUI('loading');

    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        _setPushUI(false);
        _pushBusy = false;
        return showToast('❌ Δεν δόθηκε άδεια notifications','red');
      }

      // Let Firebase Messaging auto-register firebase-messaging-sw.js at its
      // default scope (/firebase-cloud-messaging-push-scope/). This does NOT
      // conflict with sw-customer.js which lives at root scope /.
      logger.log('[push] requesting FCM token...');
      const t0 = Date.now();
      const token = await _withTimeout(
        getToken(_messaging, { vapidKey: VAPID_KEY }),
        _PUSH_TIMEOUT_MS
      );
      logger.log(`[push] getToken completed in ${Date.now() - t0}ms`);

      if (!token) {
        _setPushUI(false);
        _pushBusy = false;
        return showToast('❌ Αποτυχία λήψης token','red');
      }

      if (state.foundCustomer?.id && window._db) {
        await _withTimeout(
          window._updateDoc(
            window._doc(window._db,'ipear_customers',state.foundCustomer.id),
            { fcmToken: token, fcmUpdatedAt: new Date().toISOString() }
          ),
          _PUSH_TIMEOUT_MS
        );
        state.foundCustomer.fcmToken = token;
      }

      _setPushUI(true);
      showToast('✅ Push notifications ενεργοποιήθηκαν!','green');

      // Confirmation push — proves end-to-end delivery (SW registered, FCM
      // accepted the token, OS surfaces the notification). Uses the worker's
      // self-push branch (idToken auth): server verifies the token, resolves
      // OUR uid, looks up OUR fcmToken from Firestore, pushes only to that.
      // The `tokens` array is intentionally not sent — the worker ignores it
      // in self-push mode so a customer can't aim a push at anyone else.
      (async () => {
        try {
          const idToken = await window._auth?.currentUser?.getIdToken();
          if (!idToken) return;
          await fetch(_WORKER_URL + '/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              idToken,
              title: '🍐 iPear Loyalty',
              message: 'Έτοιμος για ειδοποιήσεις! Θα ενημερώνεσαι πρώτος για προσφορές & πόντους.'
            })
          });
        } catch(_) {}
      })();
    } catch(e) {
      const { _setPushUI: resetUI } = await import('./push-notifications.js');
      resetUI(false);
      // Map known FCM error codes to user-friendly Greek copy. Raw e.message
      // is something like "FirebaseError: Messaging: A problem occurred while
      // subscribing the user to FCM (messaging/permission-blocked). (...)" —
      // useless to a real user. logger.error keeps the raw form for ops.
      const friendly =
          e.message === 'timeout'                                  ? '⏳ Η ενεργοποίηση καθυστερεί, δοκιμάστε ξανά'
        : e.code === 'messaging/permission-blocked'                ? '🔕 Έχεις μπλοκάρει τα notifications από τις ρυθμίσεις του browser. Άνοιξε τις άδειες της σελίδας και δοκίμασε ξανά.'
        : e.code === 'messaging/permission-default'                ? '🔕 Δεν δόθηκε άδεια. Δοκίμασε ξανά και πάτησε "Επιτρέπεται".'
        : e.code === 'messaging/failed-service-worker-registration' ? '🔄 Πρόβλημα service worker. Κάνε hard refresh (Cmd/Ctrl+Shift+R) και δοκίμασε ξανά.'
        : e.code === 'messaging/unsupported-browser'               ? '🚫 Ο browser σου δεν υποστηρίζει push notifications.'
        : e.code === 'messaging/token-subscribe-failed'            ? '📡 Αποτυχία εγγραφής. Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά.'
        : e.code === 'messaging/token-subscribe-no-token'          ? '📡 Δεν δόθηκε token από το FCM. Δοκίμασε ξανά σε λίγο.'
        : e.name === 'AbortError'                                  ? '⏳ Λήξη χρόνου, δοκίμασε ξανά.'
        :                                                            '❌ Σφάλμα ενεργοποίησης notifications.';
      showToast(friendly, 'red');
      logger.error('[push enable]', e.code || e.name, e.message);
    } finally {
      _pushBusy = false;
    }
  };

  window._disablePush = async () => {
    if (_pushBusy) return;
    _pushBusy = true;
    const { _setPushUI } = await import('./push-notifications.js');
    _setPushUI('loading');

    try {
      if (state.foundCustomer?.id && window._db) {
        await _withTimeout(
          window._updateDoc(
            window._doc(window._db,'ipear_customers',state.foundCustomer.id),
            { fcmToken: '', fcmUpdatedAt: new Date().toISOString() }
          ),
          5000
        );
        state.foundCustomer.fcmToken = '';
      }
      _setPushUI(false);
      showToast('🔕 Ειδοποιήσεις απενεργοποιήθηκαν','green');
    } catch(e) {
      _setPushUI(true);
      showToast('❌ ' + e.message, 'red');
    } finally {
      _pushBusy = false;
    }
  };

  window._togglePush = () => {
    if (state.foundCustomer?.fcmToken) window._disablePush();
    else window._enablePush();
  };

  window._requestPush = window._enablePush;

  // Wait for Firebase Auth to restore persisted session from IndexedDB
  await new Promise(resolve => {
    const unsub = onAuthStateChanged(auth, (user) => {
      tagLog('AUTH-RESTORE', `onAuthStateChanged fired — user: ${user ? `✅ ${user.email} (uid=${user.uid})` : '❌ NULL (no persisted session)'}`);
      unsub();
      resolve();
    });
  });
  tagLog('AUTH-RESTORE', `auth.currentUser at firebase-ready: ${auth.currentUser ? `✅ ${auth.currentUser.email}` : '❌ NULL'}`);

  // Permanent auth-state watcher: if the user ever becomes null AFTER we've
  // shown the tablet idle screen (e.g. phantom session restoration where
  // Firebase first fires with a stale cached user, then invalidates it on
  // failed token refresh), force the login screen back on top so the cashier
  // is forced to authenticate properly instead of clicking around a dead UI.
  // This is the durable fix for the iPear hotfix loop documented in the
  // refactor/p1-services-split branch — phantom session presented the idle
  // screen while auth.currentUser was null, leading to every Firestore read
  // returning "Missing or insufficient permissions" (rules-denial wording).
  const _isTabletPath = typeof location !== 'undefined' && /^\/tablet(\.html)?(\/|$)/.test(location.pathname);
  if (_isTabletPath) {
    onAuthStateChanged(auth, (user) => {
      if (!user) {
        const loginEl = document.getElementById('tablet-login');
        if (loginEl && loginEl.style.display === 'none') {
          loginEl.style.display = 'flex';
          tagLog('AUTH-WATCH', '⚠️ user became null — re-showing tablet-login');
        }
      }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  CONTINUOUS AUTH STATE VALIDATOR
  //  Detects orphan states where Firebase Auth has a user but Firestore has
  //  no matching customer doc — the "Notis Bountouris" symptom (login fails,
  //  register says "exists", password reset bypasses). The initial restore
  //  listener above only runs once; this one stays subscribed for the app
  //  lifetime. Triggers ONLY when the auth state genuinely changes (not on
  //  every page load) and only when we're past the bootstrap window.
  // ═════════════════════════════════════════════════════════════════════════
  let _bootstrapDone = false;
  // Give the autoLogin path 3.5s to do its thing before we start patrolling.
  setTimeout(() => { _bootstrapDone = true; }, 3500);
  onAuthStateChanged(auth, async (user) => {
    if (!_bootstrapDone) return;
    if (!user) return;  // signed out — nothing to validate
    // CRITICAL: this validator was written for the CUSTOMER site (main.js
    // mounts state.foundCustomer.id when a customer doc is bound to the
    // session). The TABLET kiosk has no foundCustomer — its session is the
    // cashier's admin login, not a customer record. Without this guard the
    // validator fires signOut() ~4.7s after every tablet login (3.5s
    // bootstrap + 1.2s probe), creating the "phantom logout" loop where the
    // cashier sees the idle screen briefly then gets bounced back to login
    // with no error. This was the real root cause of the iPear hotfix loop,
    // not App Check / rules / persistence (those were red herrings).
    if (_isTabletPath) return;
    // If app already mounted us against a customer doc, trust that.
    if (state.foundCustomer?.id) return;
    // We are signed in to Firebase Auth but no customer doc is bound to the
    // session. Give the legitimate login path a beat to bind, then probe.
    await new Promise(r => setTimeout(r, 1200));
    if (state.foundCustomer?.id) return;
    tagLog('AUTH-VALIDATOR', `⚠️ orphan auth detected — uid=${user.uid} email=${user.email}, no customer doc bound. Signing out to force clean re-login.`);
    try { await signOut(auth); } catch(_) {}
    try {
      ['ipear_rem', 'ipear_customer_cache', 'ipear_offline_card'].forEach(k => localStorage.removeItem(k));
    } catch(_) {}
    // Don't hard-reload — let the natural login flow surface. If the user
    // truly has no doc, they'll see "Δεν βρέθηκε λογαριασμός" and can
    // register fresh. If a doc exists with a different uid binding, the
    // login path's migration logic will repair it on the next sign-in.
  });

  window._firebaseReady = true;
  window.dispatchEvent(new Event('firebase-ready'));
}
