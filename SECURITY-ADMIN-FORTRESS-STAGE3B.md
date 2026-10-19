# iPear Loyalty — ADMIN FORTRESS · STAGE 3B (admin browser off ADMIN_SECRET)

**Date:** 2026-10-06 · **Role:** Security Architect · **Mode:** additive + browser cutover. No WordPress change, no ADMIN_SECRET rotation/revocation, no legacy endpoint disabled, no Cloudflare Access/MFA. Builds on 3A (`email-worker` v`77a46d86`) + Stage-2 commit `5dcbe37`.

> **VERDICT: READY FOR STAGE 3C — ADMIN BROWSER NO LONGER USES ADMIN_SECRET.** The active admin browser now authenticates to the Worker with a fresh Firebase ID token + App Check token against `/admin/v2/*` (verified owner identity + `admin:true` + `OWNER_UID`). No reusable master secret is read, sent, or stored by the admin browser. Live admin build byte-verified; `localStorage['ipear_worker_secret']` absent. Legacy ADMIN_SECRET paths remain for rollback.

---

## 1. Worker config activation (3B.0)
Set two **non-secret** server-side config values on `email-worker` (via `wrangler secret put`, stdin, never echoed; kept out of the tracked `wrangler.toml`):
- `OWNER_UIDS` — derived from the authoritative GCF function env (same owner allowlist as the Stage-2 callables; value not printed).
- `FIREBASE_PROJECT_NUMBER` — the public Firebase project number (= `VITE_FB_MSG_SENDER_ID`, 12 digits).

Existing secrets/bindings preserved (`keep_vars`). **Proof:** `/health` 200; unauth v2 → 401; a token-bearing v2 call now returns `token-invalid` (previously `owner-unconfigured`), confirming config loaded server-side; legacy routes unchanged. ADMIN_SECRET untouched.

## 2. Active admin-browser consumer inventory
| # | File / fn | Legacy endpoint | Method | Financially sensitive | v2 replacement | Status |
|---|---|---|---|---|---|---|
| B3 | `email-worker.js` `sendEmailBulk` | `POST /` | POST | no | `/admin/v2/email` | **migrated** |
| B5 | `messaging.js` `sendEmailIndividual` | `POST /` | POST | no | `/admin/v2/email` | **migrated** |
| B5 | `messaging.js` `sendSMSIndividual` | `POST /sms` | POST | no | `/admin/v2/sms` | **migrated** |
| B4 | `bulk-messaging-send.js` `sendSMSBulk` | `POST /bulk-sms` | POST | no | `/admin/v2/bulk-sms` | **migrated** |
| B2 | `customers-crud.js` delete cascade | `/admin/delete-auth-user` | POST | no (lifecycle) | **CF `adminDeleteCustomer`** (Stage 2) | already server-authoritative; legacy Worker call unreachable under financial flag ON |
| — | `email-worker.js` `testWorkerConnection` | `POST /` (secret test) | POST | no | owner-auth readiness check (no mutation) | **repurposed** under flag ON |
| — | export-backup | `/admin/export-backup` | — | yes (PII) | `/admin/v2/export-backup` route ready | **no browser caller exists** (curl/cron only) |

Auth-user deletion was already migrated to the Cloud Function in Stage 2 (Admin SDK, owner+App-Check gated) — stronger than a Worker route; the `/admin/v2/delete-auth-user` route stands for parity. No other active admin-browser Worker consumer found.

## 3. Shared owner-auth browser adapter (3B.2)
[`src/admin/owner-api.js`](src/admin/owner-api.js): one client. Per request it (1) requires a signed-in Firebase user, (2) fetches a **fresh ID token** via `getIdToken()`, (3) fetches an **App Check token** via `window._getAppCheckToken()` (exposed from [firebase-init.js](src/firebase-init.js)), (4) sends both as `Authorization: Bearer <idToken>` + `X-Firebase-AppCheck` to `/admin/v2/<route>`. Tokens are **never persisted** (no localStorage/sessionStorage/cookie/IndexedDB/URL/global), never logged. **No automatic ADMIN_SECRET fallback** (3B.3) — failures throw typed errors; mode is chosen only by the `ADMIN_OWNER_AUTH` flag (default OFF → legacy path).

## 4. Migrated endpoints (flag-gated, mutually exclusive)
Each consumer: `const _ownerAuth = isOwnerAuthEnabled(); ... if (_ownerAuth) { ownerSend*(payload) } else { legacy Bearer ADMIN_SECRET }`. Payload/UX semantics preserved. Server remains authoritative. Under flag ON the master-secret requirement is dropped (owner-auth needs only the Worker URL).

## 5. Login / logout / session behavior (3B.10)
- **Login:** Firebase SDK session; `admin:true` claim checked (admin-auth.js); no ADMIN_SECRET required; v2 calls use SDK tokens.
- **Reload:** SDK restores session from IndexedDB; no master secret needed.
- **Logout:** `adminLogout` → Firebase sign-out + `clearWorkerSecret()` (admin-auth.js:185) + privileged UI reset.
- **Disabled/revoked user or removed claim:** the next `getIdToken()`/server verification fails → v2 denied (owner gate + Identity Toolkit).
- ID tokens are **never** manually persisted (SDK-managed).

## 6. localStorage cleanup result (3B.9)
- Startup (admin-main.js): `if (isOwnerAuthEnabled()) clearWorkerSecret()` purges any stale `ipear_worker_secret`.
- Settings panel: under flag ON the Worker-Secret field is hidden + disabled and never read.
- **Live runtime proof:** `localStorage['ipear_worker_secret']` = `null`, `sessionStorage` = `null`; only `_grecaptcha` present; `window._getAppCheckToken` = function.

## 7. Two independent artifact scans (production flag-ON build)
- **SCAN A (static):** `VITE_ADMIN_OWNER_AUTH:"1"` + `VITE_ADMIN_SERVER_FINANCIAL:"1"` baked; `admin/v2/` present (adapter wired); **no source maps**; **no master-secret value / owner UID** in the bundle.
- **SCAN B (control-flow):** every `getWorkerSecret()` request-read and `Bearer ${workerSec}` construction sits inside a `!_ownerAuth` / `else` branch or after an `isOwnerAuthEnabled()` early-return → **unreachable under flag ON**. Settings-panel + `testWorkerConnection` reads gated too.
- **Reconciled result (flag ON):** active reads of `ipear_worker_secret` = **0** · active ADMIN_SECRET request construction = **0** · active browser calls to legacy master-secret endpoints = **0** · manual ID-token persistence = **0** · manual App Check persistence = **0** · no secret values bundled. Legacy strings remain only in unreachable rollback branches.

## 8. Adversarial results (3B.13)
- **Owner auth** (`tests/owner-auth.test.js` 28 + `worker-routes.test.js` v2 6, live-verified): valid owner+App Check → ALLOW; no/forged/expired/wrong-project token → DENY; customer → DENY; tablet → DENY; admin wrong OWNER_UID → DENY; OWNER_UID without admin claim → DENY; missing/invalid App Check → DENY; **bare ADMIN_SECRET on v2 → DENY** (live: `token-invalid`).
- **Browser** (`tests/owner-api.test.js` 9): login needs no ADMIN_SECRET; reload works without it; localStorage master secret absent (live-verified); logout clears it; **no automatic legacy fallback** on v2 failure (exactly one attempt); tokens never persisted.
- **Endpoints:** email / sms / bulk-sms / delete-auth-user / export-backup v2 auth all enforced (harness).

## 9. Regression results (3B.14) — no new regression
Full pure vitest **462/462** (incl. owner-api 9, owner-auth 28, worker-routes 22, offer-credit/H1, sw-precache) · Firestore rules **63/63** · §6b locked **15/15** · lifecycle **8/8** · **financial rules UNCHANGED** (`firestore.rules` = `10df4875…`) · functions + Worker **code** unchanged · lint clean · build clean · `wrangler deploy --dry-run` clean (3A) · no source maps · secret scan clean.

## 10. Deployment identities
- **Worker config:** `OWNER_UIDS` + `FIREBASE_PROJECT_NUMBER` secrets added to `email-worker` (code still v`77a46d86`; no code redeploy in 3B).
- **Frontend:** Cloudflare Pages `ipear-loyalty`, **Production/main**, deployment **`519fbd7c-fab4-4a63-9f25-10677c1c65f0`** (source `5dcbe37`), via `VITE_ADMIN_SERVER_FINANCIAL=1 VITE_ADMIN_OWNER_AUTH=1 npm run deploy:pages`. Live admin bundle `admin-DKanSCzM.js`, **byte sha256 `497bd674d666dea5e57b2c05711643018945bc2d46e71e08b0a0a9e58c95276d`** (identical to the reviewed build).

## 11. Passive production verification (3B.16)
`loyalty.ipear.gr` 200 · `/admin` 200 (login renders) · `/tablet` 200 · customer SW 200 · customer `main` bundle **byte-identical** (customer app unaffected) · Worker `/health` 200 · `/admin/v2/email` unauth → 401 · admin console shows only the **pre-existing** SW-registration MIME warning (not from this change) · runtime: owner-auth wired, no master secret in storage. **No real bulk email/SMS sent, no real customer deleted** — privileged mutations: **VERIFIED IN TEST HARNESS — NOT REPEATED AS A PRODUCTION MUTATION.**

## 12. ADMIN_SECRET consumer recount (3B.17)
- **Admin browser = 0 active ADMIN_SECRET consumers** ✅ (email/SMS/bulk-SMS on v2; Auth-delete via CF; export-backup has no browser caller; secret field hidden; startup purge).
- **WordPress = UNRESOLVED / still potentially active** (`/woo-get-user` on ADMIN_SECRET in both 2.4.2 and 2.5.2; not touched in 3B).
- **Legacy Worker endpoints = still accept ADMIN_SECRET** (deliberate, for rollback).
- **create-admin = still legacy ADMIN_SECRET-gated** (retire in 3D).
- **Global consumer count is NOT yet 0** — do not rotate (3F) until 3C–3E complete.

## 13. Stage 3C plan (next)
Migrate WordPress `/woo-get-user` off ADMIN_SECRET to a **separate read-only `WOO_LOOKUP_SECRET`** (design in 3A §8): (1) **capture the live WordPress plugin and diff vs repo to resolve WOO LIVE SOURCE AUTHORITY**; (2) add `WOO_LOOKUP_SECRET` acceptance to the Worker `/woo-get-user` (additive, parallel to ADMIN_SECRET); (3) install `WOO_LOOKUP_SECRET` in WP + point the lookup at it; (4) prove WP holds no ADMIN_SECRET; keep credit/refund on `WOO_LOYALTY_SECRET`. No ADMIN_SECRET rotation until 3E.

## 14. Rollback procedure
- **Frontend:** redeploy prior Pages deployment `217af082` (owner-auth absent) or rebuild with `VITE_ADMIN_OWNER_AUTH` unset → browser reverts to the legacy ADMIN_SECRET path (still accepted by the Worker). The admin re-enters the Worker Secret in Settings.
- **Worker config:** the added `OWNER_UIDS`/`FIREBASE_PROJECT_NUMBER` are additive and harmless to legacy; may be left in place. ADMIN_SECRET never rotated, so legacy auth works throughout.
- No WordPress/rule/function/Worker-code change to undo.

---

## HARD STOP — STAGE 3B COMPLETE
No WordPress change, no ADMIN_SECRET rotation, no legacy endpoint disabled, no Cloudflare Access/MFA. Awaiting approval for **Stage 3C** (WordPress lookup credential; starts by resolving the live-plugin authority).

### FINAL VERDICT: READY FOR STAGE 3C — ADMIN BROWSER NO LONGER USES ADMIN_SECRET
