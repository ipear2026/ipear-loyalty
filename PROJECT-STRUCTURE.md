# iPear Loyalty — Project Structure & Runbook

_Last updated: 2026-10-08. No secret values appear in this file._

## Canonical source (leave in place — linked Git worktrees)
- **Main repo:** `~/Desktop/ipear-loyalty-vite` — remote `github.com/ipear2026/ipear-loyalty.git`.
- **Authoritative Admin Fortress worktree:** `~/Desktop/ipear-loyalty-prod-v270` — branch **`fix/signup-error-classification`**, HEAD **`1d9bf39`** (Stage-2/3 security work; the production source of truth).
  - Key commits: Stage-2 `5dcbe37`, Stage-3 safety `444a577`, Stage-3 final `620285b`, closeout `1d9bf39`.
- Other worktree: `~/Desktop/ipear-loyalty-v270-reconstruction` (detached; has unique local tablet-reconstruction content — owner review; do not delete).
- Separate legacy clone: `~/Desktop/iPEAR LOYALTY SYSTEM` (monolith, branch `main` `15d8e30`, unique uncommitted "v52 Gold Supreme" — see `~/Documents/iPear/Loyalty/deployment-records/V52-RECONCILIATION.md`). **Diverged line; not canonical; preserved for reconciliation.**

> These repos are linked Git worktrees — **do not move them** (it breaks the worktree links). Organize artifacts around them under `~/Documents/iPear/Loyalty/` instead.

## Production
- **URLs:** customer/admin/tablet PWA `https://loyalty.ipear.gr` (Cloudflare Pages); Worker `https://email-worker.ipear2026.workers.dev`; WordPress/WooCommerce `https://ipear.gr`.
- **Worker:** active generation `c7bd0b6f` (source `ca86f0b7`), master-secret-free. Cloudflare account `f02bde005d8c8f63cf76a9f7a1c9ee3f`.
- **Frontend:** live admin bundle `admin-DKanSCzM.js` (owner-auth build), customer `main-CK7Edhjs.js`.
- **WordPress plugin:** **2.5.4** (`~/Documents/iPear/Loyalty/wordpress/releases/ipear-woo-loyalty-2.5.4.zip`, sha256 `65217f95…`).
- **Firestore:** locked rules sha256 `10df4875…` (in `firestore.rules` / `firestore.rules.locked`); 5 fortress Cloud Functions.

## Architecture (Admin Fortress, current)
- **Admin → Worker:** Firebase ID token + `admin:true` claim + `OWNER_UIDS` allowlist + App Check, on `/admin/v2/*`. No browser master secret.
- **WordPress → Worker:** scoped `WOO_LOOKUP_SECRET` (read-only `/woo/v2/get-user`) + `WOO_LOYALTY_SECRET` (`/woo-credit-order`, `/woo-refund-order`).
- **Backups:** `BACKUP_SIGNING_KEY` HMAC for signed download URLs.
- **Financial writes:** server-only; Firestore §6b lock; integer-cent ledger idempotency.
- **Legacy ADMIN_SECRET routes:** all return `410 endpoint-retired`; create-admin handler deleted.

## ⚠️ ADMIN_SECRET is permanently retired
ADMIN_SECRET has been **eliminated** (Stage 3F): deleted from Cloudflare, zero runtime verifier, zero consumers. **It must never be restored.** No rollback may recreate it or place any master secret in the browser or WordPress.

## Approved rollback policy
Modern, master-secret-free only: Worker `ca86f0b7` / `c7bd0b6f` (or newer reviewed equivalent) + source `620285b`+; WordPress 2.5.4; locked Stage-2 rules + fortress functions + owner-auth frontend. **Never** `b4c05a77` / `e8557bc0` / earlier, WP 2.5.2–2.5.3, or any ADMIN_SECRET-era / flag-OFF-master-secret / pre-Stage-2 build.

## Deploy runbooks (run from the authoritative worktree; see also `DEPLOY_RUNBOOK.md`)
Before any Cloudflare op, ensure `wrangler` is the **correct account**: `npx wrangler whoami` → must be `f02bde005d8c8f63cf76a9f7a1c9ee3f` (it has reverted to the wrong account after app restarts — if so, `npx wrangler login` and pick that account).
- **Worker:** `npx wrangler deploy` (preserves secrets). Dry-run: `npx wrangler deploy --dry-run --outdir=/tmp/ew`.
- **Frontend (Pages):** `npm run build:pages` then deploy `dist/` to Pages project `ipear-loyalty` (see `DEPLOY_RUNBOOK.md`).
- **WordPress:** owner uploads the 2.5.4 ZIP via WP Admin → Plugins → Add New → Upload.
- **Tests:** `npm test` (pure); rules/locked/lifecycle via the `test:rules` / emulator scripts (`JAVA_HOME` = the JDK-17 path).

## Artifacts & records (not version-controlled source)
`~/Documents/iPear/Loyalty/`: `wordpress/releases/` (current 2.5.4), `releases/` (current/rollback), `deployment-records/` (`RELEASES.md`, `V52-RECONCILIATION.md`), `archive/historical-artifacts/`, `archive/unknown-review/`.

## Security / data-hygiene follow-up (outside this cleanup)
`~/Downloads/loyalty-ipear-firebase-adminsdk-*.json` (live Firebase **admin private key**) and `~/Downloads/ipear-pelates-*.csv` (customer personal data) were left untouched. The admin key needs a deliberate **review / rotation** decision (moving it is not remediation).
