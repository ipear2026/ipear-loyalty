// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Rewards CRUD (point-redeemable reward tiers)
//  Source-of-truth for the cost/title/icon shown to customers on the Home +
//  Rewards tab. The customer's startRedemption and the admin's confirmVerify
//  both validate against these docs, so frontend-only edits to cost/discount
//  are no longer possible once a row exists here.
//
//  Schema (ipear_rewards/{id}):
//    title       string
//    cost        number   — points debited from customer on redeem
//    icon        string   — emoji
//    description string
//    isActive    boolean
//    order       number   — ascending sort
//    discount    number   — € amount the cashier applies
//    createdAt   string
//    updatedAt   string
// ═══════════════════════════════════════════════════════════════════════════
import { escHtml, escJs } from '../utils.js';
import { toast, closeM } from './ui.js';

const DB = () => window._db;

// ── Render list ────────────────────────────────────────────────────────────
export async function loadRewards() {
  const db = DB();
  if (!db) return;
  const el = document.getElementById('rewards-list');
  if (!el) return;
  el.innerHTML = '<div class="empty"><span class="e">⏳</span>Φόρτωση...</div>';
  try {
    const snap = await window._getDocs(window._col(db, 'ipear_rewards'));
    if (snap.empty) {
      el.innerHTML =
        '<div class="empty"><span class="e">🎟️</span>Δεν υπάρχουν ανταμοιβές ακόμα.<br><small style="font-weight:500">Πάτα "Νέα Ανταμοιβή" για να ξεκινήσεις.</small></div>';
      return;
    }
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    rows.sort((a, b) => (a.order || 0) - (b.order || 0));
    let html = '';
    rows.forEach((r) => {
      html += `<div class="offer-card" style="${r.isActive ? '' : 'opacity:.55'}">
        <div class="offer-emoji">${escHtml(r.icon || '🎟️')}</div>
        <div class="offer-body">
          <div class="offer-title">${escHtml(r.title || '—')}</div>
          <div class="offer-desc">${escHtml(r.description || '')}</div>
          <div class="offer-dates">💰 ${Number(r.cost) || 0} πόντοι · 💶 ${Number(r.discount) || 0}€ έκπτωση · #${Number(r.order) || 0}</div>
        </div>
        <div class="offer-actions">
          <div class="offer-toggle">
            <span>${r.isActive ? 'Ενεργή' : 'Ανενεργή'}</span>
            <div class="toggle-sw ${r.isActive ? 'on' : ''}" data-action="toggleReward" data-arg="${escJs(r.id)}" data-arg2="${!!r.isActive}"></div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm btn-outline" data-action="openRewardEdit" data-arg="${escJs(r.id)}">✏️</button>
            <button class="btn btn-sm btn-red" data-action="deleteReward" data-arg="${escJs(r.id)}">🗑</button>
          </div>
        </div>
      </div>`;
    });
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div class="empty">❌ ' + escHtml(e.message) + '</div>';
  }
}

// ── Modal: create / edit ───────────────────────────────────────────────────
export function openRewardModal() {
  document.getElementById('reward-modal-title').textContent = '🎟️ Νέα Ανταμοιβή';
  document.getElementById('reward-edit-id').value = '';
  document.getElementById('rw-icon').value = '🎟️';
  document.getElementById('rw-title').value = '';
  document.getElementById('rw-desc').value = '';
  document.getElementById('rw-cost').value = '1000';
  document.getElementById('rw-discount').value = '5';
  document.getElementById('rw-order').value = '0';
  document.getElementById('rw-active').checked = true;
  document.getElementById('m-reward').classList.add('show');
}

export async function openRewardEdit(id) {
  const snap = await window._getDoc(window._doc(DB(), 'ipear_rewards', id));
  if (!snap.exists()) return;
  const data = snap.data();
  document.getElementById('reward-modal-title').textContent = '✏️ Επεξεργασία Ανταμοιβής';
  document.getElementById('reward-edit-id').value = id;
  document.getElementById('rw-icon').value = data.icon || '🎟️';
  document.getElementById('rw-title').value = data.title || '';
  document.getElementById('rw-desc').value = data.description || '';
  document.getElementById('rw-cost').value = Number(data.cost) || 0;
  document.getElementById('rw-discount').value = Number(data.discount) || 0;
  document.getElementById('rw-order').value = Number(data.order) || 0;
  document.getElementById('rw-active').checked = !!data.isActive;
  document.getElementById('m-reward').classList.add('show');
}

// ── Save (create or update) ────────────────────────────────────────────────
export async function saveReward() {
  const title = document.getElementById('rw-title').value.trim();
  const cost = parseInt(document.getElementById('rw-cost').value, 10);
  const discount = parseFloat(document.getElementById('rw-discount').value);

  if (!title) {
    toast('⚠️ Συμπλήρωσε τίτλο!', 'error');
    return;
  }
  if (!Number.isInteger(cost) || cost <= 0) {
    toast('⚠️ Το κόστος πρέπει να είναι θετικός ακέραιος.', 'error');
    return;
  }
  if (!Number.isFinite(discount) || discount < 0) {
    toast('⚠️ Η έκπτωση πρέπει να είναι θετικός αριθμός.', 'error');
    return;
  }
  // Firestore rules accept either the dynamic-catalog path OR the legacy
  // fixed ladder (1000→5, 2500→15, 4000→30). Warn the admin if they pick a
  // pair that's neither on the ladder NOR matches what will be saved —
  // server-side `ipear_redemptions` writes will be rejected otherwise once
  // the customer app starts sending rewardId.
  // (No hard block: the dynamic path will succeed because cost/discount are
  // read from this doc inside the rule.)

  const btn = document.querySelector('#m-reward .btn-green');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Αποθήκευση...';
  }

  try {
    const data = {
      icon: document.getElementById('rw-icon').value.trim() || '🎟️',
      title,
      description: document.getElementById('rw-desc').value.trim() || '',
      cost,
      discount,
      order: parseInt(document.getElementById('rw-order').value, 10) || 0,
      isActive: document.getElementById('rw-active').checked,
      updatedAt: new Date().toISOString(),
    };
    const editId = document.getElementById('reward-edit-id').value;
    if (editId) {
      await window._updateDoc(window._doc(DB(), 'ipear_rewards', editId), data);
      toast('✅ Η ανταμοιβή ενημερώθηκε!', 'success');
    } else {
      data.createdAt = new Date().toISOString();
      await window._addDoc(window._col(DB(), 'ipear_rewards'), data);
      toast('✅ Νέα ανταμοιβή δημιουργήθηκε!', 'success');
    }
    closeM();
    loadRewards();
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '✅ Αποθήκευση';
    }
  }
}

// ── Toggle isActive ────────────────────────────────────────────────────────
let _toggleRewardBusy = false;
export async function toggleReward(id, current) {
  if (_toggleRewardBusy) return;
  _toggleRewardBusy = true;
  const clickedBtn = event?.target?.closest?.('button');
  if (clickedBtn) clickedBtn.disabled = true;
  try {
    await window._updateDoc(window._doc(DB(), 'ipear_rewards', id), { isActive: !current });
    loadRewards();
    toast(current ? '⏸ Απενεργοποιήθηκε' : '▶️ Ενεργοποιήθηκε', 'success');
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  } finally {
    _toggleRewardBusy = false;
    if (clickedBtn) clickedBtn.disabled = false;
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────
let _deleteRewardBusy = false;
export async function deleteReward(id) {
  if (_deleteRewardBusy) return;
  if (!confirm('Διαγραφή ανταμοιβής;')) return;
  _deleteRewardBusy = true;
  const clickedBtn = event?.target?.closest?.('button');
  if (clickedBtn) clickedBtn.disabled = true;
  try {
    await window._deleteDoc(window._doc(DB(), 'ipear_rewards', id));
    loadRewards();
    toast('🗑 Η ανταμοιβή διαγράφηκε.', 'success');
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  } finally {
    _deleteRewardBusy = false;
    if (clickedBtn) clickedBtn.disabled = false;
  }
}
