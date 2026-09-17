// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  L2.3A · Region-lock regression guard (2026-08-31)
//
//  Prevents recurrence of the "Σφάλμα — internal" bug where the tablet
//  Functions SDK client was left at its us-central1 default while the
//  server callables live in europe-west1.
//
//  The check is deliberately syntactic — we read the source files, assert
//  `getFunctions(...)` is called with the region string, AND assert that
//  same region string matches `region:` on every L2.3A callable in
//  functions/index.js. That way a future refactor moving either side
//  without the other trips the test immediately, no emulator needed.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

// Extract every `region: "..."` on a CF definition; both L2.3A callables
// and any future ones should share one region.
function serverRegions() {
  const src = read('functions/index.js');
  const matches = [...src.matchAll(/region:\s*["']([a-z0-9-]+)["']/g)];
  return matches.map((m) => m[1]);
}

// Extract every getFunctions(...)  call and return the region string
// (2nd positional argument as a literal). undefined = SDK default (us-central1).
function clientRegions(clientRel) {
  const src = read(clientRel);
  const matches = [...src.matchAll(
    /getFunctions\s*\(\s*[^,)]+(?:,\s*(?:['"]([a-z0-9-]+)['"]|([A-Z_][A-Z0-9_]*)))?\s*\)/g
  )];
  if (!matches.length) return [];
  // Second capture group is a bare identifier (like a constant); resolve it
  // by grepping for its assigned string literal in the same file.
  const resolved = matches.map((m) => {
    if (m[1]) return m[1];
    if (m[2]) {
      const constName = m[2];
      const re = new RegExp(
        'const\\s+' + constName + "\\s*=\\s*['\"]([a-z0-9-]+)['\"]",
      );
      const cm = src.match(re);
      return cm ? cm[1] : null;
    }
    return null;
  });
  return resolved;
}

describe('L2.3A · region lock (client ↔ server)', () => {
  it('server-side: every L2.3A callable declares an explicit region', () => {
    const regs = serverRegions();
    // We expect at least the 4 L2.3A callables + the 2 hotfix callables
    // to declare region:; there are 6 in total today. All must be a single
    // consistent region (europe-west1).
    expect(regs.length).toBeGreaterThanOrEqual(6);
    expect(new Set(regs).size).toBe(1);
    expect(regs[0]).toBe('europe-west1');
  });

  it('client (tablet approval-flow): getFunctions() targets europe-west1', () => {
    const regs = clientRegions('src/tablet/approval-flow.js');
    expect(regs.length).toBeGreaterThanOrEqual(1);
    for (const r of regs) {
      expect(r, 'every getFunctions() call must pin the region').not.toBe(null);
      expect(r).toBe('europe-west1');
    }
  });

  it('client (admin approval-queue): getFunctions() targets europe-west1', () => {
    const regs = clientRegions('src/admin/approval-queue.js');
    expect(regs.length).toBeGreaterThanOrEqual(1);
    for (const r of regs) {
      expect(r, 'every getFunctions() call must pin the region').not.toBe(null);
      expect(r).toBe('europe-west1');
    }
  });

  it('single region string used by both sides (client == server)', () => {
    const server = new Set(serverRegions());
    const t = new Set(clientRegions('src/tablet/approval-flow.js').filter(Boolean));
    const a = new Set(clientRegions('src/admin/approval-queue.js').filter(Boolean));
    expect([...server]).toEqual([...t]);
    expect([...server]).toEqual([...a]);
  });
});
