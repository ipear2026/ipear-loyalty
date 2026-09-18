// @vitest-environment node
// ───────────────────────────────────────────────────────────────────────────
//  autoPublishLeaderboard republish-decision — the deleted-customer bug.
//  A deletion must ALWAYS trigger a republish so the removed customer cannot
//  linger in ipear_leaderboard/latest, even if the doc had no totalPoints.
// ───────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldRepublishLeaderboard } = require('../functions/lib/leaderboard-logic.js');

describe('shouldRepublishLeaderboard', () => {
  it('DELETE of a normal customer → republish', () => {
    expect(shouldRepublishLeaderboard({ totalPoints: 500 }, undefined)).toBe(true);
  });

  it('DELETE of a 0-point customer → republish', () => {
    expect(shouldRepublishLeaderboard({ totalPoints: 0 }, undefined)).toBe(true);
  });

  it('DELETE of a doc with NO totalPoints field → republish (the bug)', () => {
    // Previously ptsBefore=-1 === ptsAfter=-1 skipped this — deleted customer lingered.
    expect(shouldRepublishLeaderboard({ name: 'X' }, undefined)).toBe(true);
  });

  it('CREATE (new customer) → republish', () => {
    expect(shouldRepublishLeaderboard(undefined, { totalPoints: 0 })).toBe(true);
  });

  it('UPDATE with changed totalPoints → republish', () => {
    expect(shouldRepublishLeaderboard({ totalPoints: 50 }, { totalPoints: 150 })).toBe(true);
  });

  it('UPDATE with unchanged totalPoints (name/phone edit) → skip', () => {
    expect(shouldRepublishLeaderboard(
      { totalPoints: 50, name: 'A' },
      { totalPoints: 50, name: 'B' },
    )).toBe(false);
  });
});
