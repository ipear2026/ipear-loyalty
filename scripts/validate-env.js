#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  Fail-fast env validator — runs as `prebuild` so accidentally deploying
//  a DEMO bundle (placeholder Firebase keys) becomes impossible.
//
//  History: 2026-06-22 — a `cp .env.example .env` left over from a test build
//  reached production, the IS_DEMO branch in firebase-init triggered, and
//  customer login broke until we noticed visually. This script makes that
//  failure mode a build-time error instead of a runtime "no user found".
//
//  Opt-out: set `IPEAR_ALLOW_PLACEHOLDER_ENV=1` in the environment. The CI
//  `customer` job sets it because that job intentionally builds the DEMO
//  bundle for type/lint/build sanity. Production deploys (npm run deploy:pages)
//  must NOT set the opt-out — that's the whole point.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

if (process.env.IPEAR_ALLOW_PLACEHOLDER_ENV === '1') {
  console.log('ℹ️  validate-env: IPEAR_ALLOW_PLACEHOLDER_ENV=1 — skipping (DEMO build allowed).');
  process.exit(0);
}

if (!existsSync(ENV_PATH)) {
  fail([
    '.env file is missing.',
    'Copy .env.example to .env and fill in real Firebase values from',
    'Firebase Console → Project Settings → Your apps → Web.',
  ]);
}

// Parse .env (simple KEY=value parser — same shape Vite uses)
const env = Object.create(null);
for (const raw of readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}

// ── Critical keys — missing/placeholder fails the build ───────────────────
const CRITICAL = [
  'VITE_FB_API_KEY',
  'VITE_FB_AUTH_DOMAIN',
  'VITE_FB_PROJECT_ID',
  'VITE_FB_APP_ID',
  'VITE_FB_MSG_SENDER_ID',
  'VITE_WORKER_URL',
];

// ── Placeholder-detection patterns ────────────────────────────────────────
// Keep these tied to actual .env.example lines so adding a new placeholder
// there auto-triggers detection here. Each pattern returns true if the
// value LOOKS like a placeholder.
const PLACEHOLDER_PATTERNS = [
  // .env.example uses long XXXX runs for API keys / VAPID
  { name: 'X-run', test: (v) => /X{4,}/i.test(v) },
  // common .env.example tokens
  { name: 'literal placeholder', test: (v) => /^(your[-_]|demo[-_]|placeholder|example|replace[-_]me|change[-_]?me)/i.test(v) },
  // project_id / domain placeholders
  { name: 'your-project', test: (v) => /your[-_]project/i.test(v) },
  // example.com domains
  { name: 'example domain', test: (v) => /\.example\.(com|org|net)/i.test(v) },
  // all-zeros sender id / app id segments
  { name: 'all-zeros run', test: (v) => /0{8,}/.test(v) },
  // empty
  { name: 'empty value', test: (v) => v === '' },
];

const failures = [];

for (const key of CRITICAL) {
  const value = env[key];
  if (value === undefined) {
    failures.push(`${key} is MISSING from .env`);
    continue;
  }
  for (const p of PLACEHOLDER_PATTERNS) {
    if (p.test(value)) {
      const preview = value.length > 30 ? value.slice(0, 27) + '…' : value;
      failures.push(`${key} looks like a placeholder (${p.name}): "${preview}"`);
      break;
    }
  }
}

// ── Firebase API key sanity: must start with "AIzaSy" + 33 more chars ─────
const apiKey = env.VITE_FB_API_KEY || '';
if (apiKey && !apiKey.startsWith('AIzaSy')) {
  failures.push(`VITE_FB_API_KEY does not match Firebase pattern (expected "AIzaSy…"): got "${apiKey.slice(0, 12)}…"`);
}

if (failures.length > 0) {
  fail([
    '🚨 FIREBASE CONFIG IS PLACEHOLDER OR INVALID — ABORTING BUILD',
    '',
    ...failures.map((f) => '  • ' + f),
    '',
    'How to fix:',
    '  1. Open Firebase Console → Project Settings → Your apps → Web',
    '  2. Copy the config values into your local .env file',
    '  3. Re-run the build',
    '',
    'CI bypass (DEMO-mode build only):  IPEAR_ALLOW_PLACEHOLDER_ENV=1 npm run build',
  ]);
}

console.log('✅ validate-env: all critical Firebase config present and looks real.');

function fail(lines) {
  console.error('');
  for (const line of lines) console.error(line);
  console.error('');
  process.exit(1);
}
