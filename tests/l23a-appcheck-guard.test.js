// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  L2.3A · App Check misconfig regression guard (2026-08-31)
//
//  Prevents recurrence of the incident where VITE_APP_CHECK_DISABLED=1 in
//  .env silently disabled App Check client-side while callables still
//  enforced it, producing a cryptic `unauthenticated` on every scan.
//
//  Test strategy — pure Node, no emulator, no network:
//    1. Regenerate the same .env parsing as validate-env.js and assert
//       VITE_APP_CHECK_DISABLED is NOT "1" in the current .env.
//    2. Prove the prebuild guard actually rejects the bad flag by invoking
//       scripts/validate-env.js in a subprocess with a synthetic .env
//       fixture and asserting exit code 1 + the App-Check failure phrase.
//    3. Prove the guard passes on a clean fixture (exit code 0).
//    4. Prove the tablet UI error-mapping now differentiates the App Check
//       failure from a real session expiry.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const SCRIPT = join(REPO, 'scripts', 'validate-env.js');
const FIXTURE_ROOT = join(REPO, '.tmp-appcheck-fixture');

// Minimal env that satisfies the "critical Firebase" checks, so we isolate
// the App-Check gate as the ONLY failure mode.
// Fixture values chosen to satisfy every existing "critical Firebase"
// placeholder gate in scripts/validate-env.js so the App-Check gate is
// the ONLY remaining variable. Avoid `demo-`/`example.`/`your-` prefixes.
function makeGoodEnv(overrides = {}) {
  const base = {
    VITE_FB_API_KEY: 'AIzaSy' + 'A'.repeat(33),
    VITE_FB_AUTH_DOMAIN: 'stagingsite.firebaseapp.com',
    VITE_FB_PROJECT_ID: 'stagingsite',
    VITE_FB_APP_ID: '1:123456789012:web:abcdef1234567890abcdef',
    VITE_FB_MSG_SENDER_ID: '123456789012',
    VITE_WORKER_URL: 'https://staging.workers.dev',
    VITE_APP_CHECK_KEY: '6L' + 'c'.repeat(38),
    VITE_APP_CHECK_DISABLED: '0',
    ...overrides,
  };
  return Object.entries(base).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

function runGuard(envFilePath, extraEnv = {}) {
  const wrapperRoot = dirname(envFilePath); // pretend this is the repo root
  // Copy validate-env.js into the fixture root so its `join(__dirname, '..')`
  // resolves the .env we control (script sits in <root>/scripts/).
  const scriptDir = join(wrapperRoot, 'scripts');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, 'validate-env.js'), readFileSync(SCRIPT, 'utf8'));
  // Match the real repo layout: put an empty functions/index.js unless the
  // caller wants to simulate the enforceAppCheck presence explicitly.
  if (extraEnv._functionsSrc !== undefined) {
    const fnsDir = join(wrapperRoot, 'functions');
    mkdirSync(fnsDir, { recursive: true });
    writeFileSync(join(fnsDir, 'index.js'), extraEnv._functionsSrc);
    delete extraEnv._functionsSrc;
  }
  const res = spawnSync(process.execPath, [join(scriptDir, 'validate-env.js')], {
    cwd: wrapperRoot,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

beforeAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(FIXTURE_ROOT, { recursive: true });
});

describe('L2.3A · App Check misconfig guard', () => {
  it('current repo .env does NOT have VITE_APP_CHECK_DISABLED=1', () => {
    const envSrc = readFileSync(join(REPO, '.env'), 'utf8');
    const m = envSrc.match(/^VITE_APP_CHECK_DISABLED=(.*)$/m);
    expect(m, 'VITE_APP_CHECK_DISABLED must be explicitly set in .env').not.toBeNull();
    expect(m[1].trim(), 'VITE_APP_CHECK_DISABLED must NOT be "1" — App Check must init').not.toBe('1');
  });

  it('prebuild REJECTS a fixture where VITE_APP_CHECK_DISABLED=1 AND callables enforce App Check', () => {
    const dir = join(FIXTURE_ROOT, 'bad-disabled');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), makeGoodEnv({ VITE_APP_CHECK_DISABLED: '1' }));
    const enforceSrc = 'exports.someCallable = onCall({ enforceAppCheck: true, region: "europe-west1" }, () => {});';
    const res = runGuard(join(dir, '.env'), { _functionsSrc: enforceSrc });
    expect(res.status, 'expected non-zero exit').not.toBe(0);
    expect(res.stderr).toMatch(/APP-CHECK MISCONFIGURATION/);
    expect(res.stderr).toMatch(/VITE_APP_CHECK_DISABLED=1/);
  });

  it('prebuild REJECTS a fixture where VITE_APP_CHECK_KEY is a placeholder AND callables enforce App Check', () => {
    const dir = join(FIXTURE_ROOT, 'bad-key');
    mkdirSync(dir, { recursive: true });
    // 40 X's = placeholder. Disabled flag is off; only the key is bad.
    writeFileSync(join(dir, '.env'), makeGoodEnv({ VITE_APP_CHECK_KEY: 'X'.repeat(40) }));
    const enforceSrc = 'exports.someCallable = onCall({ enforceAppCheck: true, region: "europe-west1" }, () => {});';
    const res = runGuard(join(dir, '.env'), { _functionsSrc: enforceSrc });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/APP-CHECK MISCONFIGURATION/);
    expect(res.stderr).toMatch(/VITE_APP_CHECK_KEY/);
  });

  it('prebuild PASSES on a clean fixture (real key + flag=0 + callables enforce App Check)', () => {
    const dir = join(FIXTURE_ROOT, 'good');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), makeGoodEnv());
    const enforceSrc = 'exports.someCallable = onCall({ enforceAppCheck: true, region: "europe-west1" }, () => {});';
    const res = runGuard(join(dir, '.env'), { _functionsSrc: enforceSrc });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/all critical Firebase config present/);
  });

  it('prebuild PASSES when no callable enforces App Check (guard is scoped)', () => {
    const dir = join(FIXTURE_ROOT, 'no-enforce');
    mkdirSync(dir, { recursive: true });
    // Bad flag but functions do NOT enforce App Check → guard must NOT trip.
    writeFileSync(join(dir, '.env'), makeGoodEnv({ VITE_APP_CHECK_DISABLED: '1' }));
    const enforceSrc = 'exports.someCallable = onCall({ region: "europe-west1" }, () => {});'; // no enforceAppCheck
    const res = runGuard(join(dir, '.env'), { _functionsSrc: enforceSrc });
    expect(res.status).toBe(0);
  });

  it('prebuild bypass IPEAR_ALLOW_APPCHECK_DISABLED=1 allows the misconfig for CI-only builds', () => {
    const dir = join(FIXTURE_ROOT, 'bypass');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), makeGoodEnv({ VITE_APP_CHECK_DISABLED: '1' }));
    const enforceSrc = 'exports.someCallable = onCall({ enforceAppCheck: true }, () => {});';
    const res = runGuard(join(dir, '.env'), {
      _functionsSrc: enforceSrc,
      IPEAR_ALLOW_APPCHECK_DISABLED: '1',
    });
    expect(res.status).toBe(0);
  });

  it('tablet UI error-mapping distinguishes App-Check failure from session expiry', () => {
    // Read the source to prove the two distinct messages exist.
    const src = readFileSync(join(REPO, 'src', 'tablet-main.js'), 'utf8');
    expect(src).toMatch(/unauth-app/);
    expect(src).toMatch(/unauth-session/);
    expect(src).toMatch(/Πρόβλημα ασφάλειας συσκευής/);
    // And the differentiator is based on live auth state, not just the code.
    expect(src).toMatch(/window\._auth[^)]*currentUser/);
  });
});
