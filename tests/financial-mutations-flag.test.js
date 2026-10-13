// @vitest-environment jsdom
// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS — isServerFinancialEnabled() default-ON hardening.
//
//  Regression guard (2026-10-13): the server-authoritative financial path must
//  be the DEFAULT. A Pages build that ships WITHOUT VITE_ADMIN_SERVER_FINANCIAL
//  must NOT silently revert admin financial writes to the legacy direct-
//  Firestore path (which the locked firestore.rules deny → "Δεν έχετε δικαίωμα").
//  Only an EXPLICIT kill-switch may disable the server path.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isServerFinancialEnabled } from '../src/admin/financial-mutations.js';

afterEach(() => {
  vi.unstubAllEnvs();
  try { delete window.__ADMIN_SERVER_FINANCIAL_MUTATIONS; } catch (_) {}
});

describe('isServerFinancialEnabled — default-ON fail-safe', () => {
  it('returns TRUE when no flag is set (missing build flag = server path)', () => {
    // No VITE_ADMIN_SERVER_FINANCIAL stubbed, no window override.
    expect(isServerFinancialEnabled()).toBe(true);
  });

  it('returns TRUE when VITE_ADMIN_SERVER_FINANCIAL=1 (explicit on)', () => {
    vi.stubEnv('VITE_ADMIN_SERVER_FINANCIAL', '1');
    expect(isServerFinancialEnabled()).toBe(true);
  });

  it('returns TRUE for any non-"0" build value (e.g. "true", "")', () => {
    vi.stubEnv('VITE_ADMIN_SERVER_FINANCIAL', '');
    expect(isServerFinancialEnabled()).toBe(true);
    vi.stubEnv('VITE_ADMIN_SERVER_FINANCIAL', 'true');
    expect(isServerFinancialEnabled()).toBe(true);
  });

  it('returns FALSE only for the EXPLICIT build kill-switch =0', () => {
    vi.stubEnv('VITE_ADMIN_SERVER_FINANCIAL', '0');
    expect(isServerFinancialEnabled()).toBe(false);
  });

  it('returns FALSE for the EXPLICIT runtime kill-switch === false', () => {
    window.__ADMIN_SERVER_FINANCIAL_MUTATIONS = false;
    expect(isServerFinancialEnabled()).toBe(false);
  });

  it('runtime flag must be STRICT false; truthy/other values keep server path ON', () => {
    window.__ADMIN_SERVER_FINANCIAL_MUTATIONS = true;
    expect(isServerFinancialEnabled()).toBe(true);
    window.__ADMIN_SERVER_FINANCIAL_MUTATIONS = 0; // not === false
    expect(isServerFinancialEnabled()).toBe(true);
    window.__ADMIN_SERVER_FINANCIAL_MUTATIONS = undefined;
    expect(isServerFinancialEnabled()).toBe(true);
  });

  it('explicit build kill-switch =0 wins even if runtime flag is unset', () => {
    vi.stubEnv('VITE_ADMIN_SERVER_FINANCIAL', '0');
    expect(isServerFinancialEnabled()).toBe(false);
  });
});
