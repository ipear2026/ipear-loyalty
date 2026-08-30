# Source-of-truth deployment record

## Cloudflare Worker `email-worker` — Production

| Field | Value |
|---|---|
| Version number | **122** |
| Active Version ID | `7d013b88-405b-4855-b31d-5a3b231ca35b` |
| Rollback Version ID | `75247dea-065d-4f45-82e6-f2db09bf504f` (v121) |
| Rollback command | `wrangler rollback 75247dea-065d-4f45-82e6-f2db09bf504f --name email-worker` |
| Deploy date | 2026-08-29T16:47:24.448Z (version created) · 16:47:26.696Z (routed) |
| Deploy method | `wrangler deploy --secrets-file <tmp>` (atomic, secrets provisioned in same call) |
| Health URL | `https://email-worker.ipear2026.workers.dev` |
| Cron trigger | `*/30 * * * *` |
| Bundle size | 165.93 KiB uncompressed · 33.51 KiB gzip |
| Compatibility date | `2025-11-01` |
| Handlers | `scheduled, fetch` |

## Deployed runtime SHAs (as of 2026-08-29 v122)

| File | SHA-256 |
|---|---|
| `email-worker.js` | `13562d10ac4dbed7b035e9d0bf22c18958a08dd6110f1a0e6bccc144fe1eab1e` |
| `src/worker/lib/woo-integrity.js` | `a3ced46a15cd0611db6cb61d591e49b947b0eb8259ab502bd87b039513899586` |
| `src/worker/lib/ip.js` | `f78cd0ebd9f4a93e8660015fcc0e227dc2464e81a5d619bdff27b7a7e6609220` |
| `src/worker/lib/sms.js` | `836da8d1147e2cc6137fd61fcd52126c5ed8ba802bd910d2a11d76063a549d0a` |
| `src/worker/lib/redeem-keys.js` | `aca59522f14d0be994c800b5002f61dd529c8cb8d5acc7f75009ba712c1d5934` |

## Cloudflare secrets present in v122

`ADMIN_SECRET`, `BREVO_API_KEY`, `BREVO_SMS_SENDER`, `ERP_SECRET`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`, `FIREBASE_API_KEY`, `WOO_LOYALTY_SECRET` (new L1), `WOO_SITE_URL` (new L1).

Vars from wrangler.toml (unchanged): `FCM_PROJECT_ID=loyalty-ipear`, `SENDER_EMAIL=info@ipear.gr`, `SENDER_NAME=iPear Loyalty`, `ALLOWED_ORIGINS=https://loyalty.ipear.gr,https://ipear-loyalty.pages.dev`. KV binding: `RATE_LIMIT_KV=9b7bfd14b586445db94e932a75635f85`.

`LOYALTY_LEGACY_MUTATION_DISABLED`: NOT SET (kill-switch off — Phase D not entered).

## WordPress plugin `ipear-woo-loyalty` — Production

| Field | Value |
|---|---|
| Version | 2.4.2 |
| SHA-256 | `f4c299b6e6ea85039d106f78f4e9edb89033ed128b3929fadfcdea04faef7abe` |
| Byte-identity verified | ✅ (operator confirmed via cPanel/SFTP download 2026-08-29) |
| Phase B plugin ZIP ready | `~/Desktop/ipear-woo-loyalty-phaseB-2026-08-29.zip` · SHA `2ff4870a14ab3a562aeb0c5b7bf17555070f7f1835432c908427d490a4101ed2` |
| Phase B uploaded to WordPress | NO (awaiting new approval) |

## Canonical repo status (post-L2.1 sync)

Repo: `~/Desktop/ipear-loyalty-vite` · Branch: `refactor/p1-services-split` · HEAD at start of L2.1: `9ac096c`.

L1 code reconciled into working tree and committed locally on 2026-08-30 (not yet pushed):
- `email-worker.js` → SHA `13562d10…` (synced from buildL1)
- `src/worker/lib/woo-integrity.js` → SHA `a3ced46a…` (new file)
- `tests/woo-integrity.test.js`, `tests/legacy-cutover.test.js`, `tests/sw-precache.test.js` (new files)
- `firestore.rules` → appended `ipear_woo_events/{eventId}` deny-all block (not yet deployed to Firebase)
- `public/sw-customer.js` → SHELL filenames corrected, CACHE_VER bumped to v72

Pre-existing dirty preserved: `src/main.js` SHA `672ed4d7…` unchanged.
