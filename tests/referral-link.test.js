// @vitest-environment jsdom
// ───────────────────────────────────────────────────────────────────────────
//  Referral share link must ALWAYS use the canonical production origin
//  (https://loyalty.ipear.gr), never window.location.origin / pages.dev,
//  and never a /customer.html path. The referral code must be preserved.
// ───────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shareReferral } from '../src/customer/ui/misc-ui.js';
import { state } from '../src/state.js';

describe('shareReferral — canonical origin', () => {
  beforeEach(() => {
    state.foundCustomer = { card: 'IP-FC0Z12' };
    // The real app always has a #toast node; provide it so the clipboard
    // fallback's showToast() call doesn't throw on a missing element.
    document.body.innerHTML = '<div id="toast"></div>';
  });

  it('uses https://loyalty.ipear.gr and preserves the ref code (native share)', async () => {
    let shared = null;
    navigator.share = vi.fn(async (data) => { shared = data; });
    await shareReferral();
    expect(shared).toBeTruthy();
    expect(shared.url).toBe('https://loyalty.ipear.gr/?ref=IP-FC0Z12');
    expect(shared.url).not.toMatch(/pages\.dev/);
    expect(shared.url).not.toMatch(/customer\.html/);
    expect(shared.text).toContain('IP-FC0Z12');
    expect(shared.text).toContain('https://loyalty.ipear.gr/?ref=IP-FC0Z12');
  });

  it('falls back to clipboard with the canonical URL when native share is absent', async () => {
    delete navigator.share;
    let copied = null;
    navigator.clipboard = { writeText: vi.fn(async (t) => { copied = t; }) };
    await shareReferral();
    expect(copied).toContain('https://loyalty.ipear.gr/?ref=IP-FC0Z12');
    expect(copied).not.toMatch(/pages\.dev/);
  });

  it('never emits window.location.origin (jsdom origin is localhost)', async () => {
    let shared = null;
    navigator.share = vi.fn(async (data) => { shared = data; });
    await shareReferral();
    expect(shared.url).not.toContain(window.location.origin);
  });
});
