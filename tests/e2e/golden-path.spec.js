// ═══════════════════════════════════════════════════════════════════════════
//  GOLDEN PATH — login → tap reward → approve → see in history
//
//  What this test locks down (end-to-end, against real Firebase + the built
//  bundle served by `vite preview`):
//
//   1. Login UI flow (email + password) reaches the customer app.
//   2. Hero balance counts up to a value ≥ the 1000-pt reward threshold.
//   3. Tapping a reward card creates an `ipear_redemptions` doc + shows QR.
//   4. The redemption-verify atomic txn (replicated here via Firebase Admin
//      SDK to keep the spec dependency-light) drains 1000 pts, marks the
//      redemption used, and writes the ledger row in one commit.
//   5. The customer's live snapshot listener picks up the balance drop AND
//      the new "Έκπτωση" history row within a few seconds.
//   6. Cleanup: refund the points so the test stays repeatable.
//
//  Why we touch Firestore directly instead of driving a /admin/* endpoint:
//  there isn't one. The real approval path is admin/redemption-verify.js
//  confirmVerify(), which runs in the admin SPA against Firestore directly.
//  Replicating its txn here means the spec exercises the same write shape
//  the customer's live listeners are designed to observe.
//
//  Required env (loaded from .env locally, GitHub Actions secrets in CI):
//   • TEST_EMAIL                     — dedicated e2e customer account
//   • TEST_PASS                      — password
//   • FIREBASE_SERVICE_ACCOUNT_JSON  — base64 of the service-account JSON
//
//  The test account MUST have balance ≥ 1000 going in. If it dips below at
//  the end of the test (cleanup race / failure), the next run starts with
//  the wrong precondition and the assertion at line ~80 fails fast with a
//  clear message instead of silently misbehaving.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect } from '@playwright/test';
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const REQUIRED_ENV = ['TEST_EMAIL', 'TEST_PASS'];
const REWARD_COST = 1000; // 5€ tier — smallest, fastest to reset
// Stable id for the dummy reward we upsert so the customer app has at least
// one active reward to render even on a project where the admin hasn't
// seeded ipear_rewards yet. Picked the legacy 1000-pt tier so the points/
// discount pair also passes the ladder branch of the Firestore rule.
const E2E_REWARD_DOC_ID = 'e2e_dummy_5eur';
const E2E_REWARD_PAYLOAD = {
  title: '5€ Έκπτωση (E2E)',
  cost: REWARD_COST,
  discount: 5,
  icon: '🧪',
  description: 'Auto-seeded by the golden-path E2E spec.',
  isActive: true,
  order: 1,
};

// Deterministic sync: the customer bundle shows the 6-digit code in the QR
// overlay the instant it generates it, then writes the ipear_redemptions doc
// via an async addDoc(). The server commit lands a few hundred ms later, so a
// single immediate Admin-SDK query by code can race ahead of it and see
// `empty:true` (the historical flake). Poll the authoritative server state
// until the doc exists instead of assuming instantaneous propagation. This
// does NOT weaken the assertion: if the doc never appears within the window the
// helper throws and the test fails with a clear, actionable message.
async function waitForRedemptionByCode(db, code, { timeoutMs = 20_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await db
      .collection('ipear_redemptions')
      .where('code', '==', code)
      .limit(1)
      .get();
    if (!snap.empty) return snap.docs[0];
    if (Date.now() >= deadline) {
      throw new Error(
        `Redemption doc for code ${code} never appeared in Firestore within ` +
        `${timeoutMs}ms — the customer-bundle addDoc() write was not observed ` +
        `server-side (real regression, not a timing allowance).`
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function ensureAdminApp() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    // Local/dev: explicit service-account JSON (base64).
    const sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    initializeApp({ credential: cert(sa), projectId: sa.project_id });
  } else {
    // CI: keyless Workload Identity Federation → Application Default Credentials.
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'loyalty-ipear',
    });
  }
}

test.describe('Golden path', () => {
  test.beforeAll(async () => {
    const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
    if (missing.length) {
      throw new Error(
        `Missing required env: ${missing.join(', ')}. ` +
        `Locally: add them to .env. In CI: add them as repo secrets and ` +
        `wire them in .github/workflows/ci.yml → e2e job.`
      );
    }
    ensureAdminApp();

    // Seed the catalog reward this spec exercises. Idempotent (merge: true)
    // so re-running the suite doesn't churn createdAt; setting isActive:true
    // unblocks the customer-app rewards listener from getting an empty
    // snapshot when a fresh project has no ipear_rewards docs yet.
    const db = getFirestore();
    await db.collection('ipear_rewards').doc(E2E_REWARD_DOC_ID).set(
      { ...E2E_REWARD_PAYLOAD, updatedAt: new Date().toISOString() },
      { merge: true }
    );
  });

  test.afterAll(async () => {
    // Best-effort cleanup. Leaving the doc in place between runs is fine
    // (it's clearly labelled "E2E"), but flipping isActive:false hides it
    // from real customers if the project ever gets pointed at a non-test
    // dataset. Keep the doc so re-runs don't recreate it from scratch.
    try {
      const db = getFirestore();
      await db.collection('ipear_rewards').doc(E2E_REWARD_DOC_ID).set(
        { isActive: false, updatedAt: new Date().toISOString() },
        { merge: true }
      );
    } catch (e) {
      console.warn('[golden-path] reward cleanup failed:', e?.message || e);
    }
  });

  // Per-attempt isolation: Playwright retries the test up to 2 times when it
  // fails. Each attempt's runTransaction drained 1000 pts and the cleanup
  // refunded 1000 — *usually* the balance returns to 1500. But under flaky
  // network / listener races on the customer page, the cleanup occasionally
  // wrote against a stale snapshot and left the balance below 1500. By
  // retry #2 the customer was at e.g. 299 → every assertion failed for
  // unrelated reasons.
  //
  // Earlier we also deleted leftover ipear_redemptions docs here, but that
  // caused a worse race: the customer's offline Firestore cache still held
  // the deleted "pending" redemption, so the UI's _findExistingActivePending
  // path served a stale 6-digit code on tap; the test then queried Firestore
  // for that code and got `empty=true` (the doc was gone). The redemption
  // cleanup INSIDE the test's `finally` block already handles the per-test
  // lifecycle correctly; we just need to reset points here.
  test.beforeEach(async () => {
    const db = getFirestore();
    const auth = (await import('firebase-admin/auth')).getAuth();
    let uid;
    try {
      const u = await auth.getUserByEmail(process.env.TEST_EMAIL);
      uid = u.uid;
    } catch {
      // First-ever run on a fresh project — let the test fail on login.
      return;
    }
    await db.collection('ipear_customers').doc(uid).set(
      { points: 1500, totalPoints: 1500, blocked: false },
      { merge: true },
    );

    // Deterministic precondition for the redemption flow: terminate any
    // lingering 'pending' redemption for the test customer BEFORE the page
    // loads. Each Playwright test gets a fresh browser context (no IndexedDB
    // carryover), so with zero server-side pendings the customer app's
    // _findExistingActivePendingByUser() returns null and the tap creates a
    // brand-new redemption doc — rather than the UI surfacing a stale pending
    // code whose doc state the test can't predict. We flip to a terminal
    // status instead of deleting: deleting raced the customer's offline cache
    // in earlier attempts; a status flip makes _isPendingAndActive() false and
    // keeps admin views clean. Two equality filters need no composite index.
    const pending = await db
      .collection('ipear_redemptions')
      .where('customerUid', '==', uid)
      .where('status', '==', 'pending')
      .get();
    if (!pending.empty) {
      const batch = db.batch();
      const nowIso = new Date().toISOString();
      pending.forEach((d) => batch.update(d.ref, { status: 'e2e-reset', used: true, usedAt: nowIso }));
      await batch.commit();
    }
  });

  // RE-ENABLED (Phase 22). The historical flake was a read-before-write race:
  // the single immediate Admin-SDK query by code outran the customer bundle's
  // async addDoc() server commit, plus stale 'pending' docs could surface a
  // cached code. Both are now handled deterministically WITHOUT weakening any
  // assertion:
  //   • beforeEach terminates lingering 'pending' docs before the page loads,
  //     so a fresh context always creates a new redemption on tap;
  //   • waitForRedemptionByCode() polls the authoritative server state until
  //     the doc exists (throws if it never does — still a hard requirement).
  // The subsequent balance/history assertions are unchanged.
  test('customer redeems 5€ reward + sees it land live in history', async ({ page }) => {
    const db = getFirestore();

    // ── 0. App Check debug-token shim (optional) ────────────────────────
    // If the Firebase project enforces App Check, reCAPTCHA v3 must
    // produce a valid token for every Firestore / Auth call. Headless
    // chromium can't pass the reCAPTCHA bot heuristics, so we set the
    // standard debug-token global BEFORE any page script runs. The
    // token must be registered in Firebase Console → App Check →
    // Manage debug tokens; only the registered string passes.
    // If APPCHECK_DEBUG_TOKEN is unset, this is a no-op and the test
    // relies on App Check being fail-open or disabled.
    if (process.env.APPCHECK_DEBUG_TOKEN) {
      await page.addInitScript((token) => {
        self.FIREBASE_APPCHECK_DEBUG_TOKEN = token;
      }, process.env.APPCHECK_DEBUG_TOKEN);
    }

    // ── 1. Login ─────────────────────────────────────────────────────────
    await page.goto('/');
    await page.locator('#phone-in').fill(process.env.TEST_EMAIL);
    await page.locator('#auth-pass').fill(process.env.TEST_PASS);
    await page.locator('#phone-btn').click();

    // ── 2. Hero pts visible + ≥ threshold ────────────────────────────────
    // Hero number animates via _animateNumber — poll until it shows the
    // target balance instead of asserting a single textContent snapshot.
    await expect(page.locator('.hero-pts')).toBeVisible({ timeout: 30_000 });
    const startingBalance = await expect
      .poll(
        async () => {
          const txt = await page.locator('.hero-pts').innerText();
          return parseInt(txt.replace(/\D/g, ''), 10) || 0;
        },
        { timeout: 20_000, intervals: [400, 800, 1500] }
      )
      .toBeGreaterThanOrEqual(REWARD_COST)
      .then(async () => {
        const txt = await page.locator('.hero-pts').innerText();
        return parseInt(txt.replace(/\D/g, ''), 10);
      });

    // ── 3. Rewards tab + tap the first unlocked card (5€ = 1000 pts) ─────
    await page.locator('#nav-rewards').click();
    const firstUnlocked = page.locator('.rw-full-card.ok').first();
    await expect(firstUnlocked).toBeVisible({ timeout: 10_000 });
    await firstUnlocked.click();

    // ── 3b. Channel choice ──────────────────────────────────────────────
    // E-shop-eligible rewards (startRedemption → _showRewardChannelChoice when
    // spec.eshopEligible && no channel) open an in-store/e-shop picker BEFORE
    // the QR overlay; non-eshop rewards go straight to it. Deterministically
    // wait for whichever appears, and if it's the picker, choose in-store to
    // reach the QR overlay. This exercises the real redemption UX (not a
    // weakened assertion or an added timeout).
    const inStoreBtn = page.locator('[data-action="_redeemChannel"][data-arg3="instore"]');
    await expect(inStoreBtn.or(page.locator('#redeem-overlay'))).toBeVisible({ timeout: 10_000 });
    if (await inStoreBtn.isVisible()) {
      await inStoreBtn.click();
    }

    // ── 4. Read the 6-digit code from the QR overlay ────────────────────
    await expect(page.locator('#redeem-overlay')).toBeVisible({ timeout: 10_000 });
    const codeText = await page.locator('#ro-code').innerText();
    const code = codeText.replace(/\s/g, '');
    expect(code, 'code should be 6 digits').toMatch(/^\d{6}$/);

    // ── 5. Approve via Admin SDK (mirrors confirmVerify atomic txn) ─────
    // Deterministic wait for the client addDoc() to land server-side (replaces
    // the former single-shot get() that raced the write). Still a hard
    // requirement: throws if the doc never appears.
    const redDoc = await waitForRedemptionByCode(db, code, { timeoutMs: 20_000 });
    const red = redDoc.data();
    const custDocId = red.customerUid || red.customerId;
    const custRef = db.collection('ipear_customers').doc(custDocId);
    const ledgerId = `e2e_verify_${redDoc.id}`;
    const nowIso = new Date().toISOString();

    let drainedPoints = 0; // remembered for cleanup
    try {
      await db.runTransaction(async (txn) => {
        const custSnap = await txn.get(custRef);
        if (!custSnap.exists) throw new Error('Customer doc missing');
        const cust = custSnap.data();
        const debit = red.points || REWARD_COST;
        drainedPoints = debit;
        const newPts = (cust.points || 0) - debit;
        if (newPts < 0) throw new Error('Insufficient points for the test');

        txn.update(redDoc.ref, { used: true, status: 'used', usedAt: nowIso });
        txn.update(custRef, { points: newPts });
        txn.set(
          db.collection('ipear_transactions').doc(ledgerId),
          {
            customerId: red.customerId,
            customerUid: red.customerUid || cust.uid || '',
            customerEmail: cust.email || '',
            customerName: red.customerName || cust.name || '',
            card: red.card || cust.card || '',
            type: 'redeem',
            points: -debit,
            discount: red.discount || 5,
            label: red.label || 'Έκπτωση 5€',
            redemptionCode: code,
            method: 'e2e-test',
            date: nowIso,
          }
        );
      });

      // ── 6. Redemption overlay should auto-close on status:'used' ──────
      await expect(page.locator('#redeem-overlay')).toBeHidden({ timeout: 10_000 });

      // ── 7. Header balance drops by exactly REWARD_COST ────────────────
      await expect
        .poll(
          async () => {
            const txt = await page.locator('.hero-pts').innerText();
            return parseInt(txt.replace(/\D/g, ''), 10) || 0;
          },
          { timeout: 15_000 }
        )
        .toBe(startingBalance - REWARD_COST);

      // ── 8. Profile → first history row says "Έκπτωση" ─────────────────
      await page.locator('#nav-profile').click();
      const firstHistRow = page.locator('#pr-history .hist-item').first();
      await expect(firstHistRow).toBeVisible({ timeout: 15_000 });
      await expect(firstHistRow).toContainText(/Έκπτωση/);
    } finally {
      // ── Cleanup — refund + remove ledger row + reset redemption ──────
      // Best-effort: any branch failure must not leak state into the next
      // run. If cleanup itself fails (very rare), the precondition check
      // at step 2 will catch it next time with a clear error.
      if (drainedPoints > 0) {
        try {
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(custRef);
            if (!snap.exists) return;
            const cur = snap.data();
            txn.update(custRef, { points: (cur.points || 0) + drainedPoints });
          });
        } catch (e) {
          console.warn('[golden-path] refund failed:', e?.message || e);
        }
      }
      // Delete the e2e ledger row + flip the redemption doc back to a
      // terminal-but-distinct state so it doesn't pollute admin views.
      await Promise.allSettled([
        db.collection('ipear_transactions').doc(ledgerId).delete(),
        redDoc.ref.update({ status: 'e2e-cleanup', used: true, usedAt: nowIso }),
      ]);
    }
  });
});
