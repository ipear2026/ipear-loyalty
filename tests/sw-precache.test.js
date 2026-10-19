// ═══════════════════════════════════════════════════════════════════════════
//  Service-worker SHELL precache integrity
//
//  Extracts the SHELL[] array from public/sw-customer.js and asserts every
//  entry exists in the built dist/ tree. Cache.addAll() throws on opaque
//  redirects and 404s during SW install, so any stale filename here silently
//  breaks the customer app's install-time cache.
//
//  Prerequisite:  run `npm run build` first — this test reads from dist/.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SW_PATH   = path.join(REPO_ROOT, 'public', 'sw-customer.js');
const DIST_DIR  = path.join(REPO_ROOT, 'dist');

function extractShell() {
  const src = fs.readFileSync(SW_PATH, 'utf8');
  const m = src.match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error('SHELL array not found in sw-customer.js');
  const raw = m[1];
  return raw.split(',')
    .map(s => s.trim().replace(/^['"`]|['"`]$/g, ''))
    .filter(s => s.length > 0 && !s.startsWith('//'));
}

describe('sw-customer.js SHELL precache', () => {
  it('has a non-empty SHELL array', () => {
    const shell = extractShell();
    expect(shell.length).toBeGreaterThan(0);
  });

  it('every SHELL entry exists in dist/ (else SW install throws)', () => {
    if (!fs.existsSync(DIST_DIR)) {
      throw new Error(`dist/ missing — run \`npm run build\` first`);
    }
    const shell = extractShell();
    const missing = shell.filter(entry => !fs.existsSync(path.join(DIST_DIR, entry)));
    expect(missing, `SHELL entries missing from dist/: ${missing.join(', ')}`).toEqual([]);
  });

  it('no SHELL entry is served via a redirect (opaque cache.addAll failure)', () => {
    // Read _redirects and confirm no SHELL filename appears on the LEFT side
    const redirectsPath = path.join(REPO_ROOT, 'public', '_redirects');
    if (!fs.existsSync(redirectsPath)) return;   // no _redirects, nothing to check
    const redirects = fs.readFileSync(redirectsPath, 'utf8');
    const shell = extractShell();
    const redirected = shell.filter(entry => {
      // Line-anchored match: "/{entry}" appears as the source of a redirect rule
      const src = '/' + entry;
      const re = new RegExp('^\\s*' + src.replace(/[.]/g, '\\.') + '\\s+', 'm');
      return re.test(redirects);
    });
    expect(redirected, `SHELL entries served via redirect: ${redirected.join(', ')}`).toEqual([]);
  });
});
