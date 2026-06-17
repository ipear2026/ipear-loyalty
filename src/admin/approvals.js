// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Offer Approvals (real-time queue + approve/reject)
//
//  Listens to ipear_offer_redemptions where status == 'pending_approval' and
//  renders a live queue card. Approving an offer runs an atomic Firestore
//  transaction (reads first, writes after) and credits bonus points using
//  the OFFER doc's bonusPoints as the trusted source — the redemption doc
//  is user-created and not authoritative.
// ═══════════════════════════════════════════════════════════════════════════
import { escHtml, escJs } from '../utils.js';
import { logger } from '../logger.js';
import { toast } from './ui.js';

const DB = () => window._db;

let _ctx = {
  getStoreContext: () => ({ storeId: null, storeName: '—' }),
  refreshAdminViews: () => {},
};

export function initApprovals(config) {
  _ctx = { ..._ctx, ...config };
}

// ── Real-time listener for pending approvals ──────────────────────────────
let _approvalUnsub = null;

export function startApprovalListener() {
  if (_approvalUnsub) return;
  const db = DB();
  _approvalUnsub = window._onSnapshot(
    window._query(
      window._col(db, 'ipear_offer_redemptions'),
      window._where('status', '==', 'pending_approval')
    ),
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      renderApprovals(list);

      const badge = document.getElementById('approvals-badge');
      if (badge) {
        if (list.length > 0) {
          badge.style.display = 'inline-block';
          badge.textContent = list.length;
          try {
            new Audio('data:audio/wav;base64,UklGRl9vT19telefonismos...').play();
          } catch {
            /* autoplay-blocked or no audio context — ignore */
          }
        } else {
          badge.style.display = 'none';
        }
      }

      const btn = document.getElementById('tab-btn-approvals');
      if (btn) btn.style.animation = list.length > 0 ? 'pulse 1s infinite' : '';
    },
    (err) => logger.error('[approvals] listener error:', err)
  );
}

export function stopApprovalListener() {
  if (_approvalUnsub) {
    try {
      _approvalUnsub();
    } catch {
      /* ignore */
    }
    _approvalUnsub = null;
  }
}

function renderApprovals(items) {
  const el = document.getElementById('approvals-list');
  if (!el) return;
  if (items.length === 0) {
    el.innerHTML = '<div class="empty"><span class="e">✅</span>Δεν υπάρχουν εκκρεμείς εγκρίσεις</div>';
    return;
  }
  el.innerHTML = items
    .map((r) => {
      const bp = Number(r.bonusPoints) || Number(r.pointsCost) || 0;
      const ago = Math.round((Date.now() - new Date(r.tabletRequestedAt || r.createdAt).getTime()) / 1000);
      const agoStr = ago < 60 ? ago + ' δευτ.' : Math.round(ago / 60) + ' λεπτά';
      return `<div style="background:linear-gradient(135deg,#0f1f00,#1a3300);border:1.5px solid #8ae900;border-radius:14px;padding:18px;margin-bottom:12px;display:flex;align-items:center;gap:16px;animation:fadeScale .3s ease-out">
      <div style="font-size:2.2rem;flex-shrink:0">🎁</div>
      <div style="flex:1">
        <div style="color:#8ae900;font-weight:900;font-size:1.05rem;margin-bottom:3px">${escHtml(r.offerTitle || 'Προσφορά')}</div>
        <div style="color:#fff;font-size:.88rem;margin-bottom:2px">👤 ${escHtml(r.customerName || '—')} ${r.card ? '(' + escHtml(r.card) + ')' : ''}</div>
        <div style="color:#aaa;font-size:.78rem">${bp > 0 ? '+' + bp + ' πόντοι • ' : ''}${r.tabletStoreName ? '📍 ' + escHtml(r.tabletStoreName) + ' • ' : ''}πριν ${agoStr}</div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button onclick="approveOffer('${escJs(r.id)}')" style="padding:12px 20px;background:#8ae900;color:#0a0a0a;border:none;border-radius:10px;font-weight:800;font-size:.88rem;cursor:pointer;font-family:inherit">✅ Έγκριση</button>
        <button onclick="rejectOffer('${escJs(r.id)}')" style="padding:12px 16px;background:rgba(255,59,48,.15);color:#ff3b30;border:1px solid #ff3b30;border-radius:10px;font-weight:700;font-size:.88rem;cursor:pointer;font-family:inherit">✕</button>
      </div>
    </div>`;
    })
    .join('');
}

// ── Approve (atomic txn) ───────────────────────────────────────────────────
let _approveOfferBusy = false;

export async function approveOffer(redemptionId) {
  if (_approveOfferBusy) return;
  _approveOfferBusy = true;
  const clickedBtn = event?.target?.closest?.('button');
  if (clickedBtn) {
    clickedBtn.disabled = true;
    clickedBtn.textContent = '⏳';
  }
  const db = DB();
  try {
    let found;
    let custDocId;
    let bonus = 0;

    await window._runTransaction(db, async (txn) => {
      // ── ALL READS FIRST ──
      const redRef = window._doc(db, 'ipear_offer_redemptions', redemptionId);
      const redSnap = await txn.get(redRef);
      if (!redSnap.exists()) throw new Error('Δεν βρέθηκε.');
      found = redSnap.data();
      if (found.used) throw new Error('Ήδη χρησιμοποιημένος.');

      // SECURITY: bonus from OFFER DOC (trusted), not redemption doc.
      const offerId = found.offerId;
      let offerBonus = 0;
      if (offerId) {
        const offersSnap = await window._getDocs(
          window._query(window._col(db, 'ipear_offers'), window._where('active', '==', true))
        );
        offersSnap.forEach((d) => {
          if (d.id === offerId || d.data().title === offerId) {
            offerBonus = Number(d.data().bonusPoints) || Number(d.data().pointsCost) || 0;
          }
        });
      }

      custDocId = found.customerId;
      let custRef = window._doc(db, 'ipear_customers', custDocId);
      let custSnap = await txn.get(custRef);
      if (!custSnap.exists() && found.customerDocId && found.customerDocId !== custDocId) {
        custDocId = found.customerDocId;
        custRef = window._doc(db, 'ipear_customers', custDocId);
        custSnap = await txn.get(custRef);
      }
      if (!custSnap.exists()) throw new Error('Πελάτης δεν βρέθηκε.');
      const cust = custSnap.data();
      if (cust.blocked) throw new Error('Ο πελάτης είναι blocked.');
      bonus = offerBonus;
      const newPts = (cust.points || 0) + bonus;
      const newTot = (cust.totalPoints || 0) + bonus;

      // ── ALL WRITES AFTER ──
      txn.update(redRef, {
        used: true,
        status: 'approved',
        usedAt: new Date().toISOString(),
        approvedBy: 'admin',
      });
      if (bonus > 0) txn.update(custRef, { points: newPts, totalPoints: newTot });
    });

    if (bonus > 0) {
      const { storeId, storeName } = _ctx.getStoreContext();
      await window._addDoc(window._col(db, 'ipear_transactions'), {
        customerId: custDocId,
        customerUid: found.customerId || '',
        customerEmail: found.customerEmail || '',
        customerName: found.customerName,
        card: found.card || '',
        type: 'add',
        points: bonus,
        category: '🎁 Προσφορά: ' + (found.offerTitle || ''),
        note: 'Offer approved via admin',
        storeId: storeId || null,
        storeName,
        date: new Date().toISOString(),
      });
    }
    toast('✅ Εγκρίθηκε! ' + (found.offerTitle || '') + (bonus > 0 ? ' — +' + bonus + ' πόντοι' : ''), 'success');
    _ctx.refreshAdminViews();
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  } finally {
    if (clickedBtn) {
      clickedBtn.disabled = false;
      clickedBtn.textContent = '✅ Έγκριση';
    }
    _approveOfferBusy = false;
  }
}

// ── Reject ─────────────────────────────────────────────────────────────────
let _rejectOfferBusy = false;

export async function rejectOffer(redemptionId) {
  if (_rejectOfferBusy) return;
  _rejectOfferBusy = true;
  const clickedBtn = event?.target?.closest?.('button');
  if (clickedBtn) clickedBtn.disabled = true;
  try {
    await window._updateDoc(window._doc(DB(), 'ipear_offer_redemptions', redemptionId), {
      status: 'rejected',
      rejectedAt: new Date().toISOString(),
      rejectedBy: 'admin',
    });
    toast('❌ Προσφορά απορρίφθηκε.', 'error');
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  } finally {
    _rejectOfferBusy = false;
    if (clickedBtn) clickedBtn.disabled = false;
  }
}
