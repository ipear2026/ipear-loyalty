// ═══════════════════════════════════════════════════════════════════════════
//  Customer UI — Rewards (dynamic catalog)
//
//  Extracted from src/ui-renderers.js during the Sprint 3 god-module split.
//
//  Source of truth: `ipear_rewards` (admin-managed). The legacy `REWARDS`
//  const is gone — admins now CRUD reward tiers from the Admin panel and
//  the customer app subscribes via onSnapshot below. Fallback: if the
//  collection is empty (or the listener errors before first snapshot),
//  we paint the same 5/15/30 ladder so the app never shows an empty
//  rewards section to a confused customer.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../../logger.js';
import { esc } from '../../utils.js';
import { _t } from '../../i18n.js';
import { _safeImgTag } from './_shared.js';

const _REWARDS_FALLBACK = [
  { id: 'fallback-1000', cost: 1000, discount: 5,  icon: '🎟️', title: '5€ Έκπτωση',  description: '',  isActive: true, order: 1, i18nKey: 'rw_1000' },
  { id: 'fallback-2500', cost: 2500, discount: 15, icon: '💵', title: '15€ Έκπτωση', description: '', isActive: true, order: 2, i18nKey: 'rw_2500' },
  { id: 'fallback-4000', cost: 4000, discount: 30, icon: '👑', title: '30€ Έκπτωση', description: '', isActive: true, order: 3, i18nKey: 'rw_4000' },
];

let _rewardsUnsub = null;
let _activeRewards = _REWARDS_FALLBACK.slice();
let _rewardsLoaded = false;
let _rewardsLastPts = 0;

function _rewardLabel(r) {
  // i18nKey only exists on the seeded fallback rows; admin-managed rewards
  // store their final Greek text in `title`. _t() returns the key itself
  // when missing, so falling through to title gives the right output.
  if (r.i18nKey) {
    const localised = _t(r.i18nKey);
    if (localised && localised !== r.i18nKey) return localised;
  }
  return r.title || '';
}

export function startRewardsListener() {
  stopRewardsListener();
  if (window.DEMO) {
    _activeRewards = _REWARDS_FALLBACK.slice();
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
        // Empty catalog → keep the fallback so the UI never paints blank.
        _activeRewards = rows.length ? rows : _REWARDS_FALLBACK.slice();
        _rewardsLoaded = true;
        _rerenderRewards();
      },
      (err) => {
        logger.error('[rewards] onSnapshot error:', err.code, err.message);
        _activeRewards = _REWARDS_FALLBACK.slice();
        _rewardsLoaded = true;
        _rerenderRewards();
      }
    );
  } catch (e) {
    logger.error('[rewards] startRewardsListener exception:', e);
    _activeRewards = _REWARDS_FALLBACK.slice();
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

// ════════════════════════════════════════
//  HOME — REWARD SCROLL CARDS
// ════════════════════════════════════════
export function renderHomeRewards(pts) {
  _rewardsLastPts = pts;
  const el = document.getElementById('h-rewards-scroll');
  if (!el) return;
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
  if (!_activeRewards.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state__icon" aria-hidden="true">🎟️</div><div class="empty-state__title">Καμία ανταμοιβή ακόμα</div><div class="empty-state__sub">Νέες ανταμοιβές προστίθενται τακτικά</div></div>';
    return;
  }
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
