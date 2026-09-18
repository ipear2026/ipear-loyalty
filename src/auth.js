import { logger } from './logger.js';
import { state } from './state.js';
import { showToast, _trackEvent, _WORKER_URL } from './utils.js';
import {
  SIGNUP_STAGE, classifySignupError, buildSignupLog, makeCorrelationId,
  classifyLoginLookupError,
} from './customer/signup-errors.js';

// Correlation id for the current signup attempt — set at submitRegister, reused
// through the OTP + finalization steps so a UI failure ties to one log line.
let _signupCid = null;

// Emit a redacted signup-failure diagnostic: console + a best-effort beacon to
// the Worker /client-error sink (already CSP-allowed). Never sends PII/secrets.
function _reportSignupFailure(stage, err, extra = {}) {
  let classified;
  try {
    classified = classifySignupError(stage, err, {
      httpStatus: extra.httpStatus,
      appCheckStatus: (typeof window !== 'undefined' ? window._appCheckStatus : '') || '',
    });
  } catch (_) {
    classified = { category: 'A-network', userMsg: 'Δεν υπάρχει σύνδεση με την υπηρεσία. Έλεγξε τη σύνδεσή σου και προσπάθησε ξανά.', code: 'classify-failed', httpStatus: 0 };
  }
  const rec = buildSignupLog(stage, classified, {
    httpStatus: extra.httpStatus,
    appCheckStatus: (typeof window !== 'undefined' ? window._appCheckStatus : '') || 'unknown',
    cid: _signupCid,
  });
  logger.error('[signup]', JSON.stringify(rec));
  try {
    const body = JSON.stringify({ type: 'signup_failure', ...rec });
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(_WORKER_URL + '/client-error', body);
    } else if (typeof fetch === 'function') {
      fetch(_WORKER_URL + '/client-error', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
    }
  } catch (_) { /* diagnostics must never break signup */ }
  return classified;
}
import { _t } from './i18n.js';
// Q-2 fix: static import for synchronous cleanup on logout. Circular import
// is safe here because logout() runs long after both modules have loaded.
import {
  _forceCleanup, _cancelActiveRedemption, switchTab,
  startApp, _migrateCustomerToUid, _refreshPointsUI,
} from './main.js';
import { loadHistory } from './ui-renderers.js';
import { findCustomerByAuth } from './services/firebase.js';

// ════════════════════════════════════════
//  AUTH STATE
// ════════════════════════════════════════
let _regData = null;
let _otpResendTimer = null;
export const _REM_KEY = 'ipear_rem';
const _CACHE_KEY = 'ipear_customer_cache';

// HIGH-2 (Pen-Test 2026-06-24): minimal cache surface for instant-paint UX.
// Pre-fix the cache stored the WHOLE customer doc in plain JSON — including
// PII (phone, email, birthday), and admin-only flags from
// HIGH-1 (suspicious, _migratedFrom). Now we persist only the 5 fields the
// splash → home transition needs, plus a schema version (_v) so old
// "polluted" caches from previous sessions get invalidated on next read.
//
// Trade-off: cache fallback (used when Firestore is unreachable during
// auto-login) now has less data. The home / card / rewards tabs still
// render correctly. Tabs that need email/phone/birthday (profile, edit)
// will refetch when the network is back, which is the existing behaviour.
const _CACHE_SCHEMA_VERSION = 2;

function _persistMinimalCache(c) {
  if (!c || !c.id) return;
  try {
    localStorage.setItem(_CACHE_KEY, JSON.stringify({
      _v: _CACHE_SCHEMA_VERSION,
      id: c.id,
      name: c.name || '',
      card: c.card || '',
      points: c.points || 0,
      tier: c.tier || '',
    }));
  } catch(_) {}
}

function _getCachedCustomer() {
  try {
    const c = JSON.parse(localStorage.getItem(_CACHE_KEY));
    if (!c) return null;
    // Schema migration: pre-v2 caches held the full polluted payload.
    // Drop them so the next Firestore lookup repopulates with the
    // whitelist-projected version from services/firebase.js.
    if (c._v !== _CACHE_SCHEMA_VERSION) {
      localStorage.removeItem(_CACHE_KEY);
      return null;
    }
    return c;
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

// ════════════════════════════════════════════════════════════════════════════
//  SPLASH SCREEN (Login → App transition) — 5-second McDonald's-style track
//
//  Fixed 5000ms duration — the deliberate reveal + status log IS the UX. The
//  5s window buys time for slow-network first-loads and reads as "we're doing
//  serious work for you" instead of "loading spinner".
//
//  Timeline (see customer.css splash section for CSS-side timings):
//    0ms    → screen fades in, box drops (CSS: boxDrop@.2s)
//    500ms  → Step 1 "Έλεγχος ασφάλειας" appears + spins
//    1400ms → Step 1 ✓, progress 33%, label swaps, Step 2 appears + spins
//    1450ms → lid pops off (CSS: lidPop@1.45s)
//    1600ms → items begin bursting (CSS: burst0…5, 1.6–2.35s staggered)
//    2400ms → Step 2 ✓, progress 66%, Step 3 appears + spins
//    3400ms → items settled, floating begins (JS: .landed toggle)
//    3400ms → Step 3 ✓, progress 100%
//    3500ms → label morphs to "🍐 Έτοιμα!" with celebration pulse
//    5000ms → fade out (600ms transition)
// ════════════════════════════════════════════════════════════════════════════
let _splashStart = 0;
let _splashHideTimer = null;
const _SPLASH_DURATION_MS = 5000;
const _SPLASH_FADE_MS     = 600;

// Choreography markers (relative to _splashStart). Numbers here are the ONLY
// truth for JS-side timing; CSS-side (customer.css splash block) is what
// draws the box/lid/burst — those files must be updated together.
const _SPLASH_STEPS = [
  { at:  500, step: 1, label: '🔐 Έλεγχος ασφάλειας…' },
  { at: 1400, step: 1, done: true, fill: 33, nextStep: 2, label: '📦 Φόρτωση δεδομένων…' },
  { at: 2400, step: 2, done: true, fill: 66, nextStep: 3, label: '🎁 Προσφορές & πόντοι…' },
  { at: 3400, step: 3, done: true, fill: 100, landed: true },
  { at: 3500, celebrate: true, label: '🍐 Έτοιμα!' },
];

function _showSplash() {
  _splashStart = Date.now();
  if (_splashHideTimer) { clearTimeout(_splashHideTimer); _splashHideTimer = null; }

  document.getElementById('loading').style.display = 'none';
  const el = document.getElementById('splash-screen');
  el.classList.remove('fade-out');
  el.classList.add('active');

  // Reset all step + item states — safe for re-entry (e.g., re-login).
  el.querySelectorAll('.splash-item').forEach(it => it.classList.remove('burst','landed'));
  el.querySelectorAll('.splash-step').forEach(s => s.classList.remove('appear','active','done'));

  const fill = document.getElementById('splash-fill');
  const lbl  = document.getElementById('splash-lbl');
  fill.style.transition = 'none';
  fill.style.width = '0%';
  lbl.classList.remove('celebrate');
  lbl.textContent = 'Σύνδεση…';

  // Kick off CSS animations (box/lid/burst) on next frame + fire the burst class.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fill.style.transition = '';
    el.querySelectorAll('.splash-item').forEach(it => it.classList.add('burst'));

    // Schedule the choreographed step reveals.
    for (const mark of _SPLASH_STEPS) {
      setTimeout(() => _splashMark(el, mark), mark.at);
    }
  }));

  _spawnSparkles(el.querySelector('.splash-scene'));

  // Hard-cap at 5s — regardless of whether data is ready or not.
  _splashHideTimer = setTimeout(_hideSplash, _SPLASH_DURATION_MS);
}

function _splashMark(root, mark) {
  if (!root || !root.classList.contains('active')) return;

  // Step-level transitions
  if (mark.step) {
    const stepEl = root.querySelector(`.splash-step[data-step="${mark.step}"]`);
    if (stepEl) {
      if (mark.done) {
        stepEl.classList.remove('active');
        stepEl.classList.add('done');
      } else {
        stepEl.classList.add('appear', 'active');
      }
    }
  }
  if (mark.nextStep) {
    const nextEl = root.querySelector(`.splash-step[data-step="${mark.nextStep}"]`);
    if (nextEl) nextEl.classList.add('appear', 'active');
  }

  // Progress + label
  if (typeof mark.fill === 'number') {
    const fill = document.getElementById('splash-fill');
    if (fill) fill.style.width = mark.fill + '%';
  }
  if (mark.label) {
    const lbl = document.getElementById('splash-lbl');
    if (lbl) lbl.textContent = mark.label;
  }
  if (mark.celebrate) {
    const lbl = document.getElementById('splash-lbl');
    if (lbl) lbl.classList.add('celebrate');
  }

  // Item landing (freezes them in float positions)
  if (mark.landed) {
    root.querySelectorAll('.splash-item.burst').forEach(it => it.classList.add('landed'));
  }
}

function _hideSplash() {
  const el = document.getElementById('splash-screen');
  if (!el || !el.classList.contains('active') || el.classList.contains('fade-out')) return;
  el.classList.add('fade-out');
  setTimeout(() => {
    el.classList.remove('active','fade-out');
    // Broadcast so deferred UI (live-points animation queued while splash
    // was up) can fire AFTER the splash is fully gone, not behind it.
    window.dispatchEvent(new Event('splash-hidden'));
  }, _SPLASH_FADE_MS);
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
    // startApp imported statically at top of module
    await startApp();
  } catch(e) {
    logger.error('[startApp] CRASHED:', e?.message || e);
    // Raw e.message is logged elsewhere; user sees clean copy.
    showToast('⚠️ Δεν φόρτωσε. Δοκίμασε ξανά', 'red');
  }
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
        _showRegisterScreenWired();
      }, 300);
    });
    setTimeout(() => {
      const regRef = document.getElementById('reg-ref');
      if (regRef && !regRef.value) regRef.value = ref;
      if (!_loginShown) return;
      _showRegisterScreenWired();
    }, 2500);
  } catch(e) { logger.warn('[referral-autofill]', e); }
}

// Shared entry helper: any code path that lands on the register screen must
// go through here so the readiness (button-state) + refCode auto-format
// listeners are attached. Before this existed, setupReferralAutoFill jumped
// straight to showScreen('s-register') and neither listener was ever bound —
// the CTA stayed green regardless of empty required fields.
function _showRegisterScreenWired() {
  _bindRegisterReadinessOnce();
  _updateRegisterButtonState();
  showScreen('s-register');
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
  _loginShown = true;
  document.getElementById('loading').style.display = 'none';
  try {
    // HIGH-1 compatibility: lookup ladder is in services/firebase.js so the
    // same logic is reused by submitPhone, and so individual read failures
    // are logged instead of swallowed silently.
    const authUid0 = window._auth?.currentUser?.uid || null;
    const lookup = await findCustomerByAuth(authUid0, email, { logger });
    state.foundCustomer = lookup.customer;
    if (!state.foundCustomer) {
      if (lookup.error) {
        // Reads failed — App Check token expiry, offline, Firestore unreachable.
        // Surface the connectivity issue and try the cached customer; do NOT
        // wipe the remember-me cache on a transient failure.
        logger.warn('[auto-login] lookup error:', lookup.error);
        const cached = _getCachedCustomer();
        if (cached) { state.foundCustomer = cached; _transitionToApp(); return; }
        const cls = classifyLoginLookupError(lookup.error);
        showToast('⚠️ ' + cls.userMsg, 'red');
        showScreen('s-phone'); _initCheckboxStyle(); return;
      }
      localStorage.removeItem(_REM_KEY); localStorage.removeItem(_CACHE_KEY); showScreen('s-phone'); _initCheckboxStyle(); return;
    }
    if (state.foundCustomer.blocked) {
      localStorage.removeItem(_REM_KEY); localStorage.removeItem(_CACHE_KEY); state.foundCustomer = null;
      showScreen('s-phone'); _initCheckboxStyle(); return;
    }
    _persistMinimalCache(state.foundCustomer);
    const authUid = window._auth?.currentUser?.uid;
    if (authUid && state.foundCustomer.id !== authUid) {
      // Fire-and-forget: UI advances on the (still-correct) legacy data while
      // migration finishes in the background. setDoc + deleteDoc are
      // idempotent, so a re-login while in-flight just retries cleanly.
      _migrateCustomerToUid(state.foundCustomer.id, authUid)
        .catch(e => logger.warn('[migrate-uid] background:', e?.code || e?.message || e));
    }
    _transitionToApp();
  } catch(e) {
    logger.warn('[auto-login] failed:', e?.code || e?.message || e);
    const cached = _getCachedCustomer();
    if (cached) {
      state.foundCustomer = cached;
      _transitionToApp();
    } else {
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
  // L2.4-A: neutral response for ANY syntactically valid email — hit or miss.
  //   • No pre-worker Firestore lookup (previously leaked account-existence
  //     and legacy-no-password state via distinct error strings).
  //   • No client fallback to window._sendPassReset — a worker outage must
  //     surface as the same neutral confirmation, not a different code path
  //     that might succeed for existing accounts and fail differently for
  //     unknowns. Worker's /reset-password already returns identical
  //     {success:true} for EMAIL_NOT_FOUND and for hits.
  //   • Bounded 30s timeout so the button can never stick spinning.
  const NEUTRAL_MSG = 'Αν υπάρχει λογαριασμός με αυτό το email, θα λάβεις οδηγίες επαναφοράς.';
  let deadline;
  try {
    const ctrl = new AbortController();
    deadline = setTimeout(() => ctrl.abort(), 30_000);
    // The client passes the app's own continueUrl so the Firebase-hosted
    // widget bounces the customer back to loyalty.ipear.gr with ?resetOk=1
    // for the return-toast handler (see _handleAuthActionReturn).
    await fetch(_WORKER_URL + '/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        continueUrl: 'https://loyalty.ipear.gr/?resetOk=1',
      }),
      signal: ctrl.signal,
    }).catch(() => { /* neutral: never leak worker/network failures */ });
  } finally {
    if (deadline) clearTimeout(deadline);
  }
  // ALWAYS show the same neutral confirmation, regardless of hit/miss/error.
  // Client-side cooldown stamped only after the dispatch so a rapid re-submit
  // gets the countdown warning; it is a UX guard, not a security control.
  const okEl = document.getElementById('forgot-ok');
  if (okEl) {
    okEl.textContent = NEUTRAL_MSG;
    okEl.style.display = 'block';
  }
  const emailEl = document.getElementById('forgot-email');
  if (emailEl) emailEl.value = '';
  localStorage.setItem(_fpKey, Date.now().toString());
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
  _bindRegisterReadinessOnce();
  _updateRegisterButtonState();
  showScreen('s-register');
}

// UX: register CTA stays visually muted until the customer has actually
// completed the mandatory fields AND accepted the terms — then it flips to
// the brand-green ready state so the "click here" signal only fires when the
// click will actually succeed. Button remains clickable throughout so
// submitRegister can still surface the specific missing-field error.
let _regReadinessBound = false;
function _bindRegisterReadinessOnce() {
  if (_regReadinessBound) return;
  const inputs = ['reg-name','reg-phone','reg-email','reg-pass1','reg-pass2'];
  inputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', _updateRegisterButtonState);
  });
  const terms = document.getElementById('reg-terms');
  if (terms) terms.addEventListener('change', _updateRegisterButtonState);

  // UX: referral field auto-formats to IP-XXXXXX as the customer types.
  // Once "IP" is on the field the dash appears on its own, non-alphanumeric
  // chars are stripped, everything is uppercased, and the input is capped at
  // 9 chars (IP- + 6). Handles paste, backspace, and mid-string edits.
  const refEl = document.getElementById('reg-ref');
  if (refEl) {
    refEl.addEventListener('input', () => {
      // Preserve caret position so mid-string edits don't jump the cursor
      // to the end (e.g. user backspaces character 5 of a full code).
      const priorLen = refEl.value.length;
      const priorSel = refEl.selectionStart ?? priorLen;

      let v = refEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (v.length >= 2 && v.startsWith('IP')) {
        v = 'IP-' + v.slice(2);
      }
      if (v.length > 9) v = v.slice(0, 9);
      refEl.value = v;

      const delta = v.length - priorLen;
      const newSel = Math.max(0, Math.min(v.length, priorSel + delta));
      try { refEl.setSelectionRange(newSel, newSel); } catch (_) {}
    });
  }

  _regReadinessBound = true;
}

function _updateRegisterButtonState() {
  const btn = document.getElementById('reg-btn');
  if (!btn) return;
  // Mirror the required-field predicates from submitRegister so the button
  // flips exactly when a submit would pass validation. Referral code, birthday
  // and marketing opt-in stay optional (marketing checkbox is a bonus, not
  // a gate).
  const name  = (document.getElementById('reg-name')?.value  || '').trim();
  const phone = (document.getElementById('reg-phone')?.value || '').replace(/[\s\-()]/g,'');
  const email = (document.getElementById('reg-email')?.value || '').trim().toLowerCase();
  const p1    = document.getElementById('reg-pass1')?.value || '';
  const p2    = document.getElementById('reg-pass2')?.value || '';
  const terms = !!document.getElementById('reg-terms')?.checked;
  const ready =
    name.length > 0 && name.length <= 100 &&
    /^6\d{9}$/.test(phone) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    p1.length >= 6 && p1 === p2 &&
    terms;
  btn.classList.toggle('is-pending', !ready);
}

// Timeout wrapper for the critical registration writes. Firestore SDK
// occasionally hangs on client-side setDoc when App Check token acquisition
// stalls or when the browser drops offline mid-request — without a hard
// deadline the OTP button spins forever and the user has no way out.
// 12s is generous enough for slow 3G but cuts off obvious hangs.
function _withDeadline(promise, ms, label) {
  let t;
  return Promise.race([
    promise.finally(() => { if (t) clearTimeout(t); }),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
    }),
  ]);
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
  // Defense-in-depth: submitRegister validates refCode up-front, but any
  // stale/legacy _regData path (or a direct future caller) must not be
  // able to smuggle a malformed code through into referredBy — the
  // Firestore rule would 403 the whole create.
  const safeRefCode = (refCode && /^IP-[A-Z0-9]{6}$/.test(refCode)) ? refCode : '';
  try {
    await _withDeadline(
      window._setDoc(window._doc(window._db,'ipear_customers', customerDocId), {
        name, phone, email, card,
        uid: firebaseUID || '',
        points: 0, totalPoints: 0,
        birthday: birthday || '',
        referredBy: safeRefCode,
        blocked: false,
        referralProcessed: false,
        referralCount: 0,
        marketingOptIn: !!marketingOptIn,
        marketingOptInAt: marketingOptIn ? _now : '',
        termsAcceptedAt: _now,
        createdAt: _now
      }),
      12000, 'Firestore customer create'
    );
  } catch(fsErr) {
    logger.error('[register] setDoc failed:', fsErr?.code || '', fsErr?.message || fsErr);
    // Roll back: delete the Auth user so the customer can retry from scratch
    // without hitting `auth/email-already-in-use`. If the rollback ITSELF
    // fails (network drop, App Check token expiry, requires-recent-login),
    // we log it as an ERROR (not warn) so it surfaces in customer reports —
    // otherwise we'd have an orphan Auth account and silent divergence.
    // Safety net: /verify-sms-otp orphan-cleanup will heal it on the next
    // registration attempt with the same email, but the log makes the
    // divergence traceable in the meantime.
    let rollbackOk = false;
    if (authUser && window._deleteAuthUser) {
      try {
        await _withDeadline(window._deleteAuthUser(authUser), 6000, 'auth rollback');
        rollbackOk = true;
      } catch(rbErr) {
        logger.error('[register] ⚠️ AUTH ROLLBACK FAILED — orphan Auth left for',
          authUser?.email || '?', ':', rbErr?.code || '', rbErr?.message || rbErr);
      }
    }
    const friendly = fsErr?.message?.startsWith('Timeout')
      ? 'Πρόβλημα σύνδεσης με τη βάση. Έλεγξε internet και δοκίμασε ξανά.'
      : (rollbackOk
          ? 'Δεν ολοκληρώθηκε η εγγραφή. Δοκίμασε ξανά σε λίγο.'
          : 'Πρόβλημα εγγραφής. Δοκίμασε ξανά — αν το πρόβλημα επιμένει, επικοινώνησε με το κατάστημα.');
    const wrapped = new Error(friendly);
    wrapped.cause = fsErr;
    throw wrapped;
  }

  if (safeRefCode) {
    (async () => {
      try {
        await window._setDoc(window._doc(window._db,'ipear_referral_queue', firebaseUID), {
          newCustomerId:   customerDocId,
          newCustomerUid:  firebaseUID || '',
          newCustomerEmail: email || '',
          newCustomerCard: card,
          newCustomerName: name,
          referrerCard:    safeRefCode,
          processed:       false,
          createdAt:       new Date().toISOString()
        });
        const idToken = await authUser.getIdToken(true);
        fetch(_WORKER_URL + '/process-referral', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken })
        }).then(r => r.json()).then(d => {
          // Silent-fail hardening: /process-referral returns HTTP 200 with
          // ok:true for BOTH the successful-credit path AND the
          // invalid-referrer / no-queue-entry termination branches. The old
          // handler only checked !d.ok, so those termination branches never
          // surfaced anything and the customer thought they got the bonus.
          if (!d.ok) {
            logger.warn('[referral] worker error:', d.error || 'unknown');
            return;
          }
          if (d.reason === 'referral-limit-reached') {
            if (state.foundCustomer) {
              state.foundCustomer.points = Math.max(0, (state.foundCustomer.points || 0) - 100);
              state.foundCustomer.totalPoints = Math.max(0, (state.foundCustomer.totalPoints || 0) - 100);
            }
            _refreshPointsUI();
            showToast('⚠️ Ο κωδικός παραπομπής έχει εξαντληθεί', 'red');
            return;
          }
          if (d.reason === 'invalid-referrer') {
            // Preflight check-referrer should have caught this, but a race
            // (referrer got deleted between preflight and here) or a
            // degraded preflight response could let it through.
            logger.warn('[referral] invalid referrer at commit time — bonus skipped');
            showToast('⚠️ Ο κωδικός παραπομπής δεν βρέθηκε — το bonus των 100 πόντων δεν πιστώθηκε', 'red');
            return;
          }
          if (d.reason === 'no-queue-entry') {
            // Retry raced ahead of the queue setDoc. Not fatal — the IIFE's
            // own subsequent call will find the queue and credit. Log for
            // visibility only.
            logger.warn('[referral] queue not yet visible on first attempt (retry race)');
            return;
          }
          if (d.reason === 'already-processed') return;
          if (typeof loadHistory === 'function') setTimeout(loadHistory, 500);
        }).catch(e => logger.warn('[referral] worker call failed:', e.message));
      } catch(e) {
        // Queue setDoc rejected (rules mismatch, App Check, network) — the
        // customer has referredBy on their doc but no queue entry, so every
        // future /process-referral will hit no-queue-entry forever. Log
        // loudly and tell the customer the +100 didn't land so support can
        // credit manually if needed.
        logger.error('[referral] queue create FAILED — bonus lost:', e?.code || '', e?.message || e);
        showToast('⚠️ Το bonus των 100 πόντων παραπομπής δεν καταχωρήθηκε — επικοινώνησε με το κατάστημα', 'red');
      }
    })();
  }

  // Local mirror starts at 0; the worker will increment via Firestore and the
  // app's snapshot listener picks up the new balance for the UI.
  state.foundCustomer = { id: customerDocId, name, phone, email, card, uid: firebaseUID, points: 0, totalPoints: 0, birthday, referralCount: 0 };
  localStorage.setItem(_REM_KEY, JSON.stringify({ email, name }));
  ['reg-name','reg-phone','reg-email','reg-pass1','reg-pass2','reg-bday-d','reg-bday-m','reg-bday-y','reg-ref'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });

  // /send-welcome — idToken-authenticated. Worker derives email + UID from
  // the token (mismatched body fields rejected) and atomically credits the
  // +50 marketing bonus if marketingOptIn is true. Idempotent via the
  // marketingWelcomeProcessed flag on the customer doc.
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
  showToast('🍐 Καλώς ήρθες στο iPear Loyalty', 'green');
  if (marketingOptIn) setTimeout(() => showToast('🎁 +50 πόντοι bonus', 'green'), 1200);
  if (safeRefCode) setTimeout(() => showToast('🎁 +100 πόντοι από παραπομπή', 'green'), marketingOptIn ? 3000 : 1800);
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
  if (name.length > 100) { err.textContent = '⚠️ Το ονοματεπώνυμο είναι πολύ μεγάλο (μέγιστο 100 χαρακτήρες).'; return; }
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
  // Firestore rule (firestore.rules Path A) rejects any referredBy that is
  // neither '' nor matches IP-[A-Z0-9]{6}. Without this check, a malformed
  // referral code from the user propagates all the way to setDoc, blows up
  // with permission-denied, Auth is rolled back, and the customer sees the
  // generic "Δεν ολοκληρώθηκε η εγγραφή" toast. Validate up-front so we
  // never burn an SMS on a signup we know will fail.
  if (refCode && !/^IP-[A-Z0-9]{6}$/.test(refCode)) {
    err.textContent = '❌ Ο κωδικός παραπομπής είναι λάθος ή δεν υπάρχει';
    document.getElementById('reg-ref')?.focus();
    return;
  }

  btn.disabled = true; btn.innerHTML = '<div class="spin"></div>';

  // Layer 2 (referral existence): call the worker's /check-referrer BEFORE
  // sending SMS. If the code is well-formed but doesn't match any real
  // customer, /process-referral would silently mark the queue as
  // 'invalid-referrer' AFTER the customer has already committed to signup
  // — the +100 bonus vanishes and the retry loop can never heal it.
  // Failing here saves the SMS credit AND surfaces the typo before the
  // customer invests effort in the OTP step.
  if (refCode) {
    try {
      const cr = await fetch(_WORKER_URL + '/check-referrer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referrerCard: refCode })
      });
      if (cr.ok) {
        const cd = await cr.json();
        // degraded === true means the worker couldn't verify → let it pass
        // and let /process-referral be the authoritative check downstream.
        if (cd.degraded !== true) {
          if (cd.valid !== true) {
            err.textContent = '❌ Ο κωδικός παραπομπής είναι λάθος ή δεν υπάρχει';
            document.getElementById('reg-ref')?.focus();
            btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
          }
          if (cd.cap === true) {
            err.textContent = '⚠️ Αυτός ο κωδικός παραπομπής έχει εξαντληθεί (φτάσαμε το όριο). Άφησέ τον κενό ή γράψε άλλον.';
            document.getElementById('reg-ref')?.focus();
            btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
          }
        }
      }
      // 4xx/5xx from the check → don't block signup. Referral just won't
      // get validated up-front, and /process-referral's invalid-referrer
      // path will still close the queue cleanly if the code is wrong.
    } catch (_) {
      // Network drop → same reasoning: don't block signup, let the
      // authoritative check happen downstream.
    }
  }

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
    // Corrupted localStorage entry would crash submitRegister with SyntaxError
    // and leave the modal hanging — guard the parse and fall back to "no log".
    let _globalLog = [];
    try { _globalLog = (JSON.parse(localStorage.getItem(_smsGlobalKey) || '[]') || []).filter(t => _now - t < 60 * 60 * 1000); }
    catch(_) { _globalLog = []; }
    if (_globalLog.length >= 3) {
      err.textContent = '🔴 Πολλές προσπάθειες από αυτή τη συσκευή. Δοκίμασε σε 1 ώρα.';
      btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
    }

    // Pre-OTP duplicate check — saves an SMS credit when the email/phone is
    // already registered. Fail-closed on network/5xx so we never burn SMS on
    // an unverifiable signup attempt (was the cause of the credit leak —
    // previously `catch(_) {}` proceeded silently to /send-sms-otp).
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
        // If worker fell back to degraded mode (missing service-account, KV
        // outage), it returns `{exists:false, degraded:true}`. We let signup
        // continue — Firebase Auth's email-already-in-use error at create
        // time is the next backstop and does not cost an SMS by itself, but
        // the SMS would still be sent first. Surface the degradation as a
        // soft warning so ops sees it in user reports.
        if (_checkData.degraded) {
          logger.warn('[register] check-registration degraded — proceeding without duplicate check');
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
      } else {
        // 5xx other than 503 → fail-closed; do not burn an SMS credit.
        logger.warn('[register] check-registration unexpected status:', _checkRes.status);
        err.textContent = '🔴 Προσωρινό πρόβλημα. Δοκίμασε σε λίγα λεπτά.';
        btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
      }
    } catch (_checkErr) {
      // Network failure / CORS / aborted — fail-closed. Previously this was
      // a silent `catch(_) {}` that let the flow fall through to
      // /send-sms-otp and burn a credit on every retry.
      logger.warn('[register] check-registration network error:', _checkErr?.message || _checkErr);
      err.textContent = '⚠️ Δεν μπόρεσα να επαληθεύσω τα στοιχεία. Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά.';
      btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
    }

    _regData = { name, phone, email, password: p1, birthday, refCode, marketingOptIn };
    _signupCid = makeCorrelationId();

    btn.innerHTML = '<div class="spin"></div> Αποστολή SMS…';
    let _otpRes;
    try {
      _otpRes = await fetch(_WORKER_URL + '/send-sms-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
    } catch (netErr) {
      // fetch threw = network/CORS/offline reaching the Worker.
      const cls = _reportSignupFailure(SIGNUP_STAGE.SEND_OTP, netErr);
      err.textContent = '❌ ' + cls.userMsg;
      btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
    }
    const _otpData = await _otpRes.json().catch(() => ({}));
    if (!_otpRes.ok) {
      const smsErr = new Error(_otpData.error || 'send-sms-otp failed');
      smsErr.httpStatus = _otpRes.status;
      const cls = _reportSignupFailure(SIGNUP_STAGE.SEND_OTP, smsErr, { httpStatus: _otpRes.status });
      err.textContent = '❌ ' + cls.userMsg;
      btn.disabled = false; btn.innerHTML = 'Εγγραφή →'; return;
    }

    localStorage.setItem(_smsPhoneKey, _now.toString());
    localStorage.setItem(_smsGlobalKey, JSON.stringify([..._globalLog, _now]));

    document.getElementById('otp-phone-display').textContent = phone;
    document.getElementById('otp-input').value = '';
    document.getElementById('otp-err').textContent = '';
    _startOTPResendTimer(60);
    showScreen('s-otp');
    setTimeout(() => document.getElementById('otp-input').focus(), 300);

  } catch(e) {
    // Unexpected throw in the pre-OTP path — classify instead of guessing "internet".
    const cls = _reportSignupFailure(SIGNUP_STAGE.SEND_OTP, e);
    err.textContent = '❌ ' + cls.userMsg;
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

  if (!_regData) {
    err.textContent = '❌ Λήξη συνεδρίας. Επιστρέψτε και ξαναδοκιμάστε.'; return;
  }

  btn.disabled = true; btn.innerHTML = '<div class="spin"></div>';
  try {
    const vRes = await fetch(_WORKER_URL + '/verify-sms-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // email passed so the worker can clean up orphan Auth users left over
      // from prior admin deletions (no Firestore record, but Auth still locked).
      body: JSON.stringify({ phone: _regData.phone, code, email: _regData.email }),
    });
    const vData = await vRes.json().catch(() => ({}));
    if (!vRes.ok) {
      const vErr = new Error(vData.error || 'verify-sms-otp failed');
      vErr._stage = SIGNUP_STAGE.VERIFY_OTP;
      vErr.httpStatus = vRes.status;
      throw vErr;
    }

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
    _regData = null;

  } catch(e) {
    // Classify by the stage that actually failed so we never show a generic
    // "internet" message for an Auth / App Check / Firestore / OTP failure.
    const stage = e && e._stage ? e._stage
      : (typeof e?.code === 'string' && e.code.startsWith('auth/')) ? SIGNUP_STAGE.AUTH_CREATE
      : (e && e.cause) ? SIGNUP_STAGE.FIRESTORE_CREATE
      : SIGNUP_STAGE.AUTH_CREATE;
    const cls = _reportSignupFailure(stage, e, { httpStatus: e?.httpStatus });
    err.textContent = '❌ ' + cls.userMsg;
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
  // Same guard as submitRegister — corrupted localStorage must not crash resend.
  let _globalLog2 = [];
  try { _globalLog2 = (JSON.parse(localStorage.getItem(_smsGlobalKey) || '[]') || []).filter(t => _now2 - t < 60 * 60 * 1000); }
  catch(_) { _globalLog2 = []; }
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

    localStorage.setItem('_sms_p_' + _regData.phone, _now2.toString());
    localStorage.setItem(_smsGlobalKey, JSON.stringify([..._globalLog2, _now2]));
    _startOTPResendTimer(60);
    showToast('📱 Νέο SMS στάλθηκε', 'green');
  } catch(e) {
    logger.error('[resendOTP] ❌ error:', e.message);
    err.textContent = '❌ ' + (e.message || 'Αποτυχία αποστολής SMS. Δοκίμασε ξανά.');
    document.getElementById('otp-resend-btn').style.display = 'inline';
  }
}

export function cancelOTP() {
  if (_otpResendTimer) { clearInterval(_otpResendTimer); _otpResendTimer = null; }
  if (_regData?.phone) {
    try { localStorage.removeItem('_sms_p_' + _regData.phone); } catch(_) {}
  }
  try { if (window._auth?.currentUser) window._signOut(); } catch(_) {}
  showScreen('s-register');
}

// ────────────────────────────────────────
//  Structured error renderer for boxed .err-msg containers.
//  Falls back to plain textContent when only `title` is passed.
// ────────────────────────────────────────
function _renderErr(el, { icon = '', title = '', body = '', cta = null, kind = 'error' } = {}) {
  if (!el) return;
  el.classList.toggle('err-warn', kind === 'warn');
  if (!body && !cta) {
    el.textContent = icon ? `${icon} ${title}` : title;
    return;
  }
  const safeTitle = String(title).replace(/[<>&]/g, ch => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[ch]));
  const safeBody  = String(body ).replace(/[<>&]/g, ch => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[ch]));
  let html = `<span class="err-title">${icon ? icon + ' ' : ''}${safeTitle}</span>`;
  if (body) html += `<span class="err-body">${safeBody}</span>`;
  if (cta && cta.label && cta.onClickAttr) {
    const safeLbl = String(cta.label).replace(/[<>&]/g, ch => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[ch]));
    html += `<button type="button" class="err-cta" ${cta.onClickAttr}>${safeLbl}</button>`;
  }
  el.innerHTML = html;
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
    if (window._setPersistenceMode) {
      try {
        await window._setPersistenceMode(remCb?.checked ? 'local' : 'session');
      } catch (pe) {
        // iOS Safari private mode / strict ITP / cross-site cookie block.
        // Login still proceeds — but if the user asked to be remembered,
        // they should know it won't stick. Non-blocking copy that auto-
        // clears after a few seconds.
        logger.warn('[login] persistence set failed:', pe?.code || pe?.message || pe);
        if (remCb?.checked) {
          _renderErr(err, {
            icon: '⚠️', kind: 'warn',
            title: '"Να με θυμάσαι" δεν είναι διαθέσιμο',
            body: 'Το browser δεν επιτρέπει αποθήκευση συνεδρίας (πιθανώς ιδιωτική περιήγηση). Θα παραμείνεις συνδεδεμένος μόνο σε αυτή τη συνεδρία.'
          });
          setTimeout(() => { try { err.textContent = ''; } catch(_) {} }, 5000);
        }
      }
    }
    const authResult = await window._signIn(window._auth, email, pass);
    const firebaseUID = authResult?.user?.uid || authResult?.uid || null;

    // HIGH-1 compatibility: shared lookup ladder in services/firebase.js.
    const lookup = await findCustomerByAuth(firebaseUID, email, { logger });
    state.foundCustomer = lookup.customer;
    if (!state.foundCustomer) {
      // Two distinct failure modes need distinct UX:
      //   • Transient error (network / App Check) → keep session, keep card,
      //     ask user to retry. Wiping here would log out a customer whose
      //     account is fine, plus drop their offline QR.
      //   • findCustomer returned null with no error → AMBIGUOUS. Could be
      //     a deleted account OR a legacy doc that the rules hide from the
      //     authenticated-but-not-verified user. Worker /check-registration
      //     is the authoritative oracle (admin-context Firestore read,
      //     bypasses rules). Confirm with the worker BEFORE doing the
      //     destructive sign-out + offline-card wipe.
      if (lookup.error) {
        // Classify the transient lookup failure — App Check / offline /
        // network / Firestore-unavailable get distinct, accurate messages
        // instead of a blanket "can't reach database".
        const cls = classifyLoginLookupError(lookup.error);
        logger.error('[login]', JSON.stringify(buildSignupLog('login-lookup', cls, {
          appCheckStatus: (typeof window !== 'undefined' ? window._appCheckStatus : '') || 'unknown',
        })));
        _renderErr(err, { icon: '⚠️', kind: 'warn', title: cls.title, body: cls.userMsg });
        btn.disabled = false; btn.innerHTML = 'Είσοδος →'; return;
      }

      let confirmedMissing = false;
      try {
        const r = await fetch(_WORKER_URL + '/check-registration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        if (r.ok) {
          const d = await r.json();
          // exists:false + degraded:false ⇒ authoritative "no such account".
          // exists:true ⇒ account is there, rules are hiding it from this
          //               auth state (most often: legacy doc + unverified
          //               email). degraded ⇒ worker couldn't verify, do
          //               not act on it.
          confirmedMissing = (d?.exists === false && d?.degraded !== true);
        }
      } catch (e) {
        logger.warn('[login] check-registration failed:', e?.message || e);
      }

      if (confirmedMissing) {
        try { await window._signOut(window._auth); }
        catch (e) { logger.warn('[login] orphan signOut failed:', e?.code || e?.message || e); }
        try {
          [_REM_KEY, _CACHE_KEY, 'ipear_offline_card'].forEach(k => localStorage.removeItem(k));
        } catch(_) {}
        _renderErr(err, {
          icon: '❌',
          title: 'Δεν βρέθηκε λογαριασμός',
          body: 'Δεν υπάρχει loyalty account για αυτό το email. Δημιούργησε νέο ή επικοινώνησε με το κατάστημα.',
          cta: { label: 'Δημιουργία λογαριασμού →', onClickAttr: 'onclick="openRegister()"' }
        });
      } else {
        _renderErr(err, {
          icon: '⚠️', kind: 'warn',
          title: 'Ο λογαριασμός χρειάζεται ενημέρωση',
          body: 'Έχει υπάρχει αλλά απαιτείται επαλήθευση. Δοκίμασε επαλήθευση email ή ξέχασα τον κωδικό μου.',
          cta: { label: 'Ξέχασα τον κωδικό →', onClickAttr: 'onclick="openForgotPass()"' }
        });
      }
      btn.disabled = false; btn.innerHTML = 'Είσοδος →'; return;
    }

    if (state.foundCustomer.blocked) {
      await window._signOut(window._auth).catch(()=>{});
      state.foundCustomer = null;
      err.textContent = '🚫 Ο λογαριασμός σας έχει απενεργοποιηθεί. Επικοινωνήστε με το κατάστημα iPear.';
      btn.disabled=false; btn.innerHTML='Είσοδος →'; return;
    }

    if (firebaseUID && state.foundCustomer.id !== firebaseUID) {
      // Fire-and-forget so submitPhone returns control to the UI immediately;
      // the user lands in the app on the legacy doc, migration converges
      // in the background.
      _migrateCustomerToUid(state.foundCustomer.id, firebaseUID)
        .catch(e => logger.warn('[migrate-uid] background:', e?.code || e?.message || e));
    } else if (firebaseUID && state.foundCustomer.uid !== firebaseUID) {
      try {
        await window._updateDoc(window._doc(window._db,'ipear_customers',state.foundCustomer.id), {uid: firebaseUID});
        state.foundCustomer.uid = firebaseUID;
      } catch(_) {}
    }

    _persistMinimalCache(state.foundCustomer);
    if (remCb?.checked) {
      localStorage.setItem(_REM_KEY, JSON.stringify({email: state.foundCustomer.email||email, name: state.foundCustomer.name}));
    } else {
      localStorage.removeItem(_REM_KEY); localStorage.removeItem(_CACHE_KEY);
    }

    document.getElementById('auth-pass').value = '';
    _transitionToApp();
  } catch(e) {
    // L2.4-A: neutral, single credential-error message. Firebase Auth's
    // v10 SDK returns `auth/invalid-credential` for both wrong-password and
    // unknown-email (Email Enumeration Protection). Older codes are mapped
    // to the same string so the customer cannot distinguish the two.
    const code = e?.code || '';
    const isCredError =
      code === 'auth/invalid-credential' ||
      code === 'auth/invalid-login-credentials' ||
      code === 'auth/user-not-found' ||
      code === 'auth/wrong-password';
    if (isCredError) {
      err.textContent = 'Ο συνδυασμός email και κωδικού δεν είναι έγκυρος.';
    } else if (code === 'auth/too-many-requests') {
      err.textContent = 'Πολλές αποτυχημένες προσπάθειες. Δοκίμασε ξανά σε λίγο.';
    } else if (code === 'auth/network-request-failed') {
      err.textContent = 'Χωρίς σύνδεση — δοκίμασε ξανά όταν είσαι online.';
    } else {
      // Non-credential, non-network errors — surface the code only, never
      // any provider or existence-revealing message.
      err.textContent = 'Δεν ολοκληρώθηκε η σύνδεση. Δοκίμασε ξανά.';
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
    if (window._setPersistenceMode) {
      await window._setPersistenceMode(remCb?.checked ? 'local' : 'session');
    }
    const authResult = await window._createUser(window._auth, email, p1);
    const firebaseUID = authResult?.user?.uid || authResult?.uid || null;
    if (firebaseUID && state.foundCustomer?.id && state.foundCustomer.id !== firebaseUID) {
      try { await _migrateCustomerToUid(state.foundCustomer.id, firebaseUID); }
      catch (e) { logger.warn('[migrate-uid] failed:', e?.code || e?.message || e); }
    } else if (firebaseUID && state.foundCustomer?.id) {
      try {
        await window._updateDoc(window._doc(window._db,'ipear_customers',state.foundCustomer.id), {uid: firebaseUID});
        state.foundCustomer.uid = firebaseUID;
      } catch(_) {}
    }
    _persistMinimalCache(state.foundCustomer);
    if (remCb?.checked) {
      localStorage.setItem(_REM_KEY, JSON.stringify({email: state.foundCustomer.email||email, name: state.foundCustomer.name}));
    }
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
  // Q-2 fix: synchronous cleanup BEFORE signOut so listeners can't briefly
  // fire on a half-torn-down session.
  try { _forceCleanup(); } catch(_) {}
  try { _cancelActiveRedemption('logout'); } catch(_) {}
  if (_otpResendTimer) { clearInterval(_otpResendTimer); _otpResendTimer = null; }
  _regData = null;
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

// ════════════════════════════════════════════════════════════════════════════
//  L2.4-A · Resend email verification (server-authoritative)
//
//  The Worker's POST /resend-verification is the ONLY path a client is
//  allowed to trigger. Rate limits, link generation, and Brevo delivery all
//  live server-side. The client:
//    • sends the Firebase ID token in the Authorization header only
//      (never body, never query, never localStorage, never logged),
//    • honours a 60s local button cooldown as UX (not the security control),
//    • bounds the request at 30s so the button can never permanently spin,
//    • disables the button synchronously before any await to prevent
//      duplicate submissions,
//    • displays the same neutral copy for every outcome — success, worker
//      error, network error, already-verified — so the response cannot be
//      used to enumerate account state.
// ════════════════════════════════════════════════════════════════════════════
const _RESEND_COOLDOWN_MS = 60_000;
let _resendBusy = false;
const _RESEND_LAST_KEY = '_rv_last';

export async function resendEmailVerification() {
  if (_resendBusy) return;
  const btn = document.getElementById('resend-verify-btn');
  const status = document.getElementById('resend-verify-status');
  const NEUTRAL = 'Αν χρειάζεται επαλήθευση, στείλαμε νέο email. Έλεγξε και τα ανεπιθύμητα.';

  const last = parseInt(localStorage.getItem(_RESEND_LAST_KEY) || '0', 10);
  const wait = _RESEND_COOLDOWN_MS - (Date.now() - last);
  if (wait > 0) {
    if (status) {
      status.textContent = `⏳ Δοκίμασε ξανά σε ${Math.ceil(wait / 1000)}s.`;
      status.setAttribute('aria-live', 'polite');
    }
    return;
  }

  _resendBusy = true;
  if (btn) { btn.disabled = true; }

  let idToken = null;
  try {
    const u = window._auth?.currentUser;
    if (u && typeof u.getIdToken === 'function') idToken = await u.getIdToken(false);
  } catch (_) { /* neutral response below */ }

  let deadline;
  try {
    const ctrl = new AbortController();
    deadline = setTimeout(() => ctrl.abort(), 30_000);
    if (idToken) {
      await fetch(_WORKER_URL + '/resend-verification', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + idToken,
        },
        // Empty body — worker derives uid + email from the verified token.
        body: '{}',
        signal: ctrl.signal,
      }).catch(() => { /* neutral: never leak worker/network failures */ });
    }
  } finally {
    if (deadline) clearTimeout(deadline);
    _resendBusy = false;
    if (btn) { btn.disabled = false; }
    if (status) {
      status.textContent = NEUTRAL;
      status.setAttribute('aria-live', 'polite');
    }
    localStorage.setItem(_RESEND_LAST_KEY, String(Date.now()));
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  L2.4-A · Return handler for the Firebase-hosted action widget
//
//  When Firebase redirects the customer back to
//    https://loyalty.ipear.gr/?resetOk=1   (after password reset)
//    https://loyalty.ipear.gr/?verifyOk=1  (after email verification)
//  the client:
//    1. Shows a neutral, single-locale Greek toast.
//    2. Removes the query parameter via history.replaceState so a share of
//       the URL cannot mistakenly display the toast to a different user.
//    3. For verifyOk: reloads the current Firebase user before deciding
//       whether the email is verified (the ID token issued before the click
//       is stale; user.reload() forces a re-fetch).
//    4. Treats the parameter as post-action UX only, NOT security evidence.
//       No claim is written and no state is elevated on the strength of
//       someone manually typing the query string — the actual reset/verify
//       success was proven inside Firebase's hosted widget, we're only
//       displaying the confirmation.
// ════════════════════════════════════════════════════════════════════════════
export async function handleAuthActionReturn() {
  try {
    const params = new URLSearchParams(location.search || '');
    const hasReset  = params.get('resetOk')  === '1';
    const hasVerify = params.get('verifyOk') === '1';
    if (!hasReset && !hasVerify) return;

    // Strip the params from the URL regardless of what we do next.
    params.delete('resetOk'); params.delete('verifyOk');
    const q = params.toString();
    const clean = location.pathname + (q ? '?' + q : '') + location.hash;
    try { history.replaceState({}, '', clean); } catch (_) { /* browser guard */ }

    if (hasReset) {
      showToast('✅ Ο κωδικός σου ενημερώθηκε. Σύνδεσε με τον νέο κωδικό.', 'green');
    }
    if (hasVerify) {
      try { if (window._reloadUser) await window._reloadUser(window._auth?.currentUser); }
      catch (_) { /* neutral — do not surface reload failures */ }
      showToast('✅ Το email σου επαληθεύτηκε.', 'green');
    }
  } catch (_) {
    // Never crash boot on a query-param handler.
  }
}

// ════════════════════════════════════════
//  ACCOUNT DELETION REQUEST
// ════════════════════════════════════════
let _deletionBusy = false;
export async function requestAccountDeletion() {
  if (_deletionBusy) return;
  if (!state.foundCustomer?.id) { showToast('⚠️ Δεν βρέθηκε λογαριασμός', 'red'); return; }
  if (!confirm('⚠️ Θέλεις σίγουρα να διαγράψεις τον λογαριασμό σου;\n\nΌλοι οι πόντοι και τα δεδομένα σου θα χαθούν ΟΡΙΣΤΙΚΑ.')) return;
  if (!confirm('ΤΕΛΙΚΗ ΕΠΙΒΕΒΑΙΩΣΗ:\nΗ διαγραφή είναι μη αναστρέψιμη. Συνέχεια;')) return;
  _deletionBusy = true;
  try {
    await window._updateDoc(window._doc(window._db, 'ipear_customers', state.foundCustomer.id), {
      deletionRequested: true,
      deletionRequestedAt: new Date().toISOString()
    });
    showToast('✅ Καταχωρήθηκε. Θα ενημερωθείς σύντομα', 'green');
  } catch(e) {
    showToast('❌ Δεν στάλθηκε. Δοκίμασε ξανά', 'red');
  } finally {
    _deletionBusy = false;
  }
}

