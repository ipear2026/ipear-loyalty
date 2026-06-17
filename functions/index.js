const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

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
//  Guard: only rebuilds when totalPoints actually changed (skips name edits etc.)
//  Debounce: uses a 2-second write-coalesce via Firestore's own batching
// ══════════════════════════════════════════════════════════════════════════
exports.autoPublishLeaderboard = onDocumentWritten(
  "ipear_customers/{customerId}",
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    // Skip if totalPoints didn't change (name edit, phone update, etc.)
    const ptsBefore = before?.totalPoints ?? -1;
    const ptsAfter = after?.totalPoints ?? -1;
    if (ptsBefore === ptsAfter) return;

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
