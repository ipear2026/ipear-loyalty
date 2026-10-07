# iPear Loyalty — ADMIN FORTRESS · STAGE 3C (remove WordPress ADMIN_SECRET dependence)

**Date:** 2026-10-06/07 · **Role:** Security Architect · **Mode:** additive. No ADMIN_SECRET rotation/revocation, no legacy route disabled, no Stage-2 rules/functions touched, no Cloudflare Access/MFA. Builds on 3B (frontend `519fbd7c`) + Stage-2 commit `5dcbe37`.

> **STATUS: COMPLETE + VERIFIED LIVE (owner installed 2.5.3; live WordPress traffic observed).** The scoped read-only Worker lookup `/woo/v2/get-user` (auth by `WOO_LOOKUP_SECRET` only) is deployed, the secret is set, and the route is **live-verified with real production WordPress traffic** (see §12.1). **WordPress ADMIN_SECRET active consumers = 0 — confirmed live.**
>
> **LIVE CAPTURE (2026-10-07, `wrangler tail`):** production WordPress (`user-agent: WordPress/7.1.2; https://ipear.gr`, Hostinger ASN 47583, CDG) issued **`POST /woo/v2/get-user`** with an `Authorization` bearer → **HTTP 200**. In the same capture window **NO `/woo-get-user` (legacy ADMIN_SECRET) request appeared** — the only other hits were browser `/health` GETs and the scheduled `health-deep` cron. This is independent live proof that the My-Account lookup now runs on `WOO_LOOKUP_SECRET` via the v2 route and no longer touches ADMIN_SECRET.

---

## 1. Proven live Woo version / source / hash (Gate 3C.0)
- **LIVE WOO VERSION = PROVEN 2.5.2** — owner-confirmed from the production WordPress → Plugins screen ("iPear Loyalty – WooCommerce Integration · Version 2.5.2 · ACTIVE").
- **Recovered artifact re-verified:** `~/Downloads/ipear-woo-loyalty.zip`, SHA256 `319033eefddded6a88ff3172f285fb6b15893afa1053a4d8ad24c8af05085ea0` (**match**). Extracted PHP sha256 `64a0bf4b1bdf8342ebf570200e5dce9ae8c81ff0b22feb2ac8c5a6a32fe2eeb1`.
- **EXACT FILE-BYTE IDENTITY vs production = NOT INDEPENDENTLY PROVEN** (no authorized WP/Hostinger file download). Per the gate update, this is **not** a version-authority blocker. Built forward **only** from the verified 2.5.2 artifact — **never** the repo 2.4.2.

## 2. Old WordPress secret model (2.5.2)
| WP option | Endpoint | Capability | Status |
|---|---|---|---|
| `ipear_woo_loyalty_secret` | `/woo-credit-order`, `/woo-refund-order` | order credit / refund (financial) | kept, unchanged |
| **`ipear_admin_secret` (ADMIN_SECRET)** | `/woo-get-user` | My-Account points lookup (read) | **the residual being removed** |

## 3. New scoped secret model (2.5.3)
| WP option | Worker endpoint | Capability |
|---|---|---|
| `ipear_woo_loyalty_secret` → `WOO_LOYALTY_SECRET` | `/woo-credit-order`, `/woo-refund-order` | credit/refund only (unchanged) |
| **`ipear_woo_lookup_secret` → `WOO_LOOKUP_SECRET`** | **`/woo/v2/get-user`** | read-only customer/points lookup only |
| `ipear_admin_secret` | — | **rollback-only; read by NO active flow** |

WordPress ends holding **no active ADMIN_SECRET dependency**.

## 4. WOO_LOOKUP_SECRET endpoint (Worker)
`POST /woo/v2/get-user` ([email-worker.js](email-worker.js), `handleWooLookupV2`): routed **before** the ADMIN_SECRET gate; auth = `WOO_LOOKUP_SECRET` only, **timing-safe**; POST-only (else 405); fail-closed if the secret is unset (503); **no ADMIN_SECRET fallback**. Returns the shared minimized shape `{ name, points, totalPoints, card }` for a **single exact-email** match (no enumeration, no other PII/claims/audit — §3C.4), with `Cache-Control: no-store`. One source of truth: `_wooCustomerLookup()` backs both the legacy `/woo-get-user` and the new route. §3C.5: a static scoped bearer over TLS is adequate for a read-only, non-enumerating lookup; HMAC signing not warranted. Financial endpoints' idempotency/replay unchanged.

## 5. Plugin version deployed (built, pending install)
**2.5.3** — forward from the verified 2.5.2 artifact. Changes: added `ipear_woo_lookup_secret` option + settings field + getter + preserve-on-empty sanitizer; My-Account lookup now `ipear_woo_lookup_secret` → `/woo/v2/get-user` (was `ipear_admin_secret` → `/woo-get-user`); **no ADMIN_SECRET fallback** (missing lookup secret → signup card, fail-safe); `ipear_admin_secret` option/sanitizer retained **rollback-only** (0 active reads); credit/refund + idempotency untouched. **ZIP:** `/Users/notisbountouris/Desktop/ipear-woo-loyalty-2.5.3.zip` (brace-balanced; php binary unavailable locally so `php -l` not run — static/token checks passed).

## 6. Active endpoint mapping (after 2.5.3 install)
| Flow | Endpoint | Secret |
|---|---|---|
| My-Account lookup | `/woo/v2/get-user` | `WOO_LOOKUP_SECRET` |
| Order credit | `/woo-credit-order` | `WOO_LOYALTY_SECRET` |
| Refund | `/woo-refund-order` | `WOO_LOYALTY_SECRET` |
| (legacy `/woo-get-user`) | retained | ADMIN_SECRET — no active WP caller |

## 7. Adversarial test results — **10/10** (`tests/worker-routes.test.js` §Stage 3C), live-confirmed
`WOO_LOOKUP_SECRET`: correct → 200 minimized + `no-store`; missing → 401; wrong → 401; **ADMIN_SECRET alone → 401** (no fallback); `WOO_LOYALTY_SECRET` → 401; unset → 503; GET → 405. **Isolation:** lookup secret → 401 on `/woo-credit-order`, on legacy `/admin/export-backup`, and on `/admin/v2/email`. **Live:** correct-secret+nonexistent-email → 404 (auth OK), `no-store` present, no-auth/wrong → 401, GET → 405, legacy `/woo-get-user` → 401, lookup-on-credit → 401.

## 8. WordPress compromise simulation
Attacker holding **both** `WOO_LOOKUP_SECRET` + `WOO_LOYALTY_SECRET` **cannot**: mint an admin, call `/admin/v2/*` or legacy `/admin/*`, delete Firebase users, export all customers, send SMS/bulk-SMS, change claims, gain OWNER authority, or alter Firestore financial state (Stage-2 §6b lock). **Residual blast radius:** credit/refund orders (idempotent, ledger-audited) + read one customer's `{name,points,totalPoints,card}` by exact email. No enumeration.

## 9. Regression results — no Stage-2 regression
Full pure vitest **472/472** (worker-routes 32 incl. 10 Stage-3C; owner-auth 28; owner-api 9; offer-credit/H1) · Firestore rules **63/63** · §6b locked **15/15** · lifecycle **8/8** · `wrangler deploy --dry-run` clean (183.69 KiB) · lint clean (pre-existing `MAX_TOKENS` warning only) · secret scan clean (only the `-----BEGIN PRIVATE KEY-----` PEM-strip literal, runtime key parsing) · **`firestore.rules` unchanged** (`10df4875…`) · functions + rules untouched.

## 10. Worker deployment identity
`email-worker` **Version `52ca86c6-c449-4bc0-b3b1-2dee769bba80`** (account `f02bde…`, via owner `wrangler login`). `keep_vars` preserved existing secrets. `WOO_LOOKUP_SECRET` set (encrypted; generated, 52 chars; **not printed** — handed to the owner via `~/Desktop/WOO_LOOKUP_SECRET.txt`, mode 0600, to paste into WP then delete). `/health` 200.

## 11. Woo plugin deployment identity
Built: **2.5.3**, `ipear-woo-loyalty-2.5.3.zip` on the owner Desktop. **Not yet installed** on production WordPress (owner action — no authorized WP access from this session).

## 12. Live passive verification
Worker `/health` 200 · `/woo/v2/get-user`: correct secret → 404 on unknown email (auth OK, route live) + `Cache-Control: no-store` · no-auth/wrong-secret → 401 · GET → 405 · legacy `/woo-get-user` → 401 (unchanged) · scoped isolation confirmed (lookup secret → 401 on credit-order). Admin browser unaffected (3B deploy `519fbd7c` unchanged). Stage-2 rules/functions untouched. **No paid orders created for testing.** Financial mutations remain **VERIFIED IN TEST HARNESS — NOT REPEATED AS PRODUCTION MUTATIONS.**

## 12.1 Live PRODUCTION WordPress traffic capture (definitive)
`wrangler tail --format=json` on `email-worker` (version `e8557bc0…`), 2026-10-07. Observed, real end-user My-Account page-load:
- **`POST https://email-worker.ipear2026.workers.dev/woo/v2/get-user`** → **HTTP 200**
- Origin: **`user-agent: WordPress/7.1.2; https://ipear.gr`**, **ASN 47583 Hostinger**, colo CDG, HTTP/1.1 server-to-server (not a browser) — i.e. the production WP host's `wp_remote_post`.
- **`Authorization` header present** (tail redacts the value). A 200 (not 401/503) proves the presented secret matched `WOO_LOOKUP_SECRET` and the route is authoritative.
- **Negative control:** across the full capture window the ONLY other events were browser `/health` GETs (from `loyalty.ipear.gr`) and the `*/30` `health-deep` cron. **Zero `/woo-get-user` and zero other ADMIN_SECRET-gated calls from WordPress.**
→ Items (2)(3)(4)(5) of the final verification confirmed from live traffic, not just source inspection.

## 13. WordPress ADMIN_SECRET active consumer count
- **In the 2.5.3 build: 0 active** (My-Account lookup moved to `WOO_LOOKUP_SECRET`; `ipear_admin_secret` is read by no active flow — only the rollback-only settings-field display + preserve-on-empty sanitizer reference it).
- **On production right now: 0 — CONFIRMED LIVE.** The owner installed 2.5.3; captured production traffic shows WordPress calling `/woo/v2/get-user` (`WOO_LOOKUP_SECRET`) and **no** ADMIN_SECRET-gated call (§12.1).

## 14. Global ADMIN_SECRET remaining-consumer inventory
- Admin browser = **0** (Stage 3B).
- WordPress = **0 — confirmed live** (2.5.3 installed; §12.1 traffic capture).
- Legacy Worker routes (`/`, `/sms`, `/bulk-sms`, `/admin/*`, `/woo-get-user`, `/woo-add-points`, `/woo-refund-points`, export-download HMAC, health-deep) = still accept ADMIN_SECRET (**rollback**).
- create-admin = still legacy ADMIN_SECRET (Stage 3D).
- **Global count ≠ 0** — do not rotate (3F) until 3D–3E.

## 15. Stage 3D retirement plan (next)
Retire the legacy ADMIN_SECRET surface once consumers are proven zero: trip `LOYALTY_LEGACY_MUTATION_DISABLED` (woo-add/refund-points → 410); retire/owner-gate `/admin/create-admin-user`; fold `/admin/delete-auth-user` fully into the CF; migrate export-download HMAC to a dedicated `BACKUP_SIGNING_KEY`; then delete the legacy `/woo-get-user` and the v1 `/admin/*` handlers. Prove consumer count = 0 (3E) before rotating ADMIN_SECRET (3F).

## 16. Rollback
- **Worker:** redeploy the prior version (Cloudflare retains versions) or remove the `/woo/v2/get-user` block; `WOO_LOOKUP_SECRET` is additive/harmless. Legacy `/woo-get-user` (ADMIN_SECRET) still works.
- **WordPress:** re-install the 2.5.2 ZIP (`319033ee…`) — the My-Account lookup reverts to ADMIN_SECRET. `ipear_admin_secret` is preserved in WP for exactly this.
- ADMIN_SECRET never rotated → legacy auth works throughout. No rules/functions change to undo.

---

## OWNER ACTIONS — COMPLETED
**A.** ~~Open `~/Desktop/WOO_LOOKUP_SECRET.txt`~~ — done.
**B.** ~~Install 2.5.3 + paste the WooCommerce Lookup Secret~~ — **done (confirmed live, §12.1).**
**C.** **Delete `~/Desktop/WOO_LOOKUP_SECRET.txt`** — still pending; please delete it now (the value is live in Cloudflare + WP; the plaintext copy is no longer needed).
**D.** ~~Confirm live~~ — done: real My-Account lookup → `/woo/v2/get-user` → 200.

---

## HARD STOP — STAGE 3C (COMPLETE)
No ADMIN_SECRET rotation, no legacy route disabled, no create-admin change, no Cloudflare Access/MFA, no Stage-2 rules/functions touched. All constraints held.

### FINAL VERDICT: READY FOR STAGE 3D — WORDPRESS NO LONGER ACTIVELY USES ADMIN_SECRET
*(Server side deployed + verified; owner installed 2.5.3; confirmed by live production traffic capture, §12.1.)*
