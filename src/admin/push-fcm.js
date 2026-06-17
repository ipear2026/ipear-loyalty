// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Push Notifications (FCM)
//  Sends a one-shot broadcast push to all customers that have an `fcmToken`
//  via the Cloudflare Worker `/push` endpoint (authenticated by secret).
// ═══════════════════════════════════════════════════════════════════════════
import { escHtml } from '../utils.js';
import { toast } from './ui.js';
import { getWorkerSecret } from './worker-secret.js';

const DB = () => window._db;

const PUSH_TPLS = {
  promo:  { t: '🎁 Νέα Προσφορά iPear!',     b: 'Ειδική έκπτωση για τα μέλη μας σήμερα! Πέρνα από το κατάστημα. 🍐' },
  points: { t: '📊 Έλεγξε τους πόντους σου!', b: 'Δες πόσους πόντους έχεις μαζέψει και τι μπορείς να κερδίσεις. 🏆' },
  bday:   { t: '🎂 Χρόνια Πολλά!',            b: 'Σου ευχόμαστε χαρούμενα γενέθλια! Σε περιμένουμε στο iPear. 🍐' },
  new:    { t: '✨ Νέα Προϊόντα στο iPear!',  b: 'Μόλις φτάσαμε νέα gadgets, θήκες & αξεσουάρ. Έλα να τα δεις! 📱' },
};

export function fillPushTpl(key) {
  const tpl = PUSH_TPLS[key];
  if (!tpl) return;
  document.getElementById('push-title').value = tpl.t;
  document.getElementById('push-body').value = tpl.b;
}

export async function sendPushNotification() {
  const workerUrl = localStorage.getItem('ipear_worker_url');
  const secret = getWorkerSecret();
  if (!workerUrl || !secret) {
    return toast('⚠️ Ορίστε πρώτα το Cloudflare Worker URL στις ρυθμίσεις Email (πάνω)', 'error');
  }

  const title = document.getElementById('push-title').value.trim();
  const body = document.getElementById('push-body').value.trim();
  if (!title) return toast('Εισάγετε τίτλο push notification', 'error');
  if (!body) return toast('Εισάγετε μήνυμα push notification', 'error');

  const db = DB();
  if (!db) return;

  const btn = document.getElementById('send-push-btn');
  const res = document.getElementById('push-result');
  btn.disabled = true;
  btn.textContent = '⏳ Αποστολή...';
  res.innerHTML = '';

  try {
    const snap = await window._getDocs(window._col(db, 'ipear_customers'));
    const tokens = [];
    snap.forEach((d) => {
      const t = d.data().fcmToken;
      if (t) tokens.push(t);
    });

    if (!tokens.length) {
      res.innerHTML =
        '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:9px;padding:12px;font-size:.84rem;color:#856404">⚠️ Κανένας πελάτης δεν έχει ενεργοποιήσει push notifications ακόμα.</div>';
      return;
    }

    const pushUrl = workerUrl.replace(/\/$/, '') + '/push';
    const r = await fetch(pushUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens, title, message: body }),
    });
    const data = await r.json().catch(() => ({}));

    if (r.ok && data.success) {
      res.innerHTML = `<div style="background:var(--green-pale);border:1px solid var(--green);border-radius:9px;padding:12px;font-size:.84rem;color:#3a6e00">
        ✅ Αποστολή ολοκληρώθηκε — <strong>${data.sent}</strong> επιτυχής, ${data.failed} αποτυχίες (από ${data.total} συσκευές)
      </div>`;
    } else {
      throw new Error(data.error || 'Worker error ' + r.status);
    }
  } catch (e) {
    res.innerHTML = `<div style="background:#f8d7da;border:1px solid #f5c2c7;border-radius:9px;padding:12px;font-size:.84rem;color:#842029">❌ ${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔔 Αποστολή Push Notification';
  }
}
