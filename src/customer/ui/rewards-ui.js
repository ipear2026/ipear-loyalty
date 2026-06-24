// ═══════════════════════════════════════════════════════════════════════════
//  Customer UI — Rewards (dynamic catalog)
//
//  Source of truth: `ipear_rewards` (admin-managed). Admins CRUD reward
//  tiers from the Admin panel and the customer app subscribes via
//  onSnapshot below.
//
//  State machine for the rendered rewards surface:
//    1. Initial:           _rewardsLoaded === false  → skeleton placeholders
//    2. First snapshot:    _rewardsLoaded === true   → real cards OR empty
//                                                       state depending on
//                                                       _activeRewards.length
//    3. Listener error:    _rewardsLoaded === true,
//                          _activeRewards === []      → same empty state
//
//  Pre-fix the catalog used a hardcoded 1000/2500/4000 ladder as a fallback
//  so the section "never painted blank". The effect was UI flashing: fake
//  rewards on first paint → real rewards on first snapshot. Replaced with
//  skeleton-then-real, which matches the loading model used by the
//  leaderboard + history panels elsewhere in the app.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../../logger.js';
import { esc } from '../../utils.js';
import { _t } from '../../i18n.js';
import { _safeImgTag } from './_shared.js';

let _rewardsUnsub = null;
let _activeRewards = [];
let _rewardsLoaded = false;
let _rewardsLastPts = 0;

function _rewardLabel(r) {
  return r.title || '';
}

export function startRewardsListener() {
  stopRewardsListener();
  if (window.DEMO) {
    // DEMO mode has no ipear_rewards mock. Mark the surface as loaded with
    // an empty catalog so the empty state renders immediately instead of
    // a permanent skeleton (which would happen if we waited on the no-op
    // demo onSnapshot to fire a callback that never comes).
    _activeRewards = [];
    _rewardsLoaded = true;
    _rerenderRewards();
    return;
  }
  try {
    const ref = window._query(
      window._col(window._db, 'ipear_rewards'),
      window._where('isActive', '==', true)
    );
    _rewardsUnsub = window._onSnapshot(
      ref,
      (snap) => {
        const rows = [];
        snap.forEach((d) => {
          const data = d.data ? d.data() : d;
          rows.push({ id: d.id || data.id, ...data });
        });
        rows.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
        _activeRewards = rows;
        _rewardsLoaded = true;
        _rerenderRewards();
      },
      (err) => {
        logger.error('[rewards] onSnapshot error:', err.code, err.message);
        // Network / permission error: surface the empty state rather than
        // ghost data. The error message is logged for ops; the customer
        // sees "no rewards right now" which is honest.
        _activeRewards = [];
        _rewardsLoaded = true;
        _rerenderRewards();
      }
    );
  } catch (e) {
    logger.error('[rewards] startRewardsListener exception:', e);
    _activeRewards = [];
    _rewardsLoaded = true;
    _rerenderRewards();
  }
}

export function stopRewardsListener() {
  if (_rewardsUnsub) { try { _rewardsUnsub(); } catch (_) {} _rewardsUnsub = null; }
  _rewardsLoaded = false;
}

export function getActiveRewards() {
  return _activeRewards;
}

function _rerenderRewards() {
  // Re-paint both surfaces against the last-known balance so an admin
  // edit (new reward / disabled tier / order change) propagates without
  // waiting for the next points change to trigger renderHomeRewards/List.
  try {
    if (document.getElementById('h-rewards-scroll')) renderHomeRewards(_rewardsLastPts);
    if (document.getElementById('rw-list'))          renderRewardsList(_rewardsLastPts);
  } catch (e) { logger.warn('[rewards] rerender failed:', e?.message || e); }
}

// ── Skeleton card factories (use the .sk shimmer class from customer.css) ──
//
// Matches the real .rw-card / .rw-full-card dimensions so the layout
// doesn't jump when real data lands. aria-hidden keeps screen readers
// from announcing the placeholder content.
function _homeSkeletonHtml() {
  const card = `<div class="rw-card" aria-hidden="true" style="pointer-events:none">
    <div class="rw-emoji-area"><span class="sk" style="width:48px;height:48px;border-radius:10px"></span></div>
    <div class="rw-body">
      <div class="sk" style="display:block;width:64px;height:18px;border-radius:6px;margin-bottom:6px"></div>
      <div class="sk" style="display:block;width:92%;height:14px;border-radius:6px;margin-bottom:4px"></div>
      <div class="sk" style="display:block;width:70%;height:12px;border-radius:6px"></div>
    </div>
  </div>`;
  return card + card + card;
}

function _listSkeletonHtml() {
  const row = `<div class="rw-full-card" aria-hidden="true" style="pointer-events:none">
    <div class="rw-full-icon"><span class="sk" style="width:36px;height:36px;border-radius:8px"></span></div>
    <div class="rw-full-body">
      <div class="sk" style="display:block;width:60%;height:18px;border-radius:6px;margin-bottom:6px"></div>
      <div class="sk" style="display:block;width:40%;height:14px;border-radius:6px;margin-bottom:8px"></div>
      <div class="sk" style="display:block;width:100%;height:5px;border-radius:3px"></div>
    </div>
    <span class="sk" style="width:54px;height:36px;border-radius:8px"></span>
  </div>`;
  return row + row + row;
}

const _EMPTY_HTML_HOME =
  '<div class="empty-state empty-state--compact" style="flex:1">' +
    '<div class="empty-state__icon" aria-hidden="true">🎟️</div>' +
    '<div class="empty-state__title">Δεν υπάρχουν διαθέσιμες ανταμοιβές αυτή τη στιγμή.</div>' +
  '</div>';

const _EMPTY_HTML_LIST =
  '<div class="empty-state">' +
    '<div class="empty-state__icon" aria-hidden="true">🎟️</div>' +
    '<div class="empty-state__title">Δεν υπάρχουν διαθέσιμες ανταμοιβές αυτή τη στιγμή.</div>' +
    '<div class="empty-state__sub">Νέες ανταμοιβές προστίθενται τακτικά</div>' +
  '</div>';

// ════════════════════════════════════════
//  HOME — REWARD SCROLL CARDS
// ════════════════════════════════════════
export function renderHomeRewards(pts) {
  _rewardsLastPts = pts;
  const el = document.getElementById('h-rewards-scroll');
  if (!el) return;
  if (!_rewardsLoaded) { el.innerHTML = _homeSkeletonHtml(); return; }
  if (!_activeRewards.length) { el.innerHTML = _EMPTY_HTML_HOME; return; }
  el.innerHTML = _activeRewards.map((r) => {
    const cost = Number(r.cost) || 0;
    const ok = pts >= cost;
    const label = _rewardLabel(r);
    const safeLabel = esc(label).replace(/'/g, '&#39;');
    const safeId = esc(String(r.id || '')).replace(/'/g, '&#39;');
    const _riu = typeof r.imageUrl === 'string' ? r.imageUrl : '';
    const rwSafeImg = (_riu && (_riu.startsWith('https://') || _riu.startsWith('data:image/'))) ? _riu : '';
    const rwImgHtml = rwSafeImg
      ? _safeImgTag('rw-img', rwSafeImg, r.icon || '🎟️')
      : `<div class="rw-emoji-only">${esc(r.icon || '🎟️')}</div>`;
    return `<div class="rw-card ${ok ? 'unlocked' : 'locked'}" ${ok ? `role="button" tabindex="0" onclick="startRedemption('${safeId}','${safeLabel}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();startRedemption('${safeId}','${safeLabel}')}" aria-label="${esc(label)} — ${cost} ${_t('points')}"` : ' aria-disabled="true"'}>
      <div class="rw-emoji-area">${rwImgHtml}</div>
      <div class="rw-body">
        <div class="rw-pts-badge">${cost} ${_t('points')}</div>
        <div class="rw-label">${esc(label)}</div>
        <div class="rw-status">${ok ? _t('rw_tap') : _t('rw_locked') + (cost - pts) + ' ' + _t('rw_more')}</div>
      </div>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════
//  REWARDS TAB — FULL LIST
// ════════════════════════════════════════
export function renderRewardsList(pts) {
  _rewardsLastPts = pts;
  const el = document.getElementById('rw-list');
  if (!el) return;
  if (!_rewardsLoaded) { el.innerHTML = _listSkeletonHtml(); return; }
  if (!_activeRewards.length) { el.innerHTML = _EMPTY_HTML_LIST; return; }
  el.innerHTML = _activeRewards.map((r, i) => {
    const cost = Number(r.cost) || 0;
    const ok = pts >= cost;
    const label = _rewardLabel(r);
    const safeLabel = esc(label).replace(/'/g, '&#39;');
    const safeId = esc(String(r.id || '')).replace(/'/g, '&#39;');
    const prev = Number(_activeRewards[i - 1]?.cost) || 0;
    const pct = ok ? 100 : Math.max(0, Math.min(100, Math.round(((pts - prev) / Math.max(1, cost - prev)) * 100)));
    const _rfiu = typeof r.imageUrl === 'string' ? r.imageUrl : '';
    const rwfSafeImg = (_rfiu && (_rfiu.startsWith('https://') || _rfiu.startsWith('data:image/'))) ? _rfiu : '';
    const rwfIconHtml = rwfSafeImg
      ? _safeImgTag('rw-full-img', rwfSafeImg, r.icon || '🎟️')
      : esc(r.icon || '🎟️');
    return `<div class="rw-full-card ${ok ? 'ok' : ''}" ${ok ? `role="button" tabindex="0" onclick="startRedemption('${safeId}','${safeLabel}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();startRedemption('${safeId}','${safeLabel}')}" aria-label="${esc(label)} — ${cost} ${_t('points')}"` : ' aria-disabled="true"'}>
      <div class="rw-full-icon">${rwfIconHtml}</div>
      <div class="rw-full-body">
        <div class="rw-full-label">${esc(label)}</div>
        <div class="rw-full-pts">${cost} ${_t('points')}${ok ? '' : ' · ' + _t('rw_need') + ' ' + (cost - pts) + ' ' + _t('rw_more')}</div>
        <div class="rw-full-prog"><div class="rw-full-prog-fill" style="width:${pct}%"></div></div>
      </div>
      <button class="rw-full-action" ${ok ? '' : 'disabled'} aria-hidden="true" tabindex="-1">${ok ? '✓' : '🔒'}</button>
    </div>`;
  }).join('');
}
