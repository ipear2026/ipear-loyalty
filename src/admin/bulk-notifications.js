// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Bulk Notifications (manual click-through dispatcher)
//  Builds a click-per-customer list (Viber / SMS / mailto deep links).
//  Used as the legacy "send one-by-one" path before the Cloudflare Worker
//  automated bulk pipeline existed.
// ═══════════════════════════════════════════════════════════════════════════
import { tier, escHtml } from '../utils.js';
import { toast } from './ui.js';

const DB = () => window._db;

const TPLS = {
  promo:   'Ειδική προσφορά μόνο για εσένα στο iPear! Νέα προϊόντα, custom θήκες & gadgets σε περιμένουν! 📱✨',
  points:  'Υπενθύμιση: έχεις πόντους διαθέσιμους στο iPear Loyalty! Έλα να τους εξαργυρώσεις! 🎁',
  holiday: 'Καλές Γιορτές από την ομάδα του iPear! Σε ευχαριστούμε για την εμπιστοσύνη σου! 🎄',
  arrival: 'Νέα προϊόντα μόλις έφτασαν στο iPear! Custom θήκες, gadgets & αξεσουάρ. Πέρνα να τα δεις! 📱',
  repair:  'Χρειάζεσαι επισκευή; Στο iPear αναλαμβάνουμε επισκευές με εγγύηση. Κλείσε ραντεβού σήμερα! 🔧',
};

export function fillTpl(key) {
  document.getElementById('nmsg').value = TPLS[key] || '';
}

export async function prepBulk() {
  if (!navigator.onLine) {
    toast('🔴 Offline', 'error');
    return;
  }
  const target = document.getElementById('ntarget').value;
  const method = document.getElementById('nmethod').value;
  const msg = document.getElementById('nmsg').value.trim();
  if (!msg) {
    toast('⚠️ Γράψε μήνυμα!', 'error');
    return;
  }

  const snap = await window._getDocs(window._col(DB(), 'ipear_customers'));
  const list = [];
  snap.forEach((d) => {
    const data = d.data();
    const t = tier(data.totalPoints || data.points || 0);
    if (target === 'all' || t.name === target) list.push(data);
  });

  if (!list.length) {
    toast('⚠️ Δεν βρέθηκαν πελάτες.', 'error');
    return;
  }

  let html = `<p style="font-weight:700;margin-bottom:10px">${list.length} πελάτες — κάνε κλικ σε κάθε γραμμή:</p>`;
  list.forEach((c) => {
    const contact = method === 'email' ? c.email : c.phone;
    if (!contact) return;
    const ph = (c.phone || '').replace(/[\s\-()]/g, '');
    const url =
      method === 'viber'
        ? `viber://forward?text=${encodeURIComponent(msg)}`
        : method === 'sms'
          ? `sms:${ph}?body=${encodeURIComponent(msg)}`
          : `mailto:${c.email}?subject=iPear Loyalty&body=${encodeURIComponent(msg)}`;
    html += `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--light);border-radius:7px;margin-bottom:5px;border:1px solid var(--border)">
      <div style="flex:1"><strong style="font-size:.9rem">${escHtml(c.name)}</strong><br><span style="font-size:.78rem;color:var(--gray)">${escHtml(contact)}</span></div>
      <a href="${escHtml(url)}" target="_blank" style="background:var(--green);color:var(--black);padding:5px 12px;border-radius:7px;font-weight:700;font-size:.82rem;text-decoration:none">📤</a>
    </div>`;
  });
  document.getElementById('bulk-list').innerHTML = html;
}
