# iPear Loyalty — ADMIN FORTRESS · STAGE 3 AUDIT / DESIGN

**Date:** 2026-10-06 · **Role:** Security Architect · **Mode:** AUDIT / DESIGN ONLY — nothing implemented, deployed, rotated, or removed. No secret values printed (all redacted at source). Builds on Stage-2 commit `5dcbe37df2b93801f9b5d8638cdbd4305067c498`.

> **OBJECTIVE:** remove the architectural dependence on the reusable master `ADMIN_SECRET` from the admin browser and from WordPress, so that **compromising WordPress alone, or stealing browser storage alone, cannot grant full loyalty admin authority.** Replace it with strong server-verifiable Firebase identity (admin claim + OWNER_UID + App Check) for the browser, and a narrowly-scoped Woo credential for WordPress.

> **⚠️ SOURCE-OF-TRUTH DISCREPANCY (must reconcile before S3.8/rotation).** The brief states the deployed Woo plugin is **2.5.2** with financial mutations already on a scoped `WOO_LOYALTY_SECRET` (`/woo-credit-order`, `/woo-refund-order`). The **authoritative repo source** (`ipear-woo-loyalty.php`, both committed and working in the main checkout) is **2.4.2**, which still sends `Bearer ADMIN_SECRET` to the **legacy** `/woo-add-points` (mutation) and `/woo-get-user`. It contains **no** `WOO_LOYALTY_SECRET` / `/woo-credit-order` code. I cannot read the live WordPress install, so I cannot confirm 2.5.2 is deployed. **Finding WOO-DISCREPANCY (High)** — the plugin running on WordPress must be captured and diffed against the repo before any rotation; this audit documents BOTH the repo-authoritative 2.4.2 behaviour and the brief's claimed-2.5.2 behaviour where they differ.

---

## A. ADMIN_SECRET consumer inventory

`ADMIN_SECRET` is the Worker's single master bearer. In the browser it is stored under the key **`ipear_worker_secret`** and sent as `Authorization: Bearer <ADMIN_SECRET>`.

### A.1 Browser (PWA admin) consumers — all send `Bearer ipear_worker_secret`
| # | File | Fn / action | Worker endpoint | R/W | Still active? | Replacement |
|---|---|---|---|---|---|---|
| B1 | [src/admin/worker-secret.js](src/admin/worker-secret.js) | storage (`get/set/clearWorkerSecret`) | — | — | **ACTIVE** (localStorage `ipear_worker_secret`) | remove entirely — no reusable secret in browser |
| B2 | [src/admin/customers-crud.js:482](src/admin/customers-crud.js) | delete customer → Auth-user delete | `/admin/delete-auth-user` | W | **ACTIVE** (called inside `adminDeleteCustomer`? no — still the browser path for Auth delete) | fold Auth-delete into the `adminDeleteCustomer` Cloud Function (Admin SDK), OR Firebase-ID-token Worker auth |
| B3 | [src/admin/email-worker.js:323](src/admin/email-worker.js) | bulk email send | `POST /` (handleEmail) | W | **ACTIVE** | Firebase ID token + admin claim + OWNER_UID (+ App Check) |
| B4 | [src/admin/bulk-messaging-send.js:151](src/admin/bulk-messaging-send.js) | bulk SMS/email | `POST /` / `/bulk-sms` | W | **ACTIVE** | same as B3 |
| B5 | [src/admin/messaging.js:138,194](src/admin/messaging.js) | single messaging / push | `POST /` / `/sms` | W | **ACTIVE** | same as B3 |
| B6 | [src/admin-main.js:328,346](src/admin-main.js) | hook wiring (`getWorkerSecret`) | — | — | ACTIVE (DI) | delete hook once B1 removed |

> **Note on B2:** Stage-2's `adminDeleteCustomer` Cloud Function deletes the Firebase Auth user via the Admin SDK (`getAuth().deleteUser`). The **browser `deleteCust()` legacy branch** (flag-OFF) calls `/admin/delete-auth-user` with the master secret, but under flag-ON it returns before reaching it (Stage-2 verified). So B2 is **reachable only in the rollback/flag-OFF path today**; the server function already provides the replacement. Confirm no other caller remains.

### A.2 WordPress / Woo consumer
| # | File | Endpoint called | R/W | Secret | Replacement |
|---|---|---|---|---|---|
| W1 | `ipear-woo-loyalty.php:141-147` (2.4.2) | `/woo-add-points` | W (mutation) | `Bearer ADMIN_SECRET` | **retire** (Stage-2 is financial authority) OR migrate to `/woo-credit-order` + `WOO_LOYALTY_SECRET` (the 2.5.2 claim) |
| W2 | `ipear-woo-loyalty.php:484-488` (2.4.2) | `/woo-get-user` | R (customer+points lookup) | `Bearer ADMIN_SECRET` | **scoped read credential** (see §I) |

### A.3 Built-artifact / config
- Admin bundle (`dist/assets/admin-*.js`) references the **key name** `ipear_worker_secret` and constructs `Authorization: Bearer …`, but **no `ADMIN_SECRET` value is baked** (runtime-entered). → Category **B/C** (references/names only), not **A** (no actual secret exposure).
- Worker/CF `OWNER_UIDS` and `ADMIN_SECRET` live as Cloudflare/GCF env (server-side), not in the bundle. Confirmed absent from the live build.

---

## B. Worker privileged endpoint matrix (deployed `email-worker.js`)

Gate order (router): **public** → **ERP secret** → **Woo scoped secret** → **legacy kill-switch** → **`ADMIN_SECRET` gate (line 386)** → admin handlers.

| Endpoint | Method | Auth today | Capability / data | Mutations | Rate-limit | Logs secret? | Prod caller | Retire? | Replacement |
|---|---|---|---|---|---|---|---|---|---|
| `/admin/create-admin-user` | POST | **ADMIN_SECRET** | create Firebase Auth user **+ write `ipear_admins/{uid}`** → syncAdminClaim grants `admin:true` | **admin minting** | none seen | no | unclear (single-owner) | **evaluate full retirement (§F/E)** | one-time owner bootstrap / owner-only CF |
| `/admin/delete-auth-user` | POST | **ADMIN_SECRET** | delete **any** Firebase user by uid/email (incl. owner) | user delete | none seen | no | browser B2 (flag-OFF) | fold into `adminDeleteCustomer` CF | Firebase ID token + OWNER_UID, or CF-only |
| `/admin/export-backup` | POST | **ADMIN_SECRET** | full customer PII/points snapshot → R2 | read-all | none seen | no | admin (System tab) | keep, re-auth | ID token + OWNER_UID (+ App Check) |
| `/admin/export-download` | GET | **HMAC(ADMIN_SECRET)** signed URL | stream R2 backup | read | signed+TTL | no | paired w/ export-backup | keep | HMAC key → dedicated backup key |
| `/admin/redeem-attempt` | POST | **ADMIN_SECRET** | brute-force guard counter | KV write | self | no | admin/tablet approval | keep | ID token (admin/tablet) |
| `POST /` (email) | POST | **ADMIN_SECRET** | bulk email (Brevo) | send | partial | no | browser B3/B4/B5 | keep | ID token + OWNER_UID (+ App Check) |
| `/sms`, `/bulk-sms` | POST | **ADMIN_SECRET** | arbitrary SMS (Brevo) | send | partial | no | browser B4/B5 | keep | ID token + OWNER_UID (+ App Check) |
| `/woo-create-coupon` | POST | **ADMIN_SECRET + idToken** | create Woo coupon | Woo write | — | no | admin/customer offer flow | keep | already idToken-gated → drop ADMIN_SECRET, add admin/owner claim check |
| `/health-deep` | GET | **ADMIN_SECRET** | health (Brevo+Firestore) | read | — | no | cron/manual | keep | dedicated health token or ID token |
| `/woo-get-user` | POST | **ADMIN_SECRET** | customer name/points/card by email | read | none seen | no | WordPress W2 | **migrate** | scoped `WOO_LOOKUP` credential (§I) |
| `/woo-add-points` | POST | **ADMIN_SECRET** (killable) | legacy point mutation | **financial W** | — | no | WordPress W1 (2.4.2) / none (2.5.2) | **RETIRE** (§F) | `/woo-credit-order` + `WOO_LOYALTY_SECRET` |
| `/woo-refund-points` | POST | **ADMIN_SECRET** (killable) | legacy refund | **financial W** | — | no | none (replaced) | **RETIRE** | `/woo-refund-order` + `WOO_LOYALTY_SECRET` |

**Non-ADMIN_SECRET (already-migrated) endpoints for reference:** `/woo-credit-order`, `/woo-refund-order` (`WOO_LOYALTY_SECRET`, timing-safe, `src/worker/lib/woo-integrity.js`); `/erp/*` (`ERP_SECRET`); `/send-welcome`, `/process-referral`, `/woo-sync-tier`, `/check-*`, `/send-sms-otp`, `/verify-sms-otp`, `/reset-password`, `/resend-verification` (public + **Firebase idToken verified in-handler** via Google `identitytoolkit accounts:lookup`).

**Blast radius if `ADMIN_SECRET` is compromised (today):** create admins · delete any Firebase user (incl. owner) · export all customer PII · send arbitrary SMS/email at cost · create Woo coupons · read any customer's points. It can **NOT** directly mutate Firestore financial state (Stage-2 §6b lock + server-only writers) — that is the Stage-2 win preserved. **Finding ADMIN-SECRET-BLAST (Critical).**

---

## C. Browser storage / auth flow (S3.3)

```
admin login (Firebase email+password)  ──►  Firebase SDK holds ID token (managed, auto-refresh)
          │
          └─► admin opens "Notifications" settings, pastes Worker Secret ONCE
                    │  setWorkerSecret(sec)
                    ▼
        localStorage['ipear_worker_secret']  (PERSISTENT, plaintext, same-origin readable)
                    │  getWorkerSecret() (mem-cached)
                    ▼
        fetch(worker, { headers:{ Authorization:'Bearer '+sec } })   ← B2–B5
                    │
         logout ──► admin-auth.js → clearWorkerSecret() → localStorage.removeItem
```

- **Storage tier:** `localStorage` (persists across tabs/reloads/restarts). v3 chosen over sessionStorage/in-memory for UX. `sessionStorage` copy actively purged on init.
- **Other stores:** not used for this secret (no IndexedDB/cookie/CacheStorage/global/URL param). Confirmed by grep — only `localStorage['ipear_worker_secret']`.
- **Exfiltration reachability:** any same-origin script, malicious browser extension, or **DOM XSS on the admin surface** can read `localStorage['ipear_worker_secret']` and obtain a **reusable, long-lived master backend credential** — the exact anti-pattern Stage 3 removes. The source file's own comment acknowledges this and its "can't touch Firestore" rationale is now **outdated** (the secret still mints admins / deletes users / exports PII).
- **Target:** admin browser holds **no reusable master backend secret** — only the Firebase SDK-managed ID token (short-lived, refresh-managed, revocable).

---

## D. WordPress / Woo trust map (S3.5)

| Aspect | Repo-authoritative (2.4.2) | Brief-claimed deployed (2.5.2) |
|---|---|---|
| Secret stored in WP | **`ADMIN_SECRET`** (WP option, admin settings "Admin Secret") | scoped `WOO_LOYALTY_SECRET` for mutations |
| Order credit | `/woo-add-points` + `Bearer ADMIN_SECRET` | `/woo-credit-order` + `WOO_LOYALTY_SECRET` |
| Refund | (via add-points path) | `/woo-refund-order` + `WOO_LOYALTY_SECRET` |
| Customer lookup | `/woo-get-user` + `Bearer ADMIN_SECRET` | **still `ADMIN_SECRET`** (residual) |

**Invariant target:** WordPress must **not** possess `ADMIN_SECRET`. Its credential must be limited to exactly the Woo operations it needs (credit/refund order + customer lookup). A compromised WordPress must **not** be able to: create admins, delete Firebase users, export all customers, send arbitrary SMS/email, change claims, or hit unrelated admin APIs. Today (2.4.2) WP holding `ADMIN_SECRET` means a WP compromise = full master-secret compromise = **Critical**. Even under the claimed 2.5.2, `/woo-get-user` keeps `ADMIN_SECRET` in WP → still Critical until §I lands.

---

## E. Admin-creation / custom-claim escalation map (S3.6)

```
Path 1 (client):  ipear_admins client write = FALSE (firestore.rules:537-539)   ✅ blocked
Path 2 (server):  /admin/create-admin-user  ──(ADMIN_SECRET)──►  Admin SDK:
                     create Auth user  +  WRITE ipear_admins/{uid}
                            │
                            ▼
                  syncAdminClaim (onDocumentWritten ipear_admins)  ──►  setCustomUserClaims(admin:true)
```

- **Client write of `ipear_admins` = denied** (rules) ✅ — so XSS/stolen customer token cannot directly mint an admin via Firestore.
- **But `/admin/create-admin-user` (ADMIN_SECRET) bypasses rules** (Admin SDK) and writes `ipear_admins`, which `syncAdminClaim` turns into a real `admin:true` claim. ⇒ **possession of `ADMIN_SECRET` (incl. via WP compromise or admin-browser XSS) = ability to mint a new admin identity.** **Finding CREATE-ADMIN (Critical).**
- **Recommendation:** this is single-owner. Evaluate **retiring `/admin/create-admin-user` entirely** (owner already exists); if a bootstrap path must remain, gate it owner-only via Firebase ID token + OWNER_UID + App Check, never a reusable secret, and consider making it a Cloud Function (not a Worker endpoint) so it shares the Stage-2 owner gate.

---

## F. Legacy endpoint retirement candidates (S3.7) — design only, do NOT remove yet

| Endpoint | Status | Caller | Kill-switch | Retire plan |
|---|---|---|---|---|
| `/woo-add-points` | deployed, ADMIN_SECRET | WP 2.4.2 (repo) / none (2.5.2) | `LOYALTY_LEGACY_MUTATION_DISABLED=true` → 410 | after WP confirmed on credit-order path, trip flag, then delete handler |
| `/woo-refund-points` | deployed, ADMIN_SECRET | none (replaced) | same flag | same |
| `/admin/create-admin-user` | deployed, ADMIN_SECRET | unclear | none | retire or owner-only CF (§E) |
| `/admin/delete-auth-user` | deployed, ADMIN_SECRET | browser flag-OFF only | none | fold into `adminDeleteCustomer` CF, then delete |

Prove-zero-callers before removing any (see §J/§K). The legacy-mutation kill-switch already exists and is checked **before** the ADMIN_SECRET gate — good design; once WP is confirmed migrated, tripping it removes ADMIN_SECRET as a loyalty-mutation vector with a single env change (fully rollbackable).

---

## G. Replacement auth design per endpoint (S3.4)

**Browser → Worker (B3/B4/B5, delete, export, health, coupon):** replace `Bearer ADMIN_SECRET` with:
```
Authorization: Bearer <Firebase ID token>        (SDK-managed, short-lived)
X-Firebase-AppCheck: <App Check token>           (where enforced)
```
Worker verifies (see §H): signature/issuer/audience/expiry → `admin:true` claim → `uid ∈ OWNER_UIDS` for owner-only ops. **No reusable secret in the browser.** Explicitly rejected: cookie/sessionStorage/obfuscated/client-encrypted `ADMIN_SECRET` (all still reusable master secrets).

| Endpoint | New auth |
|---|---|
| `POST /` email, `/sms`, `/bulk-sms` | ID token + `admin:true` + OWNER_UID + App Check |
| `/admin/export-backup`, `/admin/export-download` | ID token + OWNER_UID + App Check; HMAC key → dedicated `BACKUP_SIGNING_KEY` (decouple from ADMIN_SECRET) |
| `/admin/delete-auth-user` | prefer **CF `adminDeleteCustomer`** (already owner-gated+App Check); if kept on Worker, ID token + OWNER_UID |
| `/admin/create-admin-user` | retire, or owner-only CF + App Check (§E) |
| `/admin/redeem-attempt` | ID token with `admin:true` or `role:tablet` |
| `/woo-create-coupon` | already idToken-gated → drop ADMIN_SECRET, add `admin:true`/owner check |
| `/health-deep` | dedicated health token (cron) or ID token |
| `/woo-get-user` | **not browser** — scoped Woo credential (§I) |

---

## H. Worker Firebase-ID-token verification design (S3.13)

The Worker **already** validates Firebase ID tokens on public endpoints by POSTing to Google `identitytoolkit accounts:lookup` (e.g. `send-welcome`, `process-referral`, `woo-sync-tier`, `woo-create-coupon`). Two viable models:

- **Model 1 (reuse, simplest):** `accounts:lookup` with the idToken → Google returns the user record incl. `customAttributes` (custom claims). Verify: request succeeded (token valid for this project) → parse `customAttributes.admin === true` → `localId ∈ OWNER_UIDS`. One Google round-trip/request (acceptable for low-rate admin ops). **Never trust the decoded JWT payload without this verification.**
- **Model 2 (local JWKS, lower latency):** fetch Google `securetoken@system.gserviceaccount.com` public keys (cache per `Cache-Control: max-age`), verify RS256 signature + `iss=https://securetoken.google.com/<projectId>` + `aud=<projectId>` + `exp` + `sub`, then read `admin`/claims from the verified payload, check OWNER_UID.

Either must: validate **signature, issuer, audience/project, expiration, subject UID, admin claim, OWNER_UID where required**, and **fail closed** on any backend error. Recommend **Model 1** first (reuses proven code; no new crypto), optionally move to Model 2 if latency matters. Server-side OWNER_UID allowlist stays in Worker env (mirrors GCF `OWNER_UIDS`), never client-side.

---

## I. Scoped Woo credential design (S3.5) — for `/woo-get-user`

Choose least-privilege + operational simplicity:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| A. extend `WOO_LOYALTY_SECRET` to also authorize read-only `/woo-get-user` | one WP secret; reuses existing timing-safe verify | widens that secret's scope to reads | acceptable |
| **B. separate `WOO_LOOKUP_SECRET`** (read-only) | **true least privilege**; independently rotatable; lookup compromise ≠ mutation ability | one more secret to manage | **RECOMMENDED** |
| C. signed service-to-service (HMAC + timestamp) | replay-resistant | more WP+Worker code; marginal gain over B over TLS | defer unless threat justifies |

**Recommendation: Option B** — add `WOO_LOOKUP_SECRET`; route `/woo-get-user` **before** the ADMIN_SECRET gate, verified by `verifyWooSecret(env.WOO_LOOKUP_SECRET)` (timing-safe, same pattern as `woo-integrity.js`). WP then stores only `WOO_LOYALTY_SECRET` (credit/refund) + `WOO_LOOKUP_SECRET` (read) — **no `ADMIN_SECRET`**. A WP compromise yields only: credit/refund orders (idempotent, ledger-audited) + read a customer's points by email. It cannot create admins, delete users, export all PII, or send SMS/email.

---

## J. Migration dependency graph (S3.8)

```
ADMIN_SECRET
 ├─ PRODUCERS:    Cloudflare Worker secret (wrangler) ; WP option (2.4.2) ; HMAC key for export-download
 ├─ STORAGE:      CF env (server) ; WP options table ; admin browser localStorage[ipear_worker_secret]
 ├─ CONSUMERS (browser):  email / sms / bulk-sms / delete-auth-user / export-backup   (B2–B5)
 ├─ CONSUMERS (WP):       /woo-add-points (2.4.2) ; /woo-get-user                       (W1,W2)
 ├─ CONSUMERS (Worker self): HMAC sign/verify for export-download ; health-deep
 └─ FALLBACKS/LEGACY:     /woo-add-points /woo-refund-points (kill-switch) ; flag-OFF browser delete path
```
**Rotation may only occur when every box above reads zero live consumers.** The `export-download` HMAC key dependency means naive rotation would break signed-URL verification → migrate that to a dedicated `BACKUP_SIGNING_KEY` first.

---

## K. Safe secret-rotation sequence (S3.8 / S3.9) — design, do NOT execute

1. **3A** introduce replacements in parallel (Worker verifies Firebase ID tokens for admin ops; add `WOO_LOOKUP_SECRET`; add `BACKUP_SIGNING_KEY`) — all **additive**, ADMIN_SECRET still accepted. No outage.
2. **3B** migrate browser consumers (B2–B5) to ID-token auth; remove `worker-secret.js` + the Notifications "Worker Secret" field; browser no longer stores/sends the master secret.
3. **3C** migrate WP `/woo-get-user` → `WOO_LOOKUP_SECRET`; confirm WP on credit/refund-order (reconcile 2.4.2↔2.5.2 first).
4. **3D** disable legacy consumers: trip `LOYALTY_LEGACY_MUTATION_DISABLED=true`; migrate `/admin/delete-auth-user` into the CF; retire/owner-gate `/admin/create-admin-user`; move `export-download` HMAC to `BACKUP_SIGNING_KEY`.
5. **3E** prove `ADMIN_SECRET` consumer count = **0** (two independent scans: static grep across PWA/Worker/WP + runtime 401/empty-caller logs over an observation window).
6. **3F** rotate/revoke `ADMIN_SECRET` (wrangler secret) **only after 3E = 0**.
7. **3G** post-rotation adversarial verification (old secret → DENY everywhere; replacements → correct).

Each stage independently rollbackable (ADMIN_SECRET remains valid until 3F).

---

## L. Rollback plan

| Stage | Rollback |
|---|---|
| 3A | remove new verify paths / scoped secrets — ADMIN_SECRET unaffected |
| 3B | re-enable `worker-secret.js` + redeploy prior admin bundle; ADMIN_SECRET still accepted |
| 3C | revert WP plugin to prior secret config; Worker still accepts ADMIN_SECRET on `/woo-get-user` |
| 3D | set `LOYALTY_LEGACY_MUTATION_DISABLED=false`; restore Worker handlers; revert HMAC key |
| 3F | **hardest** — re-add the old secret value to CF env + WP + any consumer **before** flipping back; do NOT rotate until 3E proven, precisely to keep this reversible |

**Invariant:** never run a flag-OFF/legacy frontend expecting ADMIN_SECRET against a Worker where it has been revoked. Keep ADMIN_SECRET valid through 3A–3E.

---

## M. Adversarial test plan (implementation phase)

Pre-cutover: old ADMIN_SECRET still accepted (no premature break). Replacement correctness: valid admin+OWNER+AppCheck → ALLOWED. Denials (**fail-closed**, S3.10): missing/invalid/expired/forged/modified JWT → DENY; wrong-Firebase-project token → DENY; valid **customer** token on admin endpoint → DENY; **tablet** on owner-only → DENY; admin claim + **wrong OWNER_UID** → DENY; missing App Check where enforced → DENY; missing/wrong scoped Woo secret → DENY; **Woo secret cannot call admin endpoints**; **admin identity cannot call Woo-only endpoints** unless intended; **old ADMIN_SECRET after 3F → DENY everywhere**; backend/verify error → DENY. WP-compromise simulation: cannot create admin, cannot export bulk customers, cannot delete Firebase users, cannot send arbitrary SMS. Browser: after 3B, `localStorage`/`sessionStorage`/IndexedDB/cookies contain **no** `ipear_worker_secret`; logout clears app state; **bundle contains no master secret**.

---

## N. Threat model — before → after (S3.18 / S3.11)

| # | Attacker gains | CURRENT capability | TARGET (Stage-3) capability | Residual |
|---|---|---|---|---|
| 1 | customer account | own data only; no financial write (lock) | unchanged | low |
| 2 | tablet account | tablet scan flows; no direct writes | unchanged | low |
| 3 | admin URL | login wall | unchanged | low |
| 4 | admin browser **localStorage** | **reusable ADMIN_SECRET → full master compromise** | **no reusable master secret**; at most SDK session token (short-lived, revocable) | **major reduction** |
| 5 | admin-page **XSS** | steal ADMIN_SECRET → long-term remote backend admin | can act **within current session** (ID token) but **no reusable master credential**; revoke session/disable user to cut off | reduced — **XSS not harmless**; session-scoped abuse until revoke/expiry |
| 6 | **WordPress compromise** | holds ADMIN_SECRET → create admins, delete users, export PII, SMS | only scoped Woo credit/refund + read lookup | **major reduction** |
| 7 | steal WOO scoped secret | (today = ADMIN_SECRET, full) | credit/refund (idempotent, audited) + read lookup only | reduced |
| 8 | old ADMIN_SECRET (post-3F) | n/a | **DENY everywhere** | eliminated |
| 9 | replay captured request | ID-token expiry + (optional) signing limits window | same + App Check | low |
| 10 | valid Firebase **customer** token | denied on admin (claim/OWNER gate) | unchanged | low |
| 11 | modifies frontend JS locally | cannot forge server identity; rules+claims server-side | unchanged | low |

---

## O. Prioritized findings

| ID | Sev | Component | Current behaviour | Attack path | Impact | Target remediation | Migration risk |
|---|---|---|---|---|---|---|---|
| S3-F1 CREATE-ADMIN | **Critical** | Worker `/admin/create-admin-user` | ADMIN_SECRET mints Auth user + `ipear_admins` → `admin:true` | WP compromise or admin XSS → steal/hold ADMIN_SECRET → create admin | full persistent admin takeover | retire or owner-only CF (ID token+OWNER+AppCheck) | Low (likely no prod caller) |
| S3-F2 WP-HOLDS-MASTER | **Critical** | WP plugin 2.4.2 | WP stores ADMIN_SECRET; uses it for add-points + get-user | WP/WordPress compromise | full master-secret compromise | scoped `WOO_LOYALTY_SECRET`+`WOO_LOOKUP_SECRET`; remove ADMIN_SECRET from WP | Med (reconcile 2.4.2↔2.5.2) |
| S3-F3 BROWSER-MASTER | **Critical** | `worker-secret.js` localStorage | reusable ADMIN_SECRET in localStorage | admin XSS / malicious extension / shared device | reusable backend master credential | ID-token auth; delete worker-secret storage | Med (migrate B2–B5) |
| S3-F4 DELETE-ANY-USER | **High** | `/admin/delete-auth-user` | ADMIN_SECRET deletes any Firebase user incl. owner | stolen ADMIN_SECRET | account/owner destruction | fold into CF `adminDeleteCustomer`; ID token+OWNER | Low |
| S3-F5 BULK-PII-EXPORT | **High** | `/admin/export-backup`(+download) | ADMIN_SECRET → all customer PII; HMAC key = ADMIN_SECRET | stolen ADMIN_SECRET | mass PII exfiltration | ID token+OWNER+AppCheck; dedicated `BACKUP_SIGNING_KEY` | Low |
| S3-F6 WOO-DISCREPANCY | **High** | repo vs deployed plugin | repo=2.4.2 (ADMIN_SECRET); brief=2.5.2 | — (process risk) | rotation could break live WP or leave ADMIN_SECRET in WP | capture live plugin, diff, reconcile before 3C/3F | — |
| S3-F7 WOO-GET-USER | **High** | `/woo-get-user` | ADMIN_SECRET read lookup | WP compromise | customer points/PII read; keeps ADMIN_SECRET in WP | `WOO_LOOKUP_SECRET` (§I) | Low |
| S3-F8 ARB-MESSAGING | **Medium** | `POST /`,`/sms`,`/bulk-sms` | ADMIN_SECRET → arbitrary email/SMS | stolen ADMIN_SECRET | cost/abuse/phishing from brand | ID token+OWNER+AppCheck | Low |
| S3-F9 LEGACY-MUTATION | **Medium** | `/woo-add-points`,`/woo-refund-points` | ADMIN_SECRET financial mutation still reachable (flag not tripped) | stolen ADMIN_SECRET | out-of-band point mutation (bypasses Stage-2 intent) | trip kill-switch after WP migrated; delete handlers | Low |
| S3-F10 NO-WORKER-APPCHECK | **Low/Med** | Worker admin endpoints | no App Check on browser→Worker | — | weaker bot/defense-in-depth vs CF | add App Check to browser-originated privileged Worker calls | Low |

---

## P. Recommended implementation stages

- **3A — parallel replacements (additive, no cutover):** Worker-side Firebase ID-token verification helper (§H Model 1) + OWNER_UID check; add `WOO_LOOKUP_SECRET` and `BACKUP_SIGNING_KEY`; keep ADMIN_SECRET accepted. Tests + dormant.
- **3B — migrate admin browser:** B2–B5 → ID-token auth; remove `worker-secret.js` + Notifications secret field; verify bundle/localStorage carry no master secret.
- **3C — migrate WP `/woo-get-user`** → `WOO_LOOKUP_SECRET`; reconcile plugin version; confirm credit/refund on scoped secret.
- **3D — disable legacy:** trip `LOYALTY_LEGACY_MUTATION_DISABLED`; fold `/admin/delete-auth-user` into CF; retire/owner-gate `/admin/create-admin-user`; move export HMAC to `BACKUP_SIGNING_KEY`.
- **3E — prove consumer count = 0** (two independent scans + runtime observation).
- **3F — rotate/revoke ADMIN_SECRET** (only after 3E = 0).
- **3G — post-rotation adversarial verification** (old secret denied everywhere; replacements correct).

> **Cloudflare Access / passkey / MFA (S3.20):** out of scope for Stage 3; handle the perimeter AFTER master-secret elimination. Integration note only: once browser uses Firebase ID tokens, Access can wrap the admin origin without interfering with app-level auth.

---

## HARD STOP — AUDIT / DESIGN ONLY
Nothing implemented, deployed, rotated, or removed. No WordPress, Worker secrets, Cloudflare Access, MFA/passkey touched. No secret values printed. Awaiting approval to begin **Stage 3A**.
