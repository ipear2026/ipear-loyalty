// ═══════════════════════════════════════════════════════════════════════════
//  KIOSK SURVIVAL — auth session survives the validator window
//
//  Regression coverage for the 2026-06-23 outage class:
//
//    A "continuous auth-state validator" lived in firebase-init.js (shared by
//    main.js, admin-main.js, tablet-main.js). It signed the user out 3.5s +
//    1.2s = 4.7s after every onAuthStateChanged that lacked a bound customer
//    doc (state.foundCustomer.id). On cashier surfaces (/tablet, /admin) the
//    cashier is NEVER a customer — so the validator force-logged-out every
//    cashier 4.7s post-login. The symptom surfaced as cryptic
//    "Missing or insufficient permissions" errors because the rules engine
//    saw request.auth == null on every subsequent read.
//
//    The validator was relocated to main.js (customer-only). This spec locks
//    that down by:
//      1. Signing in on /tablet or /admin via Firebase Auth client SDK
//         (window._signIn — exposed by firebase-init.js)
//      2. Waiting 10.5 seconds (past the 4.7s validator threshold)
//      3. Asserting window._auth.currentUser is still set
//      4. Performing a read that requires isAdmin() in firestore.rules and
//         expecting it to succeed (proves auth + admin claim still flow
//         through to Firestore correctly)
//
//    If anyone re-introduces a validator in firebase-init.js (or any other
//    shared module) that signs out users without checking the surface, this
//    test fails inside 11 seconds.
//
//  Required env (loaded from .env locally, GitHub Actions secrets in CI):
//   • TEST_ADMIN_EMAIL  — admin or tablet account email (must exist in
//                         Firebase Auth + be admin via custom claim, doc, or
//                         allow-list rescue path)
//   • TEST_ADMIN_PASS   — password for above
//
//  Optional env:
//   • APPCHECK_DEBUG_TOKEN — set when the project has App Check enforced
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect } from '@playwright/test';

const REQUIRED_ENV = ['TEST_ADMIN_EMAIL', 'TEST_ADMIN_PASS'];

// The validator that caused the outage fired at 3.5s + 1.2s = 4.7s post-auth.
// We wait 10.5s to be well past both timers + give the network a beat. If a
// new validator is ever added with a longer window, bump this — but the
// floor is 4.7s + safety margin.
const SURVIVAL_WAIT_MS = 10_500;

// Helper: hard-fail fast if the harness lacks env. Better than a confusing
// page.goto timeout deep in the test.
function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required env: ${missing.join(', ')}. ` +
        `Locally: add them to .env. In CI: add as repo secrets + wire into ` +
        `.github/workflows/ci.yml → e2e job. The account MUST be admin via ` +
        `custom claim, ipear_admins doc, or the email allow-list rescue ` +
        `(see firestore.rules isAdmin()).`,
    );
  }
}

// Helper: install the App Check debug token before any page script runs.
// No-op if not configured.
async function installAppCheckDebugToken(page) {
  if (!process.env.APPCHECK_DEBUG_TOKEN) return;
  await page.addInitScript((token) => {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = token;
  }, process.env.APPCHECK_DEBUG_TOKEN);
}

// Helper: wait until firebase-init.js has finished its top-level await and
// the auth/db helpers are exposed on window. The page emits 'firebase-ready'
// after init; we listen via expect.poll because the event may have already
// fired by the time we evaluate.
async function waitForFirebaseReady(page) {
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            !!(
              window._firebaseReady &&
              window._auth &&
              window._signIn &&
              window._getDocs
            ),
        ),
      { timeout: 20_000, intervals: [200, 400, 800] },
    )
    .toBe(true);
}

// Helper: programmatic sign-in via window._signIn — same primitive the UI
// uses. Returns the email confirmed by Firebase (proves the round-trip).
async function programmaticSignIn(page, email, password) {
  return await page.evaluate(
    async ([e, p]) => {
      const cred = await window._signIn(window._auth, e, p);
      return cred.user?.email || null;
    },
    [email, password],
  );
}

// Helper: read auth state from the page (NOT from a test-side import — we
// want to assert what the browser context sees).
async function readAuthState(page) {
  return await page.evaluate(async () => {
    const u = window._auth?.currentUser;
    if (!u) return { signedIn: false };
    let adminClaim = false;
    try {
      const tok = await u.getIdTokenResult(false);
      adminClaim = tok?.claims?.admin === true;
    } catch (_) {}
    return {
      signedIn: true,
      uid: u.uid,
      email: u.email,
      emailVerified: u.emailVerified,
      adminClaim,
    };
  });
}

// Helper: attempt a Firestore read that requires the isAdmin() branch of
// the read rule. ipear_customers full-collection scan is the canonical
// admin-only path the search feature relies on. Returns:
//   { ok: true, size: number }  if the read passed the rule
//   { ok: false, code: string } if denied (regression — validator fired)
async function tryAdminScopedRead(page) {
  return await page.evaluate(async () => {
    try {
      const snap = await window._getDocs(
        window._query(
          window._col(window._db, 'ipear_customers'),
          window._where('card', '==', 'IP-NONEXISTENT-' + Date.now()),
        ),
      );
      return { ok: true, size: snap.size };
    } catch (e) {
      return { ok: false, code: e?.code || e?.name || 'unknown', message: e?.message || '' };
    }
  });
}

// We run the same survival assertion against both cashier surfaces. The
// validator bug affected both. Each surface runs in its own browser context
// so localStorage / IndexedDB don't leak between them.
const SURFACES = [
  { name: '/tablet', path: '/tablet' },
  { name: '/admin', path: '/admin' },
];

// ─────────────────────────────────────────────────────────────────────────
//  The suite is split into two test stages per surface:
//
//   • PRIMARY (always-on): "auth survives the validator window"
//       — the actual 2026-06-23 regression check. Runs for ANY signed-in
//         user; doesn't need admin status. This is the hard guard against
//         the phantom auto-signOut bug ever returning.
//
//   • SECONDARY (admin-only): "admin-scoped Firestore read still allowed"
//       — catches subtler regressions where auth survives but the rules
//         engine stops recognising the user as admin (claim drift, doc
//         removal, allow-list bug). Opt-in via TEST_ADMIN_CLAIMS_EXPECTED=1
//         because the dedicated test account TEST_ADMIN_EMAIL was removed
//         from the production allow-list in commit a089a6f for security.
//         Sprint 2 backlog: seed a custom-claim admin for this account so
//         the secondary assertion can return to "always-on".
// ─────────────────────────────────────────────────────────────────────────
const RUN_ADMIN_READ = process.env.TEST_ADMIN_CLAIMS_EXPECTED === '1';

test.describe('Kiosk survival — auth persists past validator window', () => {
  test.beforeAll(() => {
    checkEnv();
  });

  for (const surface of SURFACES) {
    test(`${surface.name} — admin session survives ${SURVIVAL_WAIT_MS}ms post-login (no phantom signOut)`, async ({
      page,
    }) => {
      // ── 0. App Check debug-token shim (optional) ───────────────────────
      await installAppCheckDebugToken(page);

      // ── 1. Load surface + wait for firebase-init to finish ────────────
      // Capture page console errors so a regression shows the rules denial
      // straight in the Playwright report.
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      await page.goto(surface.path);
      await waitForFirebaseReady(page);

      // ── 2. Programmatic sign-in ────────────────────────────────────────
      const signedInEmail = await programmaticSignIn(
        page,
        process.env.TEST_ADMIN_EMAIL,
        process.env.TEST_ADMIN_PASS,
      );
      expect(signedInEmail, 'window._signIn must return a non-null user').toBe(
        process.env.TEST_ADMIN_EMAIL,
      );

      // Confirm the auth state IMMEDIATELY after sign-in (baseline).
      const beforeWait = await readAuthState(page);
      expect(beforeWait.signedIn, 'auth must be live immediately post-signIn').toBe(true);

      // ── 3. Wait past the legacy validator window ───────────────────────
      // 4.7s was the historical phantom-logout point. 10.5s gives 2x+ margin
      // so a half-broken patch (e.g. someone bumping the timer to 7s) also
      // fails this test instead of silently regressing.
      await page.waitForTimeout(SURVIVAL_WAIT_MS);

      // ── 4. PRIMARY ASSERTION: auth state MUST still be live ───────────
      // This is the core regression check for the 2026-06-23 outage.
      const afterWait = await readAuthState(page);
      expect(
        afterWait.signedIn,
        `auth state was nuked ${SURVIVAL_WAIT_MS}ms after sign-in — likely a ` +
          `phantom validator regression (re-check firebase-init.js for ` +
          `signOut paths). Console errors during wait: ` +
          consoleErrors.slice(-5).join(' | '),
      ).toBe(true);
      expect(afterWait.uid).toBe(beforeWait.uid);

      // ── 5. SECONDARY ASSERTION (opt-in): Firestore admin read works ────
      // Gated behind TEST_ADMIN_CLAIMS_EXPECTED=1 because the default test
      // account (TEST_ADMIN_EMAIL=e2e@ipear.gr today) is intentionally NOT
      // a real admin after the a089a6f security patch. Set the env var
      // only when running with a properly-claimed admin account.
      if (RUN_ADMIN_READ) {
        const readResult = await tryAdminScopedRead(page);
        expect(
          readResult.ok,
          `Firestore admin-scoped read denied after wait — auth survived but ` +
            `the rules engine no longer recognises this user as admin. ` +
            `Code: ${readResult.code}. Message: ${readResult.message}. ` +
            `Check firestore.rules isAdmin() paths + the test account's ` +
            `admin claim / ipear_admins doc / allow-list status.`,
        ).toBe(true);
      } else {
        // Document in the test trail that we deliberately skipped the
        // admin-read assertion. Makes audit logs explicit.
        test.info().annotations.push({
          type: 'note',
          description:
            'Admin-scoped Firestore read assertion skipped — set ' +
            'TEST_ADMIN_CLAIMS_EXPECTED=1 with a real admin account to enable.',
        });
      }
    });
  }
});
