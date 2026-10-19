// ═══════════════════════════════════════════════════════════════════════════
//  Customer UI — Misc (Card-tab QR + Referral share/copy)
//
//  Extracted from src/ui-renderers.js during the Sprint 3 god-module split.
//  Small set that didn't justify its own domain module but doesn't belong in
//  rewards/offers/leaderboard/history either:
//   • generateQR — paints the customer card QR on the Card tab once per session
//   • copyReferral / shareReferral — referral code clipboard + native share
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../../logger.js';
import { state } from '../../state.js';
import { showToast, _haptic } from '../../utils.js';

// ════════════════════════════════════════
//  QR CODE (Card tab)
// ════════════════════════════════════════
let _qrGenerated = false;
export function generateQR() {
  if (_qrGenerated || !state.foundCustomer || !window.QRCode) return;
  const el = document.getElementById('qr-canvas');
  el.innerHTML = '';
  new QRCode(el, {
    text: state.foundCustomer.card,
    width: 200, height: 200,
    colorDark: '#111111',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H
  });
  _qrGenerated = true;
}

// ════════════════════════════════════════
//  REFERRAL
// ════════════════════════════════════════
export async function copyReferral() {
  const code = state.foundCustomer?.card || '';
  const btn = document.querySelector('.ref-copy-btn');
  try {
    await navigator.clipboard.writeText(code);
    if (btn) { const orig = btn.textContent; btn.textContent = '✅ Αντιγράφηκε!'; btn.style.background = '#111'; btn.style.color = '#8ae900'; setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; }, 1500); }
    showToast('✅ Αντιγράφηκε: ' + code, 'green');
    _haptic('pop');
  } catch(e) { showToast('Κωδικός: ' + code); }
}

export async function shareReferral() {
  const code = state.foundCustomer?.card || '';
  // Referral links must ALWAYS point at the canonical production origin.
  // Building from window.location.origin let a session opened on the
  // Cloudflare Pages default domain (ipear-loyalty.pages.dev) share
  // pages.dev referral links; and the /customer.html base path just added a
  // redirect hop. Hardcode the canonical root so every shared link is
  // https://loyalty.ipear.gr/?ref=IP-XXXXXX regardless of where it's shared.
  const appUrl = 'https://loyalty.ipear.gr/?ref=' + encodeURIComponent(code);
  const text = `Εγγράψου στο iPear Loyalty και κέρδισε πόντους σε κάθε αγορά! 🎁\n\nΆνοιξε τον σύνδεσμο παρακάτω — ο κωδικός παραπομπής ${code} θα συμπληρωθεί αυτόματα!\n\n🔗 ${appUrl}`;
  if (navigator.share) {
    try {
      await navigator.share({title:'iPear Loyalty', text, url: appUrl});
    } catch(e) {
      // AbortError = user dismissed the share sheet — silent, no feedback needed.
      // Anything else (NotAllowedError, TypeError, missing-data) → fall back to
      // clipboard so the user still gets *something* useful instead of a
      // dead-tap experience.
      if (e?.name === 'AbortError') return;
      logger.warn('[share] navigator.share failed:', e?.name, e?.message);
      try {
        await navigator.clipboard.writeText(text);
        showToast('✅ Αντιγράφηκε','green');
      } catch(_) {
        showToast('Κωδικός: ' + code);
      }
    }
  } else {
    try { await navigator.clipboard.writeText(text); showToast('✅ Αντιγράφηκε','green'); } catch(e) { showToast('Κωδικός: ' + code); }
  }
}
