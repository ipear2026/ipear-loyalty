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
  const el = document.getElementById('lb-container');
  if (!el) return;
  if (_lbUnsub) return;

  if (window.DEMO) {
    el.innerHTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">🏆</div><div class="empty-state__title">Leaderboard διαθέσιμο σύντομα</div><div class="empty-state__sub">Θα φανεί όταν συγκεντρωθούν αρκετά δεδομένα</div></div>';
    return;
  }
  if (!window._db || !window._onSnapshot) {
    el.innerHTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">📡</div><div class="empty-state__title">Δεν υπάρχει σύνδεση</div></div>';
    return;
  }

  el.innerHTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">⏳</div><div class="empty-state__title">Φόρτωση…</div></div>';

  try {
    const ref = window._doc(window._db, 'ipear_leaderboard', 'latest');
    _lbUnsub = window._onSnapshot(ref, (snap) => {
      if (!snap.exists()) {
        el.innerHTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">🏆</div><div class="empty-state__title">Το leaderboard ετοιμάζεται…</div></div>';
        return;
      }
      _renderLeaderboardData(snap.data());
    }, (err) => {
      logger.warn('[leaderboard] onSnapshot error:', err.message);
      if (state.foundCustomer) {
        const t = tier(state.foundCustomer.totalPoints || 0);
        const pct = t.next ? Math.min(100, Math.round(((state.foundCustomer.totalPoints - t.floor) / (t.next - t.floor)) * 100)) : 100;
        el.innerHTML = `<div style="text-align:center;padding:16px">
          <div style="font-size:2.2rem;margin-bottom:6px">${t.icon}</div>
          <div style="font-weight:800;font-size:1rem;margin-bottom:4px">${esc(t.name)}</div>
          <div style="font-size:.82rem;color:var(--grl)">Επίπεδο ${pct}% — ${t.next ? 'Επόμενο: '+(t.next - (state.foundCustomer.totalPoints||0))+' πόντοι' : 'Ανώτατη κατάταξη!'}</div>
        </div>`;
      } else {
        el.innerHTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">🏆</div><div class="empty-state__title">Σύντομα διαθέσιμο</div></div>';
      }
    });
  } catch(e) {
    logger.warn('[leaderboard] listener setup failed:', e.message);
    el.innerHTML = '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">🏆</div><div class="empty-state__title">Σύντομα διαθέσιμο</div></div>';
  }
}

export function stopLbListener() {
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
