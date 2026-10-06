"use strict";
// ───────────────────────────────────────────────────────────────────────────
//  ADMIN FORTRESS · Stage 0 — server-side OWNER UID authorization.
//
//  Defense-in-depth on top of the existing admin custom-claim gate. The owner
//  UID allowlist is configured SERVER-SIDE ONLY (env var `OWNER_UIDS`, a
//  comma-separated list of Firebase UIDs). It is never shipped to the browser
//  and never read from a Firestore document a normal user could influence.
//
//  FAIL-CLOSED: a missing / empty / malformed `OWNER_UIDS` configuration
//  denies every owner-gated (financial) operation. Never fail open.
//
//  Pure + dependency-free so the full adversarial matrix is unit-testable
//  without the emulator.
// ───────────────────────────────────────────────────────────────────────────

// Parse the raw env string into a de-duplicated list of trimmed non-empty UIDs.
function parseOwnerUids(raw) {
  if (typeof raw !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const part of raw.split(",")) {
    const uid = part.trim();
    // A plausible Firebase UID: non-empty, no whitespace, reasonable length.
    if (uid && !/\s/.test(uid) && uid.length <= 128 && !seen.has(uid)) {
      seen.add(uid);
      out.push(uid);
    }
  }
  return out;
}

// Fail-closed owner check. Returns { ok, reason }.
//   tokenClaims — the VERIFIED request.auth.token (never client body fields).
//   uid         — request.auth.uid (verified).
//   ownerUidsRaw— process.env.OWNER_UIDS (server config).
function checkOwner(tokenClaims, uid, ownerUidsRaw) {
  const owners = parseOwnerUids(ownerUidsRaw);
  if (owners.length === 0) return { ok: false, reason: "owner-config-missing" };
  if (!tokenClaims || tokenClaims.admin !== true) return { ok: false, reason: "not-admin" };
  if (typeof uid !== "string" || !uid) return { ok: false, reason: "no-uid" };
  if (!owners.includes(uid)) return { ok: false, reason: "not-owner" };
  return { ok: true };
}

module.exports = { parseOwnerUids, checkOwner };
