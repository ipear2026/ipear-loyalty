# iPear Loyalty — ADMIN FORTRESS · STAGE 2 (controlled server cutover)

**Date:** 2026-10-03 · **Role:** Security Architect · **Mode:** controlled cutover. No Stage 3, no ADMIN_SECRET/Woo-secret change, no Cloudflare Access, no destructive production financial testing, no owner terminal interaction.
**Base:** branch `fix/signup-error-classification`, HEAD `f2af48b` (+ uncommitted Stage 0/1/2). Rollback ref `c179014`.

> **STATUS (updated 2026-10-06): ✅ ADMIN FORTRESS STAGE 2 COMPLETE — SERVER IS SOLE FINANCIAL WRITER.** The §6b financial Firestore lock is LIVE (ruleset `19a4c34b-4610-48a7-b6c5-fe623e339b3e`, source byte-identical to the reviewed `firestore.rules.locked`, sha256 `10df4875…`). No browser client — including a valid admin session — can directly mutate loyalty financial state. See **§LOCK** below for the full cutover record.
>
> _(Earlier: READY FOR FINAL FIRESTORE LOCK.)_ The flag-ON frontend is LIVE (Pages prod `217af082`, source `f2af48b`, `VITE_ADMIN_SERVER_FINANCIAL:"1"`, byte-verified), all 5 server financial callables are ACTIVE (incl. the new **`adminDeleteCustomer`** lifecycle function), and the final pre-lock blocker — the browser customer-deletion cascade that deleted `ipear_transactions` — is eliminated. Two independent scans agree: **active browser financial writers = 0, ledger client update = 0, ledger client delete = 0, referral authorities = 1.** Financial evidence is now preserved on deletion (ledger anonymized-and-retained server-side). The §6b lock remains emulator-PROVEN (`firestore.rules.locked`, sha256 `10df4875…`, 15/15) and is **not yet deployed** (as instructed). See **§LC** below for the full lifecycle deliverable.
>
> _(Prior banner, now historical: Step 3 frontend deploy was blocked on a Cloudflare credential; resolved 2026-10-05 via owner `wrangler login` to account `f02bde…`; flag-ON frontend deployed `71f1b3b8` then `217af082`.)_
>
> **TIER-AUTHORITY: RESOLVED** — canonical ladder = **Bronze 0 / Silver 1000 / Gold 3000 / Diamond 6000 / Platinum 10000** (§7).
> **REFERRAL-AUTHORITY: RESOLVED (Option A)** — single authority = Worker `/process-referral` (§5c).

---

## 1. Owner UID authority / source — RESOLVED
- **Authoritative source:** production `ipear_admins` (read-only via firebase-tools/IAM) cross-checked against Firebase Auth. Three records: one live admin (`g7YT…QojT2 (owner UID — redacted)` → `a***@ipear.gr`, verified), one **orphan** admin doc (`UIq98…`, no Auth account — cannot log in), one tablet kiosk.
- **Owner confirmed (by you):** sole owner = `g7YT…QojT2 (owner UID — redacted)`.
- **Configured:** `OWNER_UIDS=g7YT…QojT2 (owner UID — redacted)` set **server-side only** in `functions/.env` → baked into the function's `serviceConfig.environmentVariables` (verified present, value matches). Not in the bundle, not in Firestore, fail-closed if absent.
- **Cleanup flagged (not actioned):** the orphan admin doc `UIq98…` should be removed.

## 2. Deployed backend components — DEPLOYED (dormant) + VERIFIED
| Component | Status |
|---|---|
| `admin_audit` append-only Firestore rule | **deployed** (additive; `released rules … Deploy complete`). No financial lock. |
| `adminAdjustPoints` (gen2, europe-west1) | **deployed, state ACTIVE** (new function; `Successful create operation`) |
| owner gate + `admin_audit` writes + security events | in the deployed source (byte-verified) |

**Deploy channel:** firebase CLI from the clean workspace, logged-in account, `compute.googleapis.com` reachable — **no hang** this time (unlike Phase 2). Only `adminAdjustPoints` created; **no other function changed**.

## 3. Exact function revisions
- `adminAdjustPoints(europe-west1)` — **created**, state ACTIVE, runtime nodejs20, entryPoint `adminAdjustPoints`, updateTime `2026-10-02T09:58:48Z`.
- `approveredemption-00003-dor` — unchanged (not redeployed).
- Live ruleset — updated (adds `admin_audit`); M1 + all prior rules intact; **financial writes NOT locked**.

### 2.2 Deployment verification (all green)
- `state: ACTIVE`; runtime/entryPoint correct.
- `OWNER_UIDS` present in `serviceConfig` env **and matches** the owner UID; **server-side only** (absent from the web bundle).
- Deployed-source byte-check: `_requireOwner`, `checkOwner`, `adj_<key>` idempotency, `planAdjustment` (authoritative calc), `enforceAppCheck`, `admin_audit` write — **all present**.
- **Non-mutating live gate check:** unauthenticated call → **401 UNAUTHENTICATED** (proves live + App-Check/auth gated; **no mutation performed**).

## 4. Migrated financial paths (this increment)
| Path | File | Server target | State |
|---|---|---|---|
| Manual **add / subtract / correct** | `customer-points.js` | `adminAdjustPoints` | **deployed + verified** (flag-gated, OFF) |
| Point **expire** (zero) | `maintenance.js` `executeExpirePoints` | `adminBatchMaintenance` op `expire` | coded + unit-tested (flag-gated); callable **coded, not yet deployed** |
| **Tier-downgrade** | `maintenance.js` `executeTierDowngrade` | `adminBatchMaintenance` op `tier_downgrade` (canonical ladder) | coded + boundary-tested (flag-gated); callable not yet deployed |
| **Ledger DELETE** (orphan cleanup) | `system-health.js` `deleteOrphanTxs` | **redesigned** → append-only (see §7b) | neutralized when flag ON (no client delete) |

All use `isServerFinancialEnabled()` early-return → mutually exclusive with legacy, rollback-safe.

### 7b. Ledger-delete redesign (2E)
`deleteOrphanTxs` bulk-deleted a customer's `ipear_transactions` from the browser (financial-evidence deletion). When the flag is ON it now **refuses** (financial ledger is append-only) and directs GDPR personal-data removal to the existing **anonymization** flow (`gdpr.js`), which scrubs PII while preserving the immutable financial evidence. The rule lock (step 8) enforces this at the data tier. (A fuller orphan-metadata/remediation-record system is a follow-up; the security invariant — no browser ledger deletion — is met by neutralization + the lock.)

## 5. EXHAUSTIVE Gate-4 scan — browser financial writers (corrected)
A whole-`src/` scan for `_runTransaction`/`runTransaction`/`writeBatch`/`_updateDoc`/`_setDoc` touching `points`/`totalPoints`/`referralCount`/`ipear_transactions` found **more writers than my earlier narrower scans** (which only covered 5 files). Honest correction: my previous "0 browser writes" status was **incomplete**.

| File | Kind | Flag-ON state |
|---|---|---|
| `customer-points.js` | manual add/subtract/correct | ✅ gated → `adminAdjustPoints` |
| `maintenance.js` | expire / tier-downgrade | ✅ gated → `adminBatchMaintenance` |
| `customers-crud.js` | referral-on-create + birthday | ✅ gated (referral: no credit, `referredBy` kept; birthday → `adminBirthdayCredit`) |
| `dashboard-ops.js` | referral queue | ✅ gated → no-op |
| `system-health.js` | ledger delete | ✅ gated → refused (append-only) |
| **`birthday-claims.js`** | birthday-claim +50 processor | ✅ **now gated → no-op** — redundant duplicate of the **`validateBirthdayClaim` CF** (which already validates+credits+marks processed server-side); retiring it also removes a latent double-credit |
| **`approvals.js`** | offer-approval `pending_approval` → credit | ✅ **now gated → refuse** — **dead path** (`pending_approval` is written nowhere; queue always empty); real approval = tablet→`approveRedemption` |
| **`redemption-verify.js`** | admin 6-digit code verify → reward DEBIT / offer CREDIT | ✅ **now gated → `adminVerifyRedemption`** (server CF; see §5e) |
| `tablet/approval-flow.js` | — | ✅ already server-authoritative (`httpsCallable` → `createRedemptionRequest`/`approveRedemption`); no direct writes |
| `services/firebase.js` | — | ✅ SDK re-export wrapper, not a writer |
| `leaderboard.js` | writes `ipear_leaderboard/latest` only | ✅ **category C — non-financial** (denormalized display snapshot; reads customers, never writes `points`/`ipear_transactions`) |

## 5d. Two-method exhaustive scan (§13/§14) — reconciled → **0 active**
- **Method 1 (primitive grep):** every `src/` file with `runTransaction`/`writeBatch`/`setDoc`/`updateDoc`/`addDoc`/`deleteDoc` + a financial token. Flagged all 8 admin writers (**all flag-gated**) + `leaderboard.js` + `services/firebase.js`.
- **Method 2 (semantic):** direct writes to `ipear_transactions` / `ipear_customers.points`/`totalPoints`. Flagged the 8 admin writers only.
- **Disagreement:** `leaderboard.js` (Method 1 only). **Investigated → category C** (writes `ipear_leaderboard/latest`, a display snapshot; never financial state). Reconciled.
- **Classification:** 8 admin writers = **B** (flag-gated, unreachable with flag ON); `tablet/approval-flow.js` = **D** (callable); `services/firebase.js` = **E** (wrapper); `leaderboard.js` = **C** (non-financial).
- **ACTIVE browser-authoritative financial writers (flag ON) = 0.** Legacy code retained only behind the OFF branch (rollback).

## 5e. `adminVerifyRedemption` — server-authoritative code verify (replaces redemption-verify.js)
- **Old browser behavior (mapped):** `verifyCode` looks up a 6-digit code in `ipear_redemptions` (reward) then `ipear_offer_redemptions` (offer); `confirmVerify` debits the **catalog-trusted** reward cost (re-read `ipear_rewards`, isActive check) and marks the code used; `confirmOfferVerify` credits the **offer's** `bonusPoints` (re-read `ipear_offers`, active check — ignores the doc's value) and marks used. Deterministic ledger ids (`redeem_verify_*`/`offer_verify_*`); replay guard = the `used` flag.
- **New CF `adminVerifyRedemption({ code })`:** owner-gated + admin claim + App Check + kill-switch; server resolves the code → reward/offer → customer; **reward** = catalog-trusted debit (insufficient-balance rejected); **offer** = `canonicalOfferValue()` credit (the SAME helper `canonicalOfferCredit` uses → **H1 inflation protection preserved**; an inflated doc `bonusPoints` is ignored). One transaction: validate code state + reward/offer + customer, mark used, update balance, write ledger + immutable `admin_audit`. **Idempotency** tied to the redemption doc id (deterministic `redeem_verify_<id>`/`offer_verify_<id>` + `used` flag; duplicate/replay/concurrent → one effect). Generic external errors (no customer-existence leak).
- **Shared logic (§12):** `canonicalOfferValue` factored out of `offer-credit.js` and used by **both** `canonicalOfferCredit` (tablet) and `adminVerifyRedemption` (admin) — one canonical offer-value rule, not two. H1 tests still 14/14.

## 5c. REFERRAL-AUTHORITY analysis (§1 — resolve before coding) + DECISION NEEDED
**Three existing referral-credit authorities (should be one):**
1. **Worker `/process-referral`** (email-worker.js:2724) — **canonical, server-side**: idToken-authed (caller = the new customer), reads `ipear_referral_queue/{callerUid}`, `referralProcessed` guard, cap `MAX_REFERRALS_PER_USER=5`, transactional **+100 new / +100 referrer**, increments `referralCount`. Used by self-signup (`auth.js`) + app retry (`main.js:1381`). Amounts/cap/idempotency live here.
2. **customers-crud referral-on-create** — duplicate browser impl (`referral_in/out_*` ledger ids).
3. **dashboard-ops queue processor** — third browser impl (`referral_queue_in/out_*`) that **overlaps** the Worker on the same `ipear_referral_queue` entries.

**Latent double-credit:** the Worker and dashboard-ops both consume `ipear_referral_queue` but credit the **referrer** with *different* ledger ids → both running on one entry can double-credit the referrer. (A reason to unify, per §1/§6.)

**DECISION: Option A (owner-approved).** Worker `/process-referral` is the single authority.

**Implementation finding (important deviation):** the literal "admin-create writes a `referral_queue` entry" is **technically infeasible** because (1) admin-created customers have **no Firebase Auth account** (customers-crud `_addDoc` with a random id, no `createUser`) — so they can never call the idToken-based Worker — and (2) the `referral_queue` create rule requires `qId == request.auth.uid` (self only; an admin cannot create a queue entry for another customer). So Option A is realized as:
- **customers-crud admin-create:** `referredBy` is still recorded on the customer doc, but **no browser financial credit** happens; the referrer bonus for an admin-created customer is granted by the owner via the audited `adminAdjustPoints`. (Self-signup referrals are unaffected — the Worker credits them as today.)
- **dashboard-ops queue processor:** **retired to a no-op** when the flag is ON (removes the double-credit overlap with the Worker). Genuinely-stuck self-signup entries get processed when the customer next opens the app (the Worker + `main.js` retry), or by owner manual grant.

This keeps **one** referral authority (the Worker), eliminates both browser financial writes, needs **no** Worker change and **no** new function. (Options B/C — a CF trigger or an owner-authed Worker endpoint — remain available later if fully-automated admin-created-referral crediting is wanted; both touch the live Worker and were not chosen.)

## 6. Firestore rule changes
- **Deployed:** `admin_audit` append-only (`read: isAdmin; create/update/delete: false`).
- **NOT deployed (prepared for cutover step 8):** `ipear_transactions` → `create/update/delete: if false` (client); `ipear_customers` financial fields non-writable by admin claim (`!touchesFinancial()` even for admin). Held until all 5 paths migrated + flag enabled.

## 7. TIER-AUTHORITY analysis — RESOLVED
**Inventory of every tier-threshold definition:**
| Source | Role | Gold/Diamond/Platinum floors |
|---|---|---|
| `src/utils.js tier()` | **customer-facing** (hero card, progress "X→next tier") | 3000 / 6000 / 10000 |
| `src/main.js:507,1273,1326`, `customers-crud.js:238` | customer/admin progress labels | 3000 / 6000 / 10000 (via `t.next`) |
| `email-worker.js _computeTier` | **server** — syncs tier to WooCommerce | 3000 / 6000 / 10000 |
| `tests/utils.test.js tierFloor` | test boundaries | 3000 / 6000 / 10000 |
| `functions/index.js _serverTier()` | **tablet projection display only** | **1000 / 3000 / 6000** (outlier) |

**Canonical business ladder (3 independent consumers + tests agree): Bronze 0 · Silver 1000 · Gold 3000 · Diamond 6000 · Platinum 10000.** Tier is **computed from `totalPoints`**, not stored authoritatively; the downgrade targets `9999/5999/2999/999` sit just below the canonical floors. `_serverTier()` is a **pre-existing display bug** (tablet over-states tier) used **only** by the tablet projection — never a financial writer. 

**Decision (2D):** new canonical source of truth = **`functions/lib/tier.js`** (ladder + `tierFloor` + `downgradeTarget`), used by the new `adminBatchMaintenance`. `_serverTier()` is **left unchanged this cutover** (fixing it would change tablet display + require redeploying existing functions — violates 2J "new functions only") and is **flagged for separate remediation**. Client `tierFloor` is now exported from `utils.js` (fixes the pre-existing failing boundary test). Boundary tests added for every floor.

## 8. Idempotency / concurrency proof
`adminAdjustPoints`: deterministic `adj_<idempotencyKey>` ledger id → duplicate/replay/double-click = one mutation; concurrent = one commit (Firestore txn). 28/28 offline + deployed-source confirmed. Batch ops will reuse the existing deterministic ids (`expire_<cid>_<year>`, `tier_downgrade_<cid>_<year>`).

## 9. Full test results (current source, clean workspace)
| Suite | Result |
|---|---|
| `admin-fortress.test.js` (+tier/maintenance/birthday/**redemption**) | **56/56** |
| `offer-credit.test.js` (H1 — after `canonicalOfferValue` refactor) | **14/14** (unchanged) |
| `npm test` (full vitest) | **401/402** — only `appcheck-guard` fails (**environment-only**: clean clone has no `.env`). `tierFloor` fixed. |
| `test:rules` (emulator) | **63/63** (incl. 7 `admin_audit`) |
| `vite build` | clean (84 modules; admin UI compiles with all rewiring) |
| bundle secret / source-map scan | 0 / 0 |
| `sw-precache` | 3/3 |
**No new regressions; one pre-existing failure eliminated (tierFloor).** The sole remaining failure is environment-only.

## 10. Passive live verification
- `ipear_admins` topology read (§1). App Check proven healthy for admins (`approveRedemption` in active use, same `enforceAppCheck`). `adminAdjustPoints` live gate returns 401 unauth. Rules deploy released cleanly. No customer-app / SW / Woo impact (nothing in those surfaces changed).

## 11. Production checks NOT performed, and why
- **Owner-success financial mutation NOT tested live** — forbidden by 2.9 (no real point changes / synthetic users). The add/subtract/correct/expire/tier logic is **VERIFIED IN EMULATOR/TEST HARNESS — NOT REPEATED AS A PRODUCTION FINANCIAL MUTATION.**
- **Rule lock NOT applied** — would be unverifiable live + would break the 5 unmigrated paths. Held per cutover order.

## 12. Rollback state
- **Deployed this stage (reversible):** `admin_audit` rule (additive — remove to revert); `adminAdjustPoints` (dormant — delete the function to revert; it does nothing with the flag OFF + is fail-closed).
- **Git:** HEAD `f2af48b`; Stage 0/1/2 changes uncommitted; rollback ref `c179014`.
- **Prior ruleset** (pre-`admin_audit`): `8fbac946-7475-4220-9618-86f0cb9ba775` (restore target). Firebase Console retains rule history.
- **Feature flag:** OFF (default) → admin UI still uses the legacy direct-write path (fully working, since rules are unlocked).
- **Rollback order if needed:** disable flag (no-op now) → `firebase deploy --only firestore:rules` from `c179014` to drop `admin_audit` → delete `adminAdjustPoints`. No step removes the owner's ability to operate.

## 13. Remaining ADMIN_SECRET consumers (Stage 3 — untouched)
Browser `worker-secret.js` (localStorage) → bulk-messaging/messaging/email-worker/customers-crud(delete-auth-user). Worker gate: `/bulk-sms`, `/sms`, `/woo-create-coupon`, `/admin/*`, `/woo-get-user`, legacy `/woo-*`, `/health-deep`. WordPress `ipear_admin_secret` → `/woo-get-user` only. **No change this stage.**

## 14. Exact Stage-3 plan (not started)
Scoped `WOO_READ_SECRET` for `/woo-get-user`; Worker `/admin/*` → admin-ID-token+owner auth; remove `ADMIN_SECRET` from browser + WordPress; flip `LOYALTY_LEGACY_MUTATION_DISABLED`; **rotate `ADMIN_SECRET`**. Then Stage 4 (passkey step-up, server kill switch, Cloudflare Access, limits).

## 6. Server functions / deploy manifest
- `adminAdjustPoints` — **deployed, ACTIVE** (manual add/subtract/correct; `_commitAdjustment` helper).
- `adminBatchMaintenance` — coded + tested, **to deploy** (expire + tier_downgrade; bounded ≤500; per-item idempotent + audit).
- `adminBirthdayCredit` — coded + tested, **to deploy** (server-fixed +200 + annual key).
- `adminVerifyRedemption` — coded + tested, **to deploy** (reward debit / offer credit; shares `canonicalOfferValue`; idempotent by redemption id).
- **Referral** — unified on the existing Worker `/process-referral` (Option A); **no new function** (admin paths retired/record-only).
**Deploy at cutover (3 new functions):** `adminBatchMaintenance`, `adminBirthdayCredit`, `adminVerifyRedemption`. No change to `approveRedemption` or any unrelated function.

## 6c. §6b LOCK — EMULATOR PROOF (option b; NO deploy) ✅
**Proven artifact:** `firestore.rules.locked` · **sha256 `10df4875194a7d9e0cce4f3e34c8e051f06a4007c661907131c3489736202482`**. Diff vs live `firestore.rules` = **only the 4 §6b edits** (`touchesBalance()` added; `ipear_customers` create gated `points==0 && totalPoints==0`; `ipear_customers` update admin branch gated `!touchesBalance()`; `ipear_transactions` create/update/delete → `false`). Nothing else changed.

**New lock-delta suite `tests/firestore-rules-locked.test.js` (loads the locked artifact): 15/15 PASS**
| Proof (flag-ON locked rules) | Result |
|---|---|
| customer / tablet / **admin** direct `points` write | **DENIED** ✓ |
| admin `totalPoints` / `referralCount` write | **DENIED** ✓ |
| admin NON-balance edits (`blocked`/`name`/`suspicious`/`tier`) | **ALLOWED** ✓ (not over-blocked — `touchesBalance` is narrow) |
| `ipear_transactions` client create / update / delete (admin) | **DENIED** ✓ |
| `admin_audit` client create / update / delete | **DENIED** ✓ |
| customer own-doc read + own-tx read (uid) | **ALLOWED** ✓ |
| verified-email tx read ALLOWED / cross-customer read | **DENIED** ✓ |
| admin reads (customers / transactions / admin_audit) | **ALLOWED** ✓ |
| customer self-signup create `points==0` / `points>0` | ALLOWED / **DENIED** ✓ |
| admin create `points==0` / `points>0` (no mint-via-create) | ALLOWED / **DENIED** ✓ |
| server Admin SDK (rules bypassed) writes points + ledger + audit | **ALLOWED** ✓ (sole writer unaffected) |

**Existing suite against the locked rules: 62/63 PASS.** The single expected flip is `l23a-tablet-rules.test.js › "admin:true → ALLOWED all admin operations"`, which asserts `updateDoc(ipear_customers,{points:999})` — now correctly **DENIED** by the lock. That test encodes *pre-lock* behavior; it still passes against the current unlocked rules and **must be updated in the same commit that deploys the lock** (change that one line to `assertFails`, keep the `audit_logs` create). No other assertion changed → reads / signup / tablet / M1 / cross-customer denial all intact under the lock.

**Conclusion: the §6b lock is correct and de-risked** — it blocks every client financial write (incl. admin), preserves reads/signup/non-balance admin edits, and leaves the server Admin SDK as the sole writer. Nothing deployed; live rules remain unlocked.

## 6b. Exact Firestore rule lock (planned for cutover — NOT applied)
```
match /ipear_transactions/{txId} { allow read: if isAdmin() || (owner/verified read as today);
                                   allow create, update, delete: if false; }   // server (Admin SDK) only
match /ipear_customers/{customerId} {
  // admin may edit NON-financial fields; financial fields only via server callables
  allow update: if (isAdmin() && !touchesFinancial())
    || (ownsCustomer(resource.data) && !touchesFinancial() && <size caps>)
    || (isAuth() && resource.data.email == request.auth.token.email && isUidBindOnly());
  // create (points==0 self-signup) + admin create unchanged
}
```
`admin_audit` stays `create/update/delete:false`. Customer self-signup (`points==0` create) + own-reads + transaction-history reads remain intact. Server callables (Admin SDK) bypass rules → remain the sole financial writers. `ipear_leaderboard` unaffected (publishLeaderboard keeps working).

## Idempotency model per operation
- `adminAdjustPoints` (manual): client idempotency key → `adj_<key>` ledger id.
- `adminBatchMaintenance`: per-item deterministic id `expire_<cid>_<year>` / `tier_downgrade_<cid>_<year>` (also collides with the legacy ids → safe across old/new).
- referral/birthday (planned): `referral_in/out_<...>`, `birthday_<cid>_<year>`.

## Cut-over execution (this increment)
| Step | Result |
|---|---|
| Gate 0 — final regression + both scans | ✅ 401/402 (1 env-only), build clean, 0 active browser financial writers (flag ON) |
| Step 1 — rollback capture | ✅ HEAD `f2af48b`; flag default OFF; ruleset `8fbac946…`+admin_audit; `adminAdjustPoints` ACTIVE |
| Step 2 — deploy 3 new functions | ✅ `adminBatchMaintenance`, `adminBirthdayCredit`, `adminVerifyRedemption` **created, ACTIVE**; `OWNER_UIDS` OK; source markers present (owner gate, `canonicalOfferValue`/H1, planners, idempotency ids, `admin_audit`, `enforceAppCheck`); unauth→401; **no unrelated function changed** (`approveRedemption`/`adminAdjustPoints` updateTimes unchanged) |
| Step 3 — deploy flag-ON frontend | ❌ **BLOCKED** — Cloudflare Pages `Authentication error [10000]`; wrangler token read-only + wrong account; no write `CLOUDFLARE_API_TOKEN` |
| Steps 4–10 (scan built bundle, **rule lock**, verify, passive, rollback drill) | ⏸ **NOT performed** — gated on Step 3 (correct; no lock without the flag-ON frontend) |

### Handoff — to finish the cutover (needs your Cloudflare access)
1. **You deploy the frontend** from an environment with Pages write on the `f02bde…` account:
   ```
   VITE_ADMIN_SERVER_FINANCIAL=1 npm run deploy:pages
   ```
   (or set it in the build `.env`). This flips the admin to the server callables. The 3 functions it needs are already deployed + verified.
2. Confirm the live admin bundle has the flag ON and the admin app loads (customer/tablet unaffected).
3. **Then the Firestore lock** (§6b) — I can deploy it via the firebase CLI (that credential works here) once you confirm the flag-ON frontend is live, **or** you apply it. Order matters: lock only AFTER the flag-ON frontend is live.
4. Post-lock: emulator proof (§6b denies client financial writes, permits server) + passive production checks + rollback drill → COMPLETE.

**Rollback (if needed after lock):** revert Firestore rules to the pre-lock ruleset **before/with** reverting the frontend to flag-OFF — never leave flag-OFF frontend + locked rules.

## 14b. Rollback impact (coherent bundle)
Restore order if rolling back post-lock: **(a) redeploy prior Firestore rules (ruleset `8fbac946…` baseline + current = pre-lock) BEFORE or WITH (b) restoring the prior frontend build (flag OFF)** — never leave `old frontend + new locked rules` (that breaks legacy admin writes). (c) New functions can stay (dormant/unused with flag OFF) or be deleted. Flag OFF alone (no redeploy) reverts UI behavior to legacy, which works **only while rules are unlocked** — so after the lock, rules must be reverted together with the flag.

## FINAL VERDICT: **ADMIN FORTRESS STAGE 2 INCOMPLETE** (blocked at Step 3 — frontend deploy credential)
All financial paths serverized/retired + flag-gated; the full server backend is now **deployed + verified ACTIVE** (`adminAdjustPoints`, `adminBatchMaintenance`, `adminBirthdayCredit`, `adminVerifyRedemption`), owner-gated + App-Check, `admin_audit` immutable, H1 preserved (14/14), two-method scan = **0 active browser financial writers (flag ON)**, 401/402 tests, build clean. **The cutover cannot finish here:** Step 3 (Cloudflare Pages flag-ON frontend deploy) is blocked by a missing write-scoped Cloudflare credential, and the Firestore lock is correctly withheld until the flag-ON frontend is live. Production is unchanged and coherent (legacy paths active, new functions dormant, rules unlocked) — nothing to roll back. **Server is NOT yet the sole financial writer** (the lock is not applied). Finish via the handoff above: you deploy the flag-ON frontend, then the rule lock follows.

---
*Stage 2 in progress: 2.1 owner config + 2.2 dormant deploy & verification complete in production; batch-path migration + flag enable + rule lock are the remaining, test-first increment.*

---

## §LC — FINAL PRE-LOCK CUSTOMER LIFECYCLE FIX (2026-10-06)

Server-authoritative customer deletion. **Invariant: customer deletion MUST NOT destroy financial evidence.** Delivered without weakening the planned §6b lock, without permitting any client ledger delete/update, and without moving unrestricted ledger deletion to a function.

### 1. Lifecycle architecture
- **Function:** `adminDeleteCustomer` (onCall v2, `europe-west1`, `enforceAppCheck:true`). Owner-gated (`_requireOwner` = Firebase auth + `admin` claim + `OWNER_UIDS` allowlist), fail-closed.
- **Browser submits only intent** — `{ customerId, idempotencyKey }`. The server resolves the full identity set (uid(s), email, phone, card, orphan customer docs) and decides what to anonymize vs delete. The browser never decides which financial history to touch.
- **Pure logic** factored into `functions/lib/lifecycle.js` (`tombstoneId`, `lifecycleId`, `planLedgerAnonymization`, `LIFECYCLE_POLICY`) for unit-testability; Admin-SDK execution in `functions/index.js` (`_adminDeleteCustomerHandler`).

### 2. Deletion / anonymization classification by collection
| Resource | Class | Action |
|---|---|---|
| `ipear_transactions` (financial ledger) | **C — RETAIN + ANONYMIZE** | strip PII (email/name/phone→null), repoint `customerId`/`customerUid`→tombstone, stamp `_anonymizedAt`/`_tombstone`; **amounts/type/date/source/delta/before-after preserved**; never deleted |
| `ipear_offer_redemptions`, `ipear_redemptions` | **C — RETAIN + ANONYMIZE** | financial redemption evidence; PII scrubbed, repointed |
| `ipear_redemption_requests`, `ipear_birthday_claims`, `audit_logs` | **B — ANONYMIZE** | operational/security record retained, PII scrubbed |
| `admin_audit` | **C — RETAIN IMMUTABLE** | never modified/deleted; only the deletion completion event is appended |
| `ipear_referral_queue` | **A — DELETE** | transient operational marker, no financial evidence |
| `ipear_customers` (primary + orphans) | **A — DELETE** | PII profile; balance already captured in the ledger |
| Firebase Auth user(s) | **A — DELETE** | Admin SDK `deleteUser`; `user-not-found` == success |

Legal retention is explicitly out of scope (technical model only).

### 3. Server function identity / revision
`adminDeleteCustomer` — **ACTIVE**, `nodejs20`, `europe-west1`, created `2026-10-06T10:04:06Z`, source commit `f2af48b`. `OWNER_UIDS=g7YT…QojT2 (owner UID — redacted)`. Source markers verified in the deployed zip: `_requireOwner`, `enforceAppCheck:true`, `planLedgerAnonymization`, `tombstoneId`, `getAuth().deleteUser`, `admin_audit`, `lib/lifecycle.js` bundled. The other 4 fortress functions + `approveRedemption` **unchanged** (updateTimes Oct 2–3, pre-deploy).

### 4. Frontend deployment identity
Cloudflare Pages `ipear-loyalty`, **Production / main**, deployment **`217af082-121e-4214-9d4f-2fbe84f82bff`**, source `f2af48b`, via historical Direct Upload (`VITE_ADMIN_SERVER_FINANCIAL=1 npm run deploy:pages`). Live admin bundle `admin-BOxRttVr.js` byte-identical to the reviewed build (sha256 `89248303ed1b535a5d9c837cd6ef57b53596fc190844934807c0fb606e779e7e`); flag `VITE_ADMIN_SERVER_FINANCIAL:"1"`; `adminDeleteCustomer` referenced.

### 5. Financial-evidence preservation model
`ipear_transactions` becomes append-only. The **only** path that mutates an existing ledger row is this server lifecycle op, and it only scrubs PII fields + repoints identity to an **irreversible pseudonymous tombstone** (`deleted_customer_<sha256(uid)[:24]>` — never raw email/phone/name). This is the single documented, owner-gated, audited exception to append-only semantics. Clients retain **zero** ledger write/update/delete ability (gated now; denied by §6b rules at lock). The normal admin financial UI has no ledger-edit path.

### 6. Idempotency / partial-failure model
Deterministic `lifecycleId` names the `admin_audit` completion doc. Steps execute anonymize-first; **customer docs are deleted last, just before the audit write**, and the audit stores the target ids. Resumability:
- Audit exists ⇒ steps A–F proven done ⇒ re-run only the (idempotent) customer-doc deletion tail.
- Every anonymization is a no-op once a row carries the tombstone; Auth delete tolerates `user-not-found`.
- A retry after any partial failure never restores PII, never deletes financial evidence, never duplicates the audit, never corrupts loyalty state. Proven by the emulator (`§LC2`, `§LC3`).

### 7. Lifecycle test results (Firestore + Auth emulators) — `npm run test:lifecycle`
**8/8 PASS.** Happy path (ledger retained: count/amount/type/date preserved, PII→null, identity→tombstone; redemptions + operational anonymized; referral_queue + customer docs deleted; Auth user deleted; immutable audit written); idempotent duplicate (ledger not re-mutated, audit not duplicated); concurrent duplicate; resume-tail; nonexistent→notFound; Auth-already-missing; aux-docs-missing; orphan-by-email cascade.

### 8. Two independent scans (live flag-ON source)
- **SCAN A (static/primitive):** enumerated every `deleteDoc/updateDoc/setDoc/addDoc/runTransaction/writeBatch` (+ `window._*` wrappers) touching `ipear_transactions`/`points`/`totalPoints`/`referralCount`/`referralProcessed`/redemption/ledger/audit.
- **SCAN B (semantic/control-flow):** every such write sits behind a flag-ON early-return (or if/else legacy branch) and is unreachable in prod, or is non-financial. One gap found & fixed: `dashboard-ops.js` `importBk` (backup restore) wrote `ipear_transactions` ungated → now flag-ON refusal.
- **Both agree:** **active browser financial writers = 0 · ledger client update paths = 0 · ledger client delete paths = 0 · referral financial authorities = 1** (Worker `/process-referral`; admin paths record-only). The customer-delete cascade (`customers-crud.js` @507–555) is behind the flag-ON `return` @422 and is unreachable.

### 9. Full regression — no new regressions
| Suite | Result |
|---|---|
| Full pure vitest (`npm test`) | **415/415** |
| Admin Fortress unit (`admin-fortress.test.js`) | **69/69** (incl. 13 new lifecycle/auth-gate) |
| Lifecycle emulator (`test:lifecycle`) | **8/8** |
| Firestore rules (`test:rules`) | **63/63** |
| §6b locked-rule delta (`firestore-rules-locked`) | **15/15** |
| L2.3A integration (`test:integration`) | **42/42** |
| Production build (flag ON) | ✓ no source maps · no secrets · `adminDeleteCustomer` wired |

(Pre-existing, not a regression: the `lint` script globs removed `public/sw.js` — changed files lint clean directly.)

### 10. Live passive verification (no production mutation)
`loyalty.ipear.gr` 200 · `/admin` 200 (login panel renders) · `/` 200 · `/tablet` 200 · all assets 200 (no 4xx/5xx) · flag ON · `adminDeleteCustomer` in live bundle · no JS init errors breaking the app (one non-blocking SW-registration MIME warning, pre-existing, unrelated to this change). **No real points modified; no production customer deleted — all destructive behavior proven in the emulator.**

### 11. Exact remaining action before Stage 2 completion
Deploy the §6b financial Firestore lock (`firestore.rules.locked`, sha256 `10df4875…`) via `firebase deploy --only firestore:rules`, in the **same commit** that flips the one `l23a-tablet-rules` assertion (admin `points:999` → `assertFails`). Then post-lock passive verification + rollback drill. **Not done here, as instructed.**

### FINAL VERDICT: READY FOR FINAL FIRESTORE LOCK

---

## §LOCK — FINAL STAGE-2 FIRESTORE LOCK (2026-10-06)

### 1. Previous ruleset
`d30197c5-6d47-49b2-905a-3e492a200ebe` (released 2026-10-02T09:57:29Z; unlocked, with `admin_audit` append-only block). Source backed up: `scratchpad/rollback/firestore.rules.PREVIOUS-UNLOCKED`, sha256 `d9547506f43fc216cb74502b3b482525e965440f1831fee24acca2c7ed441c9a`.

### 2. New active ruleset
`19a4c34b-4610-48a7-b6c5-fe623e339b3e` (released 2026-10-06T10:13:24Z).

### 3. Locked artifact SHA256
`10df4875194a7d9e0cce4f3e34c8e051f06a4007c661907131c3489736202482` — the **live ruleset source is byte-identical** to this reviewed artifact.

### 4. Exact deploy command / result
`firebase deploy --only firestore:rules --project loyalty-ipear --non-interactive --force` → `✔ cloud.firestore: rules file firestore.rules compiled successfully` → `✔ firestore: released rules firestore.rules to cloud.firestore` → **Deploy complete.** Only `firestore:rules` (no functions/frontend/Worker/Hosting/indexes/Storage).

### 5. Final rules-test results (against the locked rules)
- Locked-rule delta suite (`firestore-rules-locked.test.js`): **15/15 PASS**.
- Full rules suite (`firestore-rules.test.js` + `l23a-tablet-rules.test.js`): **63/63 PASS** after the one intended assertion flip.
- **Intended test update:** `l23a-tablet-rules.test.js` — "admin:true → ALLOWED all admin operations" ⇒ renamed "ALLOWED admin ops, but DIRECT balance write DENIED (§6b lock)"; the admin `updateDoc(points:999)` flipped `assertSucceeds`→`assertFails`; added a non-balance admin edit (`blocked:true`) still `assertSucceeds`. No other test weakened.
- **Invariant proven in emulator** (maps 1:1 to the live byte-identical ruleset): customer/tablet/**admin** direct points write → DENIED; client `ipear_transactions` create/update/delete → DENIED; client `admin_audit` create/update/delete → DENIED; admin non-financial (block/name/tier/suspicious) → ALLOWED; customer own reads + own tx-history reads → ALLOWED; admin required reads → ALLOWED; signup `points==0` → ALLOWED / `points>0` → DENIED; trusted Admin SDK/server writes → UNAFFECTED.

### 6. Passive production verification (no mutations)
`loyalty.ipear.gr` 200 · `/admin` 200 · `/tablet` 200 · `/privacy` 200 · `/terms` 200 · `sw-customer.js` 200 — no 4xx/5xx. Customer app + admin login render; **no console errors**. Email/referral Worker UP (`/health-deep` 401 auth-gated, `/` 405 — alive, not down). Service worker healthy. No real points mutated; no synthetic customer created.

### 7. Post-lock two-scan results
Browser financial writers = **0** · ledger client update paths = **0** · ledger client delete paths = **0** · referral financial authorities = **1** (Worker) · admin_audit client mutation authority = **0** (rules-DENIED + 0 browser writes) · client-side OWNER_UID authorization = **0** · no new secret exposure (no `OWNER_UIDS`/owner value/secrets/source maps in the live build).

### 8. Function health
All five fortress callables **ACTIVE**, revisions **UNCHANGED** by the rules-only deploy: `adminAdjustPoints` (Oct 2), `adminBatchMaintenance`/`adminBirthdayCredit`/`adminVerifyRedemption` (Oct 3), `adminDeleteCustomer` (Oct 6 10:04, pre-lock). `OWNER_UIDS=g7YT…QojT2 (owner UID — redacted)` on all.

### 9. Frontend deployment identity
Cloudflare Pages `ipear-loyalty`, Production/main, **`217af082`** (source `f2af48b`), flag `VITE_ADMIN_SERVER_FINANCIAL:"1"`, admin bundle byte sha256 `89248303…`. **Unchanged** by the lock.

### 10. Rollback procedure (drill passed; not executed — production healthy)
**Invariant: never run legacy/flag-OFF frontend against locked financial rules.** Order:
1. **Restore previous compatible rules FIRST** — `cp scratchpad/rollback/firestore.rules.PREVIOUS-UNLOCKED firestore.rules && firebase deploy --only firestore:rules` (or re-release ruleset `d30197c5`). Unlocked rules are compatible with BOTH flag-ON and flag-OFF frontends, so this is always safe to do first.
2. **Then, only if needed, restore frontend/flag** — prior flag-ON = `71f1b3b8`; last flag-OFF legacy = `fc3eee0e`. (Flag-OFF is only safe AFTER step 1 has unlocked the rules.)
3. Restore functions only for a function-specific failure.
4. Verify coherent state. Backup + both ruleset IDs recorded above.

### 11. Checks NOT repeated as production mutations
Manual add/subtract/correct, redemption debit/credit, expire, tier-downgrade, birthday credit, referral credit, and customer deletion/anonymization correctness: **VERIFIED IN EMULATOR/TEST HARNESS — NOT REPEATED AS A PRODUCTION FINANCIAL MUTATION.**

### 12. Warnings / errors observed
- Non-blocking SW-registration MIME warning (`text/html`) on page load — pre-existing, unrelated to this change (SW/messaging registration, not financial code).
- `firebase-tools`: Node 20 runtime deprecation + firebase-functions upgrade notices (informational; no action taken this stage).
- `lint` npm script globs a removed `public/sw.js` (pre-existing); changed files lint clean directly.

### FINAL VERDICT: ADMIN FORTRESS STAGE 2 COMPLETE — SERVER IS SOLE FINANCIAL WRITER
