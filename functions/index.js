const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { createHash } = require("node:crypto");
const { canonicalOfferCredit } = require("./lib/offer-credit");
// ADMIN FORTRESS Stage 0/1 — owner authorization + server-authoritative mutations.
const { checkOwner } = require("./lib/owner");
const {
  validateAdjustInput, planAdjustment, ledgerIdForKey, auditIdForKey,
  planMaintenance, maintLedgerId, MAINT_OPS, MAX_BATCH,
} = require("./lib/admin-financial");
const { planRewardRedeem, planOfferRedeem } = require("./lib/redemption");
const {
  tombstoneId, lifecycleId, planLedgerAnonymization, LIFECYCLE_POLICY,
} = require("./lib/lifecycle");

initializeApp();
const db = getFirestore();

const MAX_ACTIVE_CODES = 1;

// M-3 FIX: Enforce max active redemption codes per customer.
// Triggers on every new redemption doc. If the customer already has
// an active pending code, the NEW code is cancelled server-side.
exports.enforceRedemptionLimit = onDocumentCreated(
  "ipear_redemptions/{rId}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    const customerUid = data.customerUid;
    if (!customerUid) return;

    // Only enforce on pending codes
    if (data.used === true || data.status !== "pending") return;

    const now = new Date();
    const col = db.collection("ipear_redemptions");

    // Find all pending, non-expired codes for this customer
    const pending = await col
      .where("customerUid", "==", customerUid)
      .where("used", "==", false)
      .where("status", "==", "pending")
      .get();

    const active = [];
    pending.forEach((d) => {
      const r = d.data();
      const exp = r.expiresAtTs?.toDate?.() || new Date(r.expiresAt);
      if (exp > now) active.push({ id: d.id, createdAt: r.createdAt });
    });

    if (active.length <= MAX_ACTIVE_CODES) return;

    // Sort by creation time — keep the newest, cancel the rest
    active.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
    const toCancel = active.slice(MAX_ACTIVE_CODES);

    const batch = db.batch();
    for (const c of toCancel) {
      batch.update(col.doc(c.id), {
        status: "cancelled",
        cancelledAt: new Date().toISOString(),
        cancelReason: "server-limit-exceeded",
      });
    }
    await batch.commit();

    console.log(
      `[enforceRedemptionLimit] Customer ${customerUid}: cancelled ${toCancel.length} excess code(s)`
    );
  }
);

// SEC-FIX C-1: Validate birthday claims server-side.
// Client can submit a claim any day — this function verifies the customer's
// birthday actually matches today before allowing processing.
exports.validateBirthdayClaim = onDocumentCreated(
  "ipear_birthday_claims/{claimId}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const claim = snap.data();

    if (claim.processed === true) return;

    const customerId = claim.customerId || claim.customerUid;
    if (!customerId) {
      await snap.ref.update({ processed: true, processedAt: new Date().toISOString(), rejected: true, rejectReason: "no-customer-id" });
      return;
    }

    const custSnap = await db.collection("ipear_customers").doc(customerId).get();
    if (!custSnap.exists) {
      await snap.ref.update({ processed: true, processedAt: new Date().toISOString(), rejected: true, rejectReason: "customer-not-found" });
      return;
    }

    const cust = custSnap.data();
    if (cust.blocked) {
      await snap.ref.update({ processed: true, processedAt: new Date().toISOString(), rejected: true, rejectReason: "customer-blocked" });
      return;
    }

    if (!cust.birthday) {
      await snap.ref.update({ processed: true, processedAt: new Date().toISOString(), rejected: true, rejectReason: "no-birthday" });
      return;
    }

    const bday = new Date(cust.birthday + "T00:00:00");
    const now = new Date();
    if (bday.getMonth() !== now.getMonth() || bday.getDate() !== now.getDate()) {
      console.warn(`[validateBirthdayClaim] REJECTED: ${customerId} birthday ${cust.birthday} != today ${now.toISOString().slice(0, 10)}`);
      await snap.ref.update({ processed: true, processedAt: new Date().toISOString(), rejected: true, rejectReason: "not-birthday-today" });
      return;
    }

    const year = claim.year || now.getFullYear();
    if (year !== now.getFullYear()) {
      await snap.ref.update({ processed: true, processedAt: new Date().toISOString(), rejected: true, rejectReason: "wrong-year" });
      return;
    }

    // ✅ Award points atomically + mark claim processed
    const custRef = db.collection("ipear_customers").doc(customerId);
    await db.runTransaction(async (txn) => {
      const custSnap = await txn.get(custRef);
      if (!custSnap.exists()) throw new Error("customer-gone");
      const c = custSnap.data();
      const newPts = (c.points || 0) + 50;
      const newTot = (c.totalPoints || 0) + 50;
      txn.update(custRef, { points: newPts, totalPoints: newTot });
      txn.update(snap.ref, {
        processed: true,
        processedAt: new Date().toISOString(),
        rejected: false,
        awardedPoints: 50,
      });
    });

    // Log transaction for ledger
    await db.collection("ipear_transactions").add({
      customerId,
      customerUid: claim.customerUid || customerId,
      customerName: claim.customerName || "",
      card: claim.card || "",
      type: "add",
      points: 50,
      amount: 0,
      category: "🎂 Birthday Bonus",
      note: "Αυτόματο δώρο γενεθλίων",
      date: new Date().toISOString(),
    });

    console.log(
      `[validateBirthdayClaim] ✅ Awarded 50 pts to ${customerId}, birthday ${cust.birthday}`
    );
  }
);

// ══════════════════════════════════════════════════════════════════════════
//  AUTO-PUBLISH LEADERBOARD — fires on every ipear_customers write
//  Rebuilds ipear_leaderboard/latest so all customer apps get live updates
//  via their existing onSnapshot listener.
//
//  Guard: rebuilds on create/delete, or when totalPoints actually changed
//  (skips name/phone edits). A DELETION always rebuilds so a removed customer
//  cannot linger in the published snapshot.
// ══════════════════════════════════════════════════════════════════════════

// Pure decision predicate lives in ./lib/leaderboard-logic.js (dep-free,
// unit-tested). See tests/leaderboard-logic.test.js.
const { shouldRepublishLeaderboard } = require("./lib/leaderboard-logic");

exports.autoPublishLeaderboard = onDocumentWritten(
  "ipear_customers/{customerId}",
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    // A customer DELETION must ALWAYS refresh the published leaderboard so the
    // removed customer can never linger in ipear_leaderboard/latest. (Bug: a
    // deleted doc has after=undefined -> ptsAfter=-1; a doc lacking a
    // totalPoints field gave ptsBefore=-1 too, so ptsBefore===ptsAfter skipped
    // the republish and the deleted customer stayed visible until an unrelated
    // write happened to re-trigger a publish.) Decision extracted to a pure,
    // unit-tested helper.
    if (!shouldRepublishLeaderboard(before, after)) return;

    try {
      // Query top 20 non-blocked customers ordered by totalPoints
      const snap = await db
        .collection("ipear_customers")
        .orderBy("totalPoints", "desc")
        .limit(20)
        .get();

      const top = [];
      snap.forEach((d) => {
        const c = d.data();
        if (c.blocked) return;
        const fullName = c.name || "—";
        // Privacy: abbreviate surname (e.g. "Νότης Μ.")
        const displayName = fullName
          .split(" ")
          .map((w, i) => (i === 0 ? w : (w[0] || "") + "."))
          .join(" ");
        top.push({
          name: displayName,
          points: c.points || 0,
          totalPoints: c.totalPoints || 0,
          card: c.card || "",
        });
      });

      // Sort (Firestore orderBy already did this, but blocked filter may shift order)
      top.sort((a, b) => b.totalPoints - a.totalPoints);
      const top20 = top.slice(0, 20);

      // Get total customer count (aggregation query — no full reads)
      const countSnap = await db
        .collection("ipear_customers")
        .where("blocked", "==", false)
        .count()
        .get();
      const total = countSnap.data().count;

      // Write to leaderboard/latest — triggers onSnapshot in all customer apps
      await db.collection("ipear_leaderboard").doc("latest").set({
        top: top20,
        total,
        updatedAt: new Date().toISOString(),
      });

      console.log(
        `[autoPublishLeaderboard] ✅ Published ${top20.length} entries, ${total} total customers`
      );
    } catch (e) {
      console.error("[autoPublishLeaderboard] Error:", e.message);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════
//  MEDIUM-3: syncAdminClaim — mirror ipear_admins/{uid} → Auth custom claim.
//
//  Previously isAdmin() in firestore.rules did `exists(ipear_admins/<uid>)`
//  on every admin write — one billed Firestore read per rule evaluation.
//  Worst case: an admin batch update of 5000 customers = 5000 extra reads
//  just for auth, on top of the real writes.
//
//  Now: this trigger fires on every create/delete in ipear_admins/{uid} and
//  sets/unsets the `admin: true` custom claim on the Firebase Auth user.
//  isAdmin() can then read request.auth.token.admin == true (free — already
//  inside the verified ID token).
//
//  The admin must log out and back in (or wait for token refresh, max 1 h)
//  before the new claim takes effect — use backfillAdminClaims (below)
//  to backfill existing admins, then ask them to re-login once.
// ══════════════════════════════════════════════════════════════════════════
// L2.3A pure decision function — computes what claims to set given the
// `ipear_admins/{uid}` doc state. Exposed via `_l23aInternals` for tests.
// Fail-closed: any doc with a missing/unknown role, or a tablet without a
// storeid, returns `failClosed: true` — the trigger strips all privileged
// claims AND revokes refresh tokens in that case.
function _decideAdminSyncState(after, docExists, currentClaims) {
  const nextClaims = { ...currentClaims };
  if (!docExists) {
    delete nextClaims.admin;
    delete nextClaims.role;
    delete nextClaims.storeId;
    return { failClosed: false, reason: null, nextClaims, summary: "none" };
  }
  const roleRaw = after.role;
  const storeIdRaw = after.storeid;
  const storeId =
    typeof storeIdRaw === "string" && storeIdRaw.length > 0 ? storeIdRaw : null;
  if (roleRaw === "admin") {
    nextClaims.admin = true;
    if (storeId) nextClaims.storeId = storeId;
    else delete nextClaims.storeId;
    delete nextClaims.role;
    return {
      failClosed: false,
      reason: null,
      nextClaims,
      summary: storeId ? `admin@${storeId}` : "admin",
    };
  }
  if (roleRaw === "tablet") {
    if (!storeId) {
      // Tablet without storeid → strip privileged claims + fail-closed.
      const stripped = { ...currentClaims };
      delete stripped.admin;
      delete stripped.role;
      delete stripped.storeId;
      return {
        failClosed: true,
        reason: "tablet-missing-storeid",
        nextClaims: stripped,
        summary: "none",
      };
    }
    delete nextClaims.admin;
    nextClaims.role = "tablet";
    nextClaims.storeId = storeId;
    return {
      failClosed: false,
      reason: null,
      nextClaims,
      summary: `tablet@${storeId}`,
    };
  }
  // Missing / unknown / malformed role → strip everything + fail-closed.
  const stripped = { ...currentClaims };
  delete stripped.admin;
  delete stripped.role;
  delete stripped.storeId;
  return {
    failClosed: true,
    reason: roleRaw === undefined ? "role-missing" : `role-unknown:${String(roleRaw).slice(0, 40)}`,
    nextClaims: stripped,
    summary: "none",
  };
}

// L2.3A: role model split into `role: 'admin' | 'tablet'` plus canonical
// `storeId` for tablets. Firestore rules `isAdmin()` now requires the
// `admin: true` claim; `isTablet()` requires `role: 'tablet'` + `storeId`.
// The two are mutually exclusive: a tablet user never has admin==true, and
// an admin user never has role=='tablet'. Refresh tokens are revoked on
// ANY change (create, role flip, delete) so the token picks up the new
// claim shape within one refresh cycle instead of the default 1h TTL.
exports.syncAdminClaim = onDocumentWritten(
  "ipear_admins/{uid}",
  async (event) => {
    const uid = event.params.uid;
    const after = event.data?.after?.data();
    const docExists = !!after;
    try {
      const user = await getAuth().getUser(uid).catch(() => null);
      if (!user) {
        console.warn(`[syncAdminClaim] no Auth user for uid=${uid} — skipping`);
        return;
      }
      const currentClaims = user.customClaims || {};

      // L2.3A FAIL-CLOSED: delegate to the pure decision function so the
      // choice tree (accept role='admin', accept role='tablet'+storeid,
      // reject everything else) is testable in isolation. See
      // _decideAdminSyncState() below + the tests it drives.
      const decision = _decideAdminSyncState(after, docExists, currentClaims);
      let nextClaims = decision.nextClaims;
      let desiredSummary = decision.summary;
      const failClosed = decision.failClosed;
      const failReason = decision.reason;

      if (failClosed) {
        // Strip all privileged claims + revoke refresh tokens + structured log.
        delete nextClaims.admin;
        delete nextClaims.role;
        delete nextClaims.storeId;
        try {
          await getAuth().setCustomUserClaims(uid, nextClaims);
        } catch (e) {
          console.error("[syncAdminClaim] fail-closed setCustomUserClaims failed:", e.message);
        }
        try {
          await getAuth().revokeRefreshTokens(uid);
        } catch (e) {
          console.error("[syncAdminClaim] fail-closed revokeRefreshTokens failed:", e.message);
        }
        console.error(
          JSON.stringify({
            severity: "ERROR",
            component: "syncAdminClaim",
            outcome: "fail-closed",
            uid,
            reason: failReason,
            docExists,
            action: "cleared-privileged-claims-and-revoked-tokens",
          })
        );
        return;
      }

      // Deep-equal current vs. desired subset (only the three keys we own).
      const changed =
        (currentClaims.admin === true) !== (nextClaims.admin === true) ||
        (currentClaims.role || null) !== (nextClaims.role || null) ||
        (currentClaims.storeId || null) !== (nextClaims.storeId || null);
      if (!changed) return;

      await getAuth().setCustomUserClaims(uid, nextClaims);

      // HIGH-2 + L2.3A: revoke refresh tokens on EVERY change. Previously
      // this fired only on demotion; extending it to every change means the
      // client picks up the new claim shape within one refresh cycle rather
      // than waiting up to 1h for the cached ID token to expire. Cost: one
      // extra login round-trip when an admin is (re)provisioned.
      try {
        await getAuth().revokeRefreshTokens(uid);
        console.log(`[syncAdminClaim] revoked refresh tokens for uid=${uid}`);
      } catch (e) {
        console.error(
          `[syncAdminClaim] revokeRefreshTokens failed for uid=${uid}:`,
          e.message
        );
      }

      console.log(
        `[syncAdminClaim] uid=${uid} → ${desiredSummary} (re-login required for token refresh)`
      );
    } catch (e) {
      console.error("[syncAdminClaim] error for uid=", uid, e.message);
    }
  }
);

// Callable function: one-shot backfill of admin claims for everyone already
// in ipear_admins. Run once after deploying syncAdminClaim. Restricted to
// existing admins (so a non-admin can't call it).
//
//   Usage from an admin's browser:
//     const fn = httpsCallable(functions, 'backfillAdminClaims');
//     await fn();
//
// Returns: { updated, alreadySet, skipped, total }
exports.backfillAdminClaims = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }
  // Only an existing admin (either by claim OR by doc) can run the backfill.
  const callerUid = request.auth.uid;
  const callerIsAdminByClaim = request.auth.token.admin === true;
  let callerIsAdminByDoc = false;
  if (!callerIsAdminByClaim) {
    const callerDoc = await db.collection("ipear_admins").doc(callerUid).get();
    callerIsAdminByDoc = callerDoc.exists;
  }
  if (!callerIsAdminByClaim && !callerIsAdminByDoc) {
    throw new HttpsError("permission-denied", "Admin only.");
  }

  const snap = await db.collection("ipear_admins").get();
  let updated = 0,
    alreadySet = 0,
    skipped = 0;
  for (const d of snap.docs) {
    const uid = d.id;
    try {
      const user = await getAuth().getUser(uid).catch(() => null);
      if (!user) {
        skipped++;
        continue;
      }
      const claims = user.customClaims || {};
      if (claims.admin === true) {
        alreadySet++;
        continue;
      }
      await getAuth().setCustomUserClaims(uid, { ...claims, admin: true });
      updated++;
    } catch (e) {
      console.error("[backfillAdminClaims] error for uid=", uid, e.message);
      skipped++;
    }
  }
  console.log(
    `[backfillAdminClaims] total=${snap.size} updated=${updated} alreadySet=${alreadySet} skipped=${skipped}`
  );
  return { total: snap.size, updated, alreadySet, skipped };
});

// ══════════════════════════════════════════════════════════════════════════
//  L2.3A: Tablet ⇄ Admin approval flow (callable Cloud Functions).
//
//  Design contract (see docs/L2.3A-APPROVAL-FLOW.md / L2.3A brief):
//    • Tablet never touches Firestore for customer/redemption data directly.
//    • Tablet calls createRedemptionRequest / lookupCustomerForTablet.
//    • Admin calls approveRedemption / rejectRedemption.
//    • All four require Firebase Auth AND App Check (enforced by
//      `enforceAppCheck: true` on the CF).
//    • createRedemptionRequest returns ONLY a masked customer projection
//      (display name, masked phone last-4, masked card, points, tier,
//      reward label, canonical points cost) plus an opaque requestId.
//    • lookupCustomerForTablet returns the same masked projection.
//    • Server-side idempotency:
//        - createRedemptionRequest deduplicates on
//          (storeId, code, tabletActorUid) — a second scan of the same QR
//          from the same tablet within TTL returns the existing requestId.
//        - approveRedemption uses deterministic ledger ids
//          (`redeem_${requestId}` / `offer_credit_${requestId}`) so a
//          retry after a successful commit is a no-op.
//    • All state transitions run inside a single Firestore runTransaction
//      that atomically updates customer/redemption/ledger/audit/request.
// ══════════════════════════════════════════════════════════════════════════

// Masked projection helper — used by createRedemptionRequest and
// lookupCustomerForTablet. Never returns email, birthday, address, referral
// data, uid, referrer chain, or any other sensitive customer field.
function _tabletCustomerProjection(cust, tierFn) {
  const phoneStr = String(cust.phone || "");
  const cardStr = String(cust.card || "");
  const points = Number(cust.points || 0);
  const totalPoints = Number(cust.totalPoints || points);
  return {
    displayName: String(cust.name || "").trim(),
    phoneMasked:
      phoneStr.length > 4
        ? "•••" + phoneStr.slice(-4)
        : phoneStr,
    cardMasked:
      cardStr.length > 4
        ? cardStr.slice(0, 3) + "•••" + cardStr.slice(-2)
        : cardStr,
    points,
    tier: tierFn(totalPoints),
    blocked: cust.blocked === true,
  };
}

// Server tier helper — mirrors src/utils.js tier() but kept inline so the
// CF has no dependency on the front-end bundle.
function _serverTier(totalPoints) {
  const t = Number(totalPoints || 0);
  if (t >= 6000) return "platinum";
  if (t >= 3000) return "diamond";
  if (t >= 1000) return "gold";
  if (t >= 500) return "silver";
  return "bronze";
}

// Auth-gate helpers — throw HttpsError so the client sees a clean code.
function _requireTablet(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const t = request.auth.token || {};
  if (t.role !== "tablet" || typeof t.storeId !== "string" || t.storeId.length === 0) {
    throw new HttpsError("permission-denied", "Tablet role required.");
  }
  return { uid: request.auth.uid, storeId: t.storeId };
}

function _requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const t = request.auth.token || {};
  if (t.admin !== true) {
    throw new HttpsError("permission-denied", "Admin only.");
  }
  return { uid: request.auth.uid };
}

// ───────────────────────────────────────────────────────────────────────────
//  ADMIN FORTRESS Stage 0 — security-event logging + owner gate + kill switch.
// ───────────────────────────────────────────────────────────────────────────

// Structured security event → Cloud Logging (foundation for log-based metric
// alerts in a later stage). NEVER include tokens/secrets/OTP/PII beyond the
// actor/customer UID. `details` is shallow and must already be redacted.
function _securityEvent(type, details) {
  try {
    const safe = { sev: "SECURITY", event: type, at: new Date().toISOString(), ...(details || {}) };
    // Use console.error for denials so they surface at ERROR severity.
    const deny = /deny|denied|fail|mismatch|replay|exceed|disabled|forbidden/i.test(type);
    (deny ? console.error : console.log)("[SEC-EVENT]", JSON.stringify(safe));
  } catch (_) { /* never let logging break a handler */ }
}

// Server-side financial kill-switch placeholder (AF-12). Enforcement is OFF by
// default; when env ADMIN_FINANCIAL_ACTIONS_DISABLED === "true" every
// owner-gated financial mutation is denied (fail-safe). Not enabled in prod now.
function _financialActionsDisabled() {
  return String(process.env.ADMIN_FINANCIAL_ACTIONS_DISABLED || "").trim() === "true";
}

// Owner gate (AF-4 single-owner): valid Firebase auth AND admin claim AND the
// server-side OWNER_UIDS allowlist. Fail-closed (missing config → deny). This
// is ADDITIVE defense-in-depth; the existing admin-claim gate still applies to
// all legacy paths.
function _requireOwner(request, opName) {
  if (!request.auth) {
    _securityEvent("owner_denied", { op: opName || null, reason: "unauthenticated" });
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const t = request.auth.token || {};
  const uid = request.auth.uid;
  const verdict = checkOwner(t, uid, process.env.OWNER_UIDS);
  if (!verdict.ok) {
    _securityEvent("owner_denied", { op: opName || null, uid: uid || null, reason: verdict.reason });
    // Uniform permission-denied to the client (no oracle about which check failed).
    throw new HttpsError("permission-denied", "Owner authorization required.");
  }
  return { uid };
}

// Deterministic ledger id for approveRedemption idempotency.
function _ledgerIdForRequest(requestId, type) {
  const prefix = type === "offer_credit" ? "offer_credit" : "redeem";
  return `${prefix}_${requestId}`;
}

// L2.3A: deterministic request id — pure function of the scan identity.
// Two concurrent scans of the same (storeId, tabletActorUid, code) triple
// COMPUTE THE SAME id, so the atomic transaction below sees one existing
// doc and returns it verbatim to both callers. No race window.
function _deterministicRequestId(storeId, tabletActorUid, code) {
  const raw = `${storeId}|${tabletActorUid}|${code}`;
  return "req_" + createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

// createRedemptionRequest(code)
//   - Tablet-only. Requires App Check.
//   - Looks up a pending redemption (or offer redemption) by the 6-digit code.
//   - Idempotency: if this tablet already has a pending request for the same
//     (code, storeId) that has not expired and is still 'pending', returns
//     the existing requestId + projection (deduplicated).
//   - Rate limit: max 20 requests per (tablet uid) per 60 s (fail-open on
//     Firestore contention — the deterministic-idempotency key stops the
//     abuse vector; the rate limit protects against absent-minded rescans).
//   - Returns: { requestId, alreadyPending, projection: {...} }
async function _createRedemptionRequestHandler(request) {
    const { uid: tabletActorUid, storeId } = _requireTablet(request);
    const raw = request.data && request.data.code;
    if (typeof raw !== "string" || !/^\d{6}$/.test(raw)) {
      throw new HttpsError("invalid-argument", "code must be a 6-digit string.");
    }
    const code = raw;

    // ── Rate limit (soft): per-tablet counter in a tiny Firestore doc.
    // Not the atomic security boundary — the deterministic-id transaction
    // below is that — but stops absent-minded rescans from flooding the queue.
    const rateRef = db.collection("_ratelimits_tablet").doc(tabletActorUid);
    await db.runTransaction(async (txn) => {
      const snap = await txn.get(rateRef);
      const now = Date.now();
      const windowMs = 60_000;
      const maxHits = 20;
      let bucket = snap.exists ? snap.data() : { windowStart: now, hits: 0 };
      if (now - (bucket.windowStart || 0) > windowMs) {
        bucket = { windowStart: now, hits: 0 };
      }
      bucket.hits = (bucket.hits || 0) + 1;
      if (bucket.hits > maxHits) {
        throw new HttpsError(
          "resource-exhausted",
          "Too many scans — wait a minute."
        );
      }
      txn.set(rateRef, bucket);
    });

    // ── Discover the redemption or offer redemption by code (outside txn:
    // needs a query, which is not allowed in transactions).
    let type = null;
    let redemptionDocRef = null;
    let redemptionData = null;
    const redeemQ = await db
      .collection("ipear_redemptions")
      .where("code", "==", code)
      .limit(1)
      .get();
    if (!redeemQ.empty) {
      type = "redeem";
      redemptionDocRef = redeemQ.docs[0].ref;
      redemptionData = redeemQ.docs[0].data();
    } else {
      const offerQ = await db
        .collection("ipear_offer_redemptions")
        .where("code", "==", code)
        .limit(1)
        .get();
      if (!offerQ.empty) {
        type = "offer_credit";
        redemptionDocRef = offerQ.docs[0].ref;
        redemptionData = offerQ.docs[0].data();
      }
    }
    if (!redemptionData) {
      throw new HttpsError("not-found", "Invalid or expired code.");
    }

    // Resolve customer ref outside txn (needs id lookup, sometimes with
    // customerUid fallback).
    const customerId = redemptionData.customerId;
    const customerUid = redemptionData.customerUid || redemptionData.customerDocId || customerId;
    if (!customerId) {
      throw new HttpsError("failed-precondition", "Redemption is missing customerId.");
    }
    let custRef = db.collection("ipear_customers").doc(customerId);
    let custPreSnap = await custRef.get();
    if (!custPreSnap.exists && customerUid && customerUid !== customerId) {
      custRef = db.collection("ipear_customers").doc(customerUid);
      custPreSnap = await custRef.get();
    }
    if (!custPreSnap.exists) {
      throw new HttpsError("not-found", "Customer not found.");
    }

    // ── DETERMINISTIC IDEMPOTENCY: single request doc per
    // (storeId, tabletActorUid, code) triple. Two concurrent scans compute
    // the SAME id and race the transaction; one wins the write, the other
    // sees the existing doc and returns the same requestId. Zero duplicates.
    const requestId = _deterministicRequestId(storeId, tabletActorUid, code);
    const requestRef = db.collection("ipear_redemption_requests").doc(requestId);

    const nowMs = Date.now();
    const expiresAtTs = Timestamp.fromMillis(nowMs + 5 * 60 * 1000);
    const nowIso = new Date(nowMs).toISOString();

    // Compute reward cost/label once — used both when writing fresh and
    // when validating an existing pending request against current state.
    let rewardCost = 0;
    let rewardLabel = "";
    if (type === "redeem") {
      rewardCost = Number(redemptionData.points || 0);
      rewardLabel = String(redemptionData.label || "");
      if (!Number.isInteger(rewardCost) || rewardCost <= 0) {
        throw new HttpsError("failed-precondition", "Invalid reward cost.");
      }
    } else {
      // offer_credit: rewardCost is stored NEGATIVE (represents a credit).
      rewardCost = -Number(redemptionData.bonusPoints || 0);
      rewardLabel = String(redemptionData.offerTitle || "Offer");
      if (!Number.isFinite(rewardCost) || rewardCost >= 0) {
        throw new HttpsError("failed-precondition", "Invalid bonus points.");
      }
    }

    // Underlying-code freshness check (outside txn; caller sees a clean
    // failed-precondition rather than an "already-pending" that references
    // a stale code).
    if (redemptionData.used === true) {
      throw new HttpsError("failed-precondition", "Code already used.");
    }
    if (redemptionData.status === "cancelled" || redemptionData.status === "rejected") {
      throw new HttpsError("failed-precondition", "Code cancelled or rejected.");
    }
    const redExpMs =
      redemptionData.expiresAtTs?.toDate?.()?.getTime?.() ??
      new Date(redemptionData.expiresAt).getTime();
    if (!Number.isFinite(redExpMs) || nowMs > redExpMs) {
      throw new HttpsError("failed-precondition", "Code expired.");
    }

    // The atomic write. Runs inside a transaction so concurrent invocations
    // serialize — the second caller sees the first caller's write and takes
    // the alreadyPending path.
    const txnResult = await db.runTransaction(async (txn) => {
      const existing = await txn.get(requestRef);
      const custTxnSnap = await txn.get(custRef);

      if (!custTxnSnap.exists) {
        throw new HttpsError("not-found", "Customer not found.");
      }
      const cust = custTxnSnap.data();
      if (cust.blocked === true) {
        throw new HttpsError("failed-precondition", "Customer is blocked.");
      }
      if (type === "redeem" && (cust.points || 0) < rewardCost) {
        throw new HttpsError("failed-precondition", "Insufficient balance.");
      }

      if (existing.exists) {
        const data = existing.data();
        const isPending = data.status === "pending";
        const expMs =
          data.expiresAtTs?.toDate?.()?.getTime?.() ??
          new Date(data.expiresAt).getTime();
        const fresh = Number.isFinite(expMs) && expMs > nowMs;
        if (isPending && fresh) {
          return { alreadyPending: true, cust };
        }
        // Terminal (approved / rejected / expired) OR stale-pending →
        // OVERWRITE with a fresh request. The underlying redemption/offer
        // code freshness was validated above; this branch handles rescan-
        // after-processing (the customer wants to retry after admin rejects,
        // or the previous window silently expired).
      }

      // Fresh create OR overwrite (idempotent on the deterministic id).
      txn.set(requestRef, {
        type,
        code,
        storeId,
        tabletActorUid,
        customerId: custRef.id,
        customerUid: cust.uid || customerUid || custRef.id,
        rewardId: redemptionData.rewardId || null,
        rewardLabel,
        rewardCost,
        redemptionRefPath: redemptionDocRef.path,
        status: "pending",
        requestedAt: nowIso,
        requestedAtTs: FieldValue.serverTimestamp(),
        expiresAt: expiresAtTs.toDate().toISOString(),
        expiresAtTs,
      });
      return { alreadyPending: false, cust };
    });

    const projection = _tabletCustomerProjection(txnResult.cust, _serverTier);
    return {
      requestId,
      alreadyPending: txnResult.alreadyPending,
      type,
      projection,
      rewardLabel,
      rewardCost,
      expiresAt: expiresAtTs.toDate().toISOString(),
    };
}
exports.createRedemptionRequest = onCall(
  { enforceAppCheck: true, region: "europe-west1" },
  _createRedemptionRequestHandler
);

// lookupCustomerForTablet(query)
//   - Tablet-only. Exact-match lookup by card ('IP-XXXXXX') or phone (digits).
//   - Never full-scans. If the query is not a valid card/phone shape, throws.
//   - Returns ONLY the masked projection. No customerId/uid exposed to the
//     tablet — the tablet cannot dereference other customer paths.
async function _lookupCustomerForTabletHandler(request) {
    _requireTablet(request);
    const raw = request.data && request.data.query;
    if (typeof raw !== "string" || !raw.trim()) {
      throw new HttpsError("invalid-argument", "query is required.");
    }
    const q = raw.trim();
    const upper = q.toUpperCase();

    let field = null;
    let value = null;
    if (/^IP-?[A-Z0-9]{6}$/i.test(upper)) {
      field = "card";
      value = upper.startsWith("IP-") ? upper : "IP-" + upper.slice(2);
    } else if (/^\d{7,}$/.test(q)) {
      field = "phone";
      value = q;
    } else {
      throw new HttpsError(
        "invalid-argument",
        "query must be a card (IP-XXXXXX) or phone (7+ digits)."
      );
    }

    const snap = await db
      .collection("ipear_customers")
      .where(field, "==", value)
      .limit(1)
      .get();
    if (snap.empty) {
      return { found: false };
    }
    const cust = snap.docs[0].data();
    if (cust.blocked === true) {
      return { found: true, blocked: true };
    }
    const projection = _tabletCustomerProjection(cust, _serverTier);
    return { found: true, projection };
}
exports.lookupCustomerForTablet = onCall(
  { enforceAppCheck: true, region: "europe-west1" },
  _lookupCustomerForTabletHandler
);

// approveRedemption(requestId)
//   - Admin-only. Requires App Check.
//   - Atomic + idempotent (see deterministic ledger id).
//   - On success: customer.points is adjusted, the underlying redemption is
//     marked used, the ledger row is written with the deterministic id, an
//     audit row is written, and the request is marked 'approved'.
//   - On retry after commit: idempotency guard returns { alreadyProcessed: true }
//     and NEVER re-charges the customer.
async function _approveRedemptionHandler(request) {
    const { uid: approverUid } = _requireAdmin(request);
    const requestId = request.data && request.data.requestId;
    if (typeof requestId !== "string" || !requestId.trim()) {
      throw new HttpsError("invalid-argument", "requestId is required.");
    }

    const requestRef = db.collection("ipear_redemption_requests").doc(requestId);
    const nowIso = new Date().toISOString();

    return await db.runTransaction(async (txn) => {
      const reqSnap = await txn.get(requestRef);
      if (!reqSnap.exists) {
        throw new HttpsError("not-found", "Request not found.");
      }
      const req = reqSnap.data();

      // Idempotency (terminal state).
      if (req.status === "approved") {
        return { alreadyProcessed: true, status: "approved" };
      }
      if (req.status === "rejected") {
        return { alreadyProcessed: true, status: "rejected" };
      }
      if (req.status === "expired") {
        return { alreadyProcessed: true, status: "expired" };
      }
      if (req.status !== "pending") {
        throw new HttpsError("failed-precondition", `Unexpected status: ${req.status}`);
      }

      // TTL guard — mark expired atomically if past deadline.
      const expMs =
        req.expiresAtTs?.toDate?.()?.getTime?.() ??
        new Date(req.expiresAt).getTime();
      if (!Number.isFinite(expMs) || Date.now() > expMs) {
        txn.update(requestRef, {
          status: "expired",
          processedAt: nowIso,
          processedByUid: approverUid,
        });
        return { alreadyProcessed: false, status: "expired" };
      }

      // Deterministic ledger id — the anti-duplication keystone.
      const ledgerId = _ledgerIdForRequest(requestId, req.type);
      const ledgerRef = db.collection("ipear_transactions").doc(ledgerId);
      const ledgerSnap = await txn.get(ledgerRef);
      if (ledgerSnap.exists) {
        // Belt-and-braces: the ledger says this request was already applied.
        // Reconcile the request state and no-op.
        txn.update(requestRef, {
          status: "approved",
          processedAt: nowIso,
          processedByUid: approverUid,
          ledgerId,
        });
        return { alreadyProcessed: true, status: "approved" };
      }

      // L2.3A hotfix: source='card_qr' requests reference a reward doc
      // (ipear_rewards/*), not a redemption/offer_redemption code doc.
      // For those we validate reward.isActive and canonical cost; there is
      // no "used=true" mark to flip (there was no minted code).
      // Every OTHER request came from createRedemptionRequest (6-digit path)
      // and DOES reference a redemption/offer_redemption doc we mark used.
      const isCardSource = req.source === "card_qr";
      const redRef = db.doc(req.redemptionRefPath);
      const redSnap = await txn.get(redRef);
      if (!redSnap.exists) {
        throw new HttpsError("failed-precondition", isCardSource ? "Reward missing." : "Underlying code missing.");
      }
      const red = redSnap.data();
      if (isCardSource) {
        if (red.isActive !== true) {
          throw new HttpsError("failed-precondition", "Reward is not active.");
        }
        const canonicalCost = Number(red.cost) || 0;
        if (canonicalCost !== req.rewardCost) {
          // Canonical cost drifted from what the request captured. Refuse
          // — the request should be re-created against the new cost.
          throw new HttpsError("failed-precondition", "Reward cost changed since the scan.");
        }
      } else {
        if (red.used === true) {
          throw new HttpsError("failed-precondition", "Code already used.");
        }
        if (red.status === "cancelled" || red.status === "rejected") {
          throw new HttpsError("failed-precondition", "Code cancelled or rejected.");
        }
        const redExpMs =
          red.expiresAtTs?.toDate?.()?.getTime?.() ??
          new Date(red.expiresAt).getTime();
        if (!Number.isFinite(redExpMs) || Date.now() > redExpMs) {
          throw new HttpsError("failed-precondition", "Code expired.");
        }
      }

      // Re-fetch the customer.
      let custRef = db.collection("ipear_customers").doc(req.customerId);
      let custSnap = await txn.get(custRef);
      if (!custSnap.exists && req.customerUid && req.customerUid !== req.customerId) {
        custRef = db.collection("ipear_customers").doc(req.customerUid);
        custSnap = await txn.get(custRef);
      }
      if (!custSnap.exists) {
        throw new HttpsError("failed-precondition", "Customer not found.");
      }
      const cust = custSnap.data();
      if (cust.blocked === true) {
        throw new HttpsError("failed-precondition", "Customer is blocked.");
      }

      // For redeem: rewardCost is positive (subtract). For offer_credit:
      // rewardCost is negative (add its absolute value to customer.points
      // AND to totalPoints).
      const cost = Number(req.rewardCost || 0);
      let newPoints = Number(cust.points || 0);
      let newTotalPoints = Number(cust.totalPoints || newPoints);
      let ledgerType, ledgerPointsDelta;
      if (req.type === "redeem") {
        if (!Number.isInteger(cost) || cost <= 0) {
          throw new HttpsError("failed-precondition", "Invalid reward cost.");
        }
        if (newPoints < cost) {
          throw new HttpsError("failed-precondition", "Insufficient balance.");
        }
        newPoints = Math.max(0, newPoints - cost);
        ledgerType = "redeem";
        ledgerPointsDelta = -cost;
      } else if (req.type === "offer_credit") {
        // SEC-H1: the credited amount MUST be derived from the authoritative
        // ipear_offers doc — never from the customer-created offer_redemption
        // or the request-captured rewardCost (a customer can mint an
        // offer_redemption with a real offerId but an inflated bonusPoints up
        // to the rules cap of 2500). Re-read the offer inside the transaction
        // and reject on any mismatch (fail-closed, same as reward cost-drift).
        // `red` is the offer_redemption doc (non-card path). offerId normally
        // holds the offer doc id, with a legacy fallback to the offer title.
        const offerId = (red && red.offerId) || null;
        let offerData = null;
        if (offerId) {
          const offerSnap = await txn.get(db.collection("ipear_offers").doc(offerId));
          if (offerSnap.exists) {
            offerData = offerSnap.data();
          } else {
            const offerQ = await txn.get(
              db.collection("ipear_offers").where("title", "==", offerId).limit(1),
            );
            if (!offerQ.empty) offerData = offerQ.docs[0].data();
          }
        }
        const decision = canonicalOfferCredit(offerData, req.rewardCost);
        if (!decision.ok) {
          throw new HttpsError(
            "failed-precondition",
            decision.reason === "value-mismatch"
              ? "Offer value changed since the scan — please re-scan."
              : "Offer not eligible.",
          );
        }
        const bonus = decision.canonicalBonus; // server-derived, authoritative
        newPoints = newPoints + bonus;
        newTotalPoints = newTotalPoints + bonus;
        ledgerType = "add";
        ledgerPointsDelta = bonus;
      } else {
        throw new HttpsError("failed-precondition", `Unknown request type: ${req.type}`);
      }

      // Atomic writes.
      txn.update(custRef, {
        points: newPoints,
        totalPoints: newTotalPoints,
      });
      if (!isCardSource) {
        // For 6-digit / offer code requests, mark the underlying doc used.
        // For card_qr requests, the target is a reward doc — leave it alone.
        txn.update(redRef, {
          used: true,
          status: "used",
          usedAt: nowIso,
        });
      }
      txn.set(ledgerRef, {
        customerId: custRef.id,
        customerUid: cust.uid || req.customerUid || custRef.id,
        customerEmail: cust.email || "",
        customerName: cust.name || "",
        card: cust.card || "",
        type: ledgerType,
        points: ledgerPointsDelta,
        discount: req.type === "redeem" ? Number(red.discount || 0) : 0,
        label: req.rewardLabel || "",
        method: req.type === "redeem" ? "qr" : "offer",
        storeId: req.storeId || null,
        storeName: null,
        date: nowIso,
        approvedByAdmin: approverUid,
        approvedByTablet: req.tabletActorUid || null,
        requestId,
      });
      const auditRef = db
        .collection("audit_logs")
        .doc(`${ledgerType}_${requestId}`);
      txn.set(auditRef, {
        action: req.type === "redeem" ? "redeem_approved" : "offer_credit_approved",
        source: "tablet_via_admin",
        approverUid,
        tabletActorUid: req.tabletActorUid || null,
        storeId: req.storeId || null,
        approvedAt: nowIso,
        customerId: custRef.id,
        customerUid: cust.uid || req.customerUid || custRef.id,
        requestId,
        code: req.code,
        pointsDelta: ledgerPointsDelta,
      });
      txn.update(requestRef, {
        status: "approved",
        processedAt: nowIso,
        processedByUid: approverUid,
        ledgerId,
        newPoints,
      });

      return {
        alreadyProcessed: false,
        status: "approved",
        newPoints,
        ledgerId,
      };
    });
}
exports.approveRedemption = onCall(
  { enforceAppCheck: true, region: "europe-west1" },
  _approveRedemptionHandler
);

// ───────────────────────────────────────────────────────────────────────────
//  ADMIN FORTRESS Stage 1 — adminAdjustPoints (server-authoritative manual
//  point mutation). Replaces the admin browser's direct Firestore writes for
//  manual add / subtract / correct. The client submits an INTENT only; the
//  server resolves the customer, reads the authoritative balance, validates the
//  amount + limit, computes the result, enforces idempotency (deterministic
//  ledger id), and writes the ledger + immutable `admin_audit` row atomically.
//
//  Auth: Firebase auth + admin claim + OWNER_UIDS allowlist + App Check
//  (enforced by onCall) + fail-safe financial kill switch. Fail-closed.
// ───────────────────────────────────────────────────────────────────────────
async function _adminAdjustPointsHandler(request) {
  // 1–4: auth, admin claim, owner allowlist (App Check enforced by onCall).
  const { uid: actorUid } = _requireOwner(request, "adminAdjustPoints");

  // Fail-safe kill switch (AF-12 placeholder; disabled by default).
  if (_financialActionsDisabled()) {
    _securityEvent("financial_killswitch_denied", { op: "adminAdjustPoints", uid: actorUid });
    throw new HttpsError("failed-precondition", "Financial actions are temporarily disabled.");
  }

  // 5: validate the intent schema (never trusts newBalance/role/actor/ts).
  const parsed = validateAdjustInput(request.data);
  if (!parsed.ok) {
    _securityEvent("adjust_input_rejected", { uid: actorUid, reason: parsed.reason });
    throw new HttpsError("invalid-argument", `Invalid adjustment: ${parsed.reason}`);
  }
  const input = parsed.value;

  // Large-mutation signal for future alerting (still within the hard cap).
  if (Math.abs(input.amount) >= 5000) {
    _securityEvent("large_adjustment", {
      uid: actorUid, customerId: input.customerId, amount: input.amount, operation: input.operation,
    });
  }

  return _commitAdjustment(input, actorUid);
}

// Shared commit for owner-gated point adjustments — used by manual
// add/subtract/correct AND by server-fixed credits (e.g. birthday). Resolves
// the customer + balance server-side, enforces idempotency (deterministic
// ledger id), and writes the ledger + immutable audit row atomically.
// `input` MUST already be schema-validated by the caller.
async function _commitAdjustment(input, actorUid) {
  const nowIso = new Date().toISOString();
  const custRef = db.collection("ipear_customers").doc(input.customerId);
  const ledgerRef = db.collection("ipear_transactions").doc(ledgerIdForKey(input.idempotencyKey));
  const auditRef = db.collection("admin_audit").doc(auditIdForKey(input.idempotencyKey));
  try {
    const result = await db.runTransaction(async (txn) => {
      const custSnap = await txn.get(custRef);
      const ledgerSnap = await txn.get(ledgerRef);
      const cust = custSnap.exists ? (custSnap.data() || {}) : {};
      const plan = planAdjustment(
        {
          exists: custSnap.exists,
          blocked: cust.blocked === true,
          points: cust.points,
          totalPoints: cust.totalPoints,
          customer: { uid: cust.uid, email: cust.email, name: cust.name, card: cust.card },
        },
        ledgerSnap.exists ? (ledgerSnap.data() || {}) : null,
        input,
        { actorUid, storeId: null, storeName: null, nowIso },
      );
      if (!plan.ok) return { _deny: true, code: plan.code, reason: plan.reason };
      if (plan.idempotent) return { idempotent: true, newPoints: plan.newPoints, ledgerId: ledgerRef.id };
      txn.update(custRef, plan.customerUpdate);
      txn.set(ledgerRef, plan.ledger);
      txn.set(auditRef, { ...plan.audit, serverTimestamp: FieldValue.serverTimestamp() });
      return { idempotent: false, newPoints: plan.after, ledgerId: ledgerRef.id };
    });
    if (result && result._deny) {
      _securityEvent("adjust_denied", { uid: actorUid, customerId: input.customerId, reason: result.reason });
      throw new HttpsError(result.code || "failed-precondition", `Adjustment rejected: ${result.reason}`);
    }
    return { ok: true, idempotent: !!result.idempotent, newPoints: result.newPoints, ledgerId: result.ledgerId };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    _securityEvent("adjust_error", { uid: actorUid, customerId: input.customerId, code: e && e.code });
    throw new HttpsError("internal", "Adjustment failed.");
  }
}

// ───────────────────────────────────────────────────────────────────────────
//  ADMIN FORTRESS Stage 2 — adminBirthdayCredit (server-authoritative).
//  Server fixes the reward amount AND the annual idempotency key; the browser
//  cannot alter the amount or the award year. Same customer + same year → at
//  most one credit (deterministic ledger id). Owner-gated + App Check + kill
//  switch. Birthday eligibility/policy is unchanged — the admin UI still decides
//  WHEN to offer it; the server owns the financial effect.
// ───────────────────────────────────────────────────────────────────────────
const BIRTHDAY_BONUS = 200;
async function _adminBirthdayCreditHandler(request) {
  const { uid: actorUid } = _requireOwner(request, "adminBirthdayCredit");
  if (_financialActionsDisabled()) {
    _securityEvent("financial_killswitch_denied", { op: "adminBirthdayCredit", uid: actorUid });
    throw new HttpsError("failed-precondition", "Financial actions are temporarily disabled.");
  }
  const raw = request.data && request.data.customerId;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 200) {
    throw new HttpsError("invalid-argument", "customerId required.");
  }
  const customerId = raw.trim();
  const year = new Date().getFullYear();
  const input = {
    customerId,
    operation: "add",
    amount: BIRTHDAY_BONUS, // server-fixed — never from the client
    reason: `Δώρο γενεθλίων ${year}`,
    idempotencyKey: `birthday_${customerId}_${year}`, // server-derived annual key
  };
  return _commitAdjustment(input, actorUid);
}
exports.adminBirthdayCredit = onCall(
  { enforceAppCheck: true, region: "europe-west1" },
  _adminBirthdayCreditHandler
);

// ───────────────────────────────────────────────────────────────────────────
//  ADMIN FORTRESS Stage 2 — adminVerifyRedemption (server-authoritative replacement
//  for the admin 6-digit code-verify browser flow, src/admin/redemption-verify.js).
//  The browser submits ONLY the code; the server resolves the code, the
//  reward/offer, the customer, and the authoritative amount, then debits/credits
//  atomically. Reward cost = catalog-trusted (ipear_rewards); offer credit =
//  canonical offer value (shared canonicalOfferValue → H1-safe). Idempotency is
//  tied to the redemption doc id (deterministic ledger id) + the `used` flag.
//  Owner-gated + App Check + fail-safe kill switch. Fail-closed.
// ───────────────────────────────────────────────────────────────────────────
async function _adminVerifyRedemptionHandler(request) {
  const { uid: actorUid } = _requireOwner(request, "adminVerifyRedemption");
  if (_financialActionsDisabled()) {
    _securityEvent("financial_killswitch_denied", { op: "adminVerifyRedemption", uid: actorUid });
    throw new HttpsError("failed-precondition", "Financial actions are temporarily disabled.");
  }
  const code = request.data && request.data.code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new HttpsError("invalid-argument", "code must be a 6-digit string.");
  }

  // Resolve the code to a redemption doc + type (reward first, then offer) —
  // the client cannot choose the target customer or operation.
  let kind = null, redId = null;
  const rq = await db.collection("ipear_redemptions").where("code", "==", code).limit(1).get();
  if (!rq.empty) { kind = "reward"; redId = rq.docs[0].id; }
  else {
    const oq = await db.collection("ipear_offer_redemptions").where("code", "==", code).limit(1).get();
    if (!oq.empty) { kind = "offer"; redId = oq.docs[0].id; }
  }
  if (!kind) {
    _securityEvent("verify_denied", { uid: actorUid, reason: "code-not-found" });
    throw new HttpsError("not-found", "Invalid or expired code.");
  }

  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const col = kind === "reward" ? "ipear_redemptions" : "ipear_offer_redemptions";
  const redRef = db.collection(col).doc(redId);
  const ledgerRef = db.collection("ipear_transactions")
    .doc(kind === "reward" ? `redeem_verify_${redId}` : `offer_verify_${redId}`);
  const auditRef = db.collection("admin_audit").doc(`verify_${redId}`);
  const ctx = { actorUid, nowIso, nowMs, storeId: null, storeName: null, redemptionId: redId, code };

  try {
    const result = await db.runTransaction(async (txn) => {
      // ── reads first ──
      const redSnap = await txn.get(redRef);
      const ledgerSnap = await txn.get(ledgerRef);
      if (!redSnap.exists) return { _deny: true, code: "not-found", reason: "code-not-found" };
      const redemption = redSnap.data() || {};

      // Resolve customer: customerId → customerUid/customerDocId fallback.
      let customerId = redemption.customerId || null;
      let custSnap = customerId ? await txn.get(db.collection("ipear_customers").doc(customerId)) : null;
      if ((!custSnap || !custSnap.exists)) {
        const alt = redemption.customerUid || redemption.customerDocId;
        if (alt && alt !== customerId) { customerId = alt; custSnap = await txn.get(db.collection("ipear_customers").doc(alt)); }
      }
      const customer = custSnap && custSnap.exists ? (custSnap.data() || {}) : null;
      const existingLedger = ledgerSnap.exists ? (ledgerSnap.data() || {}) : null;

      let plan;
      if (kind === "reward") {
        let reward = null;
        if (redemption.rewardId) {
          const rs = await txn.get(db.collection("ipear_rewards").doc(redemption.rewardId));
          reward = rs.exists ? (rs.data() || {}) : null;
        }
        plan = planRewardRedeem(redemption, reward, customer, customerId, existingLedger, ctx);
      } else {
        let offer = null;
        if (redemption.offerId) {
          const os = await txn.get(db.collection("ipear_offers").doc(redemption.offerId));
          offer = os.exists ? (os.data() || {}) : null;
        }
        plan = planOfferRedeem(redemption, offer, customer, customerId, existingLedger, ctx);
      }

      if (!plan.ok) return { _deny: true, code: plan.code, reason: plan.reason };
      if (plan.idempotent) return { idempotent: true, newPoints: (customer && customer.points) ?? null, ledgerId: ledgerRef.id };

      // ── writes after ──
      txn.update(redRef, plan.redemptionUpdate);
      txn.update(db.collection("ipear_customers").doc(customerId), plan.customerUpdate);
      txn.set(ledgerRef, plan.ledger);
      txn.set(auditRef, { ...plan.audit, serverTimestamp: FieldValue.serverTimestamp() });
      return { idempotent: false, kind: plan.kind, amount: plan.amount, newPoints: plan.after, ledgerId: ledgerRef.id };
    });

    if (result && result._deny) {
      _securityEvent("verify_denied", { uid: actorUid, redemptionId: redId, reason: result.reason });
      // Generic external message — no customer-existence leakage.
      const msg = result.reason === "insufficient-balance" ? "Insufficient points."
        : result.code === "not-found" ? "Invalid or expired code."
        : "Redemption rejected.";
      throw new HttpsError(result.code || "failed-precondition", msg);
    }
    return { ok: true, kind: result.kind, amount: result.amount, newPoints: result.newPoints, ledgerId: result.ledgerId, idempotent: !!result.idempotent };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    _securityEvent("verify_error", { uid: actorUid, redemptionId: redId, code: e && e.code });
    throw new HttpsError("internal", "Redemption failed.");
  }
}
exports.adminVerifyRedemption = onCall(
  { enforceAppCheck: true, region: "europe-west1" },
  _adminVerifyRedemptionHandler
);

exports.adminAdjustPoints = onCall(
  { enforceAppCheck: true, region: "europe-west1" },
  _adminAdjustPointsHandler
);

// ───────────────────────────────────────────────────────────────────────────
//  ADMIN FORTRESS Stage 2 — adminBatchMaintenance (server-authoritative batch).
//  Handles point EXPIRE and TIER_DOWNGRADE. The browser sends only the op + a
//  bounded list of customerIds (the admin's reviewed selection); the server
//  reads each customer's authoritative balance, computes the delta (expire →
//  zero; tier_downgrade → canonical-ladder target), and writes customer +
//  ledger + immutable audit per item in a transaction. Deterministic per-item
//  ids make every item idempotent (re-run / concurrent → one mutation each).
//  Owner-gated + App Check + fail-safe kill switch. Fail-closed per item.
// ───────────────────────────────────────────────────────────────────────────
async function _adminBatchMaintenanceHandler(request) {
  const { uid: actorUid } = _requireOwner(request, "adminBatchMaintenance");
  if (_financialActionsDisabled()) {
    _securityEvent("financial_killswitch_denied", { op: "adminBatchMaintenance", uid: actorUid });
    throw new HttpsError("failed-precondition", "Financial actions are temporarily disabled.");
  }
  const data = request.data || {};
  const op = data.op;
  const ids = Array.isArray(data.customerIds) ? data.customerIds : null;
  if (!MAINT_OPS.has(op)) throw new HttpsError("invalid-argument", "Unknown maintenance op.");
  if (!ids || ids.length === 0) throw new HttpsError("invalid-argument", "customerIds required.");
  if (ids.length > MAX_BATCH) throw new HttpsError("invalid-argument", `Batch too large (max ${MAX_BATCH}).`);
  for (const id of ids) {
    if (typeof id !== "string" || !id.trim() || id.length > 200) {
      throw new HttpsError("invalid-argument", "Malformed customerId in batch.");
    }
  }
  _securityEvent("batch_maintenance", { uid: actorUid, op, count: ids.length });

  const year = new Date().getFullYear();
  const nowIso = new Date().toISOString();
  let applied = 0, idempotent = 0, skipped = 0, failed = 0;
  const outcomes = [];

  // Per-item transaction so a bad/ineligible item never aborts the whole batch
  // (fail-closed per item); deterministic ids keep each item idempotent.
  for (const customerId of ids) {
    const custRef = db.collection("ipear_customers").doc(customerId);
    const ledgerRef = db.collection("ipear_transactions").doc(maintLedgerId(op, customerId, year));
    const auditRef = db.collection("admin_audit").doc(`${op}_${customerId}_${year}`);
    try {
      const r = await db.runTransaction(async (txn) => {
        const custSnap = await txn.get(custRef);
        const ledgerSnap = await txn.get(ledgerRef);
        const cust = custSnap.exists ? (custSnap.data() || {}) : {};
        const plan = planMaintenance(
          op, customerId,
          { exists: custSnap.exists, points: cust.points, totalPoints: cust.totalPoints,
            customer: { uid: cust.uid, email: cust.email, name: cust.name, card: cust.card } },
          ledgerSnap.exists ? (ledgerSnap.data() || {}) : null,
          { actorUid, year, nowIso, storeId: null, storeName: null },
        );
        if (!plan.ok) return { kind: plan.reason === "nothing-to-expire" || plan.reason === "not-eligible-bronze" || plan.reason === "no-downgrade" ? "skip" : "deny", reason: plan.reason };
        if (plan.idempotent) return { kind: "idempotent" };
        txn.update(custRef, plan.customerUpdate);
        txn.set(ledgerRef, plan.ledger);
        txn.set(auditRef, { ...plan.audit, serverTimestamp: FieldValue.serverTimestamp() });
        return { kind: "applied" };
      });
      if (r.kind === "applied") applied++;
      else if (r.kind === "idempotent") idempotent++;
      else if (r.kind === "skip") skipped++;
      else { failed++; }
      outcomes.push({ kind: r.kind, reason: r.reason });
    } catch (e) {
      failed++;
      outcomes.push({ kind: "error", code: e && e.code });
      _securityEvent("batch_item_error", { uid: actorUid, op, code: e && e.code });
    }
  }
  return { ok: true, op, total: ids.length, applied, idempotent, skipped, failed };
}
exports.adminBatchMaintenance = onCall(
  { enforceAppCheck: true, region: "europe-west1" },
  _adminBatchMaintenanceHandler
);

// rejectRedemption(requestId, reason)
//   - Admin-only. Requires App Check.
//   - Marks request 'rejected' with audit. No balance change.
//   - Idempotent: rejecting an already-terminal request is a no-op.
async function _rejectRedemptionHandler(request) {
    const { uid: approverUid } = _requireAdmin(request);
    const requestId = request.data && request.data.requestId;
    if (typeof requestId !== "string" || !requestId.trim()) {
      throw new HttpsError("invalid-argument", "requestId is required.");
    }
    const reason =
      typeof request.data.reason === "string" ? request.data.reason.slice(0, 200) : "";

    const requestRef = db.collection("ipear_redemption_requests").doc(requestId);
    const nowIso = new Date().toISOString();

    return await db.runTransaction(async (txn) => {
      const reqSnap = await txn.get(requestRef);
      if (!reqSnap.exists) {
        throw new HttpsError("not-found", "Request not found.");
      }
      const req = reqSnap.data();

      // Idempotency (terminal state).
      if (req.status !== "pending") {
        return { alreadyProcessed: true, status: req.status };
      }

      txn.update(requestRef, {
        status: "rejected",
        processedAt: nowIso,
        processedByUid: approverUid,
        rejectReason: reason || "",
      });
      const auditRef = db
        .collection("audit_logs")
        .doc(`reject_${requestId}`);
      txn.set(auditRef, {
        action: "redemption_rejected",
        source: "tablet_via_admin",
        approverUid,
        tabletActorUid: req.tabletActorUid || null,
        storeId: req.storeId || null,
        rejectedAt: nowIso,
        customerId: req.customerId,
        customerUid: req.customerUid,
        requestId,
        code: req.code,
        rejectReason: reason || "",
      });

      return { alreadyProcessed: false, status: "rejected" };
    });
}
exports.rejectRedemption = onCall(
  { enforceAppCheck: true, region: "europe-west1" },
  _rejectRedemptionHandler
);

// ══════════════════════════════════════════════════════════════════════════
//  L2.3A HOTFIX (2026-08-31) — Customer loyalty-card QR support.
//
//  The customer's Card-tab QR (src/customer/ui/misc-ui.js:22) encodes the
//  raw card string (e.g. "IP-ABC123"), not a 6-digit code. The L2.3A rewrite
//  of tablet-main + createRedemptionRequest broke that flow by only
//  accepting `^\d{6}$` payloads. This hotfix adds TWO new callables that
//  preserve the card-QR scan path AND keep every L2.3A security invariant:
//  no direct customer reads from the tablet, canonical reward cost from the
//  server, deterministic-idempotent request creation, masked-only projection.
// ══════════════════════════════════════════════════════════════════════════
const _CARD_QR_RE = /^IP-[A-Z0-9]{6}$/;
const _MAX_QR_PAYLOAD_LEN = 32;

// Validate + normalize the payload the tablet passes. The customer QR
// literally IS the card string; we tolerate lowercase + whitespace but
// enforce the canonical `^IP-[A-Z0-9]{6}$` shape after normalization.
function _normalizeCardQr(payload) {
  if (typeof payload !== "string") return null;
  if (payload.length > _MAX_QR_PAYLOAD_LEN) return null;
  const norm = payload.trim().toUpperCase();
  if (!_CARD_QR_RE.test(norm)) return null;
  return norm;
}

// Deterministic id for a card-path pending request.
function _deterministicCardRequestId(storeId, tabletActorUid, cardQr, rewardId) {
  const raw = `card|${storeId}|${tabletActorUid}|${cardQr}|${rewardId}`;
  return "req_" + createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

// Load active rewards catalog from Firestore (canonical cost + discount).
async function _fetchActiveRewards() {
  const snap = await db
    .collection("ipear_rewards")
    .where("isActive", "==", true)
    .get();
  const rows = [];
  snap.forEach((d) => {
    const data = d.data();
    rows.push({
      id: d.id,
      title: String(data.title || ""),
      cost: Number(data.cost) || 0,
      discount: Number(data.discount) || 0,
      order: Number(data.order) || 0,
    });
  });
  rows.sort((a, b) => a.order - b.order || a.cost - b.cost);
  return rows;
}

// lookupCustomerByCardQr(payload)
//   - Tablet-only. Requires App Check.
//   - Validates payload, exact server lookup by card, returns masked
//     projection + active rewards (canonical cost/discount).
//   - Never returns email, birthday, referral, UID, phone full string.
//   - Rate-limited to reuse the tablet scan counter (same 20/min budget).
async function _lookupCustomerByCardQrHandler(request) {
  const { uid: tabletActorUid } = _requireTablet(request);
  const raw = request.data && request.data.cardQrPayload;
  const card = _normalizeCardQr(raw);
  if (!card) {
    throw new HttpsError("invalid-argument", "cardQrPayload must match IP-[A-Z0-9]{6}");
  }

  // Reuse the createRedemptionRequest rate limiter — a scan is a scan.
  const rateRef = db.collection("_ratelimits_tablet").doc(tabletActorUid);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(rateRef);
    const now = Date.now();
    const windowMs = 60_000;
    const maxHits = 20;
    let bucket = snap.exists ? snap.data() : { windowStart: now, hits: 0 };
    if (now - (bucket.windowStart || 0) > windowMs) {
      bucket = { windowStart: now, hits: 0 };
    }
    bucket.hits = (bucket.hits || 0) + 1;
    if (bucket.hits > maxHits) {
      throw new HttpsError("resource-exhausted", "Too many scans — wait a minute.");
    }
    txn.set(rateRef, bucket);
  });

  const snap = await db
    .collection("ipear_customers")
    .where("card", "==", card)
    .limit(1)
    .get();
  if (snap.empty) return { found: false };
  const cust = snap.docs[0].data();
  if (cust.blocked === true) return { found: true, blocked: true };
  const projection = _tabletCustomerProjection(cust, _serverTier);
  const rewards = await _fetchActiveRewards();
  return { found: true, projection, rewards };
}
exports.lookupCustomerByCardQr = onCall(
  { enforceAppCheck: true, region: "europe-west1" },
  _lookupCustomerByCardQrHandler
);

// createRedemptionRequestFromCard({cardQrPayload, rewardId})
//   - Tablet-only. Requires App Check.
//   - Server re-resolves customer + reward. Canonical cost from server.
//     The tablet does NOT send the points cost — it sends only the reward id.
//   - Deterministic idempotency: hash(store|actor|card|rewardId).
//   - Blocks: blocked customer, inactive/missing reward, insufficient balance.
async function _createRedemptionRequestFromCardHandler(request) {
  const { uid: tabletActorUid, storeId } = _requireTablet(request);
  const raw = request.data && request.data.cardQrPayload;
  const card = _normalizeCardQr(raw);
  const rewardId = request.data && request.data.rewardId;
  if (!card) {
    throw new HttpsError("invalid-argument", "cardQrPayload must match IP-[A-Z0-9]{6}");
  }
  if (typeof rewardId !== "string" || !rewardId.trim() || rewardId.length > 128) {
    throw new HttpsError("invalid-argument", "rewardId is required.");
  }

  // Rate limit (reuse same tablet counter).
  const rateRef = db.collection("_ratelimits_tablet").doc(tabletActorUid);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(rateRef);
    const now = Date.now();
    const windowMs = 60_000;
    const maxHits = 20;
    let bucket = snap.exists ? snap.data() : { windowStart: now, hits: 0 };
    if (now - (bucket.windowStart || 0) > windowMs) {
      bucket = { windowStart: now, hits: 0 };
    }
    bucket.hits = (bucket.hits || 0) + 1;
    if (bucket.hits > maxHits) {
      throw new HttpsError("resource-exhausted", "Too many scans — wait a minute.");
    }
    txn.set(rateRef, bucket);
  });

  // Resolve customer.
  const custQ = await db
    .collection("ipear_customers")
    .where("card", "==", card)
    .limit(1)
    .get();
  if (custQ.empty) throw new HttpsError("not-found", "Customer not found.");
  const custRef = custQ.docs[0].ref;
  const custPre = custQ.docs[0].data();
  if (custPre.blocked === true) {
    throw new HttpsError("failed-precondition", "Customer is blocked.");
  }

  // Resolve reward — CANONICAL cost/discount from server. Any client-side
  // `cost` in the request is ignored (never even accepted as input).
  const rewardRef = db.collection("ipear_rewards").doc(rewardId);
  const rewardPre = await rewardRef.get();
  if (!rewardPre.exists) throw new HttpsError("not-found", "Reward not found.");
  const rewardData = rewardPre.data();
  if (rewardData.isActive !== true) {
    throw new HttpsError("failed-precondition", "Reward is not active.");
  }
  const rewardCost = Number(rewardData.cost) || 0;
  const rewardLabel = String(rewardData.title || "");
  if (!Number.isInteger(rewardCost) || rewardCost <= 0) {
    throw new HttpsError("failed-precondition", "Invalid reward cost.");
  }
  if ((custPre.points || 0) < rewardCost) {
    throw new HttpsError("failed-precondition", "Insufficient balance.");
  }

  // Deterministic id for this scan (store+tablet+card+reward) — two rapid
  // taps by the same cashier for the same reward return the same request.
  const requestId = _deterministicCardRequestId(storeId, tabletActorUid, card, rewardId);
  const requestRef = db.collection("ipear_redemption_requests").doc(requestId);
  const nowMs = Date.now();
  const expiresAtTs = Timestamp.fromMillis(nowMs + 5 * 60 * 1000);
  const nowIso = new Date(nowMs).toISOString();

  const txnResult = await db.runTransaction(async (txn) => {
    const existing = await txn.get(requestRef);
    const custTxnSnap = await txn.get(custRef);
    if (!custTxnSnap.exists) throw new HttpsError("not-found", "Customer not found.");
    const cust = custTxnSnap.data();
    if (cust.blocked === true) {
      throw new HttpsError("failed-precondition", "Customer is blocked.");
    }
    if ((cust.points || 0) < rewardCost) {
      throw new HttpsError("failed-precondition", "Insufficient balance.");
    }

    if (existing.exists) {
      const data = existing.data();
      const isPending = data.status === "pending";
      const expMs =
        data.expiresAtTs?.toDate?.()?.getTime?.() ??
        new Date(data.expiresAt).getTime();
      const fresh = Number.isFinite(expMs) && expMs > nowMs;
      if (isPending && fresh) {
        return { alreadyPending: true, cust };
      }
    }
    txn.set(requestRef, {
      type: "redeem",
      code: card,                  // NB: uses card string, not a 6-digit code
      source: "card_qr",           // distinguishes from redemption-code flow
      storeId,
      tabletActorUid,
      customerId: custRef.id,
      customerUid: cust.uid || custRef.id,
      rewardId,
      rewardLabel,
      rewardCost,
      redemptionRefPath: rewardRef.path,  // reward doc, not a redemption doc
      status: "pending",
      requestedAt: nowIso,
      requestedAtTs: FieldValue.serverTimestamp(),
      expiresAt: expiresAtTs.toDate().toISOString(),
      expiresAtTs,
    });
    return { alreadyPending: false, cust };
  });

  return {
    requestId,
    alreadyPending: txnResult.alreadyPending,
    type: "redeem",
    projection: _tabletCustomerProjection(txnResult.cust, _serverTier),
    rewardLabel,
    rewardCost,
    expiresAt: expiresAtTs.toDate().toISOString(),
  };
}
exports.createRedemptionRequestFromCard = onCall(
  { enforceAppCheck: true, region: "europe-west1" },
  _createRedemptionRequestFromCardHandler
);

// ───────────────────────────────────────────────────────────────────────────
//  ADMIN FORTRESS Stage 2 — adminDeleteCustomer (server-authoritative customer
//  lifecycle). Owner-gated + App Check + fail-closed. Replaces the browser
//  delete cascade in src/admin/customers-crud.js.
//
//  INVARIANT: customer deletion MUST NOT destroy financial evidence.
//    • ipear_transactions / ipear_(offer_)redemptions → ANONYMIZE PII in place,
//      RETAIN immutable financial facts (points/type/delta/date/source/ids).
//      This is the ONLY server path that updates existing ledger rows — the
//      single documented, owner-gated, audited exception to append-only.
//    • ipear_customers (+orphans) / ipear_referral_queue → DELETE (PII / transient).
//    • ipear_redemption_requests / ipear_birthday_claims / audit_logs → ANONYMIZE.
//    • admin_audit → never touched (append-only); only the completion event added.
//    • Firebase Auth user(s) → DELETE (Admin SDK; user-not-found == success).
//
//  Idempotent + resumable: the deterministic lifecycle id names the admin_audit
//  COMPLETION doc. The customer docs are deleted LAST, just before the audit is
//  written, and the audit stores the target ids — so a retry after the audit
//  exists simply re-runs the (idempotent) customer-doc deletion tail. All
//  anonymization steps are no-ops once a row carries the tombstone. A retry
//  therefore never restores PII, never deletes financial evidence, never
//  duplicates the audit, and never corrupts loyalty state.
// ───────────────────────────────────────────────────────────────────────────
async function _deleteCustomerDocs(ids) {
  for (const id of ids) {
    try { await db.collection("ipear_customers").doc(id).delete(); }
    catch (_) { /* idempotent — already gone */ }
  }
}

// Anonymize every row of `coll` matching `field == value`. Idempotent (skips
// rows already tombstoned). Returns {seen, anonymized}.
async function _anonymizeLedgerByQuery(coll, field, value, tombstone, nowIso) {
  let seen = 0, anonymized = 0;
  const snap = await db.collection(coll).where(field, "==", value).get();
  for (const d of snap.docs) {
    seen++;
    const upd = planLedgerAnonymization(d.data(), tombstone, nowIso);
    if (upd) { await d.ref.update(upd); anonymized++; }
  }
  return { seen, anonymized };
}

async function _deleteByQuery(coll, field, value) {
  let deleted = 0;
  const snap = await db.collection(coll).where(field, "==", value).get();
  for (const d of snap.docs) { try { await d.ref.delete(); deleted++; } catch (_) {} }
  return deleted;
}

async function _adminDeleteCustomerHandler(request) {
  // 1–4: auth, admin claim, owner allowlist (App Check enforced by onCall).
  const { uid: actorUid } = _requireOwner(request, "adminDeleteCustomer");

  // Strict input validation — the browser submits ONLY the deletion intent.
  const raw = request.data && request.data.customerId;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 200) {
    throw new HttpsError("invalid-argument", "customerId required.");
  }
  const customerId = raw.trim();
  const idemRaw = request.data && request.data.idempotencyKey;
  const idempotencyKey =
    (typeof idemRaw === "string" && idemRaw.trim() && idemRaw.length <= 200) ? idemRaw.trim() : null;

  const lid = lifecycleId(customerId, idempotencyKey);
  const auditRef = db.collection("admin_audit").doc(lid);
  const nowIso = new Date().toISOString();

  try {
    // Fast path / resume tail: the completion audit already exists → steps
    // A–F are proven done; just (re)run the idempotent customer-doc deletion.
    const existingAudit = await auditRef.get();
    if (existingAudit.exists) {
      const a = existingAudit.data() || {};
      const ids = Array.isArray(a.targetCustomerIds) && a.targetCustomerIds.length
        ? a.targetCustomerIds : [customerId];
      await _deleteCustomerDocs(ids);
      _securityEvent("lifecycle_idempotent", { uid: actorUid, customerId, lifecycleId: lid });
      return { ok: true, idempotent: true, tombstone: a.tombstone || null, lifecycleId: lid };
    }

    // Server-side identity resolution (never trust the browser for this).
    const primarySnap = await db.collection("ipear_customers").doc(customerId).get();
    if (!primarySnap.exists) {
      // No doc + no audit: nonexistent, or a prior run already deleted the doc
      // but crashed before auditing. No identifiers remain to safely continue,
      // so this is a no-op (no financial evidence can be at risk here).
      _securityEvent("lifecycle_noop_missing", { uid: actorUid, customerId, lifecycleId: lid });
      return { ok: true, idempotent: true, notFound: true, lifecycleId: lid };
    }
    const pdata = primarySnap.data() || {};
    const uids = new Set();
    if (pdata.uid) uids.add(pdata.uid);
    const email = (pdata.email || "").toLowerCase();
    const phone = pdata.phone || "";
    const card = pdata.card || "";
    const custIds = new Set([customerId]);

    // Orphan discovery: other ipear_customers docs sharing phone/email/card.
    for (const [field, val] of [["phone", phone], ["email", email], ["card", card]]) {
      if (!val) continue;
      const q = await db.collection("ipear_customers").where(field, "==", val).get();
      q.forEach((d) => {
        custIds.add(d.id);
        const od = d.data() || {};
        if (od.uid) uids.add(od.uid);
      });
    }
    const tombstone = tombstoneId(pdata.uid || customerId);

    // ── Step A: anonymize the FINANCIAL LEDGER (retain evidence) ────────────
    let ledgerSeen = 0, ledgerAnon = 0;
    for (const cid of custIds) {
      const r = await _anonymizeLedgerByQuery("ipear_transactions", "customerId", cid, tombstone, nowIso);
      ledgerSeen += r.seen; ledgerAnon += r.anonymized;
    }
    for (const u of uids) {
      const r = await _anonymizeLedgerByQuery("ipear_transactions", "customerUid", u, tombstone, nowIso);
      ledgerSeen += r.seen; ledgerAnon += r.anonymized;
    }
    if (email) {
      const r = await _anonymizeLedgerByQuery("ipear_transactions", "customerEmail", email, tombstone, nowIso);
      ledgerSeen += r.seen; ledgerAnon += r.anonymized;
    }

    // ── Step B: anonymize REDEMPTION financial evidence (retain) ────────────
    for (const u of uids) {
      await _anonymizeLedgerByQuery("ipear_offer_redemptions", "customerId", u, tombstone, nowIso);
      await _anonymizeLedgerByQuery("ipear_offer_redemptions", "customerUid", u, tombstone, nowIso);
      await _anonymizeLedgerByQuery("ipear_redemptions", "customerUid", u, tombstone, nowIso);
    }

    // ── Step C: anonymize OPERATIONAL PII records (keep markers) ────────────
    for (const u of uids) {
      await _anonymizeLedgerByQuery("ipear_redemption_requests", "customerUid", u, tombstone, nowIso);
      await _anonymizeLedgerByQuery("ipear_birthday_claims", "customerUid", u, tombstone, nowIso);
      await _anonymizeLedgerByQuery("audit_logs", "customerUid", u, tombstone, nowIso);
    }

    // ── Step D: DELETE transient operational markers (no evidence) ──────────
    let referralDeleted = 0;
    for (const u of uids) {
      try { await db.collection("ipear_referral_queue").doc(u).delete(); referralDeleted++; } catch (_) {}
      referralDeleted += await _deleteByQuery("ipear_referral_queue", "uid", u);
    }

    // ── Step E: DELETE Firebase Auth user(s) (user-not-found == success) ────
    let authDeleted = 0;
    for (const u of uids) {
      try { await getAuth().deleteUser(u); authDeleted++; }
      catch (e) {
        if (e && e.code === "auth/user-not-found") { authDeleted++; continue; }
        _securityEvent("lifecycle_auth_delete_error", { uid: actorUid, lifecycleId: lid, code: e && e.code });
        throw new HttpsError("internal", "Auth deletion failed; retry is safe.");
      }
    }

    // ── Step F: write the immutable admin_audit COMPLETION event ────────────
    // Written BEFORE the final customer-doc deletion so the stored target ids
    // let a crashed run resume the deletion tail. Deterministic id → no dupes.
    await auditRef.set({
      action: "admin_delete_customer",
      actorUid,
      targetCustomerId: customerId,
      targetCustomerIds: Array.from(custIds),
      targetUids: Array.from(uids),
      tombstone,
      lifecycleId: lid,
      result: "success",
      ledgerRowsSeen: ledgerSeen,
      ledgerRowsAnonymized: ledgerAnon,
      referralQueueDeleted: referralDeleted,
      authUsersDeleted: authDeleted,
      at: nowIso,
      serverTimestamp: FieldValue.serverTimestamp(),
    });

    // ── Step G: DELETE the PII-bearing customer docs LAST ───────────────────
    await _deleteCustomerDocs(Array.from(custIds));

    _securityEvent("lifecycle_deleted", {
      uid: actorUid, customerId, lifecycleId: lid,
      custDocs: custIds.size, uids: uids.size, ledgerAnonymized: ledgerAnon,
    });
    return {
      ok: true, idempotent: false, tombstone, lifecycleId: lid,
      customersDeleted: custIds.size, ledgerRowsAnonymized: ledgerAnon,
    };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    _securityEvent("lifecycle_error", { uid: actorUid, customerId, code: e && e.code });
    throw new HttpsError("internal", "Customer deletion failed; retry is safe.");
  }
}
exports.adminDeleteCustomer = onCall(
  { enforceAppCheck: true, region: "europe-west1" },
  _adminDeleteCustomerHandler
);

// L2.3A exports for local unit tests (mocked Firestore + real-emulator
// integration tests). Firebase Functions honors CommonJS module.exports
// for the deploy path — extending module.exports here (not `exports`)
// attaches non-function values without tripping the auto-registration.
// The four raw handlers are exposed so integration tests can invoke them
// directly with mock `request` objects against the Firestore emulator,
// bypassing the onCall wrapper (which would otherwise require the Cloud
// Functions emulator).
module.exports._l23aInternals = {
  _tabletCustomerProjection,
  _serverTier,
  _ledgerIdForRequest,
  _deterministicRequestId,
  _decideAdminSyncState,
  _createRedemptionRequestHandler,
  _lookupCustomerForTabletHandler,
  _approveRedemptionHandler,
  _rejectRedemptionHandler,
  // L2.3A hotfix (card-QR path):
  _lookupCustomerByCardQrHandler,
  _createRedemptionRequestFromCardHandler,
  _normalizeCardQr,
  _deterministicCardRequestId,
  // Emulator-integration helpers — expose the admin-SDK Firestore instance
  // + timestamp helpers so tests can seed/read data without re-importing
  // firebase-admin from a test-root that lacks it.
  // ADMIN FORTRESS Stage 0/1 — owner gate + server-authoritative adjust handler.
  _requireOwner,
  _adminAdjustPointsHandler,
  _adminBatchMaintenanceHandler,
  _adminBirthdayCreditHandler,
  _adminVerifyRedemptionHandler,
  _adminDeleteCustomerHandler,
  _commitAdjustment,
  _financialActionsDisabled,
  db,
  Timestamp,
  FieldValue,
  _requireTablet,
  _requireAdmin,
  // ADMIN FORTRESS Stage 2 — lifecycle emulator harness helpers.
  _deleteCustomerDocs,
  getAuth,
};
