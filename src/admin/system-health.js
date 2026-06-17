import {
  getDb, collection, doc, query, where, getDocs, deleteDoc,
} from '../services/firebase.js';
import { escHtml } from '../utils.js';
import { toast } from './ui.js';

// Callback invoked when a delete operation alters customer/transaction set.
// admin-main wires this to its loadStats() so KPIs refresh.
let _onDataChanged = () => {};

export function configureSystemHealth({ onDataChanged } = {}) {
  if (typeof onDataChanged === 'function') _onDataChanged = onDataChanged;
}

// ── Orphan Cleanup Scanner ──
export async function scanOrphans() {
  const el = document.getElementById('orphan-results');
  el.innerHTML = '<div style="text-align:center;padding:14px;color:var(--gray)">⏳ Σάρωση βάσης...</div>';
  try {
    const db = getDb();
    const [csnap, tsnap] = await Promise.all([
      getDocs(collection(db, 'ipear_customers')),
      getDocs(collection(db, 'ipear_transactions')),
    ]);
    const customerIds = new Set();
    csnap.forEach(d => customerIds.add(d.id));

    const orphanTxs = [];
    const txCustomerIds = new Set();
    tsnap.forEach(d => {
      const tx = d.data();
      if (tx.customerId) txCustomerIds.add(tx.customerId);
      if (tx.customerId && !customerIds.has(tx.customerId)) {
        orphanTxs.push({ id: d.id, customerId: tx.customerId, name: tx.customerName || '—', type: tx.type, date: tx.date });
      }
    });

    const ghostCustomers = [];
    csnap.forEach(d => {
      if (!txCustomerIds.has(d.id)) {
        const cd = d.data();
        ghostCustomers.push({ id: d.id, name: cd.name || '—', card: cd.card || '', phone: cd.phone || '', created: cd.createdAt || '' });
      }
    });

    const orphanGroups = {};
    orphanTxs.forEach(tx => {
      if (!orphanGroups[tx.customerId]) orphanGroups[tx.customerId] = { name: tx.name, txs: [] };
      orphanGroups[tx.customerId].txs.push(tx);
    });

    let html = '';
    if (Object.keys(orphanGroups).length === 0 && ghostCustomers.length === 0) {
      html = '<div style="text-align:center;padding:18px;color:var(--green);font-weight:700;font-size:1rem">✅ Η βάση είναι καθαρή — δεν βρέθηκαν ορφανά!</div>';
    } else {
      if (Object.keys(orphanGroups).length > 0) {
        html += '<div style="margin-bottom:14px"><div style="font-weight:700;color:#e53935;margin-bottom:8px">⚠️ ' + orphanTxs.length + ' ορφανές συναλλαγές (' + Object.keys(orphanGroups).length + ' διαγραμμένοι πελάτες)</div>';
        html += '<table style="width:100%;border-collapse:collapse;font-size:.82rem"><thead><tr style="border-bottom:2px solid var(--border)">';
        html += '<th style="text-align:left;padding:6px 10px;color:var(--gray)">Πελάτης</th>';
        html += '<th style="text-align:right;padding:6px 10px;color:var(--gray)">Συν/γές</th>';
        html += '<th style="text-align:center;padding:6px 10px;color:var(--gray)">Ενέργεια</th></tr></thead><tbody>';
        for (const [cid, grp] of Object.entries(orphanGroups)) {
          html += '<tr style="border-bottom:1px solid var(--border)">';
          html += '<td style="padding:8px 10px"><strong>' + escHtml(grp.name) + '</strong><div style="font-size:.72rem;color:var(--gray)">ID: ' + escHtml(cid.substring(0, 12)) + '...</div></td>';
          html += '<td style="text-align:right;padding:8px 10px">' + grp.txs.length + '</td>';
          html += '<td style="text-align:center;padding:8px 10px"><button class="btn btn-sm" style="background:#e53935;color:#fff;font-size:.72rem" data-action="_deleteOrphanTxs" data-arg="' + escHtml(cid) + '">🗑️ Διαγραφή</button></td>';
          html += '</tr>';
        }
        html += '</tbody></table></div>';
      }

      if (ghostCustomers.length > 0) {
        html += '<div><div style="font-weight:700;color:#f57c00;margin-bottom:8px">👻 ' + ghostCustomers.length + ' πελάτες χωρίς καμία συναλλαγή</div>';
        html += '<table style="width:100%;border-collapse:collapse;font-size:.82rem"><thead><tr style="border-bottom:2px solid var(--border)">';
        html += '<th style="text-align:left;padding:6px 10px;color:var(--gray)">Όνομα</th>';
        html += '<th style="text-align:left;padding:6px 10px;color:var(--gray)">Κάρτα</th>';
        html += '<th style="text-align:left;padding:6px 10px;color:var(--gray)">Εγγραφή</th>';
        html += '<th style="text-align:center;padding:6px 10px;color:var(--gray)">Ενέργεια</th></tr></thead><tbody>';
        ghostCustomers.forEach(c => {
          const created = c.created ? new Date(c.created).toLocaleDateString('el-GR') : '—';
          html += '<tr style="border-bottom:1px solid var(--border)">';
          html += '<td style="padding:8px 10px"><strong>' + escHtml(c.name) + '</strong><div style="font-size:.72rem;color:var(--gray)">' + escHtml(c.phone) + '</div></td>';
          html += '<td style="padding:8px 10px;font-size:.8rem">' + escHtml(c.card) + '</td>';
          html += '<td style="padding:8px 10px;font-size:.8rem;color:var(--gray)">' + created + '</td>';
          html += '<td style="text-align:center;padding:8px 10px"><button class="btn btn-sm" style="background:#f57c00;color:#fff;font-size:.72rem" data-action="_deleteGhostCustomer" data-arg="' + escHtml(c.id) + '" data-arg2="' + escHtml(c.name) + '">🗑️ Διαγραφή</button></td>';
          html += '</tr>';
        });
        html += '</tbody></table></div>';
      }
    }
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div style="color:#e53935;padding:10px">❌ ' + escHtml(e.message) + '</div>';
  }
}

export async function deleteOrphanTxs(customerId) {
  if (!confirm('Θα διαγραφούν ΟΛΕΣ οι συναλλαγές αυτού του πελάτη. Συνέχεια;')) return;
  try {
    const db = getDb();
    const q = query(collection(db, 'ipear_transactions'), where('customerId', '==', customerId));
    const snap = await getDocs(q);
    let count = 0;
    for (const d of snap.docs || []) { await deleteDoc(d.ref); count++; }
    if (!count) {
      const fallbackDocs = [];
      snap.forEach(d => fallbackDocs.push(d));
      for (const d of fallbackDocs) { await deleteDoc(doc(db, 'ipear_transactions', d.id)); count++; }
    }
    toast('✅ Διαγράφηκαν ' + count + ' ορφανές συναλλαγές', 'success');
    scanOrphans();
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  }
}

export async function deleteGhostCustomer(id, name) {
  if (!confirm('Θα διαγραφεί ο πελάτης «' + name + '» (χωρίς συναλλαγές). Συνέχεια;')) return;
  try {
    const db = getDb();
    await deleteDoc(doc(db, 'ipear_customers', id));
    toast('✅ Διαγράφηκε: ' + name, 'success');
    scanOrphans();
    _onDataChanged();
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  }
}

// ── Full System Health Check ──
export async function runSystemHealthCheck() {
  const el = document.getElementById('health-results');
  el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray)"><div style="font-size:2rem;margin-bottom:8px">⏳</div>Εκτέλεση ελέγχου...</div>';

  const checks = [];
  function pass(label, detail) { checks.push({ status: 'pass', label, detail }); }
  function warn(label, detail) { checks.push({ status: 'warn', label, detail }); }
  function fail(label, detail) { checks.push({ status: 'fail', label, detail }); }

  // 1. Firebase Connection
  try {
    const db = getDb();
    const testSnap = await getDocs(collection(db, 'ipear_customers'));
    pass('🔥 Firebase Firestore', 'Σύνδεση OK — ' + testSnap.size + ' πελάτες');
  } catch (e) {
    fail('🔥 Firebase Firestore', e.message);
  }

  // 2. Worker Health
  const workerUrl = (localStorage.getItem('ipear_worker_url') || '').replace(/\/$/, '');
  if (!workerUrl) {
    warn('⚙️ Cloudflare Worker', 'Δεν έχει ρυθμιστεί Worker URL');
  } else {
    try {
      const r = await fetch(workerUrl + '/health', { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const d = await r.json();
        const brevo = d.brevo ? '✅' : '❌';
        const fcm = d.fcm ? '✅' : '❌';
        pass('⚙️ Cloudflare Worker', 'Online — Brevo: ' + brevo + ' FCM: ' + fcm);
      } else {
        fail('⚙️ Cloudflare Worker', 'HTTP ' + r.status);
      }
    } catch (e) {
      fail('⚙️ Cloudflare Worker', 'Unreachable — ' + e.message);
    }
  }

  // 3. Service Worker
  if ('serviceWorker' in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      if (regs.length) {
        pass('📦 Service Workers', regs.length + ' registered — scope: ' + regs.map(r => r.scope.split('/').pop() || '/').join(', '));
      } else {
        warn('📦 Service Workers', 'Κανένας SW εγγεγραμμένος');
      }
    } catch (e) {
      warn('📦 Service Workers', e.message);
    }
  } else {
    warn('📦 Service Workers', 'Δεν υποστηρίζεται');
  }

  // 4. Database Integrity
  try {
    const db = getDb();
    const [csnap, tsnap] = await Promise.all([
      getDocs(collection(db, 'ipear_customers')),
      getDocs(collection(db, 'ipear_transactions')),
    ]);
    const custIds = new Set();
    let _noPts = 0, noName = 0, noCard = 0, pushCount = 0, negPts = 0;
    csnap.forEach(d => {
      custIds.add(d.id);
      const c = d.data();
      if (!c.name) noName++;
      if (!c.card) noCard++;
      if ((c.points || 0) < 0) negPts++;
      if (c.fcmToken) pushCount++;
      if ((c.points || 0) === 0 && (c.totalPoints || 0) === 0) _noPts++;
    });

    let orphanTx = 0;
    const txCustIds = new Set();
    tsnap.forEach(d => {
      const tx = d.data();
      if (tx.customerId) txCustIds.add(tx.customerId);
      if (tx.customerId && !custIds.has(tx.customerId)) orphanTx++;
    });

    let ghosts = 0;
    csnap.forEach(d => { if (!txCustIds.has(d.id)) ghosts++; });

    const cards = {};
    csnap.forEach(d => { const c = d.data().card; if (c) cards[c] = (cards[c] || 0) + 1; });
    const dupes = Object.entries(cards).filter(([, v]) => v > 1);

    if (orphanTx === 0 && dupes.length === 0 && negPts === 0) {
      pass('🗄️ Ακεραιότητα Βάσης', csnap.size + ' πελάτες, ' + tsnap.size + ' συναλλαγές — OK');
    } else {
      const issues = [];
      if (orphanTx) issues.push(orphanTx + ' ορφανές συναλλαγές');
      if (dupes.length) issues.push(dupes.length + ' διπλές κάρτες');
      if (negPts) issues.push(negPts + ' αρνητικοί πόντοι');
      warn('🗄️ Ακεραιότητα Βάσης', issues.join(' · '));
    }

    pass('📊 Στατιστικά Βάσης',
      'Πελάτες: ' + csnap.size + ' · Συναλλαγές: ' + tsnap.size + ' · Push: ' + pushCount + '/' + csnap.size + ' · Χωρίς αγορά: ' + ghosts);

    if (noName) warn('👤 Ελλιπή Στοιχεία', noName + ' πελάτες χωρίς όνομα');
    if (noCard) warn('🪪 Ελλιπή Στοιχεία', noCard + ' πελάτες χωρίς κάρτα');
    if (dupes.length) warn('🔁 Διπλές Κάρτες', dupes.map(([c, n]) => c + ' (×' + n + ')').join(', '));
  } catch (e) {
    fail('🗄️ Ακεραιότητα Βάσης', e.message);
  }

  // 5. Browser / PWA
  const online = navigator.onLine;
  if (online) pass('🌐 Σύνδεση Internet', 'Online'); else fail('🌐 Σύνδεση Internet', 'Offline');

  const storage = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
  if (storage) {
    const usedMB = (storage.usage / 1024 / 1024).toFixed(1);
    const quotaMB = (storage.quota / 1024 / 1024).toFixed(0);
    pass('💾 Storage', usedMB + 'MB χρησιμοποιούνται / ' + quotaMB + 'MB quota');
  }

  // 6. Manifest check
  try {
    const mResp = await fetch('/manifest.json');
    if (mResp.ok) pass('📄 Manifest', 'manifest.json ✓');
    else warn('📄 Manifest', 'HTTP ' + mResp.status);
  } catch (_e) {
    warn('📄 Manifest', 'Δεν βρέθηκε');
  }

  // Render results
  const icons = { pass: '✅', warn: '⚠️', fail: '❌' };
  const passCount = checks.filter(c => c.status === 'pass').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const failCount = checks.filter(c => c.status === 'fail').length;

  let scoreColor = '#4caf50';
  let scoreEmoji = '🟢';
  if (failCount > 0) { scoreColor = '#e53935'; scoreEmoji = '🔴'; }
  else if (warnCount > 0) { scoreColor = '#f57c00'; scoreEmoji = '🟡'; }

  let html = `<div style="text-align:center;margin-bottom:16px">
    <div style="font-size:2.2rem;font-weight:900;color:${scoreColor}">${scoreEmoji} ${passCount}/${checks.length}</div>
    <div style="font-size:.82rem;color:var(--gray)">
      <span style="color:#4caf50;font-weight:700">${passCount} pass</span> ·
      <span style="color:#f57c00;font-weight:700">${warnCount} warnings</span> ·
      <span style="color:#e53935;font-weight:700">${failCount} failures</span>
    </div>
  </div>`;

  html += '<div style="display:flex;flex-direction:column;gap:6px">';
  checks.forEach(c => {
    html += `<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:${c.status === 'fail' ? '#fff5f5' : c.status === 'warn' ? '#fff8e6' : '#f5fff5'};border-radius:10px;border:1px solid ${c.status === 'fail' ? '#ffcdd2' : c.status === 'warn' ? '#ffe0b2' : '#c8e6c9'}">
      <span style="font-size:1.1rem;flex-shrink:0">${icons[c.status]}</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:.88rem;color:var(--black)">${c.label}</div>
        <div style="font-size:.78rem;color:var(--gray);margin-top:2px">${c.detail}</div>
      </div>
    </div>`;
  });
  html += '</div>';
  html += '<div style="font-size:.72rem;color:var(--gray);text-align:right;margin-top:10px">Τελευταίος έλεγχος: ' + new Date().toLocaleString('el-GR') + '</div>';

  el.innerHTML = html;
}
