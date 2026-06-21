// ═══════════════════════════════════════════════════════════════════════════
//  Playwright — Golden Path E2E configuration
//
//  Local:    npm run e2e           → boots `vite preview` on :4173 + runs.
//  Against
//  prod URL: E2E_BASE_URL=https://ipear-loyalty.pages.dev npm run e2e
//                                  → skips local server, hits deployed app.
//  CI:       same as local; .env values come from GitHub Actions secrets
//            (see .github/workflows/ci.yml → e2e job).
//
//  We deliberately run a single chromium project, single worker. The Golden
//  Path test mutates a shared test customer's points balance + writes ledger
//  rows, so parallel runs would step on each other. Keep it serial.
// ═══════════════════════════════════════════════════════════════════════════

import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

const PORT = 4173; // vite preview default
const useExternalUrl = !!process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  // Serial — the golden path mutates a shared test customer doc.
  fullyParallel: false,
  workers: 1,

  // CI safety: --only-test blocks are a smell in CI; flaky tests get retries
  // but never auto-skipped.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,

  // Generous global timeout because the test waits on real Firestore live
  // listeners + Firebase Auth handshake (both can be 5–10 s on a cold isolate).
  timeout: 120_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI
    ? [['list'], ['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'on-failure', outputFolder: 'playwright-report' }]],

  use: {
    baseURL: process.env.E2E_BASE_URL || `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  // Only spin up vite preview when we're NOT pointed at an external URL.
  // npm run build is required by `preview` — pre-built bundle catches any
  // build-time regression before the spec even starts.
  webServer: useExternalUrl ? undefined : {
    command: `npm run build && npm run preview -- --port=${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
