// ═══════════════════════════════════════════════════════════════════════════
//  Customer UI — Offers (list + bottom sheet + multi-offer QR queue + e-shop)
//
//  Extracted from src/ui-renderers.js during the Sprint 3 god-module split.
//  This is the biggest domain — it owns 4 concerns that share state:
//   • Offer list rendering (home preview + full list, fingerprint-deduped)
//   • Offer bottom sheet (open/close/swipe-to-dismiss/already-used check)
//   • Multi-offer QR queue (concurrent codes, pagination, floating bar, timer)
//   • E-shop coupon redemption (worker call + result overlay)
//
//  Side effect: module evaluation attaches global touchstart/touchmove/touchend
//  listeners that power the bottom-sheet swipe-to-dismiss gesture. Because ESM
//  modules are evaluated exactly once, the listeners are wired up once per
//  page load regardless of how many places re-import this file.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../../logger.js';
import { state } from '../../state.js';
import { esc, showToast, _trackEvent, _trapFocus, _releaseFocus, _fireConfetti, _WORKER_URL, _haptic, offerRuntimeStatus } from '../../utils.js';
import { _migrateCustomerToUid } from '../../main.js';
import { _safeImgEl, _safeImgTag } from './_shared.js';

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
  // Split the fetch and render into separate try blocks so the log message
  // identifies the actual failure mode. Previously both paths funneled into
  // a single "[offers] _loadOffersOnce error" line, which masked render
  // crashes (malformed doc) behind a network-style error.
  let snap;
  try {
    snap = await window._getDocs(
      window._query(window._col(window._db,'ipear_offers'), window._where('active','==',true))
    );
  } catch(e) {
    logger.error('[offers] fetch failed:', e?.code, e?.message);
    const userMsg = !navigator.onLine ? '📡 Ελέγξτε τη σύνδεσή σας.' : 'Δεν ήταν δυνατή η φόρτωση προσφορών.';
    const _errHtml = `<div style="color:var(--grl);padding:20px;text-align:center;font-size:.85rem">${esc(userMsg)}</div>`;
    const _fl = document.getElementById('offers-list');
    if (_fl) _fl.innerHTML = _errHtml;
    const _hp = document.getElementById('h-offers-preview');
    if (_hp) _hp.innerHTML = _errHtml;
    return;
  }
  try {
    _renderOffersSnap(snap);
  } catch(e) {
    logger.error('[offers] render crashed on snap:', e?.message, e?.stack);
    const _errHtml = `<div style="color:var(--grl);padding:20px;text-align:center;font-size:.85rem">${esc('Σφάλμα εμφάνισης προσφορών. Ανανέωσε τη σελίδα.')}</div>`;
    const _fl = document.getElementById('offers-list');
    if (_fl) _fl.innerHTML = _errHtml;
    const _hp = document.getElementById('h-offers-preview');
    if (_hp) _hp.innerHTML = _errHtml;
  }
}

// Effective offer validity for the customer app. Authoritative status lives on
// the server (canonicalOfferValue); this is the display/redeemability filter and
// now shares the exact same rule: date-aware, Europe/Athens business-day
// boundaries, and also excludes not-yet-started (scheduled) offers.
function _isOfferActive(o) {
  return offerRuntimeStatus(o) === 'active';
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

  const preview = active.slice(0,2).map((o, idx) => {
    const _iu = typeof o.imageUrl === 'string' ? o.imageUrl : '';
    const safeImg = (_iu && (_iu.startsWith('https://') || _iu.startsWith('data:image/'))) ? _iu : '';
    const imgHtml = safeImg
      ? _safeImgTag('op-img', safeImg, o.emoji)
      : `<div class="op-img-placeholder">${esc(o.emoji)||'🎁'}</div>`;
    return `<div class="offer-preview" role="button" tabindex="0" data-action="openOfferSheet" data-arg="${idx}" data-key-action="openOfferSheet" data-karg="${idx}" data-key-space="1" aria-label="${esc(o.title)}">
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
      ? _safeImgTag('ocf-img', safeImg, o.emoji)
      : `<div class="ocf-img-placeholder">${esc(o.emoji)||'🎁'}</div>`;
    const _bp = o.bonusPoints || o.pointsCost || 0;
    const ptsBadge = _bp ? `<span class="ocf-badge-pts">+${_bp} πόντοι</span>` : '';
    return `<div class="offer-card-full" role="button" tabindex="0" data-action="openOfferSheet" data-arg="${idx}" data-key-action="openOfferSheet" data-karg="${idx}" data-key-space="1" aria-label="${esc(o.title)}">
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

// ══════════════════════════════════════════════════════════════════════════
//  Multi-offer queue
//
//  Each entry: { offer, code, expires (Date), docId, unsub }
//  Customer can generate multiple concurrent offer QRs and toggle between
//  them with the < 1/N > pagination at the bottom of the overlay. The
//  floating bar shows the badge count + the soonest-expiring countdown.
//
//  Single shared interval ticks every 500 ms — iterates the queue, expires
//  individual entries (with their watchers) and re-renders the modal +
//  bar. When the queue empties, the interval stops.
// ══════════════════════════════════════════════════════════════════════════
let _offerQueue = [];
let _currentOfferIdx = 0;
let _offerQRBusy = false;
let _offerBarMinimized = false;

function _activeOfferEntry() { return _offerQueue[_currentOfferIdx] || null; }
function _findOfferEntryByDocId(docId) { return _offerQueue.findIndex(e => e.docId === docId); }

function _renderCurrentOfferQR() {
  const entry = _activeOfferEntry();
  if (!entry) return;
  const o = entry.offer;
  const bp = _offerBonus(o);

  document.getElementById('oq-title').textContent = o.title || '';
  document.getElementById('oq-sub').textContent = bp ? `+${bp} bonus πόντοι` : 'Προσφορά';
  document.getElementById('oq-code').textContent = entry.code.slice(0,3) + ' ' + entry.code.slice(3);

  const qrEl = document.getElementById('oq-qr');
  qrEl.innerHTML = '';
  try {
    new QRCode(qrEl, {
      text: 'IPEAR-OFFER:' + entry.code,
      width: 180, height: 180,
      colorDark: '#111111', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch(qe) { logger.warn('Offer QR gen error:', qe); }

  const pag = document.getElementById('oq-pagination');
  if (pag) {
    if (_offerQueue.length > 1) {
      pag.style.display = 'flex';
      document.getElementById('oq-pag-label').textContent = `${_currentOfferIdx + 1} / ${_offerQueue.length}`;
    } else {
      pag.style.display = 'none';
    }
  }
}

export function navigateOfferQR(delta) {
  if (_offerQueue.length < 2) return;
  _currentOfferIdx = (_currentOfferIdx + delta + _offerQueue.length) % _offerQueue.length;
  _renderCurrentOfferQR();
  const overlay = document.getElementById('offer-qr-overlay');
  if (overlay) overlay.querySelectorAll('.ro-laser').forEach(l => { l.style.animation = 'none'; l.offsetHeight; l.style.animation = ''; });
}

function _removeOfferEntry(idx, opts = {}) {
  if (idx < 0 || idx >= _offerQueue.length) return;
  const entry = _offerQueue[idx];
  if (entry.unsub) { try { entry.unsub(); } catch(_) {} entry.unsub = null; }
  _offerQueue.splice(idx, 1);
  if (_currentOfferIdx >= _offerQueue.length) {
    _currentOfferIdx = Math.max(0, _offerQueue.length - 1);
  }
  if (_offerQueue.length === 0) {
    clearInterval(_offerQRTimer);
    _offerQRTimer = null;
    _offerBarMinimized = false;
    _hideOfferBar();
    const overlay = document.getElementById('offer-qr-overlay');
    if (overlay && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
      overlay.querySelectorAll('.ro-laser').forEach(l => { l.style.animation = 'none'; l.offsetHeight; l.style.animation = ''; });
      _releaseFocus();
    }
  } else {
    const overlayShown = document.getElementById('offer-qr-overlay')?.style.display !== 'none';
    if (overlayShown) _renderCurrentOfferQR();
    _updateOfferBar();
  }
  if (opts.deleteDoc && entry.docId && !window.DEMO) {
    (async () => {
      try {
        await window._deleteDoc(window._doc(window._db, 'ipear_offer_redemptions', entry.docId));
      } catch(e) {
        try {
          await window._updateDoc(window._doc(window._db, 'ipear_offer_redemptions', entry.docId), {
            status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: 'user-cancelled'
          });
        } catch(_) {}
      }
    })();
  }
}

function _watchOfferRedemptionDoc(entry) {
  if (!entry.docId || window.DEMO) return;
  try {
    const ref = window._doc(window._db, 'ipear_offer_redemptions', entry.docId);
    entry.unsub = window._onSnapshot(ref, snap => {
      const idx = _findOfferEntryByDocId(entry.docId);
      if (idx < 0) return;
      if (!snap.exists()) {
        _removeOfferEntry(idx);
        showToast('Η εξαργύρωση ακυρώθηκε από το κατάστημα', 'red');
        return;
      }
      const d = snap.data();
      if (d.status === 'rejected' || d.status === 'cancelled') {
        _removeOfferEntry(idx);
        showToast('Η εξαργύρωση ακυρώθηκε από το κατάστημα', 'red');
        return;
      }
      if (d.used === true || d.status === 'approved' || d.status === 'used') {
        _removeOfferEntry(idx);
        const bp = d.bonusPoints || 0;
        showToast('✅ Προσφορά εγκρίθηκε' + (bp > 0 ? ' · +' + bp + ' πόντοι' : ''), 'green');
        _haptic('success');
        setTimeout(() => _fireConfetti({ particleCount: 150, spread: 100 }), 200);
      }
    });
  } catch(e) { logger.warn('[offer-redeem-watch]', e); }
}

// Full queue teardown — called by main.js's _forceCleanup on logout / account
// deletion. Iterates the offer queue, unsubs every per-entry Firestore watcher,
// stops the shared interval, and resets ALL module-scope state so a subsequent
// login from another account doesn't inherit stale closures.
//
// Was previously a no-op left over from the multi-offer refactor — that
// silently leaked N snapshot listeners + 1 interval per logout cycle, and
// kept the floating bar / overlay state alive into the next session.
export function _stopOfferRedeemWatch() {
  for (const entry of _offerQueue) {
    if (entry.unsub) { try { entry.unsub(); } catch(_) {} entry.unsub = null; }
  }
  _offerQueue.length = 0;
  _currentOfferIdx = 0;
  _offerBarMinimized = false;
  _offerQRBusy = false;
  if (_offerQRTimer) { clearInterval(_offerQRTimer); _offerQRTimer = null; }
  const bar = document.getElementById('active-offer-bar');
  if (bar) { bar.style.display = 'none'; bar.classList.remove('hiding'); }
  const overlay = document.getElementById('offer-qr-overlay');
  if (overlay) overlay.style.display = 'none';
}

export async function offerGenerateQR() {
  if (_offerQRBusy) return;
  _offerQRBusy = true;
  document.getElementById('offer-confirm').classList.remove('show');
  const o = _offerToRedeem;
  if (!o || !state.foundCustomer) { showToast('⚠️ Κάτι πήγε στραβά. Δοκίμασε ξανά'); _offerQRBusy = false; return; }

  if (_offerQueue.some(e => (e.offer.id || e.offer.title) === (o.id || o.title))) {
    showToast('Ήδη έχεις ενεργό QR για αυτή την προσφορά', 'warn');
    _offerQRBusy = false;
    _offerToRedeem = null;
    return;
  }

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

  const entry = { offer: o, code, expires, docId: null, unsub: null };
  _offerQueue.push(entry);
  _currentOfferIdx = _offerQueue.length - 1;

  const _oqOverlay = document.getElementById('offer-qr-overlay');
  _oqOverlay.style.display = 'flex';
  _renderCurrentOfferQR();
  _oqOverlay.querySelectorAll('.ro-laser').forEach(l => { l.style.animation = 'none'; l.offsetHeight; l.style.animation = ''; });
  _trapFocus(_oqOverlay);

  _offerBarMinimized = false;
  _hideOfferBar();

  if (!_offerQRTimer) {
    _offerTick();
    _offerQRTimer = setInterval(_offerTick, 500);
  }

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
    entry.docId = offerDocRef.id;
    _watchOfferRedemptionDoc(entry);
  } catch(e) {
    logger.error('[offer-save] ERROR:', e?.code, e?.message, 'foundCustomer.id:', state.foundCustomer?.id, 'authUid:', authUid);
    const idx = _offerQueue.indexOf(entry);
    if (idx >= 0) _removeOfferEntry(idx);
    showToast('⚠️ Κάτι πήγε στραβά. Δοκίμασε ξανά', 'error');
  } finally {
    _offerQRBusy = false;
    _offerToRedeem = null;
  }
}

export function _offerTick() {
  const now = Date.now();
  let modalNeedsRerender = false;

  for (let i = _offerQueue.length - 1; i >= 0; i--) {
    const entry = _offerQueue[i];
    if (entry.expires.getTime() - now <= 0) {
      const wasCurrent = (i === _currentOfferIdx);
      if (entry.unsub) { try { entry.unsub(); } catch(_) {} entry.unsub = null; }
      _offerQueue.splice(i, 1);
      if (_currentOfferIdx >= _offerQueue.length) _currentOfferIdx = Math.max(0, _offerQueue.length - 1);
      if (wasCurrent) modalNeedsRerender = true;
      showToast(`⏰ Κωδικός "${entry.offer.title || 'προσφοράς'}" έληξε`, 'warn');
      if (entry.docId && !window.DEMO) {
        window._deleteDoc(window._doc(window._db, 'ipear_offer_redemptions', entry.docId)).catch(() => {});
      }
    }
  }

  if (_offerQueue.length === 0) {
    clearInterval(_offerQRTimer);
    _offerQRTimer = null;
    _offerBarMinimized = false;
    _hideOfferBar();
    const overlay = document.getElementById('offer-qr-overlay');
    if (overlay && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
      _releaseFocus();
    }
    return;
  }

  const current = _activeOfferEntry();
  if (current) {
    const rem = current.expires.getTime() - now;
    const tmr = document.getElementById('oq-timer');
    const dot = document.getElementById('oq-dot');
    if (tmr) {
      const m = Math.floor(rem / 60000), s = Math.floor((rem % 60000) / 1000);
      tmr.textContent = `Λήγει σε ${m}:${String(s).padStart(2,'0')}`;
      tmr.className = 'ro-timer' + (rem < 60000 ? ' warn' : '');
    }
    if (dot) dot.style.background = rem < 60000 ? '#ff9500' : 'var(--g)';
  }

  if (modalNeedsRerender && document.getElementById('offer-qr-overlay')?.style.display !== 'none') {
    _renderCurrentOfferQR();
  }

  _updateOfferBar();
}

export function minimizeOfferQR() {
  if (_offerQueue.length === 0) return;
  _offerBarMinimized = true;
  const overlay = document.getElementById('offer-qr-overlay');
  overlay.style.display = 'none';
  overlay.querySelectorAll('.ro-laser').forEach(l => { l.style.animation = 'none'; });
  _releaseFocus();
  const bar = document.getElementById('active-offer-bar');
  if (bar) {
    bar.style.display = 'flex';
    bar.classList.remove('hiding');
    _updateOfferBar();
  }
  _trackEvent('offer_minimized');
}

export function restoreOfferQR() {
  if (_offerQueue.length === 0) return;
  _offerBarMinimized = false;
  _hideOfferBar();
  _renderCurrentOfferQR();
  const overlay = document.getElementById('offer-qr-overlay');
  overlay.querySelectorAll('.ro-laser').forEach(l => { l.style.animation = 'none'; l.offsetHeight; l.style.animation = ''; });
  overlay.style.display = 'flex';
  _trapFocus(overlay);
  _trackEvent('offer_restored');
}

function _hideOfferBar() {
  const bar = document.getElementById('active-offer-bar');
  if (!bar || bar.style.display === 'none') return;
  bar.classList.add('hiding');
  setTimeout(() => { bar.style.display = 'none'; bar.classList.remove('hiding'); }, 260);
}

function _updateOfferBar() {
  if (_offerQueue.length === 0) return;
  // Show countdown for the soonest-expiring entry (most urgent)
  const soonest = _offerQueue.reduce(
    (best, e) => e.expires.getTime() < best.expires.getTime() ? e : best,
    _offerQueue[0]
  );
  const rem = soonest.expires.getTime() - Date.now();
  if (rem <= 0) return;
  const tmrEl = document.getElementById('aob-timer');
  if (tmrEl) {
    const m = Math.floor(rem / 60000), s = Math.floor((rem % 60000) / 1000);
    tmrEl.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    tmrEl.className = 'aob-timer' + (rem < 60000 ? ' warn' : '');
  }
  const badge = document.getElementById('aob-badge');
  if (badge) {
    if (_offerQueue.length > 1) {
      badge.style.display = 'inline-flex';
      badge.textContent = String(_offerQueue.length);
    } else {
      badge.style.display = 'none';
    }
  }
}

export async function cancelOfferQR() {
  const entry = _activeOfferEntry();
  if (!entry) return;
  _trackEvent('offer_cancelled_qr');
  _removeOfferEntry(_currentOfferIdx, { deleteDoc: true });
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
        // Server-authoritative: the Worker reads discount type/amount/expiry
        // from ipear_offers/{offerId}. The fields below are legacy/no-ops kept
        // only for backward log compatibility; they are ignored server-side.
        offerId: o.id || '',
        offerTitle: o.title || '',
        discountType: discType,
        discountAmount: discAmt,
        singleUse: !!o.singleUse,
      })
    });
    const data = await res.json();
    if (!data.ok) {
      // Log the real backend error for debugging; NEVER surface internal
      // identifiers (e.g. 'endpoint-retired') verbatim in the UI.
      logger.warn('[offer-eshop] worker error:', data.error || data.reason || '(unknown)');
      const friendly = data.error === 'insufficient-points'
        ? 'Δεν φτάνουν οι πόντοι'
        : 'Η εφαρμογή χρειάζεται ανανέωση. Δοκιμάστε ξανά σε λίγα δευτερόλεπτα.';
      showToast('❌ ' + friendly, 'error');
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
    <button class="ro-close" data-action="_hideOverlay" data-arg="offer-qr-overlay" aria-label="Κλείσιμο">×</button>
    <div style="text-align:center;padding:24px 16px">
      <div style="font-size:3rem;margin-bottom:12px">🛒</div>
      <div style="font-size:1.1rem;font-weight:800;color:var(--bk);margin-bottom:4px">Το κουπόνι σου είναι έτοιμο!</div>
      <div style="font-size:.82rem;color:var(--grl);margin-bottom:20px">Έκπτωση ${discountLabel} στο e-shop</div>
      <div style="background:linear-gradient(135deg,#f0fff0,#e8ffe8);border:2.5px dashed var(--g);border-radius:14px;padding:18px;margin-bottom:16px">
        <div style="font-size:1.6rem;font-weight:900;letter-spacing:2px;color:var(--gd);font-family:monospace" id="eshop-coupon-code">${code.toUpperCase()}</div>
      </div>
      <button data-action="_copyEshopCoupon" style="padding:12px 24px;background:var(--g);color:#111;border:none;border-radius:12px;font-family:var(--font);font-weight:800;font-size:.9rem;cursor:pointer;margin-bottom:12px;min-height:44px">📋 Αντιγραφή κωδικού</button>
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
