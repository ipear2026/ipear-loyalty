# iPear Loyalty — Consolidated Phase Report
## Track A (security identity migration) + Track B (UI/UX product audit)

**Date:** 2026-10-08. Tracks kept separate; **no deployment performed**; Stage-2/Admin-Fortress security untouched.

---
# TRACK A — WORKER SERVICE-ACCOUNT MIGRATION

1. **Status:** **MIGRATION INCOMPLETE — OWNER/GCP ACTION REQUIRED.** Design, exact capability inventory, least-privilege permission set, keyless assessment, and gitignore hardening are complete and tested. Full doc: [SECURITY-WORKER-SERVICE-ACCOUNT-MIGRATION.md](SECURITY-WORKER-SERVICE-ACCOUNT-MIGRATION.md) (11 required sections present).
2. **Exact blocker:** creating the SA/custom role/key and revoking keys needs **GCP IAM-admin** access this session lacks (firebase-tools token → 403 on IAM; no `gcloud`; `wrangler` currently on the wrong account). Read-only cloud key listing is therefore unavailable here.
3. **Ready runbook:** dedicated SA `ipear-loyalty-worker@loyalty-ipear` with `roles/datastore.user` + `roles/firebaseauth.admin` (or a tighter custom role excluding claim-setting), token scope narrowed to `identitytoolkit datastore`; one key piped straight into the Cloudflare `FCM_PRIVATE_KEY` secret; cutover → verify → stability gate → revoke old key → delete local JSON. Exact `gcloud`+`wrangler` commands are in the doc.
4. **Risk severity:** the broad default Admin SDK key remains the system's highest-value secret (bypasses Firestore rules, can set `admin:true`). Local exposure is **low** (single copy in Downloads, never git-committed), so there is no emergency — but it should be migrated.
5. **Action required from owner:** provision the SA+key (or grant tooling), then I drive the cutover + verification as a **separate change window** (never bundled with UI/UX deploys).

**No old key revoked, no Worker auth changed, no `FCM_*` secret touched.**

---
# TRACK B — UI/UX PRODUCT AUDIT

Scope note: code-level audit of `customer` / `tablet` / `admin` in the canonical worktree, plus the two P0s reproduced with automated tests. Live multi-device/Safari/PWA passes are flagged where they still need a real-device session.

## 6. Leaderboard — PROVEN root cause (P0, FIXED)
**Reproduced deterministically** in [tests/leaderboard-ui.test.js](tests/leaderboard-ui.test.js). Two compounding defects in `loadLeaderboard()`:
- **`if (_lbUnsub) return;`** made every call after the first a no-op. When the Profile container was re-painted to its static skeleton, re-opening Profile never re-rendered → the visible `#lb-container` stayed on the skeleton.
- The `onSnapshot` callbacks **captured `el`** at subscribe time; after a re-render that node is detached, so a late first snapshot wrote to a dead node while the visible skeleton persisted. If the **first snapshot never arrived** (auth/App-Check race, dropped socket) there was **no timeout and no retry** → infinite "Φόρτωση…".
**Fix (implemented):** resolve the element fresh on every callback; re-entry while subscribed re-renders cached data (or the correct loading/empty) into the current node; a bounded **10 s watchdog** converts a never-arriving first snapshot into an explicit **RETRY** state; `_retryLeaderboard()` tears down cleanly (no duplicate listeners) and re-subscribes; `stopLbListener()` clears the watchdog. State machine is now **LOADING → SUCCESS | EMPTY | ERROR+RETRY** — infinite loading is impossible. (Root cause is the lifecycle defect; the watchdog is a safety net, not the fix.)
- **"LIVE" badge:** low customer value (it only signals real-time). Recommend **removing** it (P2) — it reads as engineering noise next to "Κορυφαίοι Πελάτες". Left in place pending your nod (one-line HTML removal).

## 7. Transaction labels — root cause (P0, FIXED)
`history-ui.js` rendered the raw stored `tx.category`/`tx.note` directly, with English hardcoded fallbacks (`🎁 Referral Bonus`, `Tier Downgrade`). Those stored strings include English/legacy wording written by admin/worker (e.g. `🎁 Referral Bonus`, `🎁 Marketing Bonus`, legacy `Admin Adjustment`). **Fix (implemented):** one centralized normalizer [src/customer/ui/tx-labels.js](src/customer/ui/tx-labels.js) (`cleanTxLabel` + `txLabel` + `TYPE_LABEL`), wired into every label branch of the customer history. Handles legacy English, snake_case enums, emoji prefixes, case/spacing; preserves already-Greek categories and reward titles; safe generic Greek for unknowns; **never mutates historical docs**. 24 unit tests in [tests/tx-labels.test.js](tests/tx-labels.test.js) cover every required example (`Admin Adjustment`/`admin_adjustment`→Προσαρμογή πόντων, `Referral Bonus`/`referral_bonus`→Μπόνους σύστασης, `purchase`→Αγορά, `birthday_bonus`→Δώρο γενεθλίων, redemption/refund variants). **Other customer surfaces audited:** Woo My-Account returns only `{name,points,totalPoints,card}` (no tx list → no raw labels); no customer push/email renders categories. So the customer PWA history was the only leak.

## 8. Customer app findings
- **(FIXED)** raw transaction labels; **(FIXED)** leaderboard infinite spinner.
- **P2** "Περισσότερα... (+N)" toggle label reads technical; "Προβολή περισσότερων" / "Λιγότερα" is cleaner (copy-only).
- **P2** transaction row: label vs date vs amount hierarchy is adequate but emoji-in-label + icon chip is slightly redundant; the amount color (green/red) carries meaning by color only (see a11y).
- **P2** mixed empty-state styles exist (`.empty-state--compact` vs ad-hoc inline tier card in the leaderboard error path) — consolidate on the `.empty-state` component.
- **P3** several Greek labels mix casing ("Εκπνοή Πόντων" vs "Εκπνοή πόντων") — normalized the ones in the history path; a global sweep is recommended.

## 9. Tablet findings (operator tool) — code-level
- **P1 (needs owner confirm)** verify tap-count of the core cashier flow (search → identify → credit/redeem) on a real device; the manual-search + QR paths exist but weren't timed live this session.
- **P2** confirm every confirm/submit button has a disabled/loading lock to prevent accidental double-submit (financial writes are server-idempotent, so this is UX not integrity).
- **P2** ensure no backend terminology surfaces to employees (the tx-label normalizer is customer-only; the tablet's own redemption labels should be checked).
- Needs a **live tablet portrait/landscape pass**.

## 10. Admin app findings (owner tool) — code-level
- Admin bundle **unchanged** by this phase. Classification recommended (not yet executed — needs usage evidence): most dashboard/customer/offers/messaging controls = **ESSENTIAL/USEFUL**; **worker-health / diagnostics** surfaces = move under an **"Advanced / Diagnostics"** area (P2); re-audit for any **legacy secret/worker-secret UI** now that the Worker is master-secret-free (the owner-auth flag hides the secret field, but confirm no stale control remains) (P1 to verify).
- **Do not remove** any control without control-flow proof it is unused.

## 11. Unnecessary UI identified (candidates — not yet removed)
| What | Where | Why | Evidence needed before removal |
|---|---|---|---|
| "LIVE" badge | customer Profile leaderboard header | no customer value | none — pure cosmetic, safe (P2) |
| legacy worker-secret field | admin notifications/settings (under flag) | Worker is master-secret-free | confirm flag-ON hides it in prod build (owner-auth bundle) |
| advanced diagnostics mixed into admin | admin | clutters owner workflow | move, don't delete |

## 12. Language/copy findings
- Customer transaction labels: **fixed** to natural Greek via the shared map.
- Residual English fragments live in **stored** categories (historical docs) — now normalized at render; **recommend** switching the admin/worker write-sites (`dashboard-ops.js`, `customers-crud.js`, `birthday-claims.js`, `email-worker.js`) to write Greek categories going forward so the data itself is clean (P2, low risk, additive).
- Casing consistency sweep recommended (P3).

## 13. Async-state findings
- Leaderboard: **now** LOADING/SUCCESS/EMPTY/ERROR+RETRY.
- History: has skeleton + pagination; confirm an explicit **error/retry** state on query failure (P2).
- Offers/Rewards listeners: confirm empty + error states (P2 — not deeply audited this pass).
- No raw Firebase/HTTP errors are shown in the paths audited.

## 14. Responsive / accessibility findings (need a live-device pass)
- **A11y P1:** transaction +/− amounts communicate by **color only** (green/red) — add a sign/sr-only label (the `+`/`−` glyph already present helps; ensure it's not purely color).
- **A11y P2:** verify focus states + 44px touch targets on the leaderboard "Δοκίμασε ξανά" and history toggle buttons; verify `prefers-reduced-motion` disables the leaderboard `pulse` and skeleton shimmer.
- **Responsive P1:** iPhone Safari safe-area + installed-PWA bottom-nav overlap, tablet portrait/landscape — not verifiable headlessly here; needs a device/Browser-pane pass.

## 15. Performance findings
- Leaderboard previously could leak/retain a stale listener across re-renders; the fix adds clean unsubscribe + no-duplicate re-subscribe (small correctness+perf win).
- `_customerKeepAlive` re-invokes several listeners on resume — confirm each has the same no-duplicate guard the leaderboard now has (P2).
- No duplicate Firestore reads introduced; tx normalization is pure/synchronous.

## 16. Fixes implemented
**P0:**
- ✅ Centralized customer transaction-label normalizer + wired into history.
- ✅ Leaderboard lifecycle fix + watchdog + retry + clean unsubscribe (no listener stacking).
**P2 safe polish (this window):**
- ✅ Removed the customer "LIVE" badge from the leaderboard header (`index.html`).
- ✅ History expansion copy `Περισσότερα... (+N)` → **`Προβολή ακόμη N`**.
- ✅ Greek-ified remaining customer-facing "leaderboard" wording → **"κατάταξη"** (empty/DEMO states + skeleton `aria-label`).
- ✅ Final customer copy pass: no English/backend terms remain in `src/customer` user-facing strings.
**Tests/quality:** 31 new tests (24 tx-labels + 7 leaderboard incl. listener-stacking QA); full suite **555/555**; rules **63/63**; locked **15/15**; build clean; lint clean; no secrets/source-maps. Admin bundle byte-identical; Worker/rules/functions untouched.

## 16a. Device / responsive QA (live, this window)
Ran the production build in the Browser pane.
- **Customer** @375px (iPhone Safari-sized): login shell renders clean, centered card, `#8AE900` CTA, natural Greek, **no overflow**.
- **Tablet** @768px: operator login clean; an "Online" connectivity badge (appropriate for a store device, unlike the removed customer "LIVE" badge).
- **Admin** @desktop: ADMIN PANEL login clean, no overflow.
- **Console:** the only error is a **pre-existing** stale SRI `integrity` hash on the `canvas-confetti` CDN script → the script is **blocked** (celebration confetti won't load). **Not caused by this phase.** Fix = update/remove the integrity hash (P2).
- **Minor:** admin shows an "unknown" version badge (env var unpopulated) — cosmetic (P3).
- **Limitation:** profile/leaderboard/history, the tablet operator flow, and admin dashboards are **auth-gated** (Firebase + App Check + real credentials) and cannot be exercised headlessly here — a **real-session device pass remains an open P1** for those authenticated screens. The leaderboard state machine itself is fully covered by the automated regression harness.

## 16b. Listener QA (leaderboard) — verified in the harness
No duplicate listeners: repeated `loadLeaderboard()` (profile re-entry / keepalive) keeps **exactly one** active subscription (`subscribe=1`), nothing leaks (`unsub=0`); `_retryLeaderboard()` tears down exactly once then re-subscribes once (`unsub=1, subscribe=2`); `stopLbListener()` unsubscribes exactly once; the watchdog is cleared on success/error/teardown. No extra Firestore reads introduced (normalization is pure/synchronous).

## 16c. Admin IA proposal — LIST ONLY (owner review required; NOT restructured)
Proposed "Advanced / Diagnostics" grouping, to move **after** your approval (no control deleted, no business op moved):
| Control | Evidence it is diagnostic/developer-oriented | Proposed home |
|---|---|---|
| Worker health / deep-health panel (`src/admin/worker-health.js`) | pings infra, not a business task | Advanced → Diagnostics |
| Worker URL / connection test controls | infra configuration | Advanced → Diagnostics |
| Any legacy worker-secret field (if still rendered) | Worker is master-secret-free; owner-auth build should hide it | remove after confirming flag-ON hides it |
| Raw export / backup download internals | power-operation, rare | Advanced → Data |
**Proposed top-level Admin IA (business-first):** Dashboard · Customers · Points/Rewards/Offers · Referrals · Birthdays · Messaging (Email/SMS) · Maintenance · **Advanced (Diagnostics / Data / System)**. Normal daily owner tasks stay top-level; infra/diagnostics collapse into Advanced. **No change applied** — this is for your sign-off.

## 17. Fixes requiring owner approval / a follow-up change
- Remove the "LIVE" badge (cosmetic).
- Move admin diagnostics into an "Advanced" area; audit/remove any legacy secret UI (needs usage evidence).
- Switch admin/worker category **write-sites** to Greek (additive, improves stored data).
- Copy change "Περισσότερα... (+N)" → "Προβολή περισσότερων".
- Live-device responsive/a11y pass (Safari/PWA/tablet).
- Any structural redesign (none proposed yet — would be reported first).

## 18. Scores (strict) — three distinct states
**A = ORIGINAL PRODUCTION** (before the P0 fixes) · **B = CURRENT REVIEWED BUILD** (after implemented P0 + safe P2) · **C = TARGET** (after remaining owner-approved P1/P2).

**Customer app** (A → B → C): Visual 7→7→8 · UX clarity 6→7→8 · Navigation 7→7→8 · Consistency 6→8→8 · Copy/language **5→8→9** · Async states **5→8→9** · Mobile polish 6→7→8 · Perceived speed 7→8→8.
**Tablet** (A → B → C): Speed 7→7→8 · Clarity 7→7→8 · Error prevention 6→6→8 · Touch usability 7→7→8 · Workflow efficiency 6→6→8 · Visual polish 6→7→7. *(B unchanged — tablet not modified this phase; needs live operator pass.)*
**Admin** (A → B → C): IA 6→6→8 · Workflow efficiency 7→7→8 · Clarity 6→6→8 · Safety 9→9→9 · Visual polish 6→6→7 · Clutter (higher = less) 5→5→8. *(B unchanged — admin not modified; IA proposal pending.)*
**System-wide** (A → B → C): Design consistency 6→7→8 · UX consistency 6→8→8 · Production readiness 7→8→9 · Accessibility 5→5→7 · Overall polish 6→7→8.

## 19. Overall iPear Loyalty product score (three states)
- **A — Original production: 6.1 / 10** (two live P0 defects: raw English labels + infinite leaderboard spinner).
- **B — Current reviewed build: 7.3 / 10** (both P0s fixed, customer copy/async polished, badge/copy cleanup; tablet & admin unchanged this phase).
- **C — Target after owner-approved P1/P2: 8.3 / 10** (live-device a11y/responsive pass on authenticated screens, admin IA declutter, tablet operator pass, confetti SRI fix).

The **8.3** is **projected**, not current; the **current** reviewed-build score is **7.3**.

## 20. Priority table
| ID | Surface | Issue | Impact | Pri | Fix | Risk | Effort |
|---|---|---|---|---|---|---|---|
| P0-1 | Customer/history | raw English/backend tx labels shown to customers | trust/brand | P0 | centralized normalizer (**done**) | low | done |
| P0-2 | Customer/Profile | leaderboard infinite "Φόρτωση…" | feature unusable | P0 | lifecycle fix + retry (**done**) | low | done |
| P1-1 | Admin | audit/remove any legacy worker-secret UI | confusion/stale | P1 | verify flag-hidden, remove if dead | med | S |
| P1-2 | Customer | amount meaning is color-only | a11y | P1 | ensure sign/sr-only label | low | S |
| P1-3 | Tablet/Customer | live Safari/PWA/tablet safe-area pass | layout breakage | P1 | device/Browser-pane QA | low | M |
| P2-1 | Customer | remove "LIVE" badge | noise | P2 | delete markup (**done**) | low | done |
| P2-2 | Customer | history copy "Περισσότερα... (+N)" | clarity | P2 | → "Προβολή ακόμη N" (**done**) | low | done |
| P2-3 | Customer | "leaderboard" English in states | consistency | P2 | → "κατάταξη" (**done**) | low | done |
| P2-4 | Customer | confetti CDN stale SRI hash → blocked | missing celebration | P2 | update/remove integrity hash | low | XS |
| P2-5 | Admin | diagnostics mixed into business UI | clutter | P2 | "Advanced" section (**proposed, §16c**) | med | M |
| P2-6 | Data | write Greek categories at source | clean data | P2 | edit write-sites | low | S |
| P2-7 | Customer | history error/retry state | async polish | P2 | add error branch | low | S |
| P3-1 | Admin | "unknown" version badge | cosmetic | P3 | populate/hide | low | XS |
| P3-2 | Customer | Greek casing/copy sweep | polish | P3 | copy pass | low | S |

---
## 16d. Predeploy window (2026-10-08) — confetti SRI + deploy gate
- **Confetti SRI root cause:** the integrity hash in `index.html` **matched** the served file (verified: `sha384-sPwMfl…` == computed) — the block was a **transient CDN/CORS failure**, not a stale hash. **Fix:** self-hosted the exact pinned, SHA-384-verified `canvas-confetti@1.9.3` at `public/vendor/confetti-1.9.3.min.js` and reference it **same-origin** (no CDN/SRI/CORS failure mode). Commit `870cd45`.
- **Service-worker cache:** bumped `CACHE_VER` → `v74` so returning clients drop the cached `index.html`/bundle and receive this build + the prior label/leaderboard fixes. (Found via QA: the SW was serving a cached page — without the bump the deploy would not reach existing users.)
- **Build/tests:** vitest **555/555**, rules **63/63**, locked **15/15**, lint clean, no maps/secrets; admin/tablet bundles byte-identical; Worker/rules/functions/plugin untouched.
- **DEPLOYED (2026-10-08):** after owner re-auth to the correct account (`ipear2026@gmail.com` / `f02bde005d8c8f63cf76a9f7a1c9ee3f`), deployed to Cloudflare Pages **`ipear-loyalty` / branch `main` (Production)**.
  - **Deployment:** `f123be10` (`https://f123be10.ipear-loyalty.pages.dev`), source HEAD `870cd45`.
  - **Bundles:** customer `assets/main-BS8ApiFA.js` sha256 `6831e638…`; admin `assets/admin-DKanSCzM.js` sha256 `497bd674…` (**unchanged filename**); tablet `assets/tablet-BKe1cKHP.js` sha256 `9845ed5b…`; vendor `vendor/confetti-1.9.3.min.js` sha256 `cfc4a191…`.
  - **Passive live smoke (PASS):** `loyalty.ipear.gr` / `/admin` / `/tablet` → **200**; `/vendor/confetti-1.9.3.min.js` → 200; **zero** jsdelivr-confetti references; SW `CACHE_VER=v74`; live `window.confetti === 'function'` (old SRI block gone); **no console errors**; admin owner-auth flag **ON**, financial flag **ON**.
  - **Post-deploy security (PASS):** Worker version `c7bd0b6f` unchanged; `ADMIN_SECRET` bindings = **0**; `firestore.rules` `10df4875…` unchanged; 5 fortress functions + Woo 2.5.4 untouched; no credential changes.
- **Live score:** the deployed P0/P2 fixes move the **current LIVE score to ~7.3/10** (customer-facing); **target 8.3/10** after the remaining owner-approved P1/P2 (authenticated-session a11y/responsive pass, admin IA, confetti already done). Full-confidence re-score of the authenticated screens awaits the owner's live customer QA.

# FINAL STATUS (tracks separated)

**SECURITY IDENTITY MIGRATION: MIGRATION INCOMPLETE — OWNER/GCP ACTION REQUIRED.**

**UI/UX PRODUCT AUDIT: COMPLETE** (both P0 root causes proven + fixed with tests; safe P2 polish implemented; live responsive QA on all three shells; full suite + build + scans green; current reviewed-build score 7.3/10). Remaining items are owner-approved P1/P2 (live-session a11y/responsive pass on authenticated screens, admin IA declutter, tablet operator pass, confetti SRI) — none blocking a customer-bundle deploy.

## CUSTOMER UI DEPLOYED — OWNER AUTHENTICATED QA REQUIRED
Deployed to Cloudflare Pages Production (`ipear-loyalty`/`main`), deployment `f123be10`, source `870cd45`. Passive smoke + post-deploy security all green; admin/tablet bundles unchanged; Worker/rules/functions/Woo-plugin untouched; Track A Worker identity migration **not** touched (remains MIGRATION INCOMPLETE). **Remaining:** an owner-run authenticated-customer QA on production (profile/history/leaderboard) — no financial mutations — to visually confirm the normalized labels, `Προβολή ακόμη N`, leaderboard states/retry, and no stale UI.
