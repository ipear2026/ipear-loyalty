// ═══════════════════════════════════════════════════════════════════════════
//  iPear Loyalty — Cloudflare Worker  (Email + Push Notifications)
// ═══════════════════════════════════════════════════════════════════════════
//
//  Environment Variables (Settings → Variables στο Cloudflare):
//
//  ADMIN_SECRET      → το μυστικό σου, π.χ. "ipear-secret-2024-xyz"
//  BREVO_API_KEY     → API key από brevo.com
//  SENDER_EMAIL      → επαληθευμένο email στο Brevo, π.χ. "loyalty@ipear.gr"
//  SENDER_NAME       → "iPear Loyalty"
//  BREVO_SMS_SENDER  → Αποστολέας SMS (max 11 χαρακτήρες), π.χ. "iPear"
//  FCM_CLIENT_EMAIL  → firebase-adminsdk-fbsvc@loyalty-ipear.iam.gserviceaccount.com
//  FCM_PRIVATE_KEY   → ολόκληρο το private key (με \n)
//  FCM_PROJECT_ID    → loyalty-ipear  (REQUIRED — no fallback)
//  ALLOWED_ORIGINS   → comma-separated list, e.g. "https://loyalty.ipear.gr"
//                      defaults to "https://loyalty.ipear.gr" if unset
//
//  APP_URL           → e.g. "https://loyalty.ipear.gr" (used for welcome email CTA link)
//
//  ENDPOINTS:
//  POST /                → αποστολή bulk email (Brevo) — requires ADMIN_SECRET
//  POST /sms             → αποστολή SMS (Brevo Transactional SMS) — requires ADMIN_SECRET
//  POST /bulk-sms        → μαζική αποστολή SMS (Brevo) — requires ADMIN_SECRET
//  POST /push            → αποστολή push notifications (FCM V1) — requires ADMIN_SECRET
//  POST /admin/redeem-attempt → brute-force guard for redemption approval — requires ADMIN_SECRET
//  POST /woo-add-points    → WooCommerce integration: add loyalty points on order — requires ADMIN_SECRET
//  POST /woo-refund-points → WooCommerce: clawback loyalty points on order refund — requires ADMIN_SECRET
//  POST /woo-get-user      → WooCommerce: fetch customer points/name by email — requires ADMIN_SECRET
//  POST /woo-create-coupon  → Create real WooCommerce coupon for e-shop offer redemption — requires ADMIN_SECRET
//  POST /woo-sync-tier      → Sync VIP tier to WooCommerce user meta — public, Firebase ID token auth, rate-limited
//  POST /reset-password  → branded password reset email (public, no secret needed)
//  POST /send-welcome    → welcome email after registration (public, rate-limited)
//  POST /send-sms-otp    → Brevo SMS fallback OTP (public, rate-limited)
//  POST /verify-sms-otp  → verify Brevo OTP code (public, rate-limited)
//  POST /client-error    → client-side error telemetry (public, rate-limited, fire-and-forget)
//  POST /log-event       → zero-cookie funnel analytics: anonymous event counters (public, rate-limited)
//  POST /admin/export-backup → cross-cloud backup: read-only customer data snapshot (requires ADMIN_SECRET)
//  GET  /health-deep     → deep health check: Worker + Brevo + Firestore (requires ADMIN_SECRET)
// ═══════════════════════════════════════════════════════════════════════════

import { normalizeIpForRateLimit } from './src/worker/lib/ip.js';
import { normalizeGreekSMS } from './src/worker/lib/sms.js';
import {
  makeRedeemRateKey, makeFailKey, makeBlockKey,
} from './src/worker/lib/redeem-keys.js';

const MAX_RECIPIENTS = 5000;
const MAX_TOKENS     = 5000;

// ── H-4: Rate limiter for public endpoints (in-memory, per-isolate) ──────
// Limits requests per IP. Resets on cold start but blocks burst abuse.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_HITS  = 5;               // max 5 reset requests per IP per window
const _rateBuckets = new Map();

// Separate bucket for /process-referral (1 call per registration, not shared with reset-password)
const REFERRAL_RATE_MAX = 3;
const _referralBuckets = new Map();

const REDEEM_FAIL_LIMIT = 5;
const REDEEM_BLOCK_TTL_SECONDS = 15 * 60; // block for 15 minutes
const REDEEM_FAIL_TTL_SECONDS = 15 * 60;  // keep the fail counter for 15 minutes
// REDEEM_FAIL_KEY_PREFIX / REDEEM_BLOCK_KEY_PREFIX imported from worker/lib/redeem-keys.js

function _isRateLimited(ip) {
  const now = Date.now();
  const bucket = _rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    _rateBuckets.set(ip, { windowStart: now, hits: 1 });
    return false;
  }
  bucket.hits++;
  if (bucket.hits > RATE_LIMIT_MAX_HITS) return true;
  return false;
}

// ── MEDIUM-6: Fail-CLOSED KV rate limiter ───────────────────────────────
// KV-backed rate limiter — survives cold starts. If KV is unreachable we
// FAIL CLOSED (treat the request as rate-limited) instead of falling back to
// the leaky per-isolate in-memory map. KV outages are rare; silently degrading
// to a near-no-op limiter under attack is worse than a brief 503.
//
// Returns: { limited: boolean, reason?: 'kv-unavailable' | 'rate-exceeded' }
// Callers should treat `limited === true` as a hard 503/429.
// normalizeIpForRateLimit imported from worker/lib/ip.js (HIGH-4 IPv6 /64 collapse)

async function isRateLimitedKV(env, ip, prefix, maxHits, windowSeconds) {
  if (!env.RATE_LIMIT_KV) {
    console.error('[rate-limit] FAIL-CLOSED: RATE_LIMIT_KV binding missing');
    return { limited: true, reason: 'kv-unavailable' };
  }
  const key = `rl:${prefix}:${normalizeIpForRateLimit(ip)}`;
  try {
    const raw = await env.RATE_LIMIT_KV.get(key);
    const now = Date.now();
    let bucket = raw ? JSON.parse(raw) : null;
    if (!bucket || now - bucket.s > windowSeconds * 1000) {
      bucket = { s: now, h: 1 };
    } else {
      bucket.h++;
    }
    await env.RATE_LIMIT_KV.put(key, JSON.stringify(bucket), { expirationTtl: windowSeconds });
    return { limited: bucket.h > maxHits, reason: bucket.h > maxHits ? 'rate-exceeded' : undefined };
  } catch (e) {
    console.error('[rate-limit] FAIL-CLOSED: KV error:', e.message);
    return { limited: true, reason: 'kv-unavailable' };
  }
}

// Rate-limit-or-block helper. Returns a 503 Response if KV is unavailable
// (fail-closed), a 429 Response if the IP is rate-limited, or null if the
// call may proceed. Caller pattern:
//   const _rl = await rateLimitOrBlock(env, ip, 'otp', 5, 900, CORS);
//   if (_rl) return _rl;
async function rateLimitOrBlock(env, ip, prefix, maxHits, windowSeconds, CORS, customMsg) {
  const r = await isRateLimitedKV(env, ip, prefix, maxHits, windowSeconds);
  if (!r.limited) return null;
  if (r.reason === 'kv-unavailable') {
    return resp({ error: 'Service temporarily unavailable' }, 503, CORS);
  }
  return resp({ error: customMsg || 'Too many requests' }, 429, CORS);
}

// HIGH-4: compound rate limit (IP /64 + per-target). Use on cost-sensitive
// public endpoints where a single attacker rotating IPv6 across a /64 should
// not be able to drain a paid resource (SMS, transactional email) against a
// single victim email/phone.
//
// targetKey examples: 'phone:306900000000', 'email:victim@example.com'.
// The IP and target buckets are checked sequentially against the same window
// and threshold — if EITHER is over the limit, we 429. Two KV writes per call.
async function _rateLimitCompound(env, ip, targetKey, prefix, maxHits, windowSeconds, CORS, customMsg) {
  const ipRes = await rateLimitOrBlock(env, ip, prefix, maxHits, windowSeconds, CORS, customMsg);
  if (ipRes) return ipRes;
  if (!targetKey) return null;
  const tgtRes = await rateLimitOrBlock(env, 't:' + targetKey, prefix, maxHits, windowSeconds, CORS, customMsg);
  return tgtRes;
}

// ── MEDIUM-5: Capped JSON body reader ──────────────────────────────────
// All unauthenticated public endpoints MUST use this instead of request.json().
// Cloudflare's 100 MB default is far too generous for our APIs.
//
// Throws an Error with .status (413 for too-large, 400 for malformed JSON)
// that callers translate into a JSON error response.
async function readJsonCapped(request, maxBytes = 16 * 1024) {
  const cl = parseInt(request.headers.get('content-length') || '0', 10);
  if (Number.isFinite(cl) && cl > maxBytes) {
    const e = new Error('payload too large');
    e.status = 413;
    throw e;
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    const e = new Error('payload too large');
    e.status = 413;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error('Invalid JSON');
    e.status = 400;
    throw e;
  }
}

// makeRedeemRateKey / makeFailKey / makeBlockKey imported from worker/lib/redeem-keys.js

async function getRedeemFailState(env, failKey) {
  if (!env.RATE_LIMIT_KV) return { fails: 0, firstFailAt: 0 };
  const raw = await env.RATE_LIMIT_KV.get(failKey);
  if (!raw) return { fails: 0, firstFailAt: 0 };
  try {
    const parsed = JSON.parse(raw);
    return {
      fails: Number(parsed.fails) || 0,
      firstFailAt: Number(parsed.firstFailAt) || 0,
    };
  } catch {
    return { fails: 0, firstFailAt: 0 };
  }
}

async function saveRedeemFailState(env, failKey, state) {
  if (!env.RATE_LIMIT_KV) return;
  await env.RATE_LIMIT_KV.put(failKey, JSON.stringify(state), { expirationTtl: REDEEM_FAIL_TTL_SECONDS });
}

async function clearRedeemRateLimit(env, failKey, blockKey) {
  if (!env.RATE_LIMIT_KV) return;
  await env.RATE_LIMIT_KV.delete(failKey);
  await env.RATE_LIMIT_KV.delete(blockKey);
}

async function isRedeemBlocked(env, blockKey) {
  if (!env.RATE_LIMIT_KV) return false;
  return (await env.RATE_LIMIT_KV.get(blockKey)) !== null;
}

function _isReferralRateLimited(ip) {
  const now = Date.now();
  const bucket = _referralBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    _referralBuckets.set(ip, { windowStart: now, hits: 1 });
    return false;
  }
  bucket.hits++;
  return bucket.hits > REFERRAL_RATE_MAX;
}

// Periodically prune stale entries (keep maps from growing unbounded)
function pruneRateBuckets() {
  const now = Date.now();
  for (const [ip, b] of _rateBuckets) {
    if (now - b.windowStart > RATE_LIMIT_WINDOW_MS) _rateBuckets.delete(ip);
  }
  for (const [ip, b] of _referralBuckets) {
    if (now - b.windowStart > RATE_LIMIT_WINDOW_MS) _referralBuckets.delete(ip);
  }
  for (const [ip, b] of _checkRegBuckets) {
    if (now - b.windowStart > RATE_LIMIT_WINDOW_MS) _checkRegBuckets.delete(ip);
  }
  for (const [ph, ts] of _otpBuckets) {
    if (now - ts > OTP_PHONE_COOLDOWN_MS * 2) _otpBuckets.delete(ph);
  }
  // KV-leak fix: _logEventBuckets is isolate-local now (was KV-backed); prune
  // it on the same schedule so it doesn't grow unbounded per isolate lifetime.
  for (const [ip, b] of _logEventBuckets) {
    if (now - b.windowStart > RATE_LIMIT_WINDOW_MS) _logEventBuckets.delete(ip);
  }
}

export default {
  // ── Cron Trigger: runs /health-deep every 30 minutes ──
  async scheduled(event, env, _ctx) {
    console.log('[cron] health-deep check triggered at', new Date().toISOString());
    const fakeUrl = 'https://worker/health-deep';
    const fakeReq = new Request(fakeUrl, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + (env.ADMIN_SECRET || '') }
    });
    const result = await handleHealthDeep(fakeReq, env, {});
    const body = await result.json();
    console.log('[cron] health-deep result:', JSON.stringify(body));
  },

  async fetch(request, env, ctx) {

    // ── CORS — restrict to configured origins only ─────────────────────────
    const allowedOrigins = (env.ALLOWED_ORIGINS || 'https://loyalty.ipear.gr,https://ipear-loyalty.pages.dev')
      .split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

    const CORS = {
      'Access-Control-Allow-Origin':  corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // Reject requests from disallowed origins outright
    if (origin && !allowedOrigins.includes(origin)) {
      return resp({ error: 'Forbidden' }, 403, CORS);
    }

    // ── GET /health — lightweight health check (no auth needed) ───────────
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') {
      return resp({
        status: 'ok',
        service: 'iPear Email Worker',
        timestamp: new Date().toISOString(),
      }, 200, { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    }

    // ── GET /health-deep — deep health check: Brevo + Firestore (requires ADMIN_SECRET) ──
    if (request.method === 'GET' && path === '/health-deep') {
      return handleHealthDeep(request, env, CORS);
    }

    // ── GET /sw-kill — Service Worker kill switch (checked by SW on activate) ──
    // Returns { nuke: true } if KV key "sw_kill" is set to "true".
    // To activate: wrangler kv:key put --namespace-id=9b7bfd14b586445db94e932a75635f85 "sw_kill" "true"
    // To deactivate: wrangler kv:key delete --namespace-id=9b7bfd14b586445db94e932a75635f85 "sw_kill"
    if (request.method === 'GET' && path === '/sw-kill') {
      let nuke = false;
      if (env.RATE_LIMIT_KV) {
        try { nuke = (await env.RATE_LIMIT_KV.get('sw_kill')) === 'true'; } catch(_) {}
      }
      return resp({ nuke, ts: new Date().toISOString() }, 200,
        { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store' });
    }

    // ── MEDIUM-1: GET /admin/export-download — HMAC-signed R2 streaming ──
    //  Routed BEFORE the POST-only gate; the signature in the URL IS the
    //  credential (no ADMIN_SECRET in the link), so the admin can paste the
    //  link into a browser tab and the file downloads via standard GET.
    if (request.method === 'GET' && path === '/admin/export-download') {
      return handleExportDownload(request, env, {
        ...CORS,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      });
    }

    if (request.method !== 'POST') return resp({ error: 'Method not allowed' }, 405, CORS);

    // Public endpoints (no ADMIN_SECRET needed, rate-limited)
    if (path === '/reset-password') return handleResetPassword(request, env, CORS);
    if (path === '/check-registration') return handleCheckRegistration(request, env, CORS);
    if (path === '/process-referral') return handleProcessReferral(request, env, CORS);
    if (path === '/send-welcome') return handleSendWelcome(request, env, CORS);
    if (path === '/send-verification-link') return handleSendVerificationLink(request, env, CORS);
    if (path === '/send-sms-otp') return handleSendSmsOtp(request, env, CORS);
    if (path === '/verify-sms-otp') return handleVerifySmsOtp(request, env, CORS);
    if (path === '/woo-sync-tier')   return handleWooSyncTier(request, env, CORS);
    if (path === '/client-error')    return handleClientError(request, env, CORS);
    if (path === '/log-event')       return handleLogEvent(request, env, CORS, ctx);
    // /push has DUAL-mode auth handled inside the handler:
    //   • ADMIN_SECRET → broadcast to any tokens array (admin marketing blasts)
    //   • idToken      → self-push only, server resolves caller's own fcmToken
    //                    from Firestore (so the SPA's enable-push confirmation
    //                    works without exposing the broadcast surface).
    // Routed BEFORE the central ADMIN_SECRET gate so the idToken branch isn't
    // pre-rejected.
    if (path === '/push')       return handlePush(request, env, CORS);

    // All other endpoints require ADMIN_SECRET
    const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!env.ADMIN_SECRET || !(await timingSafeEqual(auth, env.ADMIN_SECRET))) {
      return resp({ error: 'Unauthorized' }, 401, CORS);
    }

    if (path === '/push-debug') return handlePushDebug(request, env, CORS);
    if (path === '/bulk-sms') return handleBulkSMS(request, env, CORS);
    if (path === '/woo-create-coupon') return handleWooCreateCoupon(request, env, CORS);
    if (path === '/sms')      return handleSMS(request, env, CORS);
    if (path === '/admin/redeem-attempt') return handleRedeemAttempt(request, env, CORS);
    if (path === '/admin/delete-auth-user') return handleDeleteAuthUser(request, env, CORS);
    if (path === '/admin/create-admin-user') return handleCreateAdminUser(request, env, CORS);
    if (path === '/admin/export-backup') return handleExportBackup(request, env, CORS);
    if (path === '/woo-add-points')   return handleWooAddPoints(request, env, CORS, ctx);
    if (path === '/woo-refund-points') return handleWooRefundPoints(request, env, CORS);
    if (path === '/woo-get-user')    return handleWooGetUser(request, env, CORS);
    return handleEmail(request, env, CORS);
  }
};

// ══════════════════════════════════════════════════════════════════════════
//  SMS OTP — Brevo fallback when Firebase Phone Auth fails
//
//  POST /send-sms-otp   { phone: "6974498720" }   → sends 6-digit OTP via Brevo
//  POST /verify-sms-otp { phone: "6974498720", code: "123456" } → verifies OTP
//
//  Public endpoints, rate-limited per IP + per phone.
//  OTP stored in RATE_LIMIT_KV with 5-minute TTL.
// ══════════════════════════════════════════════════════════════════════════
const OTP_TTL_SECONDS = 300;        // 5 minutes
const OTP_MAX_VERIFY_ATTEMPTS = 5;  // max wrong codes before lockout
const _otpBuckets = new Map();      // in-memory rate limit per phone
const OTP_PHONE_COOLDOWN_MS = 60_000; // 1 OTP per phone per 60s

// SEC-FIX H-2: KV-backed phone cooldown (survives cold starts)
async function isOtpRateLimited(phone, env) {
  const now = Date.now();
  // In-memory fast check
  const last = _otpBuckets.get(phone);
  if (last && now - last < OTP_PHONE_COOLDOWN_MS) return true;
  _otpBuckets.set(phone, now);
  // KV-backed check (survives cold starts)
  if (env && env.RATE_LIMIT_KV) {
    const kvKey = `otp-cd:${phone}`;
    const existing = await env.RATE_LIMIT_KV.get(kvKey);
    if (existing) return true;
    await env.RATE_LIMIT_KV.put(kvKey, '1', { expirationTtl: Math.ceil(OTP_PHONE_COOLDOWN_MS / 1000) });
  }
  return false;
}

async function handleSendSmsOtp(request, env, CORS) {
  // ── Validate env ──
  if (!env.BREVO_API_KEY) return resp({ error: 'SMS not configured' }, 503, CORS);
  if (!env.RATE_LIMIT_KV) return resp({ error: 'OTP storage not configured' }, 503, CORS);

  // ── IP rate limit (KV-backed — survives cold starts) ──
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  pruneRateBuckets();
  { const _rl = await rateLimitOrBlock(env, ip, 'otp', RATE_LIMIT_MAX_HITS, 900, CORS, 'Πολλές προσπάθειες. Δοκίμασε σε λίγα λεπτά.'); if (_rl) return _rl; }

  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const rawPhone = String(body.phone || '').replace(/[\s\-()]/g, '');
  if (!rawPhone || !/^6\d{9}$/.test(rawPhone))
    return resp({ error: 'Μη έγκυρος αριθμός (π.χ. 6912345678)' }, 400, CORS);

  // ── HIGH-4: per-phone window limit (5 per 15 min) — defeats IPv6 rotation
  //    targeting a single victim phone. Complements the 60s per-phone cooldown
  //    (in-memory + KV) below, which throttles burst rate; this throttles
  //    aggregate volume per phone across a wider window.
  { const _rl = await rateLimitOrBlock(env, 't:phone:' + rawPhone, 'otp', RATE_LIMIT_MAX_HITS, 900, CORS, 'Πολλές προσπάθειες για αυτό το νούμερο.'); if (_rl) return _rl; }

  // ── Per-phone cooldown (1 per 60s, KV-backed) ──
  if (await isOtpRateLimited(rawPhone, env))
    return resp({ error: 'Ήδη εστάλη OTP. Περίμενε 60 δευτερόλεπτα.' }, 429, CORS);

  // ── Generate 6-digit OTP (crypto-secure) ──
  const _rnd = new Uint32Array(1);
  crypto.getRandomValues(_rnd);
  const code = String(100000 + (_rnd[0] % 900000));
  const kvKey = `otp:${rawPhone}`;

  // ── Store in KV with TTL ──
  await env.RATE_LIMIT_KV.put(kvKey, JSON.stringify({
    code,
    attempts: 0,
    createdAt: Date.now(),
  }), { expirationTtl: OTP_TTL_SECONDS });

  // ── Send via Brevo SMS API ──
  const intl = '+30' + rawPhone;
  const sender = (env.BREVO_SMS_SENDER || 'iPear').slice(0, 11);
  const content = `iPear: Kodikos ${code}. Isxyei 5 lepta.`;

  try {
    const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender,
        recipient: intl,
        content,
        type: 'transactional',
        unicodeEnabled: false,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[send-sms-otp] Brevo error:', JSON.stringify(data));
      return resp({ error: 'Αποτυχία αποστολής SMS: ' + (data.message || res.status) }, 502, CORS);
    }
    console.log('[send-sms-otp] sent to', intl, 'messageId:', data.messageId);
    return resp({ ok: true, phone: rawPhone }, 200, CORS);
  } catch(e) {
    console.error('[send-sms-otp] fetch error:', e.message);
    return resp({ error: 'Σφάλμα αποστολής SMS' }, 502, CORS);
  }
}

async function handleVerifySmsOtp(request, env, CORS) {
  if (!env.RATE_LIMIT_KV) return resp({ error: 'OTP storage not configured' }, 503, CORS);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  { const _rl = await rateLimitOrBlock(env, ip, 'otp-verify', RATE_LIMIT_MAX_HITS, 900, CORS, 'Πολλές προσπάθειες. Δοκίμασε σε λίγα λεπτά.'); if (_rl) return _rl; }

  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const rawPhone = String(body.phone || '').replace(/[\s\-()]/g, '');
  const userCode = String(body.code || '').trim();
  const email    = String(body.email || '').trim().toLowerCase();
  if (!rawPhone || !userCode) return resp({ error: 'phone and code required' }, 400, CORS);

  const kvKey = `otp:${rawPhone}`;
  const raw = await env.RATE_LIMIT_KV.get(kvKey);
  if (!raw) return resp({ error: 'Ο κωδικός έληξε ή δεν υπάρχει. Ζήτα νέο SMS.' }, 410, CORS);

  let stored;
  try { stored = JSON.parse(raw); }
  catch { return resp({ error: 'Σφάλμα server' }, 500, CORS); }

  // ── Too many wrong attempts ──
  if (stored.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
    await env.RATE_LIMIT_KV.delete(kvKey);
    return resp({ error: 'Πολλές λάθος προσπάθειες. Ζήτα νέο SMS.' }, 429, CORS);
  }

  // ── Check code (timing-safe) ──
  if (!(await timingSafeEqual(userCode, stored.code))) {
    stored.attempts++;
    await env.RATE_LIMIT_KV.put(kvKey, JSON.stringify(stored), { expirationTtl: OTP_TTL_SECONDS });
    const remaining = OTP_MAX_VERIFY_ATTEMPTS - stored.attempts;
    return resp({ error: `Λάθος κωδικός. ${remaining} προσπάθειες ακόμα.`, remaining }, 401, CORS);
  }

  // ── Success — delete OTP ──
  await env.RATE_LIMIT_KV.delete(kvKey);
  console.log('[verify-sms-otp] ✅ verified', rawPhone);

  // ── Phone-OTP receipt: lets /send-welcome and /process-referral grant
  //    the +50 / +100 bonuses to the Brevo OTP signup path, where the Auth
  //    user is created via email/password and has no `phoneNumber` claim.
  //    Without this, the phone-claim gate (round-3 hardening) blocks every
  //    Brevo signup from receiving bonuses. The receipt key is the phone
  //    itself, so the bonus endpoints can verify by reading the customer
  //    doc's phone field. 30-day TTL is generous enough for retries while
  //    bounded for KV hygiene. Direct-REST signUp attackers without a real
  //    OTP still get 403'd because no receipt exists for their phone.
  try {
    await env.RATE_LIMIT_KV.put(
      `phone-otp:${rawPhone}`,
      JSON.stringify({ at: Date.now() }),
      { expirationTtl: 30 * 86400 }
    );
  } catch (recErr) {
    console.warn('[verify-sms-otp] phone-otp receipt write failed (non-fatal):', recErr.message);
  }

  // ── BUGFIX: clean up orphan Firebase Auth users that admin deletion left behind ──
  // Scenario: admin deletes a customer → Firestore wiped but Auth user remained
  // (e.g., worker secret was missing on admin's machine). Now the customer tries
  // to re-register with the same email. createUserWithEmailAndPassword would fail
  // with auth/email-already-in-use even though no customer data exists.
  // Safe to clean up because:
  //   - phone OTP just verified (proves caller controls the phone)
  //   - We only delete the Auth user if NO Firestore customer doc exists for that email
  //   - The deleted Auth user has no PII attached (admin already wiped Firestore)
  let orphanCleaned = false;
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 &&
      env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY && env.FCM_PROJECT_ID) {
    try {
      const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
      const projectId = env.FCM_PROJECT_ID;
      // 1. Check Firestore — if there's an active customer doc for this email, do NOT touch Auth
      const fsRes = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'ipear_customers' }],
            where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
            select: { fields: [{ fieldPath: 'email' }] },
            limit: 1
          }
        })
      });
      let hasActiveCustomer = false;
      if (fsRes.ok) {
        const results = await fsRes.json();
        hasActiveCustomer = Array.isArray(results) && results.length > 0 && !!results[0].document;
      }
      if (!hasActiveCustomer) {
        // 2. Lookup Auth user by email
        const lookupRes = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
          body: JSON.stringify({ email: [email] })
        });
        if (lookupRes.ok) {
          const lookup = await lookupRes.json();
          const orphan = (lookup?.users && lookup.users[0]) || null;
          if (orphan?.localId) {
            // 2b. CRITICAL SAFETY: admins are NOT in ipear_customers — they live
            // in ipear_admins keyed by UID. Without this check the previous
            // version would happily delete admin Auth accounts that someone
            // typed into a registration form. Look up the UID in ipear_admins
            // before deleting; if found, this is NOT an orphan.
            const adminCheckRes = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ipear_admins/${orphan.localId}`, {
              headers: { 'Authorization': 'Bearer ' + accessToken }
            });
            if (adminCheckRes.ok) {
              // 200 + document body == admin doc exists. Refuse to delete.
              console.warn('[verify-sms-otp] 🛑 refused to delete — uid', orphan.localId, 'is in ipear_admins (email:', email + ')');
            } else if (adminCheckRes.status !== 404) {
              // Unexpected Firestore error — fail closed (do NOT delete)
              console.error('[verify-sms-otp] admin lookup error', adminCheckRes.status, '— refusing delete');
            } else {
              // 404 == no admin doc with this UID. Safe to treat as orphan.
              const delRes = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
                body: JSON.stringify({ localId: orphan.localId })
              });
              if (delRes.ok) {
                orphanCleaned = true;
                console.log('[verify-sms-otp] 🧹 cleaned orphan auth user for', email);
              }
            }
          }
        }
      }
    } catch(cleanupErr) {
      console.warn('[verify-sms-otp] orphan cleanup failed (non-fatal):', cleanupErr.message);
    }
  }

  return resp({ ok: true, verified: true, phone: rawPhone, orphanCleaned }, 200, CORS);
}

// ══════════════════════════════════════════════════════════════════════════
//  GSM-7 SMS NORMALIZER
//  Strips accents from Greek, uppercases everything → fits in 160-char GSM-7
//  instead of 70-char UCS-2.
// ══════════════════════════════════════════════════════════════════════════
// normalizeGreekSMS imported from worker/lib/sms.js (GSM-7 transliteration)

// ══════════════════════════════════════════════════════════════════════════
//  WELCOME EMAIL — sent after customer self-registration
//
//  POST /send-welcome  { email, name, points }
//  Public endpoint, rate-limited per IP.
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
//  HIGH-4: /send-welcome — authenticated, server-derived identity.
//
//  Previously: caller supplied {email, name, customerId, marketingOptIn} with
//  no auth check. An attacker could (a) send iPear-branded welcome emails to
//  any inbox (phishing pretext) and (b) write a +50 "Marketing Bonus"
//  transaction attributed to ANY customerId.
//
//  Now: caller MUST supply a fresh Firebase idToken. We verify it server-side
//  and TRUST ONLY the verified email + UID. The body's email/customerId must
//  match the token-derived values exactly (defence-in-depth — prevents the
//  client from accidentally passing the wrong UID).
//
//  Also adds the marketing-bonus +50 to the customer's authoritative points
//  balance (atomic Firestore transaction) — not just a ledger row — so the
//  app shows the correct total immediately. Idempotent: if the customer
//  already has `marketingWelcomeProcessed: true`, the credit is skipped.
// ══════════════════════════════════════════════════════════════════════════
// Republishes ipear_leaderboard/latest from the worker. The customer app
// reads this doc and uses it to render the top-N. Previously only the admin
// app republished it (on loadAll / add / redeem), so customers who earned
// points purely through worker-driven flows (welcome bonus, referrals) were
// invisible on the board until an admin happened to open the dashboard.
// That manifested as a "phantom" pinned "Εσύ" row tied with whoever last
// held #10. Best-effort: never throws, never blocks the caller.
async function republishLeaderboardFromWorker(env, accessToken) {
  try {
    const projectId = env.FCM_PROJECT_ID;
    const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const queryRes = await fetch(`${fsBase}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'ipear_customers' }],
          orderBy: [{ field: { fieldPath: 'totalPoints' }, direction: 'DESCENDING' }],
          limit: 100
        }
      })
    });
    if (!queryRes.ok) return;
    const rows = await queryRes.json();
    const lbAll = [];
    for (const row of (rows || [])) {
      const f = row.document?.fields;
      if (!f) continue;
      if (f.blocked?.booleanValue === true) continue;
      lbAll.push({
        name: f.name?.stringValue || '—',
        points: Number(f.points?.integerValue || 0),
        totalPoints: Number(f.totalPoints?.integerValue || 0),
        card: f.card?.stringValue || '',
      });
    }
    lbAll.sort((a, b) => b.totalPoints - a.totalPoints || (a.name || '').localeCompare(b.name || '', 'el'));
    const top20 = lbAll.slice(0, 20).map(c => ({
      name: (c.name || '').split(' ').map((w, i) => i === 0 ? w : (w[0] || '') + '.').join(' '),
      points: c.points,
      totalPoints: c.totalPoints,
      card: c.card,
    }));

    const lbFields = {
      top: { arrayValue: { values: top20.map(c => ({ mapValue: { fields: {
        name:        { stringValue: c.name || '' },
        points:      { integerValue: c.points || 0 },
        totalPoints: { integerValue: c.totalPoints || 0 },
        card:        { stringValue: c.card || '' },
      }}})) }},
      total:     { integerValue: lbAll.length },
      updatedAt: { stringValue: new Date().toISOString() },
    };
    await fetch(`${fsBase}/ipear_leaderboard/latest`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
      body: JSON.stringify({ fields: lbFields })
    });
  } catch (e) {
    console.warn('[leaderboard] worker republish failed (non-fatal):', e.message);
  }
}

// Helper used by /send-welcome and /process-referral to check the Brevo
// OTP receipt left by /verify-sms-otp. Reads the customer doc to find the
// phone number, then checks `phone-otp:{phone}` in KV. Returns true if a
// fresh OTP receipt exists. accessToken must be a service-account access
// token so the customer doc read bypasses Firestore rules.
async function hasPhoneOtpReceipt(env, uid, accessToken) {
  if (!env.RATE_LIMIT_KV) return false;
  try {
    const projectId = env.FCM_PROJECT_ID;
    const docRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ipear_customers/${uid}`,
      { headers: { 'Authorization': 'Bearer ' + accessToken } }
    );
    if (!docRes.ok) return false;
    const docJson = await docRes.json();
    const rawPhone = String(docJson?.fields?.phone?.stringValue || '').replace(/[\s\-()]/g, '');
    if (!/^6\d{9}$/.test(rawPhone)) return false;
    const receipt = await env.RATE_LIMIT_KV.get(`phone-otp:${rawPhone}`);
    return !!receipt;
  } catch (e) {
    console.warn('[phone-otp-receipt] check failed:', e.message);
    return false;
  }
}

async function handleSendWelcome(request, env, CORS) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  { const _rl = await rateLimitOrBlock(env, ip, 'welcome', RATE_LIMIT_MAX_HITS, 900, CORS); if (_rl) return _rl; }

  let body;
  try { body = await readJsonCapped(request, 4 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  // 1. Require + verify Firebase ID token (HIGH-4)
  const idToken = (body.idToken || '').trim();
  if (!idToken) return resp({ error: 'idToken required' }, 401, CORS);

  if (!env.FIREBASE_API_KEY || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'Server not configured' }, 503, CORS);
  if (!env.BREVO_API_KEY)
    return resp({ error: 'Email not configured' }, 503, CORS);

  let verifiedEmail, verifiedUid;
  try {
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    const verifyData = await verifyRes.json();
    const u = verifyData?.users?.[0];
    if (!u?.localId || !u?.email) return resp({ error: 'Invalid token' }, 401, CORS);
    // Phone-verification gate. SMS OTP at signup is the sole identity check.
    // We accept EITHER:
    //   (a) Firebase Auth user has a phoneNumber claim — set when registration
    //       used Firebase Phone Auth (signInWithPhoneNumber + linkCredential).
    //   (b) A fresh `phone-otp:{phone}` receipt exists in KV for the customer
    //       doc's phone — set by /verify-sms-otp when the Brevo OTP path is
    //       used. The Brevo path creates an email/password-only Auth user, so
    //       phoneNumber is empty even though a real SMS OTP was just verified.
    //
    // A direct-REST signUp attacker (email+password, no SMS) has neither: no
    // phoneNumber on the Auth record, and no OTP receipt for any phone they
    // could put in the customer doc. They still get 403'd, closing the
    // bonus-mint + phishing-reflector path the original CRIT-1 fix defended
    // against.
    verifiedUid   = u.localId;
    verifiedEmail = String(u.email).trim().toLowerCase();
    const hasPhone = typeof u.phoneNumber === 'string' && u.phoneNumber.length > 0;
    if (!hasPhone) {
      const accessTokenForCheck = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
      const hasReceipt = await hasPhoneOtpReceipt(env, verifiedUid, accessTokenForCheck);
      if (!hasReceipt) {
        return resp({ error: 'phone-not-verified' }, 403, CORS);
      }
    }
  } catch (e) {
    console.error('[send-welcome] token verify failed:', e.message);
    return resp({ error: 'Token verification failed' }, 401, CORS);
  }

  // 2. Body fields — trust only NAME from the body (no token claim for it).
  //    email/customerId, if provided, MUST match server-verified values.
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) return resp({ error: 'name required' }, 400, CORS);

  if (body.email && String(body.email).trim().toLowerCase() !== verifiedEmail) {
    return resp({ error: 'email mismatch' }, 403, CORS);
  }
  if (body.customerId && String(body.customerId).trim() !== verifiedUid) {
    return resp({ error: 'customerId mismatch' }, 403, CORS);
  }
  const marketingOptIn = !!body.marketingOptIn;

  // 3. CRITICAL-2 pair: server-side awards the +50 marketing bonus FIRST,
  //    independent of email-send success. Previously the bonus was credited
  //    only after a successful Brevo email send — when Brevo failed (quota,
  //    transient error, invalid sender), the worker returned 502 and the
  //    +50 was silently dropped. Customer-facing impact: zero points despite
  //    a clear marketing opt-in. The bonus is the contractual promise; the
  //    email is a nice-to-have. Atomic + idempotent via marketingWelcomeProcessed.
  let bonusAwarded = false;
  if (marketingOptIn) {
      try {
        const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
        const projectId  = env.FCM_PROJECT_ID;
        const fsBase     = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
        const fsHeaders  = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };
        const custPath   = `${fsBase}/ipear_customers/${verifiedUid}`;

        // Begin Firestore transaction (atomic R-M-W on the customer doc)
        const beginRes = await fetch(`${fsBase}:beginTransaction`, {
          method: 'POST', headers: fsHeaders, body: JSON.stringify({})
        });
        if (!beginRes.ok) throw new Error('beginTransaction failed: ' + beginRes.status);
        const { transaction } = await beginRes.json();

        const readRes = await fetch(`${custPath}?transaction=${encodeURIComponent(transaction)}`, { headers: fsHeaders });
        if (!readRes.ok) throw new Error('transactional read failed: ' + readRes.status);
        const custDoc = await readRes.json();
        const fields  = custDoc.fields || {};

        // Idempotency guard — never credit twice
        if (fields.marketingWelcomeProcessed?.booleanValue === true) {
          console.log('[send-welcome] marketing bonus already processed for', verifiedUid);
        } else {
          const curPts = Number(fields.points?.integerValue || 0);
          const curTot = Number(fields.totalPoints?.integerValue || 0);
          const newFields = {
            ...custDoc.fields,
            points:                    { integerValue: curPts + 50 },
            totalPoints:               { integerValue: curTot + 50 },
            marketingWelcomeProcessed: { booleanValue: true },
            marketingWelcomeAt:        { stringValue: new Date().toISOString() },
          };

          const commitRes = await fetch(`${fsBase}:commit`, {
            method: 'POST', headers: fsHeaders,
            body: JSON.stringify({
              transaction,
              writes: [{
                update: { name: custDoc.name, fields: newFields },
                updateMask: { fieldPaths: ['points', 'totalPoints', 'marketingWelcomeProcessed', 'marketingWelcomeAt'] }
              }]
            })
          });
          if (!commitRes.ok) throw new Error('commit failed: ' + commitRes.status);

          // Ledger row (non-blocking — a failure here doesn't roll back the credit)
          const card = fields.card?.stringValue || '';
          const txRes = await fetch(`${fsBase}/ipear_transactions`, {
            method: 'POST', headers: fsHeaders,
            body: JSON.stringify({ fields: {
              customerId:    { stringValue: verifiedUid },
              customerUid:   { stringValue: verifiedUid },
              customerEmail: { stringValue: verifiedEmail },
              customerName:  { stringValue: name },
              card:          { stringValue: card },
              type:          { stringValue: 'add' },
              points:        { integerValue: 50 },
              amount:        { doubleValue: 0 },
              category:      { stringValue: '🎁 Marketing Bonus' },
              note:          { stringValue: 'Εγγραφή με αποδοχή marketing επικοινωνίας (+50 πόντοι)' },
              date:          { stringValue: new Date().toISOString() }
            }})
          });
          if (!txRes.ok) console.error('[send-welcome] marketing TX log failed:', txRes.status);
          else console.log('[send-welcome] ✅ marketing +50 credited to', verifiedUid);
          bonusAwarded = true;
          await republishLeaderboardFromWorker(env, accessToken);
        }
      } catch (txErr) {
        console.error('[send-welcome] marketing credit error:', txErr.message);
        // Don't fail the response — the idempotency guard above lets the
        // client retry safely on the next /send-welcome call (e.g. next login).
      }
    }

  // 4. Send the welcome email — best-effort, never blocks the bonus.
  //    A Brevo failure (quota, transient 5xx, sender misconfig) must NOT
  //    silently drop the +50 customer-facing credit; the email is the
  //    nice-to-have, the points are the contract.
  try {
    const appUrl = (env.APP_URL || 'https://loyalty.ipear.gr') + '/customer.html';
    const displayPoints = marketingOptIn ? 50 : 0;
    const htmlContent = buildWelcomeEmail(name, displayPoints, appUrl);

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key':      env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body: JSON.stringify({
        sender: {
          name:  env.SENDER_NAME  || 'iPear Loyalty',
          email: (env.SENDER_EMAIL || '').trim(),
        },
        to: [{ email: verifiedEmail, name }],
        subject: '🍐 Καλώς ήρθες στο iPear Loyalty!',
        htmlContent,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[send-welcome] Brevo error (non-fatal):', res.status, err?.message || '');
    } else {
      console.log('[send-welcome] ✅ sent to', verifiedEmail);
    }
  } catch (mailErr) {
    console.error('[send-welcome] email fetch failed (non-fatal):', mailErr.message);
  }

  return resp({ ok: true, bonusAwarded }, 200, CORS);
}

// ══════════════════════════════════════════════════════════════════════════
//  POST /send-verification-link  { idToken }
//
//  Public endpoint. Caller is anyone with a fresh Firebase ID token for the
//  account they JUST registered. We do NOT require emailVerified — that's
//  the whole point: the user is about to verify.
//
//  Sends a branded verification email via Brevo. Content is conditional:
//   • If customer doc has marketingOptIn===true AND !marketingWelcomeProcessed
//     → show "+50 πόντοι καλωσορίσματος"
//   • If ipear_referral_queue/{uid} exists with processed!==true
//     → show "+100 πόντοι παραπομπής"
//   • If neither → plain "verify your email" copy (no bonus copy at all)
//
//  Rate limits:
//   • Per-IP   : RATE_LIMIT_MAX_HITS / 15 min  (anti-bomb from one host)
//   • Per-email: RATE_LIMIT_MAX_HITS / 15 min  (anti-bomb of a single inbox)
//  Returns 200 ok:true alreadyVerified:true if user is already verified
//  (so the client can hide the banner).
// ══════════════════════════════════════════════════════════════════════════
async function handleSendVerificationLink(request, env, CORS) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  { const _rl = await rateLimitOrBlock(env, ip, 'verify-link', RATE_LIMIT_MAX_HITS, 900, CORS); if (_rl) return _rl; }

  let body;
  try { body = await readJsonCapped(request, 4 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const idToken = (body.idToken || '').trim();
  if (!idToken) return resp({ error: 'idToken required' }, 401, CORS);

  if (!env.FIREBASE_API_KEY || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'Server not configured' }, 503, CORS);
  if (!env.BREVO_API_KEY)
    return resp({ error: 'Email not configured' }, 503, CORS);

  // 1. Verify the token. Note: we do NOT require emailVerified — this is the
  //    only Worker endpoint that an unverified user must be able to call.
  let verifiedEmail, verifiedUid, displayName = '';
  try {
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    const verifyData = await verifyRes.json();
    const u = verifyData?.users?.[0];
    if (!u?.localId || !u?.email) return resp({ error: 'Invalid token' }, 401, CORS);
    if (u.emailVerified === true) return resp({ ok: true, alreadyVerified: true }, 200, CORS);
    verifiedUid   = u.localId;
    verifiedEmail = String(u.email).trim().toLowerCase();
    displayName   = String(u.displayName || '').trim();
  } catch (e) {
    console.error('[send-verification-link] token verify failed:', e.message);
    return resp({ error: 'Token verification failed' }, 401, CORS);
  }

  // 2. Per-email rate limit — protects a single inbox from being bombed via
  //    IPv6 rotation. Compounds with the per-IP limit above.
  { const _rl = await rateLimitOrBlock(env, 't:email:' + verifiedEmail, 'verify-link', RATE_LIMIT_MAX_HITS, 900, CORS, 'Πολλές αιτήσεις. Περίμενε λίγο.'); if (_rl) return _rl; }

  // 3. Read customer doc + referral queue to decide what bonuses to show.
  //    Failures here only affect copy — they do NOT block sending.
  let hasMarketingBonus = false;
  let hasReferralBonus  = false;
  try {
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const projectId   = env.FCM_PROJECT_ID;
    const fsBase      = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const fsHeaders   = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

    // Customer doc → marketing eligibility
    const custRes = await fetch(`${fsBase}/ipear_customers/${verifiedUid}`, { headers: fsHeaders });
    if (custRes.ok) {
      const custDoc = await custRes.json();
      const f = custDoc.fields || {};
      const marketingOptIn      = f.marketingOptIn?.booleanValue === true;
      const marketingProcessed  = f.marketingWelcomeProcessed?.booleanValue === true;
      hasMarketingBonus = marketingOptIn && !marketingProcessed;
      if (!displayName) displayName = String(f.name?.stringValue || '').trim();
    }

    // Referral queue doc → referral eligibility
    const queueRes = await fetch(`${fsBase}/ipear_referral_queue/${verifiedUid}`, { headers: fsHeaders });
    if (queueRes.ok) {
      const qDoc = await queueRes.json();
      const f = qDoc.fields || {};
      const processed = f.processed?.booleanValue === true;
      hasReferralBonus = !processed;
    }
  } catch (e) {
    console.error('[send-verification-link] Firestore read failed (non-fatal):', e.message);
  }

  // 4. Generate the Firebase verification link via Admin REST API.
  //    continueUrl uses the Pages alias (always allowlisted) — `loyalty.ipear.gr`
  //    is not currently registered as an authorized domain in Firebase Auth.
  let verifyUrl;
  try {
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const oobRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
        body: JSON.stringify({
          requestType:    'VERIFY_EMAIL',
          idToken,
          returnOobLink:  true,
          continueUrl:    'https://ipear-loyalty.pages.dev/?verified=1',
        }),
      }
    );
    if (!oobRes.ok) {
      const err = await oobRes.json().catch(() => ({}));
      console.error('[send-verification-link] sendOobCode failed:', oobRes.status, JSON.stringify(err));
      return resp({ error: 'Verification link generation failed' }, 502, CORS);
    }
    const oobData = await oobRes.json();
    verifyUrl = oobData.oobLink;
    if (!verifyUrl) return resp({ error: 'No link returned' }, 502, CORS);
  } catch (e) {
    console.error('[send-verification-link] OOB error:', e.message);
    return resp({ error: 'Link generation failed' }, 502, CORS);
  }

  // 5. Build + send the branded email via Brevo.
  const htmlContent = buildVerificationEmail(displayName || 'φίλε', verifyUrl, hasMarketingBonus, hasReferralBonus);
  const subject = (hasMarketingBonus || hasReferralBonus)
    ? '🍐 iPear Loyalty — Ξεκλείδωσε τα bonuses σου'
    : '🍐 iPear Loyalty — Επιβεβαίωσε το email σου';

  try {
    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key':      env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body: JSON.stringify({
        sender: {
          name:  env.SENDER_NAME  || 'iPear Loyalty',
          email: (env.SENDER_EMAIL || '').trim(),
        },
        to:      [{ email: verifiedEmail, name: displayName || '' }],
        subject,
        htmlContent,
      }),
    });
    if (!brevoRes.ok) {
      const err = await brevoRes.json().catch(() => ({}));
      console.error('[send-verification-link] Brevo error:', brevoRes.status, JSON.stringify(err));
      return resp({ error: 'Email send failed' }, 502, CORS);
    }
    console.log(`[send-verification-link] ✅ sent to ${verifiedEmail}, mk=${hasMarketingBonus} ref=${hasReferralBonus}`);
    return resp({ ok: true, hasMarketingBonus, hasReferralBonus }, 200, CORS);
  } catch (e) {
    console.error('[send-verification-link] Brevo network:', e.message);
    return resp({ error: 'Email send failed' }, 502, CORS);
  }
}

function buildVerificationEmail(name, link, hasMarketing, hasReferral) {
  const safeName = escHtml(name);
  const safeLink = escHtml(link);

  const bonuses = [];
  if (hasMarketing) bonuses.push('+50 πόντοι καλωσορίσματος');
  if (hasReferral)  bonuses.push('+100 πόντοι από την παραπομπή σου');

  const hasAnyBonus = bonuses.length > 0;
  const intro = hasAnyBonus
    ? 'Είσαι ένα κλικ μακριά από τα bonuses σου! Επιβεβαίωσε το email για να ξεκλειδώσεις:'
    : 'Επιβεβαίωσε το email σου για να ολοκληρώσεις την εγγραφή σου στο iPear Loyalty.';
  const ctaLabel = hasAnyBonus ? 'Ξεκλείδωσε τα Bonuses →' : 'Επιβεβαίωση email →';

  const bonusList = !hasAnyBonus ? '' : (
    '<div style="background:#f8fbef;border-left:4px solid #8ae900;border-radius:10px;padding:18px 22px;margin:18px 0">' +
    bonuses.map(t => `<div style="margin:6px 0;font-size:.95rem;color:#222;line-height:1.4"><span style="color:#6bb800;font-weight:900">✅</span>  ${escHtml(t)}</div>`).join('') +
    '</div>'
  );

  return `<!DOCTYPE html>
<html lang="el">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>iPear Loyalty — Επιβεβαίωση email</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#222">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.10)">
      <tr>
        <td style="background:linear-gradient(135deg,#6bb800 0%,#8ae900 100%);padding:36px 40px;text-align:center">
          <div style="font-size:30px;font-weight:900;color:#0a0a0a;letter-spacing:-1px;line-height:1">🍐 iPear<span style="color:#fff">Loyalty</span></div>
          <div style="font-size:11px;color:rgba(0,0,0,.55);margin-top:6px;text-transform:uppercase;letter-spacing:3px;font-weight:700">Loyalty Program</div>
        </td>
      </tr>
      <tr>
        <td style="padding:32px 40px 36px;line-height:1.55">
          <h2 style="margin:0 0 12px;font-size:1.35rem;color:#111;font-weight:800">Γεια σου ${safeName}! 👋</h2>
          <p style="margin:0;font-size:.96rem;color:#444">${intro}</p>
          ${bonusList}
          <div style="text-align:center;margin:30px 0 24px">
            <a href="${safeLink}" style="display:inline-block;background:#8ae900;color:#0a0a0a;font-weight:900;font-size:1rem;padding:16px 38px;border-radius:11px;text-decoration:none;letter-spacing:.3px;box-shadow:0 4px 14px rgba(138,233,0,.35)">${ctaLabel}</a>
          </div>
          <p style="margin:0;font-size:.85rem;color:#666;text-align:center">Το link λήγει σε <strong>1 ώρα</strong>.</p>
          <p style="margin:22px 0 0;font-size:.78rem;color:#999;border-top:1px solid #eee;padding-top:14px;text-align:center">Δεν εγγράφηκες στο iPear Loyalty; Αγνόησε αυτό το email — δεν θα γίνει καμία αλλαγή.</p>
        </td>
      </tr>
      <tr>
        <td style="background:#fafafa;padding:16px 40px;text-align:center;color:#999;font-size:.75rem">iPear · <a href="https://ipear.gr" style="color:#999;text-decoration:none">ipear.gr</a> · <a href="mailto:info@ipear.gr" style="color:#999;text-decoration:none">info@ipear.gr</a></td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function buildWelcomeEmail(name, points, appUrl) {
  const safeName = escHtml(name);
  const safeUrl  = appUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="el">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Καλώς ήρθες — iPear Loyalty</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 0">
  <tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0"
         style="max-width:600px;width:100%;background:#ffffff;border-radius:22px;
                overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.10)">

    <!-- HEADER -->
    <tr>
      <td style="background:linear-gradient(135deg,#6bb800 0%,#8ae900 100%);padding:40px 44px;text-align:center">
        <div style="font-size:36px;font-weight:900;color:#0a0a0a;letter-spacing:-1.5px;line-height:1">
          iPear<span style="color:#ffffff">Loyalty</span>
        </div>
        <div style="font-size:12px;color:rgba(0,0,0,.45);margin-top:8px;
                    text-transform:uppercase;letter-spacing:4px;font-weight:600">
          Loyalty Program
        </div>
      </td>
    </tr>

    <!-- ICON -->
    <tr>
      <td style="padding:36px 44px 0;text-align:center">
        <div style="display:inline-block;width:80px;height:80px;line-height:80px;
                    font-size:42px;background:#f0ffe0;border-radius:50%;
                    border:2.5px solid #8ae900;text-align:center">
          🎉
        </div>
      </td>
    </tr>

    <!-- BODY -->
    <tr>
      <td style="padding:24px 44px 32px">
        <h1 style="font-size:24px;font-weight:800;color:#0a0a0a;margin:0 0 8px;
                   line-height:1.3;text-align:center">
          Καλώς ήρθες, ${safeName}!
        </h1>
        <p style="font-size:15px;color:#666;line-height:1.7;margin:0 0 24px;text-align:center">
          Χαιρόμαστε που είσαι μαζί μας! 🍐<br>
          Ο λογαριασμός σου στο <strong>iPear Loyalty</strong> είναι έτοιμος.
        </p>

        <!-- Points badge -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
          <tr>
            <td style="background:#f0ffe0;border:2px solid #8ae900;border-radius:16px;
                       padding:24px;text-align:center">
              <div style="font-size:11px;color:#666;text-transform:uppercase;
                          letter-spacing:2px;font-weight:700;margin-bottom:8px">
                Οι πρώτοι σου πόντοι
              </div>
              <div style="font-size:56px;font-weight:900;color:#5a9900;line-height:1;
                          letter-spacing:-2px">
                ${points}
              </div>
              <div style="font-size:13px;color:#888;margin-top:8px;font-weight:600">
                iPear Loyalty Points 🍐
              </div>
            </td>
          </tr>
        </table>

        <p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 28px;text-align:center">
          Μάζεψε πόντους με κάθε αγορά σου<br>
          και εξαργύρωσέ τους για <strong>εκπτώσεις</strong>!
        </p>

        <!-- CTA BUTTON -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
          <tr>
            <td align="center">
              <a href="${safeUrl}" target="_blank"
                 style="display:inline-block;background:linear-gradient(135deg,#6bb800,#8ae900);
                        color:#0a0a0a;text-decoration:none;font-weight:800;font-size:16px;
                        padding:16px 48px;border-radius:14px;letter-spacing:.3px;
                        box-shadow:0 4px 18px rgba(107,184,0,.35)">
                🍐 Δες το Προφίλ σου
              </a>
            </td>
          </tr>
        </table>

        <!-- Tips -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="background:#f8f9fa;border-radius:12px;padding:18px 20px">
              <p style="font-size:13px;color:#555;margin:0;line-height:1.7">
                <strong>💡 Πώς κερδίζω πόντους;</strong><br>
                ✅ Κάνε αγορές στο κατάστημα iPear<br>
                ✅ Πρόσκαλε φίλους με το referral link (+100 πόντοι)<br>
                ✅ 1.000 πόντοι = 5€ έκπτωση!
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- DIVIDER -->
    <tr>
      <td style="padding:0 44px">
        <div style="height:1px;background:#eeeeee"></div>
      </td>
    </tr>

    <!-- FOOTER -->
    <tr>
      <td style="background:#fafafa;padding:24px 44px;text-align:center;border-radius:0 0 22px 22px">
        <p style="font-size:12px;color:#aaaaaa;margin:0;line-height:1.8">
          © iPear Loyalty Program 🍐<br>
          <span style="color:#cccccc">Αυτό το email στάλθηκε αυτόματα. Δεν χρειάζεται απάντηση.</span>
        </p>
      </td>
    </tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  POST /woo-get-user  { email }
//  Admin-only endpoint — returns customer loyalty data by email.
//  Used by WooCommerce "My Account" tab to show points & name.
// ══════════════════════════════════════════════════════════════════════════
async function handleWooGetUser(request, env, CORS) {
  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return resp({ error: 'Valid email required' }, 400, CORS);

  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'Server not configured' }, 503, CORS);

  try {
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const projectId = env.FCM_PROJECT_ID;
    const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const fsHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

    const queryRes = await fetch(`${fsBase}:runQuery`, {
      method: 'POST', headers: fsHeaders,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'ipear_customers' }],
          where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
          select: { fields: [
            { fieldPath: 'name' }, { fieldPath: 'points' },
            { fieldPath: 'totalPoints' }, { fieldPath: 'card' }
          ]},
          limit: 1
        }
      })
    });
    const results = await queryRes.json();
    const doc = Array.isArray(results) && results[0]?.document;
    if (!doc) return resp({ error: 'Customer not found' }, 404, CORS);

    const f = doc.fields || {};
    return resp({
      ok: true,
      name: f.name?.stringValue || '',
      points: Number(f.points?.integerValue || 0),
      totalPoints: Number(f.totalPoints?.integerValue || 0),
      card: f.card?.stringValue || '',
    }, 200, CORS);

  } catch (e) {
    console.error('[woo-get-user]', e.message);
    return resp({ error: 'Internal error' }, 500, CORS);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  POST /woo-add-points  { email, orderTotal }
//  Admin-only endpoint called by WooCommerce plugin on order completion.
//  Converts euros → points (1€ = 10 πόντοι), updates customer, creates
//  transaction, and publishes leaderboard.
// ══════════════════════════════════════════════════════════════════════════
async function handleWooAddPoints(request, env, CORS, ctx) {
  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const email = (body.email || '').trim().toLowerCase();
  const orderTotal = parseFloat(body.orderTotal);
  const orderId = String(body.orderId || '').replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 64);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return resp({ error: 'Valid email required' }, 400, CORS);
  if (isNaN(orderTotal) || orderTotal <= 0)
    return resp({ error: 'orderTotal must be > 0' }, 400, CORS);
  if (orderTotal > 100000)
    return resp({ error: 'orderTotal exceeds maximum' }, 400, CORS);

  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'Server not configured' }, 503, CORS);

  try {
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const projectId = env.FCM_PROJECT_ID;
    const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const fsHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

    // 1. Find customer by email
    const queryRes = await fetch(`${fsBase}:runQuery`, {
      method: 'POST', headers: fsHeaders,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'ipear_customers' }],
          where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
          limit: 1
        }
      })
    });
    const results = await queryRes.json();
    const doc = Array.isArray(results) && results[0]?.document;
    if (!doc) return resp({ error: 'Customer not found' }, 404, CORS);

    const docId = doc.name.split('/').pop();
    const docPath = `${fsBase}/ipear_customers/${docId}`;
    const fields = doc.fields || {};

    // 2. Calculate points: 1€ = 10 πόντοι
    //    Authoritative totals come from the transactional re-read below;
    //    no need to capture pre-transaction values here.
    const earnedPoints = Math.floor(orderTotal * 10);

    // 3. Atomic update via Firestore transaction (prevents race condition on concurrent orders)
    const beginRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:beginTransaction`,
      { method: 'POST', headers: fsHeaders, body: JSON.stringify({}) }
    );
    if (!beginRes.ok) {
      console.error('[woo-add-points] beginTransaction failed:', beginRes.status);
      return resp({ error: 'Failed to start transaction' }, 500, CORS);
    }
    const { transaction } = await beginRes.json();

    // Re-read inside transaction to get latest points
    const txReadRes = await fetch(`${docPath}?transaction=${encodeURIComponent(transaction)}`, { headers: fsHeaders });
    if (!txReadRes.ok) {
      console.error('[woo-add-points] transactional read failed:', txReadRes.status);
      return resp({ error: 'Failed to read customer in transaction' }, 500, CORS);
    }
    const txDoc = await txReadRes.json();
    const txFields = txDoc.fields || {};
    const txPts = Number(txFields.points?.integerValue || 0) + earnedPoints;
    const txTot = Number(txFields.totalPoints?.integerValue || 0) + earnedPoints;

    const commitRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`,
      {
        method: 'POST', headers: fsHeaders,
        body: JSON.stringify({
          transaction,
          writes: [{
            update: {
              name: txDoc.name,
              fields: { ...txDoc.fields, points: { integerValue: txPts }, totalPoints: { integerValue: txTot } }
            },
            updateMask: { fieldPaths: ['points', 'totalPoints'] }
          }]
        })
      }
    );
    if (!commitRes.ok) {
      console.error('[woo-add-points] commit failed:', commitRes.status, await commitRes.text());
      return resp({ error: 'Failed to update points' }, 500, CORS);
    }

    // 4. Create transaction record
    const txRes = await fetch(`${fsBase}/ipear_transactions`, {
      method: 'POST', headers: fsHeaders,
      body: JSON.stringify({ fields: {
        customerId: { stringValue: docId },
        customerEmail: { stringValue: email },
        customerName: { stringValue: fields.name?.stringValue || '' },
        card: { stringValue: fields.card?.stringValue || '' },
        type: { stringValue: 'add' },
        points: { integerValue: earnedPoints },
        amount: { doubleValue: orderTotal },
        category: { stringValue: '🛒 Αγορά από E-shop' },
        note: { stringValue: orderId ? `WooCommerce Order #${orderId}` : 'WooCommerce Order' },
        date: { stringValue: new Date().toISOString() }
      }})
    });
    if (!txRes.ok) {
      console.error('[woo-add-points] TX create failed:', txRes.status, await txRes.text());
    }

    // 5. Publish leaderboard — ASYNC via ctx.waitUntil() (decoupled from response)
    //    The full-collection query is heavy; we return 200 OK immediately and let
    //    the leaderboard rebuild finish in the background without blocking WooCommerce.
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(_rebuildLeaderboard(fsBase, fsHeaders));
    } else {
      // Fallback: if ctx not available (e.g. unit tests), run inline
      _rebuildLeaderboard(fsBase, fsHeaders).catch(e => console.warn('[leaderboard-fallback]', e.message));
    }

    return resp({
      ok: true,
      email,
      earnedPoints,
      newBalance: txPts,
      newTotalPoints: txTot,
      orderId: orderId || undefined,
    }, 200, CORS);

  } catch (e) {
    console.error('[woo-add-points]', e.message, e.stack);
    return resp({ error: 'Internal error' }, 500, CORS);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  POST /woo-refund-points  { email, orderTotal, orderId }
//  Admin-only endpoint called by WooCommerce plugin on order refund.
//  Reverses the points previously earned: claws back Math.floor(orderTotal * 10) pts.
//  Points cannot go below 0. Creates a negative transaction record for audit trail.
// ══════════════════════════════════════════════════════════════════════════
async function handleWooRefundPoints(request, env, CORS) {
  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const email = (body.email || '').trim().toLowerCase();
  const orderTotal = parseFloat(body.orderTotal);
  const orderId = String(body.orderId || '').replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 64);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return resp({ error: 'Valid email required' }, 400, CORS);
  if (isNaN(orderTotal) || orderTotal <= 0)
    return resp({ error: 'orderTotal must be > 0' }, 400, CORS);
  if (orderTotal > 100000)
    return resp({ error: 'orderTotal exceeds maximum' }, 400, CORS);

  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'Server not configured' }, 503, CORS);

  try {
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const projectId = env.FCM_PROJECT_ID;
    const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const fsHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

    // 1. Find customer by email
    const queryRes = await fetch(`${fsBase}:runQuery`, {
      method: 'POST', headers: fsHeaders,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'ipear_customers' }],
          where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
          limit: 1
        }
      })
    });
    const results = await queryRes.json();
    const doc = Array.isArray(results) && results[0]?.document;
    if (!doc) return resp({ error: 'Customer not found' }, 404, CORS);

    const docId = doc.name.split('/').pop();
    const fields = doc.fields || {};

    // 2. Calculate points to claw back (same formula as add: 1€ = 10 pts)
    const pointsToRemove = Math.floor(orderTotal * 10);

    // 3. Atomic update via Firestore transaction (prevent race condition)
    const beginRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:beginTransaction`,
      { method: 'POST', headers: fsHeaders, body: JSON.stringify({}) }
    );
    if (!beginRes.ok) {
      console.error('[woo-refund-points] beginTransaction failed:', beginRes.status);
      return resp({ error: 'Failed to start transaction' }, 500, CORS);
    }
    const { transaction } = await beginRes.json();

    // Re-read inside transaction for atomic consistency
    const txReadRes = await fetch(`${fsBase}/ipear_customers/${docId}?transaction=${encodeURIComponent(transaction)}`, { headers: fsHeaders });
    if (!txReadRes.ok) {
      console.error('[woo-refund-points] transactional read failed:', txReadRes.status);
      return resp({ error: 'Failed to read customer in transaction' }, 500, CORS);
    }
    const txDoc = await txReadRes.json();
    const txFields = txDoc.fields || {};
    const currentPts = Number(txFields.points?.integerValue || 0);
    const currentTot = Number(txFields.totalPoints?.integerValue || 0);
    // Clamp to 0 — never go negative
    const newPts = Math.max(0, currentPts - pointsToRemove);
    const newTot = Math.max(0, currentTot - pointsToRemove);
    const actualDeducted = currentPts - newPts;

    const commitRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`,
      {
        method: 'POST', headers: fsHeaders,
        body: JSON.stringify({
          transaction,
          writes: [{
            update: {
              name: txDoc.name,
              fields: { ...txDoc.fields, points: { integerValue: newPts }, totalPoints: { integerValue: newTot } }
            },
            updateMask: { fieldPaths: ['points', 'totalPoints'] }
          }]
        })
      }
    );
    if (!commitRes.ok) {
      console.error('[woo-refund-points] commit failed:', commitRes.status, await commitRes.text());
      return resp({ error: 'Failed to update points' }, 500, CORS);
    }

    // 4. Create transaction record (negative points for audit trail)
    const txRes = await fetch(`${fsBase}/ipear_transactions`, {
      method: 'POST', headers: fsHeaders,
      body: JSON.stringify({ fields: {
        customerId: { stringValue: docId },
        customerEmail: { stringValue: email },
        customerName: { stringValue: fields.name?.stringValue || '' },
        card: { stringValue: fields.card?.stringValue || '' },
        type: { stringValue: 'refund_clawback' },
        points: { integerValue: -actualDeducted },
        amount: { doubleValue: orderTotal },
        category: { stringValue: '🔄 E-shop Επιστροφή' },
        note: { stringValue: orderId ? `WooCommerce Refund — Order #${orderId}` : 'WooCommerce Refund' },
        date: { stringValue: new Date().toISOString() }
      }})
    });
    if (!txRes.ok) {
      console.error('[woo-refund-points] TX create failed:', txRes.status, await txRes.text());
    }

    // Rebuild leaderboard after refund (inline — no ctx.waitUntil available)
    _rebuildLeaderboard(fsBase, fsHeaders).catch(e => console.warn('[refund-leaderboard]', e.message));

    return resp({
      ok: true,
      email,
      pointsRemoved: actualDeducted,
      newBalance: newPts,
      newTotalPoints: newTot,
      orderId: orderId || undefined,
    }, 200, CORS);

  } catch (e) {
    console.error('[woo-refund-points]', e.message, e.stack);
    return resp({ error: 'Internal error' }, 500, CORS);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  POST /woo-create-coupon  { idToken, offerTitle, discountType, discountAmount, singleUse }
//  Public endpoint — authenticated via Firebase ID token.
//  Creates a real WooCommerce coupon via REST API.
//  Requires env: WOO_URL, WOO_KEY, WOO_SECRET, FIREBASE_API_KEY
// ══════════════════════════════════════════════════════════════════════════
async function handleWooCreateCoupon(request, env, CORS) {
  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const idToken = (body.idToken || '').trim();
  if (!idToken) return resp({ error: 'idToken required' }, 400, CORS);

  const offerTitle = String(body.offerTitle || '').trim().slice(0, 100);
  const discountType = ['percent', 'fixed_cart'].includes(body.discountType) ? body.discountType : 'percent';
  // SEC-FIX: cap discount — percent max 50%, fixed_cart max 100€
  const maxDiscount = discountType === 'percent' ? 50 : 100;
  const discountAmount = Math.max(0, Math.min(parseFloat(body.discountAmount) || 0, maxDiscount));
  const singleUse = !!body.singleUse;

  if (discountAmount <= 0)
    return resp({ error: 'discountAmount must be > 0' }, 400, CORS);

  // SEC-FIX: rate limit coupon creation per IP
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  { const _rl = await rateLimitOrBlock(env, ip, 'woo-coupon', 3, 3600, CORS, 'Too many coupon requests. Try again later.'); if (_rl) return _rl; }

  if (!env.FIREBASE_API_KEY || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'Server not configured' }, 503, CORS);
  if (!env.WOO_URL || !env.WOO_KEY || !env.WOO_SECRET)
    return resp({ error: 'WooCommerce API not configured (WOO_URL, WOO_KEY, WOO_SECRET)' }, 503, CORS);

  try {
    // 1. Verify Firebase ID token → get caller UID + email
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    const verifyData = await verifyRes.json();
    const callerUid = verifyData?.users?.[0]?.localId;
    if (!callerUid) return resp({ error: 'Invalid token' }, 401, CORS);

    // 2. Look up customer email from Firestore
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const projectId = env.FCM_PROJECT_ID;
    const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const fsHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

    const custRes = await fetch(`${fsBase}/ipear_customers/${callerUid}`, { headers: fsHeaders });
    if (!custRes.ok) return resp({ error: 'Customer not found' }, 404, CORS);
    const custDoc = await custRes.json();
    const email = (custDoc.fields?.email?.stringValue || '').trim().toLowerCase();
    if (!email) return resp({ error: 'Customer has no email' }, 400, CORS);

    // 3. Create WooCommerce coupon
    const rnd = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map(b => b.toString(36)).join('').toUpperCase().slice(0, 6);
    const code = 'IPEAR-' + rnd;

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);
    const expiryStr = expiry.toISOString().split('T')[0];

    const wooBase = env.WOO_URL.replace(/\/+$/, '');
    const wooAuth = btoa(env.WOO_KEY + ':' + env.WOO_SECRET);

    const couponPayload = {
      code,
      discount_type: discountType,
      amount: String(discountAmount),
      individual_use: true,
      usage_limit: singleUse ? 1 : 0,
      email_restrictions: [email],
      date_expires: expiryStr,
      description: 'iPear Loyalty: ' + offerTitle,
    };

    const wooRes = await fetch(wooBase + '/wp-json/wc/v3/coupons', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + wooAuth,
      },
      body: JSON.stringify(couponPayload),
    });

    if (!wooRes.ok) {
      const errBody = await wooRes.text();
      console.error('[woo-create-coupon] WooCommerce API error:', wooRes.status, errBody);
      return resp({ error: 'WooCommerce API error: ' + wooRes.status }, 502, CORS);
    }

    const wooCoupon = await wooRes.json();

    // 4. Log redemption in Firestore
    const redemptionDoc = {
      fields: {
        code:           { stringValue: wooCoupon.code || code },
        offerId:        { stringValue: offerTitle },
        offerTitle:     { stringValue: offerTitle },
        customerId:     { stringValue: callerUid },
        customerEmail:  { stringValue: email },
        discountType:   { stringValue: discountType },
        discountAmount: { doubleValue: discountAmount },
        channel:        { stringValue: 'eshop' },
        status:         { stringValue: 'created' },
        used:           { booleanValue: false },
        createdAt:      { stringValue: new Date().toISOString() },
        expiresAt:      { stringValue: expiryStr },
      }
    };
    await fetch(`${fsBase}/ipear_offer_redemptions`, {
      method: 'POST', headers: fsHeaders, body: JSON.stringify(redemptionDoc),
    });

    return resp({
      ok: true,
      code: wooCoupon.code || code,
      discountType,
      discountAmount,
      expiresAt: expiryStr,
    }, 200, CORS);

  } catch (e) {
    console.error('[woo-create-coupon]', e.message, e.stack);
    return resp({ error: 'Internal error' }, 500, CORS);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  POST /woo-sync-tier  { idToken, tier, totalPoints }
//  Public endpoint — authenticated via Firebase ID token.
//  Updates WooCommerce user meta with VIP tier.
//  Requires env: WOO_URL, WOO_KEY, WOO_SECRET, FIREBASE_API_KEY
// ══════════════════════════════════════════════════════════════════════════
async function handleWooSyncTier(request, env, CORS) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  { const _rl = await rateLimitOrBlock(env, ip, 'woo-sync', RATE_LIMIT_MAX_HITS, 900, CORS); if (_rl) return _rl; }

  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const idToken = (body.idToken || '').trim();
  if (!idToken) return resp({ error: 'idToken required' }, 400, CORS);

  // tier and totalPoints are read server-side from Firestore (never trust client)

  if (!env.FIREBASE_API_KEY || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'Server not configured' }, 503, CORS);
  if (!env.WOO_URL || !env.WOO_KEY || !env.WOO_SECRET)
    return resp({ error: 'WooCommerce API not configured' }, 503, CORS);

  try {
    // 1. Verify Firebase ID token → get caller UID
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    const verifyData = await verifyRes.json();
    const callerUid = verifyData?.users?.[0]?.localId;
    if (!callerUid) return resp({ error: 'Invalid token' }, 401, CORS);

    // 2. Look up customer email from Firestore
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const projectId = env.FCM_PROJECT_ID;
    const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const fsHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

    const custRes = await fetch(`${fsBase}/ipear_customers/${callerUid}`, { headers: fsHeaders });
    if (!custRes.ok) return resp({ error: 'Customer not found' }, 404, CORS);
    const custDoc = await custRes.json();
    const email = (custDoc.fields?.email?.stringValue || '').trim().toLowerCase();
    if (!email) return resp({ error: 'Customer has no email' }, 400, CORS);

    // SEC-FIX: Read totalPoints from Firestore (authoritative) — never trust client
    const realTotalPoints = Number(custDoc.fields?.totalPoints?.integerValue || 0);
    const tier = realTotalPoints >= 10000 ? 'platinum'
               : realTotalPoints >= 6000  ? 'diamond'
               : realTotalPoints >= 3000  ? 'gold'
               : realTotalPoints >= 1000  ? 'silver'
               : 'bronze';

    // 3. Find WooCommerce customer by email
    const wooBase = env.WOO_URL.replace(/\/+$/, '');
    const wooAuth = btoa(env.WOO_KEY + ':' + env.WOO_SECRET);

    const wooCustRes = await fetch(wooBase + '/wp-json/wc/v3/customers?email=' + encodeURIComponent(email) + '&per_page=1', {
      headers: { 'Authorization': 'Basic ' + wooAuth },
    });
    if (!wooCustRes.ok) {
      return resp({ error: 'WooCommerce customer lookup failed: ' + wooCustRes.status }, 502, CORS);
    }
    const customers = await wooCustRes.json();
    if (!customers.length) {
      return resp({ ok: true, synced: false, reason: 'no-woo-account' }, 200, CORS);
    }

    // 4. Update WooCommerce user meta
    const wooCustomerId = customers[0].id;
    const updateRes = await fetch(wooBase + '/wp-json/wc/v3/customers/' + wooCustomerId, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + wooAuth,
      },
      body: JSON.stringify({
        meta_data: [
          { key: 'ipear_loyalty_tier', value: tier },
          { key: 'ipear_total_points', value: String(realTotalPoints) },
        ],
      }),
    });

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('[woo-sync-tier] update failed:', updateRes.status, errText);
      return resp({ error: 'WooCommerce update failed: ' + updateRes.status }, 502, CORS);
    }

    return resp({ ok: true, synced: true, wooCustomerId, tier, totalPoints: realTotalPoints }, 200, CORS);

  } catch (e) {
    console.error('[woo-sync-tier]', e.message, e.stack);
    return resp({ error: 'Internal error' }, 500, CORS);
  }
}

async function handleRedeemAttempt(request, env, CORS) {
  if (!env.RATE_LIMIT_KV) {
    return resp({ error: 'Server not configured for rate-limit storage' }, 503, CORS);
  }

  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const action = String(body.action || '').trim(); // check | fail | success
  if (!['check', 'fail', 'success'].includes(action)) {
    return resp({ error: 'action must be check|fail|success' }, 400, CORS);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const sessionId = String(body.sessionId || '').trim().slice(0, 120);
  const source = String(body.source || 'unknown').trim().slice(0, 40);
  const actorUid = String(body.actorUid || '').trim().slice(0, 120);
  const key = makeRedeemRateKey(source, actorUid, sessionId, ip);
  const failKey = makeFailKey(key);
  const blockKey = makeBlockKey(key);

  if (await isRedeemBlocked(env, blockKey)) {
    return resp({ error: 'Too many failed redemption attempts', retryAfter: REDEEM_BLOCK_TTL_SECONDS }, 429, CORS);
  }

  if (action === 'check') {
    return resp({ ok: true, blocked: false }, 200, CORS);
  }

  if (action === 'success') {
    await clearRedeemRateLimit(env, failKey, blockKey);
    return resp({ ok: true, reset: true }, 200, CORS);
  }

  const state = await getRedeemFailState(env, failKey);
  const fails = state.fails + 1;

  if (fails >= REDEEM_FAIL_LIMIT) {
    await env.RATE_LIMIT_KV.put(blockKey, '1', { expirationTtl: REDEEM_BLOCK_TTL_SECONDS });
    await env.RATE_LIMIT_KV.delete(failKey);
    // Send security alert email to admin
    sendSecurityAlert(env, `Brute-force εξαργύρωσης blocked — IP: ${ip}, source: ${source}, actor: ${actorUid || 'anon'}`).catch(e => console.warn('[alert]', e.message));
    return resp({ error: 'Too many failed redemption attempts', retryAfter: REDEEM_BLOCK_TTL_SECONDS }, 429, CORS);
  }

  await saveRedeemFailState(env, failKey, {
    fails,
    firstFailAt: state.firstFailAt || Date.now(),
  });

  return resp({ ok: true, fails, remaining: REDEEM_FAIL_LIMIT - fails }, 200, CORS);
}

// ══════════════════════════════════════════════════════════════════════════
//  DELETE AUTH USER (Admin μόνο — requires ADMIN_SECRET)
//
//  POST /admin/delete-auth-user  { uid: "firebase_uid" }
//
//  Διαγράφει το Firebase Auth account του χρήστη βάσει UID.
//  Καλείται αυτόματα όταν ο admin διαγράφει customer από το
//  admin panel, ώστε ο customer να μπορεί να ξαναεγγραφεί με το ίδιο email/phone.
// ══════════════════════════════════════════════════════════════════════════
async function handleDeleteAuthUser(request, env, CORS) {
  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  let uid   = (body.uid   || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  if (!uid && !email)
    return resp({ error: 'uid or email is required' }, 400, CORS);
  if (uid && uid.length > 128)
    return resp({ error: 'uid too long' }, 400, CORS);
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254))
    return resp({ error: 'invalid email' }, 400, CORS);

  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'Server not configured' }, 503, CORS);

  try {
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);

    // If only an email was supplied (or to double-check after a uid delete),
    // resolve email → localId via Identity Toolkit lookup. This handles legacy
    // / pre-migration customers whose Firestore record never stored a uid.
    if (!uid && email) {
      const lookupRes = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
        body: JSON.stringify({ email: [email] })
      });
      if (!lookupRes.ok) {
        console.error('[delete-auth-user] email lookup failed:', lookupRes.status);
        return resp({ error: 'Lookup failed' }, 500, CORS);
      }
      const lookup = await lookupRes.json();
      const found = (lookup?.users && lookup.users[0]) || null;
      if (!found) return resp({ success: true, notFound: true }, 200, CORS);
      uid = found.localId;
    }

    const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
      body: JSON.stringify({ localId: uid })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const code = err?.error?.message || 'UNKNOWN';
      if (code === 'USER_NOT_FOUND') return resp({ success: true, notFound: true }, 200, CORS);
      console.error('[delete-auth-user]', code);
      return resp({ error: 'Failed to delete auth user: ' + code }, 500, CORS);
    }
    return resp({ success: true, uid }, 200, CORS);
  } catch(e) {
    console.error('[delete-auth-user]', e.message);
    return resp({ error: 'Internal error: ' + e.message }, 500, CORS);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  CREATE / RESET ADMIN OR TABLET ACCOUNT
//
//  POST /admin/create-admin-user
//  Body: { email, password, storeid? }
//
//  Idempotent: if email already exists, updates the password instead of erroring.
//  Always (re)writes the ipear_admins/{uid} doc so the user has admin rights.
//  Requires the same ADMIN_SECRET as every other /admin/* endpoint.
// ══════════════════════════════════════════════════════════════════════════
async function handleCreateAdminUser(request, env, CORS) {
  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const email    = (body.email    || '').trim().toLowerCase();
  const password = body.password  || '';
  const storeid  = (body.storeid  || '').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    return resp({ error: 'invalid email' }, 400, CORS);
  if (typeof password !== 'string' || password.length < 6 || password.length > 128)
    return resp({ error: 'password must be 6-128 chars' }, 400, CORS);

  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'Server not configured' }, 503, CORS);

  try {
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const projectId = env.FCM_PROJECT_ID;
    let uid;
    let created = false;

    // 1. Create the Auth user (idempotent — falls back to lookup+password-update if it exists)
    const signupRes = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
      body: JSON.stringify({ email, password, emailVerified: true })
    });

    if (signupRes.ok) {
      uid = (await signupRes.json()).localId;
      created = true;
    } else {
      const errBody = await signupRes.json().catch(() => ({}));
      const code = errBody?.error?.message || '';
      if (code === 'EMAIL_EXISTS' || code === 'DUPLICATE_EMAIL') {
        // Already exists — look up the UID and force-update the password
        const lookupRes = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
          body: JSON.stringify({ email: [email] })
        });
        if (!lookupRes.ok) return resp({ error: 'Email exists but lookup failed: ' + lookupRes.status }, 500, CORS);
        const lookup = await lookupRes.json();
        const existing = lookup?.users?.[0];
        if (!existing?.localId) return resp({ error: 'Email exists but no UID returned' }, 500, CORS);
        uid = existing.localId;
        const updateRes = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
          body: JSON.stringify({ localId: uid, password })
        });
        if (!updateRes.ok) {
          const updErr = await updateRes.json().catch(() => ({}));
          return resp({ error: 'Failed to update password: ' + (updErr?.error?.message || updateRes.status) }, 500, CORS);
        }
      } else {
        return resp({ error: 'Auth user creation failed: ' + code }, 500, CORS);
      }
    }

    // 2. (Re)write the ipear_admins/{uid} doc so this user has admin privileges
    const adminWriteRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ipear_admins/${uid}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
        body: JSON.stringify({ fields: { storeid: { stringValue: storeid } } })
      }
    );
    if (!adminWriteRes.ok) {
      const errText = await adminWriteRes.text();
      console.error('[create-admin-user] Firestore write failed:', errText);
      return resp({ error: 'Auth user ready but ipear_admins write failed', uid }, 500, CORS);
    }

    return resp({ success: true, uid, email, created, storeid }, 200, CORS);
  } catch(e) {
    console.error('[create-admin-user]', e.message);
    return resp({ error: 'Internal error: ' + e.message }, 500, CORS);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  SMS HANDLER (Brevo Transactional SMS)
// ══════════════════════════════════════════════════════════════════════════

async function handleSMS(request, env, CORS) {
  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const { phone, message } = body;
  if (!phone?.trim())   return resp({ error: 'phone is required' }, 400, CORS);
  if (!message?.trim()) return resp({ error: 'message is required' }, 400, CORS);

  const clean = phone.replace(/[\s\-()]/g, '');
  const intl  = clean.startsWith('+') ? clean : '+30' + clean;
  if (!/^\+\d{7,15}$/.test(intl))
    return resp({ error: 'Μη έγκυρος αριθμός τηλεφώνου' }, 400, CORS);

  const sender = (env.BREVO_SMS_SENDER || 'iPear').slice(0, 11);

  try {
    const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method:  'POST',
      headers: {
        'api-key':      env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender,
        recipient:     intl,
        content:       normalizeGreekSMS(message).slice(0, 160),
        type:          'transactional',
        unicodeEnabled: false,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `Brevo SMS error ${res.status}`);
    return resp({ ok: true, messageId: data.messageId }, 200, CORS);
  } catch(e) {
    return resp({ error: e.message }, 502, CORS);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  BULK SMS HANDLER (Brevo)
// ══════════════════════════════════════════════════════════════════════════

const MAX_BULK_SMS = 5000;

const DAILY_SMS_CAP = 10000;

async function handleBulkSMS(request, env, CORS) {
  // Admin-gated; 5000 recipients × ~20 bytes ≈ 100 KB worst-case payload.
  let body;
  try { body = await readJsonCapped(request, 512 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const { recipients, message } = body;

  if (!Array.isArray(recipients) || !recipients.length)
    return resp({ error: 'recipients array is required' }, 400, CORS);
  if (!message?.trim())
    return resp({ error: 'message is required' }, 400, CORS);
  if (recipients.length > MAX_BULK_SMS)
    return resp({ error: `Too many recipients (max ${MAX_BULK_SMS})` }, 400, CORS);

  // Daily aggregate SMS cap (KV-backed) — prevents budget drain
  if (env.RATE_LIMIT_KV) {
    const today = new Date().toISOString().slice(0, 10);
    const dayKey = `sms-daily:${today}`;
    const dayRaw = await env.RATE_LIMIT_KV.get(dayKey);
    const daySent = dayRaw ? parseInt(dayRaw, 10) : 0;
    if (daySent + recipients.length > DAILY_SMS_CAP)
      return resp({ error: `Daily SMS cap reached (${DAILY_SMS_CAP}). Sent today: ${daySent}` }, 429, CORS);
    await env.RATE_LIMIT_KV.put(dayKey, String(daySent + recipients.length), { expirationTtl: 86400 });
  }

  const sender = (env.BREVO_SMS_SENDER || 'iPear').slice(0, 11);
  const smsContent = normalizeGreekSMS(message).slice(0, 160);

  let sent = 0, failed = 0;

  // Send in sequential batches of 5 to avoid Brevo rate limits
  for (const chunk of chunkArray(recipients, 5)) {
    const results = await Promise.allSettled(
      chunk.map(async (r) => {
        const phone = (r.phone || '').replace(/[\s\-()]/g, '');
        if (!phone) throw new Error('no phone');
        const intl = phone.startsWith('+') ? phone : '+30' + phone;
        if (!/^\+\d{7,15}$/.test(intl)) throw new Error('invalid phone');

        const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
          method: 'POST',
          headers: {
            'api-key':      env.BREVO_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sender,
            recipient: intl,
            content:   smsContent,
            type:      'transactional',
            unicodeEnabled: false,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || `HTTP ${res.status}`);
        }
        return true;
      })
    );
    results.forEach(r => {
      if (r.status === 'fulfilled') sent++;
      else { failed++; console.warn('[bulk-sms] fail:', r.reason?.message); }
    });
  }

  return resp({ success: true, sent, failed, total: recipients.length }, 200, CORS);
}

// ══════════════════════════════════════════════════════════════════════════
//  EMAIL HANDLER (Brevo)
// ══════════════════════════════════════════════════════════════════════════

async function handleEmail(request, env, CORS) {
  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const { recipients, subject, message, htmlContent } = body;

  if (!Array.isArray(recipients) || !recipients.length)
    return resp({ error: 'recipients array is required' }, 400, CORS);
  if (!subject?.trim())
    return resp({ error: 'subject is required' }, 400, CORS);
  // Either `message` (plain text, auto-wrapped + escaped) OR `htmlContent`
  // (raw HTML, used as-is). Admin callers can pass `htmlContent` directly
  // when they need clickable links or custom branded templates.
  if (!message?.trim() && !htmlContent?.trim())
    return resp({ error: 'message or htmlContent is required' }, 400, CORS);
  if (recipients.length > MAX_RECIPIENTS)
    return resp({ error: `Too many recipients (max ${MAX_RECIPIENTS})` }, 400, CORS);

  const valid = recipients.filter(r => r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
  if (!valid.length) return resp({ error: 'No valid email addresses found' }, 400, CORS);

  const chunks = chunkArray(valid, 900);
  let sent = 0, failed = 0;

  // Body is already gated by ADMIN_SECRET (the bearer check upstream), so
  // raw HTML from the caller is acceptable. Falls back to the legacy
  // text→wrapped path when only `message` is provided.
  const finalHtml = (htmlContent && htmlContent.trim()) ? htmlContent : buildHtmlEmail(message);

  for (const chunk of chunks) {
    const payload = {
      sender: {
        name:  env.SENDER_NAME  || 'iPear Loyalty',
        email: (env.SENDER_EMAIL || '').trim(),
      },
      subject,
      htmlContent: finalHtml,
      messageVersions: chunk.map(r => ({
        to: [{ email: r.email, name: r.name || r.email }],
        params: {
          name:   r.name   || 'φίλε/φίλη',
          points: r.points || '—',
          email:  r.email,
          unsubscribeUrl: (env.APP_URL || '').replace(/\/$/, '') + '/customer.html#unsubscribe',
        },
      })),
    };

    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method:  'POST',
        headers: {
          'api-key':      env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          'Accept':       'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        sent += chunk.length;
      } else {
        const err = await res.json().catch(() => ({}));
        console.error('[Brevo error]', res.status, err?.message || '');
        failed += chunk.length;
      }
    } catch (e) {
      console.error('[fetch error]', e.message);
      failed += chunk.length;
    }
  }

  return resp({ success: true, sent, failed, total: valid.length }, 200, CORS);
}

// ══════════════════════════════════════════════════════════════════════════
//  PUSH HANDLER (FCM V1 API)
// ══════════════════════════════════════════════════════════════════════════

async function handlePush(request, env, CORS) {
  // Dual auth modes:
  //   ADMIN_SECRET → broadcast: caller passes a `tokens` array, we push to all
  //                  (marketing blasts from the admin dashboard).
  //   idToken      → self-push: caller passes their Firebase ID token; we
  //                  resolve their UID, look up their own fcmToken from
  //                  Firestore, and push only to that. The body's `tokens`
  //                  array is IGNORED in this branch so a logged-in customer
  //                  can't aim the push at anyone else.
  // The SPA's "🔔 enabled" confirmation push uses the idToken branch.
  let body;
  try { body = await readJsonCapped(request, 2 * 1024 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const authHeader = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const isAdmin = !!authHeader && env.ADMIN_SECRET && (await timingSafeEqual(authHeader, env.ADMIN_SECRET));

  let { tokens, title, message } = body;

  if (!title?.trim())
    return resp({ error: 'title is required' }, 400, CORS);

  if (!isAdmin) {
    // Non-admin caller MUST present a valid idToken AND the only token we
    // accept to push to is the one stored on their own customer doc.
    const idToken = (body.idToken || '').trim();
    if (!idToken) return resp({ error: 'Unauthorized' }, 401, CORS);
    if (!env.FIREBASE_API_KEY) return resp({ error: 'Server not configured' }, 503, CORS);

    let callerUid;
    try {
      const vRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
      );
      const vData = await vRes.json();
      callerUid = vData?.users?.[0]?.localId;
      if (!callerUid) return resp({ error: 'Invalid token' }, 401, CORS);
    } catch (e) {
      console.error('[push] idToken verify failed:', e.message);
      return resp({ error: 'Token verification failed' }, 401, CORS);
    }

    // Look up the caller's own fcmToken — this is the ONLY destination
    // self-push can target.
    try {
      const fsAccessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
      const projectId = env.FCM_PROJECT_ID;
      const custRes = await fetch(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ipear_customers/${callerUid}`,
        { headers: { 'Authorization': 'Bearer ' + fsAccessToken } }
      );
      if (!custRes.ok) return resp({ error: 'Customer not found' }, 404, CORS);
      const cust = await custRes.json();
      const ownToken = cust.fields?.fcmToken?.stringValue || '';
      if (!ownToken) return resp({ error: 'No fcmToken on file' }, 400, CORS);
      tokens = [ownToken];
    } catch (e) {
      console.error('[push] self-push lookup failed:', e.message);
      return resp({ error: 'Lookup failed' }, 500, CORS);
    }
  }

  if (!Array.isArray(tokens) || !tokens.length)
    return resp({ error: 'tokens array is required' }, 400, CORS);
  if (tokens.length > MAX_TOKENS)
    return resp({ error: `Too many tokens (max ${MAX_TOKENS})` }, 400, CORS);

  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY)
    return resp({ error: 'FCM credentials not configured' }, 500, CORS);
  if (!env.FCM_PROJECT_ID)
    return resp({ error: 'FCM_PROJECT_ID env var is required' }, 500, CORS);

  let accessToken;
  try {
    accessToken = await getFCMAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
  } catch(e) {
    console.error('[FCM auth]', e.message);
    return resp({ error: 'FCM auth failed' }, 500, CORS);
  }

  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`;
  let sent = 0, failed = 0;

  // Send in parallel batches of 10, using shared chunkArray helper
  for (const chunk of chunkArray(tokens, 10)) {
    const results = await Promise.allSettled(
      chunk.map(token => sendSinglePush(fcmUrl, accessToken, token, title, message || '', env.APP_URL))
    );
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value === true) sent++;
      else { failed++; console.warn('[FCM] delivery failed for token in batch'); }
    });
  }

  console.log(`[push] total=${tokens.length} sent=${sent} failed=${failed}`);
  return resp({ success: true, sent, failed, total: tokens.length }, 200, CORS);
}

// ── DEBUG endpoint: test push delivery with full FCM response ──────────────
async function handlePushDebug(request, env, CORS) {
  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'FCM not configured' }, 503, CORS);

  let _debugBody;
  try { _debugBody = await readJsonCapped(request, 8 * 1024); } catch { _debugBody = {}; }

  try {
    // Use getAuthAccessToken (has Firestore scope) not getFCMAccessToken (FCM only)
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const projectId = env.FCM_PROJECT_ID;
    const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const fsHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

    // Fetch all customers with fcmToken
    const queryRes = await fetch(`${fsBase}:runQuery`, {
      method: 'POST', headers: fsHeaders,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'ipear_customers' }],
          select: { fields: [{ fieldPath: 'name' }, { fieldPath: 'fcmToken' }, { fieldPath: 'fcmUpdatedAt' }, { fieldPath: 'email' }] }
        }
      })
    });
    const queryStatus = queryRes.status;
    const results = await queryRes.json();

    // Also try direct list
    const listRes = await fetch(`${fsBase}/ipear_customers?pageSize=5`, { headers: fsHeaders });
    const listData = await listRes.json();
    const listCount = listData.documents ? listData.documents.length : 0;
    const listError = listData.error ? listData.error.message : null;
    const customers = [];
    if (Array.isArray(results)) {
      for (const item of results) {
        if (!item.document) continue;
        const f = item.document.fields || {};
        const token = f.fcmToken?.stringValue || '';
        customers.push({
          name: f.name?.stringValue || '—',
          email: f.email?.stringValue || '',
          hasToken: !!token,
          tokenPrefix: token ? token.slice(0, 30) + '...' : '',
          tokenLength: token.length,
          fcmUpdatedAt: f.fcmUpdatedAt?.stringValue || '',
        });
      }
    }

    const withTokens = customers.filter(c => c.hasToken);

    // Test send to specific customer (by name) or first with token
    const sendToName = (_debugBody.sendToName || '').toLowerCase();

    let testResult = null;
    if (withTokens.length > 0) {
      const targetDoc = sendToName
        ? results.find(r => (r.document?.fields?.name?.stringValue || '').toLowerCase().includes(sendToName) && r.document?.fields?.fcmToken?.stringValue)
        : results.find(r => r.document?.fields?.fcmToken?.stringValue);
      const firstToken = targetDoc?.document?.fields?.fcmToken?.stringValue;
      const targetName = targetDoc?.document?.fields?.name?.stringValue || '?';
      if (firstToken) {
        const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
        const fcmRes = await fetch(fcmUrl, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: firstToken,
              notification: { title: '🍐 Debug Test', body: 'Push notification debug — ' + new Date().toLocaleTimeString() },
              webpush: {
                headers: { Urgency: 'high' },
                notification: { icon: 'https://ipear-loyalty.pages.dev/icon-192.png' },
                fcm_options: { link: 'https://ipear-loyalty.pages.dev/customer.html' },
              },
            }
          }),
        });
        const fcmBody = await fcmRes.json().catch(() => ({}));
        testResult = {
          sentTo: targetName,
          httpStatus: fcmRes.status,
          ok: fcmRes.ok,
          response: fcmBody,
          tokenUsed: firstToken.slice(0, 30) + '...',
        };
      }
    }

    return resp({
      debug: { queryStatus, queryResultCount: Array.isArray(results) ? results.length : 0, listCount, listError, firstQueryItem: Array.isArray(results) ? JSON.stringify(results[0]).slice(0, 200) : null },
      totalCustomers: customers.length,
      withFcmToken: withTokens.length,
      withoutToken: customers.length - withTokens.length,
      customers: customers.map(c => ({ name: c.name, hasToken: c.hasToken, tokenLength: c.tokenLength, updatedAt: c.fcmUpdatedAt })),
      testPushResult: testResult,
    }, 200, CORS);

  } catch(e) {
    console.error('[push-debug] error:', e.message, e.stack);
    return resp({ error: 'Internal error' }, 500, CORS);
  }
}

async function sendSinglePush(fcmUrl, accessToken, token, title, body, appUrl) {
  const baseUrl = appUrl || 'https://ipear-loyalty.pages.dev';
  try {
    const res = await fetch(fcmUrl, {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          webpush: {
            headers: { Urgency: 'high' },
            notification: {
              icon:  baseUrl + '/icon-192.png',
              badge: baseUrl + '/icon-192.png',
              requireInteraction: false,
            },
            fcm_options: { link: baseUrl + '/customer.html' },
          },
          data: { url: '/customer.html', tag: 'ipear-push' },
        }
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const code = err?.error?.details?.[0]?.errorCode || err?.error?.message || res.status;
      console.error('[FCM] send failed:', code, 'token:', token.slice(0, 20) + '...');
      return false;
    }
    console.log('[FCM] ✅ sent to token:', token.slice(0, 20) + '...');
    return true;
  } catch(e) {
    console.error('[FCM] exception:', e.message);
    return false;
  }
}

// ── FCM Service Account JWT + OAuth2 ────────────────────────────────────

async function getFCMAccessToken(clientEmail, privateKeyPem) {
  const jwt = await createJWT(clientEmail, privateKeyPem,
    'https://www.googleapis.com/auth/firebase.messaging');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error(data.error_description || JSON.stringify(data));
  return data.access_token;
}

async function createJWT(clientEmail, privateKeyPem, scope) {
  const pem = privateKeyPem
    .replace(/^["'\s]+|["'\s]+$/g, '')   // strip surrounding quotes / whitespace
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\\n/g, '')              // literal \n from JSON-escaped strings
    .replace(/\n/g, '')               // actual newline characters
    .replace(/\r/g, '')               // carriage returns
    .replace(/\s/g, '')               // any remaining whitespace
    .replace(/[^A-Za-z0-9+/=]/g, ''); // keep ONLY valid base64 characters

  const binaryKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const now = Math.floor(Date.now() / 1000);

  const b64url = obj =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const header  = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({
    iss:   clientEmail,
    scope: scope || 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  });

  const sigInput = `${header}.${payload}`;
  const sigBuf   = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(sigInput)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return `${sigInput}.${sig}`;
}

// ══════════════════════════════════════════════════════════════════════════
//  PASSWORD RESET HANDLER (Firebase Admin + Brevo branded email)
// ══════════════════════════════════════════════════════════════════════════
//
//  POST /reset-password  { email: "user@example.com", name?: "..." }
//
//  Uses FCM service account credentials (already configured) to call
//  Firebase Auth Admin REST API → generatePasswordResetLink, then sends
//  a beautiful branded email via Brevo.
//
//  Public endpoint — no ADMIN_SECRET needed (rate-limited by Firebase + CF).
// ══════════════════════════════════════════════════════════════════════════

async function handleResetPassword(request, env, CORS) {
  // H-4: Rate limit by IP — 5 requests per 15 min window (KV-backed)
  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
  pruneRateBuckets();
  { const _rl = await rateLimitOrBlock(env, clientIP, 'reset', RATE_LIMIT_MAX_HITS, 900, CORS, 'Too many requests. Please try again later.'); if (_rl) return _rl; }

  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    return resp({ error: 'Valid email is required' }, 400, CORS);

  // HIGH-4: per-email window limit (5 per 15 min) — IP-only limit is defeated
  // by IPv6 /64 rotation, letting an attacker reset-bomb a single victim
  // mailbox into junk-folder hell. Compound bucket caps aggregate volume per
  // target inbox regardless of source distribution.
  // SAME response shape as the IP limit, so we don't leak whether the email
  // is the limited dimension.
  { const _rl = await rateLimitOrBlock(env, 't:email:' + email, 'reset', RATE_LIMIT_MAX_HITS, 900, CORS, 'Too many requests. Please try again later.'); if (_rl) return _rl; }

  // Limit name length to prevent oversized payloads
  if (body.name !== undefined && body.name !== null &&
      (typeof body.name !== 'string' || body.name.length > 200))
    return resp({ error: 'name must be a string ≤ 200 characters' }, 400, CORS);

  // We reuse FCM credentials (service account) to call Firebase Auth Admin API
  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'Service account credentials not configured' }, 500, CORS);

  try {
    // Step 1: Get OAuth2 access token (same as FCM, but with broader scope)
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);

    // Step 2: Generate password reset link via Firebase Auth Admin REST API
    const fbRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
        body: JSON.stringify({
          requestType: 'PASSWORD_RESET',
          email,
          returnOobLink: true,
        }),
      }
    );

    if (!fbRes.ok) {
      const err = await fbRes.json().catch(() => ({}));
      const code = err?.error?.message || 'UNKNOWN';
      console.error('[Firebase Admin reset] status:', fbRes.status, 'code:', code, 'full:', JSON.stringify(err));
      // Don't reveal whether the email exists (security best practice)
      if (code === 'EMAIL_NOT_FOUND' || code.includes('EMAIL_NOT_FOUND')) {
        return resp({ success: true, message: 'If the email exists, a reset link was sent.' }, 200, CORS);
      }
      return resp({ error: 'Failed to generate reset link' }, 500, CORS);
    }

    const fbData = await fbRes.json();
    const resetLink = fbData.oobLink || '';

    if (!resetLink) {
      console.error('[Firebase Admin reset] No oobLink in response');
      return resp({ error: 'No reset link generated' }, 500, CORS);
    }

    // Validate the reset link is a legitimate HTTPS URL before embedding in email
    let safeResetLink;
    try {
      const parsed = new URL(resetLink);
      if (parsed.protocol !== 'https:') throw new Error('not https');
      safeResetLink = resetLink;
    } catch(_) {
      console.error('[Firebase Admin reset] Invalid or non-HTTPS oobLink');
      return resp({ error: 'Invalid reset link generated' }, 500, CORS);
    }

    // Step 3: Send branded email via Brevo
    const name = body.name || email.split('@')[0];
    const htmlContent = buildPasswordResetEmail(name, safeResetLink);

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key':      env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body: JSON.stringify({
        sender: {
          name:  env.SENDER_NAME  || 'iPear Loyalty',
          email: (env.SENDER_EMAIL || '').trim(),
        },
        to: [{ email, name }],
        subject: '🔑 Επαναφορά Κωδικού — iPear Loyalty',
        htmlContent,
      }),
    });

    if (!brevoRes.ok) {
      const err = await brevoRes.json().catch(() => ({}));
      console.error('[Brevo reset email]', brevoRes.status, err?.message || '');
      return resp({ error: 'Failed to send reset email' }, 500, CORS);
    }

    // Use same message whether email was found or not (prevents user enumeration)
    return resp({ success: true, message: 'If the email exists, a reset link was sent.' }, 200, CORS);

  } catch(e) {
    console.error('[reset-password] catch:', e.message, e.stack);
    return resp({ error: 'Internal error' }, 500, CORS);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//
//  POST /check-registration  { email: "...", phone: "6912345678" }
//
//  Public endpoint — checks if email/phone already exist in the loyalty
//  system BEFORE sending OTP (saves SMS credits on duplicate registrations).
//  Rate-limited: 10 requests per 15 min per IP.
//
// ══════════════════════════════════════════════════════════════════════════
// 10 / 15 min / /64 — relaxed from 3 once /check-registration became a real
// Firestore lookup again (was a no-op under MEDIUM-2). 3 was too tight for
// legitimate users hitting typo/refresh/back-button. Enumeration economics
// are bounded by HIGH-4 IPv6 /64 collapse + constant-time delay.
const CHECK_REG_RATE_MAX = 10;
const _checkRegBuckets = new Map();

function _isCheckRegLimited(ip) {
  const now = Date.now();
  const b = _checkRegBuckets.get(ip);
  if (!b || now - b.windowStart > RATE_LIMIT_WINDOW_MS) {
    _checkRegBuckets.set(ip, { windowStart: now, hits: 1 });
    return false;
  }
  b.hits++;
  return b.hits > CHECK_REG_RATE_MAX;
}

// MEDIUM-2 → re-enabled with HIGH-4 mitigation.
//
// History:
//   • Original: returned { exists, blocked } — a small enumeration oracle.
//   • Post-MEDIUM-2: made into a no-op that always returned { ok: true } so
//     attackers couldn't harvest the customer list via IPv6 rotation.
//   • Post-HIGH-4 (IPv6 /64 collapse): rotating IPv6 buckets to /64 caps a
//     single attacker at 3 reqs / 15 min / /64 even with a free /64 prefix.
//     That changes the enumeration economics enough to re-enable the check
//     and stop burning Brevo SMS credit on every duplicate signup attempt.
//
// Defenses kept in place:
//   • Per-/64 rate limit (3 / 15 min) via rateLimitOrBlock with HIGH-4 key.
//   • Constant-time 200–600 ms delay so request timing is independent of
//     whether the email/phone hit a Firestore document.
//   • Identical 200 response shape on both "exists" and "not exists" so
//     downstream timing / size attacks see no difference.
//   • Service-account Firestore read (not anonymous) so the query path is
//     auditable in GCP logs alongside other admin endpoints.
async function handleCheckRegistration(request, env, CORS) {
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  pruneRateBuckets();
  { const _rl = await rateLimitOrBlock(env, clientIP, 'checkreg', CHECK_REG_RATE_MAX, 900, CORS); if (_rl) return _rl; }

  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const email = (body.email || '').trim().toLowerCase();
  const phone = (body.phone || '').replace(/[\s\-()]/g, '');

  if (!email && !phone) return resp({ error: 'email or phone required' }, 400, CORS);
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254))
    return resp({ error: 'Invalid email format' }, 400, CORS);
  if (phone && !/^6\d{9}$/.test(phone))
    return resp({ error: 'Invalid phone format' }, 400, CORS);

  // Constant-time-ish delay (200–600 ms) regardless of lookup outcome.
  const delay = new Promise(r => setTimeout(r, 200 + Math.random() * 400));

  let exists = false;
  let blocked = false;
  try {
    if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID) {
      // No service account → fail OPEN (treat as "not found"). The client
      // then proceeds to OTP; Firebase Auth's auth/email-already-in-use is
      // the next backstop. We do not want to fail-closed on a config issue
      // and lock everyone out of signup.
      await delay;
      return resp({ exists: false, blocked: false, degraded: true }, 200, CORS);
    }
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const projectId   = env.FCM_PROJECT_ID;
    const fsBase      = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
    const fsHeaders   = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

    async function structuredQuery(field, value) {
      const q = {
        structuredQuery: {
          from: [{ collectionId: 'ipear_customers' }],
          where: {
            fieldFilter: {
              field: { fieldPath: field },
              op:    'EQUAL',
              value: { stringValue: value },
            },
          },
          limit: 1,
        },
      };
      const r = await fetch(fsBase, { method: 'POST', headers: fsHeaders, body: JSON.stringify(q) });
      if (!r.ok) return { exists: false, blocked: false };
      const rows = await r.json();
      for (const row of rows) {
        if (row && row.document) {
          const f = row.document.fields || {};
          const isBlocked = f.blocked && (f.blocked.booleanValue === true);
          return { exists: true, blocked: !!isBlocked };
        }
      }
      return { exists: false, blocked: false };
    }

    if (email) {
      const r = await structuredQuery('email', email);
      exists  = exists  || r.exists;
      blocked = blocked || r.blocked;
    }
    if (!exists && phone) {
      const r = await structuredQuery('phone', phone);
      exists  = exists  || r.exists;
      blocked = blocked || r.blocked;
    }
  } catch (e) {
    console.error('[check-registration] lookup failed:', e.message);
    // Fail OPEN on transient errors (see note above). Worker tail will show
    // the failure for ops investigation.
    await delay;
    return resp({ exists: false, blocked: false, degraded: true }, 200, CORS);
  }

  await delay;
  return resp({ exists, blocked }, 200, CORS);
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /process-referral  { idToken: "firebase_id_token" }
//  Public endpoint — authenticated via Firebase ID token (not ADMIN_SECRET).
//  Called by customer.html after self-registration with a referral code.
//  Processes the referral: awards referrer +100 pts, creates transactions,
//  increments referralCount, creates new customer's bonus transaction.
// ═══════════════════════════════════════════════════════════════════════════
const MAX_REFERRALS_PER_USER = 5;

async function handleProcessReferral(request, env, CORS) {
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  pruneRateBuckets();
  {
    const _rl = await rateLimitOrBlock(env, clientIP, 'referral', REFERRAL_RATE_MAX, 900, CORS);
    if (_rl) {
      sendSecurityAlert(env, `Referral abuse blocked — IP: ${clientIP}, endpoint: /process-referral`).catch(() => {});
      return _rl;
    }
  }

  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const idToken = (body.idToken || '').trim();
  if (!idToken) return resp({ error: 'idToken required' }, 400, CORS);

  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID || !env.FIREBASE_API_KEY)
    return resp({ error: 'Server not configured' }, 503, CORS);

  try {
    // 1. Verify Firebase ID token to get caller's UID
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    const verifyData = await verifyRes.json();
    const u = verifyData?.users?.[0];
    const callerUid = u?.localId;
    if (!callerUid) return resp({ error: 'Invalid token' }, 401, CORS);

    // 2. Get service account access token for Firestore
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);

    // Phone-verification gate. Accepts EITHER (a) Firebase phoneNumber claim
    // (legacy Phone Auth path) OR (b) a fresh `phone-otp:{phone}` receipt
    // written by /verify-sms-otp (Brevo OTP path, which links no phone to
    // the email/password Auth user). Direct-REST signUp attackers have
    // neither and still get 403'd — closing the fake-account referral-mint
    // path that the original round-3 fix defended against.
    const hasPhone = typeof u?.phoneNumber === 'string' && u.phoneNumber.length > 0;
    if (!hasPhone) {
      const hasReceipt = await hasPhoneOtpReceipt(env, callerUid, accessToken);
      if (!hasReceipt) {
        return resp({ error: 'phone-not-verified' }, 403, CORS);
      }
    }
    const projectId = env.FCM_PROJECT_ID;
    const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const fsHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

    // 3. Look up the referral_queue entry for this caller
    const qDocRes = await fetch(`${fsBase}/ipear_referral_queue/${callerUid}`, { headers: fsHeaders });
    if (!qDocRes.ok) return resp({ ok: false, reason: 'no-queue-entry' }, 200, CORS);
    const qDocData = await qDocRes.json();
    const q = {};
    for (const [k, v] of Object.entries(qDocData.fields || {})) {
      q[k] = v.stringValue ?? v.integerValue ?? v.booleanValue ?? v.doubleValue ?? '';
    }
    if (q.processed === true) return resp({ ok: true, reason: 'already-processed' }, 200, CORS);

    // 4. Verify new customer doc exists and matches
    const ncRes = await fetch(`${fsBase}/ipear_customers/${q.newCustomerId || callerUid}`, { headers: fsHeaders });
    if (!ncRes.ok) return resp({ ok: false, reason: 'customer-not-found' }, 200, CORS);
    const ncRaw = await ncRes.json();
    const nc = {};
    for (const [k, v] of Object.entries(ncRaw.fields || {})) {
      nc[k] = v.stringValue ?? (v.integerValue !== undefined ? Number(v.integerValue) : undefined) ?? v.booleanValue ?? v.doubleValue ?? '';
    }
    if (nc.referralProcessed === true) return resp({ ok: true, reason: 'already-processed' }, 200, CORS);

    // 5. Find referrer by card
    const referrerCard = q.referrerCard || '';
    if (!referrerCard) return resp({ ok: false, reason: 'no-referrer-card' }, 200, CORS);

    const refQueryRes = await fetch(`${fsBase}:runQuery`, {
      method: 'POST', headers: fsHeaders,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'ipear_customers' }],
          where: { fieldFilter: { field: { fieldPath: 'card' }, op: 'EQUAL', value: { stringValue: referrerCard } } },
          limit: 1
        }
      })
    });
    const refResults = await refQueryRes.json();
    const refDoc = Array.isArray(refResults) && refResults[0]?.document;

    // Helpers used by every termination branch below.
    const newCustomerId = q.newCustomerId || callerUid;
    const ncDocPath = `${fsBase}/ipear_customers/${newCustomerId}`;

    async function revertNewCustomerPoints(reason) {
      // CRITICAL-2: hard-revert any points the client may have self-credited
      // before the rules update. With the new rule, customer signups must
      // start at points=0 — so this is a safety belt for legacy paths and any
      // future regressions. Atomic R-M-W ensures we never go negative.
      try {
        const beginRes = await fetch(`${fsBase}:beginTransaction`, {
          method: 'POST', headers: fsHeaders, body: JSON.stringify({})
        });
        if (!beginRes.ok) throw new Error('beginTransaction failed: ' + beginRes.status);
        const { transaction } = await beginRes.json();

        const readRes = await fetch(`${ncDocPath}?transaction=${encodeURIComponent(transaction)}`, { headers: fsHeaders });
        if (!readRes.ok) throw new Error('transactional read failed: ' + readRes.status);
        const ncDoc = await readRes.json();
        const f = ncDoc.fields || {};
        const curPts = Number(f.points?.integerValue || 0);
        const curTot = Number(f.totalPoints?.integerValue || 0);
        const newPts = Math.max(0, curPts - 100);
        const newTot = Math.max(0, curTot - 100);

        await fetch(`${fsBase}:commit`, {
          method: 'POST', headers: fsHeaders,
          body: JSON.stringify({
            transaction,
            writes: [{
              update: {
                name: ncDoc.name,
                fields: {
                  ...ncDoc.fields,
                  points:            { integerValue: newPts },
                  totalPoints:       { integerValue: newTot },
                  referralProcessed: { booleanValue: true },
                }
              },
              updateMask: { fieldPaths: ['points', 'totalPoints', 'referralProcessed'] }
            }]
          })
        });
        console.log(`[process-referral] hard-revert (${reason}) for ${newCustomerId}: ${curPts}→${newPts}`);
      } catch (e) {
        console.error('[process-referral] revert error (' + reason + '):', e.message);
      }
    }

    async function markQueueProcessed(reason) {
      await fetch(`${fsBase}/ipear_referral_queue/${callerUid}?updateMask.fieldPaths=processed&updateMask.fieldPaths=processedAt&updateMask.fieldPaths=skipped`, {
        method: 'PATCH', headers: fsHeaders,
        body: JSON.stringify({ fields: {
          processed:   { booleanValue: true },
          processedAt: { stringValue: new Date().toISOString() },
          skipped:     { stringValue: reason }
        }})
      });
    }

    // ════════════════════════════════════════════════════════════════════
    // CRITICAL-2: invalid referrer → hard-revert + mark queue + exit early.
    // The previous code skipped the entire `if (refDoc)` block and then ran
    // step-8 unconditionally, leaving the new customer with the +100 self-
    // credit they never legitimately earned.
    // ════════════════════════════════════════════════════════════════════
    if (!refDoc) {
      await revertNewCustomerPoints('invalid-referrer');
      await markQueueProcessed('invalid-referrer');
      return resp({ ok: true, reason: 'invalid-referrer' }, 200, CORS);
    }

    const refDocPath = refDoc.name; // full path
    const rf = {};
    for (const [k, v] of Object.entries(refDoc.fields || {})) {
      rf[k] = v.stringValue ?? (v.integerValue !== undefined ? Number(v.integerValue) : undefined) ?? v.booleanValue ?? v.doubleValue ?? '';
    }
    const refCount = Number(rf.referralCount) || 0;

    if (refCount >= MAX_REFERRALS_PER_USER) {
      // Referrer hit the cap — revert new customer's 100 pts (if any) + mark queue.
      await revertNewCustomerPoints('referral-limit-reached');
      await markQueueProcessed('referral-limit-reached');
      return resp({ ok: true, reason: 'referral-limit-reached' }, 200, CORS);
    }

    // 6. Award REFERRER +100 pts atomically
    //    (SEC-FIX H-1: transaction prevents race condition on concurrent referrals)
    let referrerAwarded = false;
    {
      const txBeginRes = await fetch(`${fsBase}:beginTransaction`, {
        method: 'POST', headers: fsHeaders, body: JSON.stringify({})
      });
      if (!txBeginRes.ok) {
        console.error('[process-referral] referrer beginTransaction failed:', txBeginRes.status);
      } else {
        const { transaction: refTx } = await txBeginRes.json();
        const refReadUrl = `https://firestore.googleapis.com/v1/${refDocPath}?transaction=${encodeURIComponent(refTx)}`;
        const txRefReadRes = await fetch(refReadUrl, { headers: fsHeaders });
        if (txRefReadRes.ok) {
          const txRefDoc = await txRefReadRes.json();
          const txRefFields = txRefDoc.fields || {};
          const txRPts = Number(txRefFields.points?.integerValue || 0) + 100;
          const txRTot = Number(txRefFields.totalPoints?.integerValue || 0) + 100;
          const txRefCount = Number(txRefFields.referralCount?.integerValue || 0) + 1;
          const commitRes = await fetch(`${fsBase}:commit`, {
            method: 'POST', headers: fsHeaders,
            body: JSON.stringify({
              transaction: refTx,
              writes: [{
                update: {
                  name: txRefDoc.name,
                  fields: { ...txRefDoc.fields, points: { integerValue: txRPts }, totalPoints: { integerValue: txRTot }, referralCount: { integerValue: txRefCount } }
                },
                updateMask: { fieldPaths: ['points', 'totalPoints', 'referralCount'] }
              }]
            })
          });
          if (commitRes.ok) {
            referrerAwarded = true;
          } else {
            console.error('[process-referral] referrer commit failed:', commitRes.status, await commitRes.text());
          }
        } else {
          console.error('[process-referral] referrer tx read failed:', txRefReadRes.status);
        }
      }
    }

    // 7. Award NEW CUSTOMER +100 pts atomically.
    //    CRITICAL-2: customer can no longer self-credit at signup, so this
    //    server-side credit is the only path. Idempotent via referralProcessed.
    let newCustomerAwarded = false;
    {
      const txBeginRes = await fetch(`${fsBase}:beginTransaction`, {
        method: 'POST', headers: fsHeaders, body: JSON.stringify({})
      });
      if (!txBeginRes.ok) {
        console.error('[process-referral] new-customer beginTransaction failed:', txBeginRes.status);
      } else {
        const { transaction: ncTx } = await txBeginRes.json();
        const ncReadRes = await fetch(`${ncDocPath}?transaction=${encodeURIComponent(ncTx)}`, { headers: fsHeaders });
        if (ncReadRes.ok) {
          const ncDoc = await ncReadRes.json();
          const ncFields = ncDoc.fields || {};
          if (ncFields.referralProcessed?.booleanValue === true) {
            console.log('[process-referral] new customer already processed, skipping credit');
          } else {
            const ncPts = Number(ncFields.points?.integerValue || 0) + 100;
            const ncTot = Number(ncFields.totalPoints?.integerValue || 0) + 100;
            const ncCommitRes = await fetch(`${fsBase}:commit`, {
              method: 'POST', headers: fsHeaders,
              body: JSON.stringify({
                transaction: ncTx,
                writes: [{
                  update: {
                    name: ncDoc.name,
                    fields: {
                      ...ncDoc.fields,
                      points:            { integerValue: ncPts },
                      totalPoints:       { integerValue: ncTot },
                      referralProcessed: { booleanValue: true },
                    }
                  },
                  updateMask: { fieldPaths: ['points', 'totalPoints', 'referralProcessed'] }
                }]
              })
            });
            if (ncCommitRes.ok) {
              newCustomerAwarded = true;
            } else {
              console.error('[process-referral] new-customer commit failed:', ncCommitRes.status, await ncCommitRes.text());
            }
          }
        } else {
          console.error('[process-referral] new-customer tx read failed:', ncReadRes.status);
        }
      }
    }

    // 8. Ledger rows (non-blocking — balance is already updated above)
    if (referrerAwarded) {
      const refTxRes = await fetch(`${fsBase}/ipear_transactions`, {
        method: 'POST', headers: fsHeaders,
        body: JSON.stringify({ fields: {
          customerId:    { stringValue: refDocPath.split('/').pop() },
          customerUid:   { stringValue: rf.uid || '' },
          customerEmail: { stringValue: rf.email || '' },
          customerName:  { stringValue: rf.name || '' },
          card:          { stringValue: rf.card || referrerCard },
          type:          { stringValue: 'add' },
          points:        { integerValue: 100 },
          amount:        { integerValue: 0 },
          category:      { stringValue: '🎁 Referral Bonus' },
          note:          { stringValue: `Παραπομπή: ${q.newCustomerCard || ''} (${refCount+1}/${MAX_REFERRALS_PER_USER})` },
          date:          { stringValue: new Date().toISOString() }
        }})
      });
      if (!refTxRes.ok) console.error('[process-referral] referrer TX log failed:', refTxRes.status);
    }
    if (newCustomerAwarded) {
      const ncTxRes = await fetch(`${fsBase}/ipear_transactions`, {
        method: 'POST', headers: fsHeaders,
        body: JSON.stringify({ fields: {
          customerId:    { stringValue: newCustomerId },
          customerUid:   { stringValue: q.newCustomerUid || callerUid },
          customerEmail: { stringValue: q.newCustomerEmail || '' },
          customerName:  { stringValue: q.newCustomerName || '' },
          card:          { stringValue: q.newCustomerCard || '' },
          type:          { stringValue: 'add' },
          points:        { integerValue: 100 },
          amount:        { integerValue: 0 },
          category:      { stringValue: '🎁 Referral Bonus' },
          note:          { stringValue: 'Bonus εγγραφής με referral' },
          date:          { stringValue: new Date().toISOString() }
        }})
      });
      if (!ncTxRes.ok) console.error('[process-referral] new-customer TX log failed:', ncTxRes.status);
    }

    // 9. Mark queue done
    await fetch(`${fsBase}/ipear_referral_queue/${callerUid}?updateMask.fieldPaths=processed&updateMask.fieldPaths=processedAt`, {
      method: 'PATCH', headers: fsHeaders,
      body: JSON.stringify({ fields: {
        processed:   { booleanValue: true },
        processedAt: { stringValue: new Date().toISOString() }
      }})
    });

    // 10. Refresh the public leaderboard so the new customer (and the
    //     referrer's updated totalPoints) show up immediately.
    if (referrerAwarded || newCustomerAwarded) {
      await republishLeaderboardFromWorker(env, accessToken);
    }

    return resp({ ok: true, referrerAwarded, newCustomerAwarded }, 200, CORS);

  } catch(e) {
    console.error('[process-referral]', e.message, e.stack);
    return resp({ error: 'Processing failed' }, 500, CORS);
  }
}

// ── OAuth2 token with Identity Toolkit scope (for Auth Admin) ──────────────
async function getAuthAccessToken(clientEmail, privateKeyPem) {
  const jwt = await createJWT(clientEmail, privateKeyPem,
    'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(data.error_description || JSON.stringify(data));
  return data.access_token;
}

// ── Password Reset Email HTML Template ─────────────────────────────────────
function buildPasswordResetEmail(name, resetLink) {
  const safeName = escHtml(name);
  // HTML-encode '&' and '"' in the URL for safe embedding in href attributes.
  // Browsers decode &amp; back to & when the link is clicked, so functionality is preserved.
  const safeHref = resetLink.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="el">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Επαναφορά Κωδικού — iPear Loyalty</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 0">
  <tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0"
         style="max-width:600px;width:100%;background:#ffffff;border-radius:22px;
                overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.10)">

    <!-- HEADER -->
    <tr>
      <td style="background:linear-gradient(135deg,#6bb800 0%,#8ae900 100%);padding:40px 44px;text-align:center">
        <div style="font-size:36px;font-weight:900;color:#0a0a0a;letter-spacing:-1.5px;line-height:1">
          iPear<span style="color:#ffffff">Loyalty</span>
        </div>
        <div style="font-size:12px;color:rgba(0,0,0,.45);margin-top:8px;
                    text-transform:uppercase;letter-spacing:4px;font-weight:600">
          Loyalty Program
        </div>
      </td>
    </tr>

    <!-- ICON -->
    <tr>
      <td style="padding:36px 44px 0;text-align:center">
        <div style="display:inline-block;width:72px;height:72px;line-height:72px;
                    font-size:36px;background:#f0ffe0;border-radius:50%;
                    border:2px solid #8ae900;text-align:center">
          🔑
        </div>
      </td>
    </tr>

    <!-- BODY -->
    <tr>
      <td style="padding:24px 44px 32px">
        <h1 style="font-size:22px;font-weight:800;color:#0a0a0a;margin:0 0 8px;
                   line-height:1.3;text-align:center">
          Επαναφορά Κωδικού
        </h1>
        <p style="font-size:15px;color:#666;line-height:1.7;margin:0 0 28px;text-align:center">
          Γεια σου, <strong>${safeName}</strong>!<br>
          Λάβαμε αίτημα για αλλαγή του κωδικού σου.<br>
          Πάτα το παρακάτω κουμπί για να ορίσεις νέο κωδικό:
        </p>

        <!-- CTA BUTTON -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
          <tr>
            <td align="center">
              <a href="${safeHref}" target="_blank"
                 style="display:inline-block;background:linear-gradient(135deg,#6bb800,#8ae900);
                        color:#0a0a0a;text-decoration:none;font-weight:800;font-size:16px;
                        padding:16px 48px;border-radius:14px;letter-spacing:.3px;
                        box-shadow:0 4px 18px rgba(107,184,0,.35)">
                🔐 Αλλαγή Κωδικού
              </a>
            </td>
          </tr>
        </table>

        <!-- Secondary link -->
        <p style="font-size:13px;color:#999;line-height:1.6;margin:0 0 24px;text-align:center">
          Αν το κουμπί δεν λειτουργεί, αντέγραψε αυτό τον σύνδεσμο στο browser σου:<br>
          <a href="${safeHref}" style="color:#6bb800;word-break:break-all;font-size:12px">${escHtml(resetLink)}</a>
        </p>

        <!-- Warning -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="background:#fff9e6;border:1.5px solid #ffd93d;border-radius:12px;
                       padding:14px 18px;text-align:center">
              <p style="font-size:13px;color:#996d00;margin:0;line-height:1.5">
                ⏰ <strong>Ο σύνδεσμος λήγει σε 1 ώρα.</strong><br>
                Αν δεν ζήτησες εσύ αυτή την αλλαγή, αγνόησε αυτό το email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- DIVIDER -->
    <tr>
      <td style="padding:0 44px">
        <div style="height:1px;background:#eeeeee"></div>
      </td>
    </tr>

    <!-- FOOTER -->
    <tr>
      <td style="background:#fafafa;padding:24px 44px;text-align:center;border-radius:0 0 22px 22px">
        <p style="font-size:12px;color:#aaaaaa;margin:0;line-height:1.8">
          © iPear Loyalty Program 🍐<br>
          <span style="color:#cccccc">Αυτό το email στάλθηκε αυτόματα. Δεν χρειάζεται απάντηση.</span>
        </p>
      </td>
    </tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  SECURITY ALERT EMAIL — auto-notifies admin on suspicious activity
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
//  CLIENT ERROR TELEMETRY — /client-error
//  Receives JS errors from customer/tablet/admin apps.
//  Stores last 50 errors in KV, alerts admin on critical patterns.
// ══════════════════════════════════════════════════════════════════════════

async function handleClientError(request, env, CORS) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  // Light rate limit: 3 reports per IP per 15 min window
  {
    // /client-error is fire-and-forget telemetry — return 200 silently on
    // rate-limit so the client doesn't retry, but still return 503 if KV
    // is down (the client logger should back off).
    const _r = await isRateLimitedKV(env, ip, 'cerr', 3, 900);
    if (_r.limited && _r.reason === 'kv-unavailable') {
      return resp({ error: 'Service temporarily unavailable' }, 503, CORS);
    }
    if (_r.limited) return resp({ ok: true, note: 'rate-limited' }, 200, CORS);
  }

  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const entry = {
    type:    String(body.type || 'unknown').slice(0, 30),
    message: String(body.message || '').slice(0, 500),
    source:  String(body.source || '').slice(0, 150),
    stack:   String(body.stack || '').slice(0, 800),
    page:    String(body.page || '').slice(0, 60),
    build:   String(body.build || '').slice(0, 40),
    ua:      String(body.ua || '').slice(0, 200),
    ts:      body.ts || new Date().toISOString(),
    ip:      ip.slice(0, 45),
  };

  // ── Store in KV (ring buffer of last 50 errors) ──
  if (env.RATE_LIMIT_KV) {
    try {
      const raw = await env.RATE_LIMIT_KV.get('client_errors:log');
      let log = raw ? JSON.parse(raw) : [];
      log.push(entry);
      if (log.length > 50) log = log.slice(-50);
      await env.RATE_LIMIT_KV.put('client_errors:log', JSON.stringify(log), { expirationTtl: 7 * 86400 }); // 7 days
    } catch (e) { console.error('[client-error] KV write failed:', e.message); }
  }

  // ── Alert admin on critical errors (Firebase Auth / Firestore failures) ──
  const msg = entry.message.toLowerCase();
  // Known-benign: FCM on unsupported browsers (iOS Safari/PWA) — never alert
  const isKnownBenign = msg.includes('messaging/unsupported-browser')
    || msg.includes('messaging/permission-blocked')
    || msg.includes('messaging/token-unsubscribe-failed')
    || msg.includes('auth/messaging-token-expired')
    || msg.includes('auth/user-token-expired');
  const isCritical = !isKnownBenign && (
    msg.includes('firestore') || msg.includes('firebase') || msg.includes('auth/')
    || msg.includes('quota') || msg.includes('permission-denied') || msg.includes('unavailable')
  );
  if (isCritical) {
    // LOW-3: every field is HTML-escaped before going into the admin's inbox.
    // The previous version trusted entry.page / entry.build / entry.type /
    // entry.message / entry.source — all caller-supplied. A malformed
    // /client-error POST could inject arbitrary HTML into the alert email.
    const _esc = (s) => String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    await sendSecurityAlert(env,
      `🖥️ Critical client-side error on <b>${_esc(entry.page)}</b> (build: ${_esc(entry.build)}):<br><br>`
      + `<b>Type:</b> ${_esc(entry.type)}<br>`
      + `<b>Message:</b> ${_esc(entry.message)}<br>`
      + `<b>Source:</b> ${_esc(entry.source)}<br>`
      + `<pre style="font-size:12px;max-height:200px;overflow:auto">${_esc(entry.stack)}</pre>`
    );
  }

  console.log(`[client-error] ${entry.type} on ${entry.page}: ${entry.message.slice(0, 100)}`);
  return resp({ ok: true }, 200, CORS);
}

// ══════════════════════════════════════════════════════════════════════════
//  DEEP HEALTH CHECK — /health-deep
//  Pings Brevo API + Firestore to verify third-party connectivity.
//  Requires ADMIN_SECRET so it can be called by Cloudflare cron or manually.
// ══════════════════════════════════════════════════════════════════════════

async function handleHealthDeep(request, env, CORS) {
  // Auth: Bearer-only — no query string fallback (secrets must never travel in URLs)
  const secret = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_SECRET || !(await timingSafeEqual(secret, env.ADMIN_SECRET))) {
    return resp({ error: 'Unauthorized' }, 401, CORS);
  }

  const results = { worker: 'ok', brevo: 'unknown', firestore: 'unknown', timestamp: new Date().toISOString() };
  const alerts = [];

  // ── Check Brevo: GET /v3/account (lightest call, returns account info) ──
  try {
    const brevoResp = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': env.BREVO_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (brevoResp.ok) {
      results.brevo = 'ok';
    } else {
      results.brevo = `error:${brevoResp.status}`;
      alerts.push(`Brevo API returned HTTP ${brevoResp.status}`);
    }
  } catch (e) {
    results.brevo = `down:${e.message}`;
    alerts.push(`Brevo API unreachable: ${e.message}`);
  }

  // ── Check Firestore: read maintenance flag (1 tiny doc read) ──
  try {
    const projectId = env.FCM_PROJECT_ID;
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const fsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ipear_config/maintenance`;
    const fsResp = await fetch(fsUrl, {
      headers: { 'Authorization': 'Bearer ' + accessToken },
      signal: AbortSignal.timeout(8000),
    });
    if (fsResp.ok || fsResp.status === 404) {
      results.firestore = 'ok';  // 404 = doc doesn't exist, but Firestore responded
    } else {
      results.firestore = `error:${fsResp.status}`;
      alerts.push(`Firestore returned HTTP ${fsResp.status}`);
    }
  } catch (e) {
    results.firestore = `down:${e.message}`;
    alerts.push(`Firestore unreachable: ${e.message}`);
  }

  // ── If any dependency is down, alert admin ──
  if (alerts.length > 0) {
    results.status = 'degraded';
    await sendSecurityAlert(env,
      `⚠️ <b>Deep Health Check — DEGRADED</b><br><br>`
      + alerts.map(a => `• ${a}`).join('<br>')
      + `<br><br>Worker: ${results.worker} | Brevo: ${results.brevo} | Firestore: ${results.firestore}`
    );
  } else {
    results.status = 'ok';
  }

  return resp(results, alerts.length > 0 ? 503 : 200, { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
}

async function sendSecurityAlert(env, detail) {
  if (!env.BREVO_API_KEY || !env.SENDER_EMAIL) return;
  const adminEmail = env.ADMIN_ALERT_EMAIL || env.SENDER_EMAIL;
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'iPear Security', email: env.SENDER_EMAIL.trim() },
        to: [{ email: adminEmail.trim() }],
        subject: '\u{1F6A8} [iPear Security] Suspicious activity detected',
        htmlContent: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <div style="background:#1a1a1a;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
            <span style="font-size:28px;font-weight:900;color:#8ae900">iPear</span><span style="font-size:28px;font-weight:900;color:#fff">Security</span>
          </div>
          <div style="background:#fff3f3;border:2px solid #ff3b30;border-radius:12px;padding:20px">
            <h2 style="color:#c62828;margin:0 0 12px">\u{1F6A8} Suspicious Activity Alert</h2>
            <p style="color:#333;line-height:1.7;margin:0 0 12px">${detail.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
            <p style="color:#888;font-size:13px;margin:0">Time: ${new Date().toISOString()}</p>
          </div>
          <p style="color:#aaa;font-size:12px;text-align:center;margin-top:20px">iPear Loyalty — Automated Security Alert</p>
        </div>`,
      }),
    });
    console.log('[security-alert] sent to', adminEmail);
  } catch (e) {
    console.error('[security-alert] failed:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  LEADERBOARD REBUILD (async, decoupled from WooCommerce response)
//  Called via ctx.waitUntil() from handleWooAddPoints so the 200 OK
//  returns instantly; this heavy query runs in background.
// ══════════════════════════════════════════════════════════════════════════
async function _rebuildLeaderboard(fsBase, fsHeaders) {
  try {
    const allRes = await fetch(`${fsBase}:runQuery`, {
      method: 'POST', headers: fsHeaders,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'ipear_customers' }],
          select: { fields: [
            { fieldPath: 'name' }, { fieldPath: 'points' },
            { fieldPath: 'totalPoints' }, { fieldPath: 'card' }, { fieldPath: 'blocked' }
          ]}
        }
      })
    });
    const allDocs = await allRes.json();
    const lbAll = [];
    if (Array.isArray(allDocs)) {
      for (const item of allDocs) {
        if (!item.document) continue;
        const f = item.document.fields || {};
        if (f.blocked?.booleanValue === true) continue;
        lbAll.push({
          name: f.name?.stringValue || '—',
          points: Number(f.points?.integerValue || 0),
          totalPoints: Number(f.totalPoints?.integerValue || 0),
          card: f.card?.stringValue || '',
        });
      }
    }
    lbAll.sort((a, b) => b.totalPoints - a.totalPoints || (a.name || '').localeCompare(b.name || '', 'el'));
    const top20 = lbAll.slice(0, 20).map(c => ({
      name: c.name.split(' ').map((w, i) => i === 0 ? w : (w[0] || '') + '.').join(' '),
      points: c.points,
      totalPoints: c.totalPoints,
      card: c.card ? c.card.slice(0, 3) + '••••' : '',
    }));
    await fetch(
      `${fsBase}/ipear_leaderboard/latest`,
      {
        method: 'PATCH', headers: fsHeaders,
        body: JSON.stringify({ fields: {
          top: { arrayValue: { values: top20.map(c => ({ mapValue: { fields: {
            name: { stringValue: c.name },
            points: { integerValue: c.points },
            totalPoints: { integerValue: c.totalPoints },
            card: { stringValue: c.card },
          }}})) }},
          total: { integerValue: lbAll.length },
          updatedAt: { stringValue: new Date().toISOString() },
        }})
      }
    );
    console.log(`[leaderboard] rebuilt — ${lbAll.length} customers, top 20 published`);
  } catch (lbErr) {
    console.warn('[leaderboard] async rebuild failed:', lbErr.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  MEDIUM-1: /admin/export-backup — R2-backed, HMAC-signed download URL.
//
//  Previous behaviour: streamed the full customer PII dump (up to 50 000 rows)
//  through the response body under CORS. A stolen ADMIN_SECRET = instant
//  full-DB exfiltration over a single HTTPS request.
//
//  New behaviour:
//    POST /admin/export-backup     (ADMIN_SECRET-gated)
//        → uploads compact JSON to R2 under a random key
//        → returns { downloadUrl, expiresAt, totalCustomers, key }
//        → writes an audit_logs row with the calling IP + key
//
//    GET  /admin/export-download   (HMAC-signed URL, no secret in URL)
//        → key+exp+sig query params; HMAC verified timing-safely
//        → streams the R2 object body; 410 once expired
//
//  Reqs: env.BACKUP_R2 (R2 binding), env.ADMIN_SECRET (HMAC key).
//  Setup (one-time, Cloudflare dashboard):
//    1. R2 → Create bucket "ipear-backups"
//    2. wrangler.toml: add the [[r2_buckets]] block (already templated)
//    3. wrangler secret put ADMIN_SECRET (already set)
//    4. Optional retention rule on R2: delete after 30 days
// ══════════════════════════════════════════════════════════════════════════

// HMAC-SHA-256 signing of "key:expEpochMs" using ADMIN_SECRET.
// Returns lowercase hex. Use timingSafeHexEqual() to verify.
async function _hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

// Timing-safe equality on equal-length hex strings.
function _timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleExportBackup(request, env, CORS) {
  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID)
    return resp({ error: 'Server not configured' }, 503, CORS);
  if (!env.BACKUP_R2) {
    return resp({
      error: 'BACKUP_R2 binding missing. Configure an R2 bucket in wrangler.toml ' +
             '([[r2_buckets]] binding="BACKUP_R2" bucket_name="ipear-backups").'
    }, 503, CORS);
  }
  if (!env.ADMIN_SECRET) {
    return resp({ error: 'ADMIN_SECRET not configured (required for signed-URL HMAC).' }, 503, CORS);
  }

  try {
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const projectId = env.FCM_PROJECT_ID;
    const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const fsHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

    // Fetch all customers — select only critical fields for a lean backup
    const queryRes = await fetch(`${fsBase}:runQuery`, {
      method: 'POST', headers: fsHeaders,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'ipear_customers' }],
          select: { fields: [
            { fieldPath: 'card' }, { fieldPath: 'name' }, { fieldPath: 'email' },
            { fieldPath: 'phone' }, { fieldPath: 'points' }, { fieldPath: 'totalPoints' },
            { fieldPath: 'blocked' }, { fieldPath: 'createdAt' }, { fieldPath: 'uid' }
          ]},
          limit: 50000
        }
      })
    });
    if (!queryRes.ok) {
      return resp({ error: 'Firestore query failed', status: queryRes.status }, 502, CORS);
    }
    const results = await queryRes.json();
    const customers = [];
    if (Array.isArray(results)) {
      for (const item of results) {
        if (!item.document) continue;
        const f = item.document.fields || {};
        const docId = item.document.name.split('/').pop();
        customers.push({
          docId,
          uid:         f.uid?.stringValue || '',
          card:        f.card?.stringValue || '',
          name:        f.name?.stringValue || '',
          email:       f.email?.stringValue || '',
          phone:       f.phone?.stringValue || '',
          points:      Number(f.points?.integerValue || 0),
          totalPoints: Number(f.totalPoints?.integerValue || 0),
          blocked:     f.blocked?.booleanValue === true,
          createdAt:   f.createdAt?.stringValue || '',
        });
      }
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      source: 'ipear-loyalty-worker',
      projectId,
      totalCustomers: customers.length,
      customers,
    };

    // ── Upload to R2 with random key (PII never leaves R2 over CORS) ──
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const rndBytes = new Uint8Array(8);
    crypto.getRandomValues(rndBytes);
    const rnd = Array.from(rndBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const key = `backup-${ts}-${rnd}.json`;
    const body = JSON.stringify(payload);

    await env.BACKUP_R2.put(key, body, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        exportedAt: payload.exportedAt,
        totalCustomers: String(payload.totalCustomers),
      },
    });

    // ── Sign URL valid for 10 minutes ──
    const EXPIRY_MS = 10 * 60 * 1000;
    const expiresAtMs = Date.now() + EXPIRY_MS;
    const sig = await _hmacHex(env.ADMIN_SECRET, `${key}:${expiresAtMs}`);
    const downloadUrl = `${new URL(request.url).origin}/admin/export-download` +
      `?key=${encodeURIComponent(key)}&exp=${expiresAtMs}&sig=${sig}`;

    // ── Best-effort audit log row (rules: audit_logs admin-only create) ──
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    fetch(`${fsBase}/audit_logs`, {
      method: 'POST', headers: fsHeaders,
      body: JSON.stringify({ fields: {
        action:         { stringValue: 'export-backup' },
        actor:          { stringValue: 'admin-secret' },
        ip:             { stringValue: ip },
        r2Key:          { stringValue: key },
        totalCustomers: { integerValue: payload.totalCustomers },
        bytesUploaded:  { integerValue: body.length },
        expiresAt:      { stringValue: new Date(expiresAtMs).toISOString() },
        createdAt:      { stringValue: new Date().toISOString() }
      }})
    }).catch(e => console.warn('[export-backup] audit log failed:', e.message));

    console.log(`[export-backup] r2-uploaded ${key} (${body.length} bytes, ${customers.length} customers)`);
    return resp({
      ok: true,
      downloadUrl,
      key,
      totalCustomers: payload.totalCustomers,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }, 200, CORS);
  } catch (e) {
    console.error('[export-backup]', e.message, e.stack);
    return resp({ error: 'Internal error' }, 500, CORS);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  GET /admin/export-download?key=...&exp=...&sig=...
//  HMAC-gated R2 streaming. No ADMIN_SECRET in URL — the signature IS auth.
//  Routed in the PUBLIC section because the signature is the only credential.
// ══════════════════════════════════════════════════════════════════════════
async function handleExportDownload(request, env, CORS) {
  if (!env.BACKUP_R2 || !env.ADMIN_SECRET) {
    return resp({ error: 'Service not configured' }, 503, CORS);
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  // Per-IP rate limit defends against signature-guessing attempts.
  { const _rl = await rateLimitOrBlock(env, ip, 'export-dl', 30, 900, CORS); if (_rl) return _rl; }

  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  const exp = url.searchParams.get('exp') || '';
  const sig = (url.searchParams.get('sig') || '').toLowerCase();

  // Whitelist: key must look like one of our generated names.
  if (!/^backup-\d{14}-[0-9a-f]{16}\.json$/.test(key)) {
    return resp({ error: 'Invalid key' }, 400, CORS);
  }
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs <= 0) {
    return resp({ error: 'Invalid expiry' }, 400, CORS);
  }
  if (!/^[0-9a-f]{64}$/.test(sig)) {
    return resp({ error: 'Invalid signature' }, 400, CORS);
  }
  if (Date.now() > expMs) {
    return resp({ error: 'Signed URL expired' }, 410, CORS);
  }
  const expected = await _hmacHex(env.ADMIN_SECRET, `${key}:${expMs}`);
  if (!_timingSafeHexEqual(sig, expected)) {
    return resp({ error: 'Signature mismatch' }, 403, CORS);
  }

  // Stream the object back to the caller. The browser handles the download.
  const obj = await env.BACKUP_R2.get(key);
  if (!obj) return resp({ error: 'Not found' }, 404, CORS);

  return new Response(obj.body, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${key}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  POST /log-event — Zero-Cookie Business Funnel Analytics
//
//  Lightweight, anonymous event counter for GDPR-compliant funnel tracking.
//  Accepts: { event: "offer_opened" | "offer_dismissed" | "offer_redeemed" | ... }
//  Increments counters in Firestore doc ipear_analytics/daily_YYYY-MM-DD.
//  No PII, no cookies, no user identification — just aggregate counts.
//  Public endpoint, rate-limited (shares client-error bucket).
// ══════════════════════════════════════════════════════════════════════════
const ALLOWED_EVENTS = [
  'offer_opened', 'offer_dismissed', 'offer_confirmed',
  'offer_redeemed', 'offer_cancelled_qr',
  'reward_opened', 'reward_redeemed', 'reward_cancelled',
];

// ── KV-leak fix (URGENT) ─────────────────────────────────────────────────────
// Previously: every /log-event hit consumed ~4 KV writes (2 for the IP rate
// limit, 2 for the per-event daily counter). The free-tier ceiling is 1k
// writes/day total, so a handful of active customers exhausted half the quota
// in hours. This rewrite keeps Firestore as the single source of truth for the
// admin analytics dashboard and moves both rate-limit + counter accumulation
// into the worker isolate. Firestore writes are amortized via a periodic
// flush, so N raw events → ~1 Firestore write per isolate per 30s.
//
// Tradeoffs explicitly accepted:
//   • Isolate eviction loses any unflushed counts (a few seconds of analytics).
//     Acceptable — these are funnel counters, not financial records.
//   • Rate limit is per-isolate, not global. An attacker rotating across CF
//     edges could exceed 30 events / 15 min, but the worst-case cost is paid
//     in Firestore reads (1 read + 1 write per isolate per 30s), not KV
//     writes. The quota damage is bounded.
const _logEventBuckets = new Map();           // ip → { windowStart, hits }
const LOG_EVENT_RATE_MAX = 30;                // events / IP / 15 min, isolate-local
const _eventBuffer = new Map();               // event name → accumulated count
let _eventBufferLastFlushAt = 0;
const EVENT_FLUSH_INTERVAL_MS = 30_000;       // amortize Firestore writes

function _isLogEventRateLimited(ip) {
  const now = Date.now();
  const b = _logEventBuckets.get(ip);
  if (!b || now - b.windowStart > RATE_LIMIT_WINDOW_MS) {
    _logEventBuckets.set(ip, { windowStart: now, hits: 1 });
    return false;
  }
  b.hits++;
  return b.hits > LOG_EVENT_RATE_MAX;
}

async function _flushEventBuffer(env) {
  if (_eventBuffer.size === 0) return;
  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID) return;

  // Snapshot + reset so concurrent /log-event calls accumulate into a fresh
  // bucket while we PATCH Firestore.
  const snapshot = new Map(_eventBuffer);
  _eventBuffer.clear();

  try {
    const accessToken = await getAuthAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
    const projectId = env.FCM_PROJECT_ID;
    const today = new Date().toISOString().slice(0, 10);
    const docPath = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ipear_analytics/daily_${today}`;
    const fsHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

    const readRes = await fetch(docPath, { headers: fsHeaders });
    let fields = {};
    if (readRes.ok) {
      const doc = await readRes.json();
      fields = doc.fields || {};
    }

    for (const [event, delta] of snapshot) {
      const currentCount = Number(fields[event]?.integerValue || 0);
      fields[event] = { integerValue: currentCount + delta };
    }
    fields.updatedAt = { stringValue: new Date().toISOString() };
    fields.date = { stringValue: today };

    await fetch(docPath, {
      method: 'PATCH', headers: fsHeaders,
      body: JSON.stringify({ fields })
    });
  } catch (e) {
    console.warn('[log-event] flush failed:', e.message);
    // Best-effort restore so the deltas are retried on the next flush.
    for (const [event, delta] of snapshot) {
      _eventBuffer.set(event, (_eventBuffer.get(event) || 0) + delta);
    }
  }
}

async function handleLogEvent(request, env, CORS, ctx) {
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (_isLogEventRateLimited(clientIP)) {
    return resp({ ok: true }, 200, CORS); // silent drop, no KV write
  }

  let body;
  try { body = await readJsonCapped(request, 32 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  const event = String(body.event || '').trim().toLowerCase();
  if (!event || !ALLOWED_EVENTS.includes(event)) {
    return resp({ error: 'Unknown event' }, 400, CORS);
  }

  // In-isolate accumulation. Zero KV ops on the hot path.
  _eventBuffer.set(event, (_eventBuffer.get(event) || 0) + 1);

  // Opportunistic background flush — claim the slot via timestamp BEFORE
  // awaiting so concurrent handlers don't double-schedule.
  const now = Date.now();
  if (now - _eventBufferLastFlushAt > EVENT_FLUSH_INTERVAL_MS) {
    _eventBufferLastFlushAt = now;
    const flushP = _flushEventBuffer(env);
    if (ctx && ctx.waitUntil) ctx.waitUntil(flushP);
    else flushP.catch(() => {});
  }

  return resp({ ok: true }, 200, CORS);
}

// ══════════════════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ══════════════════════════════════════════════════════════════════════════

function resp(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Timing-safe string comparison via SHA-256 hashing — prevents timing-based secret extraction
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const aa = new Uint8Array(ha), ba = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= aa[i] ^ ba[i];
  return diff === 0;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
}

// ── Email HTML Template ───────────────────────────────────────────────────
function buildHtmlEmail(message) {
  const htmlMsg = escHtml(message);
  return `<!DOCTYPE html>
<html lang="el">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>iPear Loyalty</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
  <tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0"
         style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;
                overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.10)">

    <!-- HEADER -->
    <tr>
      <td style="background:linear-gradient(135deg,#6bb800 0%,#8ae900 100%);padding:36px 40px;text-align:center">
        <div style="font-size:34px;font-weight:900;color:#0a0a0a;letter-spacing:-1.5px;line-height:1">
          iPear<span style="color:#ffffff">Loyalty</span>
        </div>
        <div style="font-size:12px;color:rgba(0,0,0,.50);margin-top:6px;
                    text-transform:uppercase;letter-spacing:3px;font-weight:600">
          Loyalty Program
        </div>
      </td>
    </tr>

    <!-- BODY -->
    <tr>
      <td style="padding:40px 44px 32px">
        <p style="font-size:22px;font-weight:800;color:#0a0a0a;margin:0 0 20px;line-height:1.2">
          Γεια σου, {{params.name}}! 👋
        </p>
        <p style="font-size:15px;color:#444444;line-height:1.75;margin:0 0 28px">
          ${htmlMsg}
        </p>

        <!-- Points badge -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
          <tr>
            <td style="background:#f0ffe0;border:1.5px solid #8ae900;border-radius:14px;
                       padding:22px;text-align:center">
              <div style="font-size:11px;color:#666;text-transform:uppercase;
                          letter-spacing:2px;font-weight:700;margin-bottom:8px">
                Οι πόντοι σου
              </div>
              <div style="font-size:52px;font-weight:900;color:#5a9900;line-height:1;
                          letter-spacing:-2px">
                {{params.points}}
              </div>
              <div style="font-size:13px;color:#888;margin-top:6px;font-weight:600">
                iPear Loyalty Points 🍐
              </div>
            </td>
          </tr>
        </table>

        <p style="font-size:14px;color:#888888;margin:0;line-height:1.6">
          Σε περιμένουμε στο κατάστημα iPear! 🍐
        </p>
      </td>
    </tr>

    <!-- DIVIDER -->
    <tr>
      <td style="padding:0 44px">
        <div style="height:1px;background:#eeeeee"></div>
      </td>
    </tr>

    <!-- FOOTER -->
    <tr>
      <td style="background:#fafafa;padding:24px 44px;text-align:center;border-radius:0 0 18px 18px">
        <p style="font-size:12px;color:#aaaaaa;margin:0;line-height:1.8">
          © iPear Loyalty Program 🍐<br>
          <span style="color:#cccccc">Λαμβάνεις αυτό το email επειδή εγγράφηκες στο iPear Loyalty.</span><br>
          <a href="{{params.unsubscribeUrl}}" style="color:#888888;text-decoration:underline;font-weight:600">Κατάργηση εγγραφής</a>
        </p>
      </td>
    </tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;
}
