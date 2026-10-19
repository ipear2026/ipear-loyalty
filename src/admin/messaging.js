// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Per-customer messaging (Viber / SMS / Email)
//
//  Extracted from src/admin-main.js during the Sprint 3 god-module split.
//  Owns the 3-channel single-customer outreach flow:
//   • Viber  — deep link + clipboard fallback (no API call)
//   • SMS    — Brevo API call via Cloudflare Worker
//   • Email  — Brevo API call via Cloudflare Worker
//   • sendCustom — free-form composer routed by current msgCh channel
//
//  Each channel has a two-step UX: template selection → compose. The Back
//  buttons (mvBack/msBack/meBack) restore the template list.
//
//  Cross-domain hooks (configured via initMessaging):
//   • getScope          — read admin-main's selected customer (cdata) + msgCh
//   • getWorkerSecret   — read the session-scoped admin worker secret
// ═══════════════════════════════════════════════════════════════════════════
import { tier, friendlyError } from '../utils.js';
import { toast, closeM } from './ui.js';
// ADMIN FORTRESS Stage 3B — owner-auth path (flag ON), no master secret.
import { isOwnerAuthEnabled, ownerSendSms, ownerSendEmail } from './owner-api.js';

let _hooks = {
  getScope: () => ({ cdata: null, msgCh: '' }),
  getWorkerSecret: () => '',
};

export function initMessaging(hooks) {
  _hooks = { ..._hooks, ...hooks };
}

// ══════════════════════════════════════
//  MODAL OPENERS
// ══════════════════════════════════════
export function openViber() {
  const { cdata } = _hooks.getScope();
  if (!cdata?.phone) { toast('⚠️ Δεν υπάρχει τηλέφωνο!','error'); return; }
  document.getElementById('mv-name').textContent=cdata.name;
  document.getElementById('mv-phone').textContent=cdata.phone;
  document.getElementById('m-viber').classList.add('show');
}
export function openSMS() {
  const { cdata } = _hooks.getScope();
  if (!cdata?.phone) { toast('⚠️ Δεν υπάρχει τηλέφωνο!','error'); return; }
  document.getElementById('ms-name').textContent=cdata.name;
  document.getElementById('ms-phone').textContent=cdata.phone;
  document.getElementById('m-sms').classList.add('show');
}
export function openEmail() {
  const { cdata } = _hooks.getScope();
  if (!cdata?.email) { toast('⚠️ Δεν υπάρχει email!','error'); return; }
  document.getElementById('me-name').textContent=cdata.name;
  document.getElementById('me-addr').textContent=cdata.email;
  document.getElementById('m-email').classList.add('show');
}

// ══════════════════════════════════════
//  TEMPLATE BODY
// ══════════════════════════════════════
function buildMsg(type, ch) {
  const { cdata } = _hooks.getScope();
  const fn=(cdata?.name||'Πελάτη').split(' ')[0];
  const pts=cdata.points||0, tot=cdata.totalPoints||pts;
  const t=tier(tot);
  const nl=ch==='viber'?'\n':' ';
  const msgs = {
    pts:  `Γεια σου ${fn}!${nl}Έχεις ${pts} διαθέσιμους πόντους στο iPear Loyalty.${nl}Κατάταξη: ${t.icon} ${t.name} (${tot} lifetime).${nl}iPear — ipear.gr 📱`,
    wel:  `Καλωσήρθες στο iPear Loyalty, ${fn}! 📱✨${nl}Ευχαριστούμε για την εγγραφή σου!${nl}1€ = 10 πόντοι. Συλλέγε & κέρδισε εκπτώσεις!`,
    pro:  `Γεια σου ${fn}! 🎁${nl}Ειδική προσφορά μόνο για εσένα στο iPear!${nl}Νέα προϊόντα & custom θήκες σε περιμένουν. 📱`,
  };
  return msgs[type]||'';
}

// ══════════════════════════════════════
//  VIBER (deep link + clipboard fallback)
// ══════════════════════════════════════
export function sViber(t) {
  const { cdata } = _hooks.getScope();
  const body = t === 'cust' ? '' : buildMsg(t, 'viber');
  document.getElementById('mv-body').value = body;
  const ph = (cdata?.phone||'').replace(/[\s\-()]/g,'');
  document.getElementById('mv-phone2').textContent = ph.startsWith('+') ? ph : '+30' + ph;
  document.getElementById('mv-tpl').style.display = 'none';
  document.getElementById('mv-compose').style.display = '';
  document.getElementById('mv-cancel').style.display = 'none';
}
export function mvBack() {
  document.getElementById('mv-tpl').style.display = '';
  document.getElementById('mv-compose').style.display = 'none';
  document.getElementById('mv-cancel').style.display = '';
}
export function sendViberDeepLink() {
  const { cdata } = _hooks.getScope();
  const msg = document.getElementById('mv-body').value.trim();
  if (!msg) { toast('⚠️ Γράψε μήνυμα!', 'error'); return; }
  const ph = (cdata?.phone||'').replace(/[\s\-()]/g,'');
  const intlPh = ph.startsWith('+') ? ph : '+30' + ph;
  window.open(`viber://chat?number=${encodeURIComponent(intlPh)}`, '_blank');
  navigator.clipboard.writeText(msg)
    .then(()  => toast('📱 Άνοιξε Viber! Το μήνυμα αντιγράφηκε στο clipboard.', 'success'))
    .catch(()  => toast('📱 Άνοιξε Viber! Αντέγραψε το μήνυμα χειροκίνητα.', 'success'));
  closeM();
}

// ══════════════════════════════════════
//  SMS (Brevo via worker)
// ══════════════════════════════════════
export function sSMS(t) {
  const body = t === 'cust' ? '' : buildMsg(t, 'sms');
  document.getElementById('ms-body').value = body;
  document.getElementById('ms-chars').textContent = body.length + '/160';
  document.getElementById('ms-err').textContent = '';
  document.getElementById('ms-tpl').style.display = 'none';
  document.getElementById('ms-compose').style.display = '';
  document.getElementById('ms-cancel').style.display = 'none';
}
export function msBack() {
  document.getElementById('ms-tpl').style.display = '';
  document.getElementById('ms-compose').style.display = 'none';
  document.getElementById('ms-cancel').style.display = '';
}
let _smsSendBusy = false;
export async function sendSMSIndividual() {
  if (_smsSendBusy) return;
  const { cdata } = _hooks.getScope();
  const _ownerAuth = isOwnerAuthEnabled();
  const workerUrl = localStorage.getItem('ipear_worker_url');
  const workerSec = _ownerAuth ? '' : _hooks.getWorkerSecret();
  if (!workerUrl || (!_ownerAuth && !workerSec)) { toast('⚠️ Ορίστε τον Worker URL στις Ειδοποιήσεις πρώτα!', 'error'); closeM(); return; }
  const message = document.getElementById('ms-body').value.trim();
  const err = document.getElementById('ms-err');
  if (!message) { err.textContent = '⚠️ Συμπλήρωσε μήνυμα'; return; }
  _smsSendBusy = true;
  const btn = document.getElementById('ms-send-btn');
  btn.disabled = true; btn.textContent = '⏳ Αποστολή...';
  err.textContent = '';
  try {
    if (_ownerAuth) {
      await ownerSendSms({ phone: cdata.phone, message });
    } else {
      const smsUrl = workerUrl.replace(/\/$/, '') + '/sms';
      const response = await fetch(smsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${workerSec}` },
        body: JSON.stringify({ phone: cdata.phone, message }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    }
    toast(`✅ SMS εστάλη στον/στην ${cdata.name}!`, 'success');
    closeM();
  } catch(e) {
    console.error('[messaging] send failed:', e);
    err.textContent = '❌ ' + friendlyError(e);
  } finally {
    btn.disabled = false; btn.textContent = '📤 Αποστολή SMS';
    _smsSendBusy = false;
  }
}

// ══════════════════════════════════════
//  EMAIL (Brevo via worker)
// ══════════════════════════════════════
export function sEmail(t) {
  const subj = { pts: 'Οι πόντοι σου — iPear', wel: 'Καλωσήρθες στο iPear Loyalty!', pro: 'Ειδική Προσφορά — iPear' };
  document.getElementById('me-subject').value = subj[t] || '';
  document.getElementById('me-body').value = t === 'cust' ? '' : buildMsg(t, 'email');
  document.getElementById('me-err').textContent = '';
  const btn = document.getElementById('me-send-btn');
  btn.disabled = false; btn.textContent = '📤 Αποστολή';
  document.getElementById('me-tpl').style.display = 'none';
  document.getElementById('me-compose').style.display = '';
  document.getElementById('me-cancel').style.display = 'none';
}
export function meBack() {
  document.getElementById('me-tpl').style.display = '';
  document.getElementById('me-compose').style.display = 'none';
  document.getElementById('me-cancel').style.display = '';
}
let _sendEmailIndBusy = false;
export async function sendEmailIndividual() {
  if (_sendEmailIndBusy) return;
  const { cdata } = _hooks.getScope();
  const _ownerAuth = isOwnerAuthEnabled();
  const workerUrl = localStorage.getItem('ipear_worker_url');
  const workerSec = _ownerAuth ? '' : _hooks.getWorkerSecret();
  if (!workerUrl || (!_ownerAuth && !workerSec)) { toast('⚠️ Ορίστε τον Worker URL στις Ειδοποιήσεις πρώτα!', 'error'); closeM(); return; }
  const subject = document.getElementById('me-subject').value.trim();
  const message = document.getElementById('me-body').value.trim();
  const err = document.getElementById('me-err');
  if (!subject) { err.textContent = '⚠️ Συμπλήρωσε θέμα'; return; }
  if (!message) { err.textContent = '⚠️ Συμπλήρωσε μήνυμα'; return; }
  _sendEmailIndBusy = true;
  const btn = document.getElementById('me-send-btn');
  btn.disabled = true; btn.textContent = '⏳ Αποστολή...';
  err.textContent = '';
  try {
    const finalMessage = message
      .replace(/\{\{name\}\}/g, '{{params.name}}')
      .replace(/\{\{points\}\}/g, '{{params.points}}');
    const _payload = {
      recipients: [{ email: cdata.email, name: cdata.name, points: String(cdata.points||0) }],
      subject,
      message: finalMessage,
    };
    if (_ownerAuth) {
      await ownerSendEmail(_payload);
    } else {
      const response = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${workerSec}` },
        body: JSON.stringify(_payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    }
    toast(`✅ Email εστάλη στον/στην ${cdata.name}!`, 'success');
    closeM();
  } catch(e) {
    console.error('[messaging] send failed:', e);
    err.textContent = '❌ ' + friendlyError(e);
    btn.disabled = false; btn.textContent = '📤 Αποστολή';
  }
  finally { _sendEmailIndBusy = false; }
}

// ══════════════════════════════════════
//  FREE-FORM COMPOSER (routes by msgCh)
// ══════════════════════════════════════
export function sendCustom() {
  const { cdata, msgCh } = _hooks.getScope();
  const msg=document.getElementById('cm-txt').value.trim();
  if (!msg) { toast('⚠️ Γράψε μήνυμα!','error'); return; }
  const ph=(cdata?.phone||'').replace(/[\s\-()]/g,'');
  if (msgCh==='viber')  window.open(`viber://forward?text=${encodeURIComponent(msg)}`,'_blank'), toast('📱 Viber!','success');
  if (msgCh==='sms')    window.open(`sms:${ph}?body=${encodeURIComponent(msg)}`,'_blank'), toast('📱 SMS!','success');
  if (msgCh==='email')  window.open(`mailto:${cdata?.email}?subject=iPear Loyalty&body=${encodeURIComponent(msg)}`,'_blank'), toast('✉️ Email!','success');
  document.getElementById('cm-txt').value=''; closeM();
}
