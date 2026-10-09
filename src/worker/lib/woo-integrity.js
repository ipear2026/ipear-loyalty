// ═══════════════════════════════════════════════════════════════════════════
//  woo-integrity.js — Phase L1 (audit-corrected build 2)
//
//  Design principles (see buildL1/DESIGN.md):
//
//    1. Auth isolation
//       These handlers accept ONLY env.WOO_LOYALTY_SECRET. They never
//       fall back to ADMIN_SECRET. The router calls verifyWooSecret() before
//       any Firestore work. Secrets are never included in logs, order notes,
//       responses, or thrown error messages.
//
//    2. Firestore is the only correctness gate — KV is response cache only
//       Every credit/refund request enters the Firestore transaction and
//       reads the authoritative ledger. KV NEVER decides replay/conflict/
//       apply on its own. A matching but corrupted or stale KV entry
//       therefore cannot skip a real mutation nor duplicate one — the
//       ledger read inside the transaction is the sole source of truth.
//       The KV write happens AFTER a successful commit, purely as a
//       response cache for read-only consumers; it is not consulted by
//       these handlers on entry.
//
//    3. Deterministic identity across retries
//       - siteHash = sha256(env.WOO_SITE_URL)[..12]  (server-side, never
//         from the request body — a compromised plugin cannot spoof another
//         site's ledger key).
//       - Ledger docId = {siteHash}__{orderId} — same order always maps
//         to the same doc.
//       - Audit transaction docId = wooc__{ledgerId}__{sanitize(nonce)}
//         or woor__{ledgerId}__{refundId} — retries with the same nonce
//         map to the same audit doc, so an at-least-once retry cannot
//         produce two audit rows.
//
//    4. Cumulative refund reconciliation
//       Points reversed on any given refund are computed against the
//       CUMULATIVE refund cents, not the isolated refund amount:
//           target = floor(min(cum_refund_cents, original_credit_cents) × PPE / 100)
//           delta  = target − already_reversed_points
//       Only `delta` is applied to the customer balance. This prevents
//       rounding drift when many small partials are aggregated and
//       guarantees total reversal never exceeds the original credit.
//
//    5. Refund-before-credit
//       If a refund action fires before the credit action lands, the
//       ledger is created in state=pre-refunded with pre_credit_refunds[]
//       accumulating the refunded product cents. When the credit action
//       later fires, it subtracts those cents from the eligible amount:
//           net_eligible = original_eligible − sum(pre_credit_refunds)
//       If net_eligible ≤ 0 the credit is skipped (state=zero-net-credit)
//       and no balance mutation occurs.
//
//    6. Identity freeze
//       On the FIRST successful credit, the customer's normalized email
//       and resolved uid are frozen into the ledger. All later refunds
//       and replays use ledger.customerUid — never a re-lookup by email —
//       so a later billing-email change cannot subtract points from a
//       different customer. Guest without a loyalty account is a hard 404
//       — no auto-account creation.
// ═══════════════════════════════════════════════════════════════════════════

const POINTS_PER_EURO      = 10;
const KV_CACHE_TTL_SECONDS = 90 * 24 * 60 * 60;
const KV_KEY_PREFIX        = 'woo:credit:';
const MAX_EVENT_LOG_ENTRIES = 200;              // hard defense against runaway; a real order never approaches this
const MAX_SAFE_INT_CENTS   = Number.MAX_SAFE_INTEGER;  // ~9.0e15 — no business cap
const TXN_CONTENTION_RETRIES = 3;

export const STATE = Object.freeze({
  ABSENT:          'absent',            // synthetic — never persisted
  PRE_REFUNDED:    'pre-refunded',      // refund arrived before credit
  CREDITED:        'credited',
  REFUNDED:        'refunded',          // partial or full, but net > 0 (may still receive further partials)
  ZERO_NET_CREDIT: 'zero-net-credit',   // credit landed after refunds cancelled it out
  CANCELLED:       'cancelled',
  CONFLICT:        'conflict',
});

// ══════════════════════════════════════════════════════════════════════════
//  Auth — isolated secret path
// ══════════════════════════════════════════════════════════════════════════

// Uses the same timingSafeEqual helper as the rest of the worker. The
// router injects it via deps.timingSafeEqual so we don't force a duplicate
// implementation into every consumer.
async function verifyWooSecret(request, env, timingSafeEqual) {
  const configured = String(env.WOO_LOYALTY_SECRET || '');
  if (!configured) return { ok: false, code: 503, reason: 'server-misconfigured' };
  const header = String(request.headers.get('Authorization') || '');
  const presented = header.replace(/^Bearer\s+/i, '');
  if (!presented) return { ok: false, code: 401, reason: 'missing-auth' };
  const match = await timingSafeEqual(presented, configured);
  return match ? { ok: true } : { ok: false, code: 401, reason: 'bad-auth' };
}

// ══════════════════════════════════════════════════════════════════════════
//  Small utilities
// ══════════════════════════════════════════════════════════════════════════

async function siteHashFromEnv(env) {
  const configured = String(env.WOO_SITE_URL || '').trim().toLowerCase();
  if (!configured) throw serverConfig('WOO_SITE_URL not configured');
  const buf = new TextEncoder().encode(configured);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest, 0, 6))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function sanitizeId(v) { return String(v || '').replace(/[^a-zA-Z0-9_\-]/g, ''); }

function ledgerDocId(sh, orderId) { return `${sh}__${sanitizeId(orderId)}`; }

function auditCreditDocId(ledgerId, nonce) {
  // Truncate + sanitize: deterministic per (ledger, nonce). Firestore doc IDs
  // must be <=1500 bytes; we cap at 120 chars from the sanitized nonce.
  return `wooc__${ledgerId}__${sanitizeId(nonce).slice(0, 120)}`;
}
function auditRefundDocId(ledgerId, refundId) {
  return `woor__${ledgerId}__${sanitizeId(refundId).slice(0, 120)}`;
}

function pointsFromCents(cents) {
  return Math.trunc((cents * POINTS_PER_EURO) / 100);
}

function badReq(msg)  { const e = new Error(msg); e.status = 400; return e; }
function serverConfig(msg) { const e = new Error(msg); e.status = 503; return e; }

// Firestore field value → JS scalar
function unwrap(field) {
  if (field == null) return null;
  if ('integerValue'   in field) return Number(field.integerValue);
  if ('stringValue'    in field) return String(field.stringValue);
  if ('doubleValue'    in field) return Number(field.doubleValue);
  if ('booleanValue'   in field) return Boolean(field.booleanValue);
  if ('timestampValue' in field) return String(field.timestampValue);
  if ('mapValue'       in field) {
    const out = {}; const f = field.mapValue.fields || {};
    for (const k of Object.keys(f)) out[k] = unwrap(f[k]);
    return out;
  }
  if ('arrayValue' in field) return (field.arrayValue.values || []).map(unwrap);
  return null;
}
function wrap(v) {
  if (v === null || v === undefined)                    return { nullValue: null };
  if (typeof v === 'boolean')                           return { booleanValue: v };
  if (typeof v === 'number' && Number.isInteger(v))     return { integerValue: String(v) };
  if (typeof v === 'number')                            return { doubleValue: v };
  if (typeof v === 'string')                            return { stringValue: v };
  if (Array.isArray(v))                                 return { arrayValue: { values: v.map(wrap) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = wrap(v[k]);
    return { mapValue: { fields } };
  }
  throw new Error('unwrappable');
}
function wrapMap(obj) { const fields = {}; for (const k of Object.keys(obj)) fields[k] = wrap(obj[k]); return { fields }; }

function decodeLedger(doc) {
  const f = doc?.fields || {};
  return {
    _name:                 doc?.name || null,
    siteHash:              unwrap(f.siteHash)              ?? '',
    orderId:               unwrap(f.orderId)               ?? '',
    customerUid:           unwrap(f.customerUid)           ?? '',
    customerEmail:         unwrap(f.customerEmail)         ?? '',
    state:                 unwrap(f.state)                 ?? STATE.ABSENT,
    version:               unwrap(f.version)               ?? 0,
    // Rate freeze (blocker 4 · corrected build 2)
    pointsPerEuro:         unwrap(f.pointsPerEuro)         ?? 0,    // 0 = legacy ledger; refund path falls back
    // Distinct accounting fields (blocker 2/3 · corrected build 3):
    //   grossEligibleCents             = what the plugin requested at credit time (before pre-credit subtraction)
    //   preCreditRefundedCentsAtCredit = sum of pre-credit refunds at the moment credit landed (frozen)
    //   creditedEligibleCents          = the NET amount actually credited (gross − preCredit)
    //   originalPointsAwarded          = the points balance actually granted (== floor(creditedEligibleCents × ppe / 100))
    //   cumPostCreditRefundedCents     = running sum of refund cents that happened AFTER the credit landed
    //   alreadyReversedPoints          = running sum of points balance already reversed
    // Reversal cap = originalPointsAwarded — never reversed more than actually granted.
    grossEligibleCents:             unwrap(f.grossEligibleCents)             ?? 0,
    preCreditRefundedCentsAtCredit: unwrap(f.preCreditRefundedCentsAtCredit) ?? 0,
    creditedEligibleCents:          unwrap(f.creditedEligibleCents)          ?? 0,
    originalPointsAwarded:          unwrap(f.originalPointsAwarded)          ?? 0,
    cumPostCreditRefundedCents:     unwrap(f.cumPostCreditRefundedCents)     ?? 0,
    alreadyReversedPoints:          unwrap(f.alreadyReversedPoints)          ?? 0,
    preCreditRefunds:      unwrap(f.preCreditRefunds)      ?? [],   // [{ refundId, cents, nonce, at }]
    creditNonce:           unwrap(f.creditNonce)           ?? '',
    creditAt:              unwrap(f.creditAt)              ?? '',
    refunds:               unwrap(f.refunds)               ?? [],   // [{ refundId, cents, points, at, nonce }]
    createdAt:             unwrap(f.createdAt)             ?? '',
    lastEventAt:           unwrap(f.lastEventAt)           ?? '',
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  Firestore REST helpers
// ══════════════════════════════════════════════════════════════════════════

async function fsGet(fsBase, fsHeaders, relPath, transaction) {
  const url = transaction
    ? `${fsBase}/${relPath}?transaction=${encodeURIComponent(transaction)}`
    : `${fsBase}/${relPath}`;
  const r = await fetch(url, { headers: fsHeaders });
  if (r.status === 404) return { exists: false, doc: null, status: 404 };
  if (!r.ok) { const t = await r.text(); const e = new Error(`fsGet ${relPath} → ${r.status}`); e._body = t.slice(0, 200); throw e; }
  return { exists: true, doc: await r.json(), status: 200 };
}

async function fsBeginTx(fsBase, fsHeaders) {
  const url = fsBase.replace(/\/documents$/, '/documents:beginTransaction');
  const r = await fetch(url, { method: 'POST', headers: fsHeaders, body: JSON.stringify({}) });
  if (!r.ok) throw new Error(`beginTransaction → ${r.status}`);
  return (await r.json()).transaction;
}

async function fsCommit(fsBase, fsHeaders, transaction, writes) {
  const url = fsBase.replace(/\/documents$/, '/documents:commit');
  const r = await fetch(url, {
    method: 'POST', headers: fsHeaders,
    body: JSON.stringify({ transaction, writes }),
  });
  if (r.status === 409) { const e = new Error('CONTENTION'); e.contention = true; throw e; }
  if (!r.ok) { const t = await r.text(); const e = new Error(`commit → ${r.status}`); e._body = t.slice(0, 200); throw e; }
  return r.json();
}

async function fsRollback(fsBase, fsHeaders, transaction) {
  if (!transaction) return;
  const url = fsBase.replace(/\/documents$/, '/documents:rollback');
  await fetch(url, {
    method: 'POST', headers: fsHeaders, body: JSON.stringify({ transaction }),
  }).catch(() => {});
}

async function findCustomerByEmail(fsBase, fsHeaders, email) {
  const r = await fetch(`${fsBase}:runQuery`, {
    method: 'POST', headers: fsHeaders,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'ipear_customers' }],
        where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
        limit: 1,
      },
    }),
  });
  if (!r.ok) throw new Error(`runQuery → ${r.status}`);
  const res = await r.json();
  const doc = Array.isArray(res) && res[0]?.document;
  if (!doc) return null;
  return { docName: doc.name, docId: doc.name.split('/').pop(), fields: doc.fields || {} };
}

// ══════════════════════════════════════════════════════════════════════════
//  Input validation
// ══════════════════════════════════════════════════════════════════════════

function parseCredit(body) {
  const orderId       = sanitizeId(String(body?.orderId ?? '')).slice(0, 64);
  const email         = String(body?.email ?? '').trim().toLowerCase();
  const nonce         = String(body?.eventNonce ?? '').trim().slice(0, 128);
  const eligibleCents = Number(body?.eligibleCents);
  if (!orderId)                                        throw badReq('orderId required');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badReq('valid email required');
  if (!nonce)                                          throw badReq('eventNonce required');
  if (!Number.isInteger(eligibleCents) || eligibleCents < 0)     throw badReq('eligibleCents must be a non-negative integer');
  if (eligibleCents > MAX_SAFE_INT_CENTS)              throw badReq('eligibleCents exceeds safe integer range');
  return { orderId, email, nonce, eligibleCents };
}

function parseRefund(body) {
  const orderId     = sanitizeId(String(body?.orderId ?? '')).slice(0, 64);
  const refundId    = sanitizeId(String(body?.refundId ?? '')).slice(0, 64);
  const email       = String(body?.email ?? '').trim().toLowerCase();
  const nonce       = String(body?.eventNonce ?? '').trim().slice(0, 128);
  const refundCents = Number(body?.refundCents);
  if (!orderId)                                        throw badReq('orderId required');
  if (!refundId)                                       throw badReq('refundId required');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badReq('valid email required');
  if (!nonce)                                          throw badReq('eventNonce required');
  if (!Number.isInteger(refundCents) || refundCents <= 0) throw badReq('refundCents must be a positive integer');
  if (refundCents > MAX_SAFE_INT_CENTS)                throw badReq('refundCents exceeds safe integer range');
  return { orderId, refundId, email, nonce, refundCents };
}

// ══════════════════════════════════════════════════════════════════════════
//  Non-authoritative KV cache
// ══════════════════════════════════════════════════════════════════════════

async function kvGet(env, sh, orderId) {
  if (!env.RATE_LIMIT_KV) return null;
  try { return JSON.parse((await env.RATE_LIMIT_KV.get(`${KV_KEY_PREFIX}${sh}:${orderId}`)) || 'null'); }
  catch { return null; }
}
async function kvPut(env, sh, orderId, payload) {
  if (!env.RATE_LIMIT_KV) return;
  try { await env.RATE_LIMIT_KV.put(`${KV_KEY_PREFIX}${sh}:${orderId}`, JSON.stringify(payload), { expirationTtl: KV_CACHE_TTL_SECONDS }); }
  catch {}
}

// ══════════════════════════════════════════════════════════════════════════
//  Pure decision functions (exported for tests)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Given the current ledger and incoming credit event, decide the outcome.
 * Returns { kind, ... }:
 *   kind='replay'   → same nonce OR same cents: no-op, return stored result
 *   kind='apply'    → pointsDelta, netEligibleCents  (delta may be 0 → zero-net)
 *   kind='conflict' → refuse with 409, reason + stored
 */
export function decideCredit(ledger, incoming) {
  const { eligibleCents, nonce } = incoming;
  const st = ledger.state || STATE.ABSENT;

  // Replay: same nonce with same GROSS cents ALWAYS replays.
  if ((st === STATE.CREDITED || st === STATE.REFUNDED || st === STATE.ZERO_NET_CREDIT)
      && ledger.creditNonce === nonce && ledger.grossEligibleCents === eligibleCents) {
    return { kind: 'replay', pointsDelta: 0, creditedEligibleCents: ledger.creditedEligibleCents };
  }

  if (st === STATE.ABSENT) {
    // Fresh credit — no prior refunds to reconcile
    const points = pointsFromCents(eligibleCents);
    return {
      kind: 'apply', pointsDelta: points,
      grossEligibleCents:             eligibleCents,
      preCreditRefundedCentsAtCredit: 0,
      creditedEligibleCents:          eligibleCents,
      becomes: STATE.CREDITED,
    };
  }

  if (st === STATE.PRE_REFUNDED) {
    // A refund arrived before credit. Reconcile eligible.
    const preRefundCents = (ledger.preCreditRefunds || []).reduce((s, r) => s + (r.cents || 0), 0);
    const netCents = Math.max(0, eligibleCents - preRefundCents);
    if (netCents === 0) {
      // Nothing to credit — no balance mutation, transition to zero-net state.
      return {
        kind: 'apply', pointsDelta: 0,
        grossEligibleCents:             eligibleCents,
        preCreditRefundedCentsAtCredit: preRefundCents,
        creditedEligibleCents:          0,
        becomes: STATE.ZERO_NET_CREDIT,
      };
    }
    const points = pointsFromCents(netCents);
    return {
      kind: 'apply', pointsDelta: points,
      grossEligibleCents:             eligibleCents,
      preCreditRefundedCentsAtCredit: preRefundCents,
      creditedEligibleCents:          netCents,
      becomes: STATE.CREDITED,
    };
  }

  if (st === STATE.CREDITED || st === STATE.REFUNDED || st === STATE.ZERO_NET_CREDIT) {
    // Compare against grossEligibleCents (what the plugin sent), not the
    // net-after-pre-refund creditedEligibleCents. Two retries of the SAME
    // credit request always send the same gross value.
    if (ledger.grossEligibleCents === eligibleCents) {
      return { kind: 'replay', pointsDelta: 0, creditedEligibleCents: ledger.creditedEligibleCents };
    }
    return {
      kind: 'conflict',
      reason: 'credited-different-cents',
      stored: {
        grossCents: ledger.grossEligibleCents,
        creditedCents: ledger.creditedEligibleCents,
        points: ledger.originalPointsAwarded,
        state: st,
      },
    };
  }

  if (st === STATE.CANCELLED) {
    return { kind: 'conflict', reason: 'cancelled-cannot-re-credit' };
  }
  return { kind: 'conflict', reason: `unknown-state-${st}` };
}

/**
 * Refund decision using cumulative reconciliation.
 * Returns { kind, ... }:
 *   kind='replay'         → refund with this refundId already processed with the SAME cents
 *   kind='conflict'       → refund with same refundId but different cents, or refund exceeds credit
 *   kind='apply-precredit'→ ledger not credited yet; record refund into preCreditRefunds[] (0 balance mutation)
 *   kind='apply'          → mutate balance by pointsDelta (may be 0 due to floor)
 */
export function decideRefund(ledger, incoming) {
  const { refundId, refundCents } = incoming;
  const st = ledger.state || STATE.ABSENT;

  // Replay by refundId (real WC refund, cancel-*, or failed-*).
  const priorReal = (ledger.refunds || []).find(r => r.refundId === refundId);
  if (priorReal) {
    if (priorReal.cents === refundCents) return { kind: 'replay', pointsDelta: priorReal.points || 0 };
    return { kind: 'conflict', reason: 'refundId-different-cents', stored: { refundId, cents: priorReal.cents, points: priorReal.points } };
  }
  const priorPre = (ledger.preCreditRefunds || []).find(r => r.refundId === refundId);
  if (priorPre) {
    if (priorPre.cents === refundCents) return { kind: 'replay', pointsDelta: 0 };
    return { kind: 'conflict', reason: 'refundId-different-cents-precredit', stored: { refundId, cents: priorPre.cents } };
  }

  if (st === STATE.ABSENT) {
    // Refund arrived before credit — record it, no balance mutation.
    return { kind: 'apply-precredit', pointsDelta: 0 };
  }

  if (st === STATE.PRE_REFUNDED) {
    // Additional pre-credit refund
    return { kind: 'apply-precredit', pointsDelta: 0 };
  }

  if (st === STATE.CREDITED || st === STATE.REFUNDED) {
    // Point rate FREEZE: use the pointsPerEuro that was in effect at the
    // time of the original credit, not the current global. Legacy ledgers
    // without a stored rate fall back to the current constant.
    const ppe      = Number.isFinite(ledger.pointsPerEuro) && ledger.pointsPerEuro > 0
                       ? ledger.pointsPerEuro : POINTS_PER_EURO;
    const original = ledger.creditedEligibleCents || 0;
    const cumSoFar = ledger.cumPostCreditRefundedCents || 0;
    const already  = ledger.alreadyReversedPoints || 0;
    const capped   = Math.min(cumSoFar + refundCents, original);
    const target   = Math.trunc((capped * ppe) / 100);
    let delta      = target - already;
    if (delta < 0) delta = 0;                       // never re-add points via a refund
    if (delta > ledger.originalPointsAwarded - already) {
      delta = Math.max(0, ledger.originalPointsAwarded - already);
    }
    return {
      kind: 'apply',
      pointsDelta: delta,
      newCumRefunded: cumSoFar + refundCents,
      newAlreadyReversed: already + delta,
      capped,
      pointsPerEuro: ppe,
    };
  }

  if (st === STATE.ZERO_NET_CREDIT) {
    // Order already fully offset by pre-credit refunds; further refunds are logged but do not mutate balance.
    return { kind: 'apply', pointsDelta: 0, newCumRefunded: (ledger.cumPostCreditRefundedCents || 0) + refundCents, newAlreadyReversed: ledger.alreadyReversedPoints || 0, capped: (ledger.cumPostCreditRefundedCents || 0) + refundCents };
  }

  return { kind: 'conflict', reason: `refund-not-allowed-from-${st}` };
}

// Apply a refund's qualifying reversal to the customer's spendable + qualifying
// balances. PURE (no Firestore) so the full negative-balance + totalPoints
// invariant is unit-testable.
//
//   • Spendable `points` MAY go negative — ledger truth wins, no zero clamp.
//   • `totalPoints` (net qualifying / tier basis) is reversed by the SAME
//     qualifying delta. Because the refund FSM caps cumulative reversal at the
//     order's originalPointsAwarded, a refund can never reverse more qualifying
//     points than that order added, so totalPoints should never go negative in
//     the supported path. If it WOULD (unexpected/inconsistent historical
//     state — e.g. an external tier_downgrade already reduced totalPoints),
//     we FAIL CLOSED: caller must roll back and mutate nothing.
//
// `delta` is the spendable points being reversed by THIS refund event; for the
// base-only Woo credit, the qualifying delta equals the spendable delta.
export function applyRefundBalances(curPts, curTot, delta) {
  const d = Number(delta) || 0;
  const newPoints = Number(curPts) - d;          // negative allowed (ledger truth)
  const newTotalPoints = Number(curTot) - d;     // qualifying reversal
  if (newTotalPoints < 0) {
    return { ok: false, reason: 'totalPoints-would-go-negative', curTot: Number(curTot), delta: d };
  }
  return { ok: true, newPoints, newTotalPoints };
}

// ══════════════════════════════════════════════════════════════════════════
//  Router-facing handlers
// ══════════════════════════════════════════════════════════════════════════

export async function handleWooCreditOrder(request, env, CORS, ctx, deps) {
  const { resp, readJson, getAccessToken, timingSafeEqual, rebuildLeaderboard } = deps || {};
  if (!resp || !readJson || !getAccessToken || !timingSafeEqual) throw new Error('deps required');

  const auth = await verifyWooSecret(request, env, timingSafeEqual);
  if (!auth.ok) return resp({ error: 'Unauthorized', reason: auth.reason }, auth.code, CORS);

  let body; try { body = await readJson(request, 8 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  let parsed; try { parsed = parseCredit(body); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID) {
    return resp({ error: 'Server not configured' }, 503, CORS);
  }

  let sh; try { sh = await siteHashFromEnv(env); }
  catch (e) { return resp({ error: e.message }, e.status || 503, CORS); }

  const { orderId, email, nonce, eligibleCents } = parsed;
  const ledgerId = ledgerDocId(sh, orderId);

  // NO KV fast-path — every request enters the authoritative Firestore
  // transaction below. Correctness never depends on KV state.

  const accessToken = await getAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
  const projectId = env.FCM_PROJECT_ID;
  const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  // Firestore REST Write.update.name MUST be the RELATIVE resource form
  // (projects/{p}/databases/{db}/documents/{path}), NOT a URL. A URL-form
  // name causes the whole :commit to be rejected atomically with HTTP 400.
  const docBase = `projects/${projectId}/databases/(default)/documents`;
  const fsHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

  // Customer resolution — done outside transaction (runQuery is not a
  // transactional read via REST). We freeze the resolved uid into the ledger.
  const customer = await findCustomerByEmail(fsBase, fsHeaders, email);
  if (!customer) return resp({ error: 'Customer not found', state: 'not-found' }, 404, CORS);

  let lastErr;
  for (let attempt = 0; attempt <= TXN_CONTENTION_RETRIES; attempt++) {
    let txn;
    try {
      txn = await fsBeginTx(fsBase, fsHeaders);
      const [ledgerRead, custRead] = await Promise.all([
        fsGet(fsBase, fsHeaders, `ipear_woo_events/${ledgerId}`, txn),
        fsGet(fsBase, fsHeaders, `ipear_customers/${customer.docId}`, txn),
      ]);
      if (!custRead.exists) {
        await fsRollback(fsBase, fsHeaders, txn);
        return resp({ error: 'Customer disappeared during txn' }, 500, CORS);
      }

      const ledger = ledgerRead.exists ? decodeLedger(ledgerRead.doc) : { state: STATE.ABSENT, version: 0, preCreditRefunds: [], refunds: [] };
      // Identity freeze: if ledger already has a customerUid, it must match
      // the newly-resolved one. If a billing email changed to a DIFFERENT
      // customer, refuse rather than migrate the credit.
      if (ledger.state !== STATE.ABSENT && ledger.customerUid && ledger.customerUid !== customer.docId) {
        await fsRollback(fsBase, fsHeaders, txn);
        return resp({
          error: 'identity-mismatch',
          reason: 'ledger frozen to a different customerUid; refusing to migrate credit',
        }, 409, CORS);
      }

      const decision = decideCredit(ledger, { eligibleCents, nonce });
      if (decision.kind === 'replay') {
        await fsRollback(fsBase, fsHeaders, txn);
        return resp({
          ok: true, replay: true, source: 'firestore-ledger',
          earnedPoints: ledger.originalPointsAwarded || 0,
          state: ledger.state, idemState: 'replay',
        }, 200, CORS);
      }
      if (decision.kind === 'conflict') {
        await fsRollback(fsBase, fsHeaders, txn);
        return resp({
          error: 'conflict', reason: decision.reason,
          stored: decision.stored || { state: ledger.state },
        }, 409, CORS);
      }

      // apply
      const now = new Date().toISOString();
      const custFields = custRead.doc.fields || {};
      const curPts = Number(custFields.points?.integerValue || 0);
      const curTot = Number(custFields.totalPoints?.integerValue || 0);
      const newPts = curPts + decision.pointsDelta;
      const newTot = curTot + decision.pointsDelta;  // lifetime; delta is >= 0 here

      const newLedger = {
        siteHash:      sh,
        orderId,
        customerUid:   customer.docId,
        customerEmail: email,
        state:         decision.becomes,
        version:       ledger.version + 1,
        // Point-rate freeze: whichever POINTS_PER_EURO applied at first credit
        // is written into the ledger; refund path reads back from here and
        // ignores whatever global rate is in effect later.
        pointsPerEuro:         POINTS_PER_EURO,
        // Accounting fields (see decodeLedger for semantics).
        grossEligibleCents:             decision.grossEligibleCents,
        preCreditRefundedCentsAtCredit: decision.preCreditRefundedCentsAtCredit,
        creditedEligibleCents:          decision.creditedEligibleCents,   // net
        originalPointsAwarded:          decision.pointsDelta,             // reversal cap
        cumPostCreditRefundedCents:     0,
        alreadyReversedPoints:          0,
        preCreditRefunds:      [],                           // consumed
        creditNonce:           nonce,
        creditAt:              now,
        // Pre-credit refunds that fit within the credit are recorded as normal refunds
        // (points 0 because they never became a balance credit) so the audit history is preserved.
        refunds: truncate([...(ledger.preCreditRefunds || []).map(r => ({
          refundId: r.refundId, cents: r.cents, points: 0, at: r.at, nonce: r.nonce, precredit: true,
        }))]),
        createdAt:   ledger.createdAt || now,
        lastEventAt: now,
      };

      // Deterministic audit doc name — retry with same nonce maps to same doc.
      // Built from docBase (relative form) — Firestore rejects URL-form names.
      const auditName = `${docBase}/ipear_transactions/${auditCreditDocId(ledgerId, nonce)}`;

      const writes = [];
      // Only mutate customer if there is a real delta (zero-net skips this).
      if (decision.pointsDelta !== 0) {
        writes.push({
          update: {
            name: custRead.doc.name,
            fields: { ...custFields, points: wrap(newPts), totalPoints: wrap(newTot) },
          },
          updateMask: { fieldPaths: ['points', 'totalPoints'] },
        });
      }
      writes.push({
        update: {
          name: `${docBase}/ipear_woo_events/${ledgerId}`,
          fields: wrapMap(newLedger).fields,
        },
      });
      if (decision.pointsDelta !== 0) {
        writes.push({
          update: {
            name: auditName,
            fields: wrapMap({
              customerId:    customer.docId,
              customerEmail: email,
              customerName:  unwrap(custFields.name) || '',
              card:          unwrap(custFields.card) || '',
              type:          'add',
              points:        decision.pointsDelta,
              amount:        decision.creditedEligibleCents / 100,
              category:      '🛒 Αγορά από E-shop',
              note:          `WooCommerce Order #${orderId} (ledger v${ledger.version + 1})`,
              date:          now,
              source:        'woo-integrity/v2',
            }).fields,
          },
          // No currentDocument guard: deterministic id + txn contention retry
          // means at most one commit reaches this write.
        });
      }

      await fsCommit(fsBase, fsHeaders, txn, writes);

      if (ctx && ctx.waitUntil && rebuildLeaderboard && decision.pointsDelta !== 0) {
        ctx.waitUntil(rebuildLeaderboard(fsBase, fsHeaders).catch(() => {}));
      }

      await kvPut(env, sh, orderId, {
        state: decision.becomes,
        creditNonce: nonce,
        grossEligibleCents:    decision.grossEligibleCents,
        creditedEligibleCents: decision.creditedEligibleCents,
        originalPointsAwarded: decision.pointsDelta,
        cachedAt: now,
      });

      return resp({
        ok: true, replay: false, source: 'firestore-ledger',
        earnedPoints: decision.pointsDelta,
        newBalance: decision.pointsDelta !== 0 ? newPts : curPts,
        newTotalPoints: decision.pointsDelta !== 0 ? newTot : curTot,
        state: decision.becomes,
        version: ledger.version + 1,
        grossEligibleCents:    decision.grossEligibleCents,
        creditedEligibleCents: decision.creditedEligibleCents,
        idemState: ledger.state === STATE.ABSENT ? 'created' : 'transitioned',
      }, 200, CORS);
    } catch (e) {
      lastErr = e;
      if (txn) await fsRollback(fsBase, fsHeaders, txn);
      if (e.contention && attempt < TXN_CONTENTION_RETRIES) continue;
      console.error('[woo-credit-order] error:', e.message);   // secret NEVER in log
      return resp({ error: 'Internal error' }, 500, CORS);
    }
  }
  return resp({ error: 'Contention exhausted' }, 503, CORS);
}

export async function handleWooRefundOrder(request, env, CORS, ctx, deps) {
  const { resp, readJson, getAccessToken, timingSafeEqual } = deps || {};
  if (!resp || !readJson || !getAccessToken || !timingSafeEqual) throw new Error('deps required');

  const auth = await verifyWooSecret(request, env, timingSafeEqual);
  if (!auth.ok) return resp({ error: 'Unauthorized', reason: auth.reason }, auth.code, CORS);

  let body; try { body = await readJson(request, 8 * 1024); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  let parsed; try { parsed = parseRefund(body); }
  catch (e) { return resp({ error: e.message }, e.status || 400, CORS); }

  if (!env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY || !env.FCM_PROJECT_ID) {
    return resp({ error: 'Server not configured' }, 503, CORS);
  }

  let sh; try { sh = await siteHashFromEnv(env); }
  catch (e) { return resp({ error: e.message }, e.status || 503, CORS); }

  const { orderId, refundId, email, nonce, refundCents } = parsed;
  const ledgerId = ledgerDocId(sh, orderId);

  const accessToken = await getAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
  const projectId = env.FCM_PROJECT_ID;
  const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  // Firestore REST Write.update.name MUST be relative — see credit handler.
  const docBase = `projects/${projectId}/databases/(default)/documents`;
  const fsHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken };

  let lastErr;
  for (let attempt = 0; attempt <= TXN_CONTENTION_RETRIES; attempt++) {
    let txn;
    try {
      txn = await fsBeginTx(fsBase, fsHeaders);
      const ledgerRead = await fsGet(fsBase, fsHeaders, `ipear_woo_events/${ledgerId}`, txn);
      const ledger = ledgerRead.exists ? decodeLedger(ledgerRead.doc) : { state: STATE.ABSENT, version: 0, preCreditRefunds: [], refunds: [] };

      const decision = decideRefund(ledger, { refundId, refundCents, nonce });
      if (decision.kind === 'replay') {
        await fsRollback(fsBase, fsHeaders, txn);
        return resp({
          ok: true, replay: true, source: 'firestore-ledger',
          refundedPoints: decision.pointsDelta, idemState: 'replay',
        }, 200, CORS);
      }
      if (decision.kind === 'conflict') {
        await fsRollback(fsBase, fsHeaders, txn);
        return resp({
          error: 'conflict', reason: decision.reason, stored: decision.stored || { state: ledger.state },
        }, 409, CORS);
      }

      const now = new Date().toISOString();

      if (decision.kind === 'apply-precredit') {
        // Record refund into pre-credit list; no balance mutation, no customer lookup.
        const newLedger = {
          siteHash:      sh,
          orderId,
          customerUid:   ledger.customerUid || '',
          customerEmail: ledger.customerEmail || email,
          state:         STATE.PRE_REFUNDED,
          version:       ledger.version + 1,
          // Not credited yet — all "at-credit" fields stay 0. When credit
          // eventually lands, decideCredit reads the accumulated
          // preCreditRefunds and freezes the correct values in.
          pointsPerEuro:                  0,
          grossEligibleCents:             0,
          preCreditRefundedCentsAtCredit: 0,
          creditedEligibleCents:          0,
          originalPointsAwarded:          0,
          cumPostCreditRefundedCents:     0,
          alreadyReversedPoints:          0,
          preCreditRefunds: truncate([...(ledger.preCreditRefunds || []), { refundId, cents: refundCents, at: now, nonce }]),
          creditNonce: '',
          creditAt:    '',
          refunds:     ledger.refunds || [],
          createdAt:   ledger.createdAt || now,
          lastEventAt: now,
        };
        await fsCommit(fsBase, fsHeaders, txn, [{
          update: {
            name: `${docBase}/ipear_woo_events/${ledgerId}`,
            fields: wrapMap(newLedger).fields,
          },
        }]);
        return resp({
          ok: true, replay: false, source: 'firestore-ledger',
          refundedPoints: 0, idemState: 'pre-credit-recorded', state: STATE.PRE_REFUNDED,
        }, 200, CORS);
      }

      // decision.kind === 'apply' — normal post-credit refund
      const custRead = await fsGet(fsBase, fsHeaders, `ipear_customers/${ledger.customerUid}`, txn);
      if (!custRead.exists) {
        await fsRollback(fsBase, fsHeaders, txn);
        return resp({ error: 'Frozen customer doc missing' }, 500, CORS);
      }

      const custFields = custRead.doc.fields || {};
      const curPts = Number(custFields.points?.integerValue || 0);
      const curTot = Number(custFields.totalPoints?.integerValue || 0);
      // Spendable may go negative (no clamp); totalPoints qualifying reversal
      // fails closed if it would go negative (inconsistent state). The reversal
      // amount is the trusted ledger-derived decision.pointsDelta, NEVER the
      // current balance or any plugin/client-supplied value.
      const bal = applyRefundBalances(curPts, curTot, decision.pointsDelta);
      if (!bal.ok) {
        await fsRollback(fsBase, fsHeaders, txn);
        console.error(`[woo-refund-order] fail-closed (${bal.reason}) order=${orderId} refund=${refundId}`);
        return resp({ error: 'refund-inconsistent', reason: bal.reason, state: ledger.state }, 409, CORS);
      }
      const newPts = bal.newPoints;
      const newTot = bal.newTotalPoints;

      const newRefunds = truncate([...(ledger.refunds || []), {
        refundId, cents: refundCents, points: decision.pointsDelta, at: now, nonce,
      }]);
      const netCents = (ledger.creditedEligibleCents || 0) - decision.newCumRefunded;
      const nextState = netCents <= 0 ? STATE.REFUNDED : STATE.REFUNDED;   // always REFUNDED until fully covered

      const newLedger = {
        siteHash:      sh,
        orderId,
        customerUid:   ledger.customerUid,
        customerEmail: ledger.customerEmail,
        state:         nextState,
        version:       ledger.version + 1,
        // Preserve the FROZEN rate from the original credit — never overwritten by a refund.
        pointsPerEuro:                  ledger.pointsPerEuro || decision.pointsPerEuro || POINTS_PER_EURO,
        // Accounting fields — the four at-credit values are IMMUTABLE post-credit;
        // only cumPostCreditRefundedCents + alreadyReversedPoints grow with each refund.
        grossEligibleCents:             ledger.grossEligibleCents,
        preCreditRefundedCentsAtCredit: ledger.preCreditRefundedCentsAtCredit,
        creditedEligibleCents:          ledger.creditedEligibleCents,
        originalPointsAwarded:          ledger.originalPointsAwarded,
        cumPostCreditRefundedCents:     decision.newCumRefunded,
        alreadyReversedPoints:          decision.newAlreadyReversed,
        preCreditRefunds:      ledger.preCreditRefunds || [],
        creditNonce:           ledger.creditNonce,
        creditAt:              ledger.creditAt,
        refunds:               newRefunds,
        createdAt:             ledger.createdAt || now,
        lastEventAt:           now,
      };

      const auditName = `${docBase}/ipear_transactions/${auditRefundDocId(ledgerId, refundId)}`;
      const writes = [];
      if (decision.pointsDelta !== 0) {
        writes.push({
          update: {
            name: custRead.doc.name,
            fields: { ...custFields, points: wrap(newPts), totalPoints: wrap(newTot) },
          },
          updateMask: { fieldPaths: ['points', 'totalPoints'] },
        });
      }
      writes.push({
        update: {
          name: `${docBase}/ipear_woo_events/${ledgerId}`,
          fields: wrapMap(newLedger).fields,
        },
      });
      if (decision.pointsDelta !== 0) {
        writes.push({
          update: {
            name: auditName,
            fields: wrapMap({
              customerId:    ledger.customerUid,
              customerEmail: ledger.customerEmail,
              customerName:  unwrap(custFields.name) || '',
              card:          unwrap(custFields.card) || '',
              type:              'subtract',
              points:            decision.pointsDelta,
              amount:            refundCents / 100,
              category:          '🛒 Επιστροφή αγοράς',
              note:              `Επιστροφή #${refundId} · Παραγγελία #${orderId}`,
              orderId:           String(orderId),
              refundId:          String(refundId),
              balanceBefore:     curPts,
              balanceAfter:      newPts,
              totalPointsBefore: curTot,
              totalPointsAfter:  newTot,
              date:              now,
              source:            'woo-integrity/v2',
            }).fields,
          },
        });
      }

      await fsCommit(fsBase, fsHeaders, txn, writes);
      await kvPut(env, sh, orderId, {
        state: nextState,
        creditNonce: ledger.creditNonce,
        creditedEligibleCents: ledger.creditedEligibleCents,
        originalPointsAwarded:  ledger.originalPointsAwarded,
        cachedAt: now,
      });

      return resp({
        ok: true, replay: false, source: 'firestore-ledger',
        refundedPoints: decision.pointsDelta,
        newBalance: decision.pointsDelta !== 0 ? newPts : curPts,
        cumPostCreditRefundedCents: decision.newCumRefunded,
        state: nextState,
        version: ledger.version + 1,
        idemState: 'transitioned',
      }, 200, CORS);
    } catch (e) {
      lastErr = e;
      if (txn) await fsRollback(fsBase, fsHeaders, txn);
      if (e.contention && attempt < TXN_CONTENTION_RETRIES) continue;
      console.error('[woo-refund-order] error:', e.message);   // secret NEVER in log
      return resp({ error: 'Internal error' }, 500, CORS);
    }
  }
  return resp({ error: 'Contention exhausted' }, 503, CORS);
}

// ══════════════════════════════════════════════════════════════════════════
//  Test-only exports
// ══════════════════════════════════════════════════════════════════════════

export const _test = {
  siteHashFromEnv, ledgerDocId, auditCreditDocId, auditRefundDocId,
  pointsFromCents, decodeLedger, wrap, unwrap, verifyWooSecret, sanitizeId,
};

function truncate(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.length > MAX_EVENT_LOG_ENTRIES ? arr.slice(arr.length - MAX_EVENT_LOG_ENTRIES) : arr;
}
