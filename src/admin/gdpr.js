// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — GDPR Art.17 deletion-request queue
//
//  Extracted from src/admin-main.js during the Sprint 3 god-module split.
//  Owns:
//   • loadDeletionRequests — query ipear_customers where deletionRequested
//     is true, paint the queue list + update the sidebar badge count
//   • gdprDeleteCustomer   — adapter that swaps the selected customer scope
//     to the requested doc and delegates to admin-main.js's deleteCust()
//     (which performs the actual anonymisation + audit-log write)
//
//  Cross-domain hooks (configured via initGdpr):
//   • getCidCdata / setCidCdata — read/write the admin-main customer scope
//     so we can borrow + restore it around the deleteCust call
//   • deleteCust                — the actual deletion executor, owned by
//     admin-main.js (will move to customers-crud.js in a later commit)
// ═══════════════════════════════════════════════════════════════════════════
import { escHtml, escJs, friendlyError } from '../utils.js';
import { toast } from './ui.js';

const DB = () => window._db;

let _hooks = {
  getCidCdata: () => ({ cid: null, cdata: null }),
  setCidCdata: () => {},
  deleteCust: async () => {},
};

export function initGdpr(hooks) {
  _hooks = { ..._hooks, ...hooks };
}

export async function loadDeletionRequests() {
  const list = document.getElementById('gdpr-list');
  list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray)">⏳ Φόρτωση...</div>';
  try {
    const db = DB(); if (!db) throw new Error('Δεν υπάρχει σύνδεση');
    const snap = await window._getDocs(window._query(
      window._col(db, 'ipear_customers'),
      window._where('deletionRequested', '==', true)
    ));
    if (snap.empty) {
      list.innerHTML = '<div style="text-align:center;padding:28px;color:#888;font-size:.92rem">✅ Δεν υπάρχουν εκκρεμή αιτήματα διαγραφής.</div>';
      _updateGdprBadge(0);
      return;
    }
    _updateGdprBadge(snap.size);
    let html = '<div style="display:grid;gap:10px">';
    snap.forEach(d => {
      const c = d.data();
      const reqDate = c.deletionRequestedAt ? new Date(c.deletionRequestedAt).toLocaleDateString('el-GR') + ' ' + new Date(c.deletionRequestedAt).toLocaleTimeString('el-GR',{hour:'2-digit',minute:'2-digit'}) : '—';
      html += `<div style="display:flex;align-items:center;gap:14px;padding:16px;background:#fff8f8;border:1.5px solid #ffcdd2;border-radius:14px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:.95rem;margin-bottom:2px">${escHtml(c.name || '—')}</div>
          <div style="font-size:.82rem;color:#888">${escHtml(c.email || '')} · ${escHtml(c.phone || '')} · ${escHtml(c.card || '')}</div>
          <div style="font-size:.78rem;color:#bbb;margin-top:2px">Αίτημα: ${reqDate}</div>
        </div>
        <button class="btn" style="background:#dc3545;color:#fff;border-color:#dc3545;font-size:.82rem;padding:10px 16px;white-space:nowrap"
          data-action="gdprDeleteCustomer" data-arg="${escJs(d.id)}" data-arg2="${escJs(c.name || '')}">🗑 Διαγραφή</button>
      </div>`;
    });
    html += '</div>';
    list.innerHTML = html;
  } catch(e) { console.error('[gdpr] load failed:', e); list.innerHTML = '<div style="color:#c62828;padding:14px">❌ Σφάλμα: ' + friendlyError(e) + '</div>'; }
}

export async function gdprDeleteCustomer(docId, _name) {
  // Borrow admin-main's customer scope (cid/cdata) so deleteCust() operates
  // on the right doc. Restore the previous scope if the borrow stuck (the
  // typical case is deleteCust() clearing cid itself; if it threw before that,
  // we put the previous selection back so the search panel isn't left empty).
  const { cid: prevCid, cdata: prevCdata } = _hooks.getCidCdata();
  try {
    const db = DB();
    const doc = await window._getDoc(window._doc(db, 'ipear_customers', docId));
    if (!doc.exists()) { toast('⚠️ Ο πελάτης δεν βρέθηκε.', 'error'); loadDeletionRequests(); return; }
    _hooks.setCidCdata({ cid: docId, cdata: doc.data() });
    await _hooks.deleteCust();
    loadDeletionRequests();
  } catch(e) {
    toast('❌ ' + friendlyError(e), 'error');
  }
  const { cid } = _hooks.getCidCdata();
  if (!cid) _hooks.setCidCdata({ cid: prevCid, cdata: prevCdata });
}

function _updateGdprBadge(count) {
  const badge = document.getElementById('gdpr-badge');
  if (!badge) return;
  if (count > 0) { badge.style.display = ''; badge.textContent = count; }
  else { badge.style.display = 'none'; }
}
