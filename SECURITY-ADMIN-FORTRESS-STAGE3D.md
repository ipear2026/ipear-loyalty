# iPear Loyalty — ADMIN FORTRESS · STAGE 3D (retire the legacy ADMIN_SECRET surface)

**Date:** 2026-10-07 · **Role:** Security Architect · **Mode:** Worker-only, additive-to-retire. No ADMIN_SECRET rotation/revocation, no config-secret removal, no Stage-2 rules/functions touched, no frontend/plugin/Pages/Functions deploy, no Cloudflare Access/MFA. Builds on 3C (Worker `e8557bc0`, WordPress 2.5.3) + 3B (frontend `519fbd7c`) + Stage-2 commit `5dcbe37`.

> **STATUS: COMPLETE + VERIFIED LIVE.** Every runtime HTTP endpoint that accepted `ADMIN_SECRET` is retired (fail-closed `410 endpoint-retired`). `/admin/create-admin-user` is retired **unconditionally** and its handler implementation **deleted**. The cron deep-health probe and the backup download-URL HMAC no longer touch `ADMIN_SECRET`. **ACTIVE RUNTIME ENDPOINTS ACCEPTING ADMIN_SECRET = 0.** `ADMIN_SECRET` itself remains configured for controlled rollback only (not rotated — that is Stage 3F, after 3E proves zero consumers).

---

## 1. Authoritative legacy ADMIN_SECRET route inventory (3D.0)

Enumerated by scanning the deployed Worker for every `env.ADMIN_SECRET` read (direct compare, cron bearer, HMAC key) and the single shared gate. There was **one** master gate (`if (!env.ADMIN_SECRET || !timingSafeEqual(auth, env.ADMIN_SECRET)) 401`) plus the `/health-deep` compare and the export HMAC key.

| Route | Method | Capability (pre-3D) | Active caller (pre-3D) | Replacement | Decision | Rollback |
|---|---|---|---|---|---|---|
| `/` (fallback → email) | POST | send branded email | none (admin uses v2) | `/admin/v2/email` | **RETIRE** | switch |
| `/sms` | POST | transactional SMS | none (admin uses v2) | `/admin/v2/sms` | **RETIRE** | switch |
| `/bulk-sms` | POST | bulk SMS | none (admin uses v2) | `/admin/v2/bulk-sms` | **RETIRE** | switch |
| `/admin/delete-auth-user` | POST | delete Auth user + anonymize | none (admin uses v2) | `/admin/v2/delete-auth-user` | **RETIRE** | switch |
| `/admin/export-backup` | POST | full-DB PII export → R2 | none (admin uses v2) | `/admin/v2/export-backup` | **RETIRE** | switch |
| `/admin/redeem-attempt` | POST | redemption brute-force guard | **none** (orphaned; no caller in any frontend) | none needed | **RETIRE** | switch |
| `/woo-add-points` | POST | legacy loyalty credit (mutation) | none (Woo 2.5.3 uses `/woo-credit-order`) | `/woo-credit-order` (`WOO_LOYALTY_SECRET`) | **RETIRE** | switch |
| `/woo-refund-points` | POST | legacy loyalty refund (mutation) | none (Woo 2.5.3 uses `/woo-refund-order`) | `/woo-refund-order` (`WOO_LOYALTY_SECRET`) | **RETIRE** | switch |
| `/woo-get-user` | POST | My-Account points lookup (read) | none (Woo 2.5.3 uses `/woo/v2/get-user`) | `/woo/v2/get-user` (`WOO_LOOKUP_SECRET`) | **RETIRE** | switch |
| `/admin/create-admin-user` | POST | **mint/reset a loyalty admin** | none (no UI / tablet / WP / script) | none (out-of-band operator procedure) | **RETIRE PERMANENTLY** | **none** |
| `GET /health-deep` | GET | deep health probe (Brevo+Firestore) | cron (in-process) + manual debug | cron → in-process `_runHealthDeep()` | **RETIRE HTTP surface** | switch |
| `GET /admin/export-download` | GET | HMAC-signed R2 stream | export flow | **HMAC key moved** ADMIN_SECRET → `BACKUP_SIGNING_KEY` | **DECOUPLE** | n/a |

Also re-audited and confirmed **not** ADMIN_SECRET-gated (unchanged): all public endpoints (`/reset-password`, `/check-*`, `/process-referral`, `/send-welcome`, `/send-sms-otp`, `/verify-sms-otp`, `/woo-sync-tier`, `/client-error`, `/log-event`), `/erp/*` (ERP_SECRET), `/woo-credit-order` + `/woo-refund-order` (WOO_LOYALTY_SECRET), `/woo/v2/get-user` (WOO_LOOKUP_SECRET), `/admin/v2/*` (Firebase owner auth + App Check), `GET /health` (public).

**`/woo-create-coupon` — the one anomaly.** Its handler authenticates the **customer** by Firebase ID token ("Public endpoint"), yet it sat *behind* the ADMIN_SECRET gate, so idToken-only customer calls were `401`'d (feature effectively broken, confirmed live pre-deploy). Decision: **moved before the gate** into the public/idToken section. This removes it from the ADMIN_SECRET surface **and** unblocks the intended idToken path. (Full coupon issuance additionally needs `WOO_URL/WOO_KEY/WOO_SECRET`, which are **not currently configured** — pre-existing, out of 3D scope.)

## 2. Replacement coverage proof (3D.1)
Every retired capability with a real need has a **live** replacement (all verified returning deny-not-410 post-deploy, §11): email/SMS/bulk-SMS/delete-auth-user/export-backup → `/admin/v2/*` (Firebase ID token + `admin:true` + `OWNER_UIDS` + App Check); Woo lookup → `/woo/v2/get-user` (`WOO_LOOKUP_SECRET`); Woo credit/refund → `/woo-credit-order`,`/woo-refund-order` (`WOO_LOYALTY_SECRET`). `/admin/redeem-attempt` has **no** active caller, so no replacement is required. No active capability was left without a safe path → **not blocked**.

## 3. create-admin retirement proof (3D.2)
- No caller anywhere: scanned admin bundle/source, tablet, customer PWA, Woo 2.5.3, deploy scripts — **0** references to `create-admin-user`.
- Router now returns `410 endpoint-retired` for `/admin/create-admin-user` **unconditionally** — there is **no** `ADMIN_LEGACY_ROUTES_ENABLED` branch for it, so even server-side rollback cannot resurrect it.
- The handler **implementation was deleted** (replaced by a tombstone comment). No code path — rollback included — can mint or reset a loyalty admin over HTTP.
- Returned **before** any secret compare → identical response for correct/wrong/no secret (no oracle).
- Future bootstrap/recovery = out-of-band operator procedure (Firebase console / Admin SDK sets password, writes `ipear_admins/{uid}` + `admin:true` claim). Documented, never a runtime route.
- **Live:** `/admin/create-admin-user` → `410` with no auth, with a bearer, and even under rollback mode (unit-proven).

## 4. Legacy financial endpoint retirement proof (3D.5)
`/woo-add-points` and `/woo-refund-points` (the only ADMIN_SECRET-authable server mutation routes) now return `410` by default — **before** the ADMIN_SECRET compare — superseding the older per-endpoint `LOYALTY_LEGACY_MUTATION_DISABLED` switch. A stolen ADMIN_SECRET can no longer reach a server-side loyalty-balance mutation. The authoritative financial path is unchanged: `/woo-credit-order` + `/woo-refund-order` (`WOO_LOYALTY_SECRET`, integer-cent + Firestore ledger idempotency), plus the Stage-2 §6b Firestore lock for browser clients.

## 5. Two independent caller scans (3D.12)
**SCAN A — static/primitive.** Grepped the full worktree (`src/`, the `ipear-loyalty-vite` project, `functions/`, the 2.5.3 plugin, deploy scripts, service workers, tests) for literals of every retired route. Frontend worker-endpoint literals in use: `/admin/v2/*` (owner-api), `/woo-create-coupon` (idToken), `/woo-sync-tier`, `/health`, and the **flag-OFF legacy branches** of `/sms`/`/bulk-sms`/`/admin/delete-auth-user` (inert in production — owner-auth flag is ON). **0** active callers of any retired ADMIN_SECRET route. WordPress 2.5.3: only `/woo/v2/get-user`, `/woo-credit-order`, `/woo-refund-order`; `ipear_admin_secret` read by no active flow.

**SCAN B — semantic/control-flow.** Deployed Worker has exactly **two** `env.ADMIN_SECRET` reads (lines 463, 3410). Each is immediately preceded by a fail-closed `if (env.ADMIN_LEGACY_ROUTES_ENABLED !== 'true') return 410` guard (lines 454, 3405). The switch is **absent** in production (not a Worker secret, not a `wrangler.toml` var) → every legacy path 410s before any secret compare. The cron calls `_runHealthDeep(env)` in-process (no bearer); the export HMAC uses `BACKUP_SIGNING_KEY`. **Scans agree: active ADMIN_SECRET acceptance = 0.**

## 6. Adversarial test matrix results (3D.10, 3D.11) — all green
Added to [tests/worker-routes.test.js](tests/worker-routes.test.js) (§Stage 3D) + updated [tests/legacy-cutover.test.js](tests/legacy-cutover.test.js):
- **Create-admin:** no-auth / correct ADMIN_SECRET / wrong ADMIN_SECRET / WOO_LOOKUP_SECRET / WOO_LOYALTY_SECRET → **410**; still **410** in rollback mode.
- **Every legacy route** (`/sms`,`/bulk-sms`,`/admin/redeem-attempt`,`/admin/delete-auth-user`,`/admin/export-backup`,`/woo-add-points`,`/woo-refund-points`,`/woo-get-user`,`/`,`unknown`): no-auth → 410, **correct ADMIN_SECRET → 410** (no oracle), wrong → 410. `GET /health-deep` → 410.
- **Replacements:** `/admin/v2/*` bogus token → 401/403 (never 410); `/woo/v2/get-user` lookup secret → 200; `/woo-credit-order` wrong secret → 401 (never 410).
- **Coupon off-gate:** no idToken → 400 (reached handler), stale ADMIN_SECRET bearer does not gate it.
- **Cross-credential isolation:** lookup secret → DENIED on credit/refund/admin-v2/retired/create-admin; loyalty secret → DENIED on lookup/admin-v2/create-admin; customer/tablet tokens → DENIED on owner routes.
- **Rollback mode:** legacy routes authorize again with correct ADMIN_SECRET (wrong → 401); create-admin stays 410.

## 7. Regression results (3D.14) — no Stage-2/3 regression
Pure vitest **522/522** (worker-routes 80 incl. Stage-3D; legacy-cutover 9; owner-auth 28; owner-api 9; woo-integrity/H1/offer-credit) · Firestore rules **63/63** · §6b locked **15/15** · lifecycle **8/8** · `wrangler deploy --dry-run` clean (180.22 KiB) · ESLint clean (only pre-existing `MAX_TOKENS` warning; the create-admin removal cleared its unused-fn warning) · secret scan clean (only the `-----BEGIN PRIVATE KEY-----` PEM-strip literal) · source-map scan: no `upload_source_maps` → none served (the `.map` is a local dry-run artifact) · **`firestore.rules` unchanged** (`10df4875…`) · functions untouched/not redeployed · admin owner-auth untouched (`519fbd7c`) · Woo 2.5.3 scoped secrets untouched.

## 8. Previous Worker version
`e8557bc0-7548-4236-a8c8-be2de9f1f3c9` (2026-10-06, the Stage-3C `WOO_LOOKUP_SECRET` set). Rollback target.

## 9. New Worker version
`b4c05a77-b24d-496e-b5a3-16beb07c9c0e` (2026-10-07, account `f02bde…`, via owner `wrangler login`). `wrangler deploy` preserved all existing secrets; `BACKUP_SIGNING_KEY` added beforehand.

## 10. Exact retired-route behavior (3D.8, 3D.9)
`HTTP 410` with body `{"error":"endpoint-retired"}` — generic, leaking no replacement path, auth config, OWNER_UID, or secret name/value. Returned **before** any ADMIN_SECRET comparison, so a correct or incorrect secret yields an identical response (no secret-validity oracle). `/admin/create-admin-user` is unconditional; all others are governed by the fail-closed `ADMIN_LEGACY_ROUTES_ENABLED` switch (default = retired).

## 11. Passive / live verification (3D.17) — all pass
`/health` → 200. Retired (arbitrary bearer) → **410**: `/sms`,`/bulk-sms`,`/admin/export-backup`,`/admin/delete-auth-user`,`/admin/redeem-attempt`,`/woo-add-points`,`/woo-refund-points`,`/woo-get-user`,`/` (root), `GET /health-deep`. `/admin/create-admin-user` → **410** (no-auth AND bearer), generic body. Replacements alive (deny, not 410): `/admin/v2/{email,sms,bulk-sms,delete-auth-user,export-backup}` → 401; `/woo/v2/get-user` bogus → 401; `/woo-credit-order`,`/woo-refund-order` wrong secret → 401. `/woo-create-coupon` no idToken → **400 "idToken required"** (off the gate). No admin created, no user deleted, no email/SMS/financial mutation performed for testing (destructive paths proven in the harness).

## 12. Post-deploy ADMIN_SECRET acceptance count (3D.18)
**ACTIVE RUNTIME ENDPOINTS ACCEPTING ADMIN_SECRET = 0.** Two `env.ADMIN_SECRET` compares remain in the source, both unreachable in production (fail-closed switch absent). `ADMIN_SECRET` is still a configured secret (rollback) but grants no runtime authority.

## 13. Active consumer count by component (3D.19)
- **Admin browser = 0** (Stage 3B owner-auth; legacy flag-OFF branches inert).
- **WordPress = 0** (Woo 2.5.3; verified live in 3C).
- **Worker runtime routes accepting ADMIN_SECRET = 0** (this stage).
- **create-admin = retired** (handler deleted; 410).
- **GLOBAL ACTIVE ADMIN_SECRET AUTHORITY = 0.** (`ADMIN_SECRET` remains configured for rollback only — not yet rotated; that is 3F.)

## 14. Rollback procedure (3D.15)
- **Full, instant:** redeploy the prior Worker version `e8557bc0` (`wrangler rollback` / deployments) — restores every pre-3D legacy route. `BACKUP_SIGNING_KEY` is additive and harmless to the old code.
- **Targeted (keep new code):** `wrangler secret put ADMIN_LEGACY_ROUTES_ENABLED` = `true` → re-enables the legacy ADMIN_SECRET routing (email/SMS/bulk/delete/export/woo-get-user/woo-mutation + the `/health-deep` HTTP probe). **create-admin stays retired** regardless. Set back to anything ≠ `true` (or `wrangler secret delete`) to re-retire.
- Rollback **never** requires putting `ADMIN_SECRET` back into the browser or WordPress, and does **not** downgrade the 3B frontend or 2.5.3 plugin. No rules/functions change to undo. `BACKUP_SIGNING_KEY` is server-side only (never handed out).

## 15. Exact Stage 3E plan (prove zero consumers, then 3F rotates)
1. **Observation window:** run `wrangler tail` across a representative period (a full business day incl. a My-Account load, a completed Woo order credit, an admin email/SMS/export action) and confirm **0** hits on any retired path and **0** `401 Unauthorized` that would indicate a stale ADMIN_SECRET caller; all admin traffic on `/admin/v2/*`, all Woo on `/woo/v2/get-user` + `/woo-credit-order`/`/woo-refund-order`.
2. **Static re-attest:** re-run SCAN A/B against the then-current admin bundle, tablet, customer PWA, Woo plugin, Worker, functions, deploy scripts → 0 active ADMIN_SECRET consumers.
3. **Sign-off:** record the window + scans in `SECURITY-ADMIN-FORTRESS-STAGE3E.md`; verdict `ADMIN_SECRET CONSUMERS = 0 — READY FOR 3F`.
4. **Then 3F (separate, gated):** rotate/revoke `ADMIN_SECRET`; optionally delete `ADMIN_LEGACY_ROUTES_ENABLED` and the dead rollback handlers; confirm nothing breaks; `ADMIN_SECRET REMOVED` only after a clean window.

---

## HARD STOP — STAGE 3D COMPLETE
No ADMIN_SECRET rotation/revocation, no rollback-secret removal, no Stage 3F, no Cloudflare Access/passkeys/MFA, no Stage-2 rules/functions touched, no frontend/plugin/Functions/Pages deploy. Worker-only.

### FINAL VERDICT: READY FOR STAGE 3E — ADMIN_SECRET RUNTIME AUTHORITY = 0
*(Worker `b4c05a77` deployed + verified live; every ADMIN_SECRET-accepting runtime endpoint retired fail-closed; create-admin retired unconditionally with its handler deleted; cron + backup-HMAC decoupled from ADMIN_SECRET; ADMIN_SECRET retained in config for rollback only, not rotated.)*
