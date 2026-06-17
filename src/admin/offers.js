// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Offers CRUD + new-offer push notification flow
//  Renders the offers list, opens the create/edit modal (with image upload
//  + compression to base64 ≤900px / 0.78 quality), toggles active state,
//  and on new-offer creation prompts to broadcast a push via the Worker.
// ═══════════════════════════════════════════════════════════════════════════
import { escHtml, escJs } from '../utils.js';
import { toast, closeM } from './ui.js';
import { getWorkerSecret } from './worker-secret.js';
import { authState } from './auth-state.js';

const DB = () => window._db;

// ── Render list ────────────────────────────────────────────────────────────
export async function loadOffers() {
  if (!authState.authenticated) return;
  const db = DB();
  if (!db) return;
  const el = document.getElementById('offers-list');
  if (!el) return;
  el.innerHTML = '<div class="empty"><span class="e">⏳</span>Φόρτωση...</div>';
  try {
    const snap = await window._getDocs(window._col(db, 'ipear_offers'));
    if (snap.empty) {
      el.innerHTML =
        '<div class="empty"><span class="e">🎁</span>Δεν υπάρχουν προσφορές ακόμα.<br><small style="font-weight:500">Πάτα "Νέα Προσφορά" για να ξεκινήσεις.</small></div>';
      return;
    }
    let html = '';
    snap.forEach((d) => {
      const o = d.data();
      const start = o.startDate ? new Date(o.startDate).toLocaleDateString('el-GR') : '—';
      const end = o.endDate ? new Date(o.endDate).toLocaleDateString('el-GR') : '—';
      const safeImg =
        o.imageUrl && (o.imageUrl.startsWith('https://') || o.imageUrl.startsWith('data:image/'))
          ? o.imageUrl
          : '';
      html += `<div class="offer-card" style="${o.active ? '' : 'opacity:.55'}">
        ${
          safeImg
            ? `<div style="width:54px;height:54px;border-radius:11px;flex-shrink:0;background:url('${encodeURI(safeImg).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29')}') center/cover no-repeat"></div>`
            : `<div class="offer-emoji">${escHtml(o.emoji || '🎁')}</div>`
        }
        <div class="offer-body">
          <div class="offer-title">${escHtml(o.title || '—')}</div>
          <div class="offer-desc">${escHtml(o.description || '')}</div>
          <div class="offer-dates">📅 ${start} – ${end}${safeImg ? ' · 🖼️ Εικόνα' : ''}</div>
        </div>
        <div class="offer-actions">
          <div class="offer-toggle">
            <span>${o.active ? 'Ενεργή' : 'Ανενεργή'}</span>
            <div class="toggle-sw ${o.active ? 'on' : ''}" data-action="toggleOffer" data-arg="${escJs(d.id)}" data-arg2="${!!o.active}"></div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm btn-outline" data-action="openOfferEdit" data-arg="${escJs(d.id)}">✏️</button>
            <button class="btn btn-sm btn-red" data-action="deleteOffer" data-arg="${escJs(d.id)}">🗑</button>
          </div>
        </div>
      </div>`;
    });
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div class="empty">❌ ' + escHtml(e.message) + '</div>';
  }
}

// ── Image upload / compression ─────────────────────────────────────────────
let _offerPendingFile = null;

// Resize + compress image to JPEG base64 (max 900px wide, quality 0.78).
// Result is typically 50–200 KB — well within Firestore's 1 MB document limit.
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 900;
        let w = img.width;
        let h = img.height;
        if (w > MAX) {
          h = Math.round((h * MAX) / w);
          w = MAX;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.78));
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function previewOfferImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    toast('⚠️ Η εικόνα δεν πρέπει να ξεπερνά 10MB', 'error');
    return;
  }
  _offerPendingFile = file;
  const reader = new FileReader();
  reader.onload = (ev) => {
    document.getElementById('of-img-thumb').src = ev.target.result;
    document.getElementById('of-img-placeholder').style.display = 'none';
    document.getElementById('of-img-preview').style.display = 'block';
  };
  reader.readAsDataURL(file);
}

export function removeOfferImage(e) {
  if (e) e.stopPropagation();
  _offerPendingFile = null;
  document.getElementById('of-image').value = '';
  document.getElementById('of-image-file').value = '';
  document.getElementById('of-img-thumb').src = '';
  document.getElementById('of-img-placeholder').style.display = '';
  document.getElementById('of-img-preview').style.display = 'none';
}

function showExistingOfferImg(url) {
  if (url) {
    document.getElementById('of-img-thumb').src = url;
    document.getElementById('of-img-placeholder').style.display = 'none';
    document.getElementById('of-img-preview').style.display = 'block';
    document.getElementById('of-image').value = url;
  } else {
    removeOfferImage(null);
  }
}

// ── Modal: create / edit ───────────────────────────────────────────────────
export function openOfferModal() {
  document.getElementById('offer-modal-title').textContent = '🎁 Νέα Προσφορά';
  document.getElementById('offer-edit-id').value = '';
  document.getElementById('of-emoji').value = '🎁';
  document.getElementById('of-title').value = '';
  document.getElementById('of-desc').value = '';
  document.getElementById('of-start').value = new Date().toISOString().split('T')[0];
  document.getElementById('of-end').value = '';
  document.getElementById('of-points').value = '0';
  document.getElementById('of-eshop-type').value = 'percent';
  document.getElementById('of-eshop-amount').value = '0';
  document.getElementById('of-single').checked = false;
  document.getElementById('of-active').checked = true;
  removeOfferImage(null);
  document.getElementById('m-offer').classList.add('show');
}

export async function openOfferEdit(id) {
  const snap = await window._getDoc(window._doc(DB(), 'ipear_offers', id));
  if (!snap.exists()) return;
  const data = snap.data();
  document.getElementById('offer-modal-title').textContent = '✏️ Επεξεργασία Προσφοράς';
  document.getElementById('offer-edit-id').value = id;
  document.getElementById('of-emoji').value = data.emoji || '🎁';
  document.getElementById('of-title').value = data.title || '';
  document.getElementById('of-desc').value = data.description || '';
  document.getElementById('of-start').value = data.startDate || '';
  document.getElementById('of-end').value = data.endDate || '';
  document.getElementById('of-points').value = data.bonusPoints || 0;
  document.getElementById('of-eshop-type').value = data.eshopDiscountType || 'percent';
  document.getElementById('of-eshop-amount').value = data.eshopDiscountAmount || 0;
  document.getElementById('of-single').checked = !!data.singleUse;
  document.getElementById('of-active').checked = !!data.active;
  _offerPendingFile = null;
  showExistingOfferImg(data.imageUrl || '');
  document.getElementById('m-offer').classList.add('show');
}

// ── Save (create or update) ────────────────────────────────────────────────
export async function saveOffer() {
  const title = document.getElementById('of-title').value.trim();
  const desc = document.getElementById('of-desc').value.trim();
  if (!title || !desc) {
    toast('⚠️ Συμπλήρωσε τίτλο και περιγραφή!', 'error');
    return;
  }

  const btn = document.querySelector('#m-offer .btn-green');
  btn.disabled = true;
  btn.textContent = '⏳ Αποθήκευση...';

  try {
    let imageUrl = document.getElementById('of-image').value || '';
    if (_offerPendingFile) {
      btn.textContent = '⏳ Συμπίεση εικόνας...';
      imageUrl = await compressImage(_offerPendingFile);
      _offerPendingFile = null;
    }

    const eshopAmount = parseFloat(document.getElementById('of-eshop-amount').value) || 0;
    const data = {
      emoji: document.getElementById('of-emoji').value.trim() || '🎁',
      title,
      description: desc,
      startDate: document.getElementById('of-start').value,
      endDate: document.getElementById('of-end').value,
      bonusPoints: parseInt(document.getElementById('of-points').value) || 0,
      singleUse: document.getElementById('of-single').checked,
      active: document.getElementById('of-active').checked,
      eshopDiscountType: eshopAmount > 0 ? document.getElementById('of-eshop-type').value : '',
      eshopDiscountAmount: eshopAmount,
      imageUrl,
      updatedAt: new Date().toISOString(),
    };
    const editId = document.getElementById('offer-edit-id').value;
    const isNew = !editId;
    if (editId) {
      await window._updateDoc(window._doc(DB(), 'ipear_offers', editId), data);
      toast('✅ Η προσφορά ενημερώθηκε!', 'success');
    } else {
      data.createdAt = new Date().toISOString();
      await window._addDoc(window._col(DB(), 'ipear_offers'), data);
      toast('✅ Νέα προσφορά δημιουργήθηκε!', 'success');
    }
    closeM();
    loadOffers();

    // Offer is new + active → ask admin if they want to push-notify all customers
    if (isNew && data.active) {
      _pendingOfferPush = { title: data.title, desc: data.description, emoji: data.emoji || '🎁' };
      document.getElementById('offer-push-title').textContent = (data.emoji || '🎁') + ' ' + data.title;
      document.getElementById('offer-push-body').textContent = data.description;
      document.getElementById('offer-push-result').innerHTML = '';
      document.getElementById('offer-push-send-btn').disabled = false;
      document.getElementById('offer-push-send-btn').textContent = '🔔 Αποστολή';
      document.getElementById('m-offer-push').classList.add('show');
    }
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✅ Αποθήκευση';
  }
}

// ── Push notification for new offer ────────────────────────────────────────
let _pendingOfferPush = null;
let _offerPushBusy = false;

export async function sendOfferPush() {
  if (!_pendingOfferPush || _offerPushBusy) return;
  _offerPushBusy = true;
  const workerUrl = localStorage.getItem('ipear_worker_url');
  const secret = getWorkerSecret();
  if (!workerUrl || !secret) {
    toast('⚠️ Ορίστε πρώτα τον Worker URL στις Ειδοποιήσεις!', 'error');
    closeM();
    _offerPushBusy = false;
    return;
  }

  const btn = document.getElementById('offer-push-send-btn');
  const res = document.getElementById('offer-push-result');
  btn.disabled = true;
  btn.textContent = '⏳ Αποστολή...';
  res.innerHTML = '';

  try {
    const snap = await window._getDocs(window._col(DB(), 'ipear_customers'));
    const tokens = [];
    snap.forEach((d) => {
      const t = d.data().fcmToken;
      if (t) tokens.push(t);
    });

    if (!tokens.length) {
      res.innerHTML =
        '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:9px;padding:12px;font-size:.84rem;color:#856404">⚠️ Κανένας πελάτης δεν έχει ενεργοποιήσει notifications ακόμα.</div>';
      btn.disabled = false;
      btn.textContent = '🔔 Αποστολή';
      return;
    }

    const title = (_pendingOfferPush.emoji || '🎁') + ' ' + _pendingOfferPush.title;
    const message = _pendingOfferPush.desc;

    const pushUrl = workerUrl.replace(/\/$/, '') + '/push';
    const r = await fetch(pushUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens, title, message }),
    });
    const data = await r.json().catch(() => ({}));

    if (r.ok && data.success) {
      res.innerHTML = `<div style="background:var(--green-pale);border:1px solid var(--green);border-radius:9px;padding:12px;font-size:.84rem;color:#3a6e00">
        ✅ Push στάλθηκε σε <strong>${data.sent}</strong> συσκευές!
      </div>`;
      btn.textContent = '✅ Εστάλη!';
      setTimeout(closeM, 2000);
    } else {
      throw new Error(data.error || 'Worker error ' + r.status);
    }
  } catch (e) {
    res.innerHTML = `<div style="background:#f8d7da;border:1px solid #f5c2c7;border-radius:9px;padding:12px;font-size:.84rem;color:#842029">❌ ${escHtml(e.message)}</div>`;
    btn.disabled = false;
    btn.textContent = '🔔 Δοκίμασε ξανά';
  } finally {
    _pendingOfferPush = null;
    _offerPushBusy = false;
  }
}

// ── Toggle / delete ────────────────────────────────────────────────────────
let _toggleOfferBusy = false;
export async function toggleOffer(id, current) {
  if (_toggleOfferBusy) return;
  _toggleOfferBusy = true;
  const clickedBtn = event?.target?.closest?.('button');
  if (clickedBtn) clickedBtn.disabled = true;
  try {
    await window._updateDoc(window._doc(DB(), 'ipear_offers', id), { active: !current });
    loadOffers();
    toast(current ? '⏸ Απενεργοποιήθηκε' : '▶️ Ενεργοποιήθηκε', 'success');
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  } finally {
    _toggleOfferBusy = false;
    if (clickedBtn) clickedBtn.disabled = false;
  }
}

let _deleteOfferBusy = false;
export async function deleteOffer(id) {
  if (_deleteOfferBusy) return;
  if (!confirm('Διαγραφή προσφοράς;')) return;
  _deleteOfferBusy = true;
  const clickedBtn = event?.target?.closest?.('button');
  if (clickedBtn) clickedBtn.disabled = true;
  try {
    await window._deleteDoc(window._doc(DB(), 'ipear_offers', id));
    loadOffers();
    toast('🗑 Η προσφορά διαγράφηκε.', 'success');
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  } finally {
    _deleteOfferBusy = false;
    if (clickedBtn) clickedBtn.disabled = false;
  }
}
