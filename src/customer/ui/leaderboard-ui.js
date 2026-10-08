// ═══════════════════════════════════════════════════════════════════════════
//  Customer UI — Leaderboard
//
//  Extracted from src/ui-renderers.js during the Sprint 3 god-module split.
//  Reads ipear_leaderboard/latest, finds the viewer's row (via card OR
//  initials+totalPoints fallback for stale payloads), and renders a top-10
//  table with an optional pinned "Εσύ" footer for viewers outside the top-10.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../../logger.js';
import { state } from '../../state.js';
import { esc, tier } from '../../utils.js';

let _lbUnsub = null;
let _lbExpanded = false;
let _lbLastData = null;
let _lbTop10 = null;
let _lbMyCard = '';
let _lbPinnedHtml = '';
// ── Lifecycle guards (fix: infinite "Φόρτωση…") ──────────────────────────────
//  `_lbGotSnapshot` records whether the listener's first callback (success OR
//  error) has fired. `_lbWatchdog` converts a first snapshot that never arrives
//  (auth/App-Check race, dropped socket) into an explicit RETRY state instead of
//  an endless spinner. The element is ALWAYS resolved fresh (never captured) so
//  a Profile re-render can't leave the callback writing to a detached node.
let _lbWatchdog = null;
let _lbGotSnapshot = false;
const LB_WATCHDOG_MS = 10000;
const _lbEl = () => document.getElementById('lb-container');
const LB_LOADING_HTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">⏳</div><div class="empty-state__title">Φόρτωση…</div></div>';
function _lbRetryHtml(title) {
  return `<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">🏆</div><div class="empty-state__title">${title || 'Δεν φορτώθηκε η κατάταξη'}</div><button type="button" onclick="_retryLeaderboard()" style="margin-top:10px;padding:8px 18px;background:var(--gd,#6bb800);color:#fff;border:none;border-radius:10px;font-family:var(--font);font-size:.8rem;font-weight:800;cursor:pointer">Δοκίμασε ξανά</button></div>`;
}
function _lbClearWatchdog() { if (_lbWatchdog) { clearTimeout(_lbWatchdog); _lbWatchdog = null; } }
function _lbArmWatchdog() {
  _lbClearWatchdog();
  _lbWatchdog = setTimeout(() => {
    _lbWatchdog = null;
    if (_lbGotSnapshot) return;            // snapshot/error already resolved it
    logger.warn('[leaderboard] first snapshot timed out → retry state');
    const el = _lbEl();
    if (el) el.innerHTML = _lbRetryHtml('Δεν φορτώθηκε η κατάταξη');
  }, LB_WATCHDOG_MS);
}

function _renderLeaderboardData(lb) {
  _lbLastData = lb;
  const el = document.getElementById('lb-container');
  if (!el) return;

  const top = lb.top || [];
  const totalCount = lb.total || top.length;
  if (!top.length) {
    el.innerHTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">🏆</div><div class="empty-state__title">Δεν υπάρχουν δεδομένα ακόμα</div></div>';
    return;
  }

  const myCard = state.foundCustomer?.card || '';
  // Build the same obfuscated initials format the admin uses for the payload.
  // Used as fallback identity when `card` is missing from a stale payload
  // (older docs published before the card field was re-added).
  const myFullName = (state.foundCustomer?.name || '').trim();
  const myInitials = myFullName ? myFullName.split(' ').map((w,i) => i===0 ? w : (w[0]||'')+'.').join(' ') : '';
  const myTotalPts = state.foundCustomer?.totalPoints || 0;
  const _isViewer = (c) => {
    if (myCard && c.card) return c.card === myCard;             // primary
    if (myInitials && c.name === myInitials &&
        (Number(c.totalPoints) || 0) === myTotalPts) return true; // fallback
    return false;
  };
  const myRank = top.findIndex(_isViewer) + 1;

  const medals = ['🥇','🥈','🥉'];
  const LB_SHOW = 10;
  const LB_INIT = 5;

  function _renderLbRows(items) {
    let h = '';
    items.forEach((c, i) => {
      const isMe = _isViewer(c);
      const bg   = isMe ? 'background:linear-gradient(90deg,rgba(107,184,0,.18),rgba(138,233,0,.10))' : (i%2===0?'background:#fafafa':'background:#fff');
      const rank = medals[i] || `#${i+1}`;
      h += `<div style="display:flex;align-items:center;gap:10px;padding:11px 14px;${bg};${i>0?'border-top:1px solid var(--bd)':''}">
        <div style="font-size:${i<3?'1.3':'1'}rem;min-width:28px;text-align:center;font-weight:700;color:${i<3?'inherit':'var(--grl)'}">${rank}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:800;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${isMe?'#2a6000':'var(--bk)'}">${isMe?'👤 Εσύ':esc(c.name)}</div>
        </div>
        <div style="font-size:.92rem;font-weight:900;color:${isMe?'var(--gd)':'var(--bk)'}">
          ${(Number(c.totalPoints)||0).toLocaleString('el-GR')} <span style="font-size:.7rem;font-weight:500;color:var(--grl)">pts</span>
        </div>
      </div>`;
    });
    return h;
  }

  const top10 = top.slice(0, LB_SHOW);
  const myInTop10 = myRank > 0 && myRank <= LB_SHOW;
  _lbTop10 = top10; _lbMyCard = myCard;

  let pinnedHtml = '';
  if (!myInTop10 && state.foundCustomer) {
    const myTotalPts = state.foundCustomer?.totalPoints || 0;
    // Estimate rank as (# of published entries with STRICTLY more points) + 1.
    // Using `>=` previously promoted the viewer to the same slot as the last
    // visible top10 entry on a tie — UI then showed two "#10" rows (e.g. the
    // tied competitor plus the pinned "Εσύ" footer) which read as duplication.
    // Strict `>` places the viewer immediately after the tie, which is the
    // honest position when their card isn't in the published top-20 yet.
    let aheadCount = 0;
    for (let ri = 0; ri < top.length; ri++) {
      if ((top[ri].totalPoints || 0) > myTotalPts) aheadCount++;
    }
    let estRank = aheadCount + 1;
    if (estRank > top.length && totalCount > top.length) estRank = Math.max(estRank, totalCount);
    pinnedHtml = `<div style="display:flex;align-items:center;gap:10px;padding:11px 14px;border-top:2px dashed rgba(0,0,0,.1);background:linear-gradient(90deg,rgba(107,184,0,.18),rgba(138,233,0,.10))">
      <div style="font-size:1rem;font-weight:800;color:var(--gd);min-width:28px;text-align:center">#${estRank}</div>
      <div style="flex:1;min-width:0"><div style="font-weight:800;font-size:.88rem;color:#2a6000">👤 Εσύ</div></div>
      <div style="font-size:.92rem;font-weight:900;color:var(--gd)">${myTotalPts.toLocaleString('el-GR')} <span style="font-size:.7rem;font-weight:500;color:var(--grl)">pts</span></div>
    </div>`;
  }
  _lbPinnedHtml = pinnedHtml;

  const showCount = _lbExpanded ? LB_SHOW : LB_INIT;
  let html = '<div id="lb-rows" style="border-radius:12px;overflow:hidden;border:1.5px solid var(--bd)">';
  html += _renderLbRows(top10.slice(0, showCount));
  html += pinnedHtml;
  html += '</div>';

  if (top10.length > LB_INIT) {
    if (_lbExpanded) {
      html += `<button id="lb-more-btn" onclick="_collapseLb()" style="display:block;width:100%;margin-top:8px;padding:10px;background:transparent;border:1.5px solid var(--bd);border-radius:10px;font-family:var(--font);font-size:.78rem;font-weight:700;color:var(--grl);cursor:pointer;transition:border-color .15s,color .15s">Λιγότερα</button>`;
    } else {
      html += `<button id="lb-more-btn" onclick="_expandLeaderboard()" style="display:block;width:100%;margin-top:8px;padding:10px;background:transparent;border:1.5px solid var(--bd);border-radius:10px;font-family:var(--font);font-size:.78rem;font-weight:700;color:var(--grl);cursor:pointer;transition:border-color .15s,color .15s">Περισσότερα...</button>`;
    }
  }

  el.innerHTML = html;
}

export function loadLeaderboard() {
  const el = _lbEl();
  if (!el) return;
  // Already subscribed: re-render current state into the (possibly re-created)
  // container instead of no-oping. The old `if (_lbUnsub) return;` left a fresh
  // Profile render stuck on its static skeleton while the live listener wrote to
  // a detached node — the infinite-"Φόρτωση…" bug.
  if (_lbUnsub) {
    if (_lbLastData) { _renderLeaderboardData(_lbLastData); }
    else if (_lbGotSnapshot) { el.innerHTML = _lbRetryHtml('Δεν υπάρχουν δεδομένα ακόμα'); }
    else { el.innerHTML = LB_LOADING_HTML; }   // listener still pending — watchdog owns the timeout
    return;
  }

  if (window.DEMO) {
    el.innerHTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">🏆</div><div class="empty-state__title">Η κατάταξη θα είναι διαθέσιμη σύντομα</div><div class="empty-state__sub">Θα φανεί όταν συγκεντρωθούν αρκετά δεδομένα</div></div>';
    return;
  }
  if (!window._db || !window._onSnapshot) {
    el.innerHTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">📡</div><div class="empty-state__title">Δεν υπάρχει σύνδεση</div></div>';
    return;
  }

  el.innerHTML = LB_LOADING_HTML;
  _lbGotSnapshot = false;
  _lbArmWatchdog();

  try {
    const ref = window._doc(window._db, 'ipear_leaderboard', 'latest');
    _lbUnsub = window._onSnapshot(ref, (snap) => {
      _lbGotSnapshot = true; _lbClearWatchdog();
      const elNow = _lbEl();            // resolve fresh — never a captured/detached node
      if (!elNow) return;
      if (!snap.exists()) {
        elNow.innerHTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">🏆</div><div class="empty-state__title">Η κατάταξη ετοιμάζεται…</div></div>';
        return;
      }
      _renderLeaderboardData(snap.data());
    }, (err) => {
      _lbGotSnapshot = true; _lbClearWatchdog();
      logger.warn('[leaderboard] onSnapshot error:', err.message);
      const elNow = _lbEl();
      if (!elNow) return;
      if (state.foundCustomer) {
        const t = tier(state.foundCustomer.totalPoints || 0);
        const pct = t.next ? Math.min(100, Math.round(((state.foundCustomer.totalPoints - t.floor) / (t.next - t.floor)) * 100)) : 100;
        elNow.innerHTML = `<div style="text-align:center;padding:16px">
          <div style="font-size:2.2rem;margin-bottom:6px">${t.icon}</div>
          <div style="font-weight:800;font-size:1rem;margin-bottom:4px">${esc(t.name)}</div>
          <div style="font-size:.82rem;color:var(--grl)">Επίπεδο ${pct}% — ${t.next ? 'Επόμενο: '+(t.next - (state.foundCustomer.totalPoints||0))+' πόντοι' : 'Ανώτατη κατάταξη!'}</div>
        </div>`;
      } else {
        elNow.innerHTML = _lbRetryHtml('Δεν φορτώθηκε η κατάταξη');
      }
    });
  } catch(e) {
    _lbClearWatchdog();
    logger.warn('[leaderboard] listener setup failed:', e.message);
    el.innerHTML = _lbRetryHtml('Δεν φορτώθηκε η κατάταξη');
  }
}

// Controlled re-subscription after a stale/failed listener (retry button or
// lifecycle). Tears down cleanly first to avoid duplicate listeners.
export function _retryLeaderboard() {
  stopLbListener();
  loadLeaderboard();
}

export function stopLbListener() {
  _lbClearWatchdog();
  _lbGotSnapshot = false;
  if (_lbUnsub) { try { _lbUnsub(); } catch(_) {} _lbUnsub = null; }
  _lbExpanded = false;
  _lbLastData = null;
}

export function _expandLeaderboard() {
  _lbExpanded = true;
  if (_lbLastData) _renderLeaderboardData(_lbLastData);
}
export function _collapseLb() {
  _lbExpanded = false;
  if (_lbLastData) _renderLeaderboardData(_lbLastData);
}
