// ════════════════════════════════════════════════════════════════════
//  Customer UI — HISTORY (paginated, cursor-based)
//
//  Extracted from src/ui-renderers.js during the Sprint 3 god-module split.
//
//  Strategy:
//   • Page size = 20 docs per query. Two parallel queries per page —
//     customerUid + customerEmail — each with orderBy(date desc)
//     + limit(20) + optional startAfter(cursor). Composite indexes
//     for both pairs are defined in firestore.indexes.json.
//   • Module-level accumulator (_historyTxs) preserves all loaded pages
//     across button clicks. Cursors (_historyCursorUid / _historyCursorEmail)
//     are per-query so each path paginates independently — exhausting one
//     doesn't truncate the other.
//   • Button state machine:
//       (a) collapsed + hidden rows fetched → "Περισσότερα... (+N)"
//           reveals already-loaded rows via _histExpanded toggle. Zero
//           network cost.
//       (b) expanded + at least one query still has more pages
//           → "Φόρτωση παλαιότερων ↓" fetches next page from Firestore.
//       (c) expanded + both queries exhausted → button removed.
//   • External callers (tab-open, animation, live tx listener) call
//     loadHistory() which resets to page 1. The 800 ms gap guard keeps
//     rapid triggers from stampeding. "Load more" goes through
//     loadHistoryMore() which appends without resetting.
// ════════════════════════════════════════════════════════════════════
import { logger } from '../../logger.js';
import { state } from '../../state.js';
import { esc } from '../../utils.js';
import { cleanTxLabel } from './tx-labels.js';

const HIST_PAGE_SIZE = 20;
const HIST_INITIAL_VISIBLE = 5;
const _HISTORY_MIN_GAP_MS = 800;

// ══════════════════════════════════════════════════════════════════════════
//  Direction resolver — authoritative transaction-type classification.
//
//  Rules (in order):
//    1. If tx.type is in the POSITIVE set → sign='positive', magnitude=|points|
//    2. If tx.type is in the NEGATIVE set → sign='negative', magnitude=|points|
//    3. Otherwise (unknown / legacy) → preserve the raw numeric direction:
//         points > 0 → positive
//         points < 0 → negative
//         points = 0 → zero (no sign shown)
//
//  Why explicit sets rather than a blanket "not-add → negative" rule:
//    a) The Worker's /woo-refund-order writes { type:'subtract', points:+N }.
//       Without an explicit 'subtract' branch, the old renderer's fallback
//       (`points > 0 ? 'add' : 'redeem'`) mis-classified reversals as credits
//       — the exact bug reported for order #12809.
//    b) A blanket rule risks flipping an unknown FUTURE positive type (e.g.
//       an admin bonus) into a red '-'. Unknown types keep their raw sign
//       so new backend features render sanely by default.
//    c) Balances are not touched — this only affects presentation.
// ══════════════════════════════════════════════════════════════════════════
export const POSITIVE_TX_TYPES = Object.freeze(new Set([
  'add',           // WooCommerce credit + generic admin add + legacy /woo-add-points
  'referral',      // Referral bonus
]));
export const NEGATIVE_TX_TYPES = Object.freeze(new Set([
  'subtract',        // Worker /woo-refund-order (positive magnitude by convention)
  'refund_clawback', // Legacy /woo-refund-points (negative points historically)
  'redeem',          // Reward redemption (negative points historically)
  'expire',          // Points expiration
  'tier_downgrade',  // Tier downgrade adjustment
]));

export function resolveTxDirection(tx) {
  const t = String(tx && tx.type != null ? tx.type : '');
  const raw = Number(tx && tx.points);
  const pts = Number.isFinite(raw) ? raw : 0;
  const mag = Math.abs(pts);
  // Zero-magnitude wins over the type set: even a known-positive/-negative
  // type must not render "+0" or "-0" — it renders as "0" with no sign.
  if (mag === 0)                          return { sign: 'zero',     magnitude: 0 };
  if (POSITIVE_TX_TYPES.has(t))           return { sign: 'positive', magnitude: mag };
  if (NEGATIVE_TX_TYPES.has(t))           return { sign: 'negative', magnitude: mag };
  // Unknown / legacy — preserve raw numeric direction.
  if (pts > 0)                            return { sign: 'positive', magnitude: pts };
  return                                         { sign: 'negative', magnitude: -pts };
}

// Small formatter helper (broken out so it's testable in isolation).
// Uses ASCII '-' for consistency with the rest of the UI and existing tests.
export function formatTxAmount(tx) {
  const dir = resolveTxDirection(tx);
  const abs = dir.magnitude.toLocaleString('el-GR');
  if (dir.sign === 'positive') return `+${abs}`;
  if (dir.sign === 'negative') return `-${abs}`;
  return abs;   // zero — no sign
}

let _historyBusy = false;
let _historyLastRunAt = 0;
let _historyTxs = [];
let _historyCursorUid = null;
let _historyCursorEmail = null;
let _historyHasMoreUid = true;
let _historyHasMoreEmail = true;
let _histExpanded = false;

export async function loadHistory() {
  return _loadHistoryInternal(false);
}

export async function loadHistoryMore() {
  return _loadHistoryInternal(true);
}

async function _loadHistoryInternal(append) {
  if (_historyBusy) return;
  // Coalesce rapid back-to-back calls (live listener + tab-open + balance
  // animation can all trigger this within milliseconds). 800 ms gap doesn't
  // apply to user-initiated "Load more" clicks — those bypass it.
  if (!append && Date.now() - _historyLastRunAt < _HISTORY_MIN_GAP_MS) return;
  _historyBusy = true;
  _historyLastRunAt = Date.now();

  if (!append) {
    _historyTxs = [];
    _historyCursorUid = null;
    _historyCursorEmail = null;
    _historyHasMoreUid = true;
    _historyHasMoreEmail = true;
    _histExpanded = false;
  }

  const el = document.getElementById('pr-history');

  if (append) {
    const btn = document.getElementById('hist-more-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Φόρτωση…';
    }
  }

  try {
    const col = window._col(window._db, 'ipear_transactions');
    const authEmail = window._auth?.currentUser?.email || state.foundCustomer?.email || '';
    const seen = new Set(_historyTxs.map(t => t._id));

    const queries = [];

    if (state.foundCustomer.uid && _historyHasMoreUid) {
      const args = [
        window._where('customerUid', '==', state.foundCustomer.uid),
        window._orderBy('date', 'desc'),
        window._limit(HIST_PAGE_SIZE),
      ];
      if (_historyCursorUid) args.push(window._startAfter(_historyCursorUid));
      queries.push(
        window._getDocs(window._query(col, ...args))
          .then(snap => ({ tag: 'uid', snap }))
          .catch(error => ({ tag: 'uid', error }))
      );
    }

    if (authEmail && _historyHasMoreEmail) {
      const args = [
        window._where('customerEmail', '==', authEmail),
        window._orderBy('date', 'desc'),
        window._limit(HIST_PAGE_SIZE),
      ];
      if (_historyCursorEmail) args.push(window._startAfter(_historyCursorEmail));
      queries.push(
        window._getDocs(window._query(col, ...args))
          .then(snap => ({ tag: 'email', snap }))
          .catch(error => ({ tag: 'email', error }))
      );
    }

    const results = await Promise.all(queries);

    for (const r of results) {
      if (r.error) {
        logger.warn(`[loadHistory ${r.tag}]`, r.error.code || r.error.message);
        // Likely missing composite index on first deploy — disable that
        // path so we don't keep retrying it. Other path still works.
        if (r.tag === 'uid') _historyHasMoreUid = false;
        if (r.tag === 'email') _historyHasMoreEmail = false;
        continue;
      }
      let docCount = 0;
      let lastDoc = null;
      r.snap.forEach(d => {
        docCount++;
        lastDoc = d;
        if (!seen.has(d.id)) {
          seen.add(d.id);
          const data = d.data();
          data._id = d.id;
          _historyTxs.push(data);
        }
      });
      if (lastDoc) {
        if (r.tag === 'uid') _historyCursorUid = lastDoc;
        if (r.tag === 'email') _historyCursorEmail = lastDoc;
      }
      if (docCount < HIST_PAGE_SIZE) {
        if (r.tag === 'uid') _historyHasMoreUid = false;
        if (r.tag === 'email') _historyHasMoreEmail = false;
      }
    }

    _historyTxs.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (append) _histExpanded = true; // user explicitly asked for more

    _renderHistory(el);
  } catch (e) {
    logger.error('[loadHistory]', e);
    if (!_historyTxs.length) {
      const offline = !navigator.onLine;
      const icon = offline ? '📡' : '🧾';
      const title = offline ? 'Δεν υπάρχει σύνδεση' : 'Δεν ήταν δυνατή η φόρτωση';
      const sub = offline ? 'Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά' : 'Δοκίμασε ξανά σε λίγο';
      el.innerHTML = `<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">${icon}</div><div class="empty-state__title">${title}</div><div class="empty-state__sub">${sub}</div></div>`;
    } else {
      _renderHistory(el); // restore visible state, button error-recovers below
      const btn = document.getElementById('hist-more-btn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⚠️ Δοκίμασε ξανά';
      }
    }
  } finally {
    _historyBusy = false;
  }
}

function _renderHistory(el) {
  if (!_historyTxs.length) {
    el.innerHTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon">🧾</div><div class="empty-state__title">Καμία συναλλαγή ακόμα</div><div class="empty-state__sub">Όταν κάνεις την πρώτη αγορά θα εμφανιστεί εδώ</div></div>';
    return;
  }

  let html = _historyTxs.map((tx, i) => {
    const dt = new Date(tx.date);
    const ds = dt.toLocaleDateString('el-GR') + ' ' + dt.toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' });
    // Direction is derived from the authoritative type via resolveTxDirection —
    // never from a title string, and no longer from a raw-sign fallback for
    // known types. Unknown/legacy types still fall back to raw sign inside
    // the resolver so future backend additions render sanely by default.
    const dir = resolveTxDirection(tx);
    const cls = dir.sign === 'positive' ? 'add' : (dir.sign === 'negative' ? 'redeem' : 'neutral');
    // Icons stay bound to the semantic type so known transactions keep their
    // familiar glyph; the sign/color path is now driven entirely by dir.
    let ico, lbl;
    if (tx.type === 'add') {
      ico = '🛒'; lbl = cleanTxLabel(tx.category) || 'Αγορά';
    } else if (tx.type === 'redeem') {
      // Prefer the reward's own title (`tx.label`) — dynamic catalog rewards
      // like "Καλώδιο Baseus" are physical items, not euro discounts, so the
      // hardcoded "Έκπτωση Xε" template misrepresented them (it read the
      // stored numeric `discount` and always rendered as a currency amount).
      // The legacy manual-redeem paths (tablet-main.js:754, admin
      // customer-points.js:185) don't store a label — for those we still
      // fall back to the generic euro-discount format.
      ico = '💶';
      lbl = tx.label
        ? `🎁 ${tx.label}`
        : `Έκπτωση ${tx.discount || ''}€`;
    } else if (tx.type === 'expire') {
      ico = '⏳'; lbl = 'Εκπνοή πόντων';
    } else if (tx.type === 'tier_downgrade') {
      ico = '📉'; lbl = cleanTxLabel(tx.note) || cleanTxLabel(tx.category) || 'Υποβάθμιση επιπέδου';
    } else if (tx.type === 'referral' || tx.category?.includes('Referral')) {
      ico = '🎁'; lbl = cleanTxLabel(tx.category) || 'Μπόνους σύστασης';
    } else if (tx.type === 'subtract' || tx.type === 'refund_clawback') {
      // WooCommerce reversal (either from /woo-refund-order or the legacy
      // /woo-refund-points path). Icon is a return arrow; label is normalized
      // to natural Greek via the shared tx-label map (never a raw enum).
      ico = '↩︎'; lbl = cleanTxLabel(tx.category) || cleanTxLabel(tx.note) || 'Επιστροφή';
    } else {
      ico = dir.sign === 'positive' ? '🛒' : (dir.sign === 'negative' ? '💶' : '📄');
      lbl = cleanTxLabel(tx.category) || cleanTxLabel(tx.note) || 'Συναλλαγή';
    }
    const displaySign = dir.sign === 'positive' ? '+' : (dir.sign === 'negative' ? '-' : '');
    const displayAmount = dir.magnitude.toLocaleString('el-GR');
    const storeTag = (tx.storeName && tx.storeName !== '—')
      ? `<span style="display:inline-block;margin-top:2px;font-size:.65rem;background:rgba(138,233,0,.18);color:#3a6e00;border-radius:6px;padding:1px 6px;font-weight:700">${esc(tx.storeName)}</span>`
      : '';
    const hiddenStyle = !_histExpanded && i >= HIST_INITIAL_VISIBLE ? 'style="display:none"' : '';
    return `<div class="hist-item hist-type-${cls} hist-row" data-hist-idx="${i}" ${hiddenStyle}>
      <div class="hist-ico ${cls}">${ico}</div>
      <div class="hist-body"><div class="hist-name">${esc(lbl)}</div><div class="hist-date">${ds} ${storeTag}</div></div>
      <div class="hist-pts ${cls}">${displaySign}${displayAmount}</div>
    </div>`;
  }).join('');

  const hiddenCount = Math.max(0, _historyTxs.length - HIST_INITIAL_VISIBLE);
  const hasMorePages = _historyHasMoreUid || _historyHasMoreEmail;

  if (!_histExpanded && hiddenCount > 0) {
    html += `<button id="hist-more-btn" data-action="_toggleHistory" class="hist-more-btn">Προβολή ακόμη ${hiddenCount}</button>`;
  } else if (_histExpanded && hasMorePages) {
    html += `<button id="hist-more-btn" data-action="loadHistoryMore" class="hist-more-btn hist-more-btn--paginate">Φόρτωση παλαιότερων ↓</button>`;
  }

  el.innerHTML = html;
}

export function _toggleHistory() {
  _histExpanded = !_histExpanded;
  _renderHistory(document.getElementById('pr-history'));
}
