// @vitest-environment node
// ═══════════════════════════════════════════════════════════════════════════
//  prod-v2.7.0 · Google Sign-In removal contract test.
//
//  Locks the "removed" state so a future change cannot silently re-introduce
//  any Google Sign-In UI, module, wiring, or CSP origin. Purely static-source
//  based (no build/emulator needed).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'dist-off', 'dist-on', '.git'].includes(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs|cjs|html)$/.test(name)) out.push(p);
  }
  return out;
}

const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
const mainJs = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
const firebaseSvc = readFileSync(join(ROOT, 'src', 'services', 'firebase.js'), 'utf8');
const headers = readFileSync(join(ROOT, 'public', '_headers'), 'utf8');

describe('prod-v2.7.0 · Google Sign-In is removed', () => {
  it('deleted modules do not exist', () => {
    expect(existsSync(join(ROOT, 'src', 'customer', 'google-signin.js'))).toBe(false);
    expect(existsSync(join(ROOT, 'src', 'customer', 'google-onboarding-flow.js'))).toBe(false);
  });

  it('index.html has no Google Sign-In UI', () => {
    expect(indexHtml).not.toMatch(/data-google-signin-ui/);
    expect(indexHtml).not.toMatch(/google-signin-btn/);
    expect(indexHtml).not.toMatch(/Συνέχεια με Google/);
  });

  it('main.js has no Google imports or wiring', () => {
    expect(mainJs).not.toMatch(/google-signin\.js/);
    for (const s of ['startGoogleSignIn', 'cancelGoogleSignIn', 'submitGoogleLink', 'processGoogleRedirectResult', 'IS_GOOGLE_SIGNIN_ENABLED']) {
      expect(mainJs).not.toContain(s);
    }
  });

  it('services/firebase.js no longer re-exports Google provider symbols', () => {
    for (const s of ['GoogleAuthProvider', 'signInWithPopup', 'signInWithRedirect', 'getRedirectResult']) {
      expect(firebaseSvc).not.toContain(s);
    }
  });

  it('CSP no longer allows Google auth OAuth origins, keeps reCAPTCHA', () => {
    expect(headers).not.toContain('loyalty-ipear.firebaseapp.com');
    expect(headers).not.toContain('apis.google.com');
    expect(headers).not.toContain('lh3.googleusercontent.com');
    expect(headers).toContain('www.google.com');
    expect(headers).toContain('www.recaptcha.net');
  });

  it('no active source file imports a deleted Google module', () => {
    for (const f of walk(join(ROOT, 'src'))) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} imports google-signin`).not.toMatch(/from\s+['"][^'"]*google-signin(\.js)?['"]/);
    }
  });

  it('normal password-auth entry points remain', () => {
    for (const s of ['submitPhone', 'submitRegister', 'submitOTP', 'openForgotPass', 'openRegister']) {
      expect(mainJs).toContain(s);
    }
  });
});
