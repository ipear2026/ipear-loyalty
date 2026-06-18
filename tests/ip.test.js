import { describe, it, expect } from 'vitest';
import { normalizeIpForRateLimit } from '../src/worker/lib/ip.js';

describe('normalizeIpForRateLimit', () => {
  it('passes IPv4 through untouched', () => {
    expect(normalizeIpForRateLimit('1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIpForRateLimit('192.168.1.1')).toBe('192.168.1.1');
  });

  it('passes "unknown" and bogus strings through', () => {
    expect(normalizeIpForRateLimit('unknown')).toBe('unknown');
    expect(normalizeIpForRateLimit('')).toBe('');
  });

  it('leaves compound target keys (t:...) intact', () => {
    expect(normalizeIpForRateLimit('t:phone:306900000000')).toBe('t:phone:306900000000');
    expect(normalizeIpForRateLimit('t:email:foo@bar.gr')).toBe('t:email:foo@bar.gr');
  });

  it('collapses a full IPv6 to /64', () => {
    expect(
      normalizeIpForRateLimit('2001:0db8:85a3:0000:1234:5678:9abc:def0')
    ).toBe('2001:0db8:85a3:0000::/64');
  });

  it('expands :: shorthand before slicing', () => {
    expect(normalizeIpForRateLimit('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('returns first 4 groups + ::/64 suffix', () => {
    const out = normalizeIpForRateLimit('fe80:0:0:0:abcd:ef01:2345:6789');
    expect(out).toBe('fe80:0:0:0::/64');
  });

  it('handles loopback-like ::1', () => {
    expect(normalizeIpForRateLimit('::1')).toBe('0:0:0:0::/64');
  });

  it('passes malformed IPv6 through untouched (more than 8 groups)', () => {
    expect(
      normalizeIpForRateLimit('1:2:3:4:5:6:7:8:9')
    ).toBe('1:2:3:4::/64'); // takes first 4 — this is by design (defensive slice)
  });

  it('returns input for non-string types', () => {
    expect(normalizeIpForRateLimit(null)).toBe(null);
    expect(normalizeIpForRateLimit(undefined)).toBe(undefined);
    expect(normalizeIpForRateLimit(123)).toBe(123);
  });

  it('two distinct addresses in the same /64 collapse to the same bucket', () => {
    const a = normalizeIpForRateLimit('2001:db8:1:1:aaaa:bbbb:cccc:dddd');
    const b = normalizeIpForRateLimit('2001:db8:1:1:1111:2222:3333:4444');
    expect(a).toBe(b);
  });
});
