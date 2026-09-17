// @vitest-environment jsdom
// ═══════════════════════════════════════════════════════════════════════════
//  L2.4-A · client-side auth-hardening behavioral tests
//
//  Covers: forgot-password neutrality, no pre-worker Firestore query, absence
//  of client Firebase fallback, resend-verification wrapper, ?resetOk=1 and
//  ?verifyOk=1 return handlers, button lifecycle (disabled/finally/cooldown/
//  rapid-click).
//
//  Drives real exported functions from src/auth.js with mocked window._auth /
//  window._db / window._getDocs / window._sendPassReset / window._reloadUser
//  and a spied fetch.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';

// jsdom polyfills required by src/main.js's boot-time PWA detection.
// Set BEFORE the dynamic import of src/auth.js — ES `import` statements are
// hoisted above all top-level code, so we must load auth.js dynamically
// after the polyfill is in place. Otherwise the module chain crashes.
window.matchMedia = window.matchMedia || ((q) => ({
  matches: false, media: q, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  dispatchEvent: () => false,
}));

// Also polyfill navigator.serviceWorker for the boot chain.
if (!('serviceWorker' in navigator)) {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: async () => ({}),
      addEventListener: () => {},
      getRegistrations: async () => [],
      controller: null,
    },
  });
}

// Stub src/main.js — the circular import (auth.js ↔ main.js) triggers a
// TDZ crash on the firebase-ready boot event during test import. The four
// functions submitForgotPass/resendEmailVerification/handleAuthActionReturn
// do NOT depend on main.js's exports, so no-op stubs are sufficient here.
vi.mock('../src/main.js', () => ({
  _forceCleanup: () => {},
  _cancelActiveRedemption: () => {},
  switchTab: () => {},
  startApp: async () => {},
  _migrateCustomerToUid: async () => {},
  _refreshPointsUI: () => {},
}));

// Stub the shared services/firebase helper — same reason: unused by the
// three functions under test.
vi.mock('../src/services/firebase.js', () => ({
  findCustomerByAuth: async () => ({ customer: null, error: null }),
  getDb: () => ({}),
}));

let submitForgotPass, resendEmailVerification, handleAuthActionReturn;
beforeAll(async () => {
  const m = await import('../src/auth.js');
  submitForgotPass         = m.submitForgotPass;
  resendEmailVerification  = m.resendEmailVerification;
  handleAuthActionReturn   = m.handleAuthActionReturn;
});

// Set worker URL BEFORE importing anything that reads _WORKER_URL. utils.js
// reads window._IPEAR_WORKER_URL at import time, so we assign it in globalThis
// before the very first import — but src/utils.js has already been imported
// transitively by src/auth.js. As a defensive fixture, tests filter fetch
// calls by URL suffix so the specific host doesn't matter.

function mountForgotDom() {
  document.body.innerHTML = `
    <div id="s-forgot">
      <input id="forgot-email" type="email" value="" />
      <button id="forgot-btn">Αποστολή →</button>
      <div id="forgot-ok" style="display:none"></div>
      <div id="forgot-err"></div>
    </div>
  `;
}

function mountResendDom() {
  document.body.innerHTML = `
    <div id="s-app">
      <button id="resend-verify-btn">Στείλε ξανά</button>
      <div id="resend-verify-status" role="status" aria-live="polite"></div>
    </div>
  `;
}

function stubAuthUser({ getIdToken = async () => 'MOCK.ID.TOKEN' } = {}) {
  window._auth = { currentUser: { uid: 'uid-1', email: 'user@test.gr', getIdToken } };
}

function stubFetch(handler) {
  const spy = vi.fn(handler);
  window.fetch = spy;
  globalThis.fetch = spy;
  return spy;
}

// showToast reads document.body — mount a dummy toast host if the caller
// wants to verify visibility. showToast is imported from utils.js and
// appends to body; our handler tests just assert no crash.
function silenceToast() {
  // showToast writes to a toast container it creates itself; nothing to do.
}

beforeEach(() => {
  window._IPEAR_WORKER_URL = 'https://worker.test.local';
  window._getDocs   = vi.fn(async () => ({ empty: true, forEach: () => {} }));
  window._query     = vi.fn(() => ({}));
  window._col       = vi.fn(() => ({}));
  window._where     = vi.fn(() => ({}));
  window._db        = {};
  window._sendPassReset = vi.fn(async () => {});
  window._reloadUser = vi.fn(async () => {});
  // Cooldown localStorage keys — clear between tests.
  localStorage.clear();
  silenceToast();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  history.replaceState({}, '', '/');
});

describe('L2.4-A · forgot-password neutrality', () => {
  it('valid email → neutral Greek text; no pre-worker Firestore query', async () => {
    mountForgotDom();
    document.getElementById('forgot-email').value = 'user@test.gr';
    stubFetch(async () => new Response('{"success":true}', { status: 200 }));

    await submitForgotPass();

    const ok = document.getElementById('forgot-ok');
    expect(ok.style.display).toBe('block');
    expect(ok.textContent).toBe(
      'Αν υπάρχει λογαριασμός με αυτό το email, θα λάβεις οδηγίες επαναφοράς.'
    );
    // No client-side Firestore query fired.
    expect(window._getDocs).not.toHaveBeenCalled();
    // No client fallback to sendPasswordResetEmail.
    expect(window._sendPassReset).not.toHaveBeenCalled();
  });

  it('unknown email response from worker → identical neutral text; no fallback', async () => {
    mountForgotDom();
    document.getElementById('forgot-email').value = 'nobody@test.gr';
    stubFetch(async () => new Response(
      '{"success":true,"message":"If the email exists…"}',
      { status: 200 }
    ));

    await submitForgotPass();

    expect(document.getElementById('forgot-ok').textContent).toBe(
      'Αν υπάρχει λογαριασμός με αυτό το email, θα λάβεις οδηγίες επαναφοράς.'
    );
    expect(window._getDocs).not.toHaveBeenCalled();
    expect(window._sendPassReset).not.toHaveBeenCalled();
  });

  it('worker network failure → identical neutral text; no fallback', async () => {
    mountForgotDom();
    document.getElementById('forgot-email').value = 'user@test.gr';
    stubFetch(async () => { throw new Error('offline'); });

    await submitForgotPass();

    expect(document.getElementById('forgot-ok').textContent).toBe(
      'Αν υπάρχει λογαριασμός με αυτό το email, θα λάβεις οδηγίες επαναφοράς.'
    );
    expect(window._sendPassReset).not.toHaveBeenCalled();
  });

  it('sends the exact canonical continueUrl to the worker', async () => {
    mountForgotDom();
    document.getElementById('forgot-email').value = 'user@test.gr';
    const spy = stubFetch(async () => new Response('{"success":true}', { status: 200 }));

    await submitForgotPass();

    expect(spy).toHaveBeenCalledOnce();
    const [url, opts] = spy.mock.calls[0];
    expect(String(url)).toMatch(/\/reset-password$/);
    const body = JSON.parse(opts.body);
    expect(body.email).toBe('user@test.gr');
    expect(body.continueUrl).toBe('https://loyalty.ipear.gr/?resetOk=1');
  });

  it('60-second local cooldown blocks a second dispatch', async () => {
    mountForgotDom();
    document.getElementById('forgot-email').value = 'user@test.gr';
    const spy = stubFetch(async () => new Response('{"success":true}', { status: 200 }));

    await submitForgotPass();
    expect(spy).toHaveBeenCalledTimes(1);

    // Second attempt within cooldown — should render the countdown warning.
    document.getElementById('forgot-email').value = 'user@test.gr';
    await submitForgotPass();
    const errText = document.getElementById('forgot-err').textContent;
    expect(errText).toMatch(/Δοκίμασε ξανά/);
    expect(spy).toHaveBeenCalledTimes(1); // no second fetch dispatched
  });

  it('button restored after success', async () => {
    mountForgotDom();
    document.getElementById('forgot-email').value = 'user@test.gr';
    stubFetch(async () => new Response('{"success":true}', { status: 200 }));

    await submitForgotPass();

    const btn = document.getElementById('forgot-btn');
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toBe('Αποστολή →');
  });
});

describe('L2.4-A · resend email verification', () => {
  it('sends the ID token in the Authorization header only; body is {}', async () => {
    mountResendDom();
    stubAuthUser();
    const spy = stubFetch(async () => new Response('{"success":true,"message":"…"}', { status: 200 }));

    await resendEmailVerification();

    expect(spy).toHaveBeenCalledOnce();
    const [url, opts] = spy.mock.calls[0];
    expect(String(url)).toMatch(/\/resend-verification$/);
    expect(opts.headers.Authorization).toBe('Bearer MOCK.ID.TOKEN');
    expect(opts.body).toBe('{}');
    // Body must NOT carry the token.
    expect(opts.body).not.toContain('MOCK.ID.TOKEN');
    // URL must NOT carry the token.
    expect(String(url)).not.toContain('MOCK.ID.TOKEN');
  });

  it('shows neutral status text regardless of worker response body', async () => {
    mountResendDom();
    stubAuthUser();
    stubFetch(async () => new Response('{"success":true,"message":"whatever"}', { status: 200 }));

    await resendEmailVerification();

    const status = document.getElementById('resend-verify-status');
    expect(status.textContent).toBe(
      'Αν χρειάζεται επαλήθευση, στείλαμε νέο email. Έλεγξε και τα ανεπιθύμητα.'
    );
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('60-second cooldown blocks a rapid second click', async () => {
    mountResendDom();
    stubAuthUser();
    const spy = stubFetch(async () => new Response('{"success":true}', { status: 200 }));

    await resendEmailVerification();
    expect(spy).toHaveBeenCalledTimes(1);

    await resendEmailVerification();
    expect(spy).toHaveBeenCalledTimes(1); // second call intercepted by cooldown

    const status = document.getElementById('resend-verify-status');
    expect(status.textContent).toMatch(/Δοκίμασε ξανά/);
  });

  it('rapid four clicks dispatch exactly ONE fetch (busy guard + cooldown)', async () => {
    mountResendDom();
    stubAuthUser();
    const spy = stubFetch(async () => new Response('{"success":true}', { status: 200 }));

    await Promise.all([
      resendEmailVerification(),
      resendEmailVerification(),
      resendEmailVerification(),
      resendEmailVerification(),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('button restored in finally even when fetch throws', async () => {
    mountResendDom();
    stubAuthUser();
    stubFetch(async () => { throw new Error('boom'); });

    await resendEmailVerification();

    const btn = document.getElementById('resend-verify-btn');
    expect(btn.disabled).toBe(false);
    // Neutral status still displayed — never leaks the error.
    expect(document.getElementById('resend-verify-status').textContent).toBe(
      'Αν χρειάζεται επαλήθευση, στείλαμε νέο email. Έλεγξε και τα ανεπιθύμητα.'
    );
  });

  it('no auth session → no fetch dispatched but status still shows neutral text', async () => {
    mountResendDom();
    window._auth = { currentUser: null };
    const spy = stubFetch(async () => new Response('{"success":true}', { status: 200 }));

    await resendEmailVerification();

    expect(spy).not.toHaveBeenCalled();
    expect(document.getElementById('resend-verify-status').textContent).toBe(
      'Αν χρειάζεται επαλήθευση, στείλαμε νέο email. Έλεγξε και τα ανεπιθύμητα.'
    );
  });
});

describe('L2.4-A · ?resetOk=1 / ?verifyOk=1 return handler', () => {
  it('?resetOk=1 → clears the query parameter via history.replaceState', async () => {
    history.replaceState({}, '', '/?resetOk=1');
    await handleAuthActionReturn();
    expect(location.search).toBe('');
    expect(location.pathname).toBe('/');
  });

  it('?verifyOk=1 → reloads the current Firebase user, then clears the query', async () => {
    history.replaceState({}, '', '/?verifyOk=1');
    stubAuthUser();
    await handleAuthActionReturn();
    expect(window._reloadUser).toHaveBeenCalledOnce();
    expect(window._reloadUser).toHaveBeenCalledWith(window._auth.currentUser);
    expect(location.search).toBe('');
  });

  it('preserves other query params and hash while stripping the action ones', async () => {
    history.replaceState({}, '', '/?utm_source=email&resetOk=1&verifyOk=1#tab-profile');
    await handleAuthActionReturn();
    expect(location.search).toBe('?utm_source=email');
    expect(location.hash).toBe('#tab-profile');
  });

  it('no query params → no-op; no toast, no reload', async () => {
    history.replaceState({}, '', '/');
    stubAuthUser();
    await handleAuthActionReturn();
    expect(window._reloadUser).not.toHaveBeenCalled();
  });

  it('manually-typed query param still triggers the UX handler — but does NOT elevate any state', async () => {
    // Documenting the intent: the query param is UX-only, not security proof.
    // Firebase's own reset/verify success happens inside the hosted widget.
    // We just clear the param and show a toast; no auth state is written.
    history.replaceState({}, '', '/?resetOk=1');
    await handleAuthActionReturn();
    // No claim, no doc write, no persisted flag. (No mocks to assert
    // absence-of-effect; we assert the observable UX cleanup happened.)
    expect(location.search).toBe('');
  });
});
