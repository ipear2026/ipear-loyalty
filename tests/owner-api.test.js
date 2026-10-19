// @vitest-environment jsdom
// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN FORTRESS Stage 3B — admin-browser owner-auth adapter (owner-api.js).
//  Proves: flag gating; fresh ID token + App Check attached per request; calls
//  /admin/v2/*; NO ADMIN_SECRET ever read/sent; NO automatic fallback; tokens
//  never persisted; typed fail-closed errors.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isOwnerAuthEnabled, ownerPost, ownerSendEmail, ownerSendSms, ownerSendBulkSms, ownerDeleteAuthUser,
} from '../src/admin/owner-api.js';

const WORKER = 'https://worker.test';
let fetchCalls;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ipear_worker_url', WORKER);
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: true, sent: 1 }) };
  });
  // signed-in owner + App Check available
  window.__ADMIN_OWNER_AUTH = true;
  window._auth = { currentUser: { getIdToken: vi.fn(async () => 'ID_TOKEN_XYZ') } };
  window._getAppCheckToken = vi.fn(async () => 'APPCHECK_ABC');
});
afterEach(() => { delete window.__ADMIN_OWNER_AUTH; delete window._auth; delete window._getAppCheckToken; });

describe('isOwnerAuthEnabled', () => {
  it('true via runtime flag; false when unset', () => {
    expect(isOwnerAuthEnabled()).toBe(true);
    window.__ADMIN_OWNER_AUTH = false;
    expect(isOwnerAuthEnabled()).toBe(false);
  });
});

describe('ownerPost — attaches fresh identity, hits /admin/v2/*', () => {
  it('sends Bearer ID token + X-Firebase-AppCheck to the v2 route; no ADMIN_SECRET', async () => {
    const r = await ownerPost('email', { subject: 's' });
    expect(r).toEqual({ ok: true, sent: 1 });
    expect(fetchCalls).toHaveLength(1);
    const { url, opts } = fetchCalls[0];
    expect(url).toBe(`${WORKER}/admin/v2/email`);
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer ID_TOKEN_XYZ');
    expect(opts.headers['X-Firebase-AppCheck']).toBe('APPCHECK_ABC');
    // never an ADMIN_SECRET / ipear_worker_secret
    expect(JSON.stringify(opts.headers)).not.toMatch(/ipear_worker_secret|ADMIN_SECRET/i);
    expect(window._auth.currentUser.getIdToken).toHaveBeenCalled();
    expect(window._getAppCheckToken).toHaveBeenCalled();
  });

  it('typed helpers target the right routes', async () => {
    await ownerSendEmail({}); await ownerSendSms({}); await ownerSendBulkSms({}); await ownerDeleteAuthUser({ uid: 'x' });
    expect(fetchCalls.map((c) => c.url)).toEqual([
      `${WORKER}/admin/v2/email`, `${WORKER}/admin/v2/sms`, `${WORKER}/admin/v2/bulk-sms`, `${WORKER}/admin/v2/delete-auth-user`,
    ]);
  });

  it('never persists tokens to storage', async () => {
    await ownerPost('email', {});
    const dump = JSON.stringify({ ...localStorage });
    expect(dump).not.toMatch(/ID_TOKEN_XYZ|APPCHECK_ABC/);
    expect(localStorage.getItem('ipear_worker_secret')).toBeNull();
  });
});

describe('ownerPost — fail-closed, NO fallback', () => {
  it('not signed in → throws not-signed-in, makes NO fetch (no secret fallback)', async () => {
    window._auth = { currentUser: null };
    await expect(ownerPost('email', {})).rejects.toMatchObject({ code: 'not-signed-in' });
    expect(fetchCalls).toHaveLength(0);
  });
  it('App Check unavailable → throws appcheck-failed, NO fetch', async () => {
    window._getAppCheckToken = vi.fn(async () => { throw new Error('nope'); });
    await expect(ownerPost('email', {})).rejects.toMatchObject({ code: 'appcheck-failed' });
    expect(fetchCalls).toHaveLength(0);
  });
  it('App Check empty token → throws appcheck-missing, NO fetch', async () => {
    window._getAppCheckToken = vi.fn(async () => '');
    await expect(ownerPost('email', {})).rejects.toMatchObject({ code: 'appcheck-missing' });
    expect(fetchCalls).toHaveLength(0);
  });
  it('worker URL missing → throws worker-url-missing, NO fetch', async () => {
    localStorage.removeItem('ipear_worker_url');
    await expect(ownerPost('email', {})).rejects.toMatchObject({ code: 'worker-url-missing' });
    expect(fetchCalls).toHaveLength(0);
  });
  it('server denies (403 not-owner) → throws with status/code, does NOT retry with a secret', async () => {
    globalThis.fetch = vi.fn(async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: false, status: 403, json: async () => ({ code: 'not-owner' }) }; });
    await expect(ownerPost('export-backup', {})).rejects.toMatchObject({ status: 403, code: 'not-owner' });
    expect(fetchCalls).toHaveLength(1); // exactly one attempt, no fallback
  });
});
