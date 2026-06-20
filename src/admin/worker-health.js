// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Worker & KV Health Dashboard
//
//  Reads the worker-flushed analytics from Firestore
//  (ipear_analytics/daily_YYYY-MM-DD docs that handleLogEvent PATCHes every
//  ~30s per isolate) and computes:
//
//    • Today's total events + per-event breakdown
//    • 7-day trend (used both for the sparkline and the baseline)
//    • Projection — events so far × extrapolation to 24h. The projection is
//      the lead signal for "the worker is about to get expensive": once it
//      crosses the warning threshold we draw the admin's attention to the
//      Cloudflare dashboard BEFORE the daily KV / Firestore quota actually
//      gets touched.
//
//  Why not poll Cloudflare's Analytics API directly?
//  Polling would require a new API token + worker binding + secret rotation
//  + cost. The /log-event funnel is a clean proxy for overall app activity
//  (every meaningful customer action fires one) and is already in Firestore.
//  When the admin asks "are we close to the KV ceiling?", the projection +
//  trend here answers it in one place without extra infrastructure.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../logger.js';
import { escHtml } from '../utils.js';

const DB = () => window._db;

// Projection thresholds (events / day). These are calibrated for a
// loyalty app's customer volume; tune via the constants as activity grows.
//
// We compare against the projected daily total (events so far + extrapolated
// remainder), NOT the current count. That way the badge flips early in the
// day — when there's still time to react — instead of only at 23:00 when
// the damage is already done.
const TH_GREEN  = 500;   // < 500 projected → 🟢 nominal
const TH_YELLOW = 2000;  // < 2000 → 🟡 moderate, monitor
const TH_ORANGE = 5000;  // < 5000 → 🟠 high, review CF dashboard
//                       // ≥ 5000 → 🔴 very high, consider upgrade

const _EVENT_LABELS = {
  offer_opened:      { label: 'Άνοιγμα Προσφοράς',  icon: '🎁', kind: 'browse' },
  offer_dismissed:   { label: 'Κλείσιμο Προσφοράς', icon: '👋', kind: 'browse' },
  offer_confirmed:   { label: 'Επιβεβαίωση Προσφοράς', icon: '✅', kind: 'action' },
  offer_redeemed:    { label: 'Εξαργύρωση Προσφοράς',  icon: '💎', kind: 'action' },
  offer_cancelled_qr:{ label: 'Ακύρωση QR Προσφοράς',  icon: '❎', kind: 'action' },
  reward_opened:     { label: 'Άνοιγμα Reward',     icon: '🏆', kind: 'browse' },
  reward_redeemed:   { label: 'Εξαργύρωση Reward',  icon: '💶', kind: 'action' },
  reward_cancelled:  { label: 'Ακύρωση Reward',     icon: '↩️', kind: 'action' },
};

let _whBusy = false;
let _whLastRunAt = 0;
const _WH_MIN_GAP_MS = 5000;

export async function loadWorkerHealth() {
  if (_whBusy) return;
  if (Date.now() - _whLastRunAt < _WH_MIN_GAP_MS) return;
  _whBusy = true;
  _whLastRunAt = Date.now();

  const el = document.getElementById('wh-body');
  if (!el) { _whBusy = false; return; }

  el.innerHTML = '<div class="wh-loading">⏳ Φόρτωση…</div>';

  try {
    const db = DB();
    if (!db) throw new Error('Firestore unavailable');

    // Pull the last 8 days so "today + previous 7" are all in hand.
    const days = _buildLastNDays(8);
    const snaps = await Promise.all(
      days.map(d =>
        window._getDoc(window._doc(db, 'ipear_analytics', 'daily_' + d.iso))
          .then(s => ({ iso: d.iso, label: d.label, data: s.exists() ? s.data() : null }))
          .catch(e => ({ iso: d.iso, label: d.label, error: e?.code || e?.message }))
      )
    );

    const todayIso = days[0].iso;
    const today = snaps.find(s => s.iso === todayIso);
    const trend = snaps; // newest first

    const todayTotals = _sumEvents(today?.data);
    const todayTotal  = todayTotals.total;
    const breakdown   = todayTotals.byEvent;

    // Projection: extrapolate today's pace to 24h.
    const now = new Date();
    const hoursElapsed = Math.max(0.1, now.getHours() + now.getMinutes() / 60);
    const projection = Math.round(todayTotal * (24 / hoursElapsed));

    // 7-day average (yesterday and back, excluding today).
    const prior7 = trend.slice(1).map(d => _sumEvents(d.data).total);
    const avg7   = prior7.length
      ? Math.round(prior7.reduce((a, b) => a + b, 0) / prior7.length)
      : 0;

    const status = _classify(projection);

    el.innerHTML = _renderDashboard({
      todayTotal,
      projection,
      hoursElapsed,
      avg7,
      breakdown,
      trend,
      status,
    });
  } catch (e) {
    logger.warn('[worker-health]', e?.code || e?.message || e);
    el.innerHTML = `<div class="wh-loading wh-loading--error">
      ⚠️ Δεν ήταν δυνατή η φόρτωση. ${escHtml(e?.message || 'Δοκίμασε ξανά')}
    </div>`;
  } finally {
    _whBusy = false;
  }
}

function _buildLastNDays(n) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString('el-GR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    out.push({ iso, label });
  }
  return out;
}

function _sumEvents(fields) {
  // Firestore REST returns shapes like { event_name: { integerValue: '42' } }.
  // The client SDK reads the same docs as { event_name: 42 } — handleLogEvent
  // PATCHes via REST so we may see either shape depending on origin.
  if (!fields) return { total: 0, byEvent: {} };
  const byEvent = {};
  let total = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'updatedAt' || k === 'date') continue;
    const n = typeof v === 'number'
      ? v
      : Number(v?.integerValue ?? v?.value ?? 0);
    if (!Number.isFinite(n) || n < 0) continue;
    byEvent[k] = n;
    total += n;
  }
  return { total, byEvent };
}

function _classify(projection) {
  if (projection < TH_GREEN)  return { tone: 'ok',   tag: '🟢 Κανονική κίνηση', message: 'Είσαι σε ασφαλή ζώνη — δεν χρειάζεται καμία ενέργεια.' };
  if (projection < TH_YELLOW) return { tone: 'warn', tag: '🟡 Μέτρια κίνηση',  message: 'Η κίνηση είναι αυξημένη. Δεν τρέχει τίποτα, αλλά κράτα το dashboard στο νου σου.' };
  if (projection < TH_ORANGE) return { tone: 'high', tag: '🟠 Υψηλή κίνηση',  message: 'Πλησιάζουμε τα limits του δωρεάν tier. Άνοιξε το Cloudflare dashboard και τσέκαρε τα KV ops του τρέχοντος 24ώρου.' };
  return { tone: 'crit', tag: '🔴 Πολύ υψηλή κίνηση', message: 'Επικίνδυνη ζώνη. Έλεγξε άμεσα το CF dashboard. Αν χρειαστεί, σκέψου upgrade στο Workers Paid plan ($5/μήνα).' };
}

function _renderDashboard({ todayTotal, projection, hoursElapsed, avg7, breakdown, trend, status }) {
  const sparkline = _renderSparkline(trend);
  const breakdownRows = _renderBreakdown(breakdown);
  const trendRows = _renderTrendTable(trend);
  const hoursStr = hoursElapsed >= 1 ? hoursElapsed.toFixed(1) + 'h' : Math.round(hoursElapsed * 60) + 'm';

  return `
    <div class="wh-grid">
      <div class="wh-stat">
        <div class="wh-stat-lbl">Events σήμερα</div>
        <div class="wh-stat-val wh-num">${todayTotal.toLocaleString('el-GR')}</div>
        <div class="wh-stat-sub">στις τελευταίες ${hoursStr}</div>
      </div>
      <div class="wh-stat">
        <div class="wh-stat-lbl">Πρόβλεψη 24ώρου</div>
        <div class="wh-stat-val wh-num">${projection.toLocaleString('el-GR')}</div>
        <div class="wh-stat-sub">extrapolation από σημερινό ρυθμό</div>
      </div>
      <div class="wh-stat">
        <div class="wh-stat-lbl">Μ.Ο. 7 ημερών</div>
        <div class="wh-stat-val wh-num">${avg7.toLocaleString('el-GR')}</div>
        <div class="wh-stat-sub">βάση σύγκρισης</div>
      </div>
    </div>

    <div class="wh-alert wh-alert--${status.tone}">
      <div class="wh-alert-tag">${status.tag}</div>
      <div class="wh-alert-msg">${escHtml(status.message)}</div>
      <a class="wh-alert-link" href="https://dash.cloudflare.com/?to=/:account/workers/kv/namespaces" target="_blank" rel="noopener noreferrer">
        Άνοιγμα Cloudflare KV Dashboard →
      </a>
    </div>

    <div class="wh-section">
      <div class="wh-section-title">Trend 7 ημερών</div>
      ${sparkline}
      ${trendRows}
    </div>

    <div class="wh-section">
      <div class="wh-section-title">Σπάσιμο σήμερα ανά event</div>
      ${breakdownRows}
    </div>

    <div class="wh-footnote">
      Πηγή: <code>ipear_analytics/daily_*</code> docs που γράφει ο worker μέσω /log-event flush ανά ~30s.
      Το flush γίνεται in-memory στον isolate και πέφτει στο Firestore με μία PATCH ανά isolate — μηδέν KV writes.
    </div>
  `;
}

function _renderSparkline(trend) {
  // Trend is newest-first; render left-to-right oldest-to-newest.
  const rev = [...trend].reverse();
  const totals = rev.map(d => _sumEvents(d.data).total);
  const max = Math.max(1, ...totals);
  const w = 280, h = 64, pad = 4;
  const stepX = (w - pad * 2) / Math.max(1, totals.length - 1);

  const points = totals.map((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (v / max) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const dots = totals.map((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (v / max) * (h - pad * 2);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="var(--green-dark)" />`;
  }).join('');

  return `
    <svg class="wh-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Trend events 7 ημερών">
      <polyline points="${points}" fill="none" stroke="var(--green-dark)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
    </svg>
  `;
}

function _renderTrendTable(trend) {
  // Show newest first, dim today's incomplete row.
  return `
    <div class="wh-trend">
      ${trend.map((d, i) => {
        const { total } = _sumEvents(d.data);
        const isToday = i === 0;
        return `<div class="wh-trend-row ${isToday ? 'wh-trend-row--today' : ''}">
          <span class="wh-trend-day">${escHtml(d.label)}${isToday ? ' (σήμερα)' : ''}</span>
          <span class="wh-trend-bar"><span class="wh-trend-bar-fill" style="width:${_pct(total, trend)}%"></span></span>
          <span class="wh-trend-val wh-num">${total.toLocaleString('el-GR')}</span>
        </div>`;
      }).join('')}
    </div>
  `;
}

function _pct(val, trend) {
  const max = Math.max(1, ...trend.map(d => _sumEvents(d.data).total));
  return Math.round((val / max) * 100);
}

function _renderBreakdown(byEvent) {
  const entries = Object.entries(byEvent).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    return '<div class="wh-empty">Καμία δραστηριότητα ακόμα σήμερα</div>';
  }
  return `
    <div class="wh-breakdown">
      ${entries.map(([key, count]) => {
        const meta = _EVENT_LABELS[key] || { label: key, icon: '•', kind: 'browse' };
        return `<div class="wh-bd-row">
          <span class="wh-bd-ico">${meta.icon}</span>
          <span class="wh-bd-lbl">${escHtml(meta.label)}</span>
          <span class="wh-bd-val wh-num">${count.toLocaleString('el-GR')}</span>
        </div>`;
      }).join('')}
    </div>
  `;
}
