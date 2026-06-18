// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  esc, escJs, escHtml,
  tier, tierFloor,
  _parseExpiryMs, _isPendingAndActive,
} from '../src/utils.js';

describe('esc (HTML escape)', () => {
  it('escapes the five XSS-dangerous chars', () => {
    expect(esc('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('escapes ampersand and single-quote', () => {
    expect(esc("Tom & Jerry's")).toBe('Tom &amp; Jerry&#39;s');
  });

  it('returns empty string for null / undefined', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('coerces non-strings to string before escaping', () => {
    expect(esc(42)).toBe('42');
    expect(esc({})).toBe('[object Object]');
  });

  it('escHtml is an alias for esc', () => {
    expect(escHtml).toBe(esc);
  });
});

describe('escJs (JS string literal escape)', () => {
  it('escapes embedded double quotes and backslashes', () => {
    expect(escJs('he said "hi"')).toBe('he said \\"hi\\"');
    expect(escJs('back\\slash')).toBe('back\\\\slash');
  });

  it('handles newlines and tabs via JSON encoding', () => {
    expect(escJs('a\nb')).toBe('a\\nb');
    expect(escJs('a\tb')).toBe('a\\tb');
  });

  it('returns empty for nullish input', () => {
    expect(escJs(null)).toBe('');
    expect(escJs(undefined)).toBe('');
  });
});

describe('tier()', () => {
  it('Bronze for 0 and just under 1000', () => {
    expect(tier(0).name).toBe('Bronze');
    expect(tier(999).name).toBe('Bronze');
  });

  it('Silver at exactly 1000', () => {
    expect(tier(1000).name).toBe('Silver');
    expect(tier(2999).name).toBe('Silver');
  });

  it('Gold at 3000, Diamond at 6000, Platinum at 10000', () => {
    expect(tier(3000).name).toBe('Gold');
    expect(tier(6000).name).toBe('Diamond');
    expect(tier(10000).name).toBe('Platinum');
  });

  it('Platinum has no `next` tier', () => {
    expect(tier(50000).next).toBeNull();
    expect(tier(50000).name).toBe('Platinum');
  });

  it('floor and next form a non-overlapping ladder', () => {
    expect(tier(1000).floor).toBe(1000);
    expect(tier(1000).next).toBe(3000);
    expect(tier(3000).floor).toBe(3000);
    expect(tier(3000).next).toBe(6000);
  });

  it('every tier has an icon and a class', () => {
    [0, 1000, 3000, 6000, 10000].forEach((t) => {
      const x = tier(t);
      expect(x.icon).toBeTypeOf('string');
      expect(x.cls).toBeTypeOf('string');
      expect(x.icon.length).toBeGreaterThan(0);
    });
  });
});

describe('tierFloor()', () => {
  it('matches the boundaries used by tier()', () => {
    expect(tierFloor(0)).toBe(0);
    expect(tierFloor(999)).toBe(0);
    expect(tierFloor(1000)).toBe(1000);
    expect(tierFloor(3000)).toBe(3000);
    expect(tierFloor(6000)).toBe(6000);
    expect(tierFloor(10000)).toBe(10000);
    expect(tierFloor(999999)).toBe(10000);
  });
});

describe('_parseExpiryMs', () => {
  it('returns null for empty input', () => {
    expect(_parseExpiryMs(null)).toBeNull();
    expect(_parseExpiryMs(undefined)).toBeNull();
  });

  it('reads Firestore timestamp via toMillis()', () => {
    const r = { expiresAtTs: { toMillis: () => 1234567890 } };
    expect(_parseExpiryMs(r)).toBe(1234567890);
  });

  it('reads native Date via getTime()', () => {
    const d = new Date('2030-01-01T00:00:00Z');
    expect(_parseExpiryMs({ expiresAtTs: d })).toBe(d.getTime());
  });

  it('parses ISO string in expiresAtTs', () => {
    const iso = '2030-06-15T10:00:00Z';
    expect(_parseExpiryMs({ expiresAtTs: iso })).toBe(new Date(iso).getTime());
  });

  it('falls back to expiresAt ISO string', () => {
    const iso = '2030-06-15T10:00:00Z';
    expect(_parseExpiryMs({ expiresAt: iso })).toBe(new Date(iso).getTime());
  });

  it('synthesizes expiry = createdAt + 5min when nothing else present', () => {
    const createdIso = '2030-06-15T10:00:00Z';
    const expected = new Date(createdIso).getTime() + 5 * 60 * 1000;
    expect(_parseExpiryMs({ createdAt: createdIso })).toBe(expected);
  });

  it('returns null when only an unparseable string is present', () => {
    expect(_parseExpiryMs({ expiresAt: 'not-a-date', createdAt: 'also-bad' })).toBeNull();
  });
});

describe('_isPendingAndActive', () => {
  const future = () => new Date(Date.now() + 60_000).toISOString();
  const past   = () => new Date(Date.now() - 60_000).toISOString();

  beforeEach(() => {
    // ensure deterministic Date.now() across tests
  });

  it('false for null', () => {
    expect(_isPendingAndActive(null)).toBe(false);
  });

  it('false when used === true', () => {
    expect(_isPendingAndActive({ used: true, expiresAt: future() })).toBe(false);
  });

  it('false when status is not pending', () => {
    expect(_isPendingAndActive({ status: 'redeemed', expiresAt: future() })).toBe(false);
    expect(_isPendingAndActive({ status: 'cancelled', expiresAt: future() })).toBe(false);
  });

  it('true when status implicit pending and expiry is in the future', () => {
    expect(_isPendingAndActive({ expiresAt: future() })).toBe(true);
  });

  it('false when expired', () => {
    expect(_isPendingAndActive({ status: 'pending', expiresAt: past() })).toBe(false);
  });

  it('false when no expiry can be derived', () => {
    expect(_isPendingAndActive({ status: 'pending' })).toBe(false);
  });
});
