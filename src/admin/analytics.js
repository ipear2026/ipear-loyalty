// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — ANALYTICS module
//  Pure rendering + drill-down. Pulls customers + transactions and computes
//  per-customer revenue/discount/AOV/frequency/CLV; renders bar chart, table,
//  category heatmap, and per-customer drill-down doughnut.
// ═══════════════════════════════════════════════════════════════════════════
import { escHtml, escJs } from '../utils.js';
import { logger } from '../logger.js';

const DB = () => window._db;

let _anPeriod = 'all';
let _anData = null;
let _anChart = null;
let _drillChart = null;
let _loadAnalyticsBusy = false;

export function setAnPeriod(p) {
  _anPeriod = p;
  ['all', 'year', 'month', 'custom'].forEach((x) => {
    const el = document.getElementById('an-chip-' + x);
    if (el) el.className = 'chip' + (x === p ? ' active' : '');
  });
  const rangeEl = document.getElementById('an-custom-range');
  if (rangeEl) rangeEl.style.display = p === 'custom' ? 'flex' : 'none';
  if (p === 'custom') {
    const toEl = document.getElementById('an-to');
    const fromEl = document.getElementById('an-from');
    if (toEl && !toEl.value) {
      const today = new Date();
      toEl.value = today.toISOString().slice(0, 10);
      const from30 = new Date(today);
      from30.setDate(from30.getDate() - 30);
      if (fromEl && !fromEl.value) fromEl.value = from30.toISOString().slice(0, 10);
    }
  }
  renderAnalytics();
}

function _anFilterPeriod(txs) {
  const now = new Date();
  return txs.filter((tx) => {
    const d = new Date(tx.date);
    if (_anPeriod === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    if (_anPeriod === 'year') return d.getFullYear() === now.getFullYear();
    if (_anPeriod === 'custom') {
      const fromVal = document.getElementById('an-from')?.value;
      const toVal = document.getElementById('an-to')?.value;
      const from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
      const to = toVal ? new Date(toVal + 'T23:59:59') : null;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    }
    return true;
  });
}

export async function loadAnalytics() {
  if (_loadAnalyticsBusy) {
    logger.log('[loadAnalytics] ⏳ already loading');
    return;
  }
  const db = DB();
  if (!db) return;
  _loadAnalyticsBusy = true;
  document.getElementById('an-tbody').innerHTML =
    '<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--gray)">⏳ Φόρτωση...</td></tr>';
  try {
    const [csnap, tsnap] = await Promise.all([
      window._getDocs(window._col(db, 'ipear_customers')),
      window._getDocs(window._col(db, 'ipear_transactions')),
    ]);
    const customers = {};
    csnap.forEach((d) => {
      customers[d.id] = { ...d.data(), id: d.id };
    });
    const txs = [];
    tsnap.forEach((d) => txs.push({ id: d.id, ...d.data() }));
    _anData = { customers, txs };
    try {
      renderAnalytics();
    } catch (re) {
      logger.error('[loadAnalytics] renderAnalytics crashed:', re);
      const tbody = document.getElementById('an-tbody');
      if (tbody)
        tbody.innerHTML =
          '<tr><td colspan="9" style="text-align:center;padding:20px;color:#e53935">❌ Σφάλμα: ' +
          escHtml(re.message || String(re)) +
          '</td></tr>';
    }
  } catch (e) {
    logger.error('[loadAnalytics] fetch failed:', e);
    const tbody = document.getElementById('an-tbody');
    if (tbody)
      tbody.innerHTML =
        '<tr><td colspan="9" style="text-align:center;padding:20px;color:#e53935">❌ Σφάλμα φόρτωσης: ' +
        escHtml(e.message || String(e)) +
        '</td></tr>';
  } finally {
    _loadAnalyticsBusy = false;
  }
}

export function renderAnalytics() {
  if (!_anData) return;
  const { customers, txs } = _anData;
  const filtered = _anFilterPeriod(txs);
  const threshold = parseFloat(document.getElementById('an-threshold')?.value || 20);
  const sortBy = document.getElementById('an-sort')?.value || 'revenue';

  const byCustomer = {};
  for (const tx of filtered) {
    const cid = tx.customerId;
    if (!cid) continue;
    if (!byCustomer[cid])
      byCustomer[cid] = {
        id: cid,
        name: tx.customerName || customers[cid]?.name || cid,
        card: tx.card || customers[cid]?.card || '',
        revenue: 0,
        discounts: 0,
        purchases: 0,
        lastDate: null,
        points: customers[cid]?.points || 0,
      };
    const c = byCustomer[cid];
    if (tx.type === 'add') {
      c.revenue += tx.amount || 0;
      c.purchases++;
    }
    if (tx.type === 'redeem') {
      c.discounts += tx.discount || 0;
    }
    const d = new Date(tx.date);
    if (!c.lastDate || d > c.lastDate) c.lastDate = d;
  }

  const rows = Object.values(byCustomer).map((c) => ({
    ...c,
    pct: c.revenue > 0 ? (c.discounts / c.revenue) * 100 : 0,
    aov: c.purchases > 0 ? c.revenue / c.purchases : 0,
  }));

  rows.sort((a, b) => {
    if (sortBy === 'discount') return b.discounts - a.discounts;
    if (sortBy === 'pct') return b.pct - a.pct;
    if (sortBy === 'aov') return b.aov - a.aov;
    if (sortBy === 'frequency') return b.purchases - a.purchases;
    if (sortBy === 'points') return b.points - a.points;
    return b.revenue - a.revenue;
  });

  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalDiscount = rows.reduce((s, r) => s + r.discounts, 0);
  const totalPurchases = rows.reduce((s, r) => s + r.purchases, 0);
  const discPct = totalRevenue > 0 ? (totalDiscount / totalRevenue) * 100 : 0;
  const aovTotal = totalPurchases > 0 ? totalRevenue / totalPurchases : 0;

  const now = new Date();
  const inactiveCount = Object.values(customers).filter((c) => {
    const cTxs = filtered.filter((t) => t.customerId === c.id && t.type === 'add');
    if (cTxs.length === 0) return true;
    const last = Math.max(...cTxs.map((t) => new Date(t.date)));
    return now - last > 90 * 86400000;
  }).length;

  const netRevenue = totalRevenue - totalDiscount;
  const avgFreq = rows.length > 0 ? (totalPurchases / rows.length).toFixed(1) : '0';
  const clv = rows.length > 0 ? (totalRevenue / rows.length).toFixed(0) : '0';

  document.getElementById('an-revenue').textContent = totalRevenue.toLocaleString('el-GR') + '€';
  document.getElementById('an-discounts').textContent = totalDiscount.toLocaleString('el-GR') + '€';
  document.getElementById('an-disc-pct').textContent = discPct.toFixed(1) + '% του τζίρου';
  document.getElementById('an-aov').textContent = aovTotal.toFixed(0) + '€';
  document.getElementById('an-inactive').textContent = inactiveCount;
  document.getElementById('an-net').textContent = netRevenue.toLocaleString('el-GR') + '€';
  document.getElementById('an-freq').textContent = avgFreq;
  document.getElementById('sk-clv').textContent = clv + '€';

  const alertRows = rows.filter((r) => r.pct > threshold && r.revenue > 0);
  const alertEl = document.getElementById('an-alerts');
  if (alertRows.length > 0) {
    alertEl.innerHTML = `
      <div style="background:linear-gradient(135deg,#fff3f3,#ffeaea);border:2px solid #e53935;border-radius:12px;padding:14px">
        <div style="font-weight:700;color:#c62828;margin-bottom:10px">⚠️ ${alertRows.length} πελάτης/ες με ποσοστό έκπτωσης >${threshold}%</div>
        ${alertRows
          .map(
            (r) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 11px;background:white;border-radius:8px;margin-bottom:6px;cursor:pointer"
               onclick="openDrillDown('${escJs(r.id)}')">
            <div>
              <strong style="color:var(--black)">${escHtml(r.name)}</strong>
              <span style="color:var(--gray);font-size:.78rem;margin-left:8px">${escHtml(r.card)}</span>
            </div>
            <div style="display:flex;gap:10px;align-items:center">
              <span style="font-size:.8rem;color:var(--gray)">${r.revenue.toFixed(0)}€ τζίρος</span>
              <span style="background:#e53935;color:white;padding:3px 9px;border-radius:20px;font-size:.8rem;font-weight:700">${r.pct.toFixed(1)}%</span>
            </div>
          </div>`
          )
          .join('')}
      </div>`;
  } else {
    alertEl.innerHTML = '';
  }

  _renderAnChart([...rows].sort((a, b) => b.revenue - a.revenue).slice(0, 8));

  const tbody = document.getElementById('an-tbody');
  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--gray)">Δεν υπάρχουν δεδομένα για την επιλεγμένη περίοδο.</td></tr>';
  } else {
    tbody.innerHTML = rows
      .map((r) => {
        const alert = r.pct > threshold && r.revenue > 0;
        const pctColor = alert ? '#e53935' : r.pct > 10 ? '#f57c00' : '#4caf50';
        return `<tr style="border-bottom:1px solid var(--border);cursor:pointer"
                  onclick="openDrillDown('${escJs(r.id)}')"
                  onmouseover="this.style.background='var(--light)'"
                  onmouseout="this.style.background=''">
        <td style="padding:10px 10px">
          <strong>${escHtml(r.name)}</strong>
          <div style="font-size:.74rem;color:var(--gray)">${escHtml(r.card)}</div>
        </td>
        <td style="text-align:right;padding:10px 6px;font-weight:600">${r.revenue.toFixed(0)}€</td>
        <td style="text-align:right;padding:10px 6px;color:#e53935">${r.discounts.toFixed(0)}€</td>
        <td style="text-align:right;padding:10px 6px">
          <span style="background:${pctColor};color:white;padding:2px 8px;border-radius:20px;font-size:.76rem;font-weight:700">${r.pct.toFixed(1)}%</span>
        </td>
        <td style="text-align:right;padding:10px 6px">${r.aov.toFixed(0)}€</td>
        <td style="text-align:right;padding:10px 6px">${r.purchases}</td>
        <td style="text-align:right;padding:10px 6px;font-weight:600;color:#8ae900">${r.points.toLocaleString('el-GR')}</td>
        <td style="text-align:right;padding:10px 6px;font-size:.78rem;color:var(--gray)">${r.lastDate ? r.lastDate.toLocaleDateString('el-GR') : '—'}</td>
        <td style="text-align:center;padding:10px 6px;color:var(--green-dark)">🔍</td>
      </tr>`;
      })
      .join('');
  }

  _renderCategoryHeatmap(filtered);
}

function _renderAnChart(rows) {
  const ctx = document.getElementById('an-chart')?.getContext('2d');
  if (!ctx) return;
  if (typeof Chart === 'undefined') {
    logger.warn('[_renderAnChart] Chart.js not loaded yet, skipping');
    return;
  }
  if (_anChart) {
    _anChart.destroy();
    _anChart = null;
  }
  _anChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.name.split(' ')[0]),
      datasets: [
        { label: 'Τζίρος (€)', data: rows.map((r) => +r.revenue.toFixed(0)), backgroundColor: '#8ae900', borderRadius: 5 },
        { label: 'Εκπτώσεις (€)', data: rows.map((r) => +r.discounts.toFixed(0)), backgroundColor: '#e53935', borderRadius: 5 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,.05)' } },
      },
    },
  });
}

function _renderCategoryHeatmap(txs) {
  const byCat = {};
  for (const tx of txs) {
    if (tx.type !== 'add') continue;
    const cat = tx.category || 'Άλλο';
    if (!byCat[cat]) byCat[cat] = { revenue: 0, count: 0, points: 0 };
    byCat[cat].revenue += tx.amount || 0;
    byCat[cat].points += Math.abs(tx.points || 0);
    byCat[cat].count++;
  }
  const totalRevenue = Object.values(byCat).reduce((s, c) => s + c.revenue, 0);
  const totalDiscount = txs.filter((t) => t.type === 'redeem').reduce((s, t) => s + (t.discount || 0), 0);
  const rows = Object.entries(byCat).sort((a, b) => b[1].revenue - a[1].revenue || b[1].points - a[1].points);
  const maxRev = Math.max(...rows.map((r) => r[1].revenue), 1);
  const maxPts = Math.max(...rows.map((r) => r[1].points), 1);
  const tbody = document.getElementById('an-cat-tbody');
  if (!tbody) return;
  tbody.innerHTML =
    rows
      .map(([cat, d]) => {
        const isOffer = d.revenue === 0 && d.points > 0;
        const barVal = isOffer ? d.points : d.revenue;
        const barMax = isOffer ? maxPts : maxRev;
        const barW = Math.round((barVal / barMax) * 100);
        const barColor = isOffer ? '#f5a623' : 'var(--green)';
        const valLabel = isOffer ? d.points.toLocaleString('el-GR') + ' pts' : d.revenue.toFixed(0) + '€';
        const pctOfTotal = totalRevenue > 0 ? d.revenue / totalRevenue : 0;
        const catDiscount = totalDiscount * pctOfTotal;
        const grossMargin = d.revenue > 0 ? ((d.revenue - catDiscount) / d.revenue) * 100 : 100;
        const mgColor = grossMargin > 80 ? '#4caf50' : grossMargin > 60 ? '#f57c00' : '#e53935';
        const aovLabel = isOffer
          ? d.count > 0
            ? Math.round(d.points / d.count) + ' pts'
            : '0 pts'
          : d.count > 0
          ? (d.revenue / d.count).toFixed(0) + '€'
          : '0€';
        return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:10px 10px;font-weight:600">${escHtml(cat)}</td>
      <td style="padding:10px 6px;min-width:160px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden">
            <div style="height:100%;background:${barColor};border-radius:4px;width:${barW}%"></div>
          </div>
          <span style="font-size:.82rem;font-weight:700;min-width:60px;text-align:right">${valLabel}</span>
        </div>
      </td>
      <td style="text-align:right;padding:10px 6px">${d.count}</td>
      <td style="text-align:right;padding:10px 6px">${aovLabel}</td>
      <td style="text-align:right;padding:10px 6px">
        <span style="background:${mgColor};color:white;padding:2px 8px;border-radius:20px;font-size:.76rem;font-weight:700">${grossMargin.toFixed(1)}%</span>
      </td>
    </tr>`;
      })
      .join('') ||
    '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--gray)">Δεν υπάρχουν δεδομένα.</td></tr>';
}

export function openDrillDown(customerId) {
  if (!_anData) return;
  const { customers, txs } = _anData;
  const customer = customers[customerId];
  if (!customer) return;

  const filtered = _anFilterPeriod(txs).filter((t) => t.customerId === customerId);
  const addTxs = filtered.filter((t) => t.type === 'add');
  const redeemTxs = filtered.filter((t) => t.type === 'redeem');
  const revenue = addTxs.reduce((s, t) => s + (t.amount || 0), 0);
  const discounts = redeemTxs.reduce((s, t) => s + (t.discount || 0), 0);
  const pct = revenue > 0 ? (discounts / revenue) * 100 : 0;

  document.getElementById('drill-name').textContent = customer.name || customerId;
  document.getElementById('drill-revenue').textContent = revenue.toFixed(0) + '€';
  document.getElementById('drill-discounts').textContent = discounts.toFixed(0) + '€';
  document.getElementById('drill-pct').textContent = pct.toFixed(1) + '%';
  document.getElementById('drill-pct').style.color = pct > 20 ? '#e53935' : pct > 10 ? '#f57c00' : '#4caf50';

  const catRevenue = {};
  for (const tx of addTxs) {
    const cat = (tx.category || 'Άλλο').replace(/\s*\(.*?\)/, '').trim();
    catRevenue[cat] = (catRevenue[cat] || 0) + (tx.amount || 0);
  }
  const catCtx = document.getElementById('drill-chart')?.getContext('2d');
  if (catCtx && typeof Chart !== 'undefined') {
    if (_drillChart) {
      _drillChart.destroy();
      _drillChart = null;
    }
    const cats = Object.keys(catRevenue);
    const vals = cats.map((c) => catRevenue[c]);
    const colors = ['#8ae900', '#4fc3f7', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac'];
    _drillChart = new Chart(catCtx, {
      type: 'doughnut',
      data: { labels: cats, datasets: [{ data: vals, backgroundColor: colors.slice(0, cats.length), borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } },
    });
  }

  const allSorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));
  document.getElementById('drill-tx').innerHTML =
    allSorted.length === 0
      ? '<p style="color:var(--gray);text-align:center;padding:18px">Δεν υπάρχουν συναλλαγές.</p>'
      : allSorted
          .map((tx) => {
            const isAdd = tx.type === 'add';
            return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 13px;border-bottom:1px solid var(--border)">
          <div>
            <span style="margin-right:7px">${isAdd ? '➕' : '💶'}</span>
            <strong style="font-size:.84rem">${escHtml(isAdd ? tx.category || 'Αγορά' : 'Εξαργύρωση')}</strong>
            ${tx.note ? `<div style="font-size:.74rem;color:var(--gray);margin-top:2px">${escHtml(tx.note)}</div>` : ''}
          </div>
          <div style="text-align:right;flex-shrink:0">
            ${
              isAdd
                ? `<div style="font-weight:700">${(tx.amount || 0).toFixed(0)}€</div>`
                : `<div style="font-weight:700;color:#e53935">-${(tx.discount || 0).toFixed(0)}€</div>`
            }
            <div style="font-size:.74rem;color:var(--gray)">${new Date(tx.date).toLocaleDateString('el-GR')}</div>
          </div>
        </div>`;
          })
          .join('');

  document.getElementById('m-analytics-drill').classList.add('show');
}
