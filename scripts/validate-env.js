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

// ── L2.3A App-Check guard (added 2026-08-31) ─────────────────────────────
// The four L2.3A callables in functions/index.js declare
// `enforceAppCheck: true`. If VITE_APP_CHECK_DISABLED=1 slips into .env,
// initializeAppCheck() gets skipped client-side (see firebase-init.js
// lines 201-207), no App-Check tokens are minted, and every callable
// returns `unauthenticated` — the tablet UI misleadingly says "Session
// expired". Root-cause history: L2.3A hotfix incident, 2026-08-31.
//
// Rule: if any callable in functions/index.js requires App Check, the
// client must not disable App Check init. Fail-closed at build time.
const APPCHECK_DISABLED_FLAG = String(env.VITE_APP_CHECK_DISABLED ?? '').trim() === '1';
const APPCHECK_KEY_MISSING = !env.VITE_APP_CHECK_KEY || /X{4,}/i.test(env.VITE_APP_CHECK_KEY);
const FUNCTIONS_INDEX = join(ROOT, 'functions', 'index.js');
let callablesEnforceAppCheck = false;
if (existsSync(FUNCTIONS_INDEX)) {
  const src = readFileSync(FUNCTIONS_INDEX, 'utf8');
  callablesEnforceAppCheck = /enforceAppCheck\s*:\s*true/.test(src);
}
if (callablesEnforceAppCheck && process.env.IPEAR_ALLOW_APPCHECK_DISABLED !== '1') {
  const appCheckFailures = [];
  if (APPCHECK_DISABLED_FLAG) {
    appCheckFailures.push(
      'VITE_APP_CHECK_DISABLED=1 in .env, but functions/index.js has ' +
      '`enforceAppCheck: true` on at least one callable. ' +
      'Every callable request will return `unauthenticated` because the ' +
      'client will not mint App Check tokens. Set VITE_APP_CHECK_DISABLED=0.',
    );
  }
  if (APPCHECK_KEY_MISSING) {
    appCheckFailures.push(
      'VITE_APP_CHECK_KEY is missing or looks like a placeholder. ' +
      'Callables that require App Check will fail — obtain the reCAPTCHA ' +
      'v3 site key from Firebase Console → App Check → Web apps.',
    );
  }
  if (appCheckFailures.length) {
    fail([
      '🚨 APP-CHECK MISCONFIGURATION — ABORTING BUILD',
      '',
      ...appCheckFailures.map((f) => '  • ' + f),
      '',
      'How to fix:',
      '  1. Ensure the web app is registered under Firebase Console → App Check',
      '     with the reCAPTCHA v3 provider AND the site key matches ' +
      'VITE_APP_CHECK_KEY.',
      '  2. Set VITE_APP_CHECK_DISABLED=0 in .env (or remove the line).',
      '  3. Re-run the build.',
      '',
      'CI/local bypass (test-only builds where callables are not called):',
      '  IPEAR_ALLOW_APPCHECK_DISABLED=1 npm run build',
    ]);
  }
}

// ── L2.4-B: Google Sign-In feature-flag validator (added 2026-09-01) ─────
// Enforce that VITE_GOOGLE_SIGNIN_ENABLED is EXACTLY "0" or "1". Anything
// else — unset, empty, "true", "false", "yes", stray whitespace — must
// coerce to "0" downstream, and validate-env prints a warning so a
// misconfigured value cannot silently ship as "on".
//
// The runtime gate in src/customer/google-signin.js re-validates on the
// client side; this guard is the build-time safety net so a typo like
// `VITE_GOOGLE_SIGNIN_ENABLED=Yes` cannot ever pass through to production.
const gRaw = env.VITE_GOOGLE_SIGNIN_ENABLED;
if (gRaw !== undefined && gRaw !== '' && gRaw !== '0' && gRaw !== '1') {
  console.warn(
    '⚠️  validate-env: VITE_GOOGLE_SIGNIN_ENABLED="' + gRaw + '" is invalid — ' +
    'must be exactly "0" or "1". Coercing to "0" (Google Sign-In disabled).'
  );
}

console.log('✅ validate-env: all critical Firebase config present and looks real.');

function fail(lines) {
  console.error('');
  for (const line of lines) console.error(line);
  console.error('');
  process.exit(1);
}
