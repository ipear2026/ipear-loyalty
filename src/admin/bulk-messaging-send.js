import { getDb, collection, getDocs } from '../services/firebase.js';
import { tier, escHtml } from '../utils.js';
import { toast } from './ui.js';
import { getWorkerSecret } from './worker-secret.js';

const SMS_COST_PER_MSG = 0.05; // €0.05/SMS (Brevo Greece GSM-7)

export async function previewSmsBulk() {
  const est = document.getElementById('sms-bulk-estimate');
  est.style.display = 'block';
  est.innerHTML = '⏳ Μέτρηση παραληπτών...';
  try {
    const db = getDb();
    const target = document.getElementById('sms-target').value;
    const snap = await getDocs(collection(db, 'ipear_customers'));
    let count = 0;
    snap.forEach(d => {
      const c = d.data();
      const phone = (c.phone || '').replace(/[\s\-()]/g, '');
      if (!phone || phone.length < 10) return;
      if (target !== 'all') {
        const t = tier(c.totalPoints || c.points || 0);
        if (t.name !== target) return;
      }
      count++;
    });
    const cost = (count * SMS_COST_PER_MSG).toFixed(2);
    est.innerHTML = `<strong>📱 ${count} παραλήπτες</strong> — Εκτιμώμενο κόστος: <strong style="font-size:1.1rem">€${cost}</strong><br><span style="font-size:.76rem;color:#999">Τιμή: €${SMS_COST_PER_MSG}/SMS × ${count} = €${cost}</span>`;
  } catch (e) {
    est.innerHTML = '❌ ' + escHtml(e.message);
  }
}

export async function previewEmailBulk() {
  const est = document.getElementById('email-bulk-estimate');
  est.style.display = 'block';
  est.innerHTML = '⏳ Μέτρηση παραληπτών...';
  try {
    const db = getDb();
    const target = document.getElementById('email-target').value;
    const snap = await getDocs(collection(db, 'ipear_customers'));
    let count = 0;
    let withEmail = 0;
    if (target === 'one') {
      // window._emailOneSelected is set by email-worker module when a single recipient is picked
      count = window._emailOneSelected ? 1 : 0;
    } else {
      snap.forEach(d => {
        const c = d.data();
        if (!c.email || !c.email.includes('@')) return;
        if (target !== 'all') {
          const t = tier(c.totalPoints || c.points || 0);
          if (t.name !== target) return;
        }
        withEmail++;
        if (c.marketingOptIn === true) count++;
      });
    }
    const freeLimit = 300;
    const overFree = count > freeLimit;
    const optedOut = target === 'one' ? 0 : (withEmail - count);
    const consentNote = optedOut > 0
      ? `<br><span style="font-size:.76rem;color:#c97c00">⚠️ ${optedOut} πελάτ${optedOut === 1 ? 'ης' : 'ες'} με email δεν έχουν δώσει marketing consent — εξαιρούνται (GDPR)</span>`
      : '';
    est.innerHTML = `<strong>📧 ${count} παραλήπτες</strong> — Κόστος: <strong style="font-size:1.1rem">${overFree ? '⚠️ Υπέρβαση Free Plan' : 'ΔΩΡΕΑΝ'}</strong>`
      + `<br><span style="font-size:.76rem;color:#999">Free Plan: ${freeLimit}/ημέρα — ${overFree ? 'Χρειάζεσαι Starter Plan (€19/μο) για ' + count + ' emails' : count + '/' + freeLimit + ' διαθέσιμα σήμερα'}</span>`
      + consentNote;
  } catch (e) {
    est.innerHTML = '❌ ' + escHtml(e.message);
  }
}

const SMS_BULK_TPLS = {
  promo:   'Ειδικη προσφορα μονο σημερα στο iPear! Περνα να τη δεις! 📱✨',
  points:  'Υπενθυμιση: εχεις ποντους στο iPear Loyalty! Ελα να τους εξαργυρωσεις! 🎁',
  arrival: 'Νεα προιοντα μολις εφτασαν στο iPear! Custom θηκες, gadgets & αξεσουαρ. 📱',
  repair:  'Χρειαζεσαι επισκευη; Στο iPear αναλαμβανουμε με εγγυηση. Κλεισε ραντεβου! 🔧',
};

export function fillSmsBulkTpl(key) {
  const ta = document.getElementById('sms-bulk-body');
  ta.value = SMS_BULK_TPLS[key] || '';
  document.getElementById('sms-bulk-chars').textContent = ta.value.length + '/160';
}

let _sendSMSBulkBusy = false;

export async function sendSMSBulk() {
  if (_sendSMSBulkBusy) return;
  const workerUrl = localStorage.getItem('ipear_worker_url');
  const workerSec = getWorkerSecret();
  if (!workerUrl || !workerSec) {
    toast('⚠️ Ρύθμισε πρώτα τον Worker (κουμπί Ρυθμίσεις)!', 'error');
    document.getElementById('worker-cfg-panel').style.display = 'block';
    document.getElementById('worker-cfg-toggle').textContent = '▲ Απόκρυψη';
    return;
  }

  const target  = document.getElementById('sms-target').value;
  const message = document.getElementById('sms-bulk-body').value.trim();
  if (!message) { toast('⚠️ Συμπλήρωσε Μήνυμα!', 'error'); return; }

  const btn  = document.getElementById('send-sms-bulk-btn');
  const prog = document.getElementById('sms-bulk-progress');
  const res  = document.getElementById('sms-bulk-result');

  _sendSMSBulkBusy = true;
  btn.disabled = true;
  btn.textContent = '⏳ Αποστολή...';
  prog.style.display = 'block';
  prog.textContent = '⏳ Φόρτωση πελατών...';
  res.innerHTML = '';

  try {
    const db = getDb();
    const snap = await getDocs(collection(db, 'ipear_customers'));

    const recipients = [];
    snap.forEach(d => {
      const c = d.data();
      const phone = (c.phone || '').replace(/[\s\-()]/g, '');
      if (!phone || phone.length < 10) return;
      if (c.marketingOptIn !== true) return;
      if (target !== 'all') {
        const t = tier(c.totalPoints || c.points || 0);
        if (t.name !== target) return;
      }
      recipients.push({ phone, name: c.name || '' });
    });

    if (!recipients.length) {
      prog.style.display = 'none';
      res.innerHTML = '<div style="background:#fff3f3;border:1px solid #e53935;border-radius:10px;padding:14px;color:#c62828;font-size:.85rem">⚠️ Δεν βρέθηκαν πελάτες με τηλέφωνο για αυτή την κατηγορία.</div>';
      return;
    }

    if (!confirm(`Θέλεις σίγουρα να στείλεις SMS σε ${recipients.length} πελάτες;\n\nΚόστος: ~€${(recipients.length * 0.05).toFixed(2)}\nΜήνυμα: ${message.slice(0, 60)}...`)) {
      prog.style.display = 'none';
      return;
    }

    prog.textContent = `📤 Αποστολή σε ${recipients.length} παραλήπτες...`;

    const smsUrl = workerUrl.replace(/\/$/, '') + '/bulk-sms';
    const response = await fetch(smsUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${workerSec}`,
      },
      body: JSON.stringify({ recipients, message }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    prog.style.display = 'none';
    const failedLine = data.failed > 0
      ? `<div style="margin-top:4px;color:#e53935">❌ Απέτυχαν: <strong>${data.failed}</strong></div>` : '';
    res.innerHTML = `<div style="background:linear-gradient(135deg,#f0ffe0,#e8ffcc);border:1px solid #8ae900;border-radius:12px;padding:18px">
      <div style="font-weight:800;font-size:1.05rem;color:#3a6000;margin-bottom:8px">✅ Μαζικό SMS ολοκληρώθηκε!</div>
      <div style="font-size:.87rem;color:#555;line-height:1.9">
        📤 Εστάλησαν: <strong style="color:#3a6000">${data.sent}</strong>
        ${failedLine}
        👥 Σύνολο: <strong>${data.total}</strong>
      </div>
    </div>`;
    toast(`✅ SMS εστάλη σε ${data.sent} πελάτες!`, 'success');
  } catch (e) {
    prog.style.display = 'none';
    res.innerHTML = `<div style="background:#fff3f3;border:1px solid #e53935;border-radius:10px;padding:14px;color:#c62828;font-size:.85rem">❌ Σφάλμα: ${escHtml(e.message)}</div>`;
    toast('❌ ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📱 Αποστολή Μαζικού SMS';
    _sendSMSBulkBusy = false;
  }
}
