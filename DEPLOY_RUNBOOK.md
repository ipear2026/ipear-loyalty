# iPear Loyalty — Phase A + B Deploy Runbook

> Branch: `refactor/p1-services-split` · 7 commits · B− (65%) → **A− (~91%)**

Execute **strictly in order**. Each step has a verification gate; do not proceed to the next step until the gate passes.

---

## 0. Prerequisites

- Firebase CLI logged in to project `loyalty-ipear` (`firebase login --reauth`)
- Wrangler logged in to Cloudflare account `f02bde005d8c8f63cf76a9f7a1c9ee3f` (`wrangler login`)
- Cloudflare Pages project connected to this repo (or manual upload of `dist/`)
- All Worker secrets already set in Cloudflare dashboard:
  `ADMIN_SECRET`, `BREVO_API_KEY`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`,
  `FIREBASE_API_KEY`, `WOO_URL`, `WOO_KEY`, `WOO_SECRET`
- Admin account that can call HTTPS callable functions

## 1. Pre-flight (local)

```bash
npm run lint && npm run build
firebase deploy --only firestore:rules --dry-run
wrangler deploy --dry-run
node --check email-worker.js
node --check functions/index.js
```
**Gate:** every command exits 0.

---

## 2. Firestore rules + Cloud Functions

```bash
firebase deploy --only firestore:rules,functions
```

**Ships:**
- New `isVerifiedAuth()` helper; `ownsCustomer()` / `isUidBindOnly()` gated on `email_verified` (HIGH-1)
- Signup forces `points==0 && totalPoints==0` (CRITICAL-2)
- `isAdmin()` checks `request.auth.token.admin == true` (free, claim-based) before falling back to `exists()` (MEDIUM-3)
- New triggers: `syncAdminClaim`, `backfillAdminClaims` callable

**Gate (Firebase Console):**
1. Firestore → Rules tab → check the "Last published" timestamp updated.
2. Functions tab → confirm both `syncAdminClaim` and `backfillAdminClaims` show "Healthy".

---

## 3. Backfill admin claims (one-shot)

From an existing admin's browser console at `https://loyalty.ipear.gr/admin.html`:

```js
const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
const functions = getFunctions(firebase.app(), 'us-central1');  // or your region
const fn = httpsCallable(functions, 'backfillAdminClaims');
const res = await fn();
console.log(res.data);   // expect { total, updated, alreadySet, skipped }
```

**Gate:** `res.data.total === <number of expected admins>` and `skipped === 0`. If skipped > 0, check Function logs for `[backfillAdminClaims] error for uid=...` — usually means an `ipear_admins` doc whose UID no longer exists in Auth.

## 4. Admin re-login

Each admin must log out + log back in once (or wait ≤ 1 hour for token refresh). Until they do, they still hit the legacy `exists()` fallback path — no functional impact, just an extra billed read per request.

**Gate:** ask one admin to sign out + sign back in, then open Firestore → Rules Playground:
- Select an admin write path (e.g. `update ipear_customers/<any>`)
- Set `auth.uid` = the admin's UID
- The Playground should show the rule passing **without** consulting `ipear_admins/<uid>`. (You can verify in the Function logs that no `exists()` was made.)

---

## 5. Cloudflare Worker

```bash
wrangler deploy
```

**Ships:**
- Fail-closed KV rate limiter (MEDIUM-6) — 503 if KV unreachable
- `readJsonCapped()` on all public endpoints (MEDIUM-5) — 32 KB default cap
- `/send-welcome` now idToken-authenticated + idempotent +50 credit (HIGH-4)
- `/process-referral` reverts new customer's balance when refDoc missing (CRITICAL-2)
- `/admin/export-backup` → R2 upload + HMAC-signed download URL (MEDIUM-1)
- `/admin/export-download` (new GET endpoint)
- `/client-error` admin alert email — every field HTML-escaped (LOW-3)

**Gate:**
```bash
# Origin headers / general health
curl -sI https://email-worker.ipear2026.workers.dev/health
# Body cap enforcement
curl -X POST https://email-worker.ipear2026.workers.dev/log-event \
  -H 'Content-Type: application/json' \
  --data-binary @<(head -c 100000 /dev/urandom | base64) | head
#   → expect {"error":"payload too large"}, status 413
# Auth gate on welcome
curl -X POST https://email-worker.ipear2026.workers.dev/send-welcome \
  -H 'Content-Type: application/json' \
  -d '{"name":"x"}'
#   → expect {"error":"idToken required"}, status 401
```

## 6. R2 bucket (one-time, manual)

The export-backup path returns **503** until this is done.

1. Cloudflare dashboard → R2 → Create bucket `ipear-backups`
2. (Optional) Object Lifecycle: delete after 30 days
3. Edit `wrangler.toml` — uncomment the `[[r2_buckets]]` block:
   ```toml
   [[r2_buckets]]
   binding     = "BACKUP_R2"
   bucket_name = "ipear-backups"
   ```
4. `wrangler deploy` again

**Gate:**
```bash
curl -X POST https://email-worker.ipear2026.workers.dev/admin/export-backup \
  -H 'Authorization: Bearer <ADMIN_SECRET>'
# Expect: { ok:true, downloadUrl, key, totalCustomers, expiresAt }
# Open downloadUrl in a browser; should download backup-YYYYMMDD....json
# Wait 10 minutes, retry the same URL → expect 410 "Signed URL expired"
```

---

## 7. Cloudflare Pages

If Pages is connected to the repo, the deploy auto-triggers on push. Otherwise:

```bash
npm run build
wrangler pages deploy dist --project-name=ipear-loyalty
```

**Ships:**
- Single-block `/*` `_headers` with HSTS + CSP + frame-ancestors (CRITICAL-1)
- Stricter CSP for `/admin` + `/admin.html` (no `script-src 'unsafe-inline'`) (HIGH-2)
- `/admin-bootstrap.js` extracted from inline `<script>` blocks (HIGH-2)
- All admin inline handlers → event delegation (HIGH-2)
- `_safeImgEl` DOM factory for offer images (HIGH-3)
- Customer points self-credit removed; idToken sent to `/send-welcome` (HIGH-4 client-side pair)

**Gate (after Pages publishes):**
```bash
# Headers must NOT drop on clean URLs (the CRITICAL-1 fix)
for u in / /admin /admin.html /tablet /tablet.html /index.html; do
  echo "=== $u ==="
  curl -sI "https://loyalty.ipear.gr$u" \
    | grep -iE 'strict-transport|content-security|permissions-policy|frame-ancestors|x-frame'
done
# Expect on EVERY URL: HSTS preload + CSP with frame-ancestors 'none'.
# /tablet* must show camera=(self); everything else camera=().

# Admin must NOT include 'unsafe-inline' in script-src
curl -sI https://loyalty.ipear.gr/admin | grep -i 'content-security' \
  | grep -E "script-src[^;]*'unsafe-inline'" && echo "❌ FAIL" || echo "✅ no unsafe-inline in script-src"

# Customer + tablet should still have it (Phase C will refactor)
curl -sI https://loyalty.ipear.gr/ | grep -iE "content-security" | grep -q "script-src 'self' 'unsafe-inline'" && echo "✅ customer keeps unsafe-inline (expected)"
```

---

## 8. Smoke test (end-to-end)

Open `https://loyalty.ipear.gr/`:
1. Register a new customer with a fake referral `IP-AAAAAA` and marketing opted-in.
   - Customer doc lands with `points: 0, totalPoints: 0`
   - `/send-welcome` fires → marketing +50 credited via worker (Firestore doc updated)
   - Within ~5s `/process-referral` fires → refDoc lookup fails → hard-revert keeps balance at 50
   - Customer balance ends at 50, not 150.
2. Register a second customer with marketing opted-in but no referral.
   - Balance ends at 50.
3. Have the second customer attempt to read another customer's doc via DevTools — should fail (`permission-denied`).

Open admin at `https://loyalty.ipear.gr/admin`:
1. Login. Eye toggle works (B/3a delegation).
2. Open every tab (Πελάτες, Συναλλαγές, Εγκρίσεις, Προσφορές, Μάρκετινγκ, Στατιστικά, Σύστημα, GDPR) — no console errors.
3. Trigger an export from a curl call (step 6 gate) and download the file.
4. DevTools → Network → confirm `script-src` does NOT include `'unsafe-inline'` on `/admin`.

---

## What's deployed in this PR

| Commit | Items |
|---|---|
| `eec2313` | CRITICAL-1, CRITICAL-2, HIGH-1, HIGH-3, HIGH-4, MEDIUM-5, MEDIUM-6 |
| `e9392c9` | LOW-1, LOW-3 |
| `7422dab` | MEDIUM-1 (R2 + HMAC URL) |
| `b0c59bb` | HIGH-2 admin handler delegation |
| `34e9f0a` | MEDIUM-3 admin custom claim |
| `502ec6f` | HIGH-2 CSP `unsafe-inline` drop for /admin* |

## What's NOT in this PR (Phase C)

- **MEDIUM-2** — `window._*` SDK exports cleanup (492 refs across 20 files). Architecture in place at `src/services/firebase.js`; refactor is mechanical but needs per-entry UI testing.
- **HIGH-2 customer + tablet** — same delegation refactor + CSP tightening as admin, applied to customer.html (54 onclick / 19 onkeydown) and tablet.html (14 onclick / 6 onkeydown).
- **LOW-2** — cosmetic-only double-escape on password reset email link (harmless).

## Rollback

If anything breaks in production:

```bash
# Roll back rules + functions (use the previous published version in Firebase Console → Rules → Version History → restore)
# Roll back Worker
wrangler rollback
# Roll back Pages — revert to previous deployment in CF dashboard
git revert eec2313..HEAD   # local commit revert if needed before re-push
```

The Phase A `email_verified` rule change is the most likely breakage source — if legacy customers can't read their docs, the temporary fix is to comment out the `isVerifiedAuth()` check in `ownsCustomer()` for the email-match branch, redeploy rules, then plan a one-shot Cloud Function to backfill `email_verified` on legitimate accounts before re-tightening.
