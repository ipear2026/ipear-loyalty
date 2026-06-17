import { logger } from './logger.js';
import { state } from './state.js';
import { showToast, _trackEvent, _WORKER_URL } from './utils.js';
import { _t } from './i18n.js';
import { _showPushOnboarding } from './push-notifications.js';
// Q-2 fix: static import for synchronous cleanup on logout. Circular import
// is safe here because logout() runs long after both modules have loaded.
import { _forceCleanup, _cancelActiveRedemption, switchTab } from './main.js';

// ════════════════════════════════════════
//  AUTH STATE
// ════════════════════════════════════════
let _regData = null;
let _confirmResult = null;
let _otpResendTimer = null;
let _brevoOtpMode = false;
export const _REM_KEY = 'ipear_rem';
const _CACHE_KEY = 'ipear_customer_cache';

function _getCachedCustomer(email) {
  try {
    const c = JSON.parse(localStorage.getItem(_CACHE_KEY));
    return (c && c.email === email && !c.blocked) ? c : null;
  } catch { return null; }
}

// ════════════════════════════════════════
//  SCREEN SWITCHING
// ════════════════════════════════════════
export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id === 's-app') {
    requestAnimationFrame(() => {
      const nav = document.querySelector('.bottom-nav');
      if (nav) { nav.style.display = 'none'; nav.offsetHeight; nav.style.display = ''; }
    });
  }
}

// ════════════════════════════════════════
//  SPLASH SCREEN (Login -> App transition)
// ════════════════════════════════════════
let _splashStart = 0;
let _splashDataReady = false;
const _SPLASH_MIN_MS  = 2800;
const _SPLASH_MAX_MS  = 5500;

function _showSplash() {
  _splashStart = Date.now();
  _splashDataReady = false;
  document.getElementById('loading').style.display = 'none';
  const el = document.getElementById('splash-screen');
  el.classList.remove('fade-out');
  el.classList.add('active');
  el.querySelectorAll('.splash-item').forEach(it => it.classList.remove('burst','landed'));
  const fill = document.getElementById('splash-fill');
  fill.style.transition = 'none';
  fill.style.width = '0%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fill.style.transition = '';
    fill.style.width = '100%';
    el.querySelectorAll('.splash-item').forEach(it => it.classList.add('burst'));
    setTimeout(() => {
      el.querySelectorAll('.splash-item.burst').forEach(it => it.classList.add('landed'));
    }, 2400);
  }));
  _spawnSparkles(el.querySelector('.splash-scene'));
  setTimeout(_hideSplash, _SPLASH_MAX_MS);
}

function _splashDone() {
  _splashDataReady = true;
  const elapsed = Date.now() - _splashStart;
  const wait = Math.max(0, _SPLASH_MIN_MS - elapsed);
  setTimeout(_hideSplash, wait);
}

function _hideSplash() {
  const el = document.getElementById('splash-screen');
  if (!el || !el.classList.contains('active') || el.classList.contains('fade-out')) return;
  document.getElementById('splash-lbl').textContent = 'Καλωσήρθες! 🍐';
  el.classList.add('fade-out');
  setTimeout(() => { el.classList.remove('active','fade-out'); }, 600);
}

function _spawnSparkles(scene) {
  if (!scene) return;
  scene.querySelectorAll('.splash-sparkle').forEach(s => s.remove());
  const colors = ['#8ae900','#6bb800','#ffe066','#ff9f43','#54a0ff'];
  for (let i = 0; i < 18; i++) {
    const sp = document.createElement('div');
    sp.className = 'splash-sparkle';
    const angle = (Math.PI * 2 * i) / 18 + (Math.random() - .5) * .4;
    const dist = 60 + Math.random() * 80;
    sp.style.cssText = 'left:50%;bottom:50px;--sx:'+Math.cos(angle)*dist+'px;--sy:'+(Math.sin(angle)*dist-40)+'px;background:'+colors[i%colors.length]+';width:'+(3+Math.random()*4)+'px;height:'+(3+Math.random()*4)+'px';
    sp.classList.add('go');
    sp.style.animationDelay = (1.1 + Math.random() * .5) + 's';
    scene.appendChild(sp);
  }
}

// ── startApp is imported lazily to avoid circular dependency ──
async function _transitionToApp() {
  _showSplash();
  showScreen('s-app');
  try {
    const { startApp } = await import('./main.js');
    await startApp();
  } catch(e) {
    logger.error('[startApp] CRASHED:', e?.message || e);
    showToast('⚠️ Σφάλμα φόρτωσης: ' + (e?.message || 'unknown'), 'red');
  }
  _splashDone();
}

// ── Loading hide: guarded so it runs only once
let _loginShown = false;
export function _showLogin() {
  if (_loginShown) return;
  _loginShown = true;
  document.getElementById('loading').style.display = 'none';
  showScreen('s-phone');
  _initCheckboxStyle();
}

// ── Referral URL auto-fill (?ref=IP-XXXXX) ──
export function setupReferralAutoFill() {
  try {
    const params = new URLSearchParams(window.location.search);
    const ref = (params.get('ref') || '').trim().toUpperCase();
    if (!ref) return;
    function _fill() {
      const el = document.getElementById('reg-ref');
      if (el) { el.value = ref; el.style.background = '#f0ffe0'; }
    }
    _fill();
    window.addEventListener('firebase-ready', () => {
      _fill();
      setTimeout(() => {
        const regRef = document.getElementById('reg-ref');
        if (regRef && !regRef.value) regRef.value = ref;
        showScreen('s-register');
      }, 300);
    });
    setTimeout(() => {
      const regRef = document.getElementById('reg-ref');
      if (regRef && !regRef.value) regRef.value = ref;
      if (!_loginShown) return;
      showScreen('s-register');
    }, 2500);
  } catch(e) { logger.warn('[referral-autofill]', e); }
}

export function _getSavedAccount() {
  try { return JSON.parse(localStorage.getItem(_REM_KEY)); } catch { return null; }
}

let _cbListenerBound = false;
export function _initCheckboxStyle() {
  const cb = document.getElementById('rem-me');
  if (!cb) return;
  if (_getSavedAccount()) {
    cb.checked = true;
    _setCheckboxStyle(true);
  }
  if (!_cbListenerBound) {
    cb.addEventListener('change', () => _setCheckboxStyle(cb.checked));
    _cbListenerBound = true;
  }
}
function _setCheckboxStyle(on) {
  document.getElementById('rem-box').style.borderColor = on ? 'var(--g)' : '#ddd';
  document.getElementById('rem-box').style.background  = on ? 'var(--gp)' : '#fff';
  document.getElementById('rem-check').style.opacity   = on ? '1' : '0';
}

export function togglePassVis() {
  const f = document.getElementById('auth-pass');
  const isPass = f.type === 'password';
  f.type = isPass ? 'text' : 'password';
  document.getElementById('eye-icon').style.opacity = isPass ? '.4' : '1';
}

// ════════════════════════════════════════
//  AUTO LOGIN (from remember-me)
// ════════════════════════════════════════
export async function autoLogin(email) {
  logger.log('%c[AUTO-LOGIN] ▶️ autoLogin CALLED with email:', 'color:#ff6600;font-weight:bold;font-size:14px', email);
  logger.log('%c[AUTO-LOGIN] auth.currentUser:', 'color:#0088ff;font-weight:bold;font-size:14px', window._auth?.currentUser ? '✅ ' + window._auth.currentUser.email : '❌ NULL');
  _loginShown = true;
  document.getElementById('loading').style.display = 'none';
  try {
    const snap = await window._getDocs(
      window._query(window._col(window._db,'ipear_customers'), window._where('email','==',email))
    );
    if (snap.empty) { logger.log('%c[AUTO-LOGIN] ❌ Firestore snap EMPTY', 'color:#ff0000;font-weight:bold;font-size:14px'); localStorage.removeItem(_REM_KEY); localStorage.removeItem(_CACHE_KEY); showScreen('s-phone'); _initCheckboxStyle(); return; }
    snap.forEach(d => { state.foundCustomer = {id:d.id,...d.data()}; });
    if (state.foundCustomer.blocked) {
      logger.log('%c[AUTO-LOGIN] ❌ Customer BLOCKED', 'color:#ff0000;font-weight:bold;font-size:14px');
      localStorage.removeItem(_REM_KEY); localStorage.removeItem(_CACHE_KEY); state.foundCustomer = null;
      showScreen('s-phone'); _initCheckboxStyle(); return;
    }
    localStorage.setItem(_CACHE_KEY, JSON.stringify(state.foundCustomer));
    const authUid = window._auth?.currentUser?.uid;
    if (authUid && state.foundCustomer.id !== authUid) {
      const { _migrateCustomerToUid } = await import('./main.js');
      try { await _migrateCustomerToUid(state.foundCustomer.id, authUid); } catch(_) {}
    }
    logger.log('%c[AUTO-LOGIN] ✅ Firestore OK → _transitionToApp()', 'color:#00cc00;font-weight:bold;font-size:16px');
    _transitionToApp();
  } catch(e) {
    logger.log('%c[AUTO-LOGIN] ⚠️ Firestore query failed:', 'color:#ff6600;font-weight:bold;font-size:14px', e?.code || e?.message || e);
    const cached = _getCachedCustomer(email);
    if (cached) {
      logger.log('%c[AUTO-LOGIN] 📦 Using CACHED customer data — loading app from cache', 'color:#00cc00;font-weight:bold;font-size:16px');
      state.foundCustomer = cached;
      _transitionToApp();
    } else {
      logger.log('%c[AUTO-LOGIN] ❌ No cache, showing login', 'color:#ff0000;font-weight:bold;font-size:14px');
      showScreen('s-phone'); _initCheckboxStyle();
    }
  }
}

// ════════════════════════════════════════
//  FORGOT PASSWORD
// ════════════════════════════════════════
export function openForgotPass() {
  const email = (document.getElementById('phone-in').value || '').trim();
  document.getElementById('forgot-email').value = email;
  document.getElementById('forgot-err').textContent = '';
  document.getElementById('forgot-ok').style.display = 'none';
  showScreen('s-forgot-pass');
}

export async function submitForgotPass() {
  const email = document.getElementById('forgot-email').value.trim().toLowerCase();
  const err = document.getElementById('forgot-err');
  const btn = document.getElementById('forgot-btn');
  err.textContent = '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    err.textContent = '⚠️ Εισάγετε έγκυρο email.'; return;
  }
  const _fpKey = '_fp_' + email;
  const _fpLast = parseInt(localStorage.getItem(_fpKey) || '0', 10);
  if (_fpLast && (Date.now() - _fpLast) < 60 * 1000) {
    const sec = Math.ceil((60 * 1000 - (Date.now() - _fpLast)) / 1000);
    err.textContent = `⏳ Δοκίμασε ξανά σε ${sec}s.`; return;
  }
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div>';
  try {
    let customerDoc = null;
    let firestoreAvailable = true;
    try {
      const snap = await window._getDocs(
        window._query(window._col(window._db,'ipear_customers'), window._where('email','==',email))
      );
      if (!snap.empty) {
        snap.forEach(d => { if (!customerDoc) customerDoc = { id: d.id, ...d.data() }; });
      }
    } catch(_) {
      firestoreAvailable = false;
    }

    if (firestoreAvailable && customerDoc === null) {
      err.textContent = '❌ Δεν βρέθηκε λογαριασμός με αυτό το email.';
      btn.disabled = false; btn.innerHTML = 'Αποστολή →';
      return;
    }

    if (firestoreAvailable && customerDoc && !customerDoc.uid) {
      err.innerHTML = '⚠️ Δεν έχεις ορίσει κωδικό ακόμα.<br><span style="font-weight:400">Κάνε <a href="#" onclick="showScreen(\'s-phone\');backToLogin();return false" style="color:var(--gd)">Σύνδεση</a> και πάτα <strong>Είσοδος →</strong> για να δημιουργήσεις κωδικό.</span>';
      btn.disabled = false; btn.innerHTML = 'Αποστολή →';
      return;
    }

    let branded = false;
    try {
      const res = await fetch(_WORKER_URL + '/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: customerDoc?.name || '' }),
      });
      const data = await res.json();
      if (res.ok && data.success) branded = true;
    } catch(_) {}

    if (!branded) {
      await window._sendPassReset(window._auth, email);
    }

    document.getElementById('forgot-ok').style.display = 'block';
    document.getElementById('forgot-email').value = '';
    localStorage.setItem(_fpKey, Date.now().toString());
  } catch(e) {
    err.textContent = '❌ ' + (e.message || e.code || 'Σφάλμα. Δοκίμασε ξανά.');
  }
  btn.disabled = false; btn.innerHTML = 'Αποστολή →';
}

export function backToLogin() {
  document.getElementById('auth-step1').style.display = '';
  document.getElementById('auth-step2').style.display = 'none';
  document.getElementById('auth-pass').value = '';
  document.getElementById('phone-err').textContent = '';
}

// ════════════════════════════════════════
//  SELF-REGISTRATION
// ════════════════════════════════════════
export function openRegister() {
  ['reg-name','reg-phone','reg-email','reg-pass1','reg-pass2','reg-ref'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  ['reg-bday-d','reg-bday-m','reg-bday-y'].forEach(id => { const el=document.getElementById(id); if(el) el.selectedIndex=0; });
  ['reg-terms','reg-marketing'].forEach(id => { const el=document.getElementById(id); if(el) el.checked=false; });
  document.getElementById('reg-err').innerHTML = '';
  showScreen('s-register');
}

async function _finishRegistration(authUser, { name, phone, email, card, birthday, refCode, marketingOptIn }) {
  const firebaseUID = authUser?.uid || null;
  // CRITICAL-2: customer CANNOT self-credit any signup bonus. The Firestore
  // rule enforces points==0 && totalPoints==0 on Path A creates. Server-side
  // workers award the bonuses after verification:
  //   - /send-welcome credits +50 marketing bonus (idToken-authenticated)
  //   - /process-referral credits +100 referral bonus (to both parties)
  const customerDocId = firebaseUID;
  const _now = new Date().toISOString();
  try {
    await window._setDoc(window._doc(window._db,'ipear_customers', customerDocId), {
      name, phone, email, card,
      uid: firebaseUID || '',
      points: 0, totalPoints: 0,
      birthday: birthday || '',
      referredBy: refCode || '',
      blocked: false,
      referralProcessed: false,
      referralCount: 0,
      fcmToken: '',
      marketingOptIn: !!marketingOptIn,
      marketingOptInAt: marketingOptIn ? _now : '',
      termsAcceptedAt: _now,
      createdAt: _now
    });
  } catch(fsErr) {
    if (authUser && window._deleteAuthUser) {
      try { await window._deleteAuthUser(authUser); } catch(_) {}
    }
    throw fsErr;
  }

  if (refCode) {
    (async () => {
      try {
        await window._setDoc(window._doc(window._db,'ipear_referral_queue', firebaseUID), {
          newCustomerId:   customerDocId,
          newCustomerUid:  firebaseUID || '',
          newCustomerEmail: email || '',
          newCustomerCard: card,
          newCustomerName: name,
          referrerCard:    refCode,
          processed:       false,
          createdAt:       new Date().toISOString()
        });
        const idToken = await authUser.getIdToken(true);
        fetch(_WORKER_URL + '/process-referral', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken })
        }).then(r => r.json()).then(d => {
          if (!d.ok) logger.warn('[referral] worker error:', d.error || 'unknown');
          if (d.reason === 'referral-limit-reached') {
            if (state.foundCustomer) {
              state.foundCustomer.points = Math.max(0, (state.foundCustomer.points || 0) - 100);
              state.foundCustomer.totalPoints = Math.max(0, (state.foundCustomer.totalPoints || 0) - 100);
            }
            import('./main.js').then(m => m._refreshPointsUI());
            showToast('⚠️ Ο κωδικός παραπομπής έχει φτάσει το όριο χρήσεων.', 'red');
          } else {
            import('./ui-renderers.js').then(m => { if (typeof m.loadHistory === 'function') setTimeout(m.loadHistory, 500); });
          }
        }).catch(e => logger.warn('[referral] worker call failed:', e.message));
      } catch(e) { logger.warn('[referral] queue/worker error:', e.message); }
    })();
  }

  // Local mirror starts at 0; the worker will increment via Firestore and the
  // app's snapshot listener picks up the new balance for the UI.
  state.foundCustomer = { id: customerDocId, name, phone, email, card, uid: firebaseUID, points: 0, totalPoints: 0, birthday, fcmToken: '', referralCount: 0 };
  localStorage.setItem(_REM_KEY, JSON.stringify({ email, name }));
  ['reg-name','reg-phone','reg-email','reg-pass1','reg-pass2','reg-bday-d','reg-bday-m','reg-bday-y','reg-ref'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });

  // HIGH-4: /send-welcome now requires a verified Firebase idToken. The worker
  // derives email + UID from the token; mismatched body fields are rejected.
  // We still send the name (no token claim for it) and the marketing flag
  // (consent). The +50 marketing bonus is credited atomically by the worker.
  (async () => {
    try {
      const idToken = await authUser.getIdToken(true);
      const res = await fetch(_WORKER_URL + '/send-welcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, name, marketingOptIn: !!marketingOptIn }),
      });
      if (!res.ok) logger.warn('[welcome] failed:', res.status);
    } catch (e) {
      logger.warn('[welcome] error:', e.message);
    }
  })();

  _transitionToApp();
  showToast('✅ Καλωσήρθες στο iPear Loyalty! 🍐', 'green');
  if (marketingOptIn) setTimeout(() => showToast('🎁 Marketing bonus: +50 πόντοι! 🎉', 'green'), 1200);
  if (refCode) setTimeout(() => showToast('🎁 Referral bonus: +100 πόντοι για εσένα! 🎉', 'green'), marketingOptIn ? 3000 : 1800);

  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(_showPushOnboarding, 3500);
  }
}

export async function submitRegister() {
  const name  = document.getElementById('reg-name').value.trim();
  const phone = document.getElementById('reg-phone').value.replace(/[\s\-()]/g,'');
  const email = document.getElementById('reg-email').value.trim().toLowerCase();
  const p1    = document.getElementById('reg-pass1').value;
  const p2    = document.getElementById('reg-pass2').value;
  const err   = document.getElementById('reg-err');
  const btn   = document.getElementById('reg-btn');
  err.innerHTML = '';

  if (!window._createUser || !window._db) {
    err.textContent = '⚠️ Η εφαρμογή δεν φόρτωσε σωστά. Αν χρησιμοποιείτε ad-blocker, απενεργοποιήστε τον για αυτή τη σελίδα.';
    return;
  }
  if (!name)  { err.textContent = '⚠️ Εισάγετε ονοματεπώνυμο.'; return; }
  if (!phone || !/^6\d{9}$/.test(phone)) { err.textContent = '⚠️ Εισάγετε έγκυρο ελληνικό κινητό (π.χ. 6912345678).'; return; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = '⚠️ Εισάγετε έγκυρο email.'; return; }
  if (p1.length < 6) { err.textContent = '⚠️ Ο κωδικός πρέπει να έχει τουλάχιστον 6 χαρακτήρες.'; return; }
  if (p1 !== p2) { err.textContent = '❌ Οι κωδικοί δεν ταιριάζουν.'; return; }
  if (!document.getElementById('reg-terms')?.checked) { err.textContent = '⚠️ Πρέπει να αποδεχτείτε τους Όρους Χρήσης και την Πολιτική Απορρήτου.'; return; }
  const marketingOptIn = !!document.getElementById('reg-marketing')?.checked;

  const bd = document.getElementById('reg-bday-d')?.value || '';
  const bm = document.getElementById('reg-bday-m')?.value || '';
  const by = document.getElementById('reg-bday-y')?.value || '';
  const birthday = (bd && bm && by) ? `${by}-${bm.padStart(2,'0')}-${bd.padStart(2,'0')}` : '';
  const refCode  = (document.getElementById('reg-ref')?.value || '').trim().toUpperCase();

  btn.disabled = true; btn.innerHTML = '<div class="spin"></div>';

  if (window.DEMO) {
    try {
      if (window._setPersistenceMode) await window._setPersistenceMode('local');
      const authResult = await window._createUser(window._auth, email, p1);
      const authUser = authResult?.user || null;
      const card = 'IP-' + (authUser?.uid || Date.now().toString()).slice(-6).toUpperCase();
      await _finishRegistration(authUser, { name, phone, email, card, birthday, refCode, marketingOptIn });
    } catch(e) {
      err.textContent = '❌ ' + (e.message || e.code || 'Σφάλμα εγγραφής.');
    }
    btn.disabled = false; btn.innerHTML = 'Εγγραφή →';
    return;
  }

  try {
    const _smsPhoneKey = '_sms_p_' + phone;
    const _smsGlobalKey = '_sms_g';
    const _now = Date.now();
    const _lastForPhone = parseInt(localStorage.getItem(_smsPhoneKey) || '0', 10);
    if (_lastForPhone && (_now - _lastForPhone) < 5 * 60 * 1000) {
      const _remSec = Math.ceil((5 * 60 * 1000 - (_now - _lastForPhone)) / 1000);
      const _m = Math.floor(_remSec / 60), _s = _remSec % 60;
      err.textContent = `⏳ Έχεις ήδη λάβει SMS στον ${phone}. Δοκίμασε ξανά σε ${_m > 0 ? _m + 'λ ' : ''}${_s}δ.`;
      btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
    }
    const _globalLog = JSON.parse(localStorage.getItem(_smsGlobalKey) || '[]').filter(t => _now - t < 60 * 60 * 1000);
    if (_globalLog.length >= 3) {
      err.textContent = '🔴 Πολλές προσπάθειες από αυτή τη συσκευή. Δοκίμασε σε 1 ώρα.';
      btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
    }

    try {
      const _checkUrl = _WORKER_URL + '/check-registration';
      const _checkRes = await fetch(_checkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, phone })
      });
      if (_checkRes.ok) {
        const _checkData = await _checkRes.json();
        if (_checkData.blocked) {
          err.textContent = '🚫 Ο λογαριασμός σας έχει αποκλειστεί. Επικοινωνήστε με το κατάστημα.';
          btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
        }
        if (_checkData.exists) {
          err.textContent = '⚠️ Υπάρχει ήδη λογαριασμός με αυτά τα στοιχεία. Δοκίμασε σύνδεση.';
          btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
        }
      } else if (_checkRes.status === 429) {
        err.textContent = '🔴 Πολλές προσπάθειες. Δοκίμασε σε λίγα λεπτά.';
        btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
      } else if (_checkRes.status === 503) {
        err.textContent = '🔴 Προσωρινό πρόβλημα διακομιστή. Δοκίμασε σε λίγα λεπτά.';
        btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
      } else if (_checkRes.status >= 400 && _checkRes.status < 500) {
        err.textContent = '⚠️ Έλεγξε τα στοιχεία σου και δοκίμασε ξανά.';
        btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
      }
    } catch(_checkErr) {}

    _regData = { name, phone, email, password: p1, birthday, refCode, marketingOptIn };

    btn.innerHTML = '<div class="spin"></div> Αποστολή SMS…';
    const _otpRes = await fetch(_WORKER_URL + '/send-sms-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const _otpData = await _otpRes.json();
    if (!_otpRes.ok) throw new Error(_otpData.error || 'Αποτυχία αποστολής SMS');

    _brevoOtpMode = true;
    localStorage.setItem(_smsPhoneKey, _now.toString());
    localStorage.setItem(_smsGlobalKey, JSON.stringify([..._globalLog, _now]));

    document.getElementById('otp-phone-display').textContent = phone;
    document.getElementById('otp-input').value = '';
    document.getElementById('otp-err').textContent = '';
    _startOTPResendTimer(60);
    showScreen('s-otp');
    setTimeout(() => document.getElementById('otp-input').focus(), 300);

  } catch(e) {
    logger.error('[register] ❌ SMS error:', e.message, e);
    err.textContent = '❌ ' + (e.message || 'Σφάλμα αποστολής SMS. Δοκίμασε ξανά.');
  }
  btn.disabled = false; btn.innerHTML = 'Εγγραφή →';
}

function _startOTPResendTimer(secs) {
  const timerEl  = document.getElementById('otp-resend-timer');
  const resendEl = document.getElementById('otp-resend-btn');
  if (resendEl) resendEl.style.display = 'none';
  let remaining = secs;
  if (timerEl) timerEl.textContent = `Επανάληψη σε ${remaining}s`;
  if (_otpResendTimer) clearInterval(_otpResendTimer);
  _otpResendTimer = setInterval(() => {
    remaining--;
    if (timerEl) timerEl.textContent = `Επανάληψη σε ${remaining}s`;
    if (remaining <= 0) {
      clearInterval(_otpResendTimer); _otpResendTimer = null;
      if (timerEl) timerEl.textContent = '';
      if (resendEl) resendEl.style.display = 'inline';
    }
  }, 1000);
}

export async function submitOTP() {
  const code = (document.getElementById('otp-input').value || '').trim();
  const err  = document.getElementById('otp-err');
  const btn  = document.getElementById('otp-btn');
  err.textContent = '';

  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    err.textContent = '⚠️ Εισάγετε τον 6ψήφιο κωδικό.'; return;
  }

  if (_brevoOtpMode && _regData) {
    btn.disabled = true; btn.innerHTML = '<div class="spin"></div>';
    try {
      const vRes = await fetch(_WORKER_URL + '/verify-sms-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // email passed so the worker can clean up orphan Auth users left over
        // from prior admin deletions (no Firestore record, but Auth still locked).
        body: JSON.stringify({ phone: _regData.phone, code, email: _regData.email }),
      });
      const vData = await vRes.json();
      if (!vRes.ok) throw new Error(vData.error || 'Λάθος κωδικός');

      if (window._setPersistenceMode) await window._setPersistenceMode('local');
      const authResult = await window._createUser(window._auth, _regData.email, _regData.password);
      const authUser = authResult?.user || null;
      if (!authUser) throw new Error('Αποτυχία δημιουργίας λογαριασμού');

      window._sendEmailVerif(authUser).catch(() => {});

      const card = 'IP-' + authUser.uid.slice(-6).toUpperCase();
      await _finishRegistration(authUser, {
        name:     _regData.name,
        phone:    _regData.phone,
        email:    _regData.email,
        card,
        birthday: _regData.birthday,
        refCode:  _regData.refCode,
        marketingOptIn: _regData.marketingOptIn,
      });

      if (_otpResendTimer) { clearInterval(_otpResendTimer); _otpResendTimer = null; }
      _regData = null; _confirmResult = null; _brevoOtpMode = false;
      return;

    } catch(e) {
      logger.error('[brevo-otp] verify error:', e.code || '', e.message);
      if (e.code === 'auth/email-already-in-use') {
        err.textContent = '❌ Υπάρχει ήδη λογαριασμός με αυτό το email. Χρησιμοποίησε την Είσοδο.';
      } else {
        err.textContent = '❌ ' + (e.message || 'Σφάλμα επαλήθευσης');
      }
      btn.disabled = false; btn.innerHTML = 'Επαλήθευση →';
      return;
    }
  }

  if (!_confirmResult || !_regData) {
    err.textContent = '❌ Λήξη συνεδρίας. Επιστρέψτε και ξαναδοκιμάστε.'; return;
  }

  btn.disabled = true; btn.innerHTML = '<div class="spin"></div>';
  try {
    if (window._setPersistenceMode) await window._setPersistenceMode('local');
    const result = await _confirmResult.confirm(code);
    const phoneUser = result.user;

    const uidSnap = await window._getDocs(
      window._query(window._col(window._db,'ipear_customers'), window._where('uid','==',phoneUser.uid))
    );
    if (!uidSnap.empty) {
      err.textContent = '⚠️ Αυτό το κινητό είναι ήδη εγγεγραμμένο. Χρησιμοποίησε την Είσοδο.';
      btn.disabled = false; btn.innerHTML = 'Επαλήθευση →';
      return;
    }

    const emailCred = window._emailCredential(_regData.email, _regData.password);
    const linkedResult = await window._linkCredential(phoneUser, emailCred);
    const linkedUser = linkedResult?.user || phoneUser;
    await linkedUser.getIdToken(true);
    window._sendEmailVerif(linkedUser).catch(() => {});

    const card = 'IP-' + linkedUser.uid.slice(-6).toUpperCase();
    await _finishRegistration(linkedUser, {
      name:     _regData.name,
      phone:    _regData.phone,
      email:    _regData.email,
      card,
      birthday: _regData.birthday,
      refCode:  _regData.refCode,
      marketingOptIn: _regData.marketingOptIn,
    });

    if (_otpResendTimer) { clearInterval(_otpResendTimer); _otpResendTimer = null; }
    _regData = null; _confirmResult = null;

  } catch(e) {
    if (e.code === 'auth/email-already-in-use') {
      try {
        const orphanPhoneUser = window._auth?.currentUser;
        if (orphanPhoneUser) await window._deleteAuthUser(orphanPhoneUser);
      } catch(_) {}
      try {
        const emailResult = await window._signIn(window._auth, _regData.email, _regData.password);
        const emailUser = emailResult?.user || emailResult;
        const existSnap = await window._getDocs(
          window._query(window._col(window._db,'ipear_customers'), window._where('uid','==',emailUser.uid))
        );
        if (!existSnap.empty) {
          await window._signOut();
          err.textContent = '❌ Υπάρχει ήδη λογαριασμός με αυτό το email. Χρησιμοποίησε την Είσοδο.';
          btn.disabled = false; btn.innerHTML = 'Επαλήθευση →';
          return;
        }
        const card2 = 'IP-' + emailUser.uid.slice(-6).toUpperCase();
        await _finishRegistration(emailUser, {
          name: _regData.name, phone: _regData.phone,
          email: _regData.email, card: card2,
          birthday: _regData.birthday, refCode: _regData.refCode,
          marketingOptIn: _regData.marketingOptIn,
        });
        if (_otpResendTimer) { clearInterval(_otpResendTimer); _otpResendTimer = null; }
        _regData = null; _confirmResult = null;
        return;
      } catch(innerE) {
        const wrongPass = ['auth/wrong-password','auth/invalid-credential','auth/invalid-login-credentials'];
        if (wrongPass.includes(innerE.code)) {
          err.textContent = '❌ Υπάρχει ήδη λογαριασμός με αυτό το email. Χρησιμοποίησε την Είσοδο.';
        } else {
          err.textContent = '❌ ' + (innerE.message || innerE.code || 'Σφάλμα εγγραφής.');
        }
        btn.disabled = false; btn.innerHTML = 'Επαλήθευση →';
        return;
      }
    }
    const msgs = {
      'auth/invalid-verification-code': '❌ Λάθος κωδικός. Ξαναδοκίμασε.',
      'auth/code-expired':              '❌ Ο κωδικός έληξε. Πάτα "Επανάληψη SMS".',
      'auth/too-many-requests':         '🔴 Πολλές αποτυχημένες προσπάθειες. Δοκίμασε αργότερα.',
      'auth/network-request-failed':    '🔴 Πρόβλημα δικτύου.',
    };
    try { if (window._auth?.currentUser) await window._signOut(); } catch(_) {}
    err.textContent = msgs[e.code] || ('❌ ' + (e.message || e.code || 'Σφάλμα επαλήθευσης.'));
    btn.disabled = false; btn.innerHTML = 'Επαλήθευση →';
  }
}

export async function resendOTP() {
  if (!_regData) { showScreen('s-register'); return; }
  const err = document.getElementById('otp-err');
  err.textContent = '';
  document.getElementById('otp-resend-btn').style.display = 'none';

  const _smsGlobalKey = '_sms_g';
  const _now2 = Date.now();
  const _globalLog2 = JSON.parse(localStorage.getItem(_smsGlobalKey) || '[]').filter(t => _now2 - t < 60 * 60 * 1000);
  if (_globalLog2.length >= 3) {
    err.textContent = '🔴 Πολλές προσπάθειες από αυτή τη συσκευή. Δοκίμασε σε 1 ώρα.';
    document.getElementById('otp-resend-btn').style.display = 'inline';
    return;
  }

  try {
    const res = await fetch(_WORKER_URL + '/send-sms-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: _regData.phone }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Αποτυχία αποστολής');

    _brevoOtpMode = true;
    localStorage.setItem('_sms_p_' + _regData.phone, _now2.toString());
    localStorage.setItem(_smsGlobalKey, JSON.stringify([..._globalLog2, _now2]));
    _startOTPResendTimer(60);
    showToast('📱 Νέο SMS εστάλη!', 'green');
  } catch(e) {
    logger.error('[resendOTP] ❌ error:', e.message);
    err.textContent = '❌ ' + (e.message || 'Αποτυχία αποστολής SMS. Δοκίμασε ξανά.');
    document.getElementById('otp-resend-btn').style.display = 'inline';
  }
}

export function cancelOTP() {
  if (_otpResendTimer) { clearInterval(_otpResendTimer); _otpResendTimer = null; }
  _confirmResult = null;
  _brevoOtpMode = false;
  if (_regData?.phone) {
    try { localStorage.removeItem('_sms_p_' + _regData.phone); } catch(_) {}
  }
  try { if (window._auth?.currentUser) window._signOut(); } catch(_) {}
  showScreen('s-register');
}

// ════════════════════════════════════════
//  EMAIL + PASSWORD LOGIN
// ════════════════════════════════════════
export async function submitPhone() {
  const email = document.getElementById('phone-in').value.trim().toLowerCase();
  const pass  = document.getElementById('auth-pass').value;
  const err   = document.getElementById('phone-err');
  err.textContent = '';
  if (!email || !email.includes('@')) { err.textContent = '⚠️ Εισάγετε έγκυρο email.'; return; }
  if (!pass) { err.textContent = '⚠️ Εισάγετε τον κωδικό σας.'; document.getElementById('auth-pass').focus(); return; }
  if (!window._signIn || !window._db) {
    err.textContent = '⚠️ Η εφαρμογή δεν φόρτωσε σωστά. Αν χρησιμοποιείτε ad-blocker, απενεργοποιήστε τον για αυτή τη σελίδα και ανανεώστε.';
    return;
  }
  const btn = document.getElementById('phone-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div>';
  try {
    const remCb = document.getElementById('rem-me');
    logger.log('%c[LOGIN] CHECKBOX ELEMENT:', 'color:#ff00ff;font-weight:bold;font-size:14px', remCb);
    logger.log('%c[LOGIN] CHECKBOX VALUE IS:', 'color:#ff00ff;font-weight:bold;font-size:14px', remCb?.checked);
    if (window._setPersistenceMode) {
      logger.log('%c[LOGIN] Calling _setPersistenceMode with:', 'color:#ff6600;font-weight:bold;font-size:14px', remCb?.checked ? 'LOCAL 👑' : 'SESSION ⏳');
      await window._setPersistenceMode(remCb?.checked ? 'local' : 'session');
    } else {
      logger.log('%c[LOGIN] ⚠️ window._setPersistenceMode IS MISSING!', 'color:#ff0000;font-weight:bold;font-size:16px');
    }
    const authResult = await window._signIn(window._auth, email, pass);
    const firebaseUID = authResult?.user?.uid || authResult?.uid || null;

    const snap = await window._getDocs(
      window._query(window._col(window._db,'ipear_customers'), window._where('email','==',email))
    );
    if (snap.empty) { err.textContent = '❌ Δεν βρέθηκε loyalty λογαριασμός για αυτό το email.'; btn.disabled=false; btn.innerHTML='Είσοδος →'; return; }
    snap.forEach(d => { state.foundCustomer = {id:d.id,...d.data()}; });

    if (state.foundCustomer.blocked) {
      await window._signOut(window._auth).catch(()=>{});
      state.foundCustomer = null;
      err.textContent = '🚫 Ο λογαριασμός σας έχει απενεργοποιηθεί. Επικοινωνήστε με το κατάστημα iPear.';
      btn.disabled=false; btn.innerHTML='Είσοδος →'; return;
    }

    if (firebaseUID && state.foundCustomer.id !== firebaseUID) {
      const { _migrateCustomerToUid } = await import('./main.js');
      try { await _migrateCustomerToUid(state.foundCustomer.id, firebaseUID); } catch(_) {}
    } else if (firebaseUID && state.foundCustomer.uid !== firebaseUID) {
      try {
        await window._updateDoc(window._doc(window._db,'ipear_customers',state.foundCustomer.id), {uid: firebaseUID});
        state.foundCustomer.uid = firebaseUID;
      } catch(_) {}
    }

    localStorage.setItem(_CACHE_KEY, JSON.stringify(state.foundCustomer));
    if (remCb?.checked) {
      localStorage.setItem(_REM_KEY, JSON.stringify({email: state.foundCustomer.email||email, name: state.foundCustomer.name}));
      logger.log('%c[LOGIN] ✅ Saved _REM_KEY + cache to localStorage', 'color:#00cc00;font-weight:bold;font-size:14px');
    } else {
      localStorage.removeItem(_REM_KEY); localStorage.removeItem(_CACHE_KEY);
      logger.log('%c[LOGIN] ❌ Removed _REM_KEY (checkbox unchecked)', 'color:#ff0000;font-weight:bold;font-size:14px');
    }
    logger.log('%c[LOGIN] auth.currentUser after signIn:', 'color:#0088ff;font-weight:bold;font-size:14px', window._auth?.currentUser?.email || 'NULL');

    document.getElementById('auth-pass').value = '';
    _transitionToApp();
  } catch(e) {
    const isNotFound    = e.code === 'auth/user-not-found';
    const isWrong       = e.code === 'auth/wrong-password';
    const isInvalidCred = e.code === 'auth/invalid-credential' || e.code === 'auth/invalid-login-credentials';
    if (isNotFound || isInvalidCred) {
      try {
        const checkRes = await fetch(_WORKER_URL + '/check-registration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        if (checkRes.ok) {
          const d = await checkRes.json();
          if (d.exists && !d.blocked) {
            if (isInvalidCred) {
              err.textContent = '❌ Λάθος κωδικός.';
              btn.disabled=false; btn.innerHTML='Είσοδος →'; return;
            }
            state.foundCustomer = { email, id: null, name: '' };
            document.getElementById('auth-step2-sub').textContent = 'Ορίσε τον κωδικό σου για πρώτη σύνδεση.';
            document.getElementById('auth-step1').style.display = 'none';
            document.getElementById('auth-step2').style.display = '';
            document.getElementById('auth-step2-err').textContent = '';
            document.getElementById('auth-newpass1').focus();
            btn.disabled=false; btn.innerHTML='Είσοδος →'; return;
          }
        }
      } catch(_) {}
      err.textContent = '❌ Δεν βρέθηκε λογαριασμός με αυτό το email.';
    } else if (isWrong) {
      err.textContent = '❌ Λάθος κωδικός.';
    } else {
      err.textContent = '❌ ' + (e.message || e.code || 'Σφάλμα σύνδεσης.');
    }
  }
  btn.disabled = false; btn.innerHTML = 'Είσοδος →';
}

export async function submitCreatePass() {
  const p1  = document.getElementById('auth-newpass1').value;
  const p2  = document.getElementById('auth-newpass2').value;
  const err = document.getElementById('auth-step2-err');
  const email = document.getElementById('phone-in').value.trim().toLowerCase();
  err.textContent = '';
  if (p1.length < 6) { err.textContent = '⚠️ Ο κωδικός πρέπει να έχει τουλάχιστον 6 χαρακτήρες.'; return; }
  if (p1 !== p2) { err.textContent = '❌ Οι κωδικοί δεν ταιριάζουν.'; return; }
  try {
    const remCb = document.getElementById('rem-me');
    logger.log('%c[CREATE-PASS] CHECKBOX ELEMENT:', 'color:#ff00ff;font-weight:bold;font-size:14px', remCb);
    logger.log('%c[CREATE-PASS] CHECKBOX VALUE IS:', 'color:#ff00ff;font-weight:bold;font-size:14px', remCb?.checked);
    if (window._setPersistenceMode) {
      logger.log('%c[CREATE-PASS] Calling _setPersistenceMode with:', 'color:#ff6600;font-weight:bold;font-size:14px', remCb?.checked ? 'LOCAL 👑' : 'SESSION ⏳');
      await window._setPersistenceMode(remCb?.checked ? 'local' : 'session');
    } else {
      logger.log('%c[CREATE-PASS] ⚠️ window._setPersistenceMode IS MISSING!', 'color:#ff0000;font-weight:bold;font-size:16px');
    }
    const authResult = await window._createUser(window._auth, email, p1);
    const firebaseUID = authResult?.user?.uid || authResult?.uid || null;
    if (firebaseUID && state.foundCustomer?.id && state.foundCustomer.id !== firebaseUID) {
      const { _migrateCustomerToUid } = await import('./main.js');
      try { await _migrateCustomerToUid(state.foundCustomer.id, firebaseUID); } catch(_) {}
    } else if (firebaseUID && state.foundCustomer?.id) {
      try {
        await window._updateDoc(window._doc(window._db,'ipear_customers',state.foundCustomer.id), {uid: firebaseUID});
        state.foundCustomer.uid = firebaseUID;
      } catch(_) {}
    }
    localStorage.setItem(_CACHE_KEY, JSON.stringify(state.foundCustomer));
    if (remCb?.checked) {
      localStorage.setItem(_REM_KEY, JSON.stringify({email: state.foundCustomer.email||email, name: state.foundCustomer.name}));
      logger.log('%c[CREATE-PASS] ✅ Saved _REM_KEY + cache', 'color:#00cc00;font-weight:bold;font-size:14px');
    } else {
      logger.log('%c[CREATE-PASS] ❌ _REM_KEY NOT saved (checkbox unchecked)', 'color:#ff0000;font-weight:bold;font-size:14px');
    }
    logger.log('%c[CREATE-PASS] auth.currentUser after createUser:', 'color:#0088ff;font-weight:bold;font-size:14px', window._auth?.currentUser?.email || 'NULL');
    document.getElementById('auth-newpass1').value = '';
    document.getElementById('auth-newpass2').value = '';
    backToLogin();
    _transitionToApp();
  } catch(e) {
    const msgs = {'auth/email-already-in-use':'Υπάρχει ήδη λογαριασμός με αυτό το email. Χρησιμοποίησε την Είσοδο.','auth/weak-password':'Ο κωδικός είναι πολύ αδύναμος.'};
    err.textContent = '❌ ' + (msgs[e.code] || e.message || e.code);
  }
}

export function goToPhone() {
  logger.log('%c[AUTH] 🔙 goToPhone() CALLED — removing _REM_KEY + signOut', 'color:#ff0000;font-weight:bold;font-size:14px');
  state.foundCustomer = null;
  localStorage.removeItem(_REM_KEY); localStorage.removeItem(_CACHE_KEY);
  document.getElementById('phone-in').value = '';
  document.getElementById('auth-pass').value = '';
  document.getElementById('phone-err').textContent = '';
  backToLogin();
  try { window._signOut(window._auth)?.catch(()=>{}); } catch(_) {}
  showScreen('s-phone');
  _initCheckboxStyle();
}

// ════════════════════════════════════════
//  LOGOUT
// ════════════════════════════════════════
export function logout() {
  logger.log('%c[AUTH] 🚪 logout() CALLED', 'color:#ff0000;font-weight:bold;font-size:16px');
  // Q-2 fix: synchronous cleanup BEFORE signOut so listeners can't briefly
  // fire on a half-torn-down session.
  try { _forceCleanup(); } catch(_) {}
  try { _cancelActiveRedemption('logout'); } catch(_) {}
  if (_otpResendTimer) { clearInterval(_otpResendTimer); _otpResendTimer = null; }
  _regData = null;
  _confirmResult = null;
  _brevoOtpMode = false;
  state.foundCustomer = null;
  localStorage.removeItem(_REM_KEY); localStorage.removeItem(_CACHE_KEY);
  try { localStorage.removeItem('ipear_offline_card'); } catch(_) {}
  try { localStorage.removeItem('_sms_g'); } catch(_) {}
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('_sms_p_')) localStorage.removeItem(k);
    }
  } catch(_) {}
  try { switchTab('home'); } catch(_) {}
  try { window._signOut(window._auth)?.catch(()=>{}); } catch(_) {}
  document.getElementById('phone-in').value = '';
  document.getElementById('auth-pass').value = '';
  document.getElementById('phone-err').textContent = '';
  showScreen('s-phone');
  _initCheckboxStyle();
}

// ════════════════════════════════════════
//  ACCOUNT DELETION REQUEST
// ════════════════════════════════════════
let _deletionBusy = false;
export async function requestAccountDeletion() {
  if (_deletionBusy) return;
  if (!state.foundCustomer?.id) { showToast('⚠️ Δεν βρέθηκε λογαριασμός.', 'red'); return; }
  if (!confirm('⚠️ Θέλεις σίγουρα να διαγράψεις τον λογαριασμό σου;\n\nΌλοι οι πόντοι και τα δεδομένα σου θα χαθούν ΟΡΙΣΤΙΚΑ.')) return;
  if (!confirm('ΤΕΛΙΚΗ ΕΠΙΒΕΒΑΙΩΣΗ:\nΗ διαγραφή είναι μη αναστρέψιμη. Συνέχεια;')) return;
  _deletionBusy = true;
  try {
    await window._updateDoc(window._doc(window._db, 'ipear_customers', state.foundCustomer.id), {
      deletionRequested: true,
      deletionRequestedAt: new Date().toISOString()
    });
    showToast('✅ Το αίτημα διαγραφής καταχωρήθηκε. Θα ενημερωθείς σύντομα.', 'green');
  } catch(e) {
    showToast('❌ Σφάλμα: ' + (e.message || 'Δοκίμασε ξανά.'), 'red');
  } finally {
    _deletionBusy = false;
  }
}

