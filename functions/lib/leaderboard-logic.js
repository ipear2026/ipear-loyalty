// ═══════════════════════════════════════════════════════════════════════════
//  Pure leaderboard-republish decision — no Firebase deps, unit-testable.
//  Used by autoPublishLeaderboard (functions/index.js).
//    • delete (before && !after)  → ALWAYS republish (removed customer must
//                                    never linger in ipear_leaderboard/latest)
//    • create (!before && after)  → republish
//    • update                     → republish only if totalPoints changed
// ═══════════════════════════════════════════════════════════════════════════
function shouldRepublishLeaderboard(before, after) {
  const isDelete = !!before && !after;
  if (isDelete) return true;
  const ptsBefore = (before && before.totalPoints != null) ? before.totalPoints : -1;
  const ptsAfter  = (after  && after.totalPoints  != null) ? after.totalPoints  : -1;
  return ptsBefore !== ptsAfter;
}
module.exports = { shouldRepublishLeaderboard };
