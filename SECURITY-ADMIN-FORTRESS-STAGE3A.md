# iPear Loyalty — ADMIN FORTRESS · STAGE 3A (parallel auth replacement)

**Date:** 2026-10-06 · **Role:** Security Architect · **Mode:** ADDITIVE ONLY. No secret rotated/removed, no browser/WordPress migration, no legacy endpoint disabled, no Cloudflare Access/MFA. ADMIN_SECRET remains fully valid. Builds on Stage-2 commit `5dcbe37`.

> **VERDICT: READY FOR STAGE 3B — PARALLEL AUTH REPLACEMENT VERIFIED.** The additive owner-grade Worker auth (Firebase ID token + `admin:true` claim + `OWNER_UID` allowlist + App Check) is implemented, adversarially tested (50/50), regression-clean (453/453 pure), and **deployed live and dormant** (`email-worker` version `77a46d86-04e0-4358-9591-7d3b0b493066`). Legacy ADMIN_SECRET paths are untouched and fully operational. The new `/admin/v2/*` routes exist and **fail-closed** (deny-all) until `OWNER_UIDS`+`FIREBASE_PROJECT_NUMBER` are set on the Worker at the start of 3B — zero production impact.

---

## 1. Woo source-of-truth reconciliation (Gate 0)
- **2.5.2 artifact located:** `~/Downloads/ipear-woo-loyalty.zip`, **SHA256 `319033eefddded6a88ff3172f285fb6b15893afa1053a4d8ad24c8af05085ea0` — MATCHES** the expected hash.
- **2.5.2 behaviour (verified from the artifact):** `/woo-credit-order` + `/woo-refund-order` use a **separate `ipear_woo_loyalty_secret`** (never falls back to ADMIN_SECRET); **`/woo-get-user` still uses `ipear_admin_secret` (ADMIN_SECRET)** for the My-Account lookup.
- **Repo source is 2.4.2** (committed + working in the main checkout) — older design: `/woo-add-points` + `/woo-get-user` on ADMIN_SECRET; no `WOO_LOYALTY_SECRET`.
- **Live-plugin evidence:** the Worker has `/woo-credit-order` + `/woo-refund-order` deployed (passive probe → 401 = present), consistent with 2.5.2 being live; **but** `/woo-add-points` is **not** kill-switched (401, not 410), and I cannot read the live WordPress install.

### 2. Actual live Woo authority confidence
**WOO LIVE SOURCE AUTHORITY = UNRESOLVED.** Strongest evidence leans to **2.5.2 deployed** (artifact recovered + hash-verified; L1 endpoints live), but it is **not proven** (repo is 2.4.2; legacy endpoint still reachable; no direct read of WP). **Therefore no WordPress changes were made in Stage 3A** (per the Gate-0 rule). WordPress migration waits for 3C after the live plugin is captured and diffed.

## 3. New Worker owner-auth architecture
`Authorization: Bearer <Firebase ID token>` + `X-Firebase-AppCheck: <App Check token>` → [`src/worker/lib/owner-auth.js`](src/worker/lib/owner-auth.js) `requireOwner()`:
identity (ID token verified server-side) → `admin:true` custom claim → `uid ∈ OWNER_UIDS` → App Check attestation. **Fail-closed** on any missing config / verification error. No reusable master secret anywhere in the browser.

## 4. Firebase token verification implementation
`verifyOwnerIdentity()` posts the ID token to Google **Identity Toolkit `accounts:lookup`** (reuses the Worker's proven pattern) — Google validates **signature, issuer, audience/project, expiry**; expired/forged/modified/wrong-project tokens return an error → `token-invalid`. Then it enforces `customAttributes.admin === true` and `localId ∈ parseOwnerUids(env.OWNER_UIDS)` (server-side only). Never decodes/ trusts the raw JWT payload.

## 5. App Check implementation
`verifyAppCheck()` verifies the App Check **RS256 JWT against Google's App Check JWKS** (`firebaseappcheck.googleapis.com/v1/jwks`, cached): checks `alg=RS256`, matching `kid`, **cryptographic signature** (WebCrypto `RSASSA-PKCS1-v1_5`/SHA-256), `exp`, `iss = …/<projectNumber>`, `aud ∋ projects/<projectNumber>`. Requires the **public** `FIREBASE_PROJECT_NUMBER`; fail-closed if unconfigured. App Check = attestation **in addition to** identity, never a replacement.

## 6. New parallel admin routes (additive, before the ADMIN_SECRET gate)
`/admin/v2/email`, `/admin/v2/sms`, `/admin/v2/bulk-sms`, `/admin/v2/delete-auth-user`, `/admin/v2/export-backup` → `requireOwner()` → existing handler. Legacy ADMIN_SECRET routes below are **unchanged** (rollback by not using v2). Covers every **active** browser-admin capability (bulk email, SMS/bulk-SMS, Auth-user delete, export-backup).

## 7. Create-admin retirement design (S3.4)
`/admin/v2/create-admin-user` was **intentionally NOT created.** This is single-owner; minting admin identities at runtime is fortress-critical. The legacy `/admin/create-admin-user` (ADMIN_SECRET → writes `ipear_admins` → `syncAdminClaim` grants `admin:true`) remains for now and is slated for **retirement** in 3D. If a bootstrap/recovery path is ever needed, it will be a separate controlled operational procedure (owner-only), never an easy owner-token endpoint. Client `ipear_admins` write is already `false` (rules) and custom claims are server-only — confirmed.

## 8. WOO_LOOKUP_SECRET design (S3.5)
Recommended **Option B — a separate read-only `WOO_LOOKUP_SECRET`** for `/woo-get-user` (timing-safe, routed before the ADMIN_SECRET gate, same pattern as `verifyWooSecret`). WordPress would then hold only `WOO_LOYALTY_SECRET` (credit/refund) + `WOO_LOOKUP_SECRET` (read) — **no ADMIN_SECRET**. **Not installed in 3A** (WP authority UNRESOLVED); design is ready for 3C once the live plugin is confirmed.

## 9. Legacy endpoint inventory
| Endpoint | Status | Caller | Retire in |
|---|---|---|---|
| `/woo-add-points` | live, ADMIN_SECRET, **not** kill-switched (401) | 2.4.2 repo / none if 2.5.2 | 3D (trip `LOYALTY_LEGACY_MUTATION_DISABLED`) |
| `/woo-refund-points` | live, ADMIN_SECRET | none (replaced) | 3D |
| `/admin/create-admin-user` | live, ADMIN_SECRET | unclear | 3D (retire/owner-only) |
| `/admin/delete-auth-user` | live, ADMIN_SECRET; now **also** `/admin/v2/delete-auth-user` | browser (flag-OFF) | 3D (fold into CF) |

## 10. Adversarial test results — **50/50 PASS**
[`tests/owner-auth.test.js`](tests/owner-auth.test.js) (28) + [`tests/worker-routes.test.js`](tests/worker-routes.test.js) §Stage-3A (6 new; 22 total in file):
- **Identity:** no-token → DENY · malformed/forged/expired/wrong-project → DENY (`token-invalid`) · customer → DENY (`not-admin`) · tablet → DENY (`not-admin`) · admin + wrong UID → DENY (`not-owner`) · owner UID + no admin claim → DENY (`not-admin`) · valid owner → ALLOW · network error → DENY (`verify-error`) · OWNER_UIDS unset → DENY (`owner-unconfigured`).
- **App Check (real RS256):** missing/unconfigured/malformed/alg≠RS256/unknown-kid/**tampered-sig**/expired/wrong-iss/wrong-aud/JWKS-down → DENY · valid → ALLOW.
- **Worker routing:** `/admin/v2/*` exist & deny unauth (401, not 404) · token+no OWNER_UIDS → 503 · **bare ADMIN_SECRET on v2 → DENY (token-invalid)** · non-owner → 403 · valid owner+App Check → dispatches past the gate.

## 11. Regression results
Full pure vitest **453/453** · worker+woo+resend **103/103** · owner-auth **28/28** · **financial rules UNTOUCHED** (`firestore.rules` still `10df4875…`) · 5 Cloud Functions + Firestore ruleset unchanged (Worker-only deploy) · lint clean · `wrangler deploy --dry-run` bundles cleanly (182.68 KiB).

## 12. Additive deployment identity
`email-worker` **Version `77a46d86-04e0-4358-9591-7d3b0b493066`** (account `f02bde…`, via owner `wrangler login`). `keep_vars` preserved existing secrets/vars. **Post-deploy passive proof:** `/health` 200; `/admin/v2/*` exist + deny unauth (401); bogus Bearer on v2 → 503 (fail-closed, never 200); `/`, `/woo-get-user`, `/woo-credit-order`, `/sms`, `/admin/export-backup`, `/health-deep` all deny unauth **unchanged**. `OWNER_UIDS`/`FIREBASE_PROJECT_NUMBER` not set → v2 routes **dormant/fail-closed** (intended).

## 13. Exact ADMIN_SECRET consumers remaining
Unchanged from Stage-3 audit (3A is additive — removed none): **Browser** email/SMS/bulk-SMS/delete-auth-user/export-backup (still via `ipear_worker_secret`); **WordPress** `/woo-get-user` (+ `/woo-add-points` if 2.4.2 live); **Worker self** export-download HMAC + health-deep; **legacy** create-admin, woo-add/refund-points. The **parallel** v2 paths now exist but are not yet consumed.

## 14. Stage 3B migration plan (next)
1. Set Worker env (non-secret): `OWNER_UIDS=<owner uid>`, `FIREBASE_PROJECT_NUMBER=<public project number>` → activates v2 routes; verify a real owner+App-Check call succeeds end-to-end.
2. Migrate browser consumers (B2–B5) to attach `Authorization: Bearer <SDK ID token>` + `X-Firebase-AppCheck` and call `/admin/v2/*`; the admin app already initializes Firebase Auth + App Check.
3. Remove `src/admin/worker-secret.js` + the Notifications "Worker Secret" field; prove `localStorage`/`sessionStorage` carry no `ipear_worker_secret`; bundle carries no master secret.
4. Keep legacy routes live for rollback until 3D. ADMIN_SECRET not rotated.

## 15. Rollback procedure
Stage 3A rolls back by **not using** the v2 routes (legacy ADMIN_SECRET paths untouched). To fully revert the deploy: redeploy the prior `email-worker` version (previous version retained by Cloudflare) or remove the additive route block + `owner-auth.js` import and redeploy. ADMIN_SECRET remains valid throughout. No secret/WordPress/rule/function change to undo.

---

## HARD STOP — STAGE 3A COMPLETE
No browser/WordPress migration, no legacy endpoint disabled, no secret rotated/revoked, no Cloudflare Access/MFA. Awaiting approval to begin **Stage 3B** (activate v2 config + migrate the admin browser).

### FINAL VERDICT: READY FOR STAGE 3B — PARALLEL AUTH REPLACEMENT VERIFIED
