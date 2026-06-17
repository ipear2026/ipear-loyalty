// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Email Worker (Cloudflare Worker integration)
//  Config UI, connection test, health probe, single-customer search,
//  template fill, and authenticated bulk-email broadcast via Brevo.
// ═══════════════════════════════════════════════════════════════════════════
import { tier, escHtml, escJs } from '../utils.js';
import { toast } from './ui.js';
import { getWorkerSecret, setWorkerSecret } from './worker-secret.js';

const DB = () => window._db;

// ── Worker config UI ──────────────────────────────────────────────────────
export function toggleWorkerConfig() {
  const panel = document.getElementById('worker-cfg-panel');
  const btn = document.getElementById('worker-cfg-toggle');
  const open = panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  btn.textContent = open ? '▲ Απόκρυψη' : '▼ Ρυθμίσεις';
  if (open) {
    const url = localStorage.getItem('ipear_worker_url') || '';
    const sec = getWorkerSecret() || '';
    document.getElementById('worker-url').value = url;
    document.getElementById('worker-secret').value = sec ? '••••••••' : '';
    document.getElementById('worker-secret').dataset.real = sec;
  }
}

export function saveWorkerConfig() {
  const url = document.getElementById('worker-url').value.trim();
  const secEl = document.getElementById('worker-secret');
  const sec =
    secEl.value === '••••••••' ? secEl.dataset.real || '' : secEl.value.trim();
  if (!url || !sec) {
    toast('⚠️ Συμπλήρωσε URL και Secret!', 'error');
    return;
  }
  if (!url.startsWith('https://')) {
    toast('⚠️ Το Worker URL πρέπει να ξεκινά με https://', 'error');
    return;
  }
  localStorage.setItem('ipear_worker_url', url);
  setWorkerSecret(sec);
  const st = document.getElementById('worker-cfg-status');
  st.style.color = 'var(--green-dark)';
  st.textContent = '✅ Αποθηκεύτηκε!';
  setTimeout(() => (st.textContent = ''), 2500);
}

export async function testWorkerConnection() {
  const url = localStorage.getItem('ipear_worker_url');
  const sec = getWorkerSecret();
  const st = document.getElementById('worker-cfg-status');
  if (!url || !sec) {
    toast('⚠️ Πρώτα αποθήκευσε URL και Secret!', 'error');
    return;
  }
  st.style.color = 'var(--gray)';
  st.textContent = '⏳ Έλεγχος...';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sec}` },
      body: JSON.stringify({ recipients: [], subject: 'test', message: 'test' }),
    });
    if (res.status === 400 || res.ok) {
      st.style.color = 'var(--green-dark)';
      st.textContent = '✅ Σύνδεση ΟΚ!';
    } else if (res.status === 401) {
      st.style.color = '#e53935';
      st.textContent = '❌ Λάθος Secret!';
    } else {
      st.style.color = '#e53935';
      st.textContent = `❌ HTTP ${res.status}`;
    }
  } catch {
    st.style.color = '#e53935';
    st.textContent = '❌ Δεν βρέθηκε ο Worker — έλεγξε το URL';
  }
  setTimeout(() => (st.textContent = ''), 4000);
}

export async function checkWorkerHealth() {
  const workerUrl = (localStorage.getItem('ipear_worker_url') || '').replace(/\/$/, '');
  if (!workerUrl) return;
  const dot = document.getElementById('worker-health-dot');
  const txt = document.getElementById('worker-health-txt');
  const wrap = document.getElementById('worker-health');
  wrap.style.display = 'flex';
  dot.className = 'health-dot unknown';
  txt.textContent = 'Worker...';
  try {
    const r = await fetch(workerUrl + '/health', { method: 'GET', signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const data = await r.json();
      dot.className = 'health-dot ok';
      txt.textContent = 'Worker ✓';
      txt.title = 'Brevo: ' + (data.brevo ? '✓' : '✗') + ' | FCM: ' + (data.fcm ? '✓' : '✗');
    } else {
      dot.className = 'health-dot err';
      txt.textContent = 'Worker ✗';
    }
  } catch (e) {
    dot.className = 'health-dot err';
    txt.textContent = 'Worker ✗';
    txt.title = e.message;
  }
}

// ── Email templates ────────────────────────────────────────────────────────
const EMAIL_TPLS = {
  promo: {
    s: '🎁 Ειδική Προσφορά iPear — Μόνο για εσένα!',
    b: 'Έχουμε μια ξεχωριστή προσφορά για σένα αυτή την εβδομάδα!\n\nΕπισκέψου το κατάστημα iPear και απόλαυσε αποκλειστικά deals σε αξεσουάρ, επισκευές και custom θήκες.\n\nΜην ξεχνάς ότι έχεις {{points}} πόντους έτοιμους για εξαργύρωση! 🎯',
  },
  points: {
    s: '📊 Ενημέρωση Πόντων — iPear Loyalty',
    b: 'Μια γρήγορη ενημέρωση: έχεις {{points}} πόντους στο iPear Loyalty.\n\nΜε 250 πόντους κερδίζεις έκπτωση 5€ στην επόμενη αγορά σου.\n\nΈλα να τους εξαργυρώσεις — σε περιμένουμε! 🍐',
  },
  birthday: {
    s: '🎂 Χρόνια Πολλά από το iPear Loyalty!',
    b: 'Τα iPear Loyalty σου εύχονται Χρόνια Πολλά! 🎉\n\nΩς δώρο γενεθλίων σου προσφέρουμε 100 bonus πόντους — έλα να τους παραλάβεις στο κατάστημα!\n\nΝα είσαι πάντα καλά! 🍐',
  },
  inactive: {
    s: '😊 Μας λείπεις — iPear Loyalty',
    b: 'Πέρασε λίγος καιρός από την τελευταία σου επίσκεψη!\n\nΈχεις {{points}} πόντους που σε περιμένουν και θέλαμε να σε υπενθυμίσουμε ότι είμαστε εδώ με νέα προϊόντα και προσφορές.\n\nΈλα να μας δεις — θα χαρούμε! 🍐',
  },
  newtier: {
    s: '🏆 Ανέβηκες Tier στο iPear Loyalty!',
    b: 'Συγχαρητήρια! 🎊 Ανέβηκες επίπεδο στο iPear Loyalty!\n\nΩς υψηλότερο μέλος, απολαμβάνεις αποκλειστικά προνόμια και bonus πόντους σε κάθε αγορά.\n\nΤρέχοντες πόντοι σου: {{points}} 🏅\n\nΕυχαριστούμε που είσαι μαζί μας!',
  },
  holiday: {
    s: '🎄 Καλές Γιορτές από το iPear Loyalty!',
    b: 'Η ομάδα του iPear σου εύχεται Καλές Γιορτές και Ευτυχισμένο το Νέο Έτος! 🎄✨\n\nΕυχαριστούμε θερμά για την εμπιστοσύνη σου κατά τη διάρκεια της χρονιάς.\n\nΈχεις {{points}} πόντους για να αρχίσεις το νέο έτος με δώρα! 🎁',
  },
};

export function fillEmailTpl(key) {
  const t = EMAIL_TPLS[key];
  if (!t) return;
  document.getElementById('email-subject').value = t.s;
  document.getElementById('email-body').value = t.b;
}

// ── Single-customer email search ──────────────────────────────────────────
// _emailOneSelected / _emailAllCustomers stay on window because they are
// touched by inline HTML handlers (onclick="selectEmailOne(...)") rendered
// from this module's search results.
window._emailOneSelected = null;
window._emailAllCustomers = null;

export function toggleEmailTargetSearch(val) {
  const wrap = document.getElementById('email-one-wrap');
  if (wrap) wrap.style.display = val === 'one' ? 'block' : 'none';
  if (val !== 'one') {
    window._emailOneSelected = null;
    const sel = document.getElementById('email-one-selected');
    if (sel) sel.style.display = 'none';
    const inp = document.getElementById('email-one-search');
    if (inp) inp.value = '';
    const res = document.getElementById('email-one-results');
    if (res) res.style.display = 'none';
  }
}

export async function searchEmailOne(q) {
  const resEl = document.getElementById('email-one-results');
  const selEl = document.getElementById('email-one-selected');
  window._emailOneSelected = null;
  selEl.style.display = 'none';

  if (!q || q.length < 2) {
    resEl.style.display = 'none';
    return;
  }

  if (!window._emailAllCustomers) {
    const db = DB();
    if (!db) return;
    const snap = await window._getDocs(window._col(db, 'ipear_customers'));
    window._emailAllCustomers = [];
    snap.forEach((d) => window._emailAllCustomers.push({ id: d.id, ...d.data() }));
  }

  const ql = q.toLowerCase();
  const matches = window._emailAllCustomers
    .filter(
      (c) =>
        (c.name || '').toLowerCase().includes(ql) ||
        (c.card || '').toLowerCase().includes(ql) ||
        (c.phone || '').includes(q)
    )
    .slice(0, 8);

  if (!matches.length) {
    resEl.innerHTML =
      '<div style="padding:12px;color:var(--gray);font-size:.84rem;text-align:center">Δεν βρέθηκαν πελάτες</div>';
    resEl.style.display = 'block';
    return;
  }

  resEl.innerHTML = matches
    .map((c) => {
      const hasEmail = c.email && c.email.includes('@');
      return `<div data-action="selectEmailOne" data-arg="${escJs(c.id)}" style="
      padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);
      display:flex;justify-content:space-between;align-items:center;
      ${!hasEmail ? 'opacity:.5;pointer-events:none;' : ''}
    " onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background=''">
      <div>
        <div style="font-weight:700;font-size:.86rem">${escHtml(c.name || '—')} <span style="color:var(--gray);font-weight:400;font-size:.78rem">${escHtml(c.card || '')}</span></div>
        <div style="font-size:.76rem;color:var(--gray)">${escHtml(c.phone || '')} ${hasEmail ? '· ' + escHtml(c.email) : '· <span style="color:#dc3545">χωρίς email</span>'}</div>
      </div>
      <div style="font-size:.8rem;font-weight:700;color:var(--green)">${(c.points || 0).toLocaleString('el-GR')} pts</div>
    </div>`;
    })
    .join('');
  resEl.style.display = 'block';
}

export function selectEmailOne(id) {
  const c = (window._emailAllCustomers || []).find((x) => x.id === id);
  if (!c) return;
  window._emailOneSelected = c;
  document.getElementById('email-one-search').value = c.name || c.card;
  document.getElementById('email-one-results').style.display = 'none';
  const selEl = document.getElementById('email-one-selected');
  selEl.innerHTML = `✅ <strong>${escHtml(c.name)}</strong> · ${escHtml(c.card)} · ${escHtml(c.email)} · <span style="color:var(--green);font-weight:700">${(c.points || 0).toLocaleString('el-GR')} pts</span>`;
  selEl.style.display = 'block';
}

// ── Bulk email broadcast ──────────────────────────────────────────────────
let _sendEmailBulkBusy = false;

export async function sendEmailBulk() {
  if (_sendEmailBulkBusy) return;
  const workerUrl = localStorage.getItem('ipear_worker_url');
  const workerSec = getWorkerSecret();
  if (!workerUrl || !workerSec) {
    toast('⚠️ Ρύθμισε πρώτα τον Worker (κουμπί Ρυθμίσεις)!', 'error');
    document.getElementById('worker-cfg-panel').style.display = 'block';
    document.getElementById('worker-cfg-toggle').textContent = '▲ Απόκρυψη';
    return;
  }
  const target = document.getElementById('email-target').value;
  const subject = document.getElementById('email-subject').value.trim();
  const message = document.getElementById('email-body').value.trim();
  if (!subject) {
    toast('⚠️ Συμπλήρωσε Θέμα!', 'error');
    return;
  }
  if (!message) {
    toast('⚠️ Συμπλήρωσε Μήνυμα!', 'error');
    return;
  }

  const btn = document.getElementById('send-email-btn');
  const spin = document.getElementById('email-spin');
  const prog = document.getElementById('email-progress');
  const res = document.getElementById('email-result');

  _sendEmailBulkBusy = true;
  btn.disabled = true;
  spin.classList.add('show');
  prog.style.display = 'block';
  prog.textContent = '⏳ Φόρτωση πελατών...';
  res.innerHTML = '';

  try {
    const db = DB();
    if (!db) throw new Error('Δεν υπάρχει σύνδεση');
    const snap = await window._getDocs(window._col(db, 'ipear_customers'));

    const recipients = [];
    if (target === 'one') {
      const sel = window._emailOneSelected;
      if (!sel) {
        prog.style.display = 'none';
        toast('⚠️ Επίλεξε πελάτη από την αναζήτηση', 'error');
        return;
      }
      if (!sel.email || !sel.email.includes('@')) {
        prog.style.display = 'none';
        toast('⚠️ Ο πελάτης δεν έχει email', 'error');
        return;
      }
      recipients.push({
        email: sel.email,
        name: sel.name || sel.email.split('@')[0],
        points: String(sel.points || 0),
      });
    } else {
      snap.forEach((d) => {
        const c = d.data();
        if (!c.email || !c.email.includes('@')) return;
        if (c.marketingOptIn !== true) return;
        if (target !== 'all') {
          const t = tier(c.totalPoints || c.points || 0);
          if (t.name !== target) return;
        }
        recipients.push({
          email: c.email,
          name: c.name || c.email.split('@')[0],
          points: String(c.points || 0),
        });
      });
    }

    if (!recipients.length) {
      prog.style.display = 'none';
      res.innerHTML = `<div style="background:#fff3f3;border:1px solid #e53935;border-radius:10px;padding:14px;color:#c62828;font-size:.85rem">
        ⚠️ Δεν βρέθηκαν πελάτες με email για αυτή την κατηγορία.</div>`;
      return;
    }

    prog.textContent = `📤 Αποστολή σε ${recipients.length} παραλήπτες...`;

    const finalMessage = message
      .replace(/\{\{name\}\}/g, '{{params.name}}')
      .replace(/\{\{points\}\}/g, '{{params.points}}');

    const response = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerSec}` },
      body: JSON.stringify({ recipients, subject, message: finalMessage }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    prog.style.display = 'none';
    const failedLine =
      data.failed > 0
        ? `<div style="margin-top:4px;color:#e53935">❌ Απέτυχαν: <strong>${data.failed}</strong></div>`
        : '';
    res.innerHTML = `<div style="background:linear-gradient(135deg,#f0ffe0,#e8ffcc);border:1px solid #8ae900;border-radius:12px;padding:18px">
      <div style="font-weight:800;font-size:1.05rem;color:#3a6000;margin-bottom:8px">✅ Αποστολή ολοκληρώθηκε!</div>
      <div style="font-size:.87rem;color:#555;line-height:1.9">
        📤 Εστάλησαν: <strong style="color:#3a6000">${data.sent}</strong>
        ${failedLine}
        👥 Σύνολο: <strong>${data.total}</strong>
      </div>
    </div>`;
    toast(`✅ Email εστάλη σε ${data.sent} πελάτες!`, 'success');
  } catch (e) {
    prog.style.display = 'none';
    res.innerHTML = `<div style="background:#fff3f3;border:1px solid #e53935;border-radius:10px;padding:14px;color:#c62828;font-size:.85rem">
      ❌ Σφάλμα: ${escHtml(e.message)}</div>`;
    toast('❌ ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    spin.classList.remove('show');
    _sendEmailBulkBusy = false;
  }
}
