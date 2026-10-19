// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  Regression guard — customer reward redemption must NOT reintroduce the 2s
//  time-cooldown that falsely blocked the channel-choice step ("Περίμενε λίγο")
//  on BOTH in-store and e-shop paths (startRedemption() is re-entered at the
//  channel step within 2s of opening the reward). The ONLY client guard allowed
//  is the in-flight double-SUBMIT lock (_redeemInProgress); financial safety is
//  server-authoritative (idempotent pointer + immutable ledger + Worker rate
//  limits — proven in tests/worker-routes.test.js Flow B concurrency cases).
//
//  main.js is a side-effectful monolith (imports firebase/DOM at module load),
//  so this asserts the source contract rather than importing the module.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, '../src/main.js'), 'utf8');

// Isolate the startRedemption function body for precise assertions.
function startRedemptionBody() {
  const start = main.indexOf('export async function startRedemption(');
  expect(start).toBeGreaterThan(-1);
  // find the matching close brace of the function
  let i = main.indexOf('{', start), depth = 0, end = -1;
  for (; i < main.length; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return main.slice(start, end + 1);
}

// Strip // line-comments so assertions check ACTIVE code, not the explanatory
// comment (which legitimately names the removed behaviour).
function stripComments(src) {
  return src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

describe('redemption cooldown regression guard', () => {
  const body = startRedemptionBody();
  const code = stripComments(body);

  it('startRedemption does NOT reintroduce a time-based cooldown', () => {
    expect(code).not.toMatch(/_REDEEM_COOLDOWN/);
    expect(code).not.toMatch(/_redeemLastAt/);
    // the specific false-positive toast must not be gated in ACTIVE code any more
    expect(code).not.toMatch(/showToast\(\s*['"`]⏳ Περίμενε λίγο/);
  });

  it('the time-cooldown constant/state is removed from the module', () => {
    expect(main).not.toMatch(/const\s+_REDEEM_COOLDOWN/);
    expect(main).not.toMatch(/let\s+_redeemLastAt/);
  });

  it('startRedemption keeps the in-flight double-submit lock', () => {
    expect(body).toMatch(/if\s*\(\s*_redeemInProgress\s*\)\s*return/);
    expect(body).toMatch(/_redeemInProgress\s*=\s*true/);
    expect(body).toMatch(/finally\s*\{\s*_redeemInProgress\s*=\s*false/);
  });
});
