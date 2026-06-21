import { logger } from './logger.js';
import { state } from './state.js';
import { esc, showToast, _trackEvent, _trapFocus, _releaseFocus, _fireConfetti, tier, _WORKER_URL, _haptic } from './utils.js';
import { _t } from './i18n.js';
import { _migrateCustomerToUid } from './main.js';

// ═══════════════════════════════════════════════════════════════════════════
//  HIGH-3: Safe <img> factory.
//
//  Building the <img> via DOM API (createElement + property assignment) means
//  the browser handles every attribute escape — no string interpolation, no
//  hand-rolled `onerror=` template, no chance of attribute breakout from
//  admin-supplied `emoji` or `imageUrl`. Returns a real Element; callers can
//  either appendChild it or read `.outerHTML` (which is also safe because the
//  serializer escapes attributes when stringifying).
//
//  Used by both the offer list renderer and the offer bottom sheet.
// ═══════════════════════════════════════════════════════════════════════════
function _safeImgEl(cls, src, emoji) {
  const safeSrc = typeof src === 'string' ? src : '';
  const isData = safeSrc.startsWith('data:');
  const img = document.createElement('img');
  img.className = cls + (isData ? ' loaded' : '');
  img.src = safeSrc;
  img.alt = '';
  if (!isData) img.loading = 'lazy';
  img.decoding = 'async';
  const ph = cls + '-placeholder';
  const em = String(emoji || '🎁');
  img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
  img.addEventListener('error', () => {
    const d = document.createElement('div');
    d.className = ph;
    d.textContent = em;
    img.replaceWith(d);
  }, { once: true });
  return img;
}

// Module-scope helper for string-fragment callers.
// Safe because _safeImgEl never uses innerHTML or hand-rolled attribute injection.
function _safeImgTag(cls, src, emoji) {
  return _safeImgEl(cls, src, emoji).outerHTML;
}

// ════════════════════════════════════════
//  HOME — REWARD SCROLL CARDS
// ════════════════════════════════════════
export const REWARDS = [
  {pts:1000, label:'5€ Έκπτωση',  icon:'🎟️', i18nKey:'rw_1000'},
  {pts:2500, label:'15€ Έκπτωση', icon:'💵', i18nKey:'rw_2500'},
  {pts:4000, label:'30€ Έκπτωση', icon:'👑', i18nKey:'rw_4000'},
];

export function renderHomeRewards(pts) {
  document.getElementById('h-rewards-scroll').innerHTML = REWARDS.map(r => {
    const ok = pts >= r.pts;
    const label = _t(r.i18nKey);
    return `<div class="rw-card ${ok?'unlocked':'locked'}" ${ok?`role="button" tabindex="0" onclick="startRedemption(${r.pts},'${label}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();startRedemption(${r.pts},'${label}')}" aria-label="${label} — ${r.pts} ${_t('points')}"`:` aria-disabled="true"`}>
      <div class="rw-emoji-area">${r.icon}</div>
      <div class="rw-body">
        <div class="rw-pts-badge">${r.pts} ${_t('points')}</div>
        <div class="rw-label">${label}</div>
        <div class="rw-status">${ok?_t('rw_tap'):_t('rw_locked')+(r.pts-pts)+' '+_t('rw_more')}</div>
      </div>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════
//  REWARDS TAB — FULL LIST
// ════════════════════════════════════════
export function renderRewardsList(pts) {
  document.getElementById('rw-list').innerHTML = REWARDS.map(r => {
    const ok   = pts >= r.pts;
    const label = _t(r.i18nKey);
    const prev = REWARDS[REWARDS.indexOf(r)-1]?.pts || 0;
    const pct  = ok ? 100 : Math.max(0, Math.min(100, Math.round(((pts-prev)/(r.pts-prev))*100)));
    return `<div class="rw-full-card ${ok?'ok':''}" ${ok?`role="button" tabindex="0" onclick="startRedemption(${r.pts},'${label}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();startRedemption(${r.pts},'${label}')}" aria-label="${label} — ${r.pts} ${_t('points')}"`:` aria-disabled="true"`}>
      <div class="rw-full-icon">${r.icon}</div>
      <div class="rw-full-body">
        <div class="rw-full-label">${label}</div>
        <div class="rw-full-pts">${r.pts} ${_t('points')}${ok?'':' · '+_t('rw_need')+' '+(r.pts-pts)+' '+_t('rw_more')}</div>
        <div class="rw-full-prog"><div class="rw-full-prog-fill" style="width:${pct}%"></div></div>
      </div>
      <button class="rw-full-action" ${ok?'':'disabled'} aria-hidden="true" tabindex="-1">${ok?'✓':'🔒'}</button>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════
//  OFFERS
// ════════════════════════════════════════
let _offersUnsub = null;
let _offersLastFingerprint = '';
let _activeOffers = [];

export function startOffersListener() {
  stopOffersListener();
  if (window.DEMO) {
    _loadOffersOnce();
    return;
  }
  try {
    const ref = window._query(
      window._col(window._db, 'ipear_offers'),
      window._where('active', '==', true)
    );
    _offersUnsub = window._onSnapshot(
      ref,
      snap => { try { _renderOffersSnap(snap); } catch(re) { logger.error('[offers] render crash:', re); _loadOffersOnce(); } },
      err  => {
        logger.error('[offers] onSnapshot error:', err.code, err.message);
        _loadOffersOnce();
      }
    );
  } catch(e) {
    logger.error('[offers] startOffersListener exception:', e);
    _loadOffersOnce();
  }
}

export function stopOffersListener() {
  if (_offersUnsub) { try { _offersUnsub(); } catch(_) {} _offersUnsub = null; }
  _offersLastFingerprint = '';
}

async function _loadOffersOnce() {
  try {
    const snap = await window._getDocs(
      window._query(window._col(window._db,'ipear_offers'), window._where('active','==',true))
    );
    _renderOffersSnap(snap);
  } catch(e) {
    logger.error('[offers] _loadOffersOnce error:', e.code, e.message);
    const userMsg = !navigator.onLine ? '📡 Ελέγξτε τη σύνδεσή σας.' : 'Δεν ήταν δυνατή η φόρτωση προσφορών.';
    const _errHtml = `<div style="color:var(--grl);padding:20px;text-align:center;font-size:.85rem">${esc(userMsg)}</div>`;
    document.getElementById('offers-list').innerHTML = _errHtml;
    const _hp = document.getElementById('h-offers-preview');
    if (_hp) _hp.innerHTML = _errHtml;
  }
}

function _isOfferActive(o) {
  if (!o.active) return false;
  const raw = o.endDate;
  if (raw === null || raw === undefined || raw === '') return true;
  try {
    let ms;
    if (typeof raw.toDate === 'function') {
      ms = raw.toDate().getTime();
    } else if (typeof raw === 'number') {
      ms = raw > 1e12 ? raw : raw * 1000;
    } else if (typeof raw === 'string') {
      const s = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? raw.trim() + 'T23:59:59' : raw;
      ms = new Date(s).getTime();
    } else {
      logger.warn('[offers] unknown endDate type:', typeof raw, raw);
      return true;
    }
    if (isNaN(ms)) {
      logger.warn('[offers] endDate parse returned NaN:', raw);
      return true;
    }
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    return ms >= todayStart.getTime();
  } catch(e) {
    logger.warn('[offers] endDate exception:', raw, e);
    return true;
  }
}

function _renderOffersSnap(snap) {
  const today = new Date();
  let active = [];
  snap.forEach(d => {
    try {
      const o = d.data ? d.data() : d;
      if (!o) return;
      const show = _isOfferActive(o);
      if (show) active.push({ ...o, id: d.id || o.id });
    } catch(e) { logger.warn('[offers] skipping malformed doc:', d.id, e); }
  });

  // Fingerprint must include EVERY field that any renderer reads — otherwise
  // an admin edit that only touches a non-fingerprinted field (e.g. bumping
  // bonusPoints from +100 to +1000) snapshots through Firestore but skips
  // re-render here, leaving stale values in both the preview and the open
  // offer sheet until a hard reload. Earlier versions only fingerprinted
  // title/imageUrl/endDate, which is why points/desc/singleUse/coupon edits
  // weren't propagating.
  const fingerprint = active.map(o => [
    o.id,
    o.title,
    o.description,
    o.emoji,
    o.imageUrl,
    o.startDate,
    o.endDate,
    o.bonusPoints,
    o.pointsCost,
    o.singleUse ? 1 : 0,
    o.active   ? 1 : 0,
    o.eshopDiscountType,
    o.eshopDiscountAmount,
    o.updatedAt,
  ].join('|')).join(';;');
  if (fingerprint === _offersLastFingerprint) return;
  _offersLastFingerprint = fingerprint;

  _activeOffers = active;

  // If the customer has the offer sheet open while the admin edits the
  // underlying offer (e.g. bumps bonusPoints from +100 to +1000), refresh
  // the open sheet in place so the user sees the new value immediately
  // — rather than the stale snapshot frozen at openOfferSheet() time.
  // `_selectedOffer` is matched by id; the matching record from the new
  // `active` array replaces it and we re-fire openOfferSheet at that index.
  if (_selectedOffer && document.getElementById('offer-sheet')?.classList.contains('show')) {
    const newIdx = active.findIndex(o => o.id === _selectedOffer.id);
    if (newIdx >= 0) {
      _offerSheetBusy = false;   // bypass the 600ms re-entry guard
      openOfferSheet(newIdx);
    }
  }

  // HIGH-3: delegates to the module-scoped safe factories (top of file).
  const _imgTag = _safeImgTag;

  const preview = active.slice(0,2).map((o, idx) => {
    const _iu = typeof o.imageUrl === 'string' ? o.imageUrl : '';
    const safeImg = (_iu && (_iu.startsWith('https://') || _iu.startsWith('data:image/'))) ? _iu : '';
    const imgHtml = safeImg
      ? _imgTag('op-img', safeImg, o.emoji)
      : `<div class="op-img-placeholder">${esc(o.emoji)||'🎁'}</div>`;
    return `<div class="offer-preview" role="button" tabindex="0" onclick="openOfferSheet(${idx})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openOfferSheet(${idx})}" aria-label="${esc(o.title)}">
      ${imgHtml}
      <div class="op-bottom">
        <div class="op-title">${esc(o.title)}</div>
        <div class="op-desc">${esc(o.description)}</div>
        ${o.endDate ? `<div class="op-date">Έως ${(o.endDate?.toDate ? o.endDate.toDate() : new Date(typeof o.endDate === 'string' ? (/^\d{4}-\d{2}-\d{2}$/.test(o.endDate.trim()) ? o.endDate.trim()+'T23:59:59' : o.endDate) : o.endDate)).toLocaleDateString('el-GR')}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const previewEl = document.getElementById('h-offers-preview');
  if (previewEl) previewEl.innerHTML = preview ||
    '<div class="empty-state empty-state--compact"><div class="empty-state__icon" aria-hidden="true">🎁</div><div class="empty-state__title">Καμία ενεργή προσφορά</div><div class="empty-state__sub">Έλεγξε ξανά σύντομα για νέες προσφορές</div></div>';

  const full = active.map((o, idx) => {
    const expDate  = o.endDate && typeof o.endDate !== 'object'
                     ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(o.endDate).trim()) ? o.endDate+'T23:59:59' : o.endDate)
                     : (o.endDate?.toDate ? o.endDate.toDate() : null);
    const daysLeft = expDate && !isNaN(expDate) ? Math.ceil((expDate - today) / 864e5) : 99;
    const soon = daysLeft <= 3;
    const _iu2 = typeof o.imageUrl === 'string' ? o.imageUrl : '';
    const safeImg = (_iu2 && (_iu2.startsWith('https://') || _iu2.startsWith('data:image/'))) ? _iu2 : '';
    const imgHtml = safeImg
      ? _imgTag('ocf-img', safeImg, o.emoji)
      : `<div class="ocf-img-placeholder">${esc(o.emoji)||'🎁'}</div>`;
    const _bp = o.bonusPoints || o.pointsCost || 0;
    const ptsBadge = _bp ? `<span class="ocf-badge-pts">+${_bp} πόντοι</span>` : '';
    return `<div class="offer-card-full" role="button" tabindex="0" onclick="openOfferSheet(${idx})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openOfferSheet(${idx})}" aria-label="${esc(o.title)}">
      ${imgHtml}
      <div class="ocf-body">
        <div class="ocf-badge-row">
          ${soon ? '<span class="ocf-badge-soon">Λήγει σύντομα</span>' : '<span class="ocf-badge-active">Ενεργή</span>'}
          ${ptsBadge}
        </div>
        <div class="ocf-title-head">${esc(o.title)}</div>
        <div class="ocf-desc">${esc(o.description)}</div>
        ${o.endDate ? `<div class="ocf-date">📅 Ισχύει έως ${(expDate && !isNaN(expDate) ? expDate : new Date(o.endDate)).toLocaleDateString('el-GR')}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const fullEl = document.getElementById('offers-list');
  if (fullEl) fullEl.innerHTML = full ||
    '<div class="empty-state"><div class="empty-state__icon" aria-hidden="true">🎁</div><div class="empty-state__title">Δεν υπάρχουν ενεργές προσφορές</div><div class="empty-state__sub">Νέες προσφορές προστίθενται τακτικά — έλεγξε ξανά αύριο</div></div>';
}

export function loadOffersData() { startOffersListener(); }

// ════════════════════════════════════════
//  OFFER BOTTOM SHEET + QR REDEMPTION
// ════════════════════════════════════════
let _selectedOffer = null;
let _offerToRedeem = null;
let _offerQRTimer = null;

function _offerBonus(o) { return Math.floor(Number(o.bonusPoints) || Number(o.pointsCost) || 0); }

let _offerSheetBusy = false;
export function openOfferSheet(idx) {
  if (_offerSheetBusy) return;
  _offerSheetBusy = true;
  setTimeout(() => { _offerSheetBusy = false; }, 600);
  const offers = _activeOffers || [];
  if (!offers[idx]) return;
  _selectedOffer = offers[idx];
  const o = _selectedOffer;
  // HIGH-3: same XSS sink as the offer-list renderer — build the <img> via
  // _safeImgEl() instead of an HTML template, then swap it in via replaceChildren.
  const _oiu = typeof o.imageUrl === 'string' ? o.imageUrl : '';
  const safeImg = (_oiu && (_oiu.startsWith('https://') || _oiu.startsWith('data:image/'))) ? _oiu : '';
  const imgWrap = document.getElementById('os-img-wrap');
  if (imgWrap) {
    if (safeImg) {
      imgWrap.replaceChildren(_safeImgEl('os-img', safeImg, o.emoji));
    } else {
      const ph = document.createElement('div');
      ph.className = 'os-img-placeholder';
      ph.textContent = String(o.emoji || '🎁');
      imgWrap.replaceChildren(ph);
    }
  }
  document.getElementById('os-title').textContent = o.title || '';
  document.getElementById('os-desc').textContent = o.description || '';

  const expDate = o.endDate && typeof o.endDate !== 'object'
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(o.endDate).trim()) ? o.endDate+'T23:59:59' : o.endDate)
    : (o.endDate?.toDate ? o.endDate.toDate() : null);
  const daysLeft = expDate && !isNaN(expDate) ? Math.ceil((expDate - new Date()) / 864e5) : 99;
  const soon = daysLeft <= 3;
  const bp = _offerBonus(o);
  let badgesHtml = soon ? '<span class="ocf-badge-soon">Λήγει σύντομα</span>' : '<span class="ocf-badge-active">Ενεργή</span>';
  if (bp) badgesHtml += `<span class="ocf-badge-pts">+${bp} πόντοι</span>`;
  document.getElementById('os-badges').innerHTML = badgesHtml;

  let rulesHtml = '';
  if (o.singleUse) rulesHtml += '<div class="os-rule"><span class="os-rule-icon">🔒</span>Μία χρήση ανά πελάτη</div>';
  else rulesHtml += '<div class="os-rule"><span class="os-rule-icon">🔄</span>Επαναλαμβανόμενη προσφορά</div>';
  if (bp) rulesHtml += `<div class="os-rule"><span class="os-rule-icon">⭐</span>Κερδίζεις +${bp} πόντους</div>`;
  rulesHtml += '<div class="os-rule"><span class="os-rule-icon">🏪</span>Δείξε το QR στο κατάστημα</div>';
  document.getElementById('os-rules').innerHTML = rulesHtml;

  document.getElementById('os-date').textContent = expDate && !isNaN(expDate)
    ? `Λήγει ${expDate.toLocaleDateString('el-GR')}` : '';

  const cta = document.getElementById('os-cta');
  cta.textContent = '🎁 Θέλω αυτή την προσφορά';
  cta.disabled = false;

  if (o.singleUse && state.foundCustomer) {
    cta.textContent = '⏳ Έλεγχος...';
    cta.disabled = true;
    _checkOfferUsed(o, cta);
  }

  document.getElementById('offer-sheet').classList.add('show');
  document.body.classList.add('modal-open');
  _lockBgScroll();
  _trapFocus(document.getElementById('offer-sheet'));
  _trackEvent('offer_opened');
}

// iOS Safari ignores `overflow:hidden` set via a class on a scrolling div in
// some cases — the body keeps rubber-banding / the tab-pane keeps panning
// behind the modal. Belt-and-suspenders: also pin the active tab-pane with
// inline styles and remember its scrollTop so we can restore on close.
let _bgScrollLocked = false;
let _bgScrollSavedTop = 0;
function _lockBgScroll() {
  if (_bgScrollLocked) return;
  const t = document.querySelector('.tab-pane.active');
  if (!t) return;
  _bgScrollSavedTop = t.scrollTop;
  t.style.overflow = 'hidden';
  t.style.touchAction = 'none';
  _bgScrollLocked = true;
}
function _unlockBgScroll() {
  if (!_bgScrollLocked) return;
  const t = document.querySelector('.tab-pane.active');
  if (t) {
    t.style.overflow = '';
    t.style.touchAction = '';
    t.scrollTop = _bgScrollSavedTop;
  }
  _bgScrollLocked = false;
}

async function _checkOfferUsed(o, cta) {
  try {
    const offerId = o.id || o.title;
    const authUid = window._auth?.currentUser?.uid || state.foundCustomer.id;
    const snap = await window._getDocs(
      window._query(
        window._col(window._db, 'ipear_offer_redemptions'),
        window._where('offerId', '==', offerId),
        window._where('customerId', '==', authUid),
        window._where('used', '==', true)
      )
    );
    if (!snap.empty) {
      cta.textContent = '✅ Ήδη χρησιμοποιήθηκε';
      cta.disabled = true;
      cta.style.background = '#ddd';
      cta.style.color = '#999';
      cta.style.boxShadow = 'none';
    } else {
      cta.textContent = '🎁 Θέλω αυτή την προσφορά';
      cta.disabled = false;
      cta.style.background = '';
      cta.style.color = '';
      cta.style.boxShadow = '';
    }
  } catch(e) {
    cta.textContent = '🎁 Θέλω αυτή την προσφορά';
    cta.disabled = false;
  }
}

export function closeOfferSheet(fromSwipe) {
  _trackEvent('offer_dismissed');
  const sheet = document.getElementById('offer-sheet');
  if (!sheet) return;
  const panel = sheet.querySelector('.os-panel');
  const bd = sheet.querySelector('.os-backdrop');
  if (!panel) { sheet.classList.remove('show'); document.body.classList.remove('modal-open'); _unlockBgScroll(); return; }

  function _cleanup() {
    sheet.classList.remove('show', 'closing');
    document.body.classList.remove('modal-open');
    _unlockBgScroll();
    panel.style.transform = '';
    panel.style.transition = '';
    panel.style.animation = '';
    panel.classList.remove('is-dragging');
    if (bd) { bd.style.transition = ''; bd.style.opacity = ''; }
    const cta = document.getElementById('os-cta');
    if (cta) { cta.style.background = ''; cta.style.color = ''; cta.style.boxShadow = ''; }
    _releaseFocus();
  }

  if (fromSwipe) {
    panel.style.animation = 'none';
    panel.classList.remove('is-dragging');
    if (bd) { bd.style.transition = 'opacity .22s'; bd.style.opacity = '0'; }
    requestAnimationFrame(function() {
      panel.style.transition = 'transform .25s cubic-bezier(.4,0,1,1)';
      requestAnimationFrame(function() {
        panel.style.transform = 'translateY(100%)';
      });
    });
    setTimeout(_cleanup, 320);
  } else {
    panel.style.transform = '';
    panel.style.animation = '';
    sheet.classList.add('closing');
    panel.addEventListener('animationend', _cleanup, {once:true});
    setTimeout(_cleanup, 320);
  }
}

// ── Offer sheet swipe-to-dismiss IIFE ──
(function() {
  let sy=0, vy=0, lastY=0, lastT=0;
  let tracking=false, dragging=false, decided=false;
  const INTENT = 10;
  const DISMISS = 90;
  const VEL_DISMISS = 0.5;

  let _p=null, _bd=null, _sh=null;
  function P(){  return _p  ||(_p =document.querySelector('#offer-sheet .os-panel')); }
  function BD(){ return _bd||(_bd=document.querySelector('#offer-sheet .os-backdrop')); }
  function SH(){ return _sh||(_sh=document.getElementById('offer-sheet')); }

  document.addEventListener('touchstart', function(e) {
    const s = SH(); if (!s || !s.classList.contains('show')) return;
    sy = lastY = e.touches[0].clientY;
    lastT = e.timeStamp;
    vy = 0;
    tracking = true; dragging = false; decided = false;
  }, {passive: true});

  document.addEventListener('touchmove', function(e) {
    if (!tracking) return;
    const p = P(); if (!p) { tracking = false; return; }
    const cy = e.touches[0].clientY;
    const raw = cy - sy;
    const now = e.timeStamp;

    const dt = now - lastT;
    if (dt > 0) vy = 0.6 * vy + 0.4 * ((cy - lastY) / dt);
    lastY = cy; lastT = now;

    if (!decided) {
      if (Math.abs(raw) < INTENT) return;
      decided = true;
      if (raw > 0 && p.scrollTop <= 0) {
        dragging = true;
        p.classList.add('is-dragging');
      } else {
        dragging = false; tracking = false; return;
      }
    }
    if (!dragging) return;

    e.preventDefault();

    const d = Math.max(0, raw);
    p.style.transform = 'translate3d(0,' + d + 'px,0)';
    const b = BD();
    if (b) b.style.opacity = String(Math.max(0, 1 - d / 350));
  }, {passive: false});

  document.addEventListener('touchend', function() {
    if (!tracking) return; tracking = false;
    if (!dragging) return; dragging = false;
    const p = P(); if (!p) return;
    const d = Math.max(0, lastY - sy);

    if (d > DISMISS || vy > VEL_DISMISS) {
      closeOfferSheet(true);
    } else {
      p.style.animation = 'none';
      p.classList.remove('is-dragging');
      const b = BD();
      requestAnimationFrame(function() {
        p.style.transition = 'transform .28s cubic-bezier(.22,1,.36,1)';
        requestAnimationFrame(function() {
          p.style.transform = 'translate3d(0,0,0)';
          if (b) { b.style.transition = 'opacity .28s'; b.style.opacity = '1'; }
        });
      });
      setTimeout(function() {
        p.style.transform = '';
        p.style.transition = '';
        p.style.animation = '';
        if (b) { b.style.transition = ''; b.style.opacity = ''; }
      }, 320);
    }
  }, {passive: true});
})();

export function offerRedeemStep1() {
  if (state._maintenanceMode) { showToast('Το σύστημα αναβαθμίζεται. Παρακαλούμε δοκιμάστε σε λίγο!', 'warn'); return; }
  _offerToRedeem = _selectedOffer;
  const _sheet = document.getElementById('offer-sheet');
  _sheet.querySelector('.os-panel').style.transform = '';
  _sheet.querySelector('.os-panel').style.transition = '';
  _sheet.classList.remove('show', 'closing');
  document.body.classList.remove('modal-open');
  _unlockBgScroll();
  document.getElementById('offer-confirm').classList.add('show');
  _trapFocus(document.getElementById('offer-confirm'));
  _trackEvent('offer_confirmed');
}

export function closeOfferConfirm() {
  _trackEvent('offer_cancelled_qr');
  document.getElementById('offer-confirm').classList.remove('show');
  document.body.classList.remove('modal-open');
  _releaseFocus();
  _offerToRedeem = null;
}

let _offerQRBusy = false;
let _activeOfferRedemptionId = null;
export async function offerGenerateQR() {
  if (_offerQRBusy) return;
  _offerQRBusy = true;
  document.getElementById('offer-confirm').classList.remove('show');
  const o = _offerToRedeem;
  if (!o || !state.foundCustomer) { showToast('⚠️ Κάτι πήγε στραβά. Δοκίμασε ξανά'); _offerQRBusy = false; return; }

  const now = new Date();
  const expires = new Date(now.getTime() + 5*60*1000);

  const _oRnd = new Uint32Array(1); crypto.getRandomValues(_oRnd);
  const code = String(100000 + (_oRnd[0] % 900000));

  const authUid = window._auth?.currentUser?.uid;
  if (!authUid) {
    showToast('⚠️ Συνδέσου ξανά για να συνεχίσεις');
    _offerQRBusy = false;
    return;
  }

  if (authUid && state.foundCustomer.id !== authUid) {
    try { await _migrateCustomerToUid(state.foundCustomer.id, authUid); }
    catch (e) { logger.warn('[migrate-uid] failed:', e?.code || e?.message || e); }
  }

  const bp = _offerBonus(o);

  document.getElementById('oq-title').textContent = o.title;
  document.getElementById('oq-sub').textContent = bp ? `+${bp} bonus πόντοι` : 'Προσφορά';
  document.getElementById('oq-code').textContent = code.slice(0,3) + ' ' + code.slice(3);
  const _oqOverlay = document.getElementById('offer-qr-overlay');
  _oqOverlay.querySelectorAll('.ro-laser').forEach(l => { l.style.animation = 'none'; l.offsetHeight; l.style.animation = ''; });
  _oqOverlay.style.display = 'flex';
  _trapFocus(document.getElementById('offer-qr-overlay'));

  const qrEl = document.getElementById('oq-qr');
  qrEl.innerHTML = '';
  try {
    new QRCode(qrEl, {
      text: 'IPEAR-OFFER:' + code,
      width: 180, height: 180,
      colorDark: '#111111', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch(qe) { logger.warn('Offer QR gen error:', qe); }

  _startOfferCountdown(expires);

  try {
    const offerDocRef = await window._addDoc(window._col(window._db, 'ipear_offer_redemptions'), {
      code,
      offerId: o.id || o.title || 'unknown',
      offerTitle: o.title,
      bonusPoints: _offerBonus(o),
      singleUse: o.singleUse || false,
      customerId: authUid,
      customerDocId: state.foundCustomer.id,
      customerName: state.foundCustomer.name,
      card: state.foundCustomer.card,
      status: 'pending',
      used: false,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      createdAtTs: now,
      expiresAtTs: expires
    });
    _activeOfferRedemptionId = offerDocRef.id;
    _watchOfferRedemptionDoc(offerDocRef.id);
  } catch(e) {
    logger.error('[offer-save] ERROR:', e?.code, e?.message, 'foundCustomer.id:', state.foundCustomer?.id, 'authUid:', authUid);
    clearInterval(_offerQRTimer);
    document.getElementById('offer-qr-overlay').style.display = 'none';
    showToast('⚠️ Κάτι πήγε στραβά. Δοκίμασε ξανά', 'error');
  } finally {
    _offerQRBusy = false;
    _offerToRedeem = null;
  }
}

let _offerExpires = null;

export function _offerTick() {
  const dot = document.getElementById('oq-dot'), tmr = document.getElementById('oq-timer');
  if (!_offerExpires || !tmr) return;
  const rem = _offerExpires - Date.now();
  if (rem <= 0) {
    clearInterval(_offerQRTimer);
    _offerExpires = null;
    _stopOfferRedeemWatch();
    _offerQRBusy = false;
    _activeOfferRedemptionId = null;
    tmr.textContent = '⏰ Το QR έληξε';
    tmr.className = 'ro-timer exp';
    if (dot) dot.style.background = '#ff3b30';
    tmr.setAttribute('aria-live', 'assertive');
    setTimeout(() => {
      document.getElementById('offer-qr-overlay').style.display = 'none';
      showToast('⏰ Ο κωδικός έληξε. Δοκίμασε ξανά', 'warn');
    }, 2000);
    return;
  }
  const m = Math.floor(rem / 60000), s = Math.floor((rem % 60000) / 1000);
  tmr.textContent = `Λήγει σε ${m}:${String(s).padStart(2,'0')}`;
  tmr.className = 'ro-timer' + (rem < 60000 ? ' warn' : '');
  if (dot) dot.style.background = rem < 60000 ? '#ff9500' : 'var(--g)';
}

function _startOfferCountdown(expires) {
  clearInterval(_offerQRTimer);
  _offerExpires = expires;
  _offerTick();
  _offerQRTimer = setInterval(_offerTick, 500);
}

let _offerRedeemUnsub = null;
export function _stopOfferRedeemWatch() {
  if (_offerRedeemUnsub) { try { _offerRedeemUnsub(); } catch(_){} _offerRedeemUnsub = null; }
}
function _watchOfferRedemptionDoc(docId) {
  _stopOfferRedeemWatch();
  if (!docId || window.DEMO) return;
  try {
    const ref = window._doc(window._db, 'ipear_offer_redemptions', docId);
    _offerRedeemUnsub = window._onSnapshot(ref, snap => {
      if (!snap.exists()) {
        _stopOfferRedeemWatch();
        clearInterval(_offerQRTimer);
        _offerQRBusy = false;
        _activeOfferRedemptionId = null;
        document.getElementById('offer-qr-overlay').style.display = 'none';
        showToast('Η εξαργύρωση ακυρώθηκε από το κατάστημα', 'red');
        return;
      }
      const d = snap.data();
      if (d.status === 'rejected' || d.status === 'cancelled') {
        _stopOfferRedeemWatch();
        clearInterval(_offerQRTimer);
        _offerQRBusy = false;
        _activeOfferRedemptionId = null;
        document.getElementById('offer-qr-overlay').style.display = 'none';
        showToast('Η εξαργύρωση ακυρώθηκε από το κατάστημα', 'red');
        return;
      }
      if (d.used === true || d.status === 'approved' || d.status === 'used') {
        _stopOfferRedeemWatch();
        clearInterval(_offerQRTimer);
        _offerQRBusy = false;
        _activeOfferRedemptionId = null;
        document.getElementById('offer-qr-overlay').style.display = 'none';
        const bp = d.bonusPoints || 0;
        showToast('✅ Προσφορά εγκρίθηκε' + (bp > 0 ? ' · +' + bp + ' πόντοι' : ''), 'green');
        _haptic('success');
        setTimeout(() => _fireConfetti({ particleCount: 150, spread: 100 }), 200);
      }
    });
  } catch(e) { logger.warn('[offer-redeem-watch]', e); }
}

export async function cancelOfferQR() {
  clearInterval(_offerQRTimer);
  _stopOfferRedeemWatch();
  _offerQRBusy = false;
  _offerExpires = null;
  const _oqr = document.getElementById('offer-qr-overlay');
  _oqr.style.display = 'none';
  _oqr.querySelectorAll('.ro-laser').forEach(l => { l.style.animation = 'none'; l.offsetHeight; l.style.animation = ''; });
  _releaseFocus();
  if (_activeOfferRedemptionId && !window.DEMO) {
    const docId = _activeOfferRedemptionId;
    _activeOfferRedemptionId = null;
    try {
      await window._deleteDoc(window._doc(window._db, 'ipear_offer_redemptions', docId));
      logger.log('[offer-cancel] deleted offer redemption doc:', docId);
    } catch(e) {
      logger.warn('[offer-cancel] delete failed, falling back to status update:', e.message);
      try {
        await window._updateDoc(window._doc(window._db, 'ipear_offer_redemptions', docId), {
          status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: 'user-cancelled'
        });
      } catch(_) {}
    }
  } else {
    _activeOfferRedemptionId = null;
  }
}

// ════════════════════════════════════════
//  E-SHOP COUPON
// ════════════════════════════════════════
export async function offerGenerateEshopCoupon() {
  document.getElementById('offer-confirm').classList.remove('show');
  const o = _offerToRedeem;
  if (!o) { showToast('⚠️ Κάτι πήγε στραβά. Δοκίμασε ξανά'); return; }
  _offerToRedeem = null;

  const discType = o.eshopDiscountType || '';
  const discAmt  = Number(o.eshopDiscountAmount) || 0;
  if (!discType || discAmt <= 0) {
    showToast('⚠️ Δεν διατίθεται κουπόνι e-shop για αυτή την προσφορά', 'warn');
    return;
  }

  const authUser = window._auth?.currentUser;
  if (!authUser) { showToast('⚠️ Συνδέσου ξανά'); return; }

  showToast('⏳ Δημιουργία κουπονιού…');
  try {
    const idToken = await authUser.getIdToken(true);
    const res = await fetch(_WORKER_URL + '/woo-create-coupon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idToken,
        offerTitle: o.title || '',
        discountType: discType,
        discountAmount: discAmt,
        singleUse: !!o.singleUse,
      })
    });
    const data = await res.json();
    if (!data.ok) {
      showToast('❌ ' + (data.error || 'Σφάλμα δημιουργίας κουπονιού'), 'error');
      return;
    }
    const label = discType === 'percent' ? (discAmt + '%') : (discAmt + '€');
    _showEshopCouponResult(data.code, label, data.expiresAt);
  } catch (e) {
    logger.warn('[eshop-coupon]', e);
    showToast('❌ Δεν συνδέθηκε. Δοκίμασε ξανά', 'error');
  }
}

function _showEshopCouponResult(code, discountLabel, expiresAt) {
  const overlay = document.getElementById('offer-qr-overlay');
  const wrap = overlay.querySelector('.ro-wrap');
  const expDate = expiresAt ? new Date(expiresAt).toLocaleDateString('el-GR') : '';
  wrap.innerHTML = `
    <button class="ro-close" onclick="document.getElementById('offer-qr-overlay').style.display='none'" aria-label="Κλείσιμο">×</button>
    <div style="text-align:center;padding:24px 16px">
      <div style="font-size:3rem;margin-bottom:12px">🛒</div>
      <div style="font-size:1.1rem;font-weight:800;color:var(--bk);margin-bottom:4px">Το κουπόνι σου είναι έτοιμο!</div>
      <div style="font-size:.82rem;color:var(--grl);margin-bottom:20px">Έκπτωση ${discountLabel} στο e-shop</div>
      <div style="background:linear-gradient(135deg,#f0fff0,#e8ffe8);border:2.5px dashed var(--g);border-radius:14px;padding:18px;margin-bottom:16px">
        <div style="font-size:1.6rem;font-weight:900;letter-spacing:2px;color:var(--gd);font-family:monospace" id="eshop-coupon-code">${code.toUpperCase()}</div>
      </div>
      <button onclick="_copyEshopCoupon()" style="padding:12px 24px;background:var(--g);color:#111;border:none;border-radius:12px;font-family:var(--font);font-weight:800;font-size:.9rem;cursor:pointer;margin-bottom:12px;min-height:44px">📋 Αντιγραφή κωδικού</button>
      <div style="font-size:.76rem;color:var(--grl);margin-top:8px">${expDate ? 'Ισχύει έως ' + expDate : ''} · Μόνο για το email σου</div>
    </div>`;
  overlay.style.display = 'flex';
}

export function _copyEshopCoupon() {
  const code = document.getElementById('eshop-coupon-code')?.textContent || '';
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).then(() => showToast('✅ Αντιγράφηκε: ' + code));
  } else {
    showToast('📋 ' + code, 'info');
  }
}

// ════════════════════════════════════════
//  LEADERBOARD
// ════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════
//  HISTORY (paginated, cursor-based)
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
const HIST_PAGE_SIZE = 20;
const HIST_INITIAL_VISIBLE = 5;
const _HISTORY_MIN_GAP_MS = 800;

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
    let ico, lbl, cls;
    if (tx.type === 'add') {
      ico = '🛒'; cls = 'add'; lbl = tx.category || 'Αγορά';
    } else if (tx.type === 'redeem') {
      ico = '💶'; cls = 'redeem'; lbl = `Έκπτωση ${tx.discount||''}€`;
    } else if (tx.type === 'expire') {
      ico = '⏳'; cls = 'redeem'; lbl = '⏳ Εκπνοή Πόντων';
    } else if (tx.type === 'tier_downgrade') {
      ico = '📉'; cls = 'redeem'; lbl = tx.note || 'Tier Downgrade';
    } else if (tx.type === 'referral' || tx.category?.includes('Referral')) {
      ico = '🎁'; cls = 'add'; lbl = tx.category || '🎁 Referral Bonus';
    } else {
      ico = tx.points > 0 ? '🛒' : '💶';
      cls = tx.points > 0 ? 'add' : 'redeem';
      lbl = tx.category || tx.note || 'Συναλλαγή';
    }
    const txPts = Number(tx.points) || 0;
    const ptsSign = txPts > 0 ? '+' : '';
    const storeTag = (tx.storeName && tx.storeName !== '—')
      ? `<span style="display:inline-block;margin-top:2px;font-size:.65rem;background:rgba(138,233,0,.18);color:#3a6e00;border-radius:6px;padding:1px 6px;font-weight:700">${esc(tx.storeName)}</span>`
      : '';
    const hiddenStyle = !_histExpanded && i >= HIST_INITIAL_VISIBLE ? 'style="display:none"' : '';
    return `<div class="hist-item hist-type-${cls} hist-row" data-hist-idx="${i}" ${hiddenStyle}>
      <div class="hist-ico ${cls}">${ico}</div>
      <div class="hist-body"><div class="hist-name">${esc(lbl)}</div><div class="hist-date">${ds} ${storeTag}</div></div>
      <div class="hist-pts ${cls}">${ptsSign}${txPts.toLocaleString('el-GR')}</div>
    </div>`;
  }).join('');

  const hiddenCount = Math.max(0, _historyTxs.length - HIST_INITIAL_VISIBLE);
  const hasMorePages = _historyHasMoreUid || _historyHasMoreEmail;

  if (!_histExpanded && hiddenCount > 0) {
    html += `<button id="hist-more-btn" onclick="_toggleHistory()" class="hist-more-btn">Περισσότερα... (+${hiddenCount})</button>`;
  } else if (_histExpanded && hasMorePages) {
    html += `<button id="hist-more-btn" onclick="loadHistoryMore()" class="hist-more-btn hist-more-btn--paginate">Φόρτωση παλαιότερων ↓</button>`;
  }

  el.innerHTML = html;
}

export function _toggleHistory() {
  _histExpanded = !_histExpanded;
  _renderHistory(document.getElementById('pr-history'));
}

// ════════════════════════════════════════
//  QR CODE (Card tab)
// ════════════════════════════════════════
let _qrGenerated = false;
export function generateQR() {
  if (_qrGenerated || !state.foundCustomer || !window.QRCode) return;
  const el = document.getElementById('qr-canvas');
  el.innerHTML = '';
  new QRCode(el, {
    text: state.foundCustomer.card,
    width: 200, height: 200,
    colorDark: '#111111',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H
  });
  _qrGenerated = true;
}

// ════════════════════════════════════════
//  REFERRAL
// ════════════════════════════════════════
export async function copyReferral() {
  const code = state.foundCustomer?.card || '';
  const btn = document.querySelector('.ref-copy-btn');
  try {
    await navigator.clipboard.writeText(code);
    if (btn) { const orig = btn.textContent; btn.textContent = '✅ Αντιγράφηκε!'; btn.style.background = '#111'; btn.style.color = '#8ae900'; setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; }, 1500); }
    showToast('✅ Αντιγράφηκε: ' + code, 'green');
    _haptic('pop');
  } catch(e) { showToast('Κωδικός: ' + code); }
}

export async function shareReferral() {
  const code = state.foundCustomer?.card || '';
  const basePath = window.location.pathname.includes('customer') ? window.location.pathname : '/customer.html';
  const appUrl = window.location.origin + basePath + '?ref=' + encodeURIComponent(code);
  const text = `Εγγράψου στο iPear Loyalty και κέρδισε πόντους σε κάθε αγορά! 🎁\n\nΆνοιξε τον σύνδεσμο παρακάτω — ο κωδικός παραπομπής ${code} θα συμπληρωθεί αυτόματα!\n\n🔗 ${appUrl}`;
  if (navigator.share) {
    try { await navigator.share({title:'iPear Loyalty', text, url: appUrl}); } catch(e) {}
  } else {
    try { await navigator.clipboard.writeText(text); showToast('✅ Αντιγράφηκε','green'); } catch(e) { showToast('Κωδικός: ' + code); }
  }
}
