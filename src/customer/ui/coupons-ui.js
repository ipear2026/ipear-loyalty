// ───────────────────────────────────────────────────────────────────────────
//  ΤΑ ΚΟΥΠΟΝΙΑ ΜΟΥ — read-only "My Coupons" view.
//  Lets a customer find previously-created e-shop coupons (reward + offer)
//  again after closing the redemption modal or returning later.
//
//  INVARIANT (structural, not just by convention): this view ONLY READS the
//  authenticated customer's own ipear_offer_redemptions docs
//  (customerId == auth.uid — permitted by the Firestore rules). It makes NO
//  Worker call and never touches a mint/charge code path, so opening or
//  reloading it creates ZERO coupons, deducts ZERO points, and writes ZERO
//  ledger rows. Status comes from the server-authoritative doc fields
//  (used / status / expiresAt) written by the Worker — never inferred/minted
//  here, and never a client guess over a server value.
// ───────────────────────────────────────────────────────────────────────────
import { logger } from '../../logger.js';
import { showToast } from '../../utils.js';

const ESHOP_URL = 'https://ipear.gr';

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Server-authoritative status. `used`/`status` are Worker-written; `expiresAt`
// is the coupon deadline. We never trust a client guess over these.
function _couponStatus(d, nowMs) {
  if (d.used === true || d.status === 'used') return 'used';
  const exp = d.expiresAt ? Date.parse(d.expiresAt) : NaN;
  if (Number.isFinite(exp) && nowMs > exp) return 'expired';
  if (d.status === 'creating') return 'pending'; // in-flight; no coupon code yet
  return 'active';
}

function _couponValue(d) {
  if (d.discountAmount != null && Number(d.discountAmount) > 0) return Number(d.discountAmount) + '€';
  if (d.discount != null && Number(d.discount) > 0) return Number(d.discount) + '€';
  if (d.bonusPoints != null && Number(d.bonusPoints) > 0) return '+' + Number(d.bonusPoints) + ' πόντοι';
  return '';
}
function _couponTitle(d) { return d.rewardTitle || d.offerTitle || d.label || 'Κουπόνι e-shop'; }
function _fmtDate(iso) { try { return iso ? new Date(iso).toLocaleDateString('el-GR') : ''; } catch (_) { return ''; } }

// Copy helper for inline onclick (string is escaped at render time).
window._copyMyCoupon = function (code) {
  const c = String(code || '');
  if (!c) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(c).then(() => showToast('✅ Αντιγράφηκε: ' + c)).catch(() => showToast('Κωδικός: ' + c));
  } else { showToast('Κωδικός: ' + c); }
};

function _couponCard(d, status) {
  const code = _esc(String(d.code || '').toUpperCase());
  const val = _esc(_couponValue(d));
  const title = _esc(_couponTitle(d));
  const exp = _fmtDate(d.expiresAt);
  const badge = status === 'active'
    ? '<span style="background:#e8ffe8;color:#1a7a1a;border-radius:8px;padding:3px 10px;font-size:.72rem;font-weight:800">Ενεργό</span>'
    : status === 'used'
      ? '<span style="background:#eee;color:#777;border-radius:8px;padding:3px 10px;font-size:.72rem;font-weight:800">Χρησιμοποιήθηκε</span>'
      : '<span style="background:#fdeaea;color:#b23;border-radius:8px;padding:3px 10px;font-size:.72rem;font-weight:800">Έληξε</span>';
  const codeBlock = status === 'active'
    ? `<div style="background:linear-gradient(135deg,#f0fff0,#e8ffe8);border:2px dashed var(--g,#b7e33b);border-radius:12px;padding:12px;margin:8px 0;text-align:center">
         <div style="font-size:1.25rem;font-weight:900;letter-spacing:1.5px;color:var(--gd,#2a7);font-family:monospace">${code}</div>
       </div>
       <div style="display:flex;gap:8px">
         <button type="button" onclick="window._copyMyCoupon('${code}')" style="flex:1;padding:10px;background:var(--g,#b7e33b);color:#111;border:none;border-radius:10px;font-weight:800;font-size:.84rem;cursor:pointer;min-height:44px">📋 Αντιγραφή</button>
         <a href="${ESHOP_URL}" target="_blank" rel="noopener" style="flex:1;padding:10px;background:#111;color:#fff;border-radius:10px;font-weight:800;font-size:.84rem;text-align:center;text-decoration:none;min-height:44px;display:flex;align-items:center;justify-content:center">Χρήση στο ipear.gr →</a>
       </div>`
    : `<div style="font-family:monospace;font-size:.95rem;color:#999;letter-spacing:1px;margin:6px 0;text-decoration:${status === 'used' ? 'line-through' : 'none'}">${code}</div>`;
  return `<div style="background:var(--card,#fff);border:1px solid #eee;border-radius:14px;padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div style="font-weight:800;font-size:.92rem;color:var(--bk,#111)">${title}${val ? ' · ' + val : ''}</div>
        ${badge}
      </div>
      ${codeBlock}
      ${exp ? `<div style="font-size:.74rem;color:var(--grl,#888);margin-top:8px">${status === 'expired' ? 'Έληξε' : 'Ισχύει έως'} ${_esc(exp)}</div>` : ''}
    </div>`;
}

// Opens the read-only "My Coupons" overlay. Safe to call repeatedly.
export async function openMyCoupons() {
  const uid = window._auth && window._auth.currentUser && window._auth.currentUser.uid;
  if (!uid) { showToast('⚠️ Συνδέσου ξανά', 'red'); return; }

  document.getElementById('mycoupons-overlay')?.remove();
  const ov = document.createElement('div');
  ov.id = 'mycoupons-overlay';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Τα κουπόνια μου');
  ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:var(--bg,#fafafa);overflow-y:auto';
  ov.innerHTML = `
    <div style="max-width:520px;margin:0 auto;padding:18px 16px 48px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <button type="button" onclick="document.getElementById('mycoupons-overlay').remove()" aria-label="Κλείσιμο" style="background:none;border:none;font-size:1.6rem;cursor:pointer;color:var(--bk,#111);min-height:44px;min-width:44px">←</button>
        <div style="font-size:1.2rem;font-weight:900;color:var(--bk,#111)">🎟️ Τα Κουπόνια Μου</div>
      </div>
      <div id="mycoupons-body"><div style="text-align:center;padding:40px;color:var(--grl,#888)">Φόρτωση…</div></div>
    </div>`;
  document.body.appendChild(ov);

  const body = ov.querySelector('#mycoupons-body');
  try {
    const col = window._col(window._db, 'ipear_offer_redemptions');
    // Equality-only query (no composite index needed); sort client-side.
    const snap = await window._getDocs(window._query(col, window._where('customerId', '==', uid)));
    const nowMs = Date.now();
    const active = [], history = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      if (!d.code) return;                 // no minted code yet → nothing to show
      const st = _couponStatus(d, nowMs);
      if (st === 'pending') return;
      (st === 'active' ? active : history).push({ d, st, _ts: Date.parse(d.createdAt || '') || 0 });
    });
    active.sort((a, b) => b._ts - a._ts);
    history.sort((a, b) => b._ts - a._ts);

    const sec = (title, items, empty) =>
      `<div style="font-size:.8rem;font-weight:800;color:var(--grl,#888);text-transform:uppercase;letter-spacing:.5px;margin:18px 0 10px">${title}</div>` +
      (items.length ? items.map(x => _couponCard(x.d, x.st)).join('')
        : `<div style="text-align:center;padding:18px;color:var(--grl,#aaa);font-size:.85rem">${empty}</div>`);

    body.innerHTML =
      sec('Ενεργά', active, 'Δεν έχεις ενεργά κουπόνια.') +
      sec('Ιστορικό', history, 'Δεν υπάρχει ιστορικό κουπονιών.');
  } catch (e) {
    logger.warn('[my-coupons]', e.code || e.message);
    body.innerHTML = '<div style="text-align:center;padding:30px;color:#b23">❌ Δεν ήταν δυνατή η φόρτωση. Δοκίμασε ξανά.</div>';
  }
}

window.openMyCoupons = openMyCoupons;
