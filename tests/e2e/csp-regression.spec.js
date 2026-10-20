// ═══════════════════════════════════════════════════════════════════════════
//  CSP REGRESSION — locks in Phases 19–21 (script-src 'unsafe-inline' removal +
//  event-delegation of every inline handler) against the BUILT bundle.
//
//  Two independent guarantees, per surface (/, /tablet, /admin):
//    1. ZERO executable inline on* event-handler attributes in the live DOM.
//       This holds regardless of whether a CSP header is present, so it is the
//       primary, server-agnostic invariant.
//    2. ZERO Content-Security-Policy violations while the enforced hardened
//       script-src is applied. `vite preview` (CI local mode) does NOT emit the
//       Cloudflare _headers CSP, so we inject the EXACT production script-src
//       via response-header interception to make the violation check real.
//       Against a deployed origin (E2E_BASE_URL) the real header is already
//       present; the injected one matches it.
//
//  This spec only LOADS pages and inspects the DOM/console. It performs no
//  login, no Firestore writes, and touches no customer data.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect } from '@playwright/test';

// The exact production customer/tablet script-src (public/_headers), with
// 'unsafe-inline' removed. style-src keeps 'unsafe-inline' intentionally.
const SCRIPT_SRC =
  "script-src 'self' https://www.gstatic.com https://cdn.jsdelivr.net " +
  "https://cdnjs.cloudflare.com https://www.googletagmanager.com " +
  "https://www.google.com https://www.recaptcha.net";
const CSP =
  "default-src 'self'; " + SCRIPT_SRC + "; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com " +
  "https://*.cloudfunctions.net https://email-worker.ipear2026.workers.dev " +
  "wss://*.firebaseio.com https://firestore.googleapis.com " +
  "https://identitytoolkit.googleapis.com https://securetoken.googleapis.com " +
  "https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com " +
  "https://www.google.com https://www.recaptcha.net https://www.gstatic.com; " +
  "img-src 'self' data: blob: https://firebasestorage.googleapis.com https://*.firebasestorage.app; " +
  "frame-src 'self' https://www.google.com https://www.recaptcha.net; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const SURFACES = [
  { name: 'customer', path: '/' },
  { name: 'tablet', path: '/tablet' },
  { name: 'admin', path: '/admin' },
];

for (const surface of SURFACES) {
  test(`CSP: ${surface.name} (${surface.path}) — no violations, no inline handlers`, async ({ page }) => {
    // Enforce the hardened CSP on the top-level document (robust under
    // vite preview, which does not serve public/_headers).
    await page.route('**/*', async (route) => {
      const req = route.request();
      if (req.resourceType() !== 'document') return route.continue();
      const resp = await route.fetch();
      const headers = { ...resp.headers(), 'content-security-policy': CSP };
      route.fulfill({ response: resp, headers });
    });

    // Capture real CSP enforcement failures via the authoritative DOM event.
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        (window.__csp = window.__csp || []).push({
          directive: e.violatedDirective, blocked: e.blockedURI, line: e.lineNumber,
        });
      });
    });
    // Narrow to SCRIPT-src violations only — the Phases 19–21 guarantee.
    // style-src keeps 'unsafe-inline' intentionally, and connect/img blocks in
    // a placeholder build are not script regressions, so they must not fail
    // this spec. The authoritative signal is the securitypolicyviolation DOM
    // event below; this console check is a precise secondary net.
    const consoleCsp = [];
    page.on('console', (m) => {
      const t = m.text();
      if (/script-src|refused to (execute|load the script)/i.test(t) && /content security policy|script-src/i.test(t)) {
        consoleCsp.push(t);
      }
    });

    await page.goto(surface.path, { waitUntil: 'domcontentloaded' });
    // Let modules evaluate + the app shell render (delegation installs at the
    // end of the entry module).
    await page.waitForTimeout(2500);

    // (1) zero executable inline on* handlers in the live DOM
    const inlineHandlers = await page.evaluate(() =>
      document.querySelectorAll(
        '[onclick],[onkeydown],[onkeyup],[onchange],[oninput],[onsubmit],[onfocus],[onblur],[onmouseover],[onmouseout],[onmousedown],[onmouseup]'
      ).length
    );
    expect(inlineHandlers, `${surface.name}: inline on* handlers in DOM`).toBe(0);

    // (2) zero CSP violations (DOM event + console)
    const allViolations = await page.evaluate(() => window.__csp || []);
    const scriptViolations = allViolations.filter((v) => /script-src/.test(v.directive || ''));
    expect(scriptViolations, `${surface.name}: script-src violation events`).toEqual([]);
    expect(consoleCsp, `${surface.name}: script-src console errors`).toEqual([]);
  });
}
