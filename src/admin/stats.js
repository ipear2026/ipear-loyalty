import {
  getDb, collection, getDocs,
} from '../services/firebase.js';
import { tier, escHtml } from '../utils.js';
import { authState } from './auth-state.js';
import { setCachedCustomers } from './snapshot-cache.js';
import { processBirthdayClaims } from './birthday-claims.js';
import { logger } from '../logger.js';

// Hardcoded business constant — also lives in admin-main (referral processing).
// Keep in sync if changed.
const MAX_REFERRALS_PER_USER = 5;

// Lazy Chart.js (loaded only on first stats render, ~210K saved otherwise).
let _ChartCtor = null;
async function loadChart() {
  if (_ChartCtor) return _ChartCtor;
  const mod = await import('chart.js/auto');
  _ChartCtor = mod.Chart;
  return _ChartCtor;
}

let _tierDonutChart = null;
let _loadStatsBusy = false;

// Optional callback fired after stats finish loading with the customer snapshot.
// admin-main wires this to its renderSegments() function.
let _onSnapshot = () => {};

export function configureStats({ onSnapshot } = {}) {
  if (typeof onSnapshot === 'function') _onSnapshot = onSnapshot;
}

export async function loadStats() {
  if (!authState.authenticated) return;
  if (!navigator.onLine) return;
  if (_loadStatsBusy) return;
  _loadStatsBusy = true;
  try {
    const db = getDb();
    const [csnap, tsnap] = await Promise.all([
      getDocs(collection(db, 'ipear_customers')),
      getDocs(collection(db, 'ipear_transactions')),
    ]);
    setCachedCustomers(csnap);

    let given = 0, redeemed = 0, totalAvailPts = 0, pushCount = 0, blockedCount = 0, suspiciousCount = 0;
    const tc = { Bronze: 0, Silver: 0, Gold: 0, Diamond: 0, Platinum: 0 };
    const txByCustomer = {};
    const now = new Date();
    const d30ago = new Date(now - 30 * 86400000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let signupsThisMonth = 0;
    const referrers = [];
    const redeemCounts = {};

    csnap.forEach(d => {
      const cd = d.data();
      const t = tier(cd.totalPoints || cd.points || 0);
      tc[t.name]++;
      totalAvailPts += cd.points || 0;
      if (cd.fcmToken) pushCount++;
      if (cd.blocked) blockedCount++;
      if (cd.suspicious) suspiciousCount++;
      if (cd.createdAt && new Date(cd.createdAt) >= monthStart) signupsThisMonth++;
      if ((cd.referralCount || 0) > 0) referrers.push({ name: cd.name || '—', card: cd.card || '', count: cd.referralCount });
    });

    const active30Ids = new Set();
    tsnap.forEach(d => {
      const x = d.data();
      if (x.type === 'add') {
        given += x.points || 0;
        if (x.customerId) txByCustomer[x.customerId] = (txByCustomer[x.customerId] || 0) + 1;
        if (x.date && new Date(x.date) >= d30ago && x.customerId) active30Ids.add(x.customerId);
      }
      if (x.type === 'redeem') {
        redeemed += Math.abs(x.points || 0);
        const lbl = (x.discount || 0) + '€';
        redeemCounts[lbl] = (redeemCounts[lbl] || 0) + 1;
      }
    });

    const redemptionRate = given > 0 ? (redeemed / given * 100).toFixed(1) + '%' : '0%';
    const redemDetail = given > 0 ? redeemed.toLocaleString('el-GR') + ' / ' + given.toLocaleString('el-GR') + ' πτ' : '';
    const liability = (totalAvailPts * 0.02).toFixed(0) + '€';
    const loyalCount = Object.values(txByCustomer).filter(n => n >= 3).length;
    const loyaltyRate = csnap.size > 0 ? (loyalCount / csnap.size * 100).toFixed(0) + '%' : '0%';
    const pushPct = csnap.size > 0 ? Math.round(pushCount / csnap.size * 100) : 0;
    const active30 = active30Ids.size;
    const active30Pct = csnap.size > 0 ? Math.round(active30 / csnap.size * 100) : 0;

    let topReward = '—', topRewardCount = 0;
    for (const [lbl, cnt] of Object.entries(redeemCounts)) {
      if (cnt > topRewardCount) { topReward = lbl; topRewardCount = cnt; }
    }

    document.getElementById('sc').textContent = csnap.size;
    document.getElementById('dash-signups').innerHTML = '📈 <span class="dash-trend-up">+' + signupsThisMonth + '</span> αυτό τον μήνα';
    document.getElementById('sk-redem').textContent = redemptionRate;
    document.getElementById('dash-redem-detail').textContent = redemDetail;
    document.getElementById('sk-liab').textContent = liability;
    document.getElementById('dash-liab-pts').textContent = totalAvailPts.toLocaleString('el-GR') + ' πόντοι';
    document.getElementById('sk-clv').textContent = '—';
    document.getElementById('dash-loyalty-rate').textContent = 'Loyalty Rate: ' + loyaltyRate;
    document.getElementById('dash-active30').textContent = active30;
    document.getElementById('dash-active30-pct').textContent = active30Pct + '% της βάσης';
    document.getElementById('dash-push-count').textContent = pushCount + '/' + csnap.size;
    document.getElementById('dash-push-bar').style.width = pushPct + '%';
    document.getElementById('dash-push-pct').textContent = pushPct + '% reachable';
    document.getElementById('dash-top-reward').textContent = topReward;
    document.getElementById('dash-top-reward-count').textContent = topRewardCount > 0 ? topRewardCount + ' εξαργυρώσεις' : 'Καμία ακόμα';
    document.getElementById('dash-blocked').textContent = blockedCount + (suspiciousCount ? ' / ' + suspiciousCount : '');
    document.getElementById('dash-total-tx').textContent = tsnap.size + ' συναλλαγές';
    document.getElementById('su').textContent = new Date().toLocaleString('el-GR');

    // Tier Donut
    const tierData = [
      { n: 'Platinum', i: '👑', c: '#d4af37', v: tc.Platinum },
      { n: 'Diamond',  i: '💎', c: '#6ba3d6', v: tc.Diamond  },
      { n: 'Gold',     i: '🥇', c: '#d4a017', v: tc.Gold     },
      { n: 'Silver',   i: '🥈', c: '#a8b2c1', v: tc.Silver   },
      { n: 'Bronze',   i: '🥉', c: '#cd7f32', v: tc.Bronze   },
    ];
    const donutEl = document.getElementById('tier-donut-chart');
    if (donutEl) {
      try {
        const Chart = await loadChart();
        if (_tierDonutChart) _tierDonutChart.destroy();
        _tierDonutChart = new Chart(donutEl, {
          type: 'doughnut',
          data: {
            labels: tierData.map(t => t.i + ' ' + t.n),
            datasets: [{ data: tierData.map(t => t.v), backgroundColor: tierData.map(t => t.c), borderWidth: 2, borderColor: '#fff' }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            cutout: '62%',
            plugins: {
              legend: { position: 'bottom', labels: { padding: 14, usePointStyle: true, pointStyleWidth: 10, font: { size: 11, weight: '600' } } },
              tooltip: { callbacks: { label: ctx => ' ' + ctx.label + ': ' + ctx.parsed + ' (' + Math.round(ctx.parsed / csnap.size * 100) + '%)' } },
            },
          },
        });
      } catch (e) {
        logger.warn('[stats] Chart load failed:', e.message);
      }
    }

    // Mini tier bars below donut
    const total = csnap.size || 1;
    document.getElementById('tier-bd').innerHTML = tierData.map(t => `
      <div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:.78rem">
        <span style="width:18px;text-align:center">${t.i}</span>
        <span style="width:55px;font-weight:600">${t.n}</span>
        <div style="flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden">
          <div style="height:100%;background:${t.c};border-radius:3px;width:${Math.round(t.v / total * 100)}%;transition:width .4s"></div>
        </div>
        <span style="font-weight:800;width:24px;text-align:right">${t.v}</span>
      </div>`).join('');

    // Top 10 Referrers
    referrers.sort((a, b) => b.count - a.count);
    const top10ref = referrers.slice(0, 10);
    const refEl = document.getElementById('kpi-top-referrers');
    if (!top10ref.length) {
      refEl.innerHTML = '<li style="color:var(--gray);font-size:.85rem;justify-content:center;padding:14px">Κανένας referrer ακόμα</li>';
    } else {
      const medals = ['🥇', '🥈', '🥉'];
      refEl.innerHTML = top10ref.map((r, i) => `<li>
        <div class="ref-rank" style="${i >= 3 ? 'background:#555;color:#fff;font-size:.72rem' : ''}">${medals[i] || '#' + (i + 1)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:.85rem">${escHtml(r.name)}</div>
          <div style="font-size:.72rem;color:var(--gray)">${escHtml(r.card)}</div>
        </div>
        <div style="font-weight:900;font-size:1rem;color:${r.count >= 5 ? '#d4af37' : 'var(--green)'}">${r.count}<span style="font-weight:600;font-size:.72rem;color:var(--gray)">/${MAX_REFERRALS_PER_USER}</span></div>
      </li>`).join('');
    }

    // Push Notifications Table
    const pushCustomers = [];
    csnap.forEach(d => {
      const cd = d.data();
      if (cd.fcmToken) pushCustomers.push({ name: cd.name || '—', card: cd.card || '', phone: cd.phone || '' });
    });
    const pushEl = document.getElementById('push-customers-list');
    if (!pushCustomers.length) {
      pushEl.innerHTML = '<div style="color:var(--gray);font-size:.85rem;text-align:center;padding:14px">Κανένας πελάτης με ενεργές ειδοποιήσεις</div>';
    } else {
      pushEl.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:.83rem">
          <thead><tr style="border-bottom:2px solid var(--border)">
            <th style="text-align:left;padding:8px 10px;color:var(--gray);font-weight:600">#</th>
            <th style="text-align:left;padding:8px 10px;color:var(--gray);font-weight:600">Πελάτης</th>
            <th style="text-align:left;padding:8px 10px;color:var(--gray);font-weight:600">Κάρτα</th>
            <th style="text-align:left;padding:8px 10px;color:var(--gray);font-weight:600">Τηλέφωνο</th>
          </tr></thead>
          <tbody>${pushCustomers.map((c, i) => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:8px 10px;color:var(--gray)">${i + 1}</td>
              <td style="padding:8px 10px;font-weight:600">${escHtml(c.name)}</td>
              <td style="padding:8px 10px;font-size:.8rem;color:var(--gray)">${escHtml(c.card)}</td>
              <td style="padding:8px 10px;font-size:.8rem">${escHtml(c.phone)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div style="font-size:.75rem;color:var(--gray);margin-top:8px;text-align:right">🔔 ${pushCustomers.length} / ${csnap.size} πελάτες με push ενεργό</div>`;
    }

    _onSnapshot(csnap, tsnap);
    processBirthdayClaims().catch(e => logger.warn('[birthday-auto]', e.message));
  } catch (e) {
    logger.error(e);
  } finally {
    _loadStatsBusy = false;
  }
}
