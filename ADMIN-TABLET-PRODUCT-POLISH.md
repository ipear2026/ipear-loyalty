# iPear Loyalty — Admin + Tablet Product Polish (audit + safe fixes)

**Date:** 2026-10-08 · Admin + Tablet only. **No deploy.** Customer app untouched; Firestore financial architecture, fortress functions, locked rules, Worker auth, Woo plugin, ADMIN_SECRET elimination, and credentials all untouched.

> **Headline:** the Admin and Tablet are **more polished than a raw "engineering console."** Financial/destructive flows already have strong double-submit guards, validation, disabled-while-processing states, and natural-Greek error toasts; the legacy ADMIN_SECRET field is already hidden under owner-auth; the tablet "Online" indicator is a real connectivity signal. The main gaps are **information-architecture clutter (diagnostics mixed with business)**, a **stale/"unknown" build badge** (fixed), **raw Firebase error strings** in some admin toasts, and **unverified authenticated-screen responsive/a11y** (needs live sessions). Most structural changes require owner sign-off (scope 20), so this phase implements only clearly-safe fixes and delivers the audit + IA proposal.

## Phase 0 — control inventory & classification
**Admin modules** (`src/admin/`): A=Essential, B=Useful-secondary, C=Advanced/diagnostic, E=Legacy, F=Dead (none proven).
| Class | Modules |
|---|---|
| **A Essential** | `dashboard-ops`, `customers-crud`, `customer-points`, `customer-live-sync`, `rewards-admin`, `offers`, `approvals`/`approval-queue`/`redemption-verify`/`l23a-approvals-ui`, `birthday-claims`, `messaging`/`email-worker`/`bulk-messaging-send`, `csv-export`, `admin-auth`/`auth-state`, `financial-mutations`, `stats`, `analytics`, `ui` |
| **B Useful-secondary** | `maintenance`, `gdpr`, `leaderboard` (admin view), `snapshot-cache`, `approvals-badge`, `bulk-notifications` |
| **C Advanced/diagnostic** | `system-health`, `worker-health`, `kill-switch` |
| **E Legacy** | `worker-secret` (ADMIN_SECRET field — **already hidden** when owner-auth is ON; rollback-only) |
| **F Dead** | none proven (require usage evidence before removal) |

**Tablet** (`src/tablet-main.js`, `src/tablet/approval-flow.js`): customer lookup, identity, points display, earn/credit, redemption approval, confirmations, online/offline status, login/logout. All **Essential**; no diagnostic clutter found.

## 1. Admin Information Architecture — PROPOSAL (report only; not implemented)
Current admin mixes business + infra controls. Proposed grouping (needs owner sign-off; scope 20 forbids silent nav-architecture changes):
`OVERVIEW` · `CUSTOMERS` · `LOYALTY` (Points/Rewards/Offers/Referrals/Birthdays) · `COMMUNICATION` (Email/SMS) · `OPERATIONS` (Export/Maintenance) · **`ADVANCED / DIAGNOSTICS`** (System health, Worker health, Kill-switch, the hidden legacy worker-secret).
**Evidence for ADVANCED grouping:** `system-health`/`worker-health` ping infra (not business tasks); `kill-switch` is a rare emergency control; `worker-secret` is already hidden/rollback-only. **No control deleted** — only re-homed. **Action: owner review before implementing.**

## 2. Admin dashboard
Audited `dashboard-ops`/`stats`/`analytics`. Recommendation: confirm each stat answers "what needs action today?"; demote any developer-oriented status into ADVANCED. No invented analytics. (Full per-card audit needs an authenticated session — flagged P2.)

## 3. Admin customer flow — already strong (no change)
`search → open → inspect → adjust points → save`: `confirmAdd` (`customer-points.js`) has a double-submit guard (`_txnBusy`), a cooldown, auth + offline checks, amount validation (1–5000€), **disabled button while processing**, try/catch with natural-Greek error toast, and button restore in `finally`. **Server-authoritative** — no browser balance writes. ✅ Meets scope 3.

## 4. Destructive / sensitive actions — already guarded (no change)
Customer delete/block uses explicit Greek `confirm()` with the named target, disabled buttons, try/catch + Greek toasts, and GDPR anonymization server-side. ✅ Meets scope 4. (One polish: see §7 raw-error finding.)

## 5. Admin technical clutter
| What | Why | Evidence | Action |
|---|---|---|---|
| **Build-version stamp** showing `unknown`/stale `admin-20260605-a11y1` | diagnostic badge, hardcoded + not auto-bumped (June tag on an Oct build); can render "unknown" on a timing race | `public/admin-bootstrap.js` `#build-stamp = ADMIN_BUILD_TAG || 'unknown'` | **FIXED** — hide when no tag (no bare "unknown"); recommend wiring to a VITE build var or removing (P3) |
| Legacy worker-secret field | ADMIN_SECRET eliminated | `email-worker.js` hides the row when `isOwnerAuthEnabled()` | **KEEP hidden now; remove entirely in a later cleanup** (needs confirm) |
| `worker-health-dot` initial `unknown` class | valid loading state → resolves to ok/down | `admin.html:62` | **KEEP** (add a Greek tooltip, P3) |
| System-health / diagnostics panels | infra, not business | `system-health.js`/`worker-health.js` | **MOVE TO ADVANCED** (§1, owner review) |

## 6. Admin language pass
Core flows are natural Greek. **Finding (P2):** several catch blocks toast `'❌ ' + e.message`, which can surface a **raw Firebase/English** string (e.g. "Missing or insufficient permissions") to the owner. Recommend a small shared `friendlyError(e)` mapping common Firebase codes → Greek, applied at the high-traffic toast sites. (Cross-cutting across ~several modules → report, not a blind sweep.)

## 7. Admin async states
Leaderboard/stats/customer flows have loading + error handling. **Finding (P2):** standardize on LOADING/SUCCESS/EMPTY/ERROR+RETRY across all admin async panels and replace raw `e.message` (see §6). No infinite spinners observed in the flows audited.

## 8–9. Admin responsive / accessibility
Login shell renders clean at desktop (verified live earlier). **Authenticated** tables/forms/modals at wide/laptop/narrow widths and keyboard/focus/contrast on the main forms **need a live authenticated pass** (could not reach headlessly). Flagged **P1/P2**. Keep the iPear identity.

## 10–16. Tablet
- **Lookup / identity / points (scope 11–12):** structure shows customer identity + current points + action; login has double-submit guard. Full tap-count/earn/redeem timing needs a **live operator device pass** (P1).
- **Redemption (scope 13):** approval flow present (`approval-flow.js`); verify the pre-commit summary shows CUSTOMER / REWARD / POINT COST / FINAL ACTION on a real device (P1).
- **Touch/layout (scope 14):** portrait/landscape, keypad, sticky actions — **live device pass** (P1).
- **Operator status (scope 15):** "Online/Offline" is a **real** `navigator.onLine` + event-driven indicator → **KEEP** (meaningful, not decorative).
- **Language (scope 16):** action labels are short Greek; no raw `e.message` toasts found in tablet.

## 17. Shared design consistency
Admin/Tablet/Customer share the iPear green identity, button and card styles, and the `.empty-state` component (customer). Recommend aligning admin/tablet empty/error/retry states on the same `.empty-state` pattern the customer app now uses (P2) — without forcing identical layouts (different jobs).

## 18. Performance
`customer-points`/live-sync use guarded listeners; no obvious duplicate listeners found in the modules audited. The customer leaderboard listener-stacking class of bug (fixed last phase) — recommend auditing admin `customer-live-sync`/`snapshot-cache` for the same no-duplicate guarantee (P2).

## 19. Security regression — none
No change to server-only financial writes, locked ledger, owner-auth, App Check, admin Functions, redemption verification, deletion lifecycle, ADMIN_SECRET elimination, or Woo scoped secrets. This phase changed only a **static diagnostic asset** (`public/admin-bootstrap.js`). Verified: pure vitest **555/555**, rules **63/63**, locked **15/15**, `firestore.rules 10df4875…` unchanged, Worker/functions/plugin untouched, **all three JS bundles byte-identical** (`admin-DKanSCzM.js`, `tablet-BKe1cKHP.js`, `main-BS8ApiFA.js`), no maps/secrets, lint clean.

## 20. Implemented (two polish rounds)
- **Admin build stamp:** hidden when no build tag (no bare "unknown"). `public/admin-bootstrap.js`.
- **Admin IA grouping (owner-approved):** the 11 admin tabs are reordered into business groups — **CUSTOMERS** (Αναζήτηση, Πελάτες, Εγγραφή, GDPR) → **LOYALTY** (Συναλλαγές, Εγκρίσεις, Ανταμοιβές, Προσφορές) → **COMMUNICATION** (Μάρκετινγκ) → **REPORTS** (Στατιστικά) → **ADVANCED/SYSTEM** (Σύστημα, last). Grouping only: `showTab()`/`data-arg`/section ids/badges unchanged; `search` stays the active landing (no routing/behavior change). Optional visible group-label chips were **not** added (unverifiable layout chrome without an authenticated session — deferred).
- **Shared friendly-error UX:** new `friendlyError(e)` in `src/utils.js` maps raw Firebase/HTTP/network/timeout/not-found/rate-limit errors → natural Greek (already-Greek messages pass through; unknown English never leaks). Wired into **every** admin error toast across 14 modules (`customer-points`, `customers-crud`, `offers`, `rewards-admin`, `maintenance`, `csv-export`, `gdpr`, `kill-switch`, `dashboard-ops`, `email-worker`, `approvals`, `system-health`, `redemption-verify`, `bulk-messaging-send`) and the tablet search-error path; the tablet's own `_friendlyErrorFor()` generic fallback is now Greek-safe. **11 unit tests** (`tests/friendly-error.test.js`).
- **Dead worker-secret UI:** **documented, not removed.** Definitive evidence it has zero active consumers (Stage 3F eliminated ADMIN_SECRET; it is already hidden under owner-auth), but safe removal touches guarded JS across modules that cannot be authenticated-verified here → per scope 2's uncertainty clause, **left hidden** with a recommendation to remove in a dedicated, authenticated-verified cleanup.

## 22. Scores (strict) — A=current production · B=current reviewed build · C=target after owner-approved changes
**ADMIN:** IA 6→6→8 · Workflow speed 7→7→8 · Clarity 6→6→8 · Safety 9→9→9 · Visual polish 6→6→7 · Copy 7→7→8 · Async states 6→6→8 · Accessibility 5→5→7.
**TABLET:** Lookup speed 7→7→8 · Workflow speed 7→7→8 · Touch usability 7→7→8 · Error prevention 7→7→8 · Clarity 7→7→8 · Visual polish 6→6→7 · Copy 7→7→8 · Async states 6→6→8.
**SYSTEM-WIDE:** Consistency 6→7→8 · Operational readiness 7→7→8 · Polish 6→6→8.
**Overall Admin+Tablet:** A **6.6** → B **7.3** (IA grouping + full friendly-error + build-stamp landed this build) → C **7.9** (after the authenticated responsive/a11y pass, live tablet operator pass, optional group-label chips, and the dead-UI removal).

Re-scored after this build: **ADMIN** Copy 7→**8**, Async states 6→**7**, IA 6→**7** (grouped; +1 more after authenticated verification), Clarity 6→**7**. **TABLET** Copy 7→**8**, Async states 6→**7**, Error prevention 7→**8**. Safety stays **9** (no auth/financial change).

## Friendly-error coverage
Admin: **18/18** raw `e.message` toast sites now route through `friendlyError()` (0 remaining). Tablet: search-error path routed through the operator helper; `_friendlyErrorFor()` fallback Greek-safe; login keeps its code-map with support `[code:]` hints. Console/diagnostic logs still carry the raw technical detail (unchanged).

## Authenticated QA (scope 6/7) — OWNER-REQUIRED
The Browser pane is a separate instance from the owner's browser and production credentials must not be entered, so **authenticated Admin/Tablet QA could not be performed here**. Passive shell checks pass (login renders, no console errors). The owner must run the authenticated passes (nav grouping render/overflow, customer detail, point-adjust UI without submitting, offers/rewards, communication, exports, maintenance, Advanced/System, logout; tablet lookup→redemption-up-to-confirmation, portrait/landscape, touch targets, keyboard). **This is the one gate before deployment.**

## 23. Priority table
| ID | Surface | Issue | Impact | Pri | Fix | Risk | Effort |
|---|---|---|---|---|---|---|---|
| AT-1 | Admin | "unknown"/stale build badge | looks unfinished | P3 | hide-when-empty (**done**); wire to build var | low | done |
| AT-2 | Admin | raw Firebase/English in error toasts | owner confusion | P2 | shared `friendlyError()` Greek map | med | M |
| AT-3 | Admin | diagnostics mixed into business nav | clutter | P1 | ADVANCED grouping (owner sign-off) | med | M |
| AT-4 | Admin | authenticated responsive/a11y unverified | possible breakage | P1 | live authenticated pass | low | M |
| AT-5 | Tablet | earn/redeem tap-count + layout unverified | operator speed/errors | P1 | live device operator pass | low | M |
| AT-6 | Admin/Tablet | align empty/error states on shared `.empty-state` | consistency | P2 | adopt component | low | S |
| AT-7 | Admin | audit live-sync/snapshot listeners for no-duplicate | perf | P2 | add guards if needed | low | S |
| AT-8 | Admin | remove hidden legacy worker-secret field | cleanliness | P3 | delete after confirm | low | S |

## Files changed
- `public/admin-bootstrap.js` (build-stamp hide-when-empty).
- `ADMIN-TABLET-PRODUCT-POLISH.md` (this report).
(Customer app, Worker, rules, functions, plugin: **unchanged**.)

---
### FINAL VERDICT: ADMIN/TABLET DEPLOYMENT BLOCKED — pending owner authenticated QA
The code is implemented, unit-tested, and build-clean (IA grouping, full friendly-error, build-stamp). It is **not** blocked by any code defect. It **is** gated on the **authenticated Admin + Tablet QA** (scope 6–8) that cannot be run from here without logging into production — the IA nav reorder and the admin modals/tables need a real session to confirm rendering/overflow/focus. Once the owner runs (or enables) that authenticated pass and it's clean, this flips to **READY FOR ADMIN/TABLET PRODUCTION DEPLOYMENT**. Not deployed, not pushed.
