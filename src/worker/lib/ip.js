// Collapse an IPv6 address to its /64 prefix for rate-limiting bucket keys.
//
// HIGH-4: a single IPv6 client typically owns an entire /64 prefix for free.
// Bucketing per full 128-bit address gives an attacker 2^64 buckets and zero
// effective rate limit. /64 is the smallest assignment most ISPs hand out.
//
// IPv4, "unknown", and compound target keys (anything starting with "t:")
// pass through untouched.
export function normalizeIpForRateLimit(ip) {
  if (!ip || typeof ip !== 'string') return ip;
  if (!ip.includes(':')) return ip;
  if (ip.startsWith('t:')) return ip;
  try {
    let s = ip;
    if (s.includes('::')) {
      const [left, right] = s.split('::', 2);
      const leftParts  = left  ? left.split(':')  : [];
      const rightParts = right ? right.split(':') : [];
      const missing    = 8 - leftParts.length - rightParts.length;
      if (missing < 0) return ip;
      const fill = new Array(missing).fill('0');
      s = [...leftParts, ...fill, ...rightParts].join(':');
    }
    const parts = s.split(':');
    if (parts.length < 4) return ip;
    return parts.slice(0, 4).join(':') + '::/64';
  } catch (_) {
    return ip;
  }
}
