"use strict";
// ───────────────────────────────────────────────────────────────────────────
//  CANONICAL TIER LADDER (Admin Fortress Stage 2 — TIER-AUTHORITY resolved).
//
//  Single server-side source of truth for tier thresholds, matching the
//  customer-facing ladder (src/utils.js `tier()`), the Cloudflare Worker
//  (`_computeTier`), and the test-suite boundaries (`tierFloor`):
//
//    Bronze 0 · Silver 1000 · Gold 3000 · Diamond 6000 · Platinum 10000
//
//  NOTE: functions/index.js `_serverTier()` uses a DIFFERENT (lower) ladder and
//  is a pre-existing *display* bug used only by the tablet projection — it is
//  NOT the authoritative business ladder and is NOT a financial writer. It is
//  flagged for separate remediation (fixing it would alter tablet display and
//  require redeploying existing functions, out of this cutover's "new functions
//  only" scope). This module is the canonical source for all NEW financial logic.
//
//  Pure + dependency-free for unit testing at every boundary.
// ───────────────────────────────────────────────────────────────────────────

// Highest-floor-first so the first match wins.
const LADDER = [
  { name: "Platinum", cls: "platinum", floor: 10000 },
  { name: "Diamond",  cls: "diamond",  floor: 6000 },
  { name: "Gold",     cls: "gold",     floor: 3000 },
  { name: "Silver",   cls: "silver",   floor: 1000 },
  { name: "Bronze",   cls: "bronze",   floor: 0 },
];

function tierOf(totalPoints) {
  const t = Number(totalPoints || 0);
  for (const x of LADDER) if (t >= x.floor) return x;
  return LADDER[LADDER.length - 1]; // Bronze (floor 0) — unreachable fallback
}
function tierFloor(totalPoints) { return tierOf(totalPoints).floor; }
function tierName(totalPoints) { return tierOf(totalPoints).name; }
function tierCls(totalPoints) { return tierOf(totalPoints).cls; }

// Inactivity downgrade: drop exactly one tier → the top of the tier below
// (current floor − 1), e.g. Platinum(≥10000)→9999, Diamond→5999, Gold→2999,
// Silver→999. Bronze (floor 0) is the bottom → no downgrade (returns null).
// Mirrors the existing client logic (maintenance.js) exactly, server-computed.
function downgradeTarget(totalPoints) {
  const f = tierFloor(totalPoints);
  return f > 0 ? f - 1 : null;
}

module.exports = { LADDER, tierOf, tierFloor, tierName, tierCls, downgradeTarget };
