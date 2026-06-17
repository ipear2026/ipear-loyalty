// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Customer FCM token listener (real-time)
//  Watches ipear_customers and keeps the dashboard's push-reachability KPI,
//  the "subscribed customers" table, and the bell icons in the main customer
//  table in sync with reality. Admin-main hooks in via onCustomerChange to
//  refresh its in-memory row cache used for search filtering.
// ═══════════════════════════════════════════════════════════════════════════
import { escHtml } from '../utils.js';
import { logger } from '../logger.js';

const DB = () => window._db;

let _ctx = {
  // Called for each modified customer doc so admin-main can refresh its
  // _allCustRows cache (used by client-side search filter).
  onCustomerChange: (_id, _data) => {},
};

export function initPushListener(config) {
  _ctx = { ..._ctx, ...config };
}

let _pushUnsub = null;

export function startPushListener() {
  if (_pushUnsub || window.DEMO) return;
  const db = DB();
  if (!db) return;

  _pushUnsub = window._onSnapshot(
    window._col(db, 'ipear_customers'),
    (snap) => {
      // ── 1. KPI counter + bar ────────────────────────────────────────────
      let pushCount = 0;
      const pushCustomers = [];
      snap.forEach((d) => {
        const cd = d.data();
        if (cd.fcmToken) {
          pushCount++;
          pushCustomers.push({
            name: cd.name || '—',
            card: cd.card || '',
            phone: cd.phone || '',
          });
        }
      });

      const total = snap.size;
      const pct = total > 0 ? Math.round((pushCount / total) * 100) : 0;

      const elCount = document.getElementById('dash-push-count');
      const elBar = document.getElementById('dash-push-bar');
      const elPct = document.getElementById('dash-push-pct');
      if (elCount) elCount.textContent = pushCount + '/' + total;
      if (elBar) elBar.style.width = pct + '%';
      if (elPct) elPct.textContent = pct + '% reachable';

      // ── 2. Subscribed customers table ───────────────────────────────────
      const pushEl = document.getElementById('push-customers-list');
      if (pushEl) {
        if (!pushCustomers.length) {
          pushEl.innerHTML =
            '<div style="color:var(--gray);font-size:.85rem;text-align:center;padding:14px">Κανένας πελάτης με ενεργές ειδοποιήσεις</div>';
        } else {
          pushEl.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:.83rem">
              <thead><tr style="border-bottom:2px solid var(--border)">
                <th style="text-align:left;padding:8px 10px;color:var(--gray);font-weight:600">#</th>
                <th style="text-align:left;padding:8px 10px;color:var(--gray);font-weight:600">Πελάτης</th>
                <th style="text-align:left;padding:8px 10px;color:var(--gray);font-weight:600">Κάρτα</th>
                <th style="text-align:left;padding:8px 10px;color:var(--gray);font-weight:600">Τηλέφωνο</th>
              </tr></thead>
              <tbody>${pushCustomers
                .map(
                  (c, i) => `
                <tr style="border-bottom:1px solid var(--border)">
                  <td style="padding:8px 10px;color:var(--gray)">${i + 1}</td>
                  <td style="padding:8px 10px;font-weight:600">${escHtml(c.name)}</td>
                  <td style="padding:8px 10px;font-size:.8rem;color:var(--gray)">${escHtml(c.card)}</td>
                  <td style="padding:8px 10px;font-size:.8rem">${escHtml(c.phone)}</td>
                </tr>`
                )
                .join('')}
              </tbody>
            </table>
            <div style="font-size:.75rem;color:var(--gray);margin-top:8px;text-align:right">🔔 ${pushCustomers.length} / ${total} πελάτες με push ενεργό</div>`;
        }
      }

      // ── 3. Targeted bell-icon updates in the main customer table ───────
      snap.docChanges().forEach((change) => {
        if (change.type === 'modified' || change.type === 'added') {
          const row = document.querySelector(`tr[data-uid="${change.doc.id}"]`);
          if (!row) return;
          const bell = row.querySelector('.push-bell');
          if (!bell) return;
          if (change.doc.data().fcmToken) {
            bell.innerHTML = '🔔';
            bell.title = 'Push ενεργό';
            bell.style.cssText = 'font-size:.7rem;opacity:.7';
          } else {
            bell.innerHTML = '';
            bell.title = '';
            bell.style.cssText = '';
          }
        }
      });

      // ── 4. Notify admin-main so its row cache stays in sync ─────────────
      snap.docChanges().forEach((change) => {
        if (change.type === 'modified') {
          _ctx.onCustomerChange(change.doc.id, change.doc.data());
        }
      });
    },
    (err) => logger.warn('[push-listener] error:', err)
  );
}

export function stopPushListener() {
  if (_pushUnsub) {
    try {
      _pushUnsub();
    } catch {
      /* ignore */
    }
    _pushUnsub = null;
  }
}
