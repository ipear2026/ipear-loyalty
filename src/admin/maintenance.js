import {
  getDb, collection, doc, getDocs, updateDoc, addDoc,
} from '../services/firebase.js';
import { tier, escHtml } from '../utils.js';
import { toast } from './ui.js';
import { authState } from './auth-state.js';

let _expireTargets = [];
let _downgradeTargets = [];

export async function previewExpirePoints() {
  const btn = document.getElementById('btn-expire-exec');
  const previewEl = document.getElementById('expire-preview');
  btn.style.display = 'none';
  previewEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--gray)">⏳ Ανάλυση...</div>';

  try {
    const db = getDb();
    const [csnap, tsnap] = await Promise.all([
      getDocs(collection(db, 'ipear_customers')),
      getDocs(collection(db, 'ipear_transactions')),
    ]);

    const lastTxDate = {};
    tsnap.forEach(d => {
      const tx = d.data();
      if (!tx.customerId || !tx.date) return;
      const dt = new Date(tx.date);
      if (!lastTxDate[tx.customerId] || dt > lastTxDate[tx.customerId])
        lastTxDate[tx.customerId] = dt;
    });

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);

    _expireTargets = [];
    csnap.forEach(d => {
      const c = { id: d.id, ...d.data() };
      if (!c.points || c.points <= 0) return;
      const last = lastTxDate[c.id] || (c.createdAt ? new Date(c.createdAt) : null);
      if (!last || last < cutoff) _expireTargets.push({ ...c, lastDate: last });
    });

    if (!_expireTargets.length) {
      previewEl.innerHTML = '<div style="background:var(--green-pale);border:1px solid var(--green);border-radius:9px;padding:14px;font-size:.85rem;text-align:center;color:#3a6e00">✅ Κανένας πελάτης δεν πληροί τα κριτήρια λήξης.</div>';
      return;
    }

    const totalPts = _expireTargets.reduce((s, c) => s + (c.points || 0), 0);
    let html = `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:9px;padding:10px 14px;font-size:.82rem;margin-bottom:10px;color:#856404">
      ⚠️ <strong>${_expireTargets.length}</strong> πελάτες — <strong>${totalPts.toLocaleString('el-GR')}</strong> πόντοι θα μηδενιστούν
    </div>
    <div style="overflow-x:auto"><table style="width:100%;font-size:.79rem;border-collapse:collapse">
      <thead><tr style="background:var(--green-pale);font-weight:700">
        <th style="padding:6px 8px;text-align:left">Πελάτης</th>
        <th style="padding:6px 8px;text-align:right">Πόντοι</th>
        <th style="padding:6px 8px;text-align:right">Τελ. Αγορά</th>
      </tr></thead><tbody>`;
    for (const c of _expireTargets.slice(0, 25)) {
      html += `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:5px 8px">${escHtml(c.name)} <span style="color:var(--gray);font-size:.75rem">${escHtml(c.card)}</span></td>
        <td style="padding:5px 8px;text-align:right;color:#dc3545;font-weight:700">${(c.points || 0).toLocaleString('el-GR')}</td>
        <td style="padding:5px 8px;text-align:right;color:var(--gray)">${c.lastDate ? c.lastDate.toLocaleDateString('el-GR') : 'Ποτέ'}</td>
      </tr>`;
    }
    if (_expireTargets.length > 25) html += `<tr><td colspan="3" style="text-align:center;padding:7px;color:var(--gray);font-size:.76rem">...και ${_expireTargets.length - 25} ακόμα</td></tr>`;
    html += '</tbody></table></div>';

    previewEl.innerHTML = html;
    btn.style.display = '';
  } catch (e) {
    previewEl.innerHTML = '';
    toast('❌ ' + e.message, 'error');
  }
}

export async function executeExpirePoints() {
  if (!_expireTargets.length) return;
  if (!confirm(`Μηδενισμός πόντων για ${_expireTargets.length} πελάτες;\nΑυτή η ενέργεια ΔΕΝ αναιρείται.`)) return;
  const btn = document.getElementById('btn-expire-exec');
  btn.textContent = '⏳ Εκτέλεση...';
  btn.disabled = true;

  let done = 0, failed = 0;
  try {
    const db = getDb();
    for (const c of _expireTargets) {
      try {
        await updateDoc(doc(db, 'ipear_customers', c.id), { points: 0 });
        await addDoc(collection(db, 'ipear_transactions'), {
          customerId: c.id, customerUid: c.uid || '', customerEmail: c.email || '', customerName: c.name, card: c.card,
          type: 'expire', points: -(c.points || 0), amount: 0,
          category: '⏳ Εκπνοή Πόντων',
          note: 'Μηδενισμός λόγω αδράνειας 12+ μηνών',
          storeId: authState.storeId || null, storeName: authState.storeName,
          date: new Date().toISOString(),
        });
        done++;
      } catch (_) { failed++; }
    }
  } finally {
    _expireTargets = [];
    btn.style.display = 'none';
    btn.disabled = false;
    btn.textContent = '🗑️ Εφαρμογή';
    document.getElementById('expire-preview').innerHTML = '';
  }
  toast(`✅ Εκπνοή: ${done} πελάτες μηδενίστηκαν${failed ? ' · ' + failed + ' σφάλματα' : ''}`, 'success');
}

// ── Tier Downgrade ──

export async function previewTierDowngrade() {
  const btn = document.getElementById('btn-downgrade-exec');
  const previewEl = document.getElementById('downgrade-preview');
  btn.style.display = 'none';
  previewEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--gray)">⏳ Ανάλυση...</div>';

  try {
    const db = getDb();
    const [csnap, tsnap] = await Promise.all([
      getDocs(collection(db, 'ipear_customers')),
      getDocs(collection(db, 'ipear_transactions')),
    ]);

    const thisYear = new Date().getFullYear();
    const activeThisYear = new Set();
    tsnap.forEach(d => {
      const tx = d.data();
      if (tx.customerId && tx.date && new Date(tx.date).getFullYear() === thisYear)
        activeThisYear.add(tx.customerId);
    });

    _downgradeTargets = [];
    csnap.forEach(d => {
      const c = { id: d.id, ...d.data() };
      if (activeThisYear.has(c.id)) return;
      const tot = c.totalPoints || c.points || 0;
      const t = tier(tot);
      if (t.name === 'Bronze') return;
      const newTot = t.name === 'Platinum' ? 9999 : t.name === 'Diamond' ? 5999 : t.name === 'Gold' ? 2999 : 999;
      _downgradeTargets.push({ ...c, currentTier: t, newTier: tier(newTot), newTot });
    });

    if (!_downgradeTargets.length) {
      previewEl.innerHTML = '<div style="background:var(--green-pale);border:1px solid var(--green);border-radius:9px;padding:14px;font-size:.85rem;text-align:center;color:#3a6e00">✅ Κανένας πελάτης δεν πληροί τα κριτήρια downgrade.</div>';
      return;
    }

    let html = `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:9px;padding:10px 14px;font-size:.82rem;margin-bottom:10px;color:#856404">
      ⚠️ <strong>${_downgradeTargets.length}</strong> πελάτες χωρίς αγορά το ${thisYear}
    </div>
    <div style="overflow-x:auto"><table style="width:100%;font-size:.79rem;border-collapse:collapse">
      <thead><tr style="background:var(--green-pale);font-weight:700">
        <th style="padding:6px 8px;text-align:left">Πελάτης</th>
        <th style="padding:6px 8px;text-align:center">Από</th>
        <th style="padding:6px 8px;text-align:center">→ Σε</th>
      </tr></thead><tbody>`;
    for (const c of _downgradeTargets.slice(0, 25)) {
      html += `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:5px 8px">${escHtml(c.name)} <span style="color:var(--gray);font-size:.75rem">${escHtml(c.card)}</span></td>
        <td style="padding:5px 8px;text-align:center">${c.currentTier.icon} ${escHtml(c.currentTier.name)}</td>
        <td style="padding:5px 8px;text-align:center;font-weight:700;color:#dc3545">${c.newTier.icon} ${escHtml(c.newTier.name)}</td>
      </tr>`;
    }
    if (_downgradeTargets.length > 25) html += `<tr><td colspan="3" style="text-align:center;padding:7px;color:var(--gray);font-size:.76rem">...και ${_downgradeTargets.length - 25} ακόμα</td></tr>`;
    html += '</tbody></table></div>';

    previewEl.innerHTML = html;
    btn.style.display = '';
  } catch (e) {
    previewEl.innerHTML = '';
    toast('❌ ' + e.message, 'error');
  }
}

export async function executeTierDowngrade() {
  if (!_downgradeTargets.length) return;
  if (!confirm(`Tier Downgrade για ${_downgradeTargets.length} πελάτες;\nΤα lifetime points τους θα μειωθούν. Αυτή η ενέργεια ΔΕΝ αναιρείται.`)) return;
  const btn = document.getElementById('btn-downgrade-exec');
  btn.textContent = '⏳ Εκτέλεση...';
  btn.disabled = true;

  let done = 0, failed = 0;
  try {
    const db = getDb();
    for (const c of _downgradeTargets) {
      try {
        await updateDoc(doc(db, 'ipear_customers', c.id), { totalPoints: c.newTot });
        await addDoc(collection(db, 'ipear_transactions'), {
          customerId: c.id, customerUid: c.uid || '', customerEmail: c.email || '', customerName: c.name, card: c.card,
          type: 'tier_downgrade',
          points: c.newTot - (c.totalPoints || 0),
          amount: 0,
          category: '📉 Tier Downgrade',
          note: `${c.currentTier.icon} ${c.currentTier.name} → ${c.newTier.icon} ${c.newTier.name} (αδράνεια ${new Date().getFullYear()})`,
          storeId: authState.storeId || null, storeName: authState.storeName,
          date: new Date().toISOString(),
        });
        done++;
      } catch (_) { failed++; }
    }
  } finally {
    _downgradeTargets = [];
    btn.style.display = 'none';
    btn.disabled = false;
    btn.textContent = '📉 Εφαρμογή';
    document.getElementById('downgrade-preview').innerHTML = '';
  }
  toast(`✅ Tier Downgrade: ${done} πελάτες ανανεώθηκαν${failed ? ' · ' + failed + ' σφάλματα' : ''}`, 'success');
}
