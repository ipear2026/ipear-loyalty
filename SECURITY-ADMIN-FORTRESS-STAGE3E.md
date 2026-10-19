# iPear Loyalty — ADMIN FORTRESS · STAGE 3E (zero-consumer proof / pre-rotation gate)

**Date:** 2026-10-07 · **Role:** Security Architect · **Mode:** PROOF / OBSERVATION ONLY — no production mutation. No ADMIN_SECRET rotation/revocation/deletion, the `ADMIN_LEGACY_ROUTES_ENABLED` switch was **not** enabled, no legacy route restored, no deploy of any kind.

> **STATUS: COMPLETE — ZERO ACTIVE CONSUMERS PROVEN.** Across every component (admin browser, WordPress 2.5.3, customer PWA, tablet, Functions, Worker) `ADMIN_SECRET` has **0 active consumers** and **0 active runtime authority**. The only runtime reads sit behind a fail-closed switch that is absent in production. `ADMIN_SECRET` persists solely as a configured Cloudflare secret (+ a stale WordPress option) for rollback — both scheduled for removal in Stage 3F.

---

## 1. Production state freeze (3E.0)
| Asset | Identity (frozen) | Changed since 3D? |
|---|---|---|
| Worker (active, 100%) | `b4c05a77-b24d-496e-b5a3-16beb07c9c0e` | no |
| Worker (rollback) | `e8557bc0-7548-4236-a8c8-be2de9f1f3c9` | — |
| Cloudflare account | `f02bde005d8c8f63cf76a9f7a1c9ee3f` (ipear2026@gmail.com) | — |
| Pages — admin bundle (live) | `assets/admin-DKanSCzM.js` (owner-auth build) | no (3B) |
| Pages — customer bundle (live) | `assets/main-CK7Edhjs.js` | no |
| Woo plugin | **2.5.3** (active) | no (3C) |
| Firestore ruleset (source) | sha256 `10df4875…` (byte-identical to locked) | no |
| Fortress Cloud Functions | 5 callables ACTIVE (not redeployed) | no |
| Feature flags (live bundle) | `VITE_ADMIN_OWNER_AUTH:"1"`, `VITE_ADMIN_SERVER_FINANCIAL:"1"` | no |
| Scoped Woo creds | `WOO_LOOKUP_SECRET` (lookup), `WOO_LOYALTY_SECRET` (credit/refund), `BACKUP_SIGNING_KEY` (export HMAC) | no |

No unexpected deployment occurred after Stage 3D. **Not blocked.**

## 2. Complete ADMIN_SECRET reference classification (3E.1)
Scanned Worker, admin frontend, customer PWA, tablet, Woo 2.5.3, Functions (`functions/index.js`, 1968 lines), service workers, scripts, tests, config, and the live production bundles.

| Class | Meaning | Count | Where |
|---|---|---|---|
| **A — ACTIVE AUTHORITY** | grants live privilege | **0** | — |
| **B — ACTIVE CONSUMER** | live code sends/reads it | **0** | — |
| C — DORMANT ROLLBACK | reachable only via the off-by-default switch / flag-OFF branch | several | Worker rollback gate (lines 454→463, 3405→3410, guarded); frontend `getWorkerSecret()` branches + `worker-secret.js`; Woo 2.5.3 `ipear_admin_secret` settings-field + preserve-on-empty sanitizer |
| D — TEST ONLY | `'test-admin-secret'` fixtures | many | `tests/*` |
| E — DOC / COMMENT | no value | many | `email-worker.js` comments, `wrangler.toml` line 8 comment, `SECURITY-*.md` |
| F — CONFIGURED SECRET ONLY | stored, no active reader | 2 | Cloudflare Worker secret `ADMIN_SECRET` (active config); WordPress `ipear_admin_secret` option (stale) |
| G — DEAD / UNREACHABLE | — | 0 | (the create-admin handler was **deleted**, not left dead) |

**A = 0 and B = 0 → not blocked.**

## 3. Deployed Worker control-flow proof (3E.2)
Deployed source (`b4c05a77`) has exactly **two** `env.ADMIN_SECRET` reads — router line 463 and `handleHealthDeep` line 3410. Each is immediately preceded by a fail-closed guard:
```
454:  if (env.ADMIN_LEGACY_ROUTES_ENABLED !== 'true') return 410 endpoint-retired;   // then 463: ADMIN_SECRET compare
3405: if (env.ADMIN_LEGACY_ROUTES_ENABLED !== 'true') return 410 endpoint-retired;   // then 3410: ADMIN_SECRET compare
```
`ADMIN_LEGACY_ROUTES_ENABLED` is **absent** in production (not a Worker secret, not a `wrangler.toml` var) → `!== 'true'` is true → **410 is returned before any secret comparison**. Therefore: correct ADMIN_SECRET cannot bypass retirement; wrong ADMIN_SECRET is identical; absent config fails closed. `/admin/create-admin-user` returns 410 **unconditionally** (no switch). The final `return handleEmail(...)` fallthrough is gone — an unknown POST hits the 410 guard. No alias/fallback path reaches ADMIN_SECRET authority. Explicitly verified retired: `/`, `/sms`, `/bulk-sms`, `/admin/redeem-attempt`, `/admin/delete-auth-user`, `/admin/export-backup`, `/admin/create-admin-user`, `/woo-add-points`, `/woo-refund-points`, `/woo-get-user`, `GET /health-deep` (+ unknown POST). The cron calls `_runHealthDeep(env)` in-process (no bearer); the export HMAC uses `BACKUP_SIGNING_KEY`.

## 4. Create-admin zero-surface proof (3E.3)
- Router: `/admin/create-admin-user` → `410` **unconditionally** (line 436), no v2 equivalent exists.
- Handler implementation **deleted** (tombstone comment only at line 2160); no `handleCreateAdminUser` function remains.
- **No Worker route writes `ipear_admins`** — the sole reference is a defensive **read** in `/verify-sms-otp` orphan-cleanup (line 696) that *refuses* to delete a uid found in `ipear_admins`.
- **No `setCustomUserClaims` / `customAttributes` / `:setAccountInfo`** anywhere in the Worker → no HTTP route can assign the `admin:true` claim.
- Browser cannot write `ipear_admins` (Firestore rules, unchanged `10df4875…`); Woo creds and customer/tablet identity cannot mint admins (no route + rules).
- **RUNTIME HTTP ADMIN-MINTING SURFACE = 0.** Future bootstrap = out-of-band operator procedure only.

## 5. Consumer count per component (3E.4)
| Component | Active ADMIN_SECRET consumers | Evidence |
|---|---|---|
| Admin frontend | **0** | live bundle `admin-DKanSCzM.js`: `VITE_ADMIN_OWNER_AUTH:"1"` → `isOwnerAuthEnabled()===true`; all sends take the owner-api `/admin/v2/` path; `ipear_worker_secret` purged at startup; legacy `getWorkerSecret` branch dormant |
| WordPress 2.5.3 | **0** | lookup → `/woo/v2/get-user` (`WOO_LOOKUP_SECRET`), credit/refund → `WOO_LOYALTY_SECRET`; `ipear_admin_secret` read by no active flow (settings/sanitizer only); live traffic confirmed in 3C |
| Customer PWA | **0** | live bundle `main-CK7Edhjs.js`: `ADMIN_SECRET`=0, `ipear_worker_secret`=0, `woo-get-user`=0; coupon via Firebase idToken |
| Tablet | **0** | no `ADMIN_SECRET` / worker-secret / legacy-route reference in `src/tablet*` |
| Functions | **0** | `functions/index.js`: no `ADMIN_SECRET` / worker-bearer / `workers.dev` reference |
| Worker | **0 active acceptance** | §3 control-flow proof |

## 6. Live traffic corroboration (3E.5)
A live `wrangler tail` (3C) captured production WordPress calling `POST /woo/v2/get-user` → 200 with **no** `/woo-get-user` (ADMIN_SECRET) call. **Limitation (stated explicitly):** `wrangler tail` is real-time only — this session has **no historical/analytics visibility** into requests since the 3D deploy, so I cannot enumerate past legacy-route hits. Per 3E.5, a short tail is **not** treated as proof of zero historical callers; **static + control-flow + source proof (§2–§5) is primary**, and it is conclusive. No evidence of any production caller hitting a retired 410 route was observed. (Stage 3F should run a representative live-tail window as added assurance.)

## 7. Retired-route live matrix (3E.6) — non-destructive
Every retired route returns **`410 {"error":"endpoint-retired"}`** with an **identical body for no-credential and wrong-credential** (no secret oracle):
`/` · `/sms` · `/bulk-sms` · `/admin/redeem-attempt` · `/admin/delete-auth-user` · `/admin/export-backup` · `/admin/create-admin-user` · `/woo-add-points` · `/woo-refund-points` · `/woo-get-user` · `GET /health-deep` · unknown POST `/zzz`. (ADMIN_SECRET value never used/printed; the 410-before-compare design makes a "correct secret" probe unnecessary and it is unit-proven.)

## 8. Replacement-route health (3E.7) — non-destructive
`/health` → 200 · `/admin/v2/{email,sms,bulk-sms,delete-auth-user,export-backup}` (bogus token) → 401 (alive, never 410) · `/woo/v2/get-user` (bogus) → 401 · `/woo-credit-order`,`/woo-refund-order` (bogus) → 401 · `/woo-create-coupon` (no idToken) → 400 "idToken required" (off the ADMIN_SECRET gate). No real email/SMS sent, no balance mutated, no admin created.

## 9. Scoped-credential isolation (3E.8)
- **`WOO_LOOKUP_SECRET`** — authorizes only `/woo/v2/get-user`; DENIED on credit/refund/admin-v2/retired/create-admin (proven live with the real secret in 3C → 401 on every privileged endpoint; re-affirmed by the `worker-routes` isolation suite).
- **`WOO_LOYALTY_SECRET`** — authorizes only `/woo-credit-order` + `/woo-refund-order`; DENIED on lookup/admin/create-admin.
- **Firebase owner identity** — authorizes only `/admin/v2/*` (admin:true + OWNER_UID + App Check); does **not** revive any legacy route.
- **`ADMIN_SECRET`** — authorizes **NOTHING active** (every route 410s before its compare).

## 10. Remaining ADMIN_SECRET storage locations (3E.10)
| Location | Classification |
|---|---|
| Cloudflare Worker secret `ADMIN_SECRET` | **ACTIVE CONFIG** (rollback only; 0 readers) → delete in 3F |
| WordPress `ipear_admin_secret` option | **STALE STORED COPY** (0 active consumers; unverifiable from here — no WP access) → remove in 3F |
| `wrangler.toml` line 8, `email-worker.js` comments, `SECURITY-*.md` | DOCUMENTATION only (no value) |
| `./.env`, `./functions/.env.loyalty-ipear` | do **not** contain `ADMIN_SECRET` (verified); gitignored + untracked |
| Shell history (earlier sessions) | **HISTORICAL/UNCONFIRMED** — not assessed (out of task scope); this session never echoed the value |
| CI/deploy env | none (deploys are manual `wrangler`) |

## 11. WordPress stale-secret status (3E.11)
Active 2.5.3 plugin reads `ipear_admin_secret` in **0** active flows. Whether the stored option still holds a value cannot be confirmed without WordPress access; treat as **STALE STORED COPY — ZERO ACTIVE CONSUMERS**. **Not removed in 3E** (no WP access, and sequencing says remove after global proof). Removal scheduled for 3F (owner action).

## 12. Local plaintext-secret housekeeping (3E.12)
`~/Desktop/WOO_LOOKUP_SECRET.txt` is **still present** (0600, 373 bytes) — the Stage-3C lookup-secret handoff file. It is **not** ADMIN_SECRET, but it is a plaintext secret that is no longer needed (the value is live in Cloudflare + WordPress). **Owner action: delete it.** (Contents not displayed.) No `*ADMIN*`/other `*SECRET*` plaintext files found on the Desktop.

## 13. Two independent final scans (3E.13)
- **SCAN A (static/primitive):** route + reference grep over Worker, both live bundles, tablet, Functions, plugin, service workers, scripts, tests → **0** active callers of any ADMIN_SECRET route; admin/customer bundles show `ADMIN_SECRET`/`ipear_worker_secret`/`woo-get-user` = 0 active.
- **SCAN B (semantic/control-flow):** exactly 2 guarded `env.ADMIN_SECRET` reads, both behind the absent fail-closed switch; cron + export decoupled; no `ipear_admins` write; no claim assignment.
- **Agreement:** browser **0** · WordPress **0** · Worker acceptance **0** · Functions **0** · customer/tablet **0** · runtime authority **0**. **Scans agree → not blocked.**

## 14. Full regression results (3E.14)
Pure vitest **522/522** · Firestore rules **63/63** · §6b locked **15/15** · lifecycle **8/8** · `wrangler deploy --dry-run` clean (180.22 KiB) · ESLint clean (only pre-existing `MAX_TOKENS` warning) · secret scan clean (only the `-----BEGIN PRIVATE KEY-----` PEM-strip literal) · source-map scan: no `upload_source_maps` → none served · plugin static checks unchanged (2.5.3). No Stage-2/3 regression; `firestore.rules` `10df4875…` unchanged; functions untouched.

## 15. Git / production-source integrity (3E.15)
- **HEAD:** `5dcbe37` (Stage 2). Stages 3A–3D are **live but uncommitted**.
- **Live-but-uncommitted, production-authoritative:**
  - `email-worker.js` — Worker `b4c05a77` (3A/3B/3C/3D)
  - `src/admin/owner-api.js` (new), `src/worker/lib/owner-auth.js` (new) — 3A/3B
  - `src/admin-main.js`, `src/admin/email-worker.js`, `src/admin/messaging.js`, `src/admin/bulk-messaging-send.js`, `src/firebase-init.js` — 3B (Pages `admin-DKanSCzM.js`)
  - `tests/owner-auth.test.js`, `tests/owner-api.test.js` (new); `tests/worker-routes.test.js`, `tests/legacy-cutover.test.js` (modified)
  - Reports `SECURITY-ADMIN-FORTRESS-STAGE3*.md` (docs)
- **Must NOT be committed:** `node_modules/` (untracked — do **not** `git add .`), `.env`, `functions/.env.loyalty-ipear` (gitignored secrets), `.tmp-appcheck-fixture/` (test scratch), `ipear-pages-FLAG-ON-*.MANIFEST.sha256` (generated artifact).
- **Recommended commit boundary (prepared, NOT executed — push not authorized):** one explicit commit of the files above —
  `git add email-worker.js src/admin/owner-api.js src/worker/lib/owner-auth.js src/admin-main.js src/admin/email-worker.js src/admin/messaging.js src/admin/bulk-messaging-send.js src/firebase-init.js tests/owner-auth.test.js tests/owner-api.test.js tests/worker-routes.test.js tests/legacy-cutover.test.js SECURITY-ADMIN-FORTRESS-STAGE3*.md` → message `SECURITY: Admin Fortress Stage 3A–3E (owner-auth migration + ADMIN_SECRET runtime retirement)`. No secrets are staged. Do not push until authorized.

## 16. Exact Stage 3F revoke/delete sequence (3E.16 → 3F)
Pre-rotation gate — all true: (1) browser 0 · (2) WordPress 0 · (3) Worker acceptance 0 · (4) Functions 0 · (5) customer/tablet 0 · (6) create-admin surface 0 · (7) no component requires ADMIN_SECRET · (8) replacements healthy · (9) rollback no longer needs a browser/WP master secret (§17) · (10) storage locations known (§10). **All satisfied.**

Proposed 3F order (each its own authorized step; nothing here is executed in 3E):
1. **(Optional, recommended) Retire the rollback dependency first:** since switch-based rollback becomes non-functional the moment the secret is deleted (§17), delete the dormant rollback handlers + the `ADMIN_LEGACY_ROUTES_ENABLED` branch from `email-worker.js` and redeploy — so the code no longer implies a rollback that cannot work. (Keep the 410 retirement + create-admin removal.)
2. **Revoke the Worker secret:** `wrangler secret delete ADMIN_SECRET` (account `f02bde…`). Safe — no runtime route reads it.
3. **Remove the WordPress stale option** `ipear_admin_secret` (owner, WP admin) — after confirming 2.5.3 lookup still works.
4. **Purge stale local/handoff copies:** delete `~/Desktop/WOO_LOOKUP_SECRET.txt`; optionally clear any historical shell-history entries (owner's discretion).
5. **Post-3F verification:** `/health` 200; `/admin/v2/*`, `/woo/v2/get-user`, `/woo-credit-order`, `/woo-refund-order` healthy; retired routes still 410; a My-Account lookup + a Woo order credit succeed; cron health-deep still logs. Record in `SECURITY-ADMIN-FORTRESS-STAGE3F.md`.

## 17. Rollback model after revocation (3E.9, 3E.17)
- **Possible after 3F:** forward rollback to any **modern** owner-auth / scoped-credential Worker build (e.g. redeploy `b4c05a77` or a forward fix). Owner-auth (`/admin/v2/*`), scoped Woo (`WOO_LOOKUP_SECRET`/`WOO_LOYALTY_SECRET`), and `BACKUP_SIGNING_KEY` are all independent of `ADMIN_SECRET`.
- **Impossible / unsafe after 3F:** restoring old Worker `e8557bc0` — its routes **require** `ADMIN_SECRET`, which will no longer exist, so they would `401` (non-functional). Likewise, enabling `ADMIN_LEGACY_ROUTES_ENABLED` after deletion only reaches a gate that `401`s on a missing secret. **Master-secret rollback is therefore dead post-revocation — by design.**
- **Invariant achieved:** no rollback procedure requires restoring a master secret to the browser or WordPress. This is why step 1 above (removing the now-useless rollback code) is recommended rather than retained.

---

## HARD STOP — STAGE 3E COMPLETE (proof only)
ADMIN_SECRET **not** rotated/revoked/deleted. `ADMIN_LEGACY_ROUTES_ENABLED` **not** enabled. No legacy route restored. No deploy. No Stage 3F started. No Cloudflare Access/passkeys/MFA.

### Final counts
ADMIN BROWSER = **0** · WORDPRESS = **0** · WORKER ACTIVE ACCEPTANCE = **0** · FUNCTIONS = **0** · CUSTOMER/TABLET = **0** · RUNTIME ADMIN-MINTING = **0** · **GLOBAL ACTIVE ADMIN_SECRET AUTHORITY = 0**

### FINAL VERDICT: READY FOR STAGE 3F — ADMIN_SECRET HAS ZERO ACTIVE CONSUMERS
