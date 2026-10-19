// ═══════════════════════════════════════════════════════════════════════════
//  iPear Loyalty — Tablet / Store POS  ·  L2.3A rewrite (2026-08-31)
//
//  What changed from the pre-L2.3A tablet:
//    • NO direct customer/redemption/audit Firestore access. Every read of
//      customer data goes through the `lookupCustomerForTablet` callable
//      and returns ONLY the masked projection.
//    • NO direct writes to customer.points, ipear_redemptions.used,
//      ipear_offer_redemptions, ipear_transactions, or audit_logs.
//    • Scan / manual lookup → `createRedemptionRequest(code)` callable.
//    • Subscribes with `onSnapshot` to ONLY the returned requestId
//      (rules deny reads of other tablets' or stores' requests).
//    • Live status UI: pending / approved / rejected / expired.
//    • Auth: only `role: 'tablet'` custom claim with a `storeId`. A stale
//      admin/legacy-doc login is refused with a clear error.
//    • Admin routes are refused — tablet role claim is not admin.
//
//  DOM ids are those already in tablet.html (2026-06 layout).
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from './logger.js';
import './firebase-init.js';
import { installDelegation } from './dom-delegate.js';
import { tier, _trapFocus, _releaseFocus, escHtml } from './utils.js';
import {
  createRedemptionRequest,
  lookupCustomerForTablet,
  subscribeToRequest,
  lookupCustomerByCardQr,
  createRedemptionRequestFromCard,
} from './tablet/approval-flow.js';

const _CARD_QR_RE = /^IP-[A-Z0-9]{6}$/;

const TABLET_BUILD_TAG = 'tablet-l23a-20260831';
window.TABLET_BUILD_TAG = TABLET_BUILD_TAG;
logger.log('tablet.html loaded', TABLET_BUILD_TAG);

window._tabletSignIn = async (email, pass) => {
  const cred = await window._signIn(window._auth, email, pass);
  return cred.user;
};
window._tabletSignOut = window._signOut;

// ── Audio ──────────────────────────────────────────────────────────────────
const _sndSuccess = new Audio('snd-success.mp3');
const _sndError = new Audio('snd-error.mp3');
_sndSuccess.volume = 0.5; _sndError.volume = 0.5;
let _sndUnlocked = false;
function _unlockSndOnGesture() {
  if (_sndUnlocked) return;
  _sndUnlocked = true;
  _sndSuccess.muted = true; _sndError.muted = true;
  Promise.all([
    _sndSuccess.play().catch(() => {}),
    _sndError.play().catch(() => {}),
  ]).then(() => {
    _sndSuccess.pause(); _sndSuccess.currentTime = 0; _sndSuccess.muted = false;
    _sndError.pause(); _sndError.currentTime = 0; _sndError.muted = false;
  }).catch(() => { _sndSuccess.muted = false; _sndError.muted = false; });
  document.removeEventListener('touchstart', _unlockSndOnGesture);
  document.removeEventListener('click', _unlockSndOnGesture);
}
document.addEventListener('touchstart', _unlockSndOnGesture, { passive: true });
document.addEventListener('click', _unlockSndOnGesture);
function _playSuccess() { try { _sndSuccess.currentTime = 0; _sndSuccess.play().catch(() => {}); } catch (_) {} }
function _playError() { try { _sndError.currentTime = 0; _sndError.play().catch(() => {}); } catch (_) {} }

function _showToast(msg) {
  const old = document.getElementById('tablet-toast'); if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'tablet-toast';
  el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:14px 22px;border-radius:8px;font-weight:700;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.2);max-width:80vw;text-align:center';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Tablet auth state (module-scoped, never in localStorage) ───────────────
let _tabletActorUid = null;
let _tabletStoreId = null;
let _tabletStoreName = '—';

async function _completeTabletAuth(user) {
  const tok = await user.getIdTokenResult(true);
  const claims = tok?.claims || {};
  if (claims.role !== 'tablet' || typeof claims.storeId !== 'string' || !claims.storeId) {
    throw new Error('not-tablet');
  }
  _tabletActorUid = user.uid;
  _tabletStoreId = claims.storeId;
  try {
    const snap = await window._getDoc(window._doc(window._db, 'ipear_stores', _tabletStoreId));
    if (snap.exists()) _tabletStoreName = snap.data().name || '—';
  } catch (_) {}
  _paintStoreBadge();
  document.getElementById('tablet-login').style.display = 'none';
  const passEl = document.getElementById('tl-pass'); if (passEl) passEl.value = '';
}

function _paintStoreBadge() {
  const ids = ['store-badge', 'r-store', 'tablet-store-name'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) { el.textContent = 'Tablet — ' + _tabletStoreName; el.style.display = 'inline-block'; }
  }
  const hdr = document.querySelector('.tablet-hdr-store');
  if (hdr) hdr.textContent = 'Tablet — ' + _tabletStoreName;
}

let _tlAttempts = 0, _tlLockedUntil = 0;
const _TL_MAX = 5, _TL_LOCK = 60;

async function tabletLogin() {
  const err = document.getElementById('tl-err');
  const btn = document.getElementById('tl-btn');
  if (Date.now() < _tlLockedUntil) {
    const sec = Math.ceil((_tlLockedUntil - Date.now()) / 1000);
    err.textContent = `🔒 Κλείδωμα — περίμενε ${sec} δευτερόλεπτα.`; return;
  }
  const email = document.getElementById('tl-email').value.trim().toLowerCase();
  const pass = document.getElementById('tl-pass').value;
  err.textContent = '';
  if (!email || !pass) { err.textContent = '⚠️ Συμπληρώστε email και κωδικό.'; return; }
  btn.disabled = true; btn.textContent = '⏳ Σύνδεση...';
  try {
    const user = await window._tabletSignIn(email, pass);
    _tlAttempts = 0;
    await _completeTabletAuth(user);
  } catch (e) {
    if (e.message === 'not-tablet') {
      err.textContent = '❌ Ο λογαριασμός δεν έχει tablet role/storeId claim. Επικοινώνησε με τον διαχειριστή.';
      try { await window._tabletSignOut(window._auth); } catch (_) {}
    } else {
      _tlAttempts++;
      if (_tlAttempts >= _TL_MAX) {
        _tlLockedUntil = Date.now() + _TL_LOCK * 1000; _tlAttempts = 0;
        err.textContent = `🔒 Κλείδωμα ${_TL_LOCK} δευτερολέπτων μετά από πολλές αποτυχίες.`;
      } else {
        const msgs = {
          'auth/wrong-password': '❌ Λάθος κωδικός.',
          'auth/user-not-found': '❌ Δεν βρέθηκε λογαριασμός.',
          'auth/invalid-credential': '❌ Λάθος email ή κωδικός.',
          'auth/too-many-requests': '⚠️ Πάρα πολλές προσπάθειες.',
        };
        const left = _TL_MAX - _tlAttempts;
        err.textContent = (msgs[e.code] || ('❌ ' + (e.message || e.code))) +
          (left < _TL_MAX ? `  (${left} απόπειρες ακόμα)` : '');
      }
    }
  }
  btn.disabled = false; btn.textContent = 'Είσοδος →';
}

async function _tryTabletAutoRestore() {
  const user = window._auth?.currentUser;
  if (!user) return;
  try { await _completeTabletAuth(user); }
  catch (e) { logger.warn('[TABLET] auto-restore failed:', e?.message); }
}
if (window._firebaseReady) _tryTabletAutoRestore();
else window.addEventListener('firebase-ready', _tryTabletAutoRestore);

// ── QR scanner ─────────────────────────────────────────────────────────────
let _qrStream = null, _qrAnimFrame = null, _qrScanning = false;

async function openQRScanner() {
  const overlay = document.getElementById('qr-overlay');
  const video = document.getElementById('qr-video');
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia-not-supported');
    _qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = _qrStream;
    await video.play();
    overlay.classList.add('show');
    if (typeof _trapFocus === 'function') _trapFocus(overlay);
    _qrScanning = true;
    requestAnimationFrame(_qrScanLoop);
  } catch (e) {
    logger.error('QR camera failed', e);
    const msg = (e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError')
      ? '⚠️ Πρόσβαση κάμερας αρνήθηκε. Χρησιμοποίησε τη χειροκίνητη αναζήτηση.'
      : (e?.name === 'NotFoundError')
        ? '⚠️ Δεν βρέθηκε κάμερα.'
        : `⚠️ Κάμερα μη διαθέσιμη: ${e?.name || e?.message || 'unknown'}.`;
    _showToast(msg);
    document.getElementById('sinput')?.focus();
  }
}

function _qrScanLoop() {
  if (!_qrScanning) return;
  const video = document.getElementById('qr-video');
  const canvas = document.getElementById('qr-canvas');
  if (video.readyState !== video.HAVE_ENOUGH_DATA) {
    _qrAnimFrame = requestAnimationFrame(_qrScanLoop); return;
  }
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = window.jsQR && jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
  if (code?.data) _onQRFound(code.data);
  else _qrAnimFrame = requestAnimationFrame(_qrScanLoop);
}

function _onQRFound(text) {
  _qrScanning = false;
  closeQRScanner();
  const t = text.trim();
  if (t.startsWith('IPEAR-REDEEM:')) _sendScanRequest(t.replace('IPEAR-REDEEM:', '').trim());
  else if (t.startsWith('IPEAR-OFFER:')) _sendScanRequest(t.replace('IPEAR-OFFER:', '').trim());
  else if (/^\d{6}$/.test(t)) _sendScanRequest(t);
  else if (_CARD_QR_RE.test(t.toUpperCase())) _handleCardScan(t.toUpperCase());
  else _showToast('⚠️ Μη έγκυρος QR κωδικός.');
}

function closeQRScanner() {
  _qrScanning = false;
  cancelAnimationFrame(_qrAnimFrame);
  if (_qrStream) { _qrStream.getTracks().forEach(t => t.stop()); _qrStream = null; }
  const video = document.getElementById('qr-video'); if (video) video.srcObject = null;
  document.getElementById('qr-overlay')?.classList.remove('show');
  if (typeof _releaseFocus === 'function') _releaseFocus();
}

// ── Manual search (via callable) ───────────────────────────────────────────
async function searchByCard() {
  const raw = document.getElementById('card-input')?.value.trim().toUpperCase();
  if (!raw) return;
  const card = raw.startsWith('IP-') ? raw : 'IP-' + raw;
  await _doLookup(card);
  const cardInput = document.getElementById('card-input');
  if (cardInput) cardInput.value = '';
}

async function doSearch() {
  const q = document.getElementById('sinput')?.value.trim();
  if (!q) return;
  const stripped = q.replace(/\s/g, '');
  if (q.startsWith('IPEAR-OFFER:')) { _sendScanRequest(q.replace('IPEAR-OFFER:', '').trim()); return; }
  if (q.startsWith('IPEAR-REDEEM:')) { _sendScanRequest(q.replace('IPEAR-REDEEM:', '').trim()); return; }
  if (/^\d{6}$/.test(stripped)) { _sendScanRequest(stripped); return; }
  // L2.3A hotfix: manually-typed card (IP-XXXXXX) opens the same reward
  // picker as a QR card scan. Everything else is a name/phone lookup.
  if (_CARD_QR_RE.test(stripped.toUpperCase())) { _handleCardScan(stripped.toUpperCase()); return; }
  // Phone-only lookup (matches the live production fix): the backend resolves a
  // customer by exact phone, never by name. A non-phone input (e.g. a name) is
  // rejected here with a clear message and NEVER reaches the server.
  if (!/^\d{7,}$/.test(stripped)) { _showToast('⚠️ Εισάγετε έγκυρο αριθμό τηλεφώνου.'); return; }
  await _doLookup(stripped);
}

async function _doLookup(query) {
  if (!_tabletStoreId) { _showToast('❌ Δεν είσαι συνδεδεμένος ως tablet.'); return; }
  const btn = document.getElementById('sbtn');
  if (btn) { btn.innerHTML = '<div class="spin"></div>'; btn.disabled = true; }
  document.getElementById('cust-display').style.display = 'block';
  document.getElementById('not-found').style.display = 'none';
  try {
    const res = await lookupCustomerForTablet(query);
    if (!res.found) _showResultAsNotFound('Δεν βρέθηκε πελάτης.');
    else if (res.blocked) _showResultAsNotFound('🚫 Ο πελάτης είναι blocked.');
    else { _renderCustomerProjection(res.projection); _showResult(); }
  } catch (e) {
    _showToast('❌ ' + _friendlyErrorFor(e));
  } finally {
    if (btn) { btn.innerHTML = 'Αναζήτηση'; btn.disabled = false; }
  }
}

function _showResultAsNotFound(msg) {
  document.getElementById('cust-display').style.display = 'none';
  const nf = document.getElementById('not-found');
  nf.style.display = 'block';
  nf.innerHTML = `<div style="font-size:1.8rem;margin-bottom:10px">ℹ️</div><div style="font-size:1.05rem;font-weight:700">${escHtml(msg)}</div>`;
  _showResult();
}

function _renderCustomerProjection(p) {
  const ini = (p.displayName || '?').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText('r-av', ini);
  setText('r-name', p.displayName || '—');
  setText('r-phone', p.phoneMasked || '');
  setText('r-card', '📱 ' + (p.cardMasked || ''));
  setText('r-pts', (p.points || 0).toLocaleString('el-GR'));
  setText('r-ticon', _tierIcon(p.tier));
  setText('r-tname', _tierName(p.tier));
  _renderTierProgress(p);
  const rw = document.getElementById('r-rewards'); if (rw) rw.innerHTML = '';
}

// Truthful tier-progress bar. Progress-to-next-tier is a function of lifetime
// totalPoints (NOT spendable points), so it needs totalPoints from the masked
// projection. When present we fill the bar proportionally on the canonical
// ladder (tier() → {floor, next}); at Platinum the bar is legitimately full.
// When totalPoints is absent (older server projection) we HIDE the bar rather
// than show a misleading permanently-full one.
function _renderTierProgress(p) {
  const prog = document.getElementById('r-prog');
  const sub = document.getElementById('r-tsub');
  const tp = Number(p && p.totalPoints);
  if (!prog) return;
  if (!Number.isFinite(tp)) {
    prog.style.width = '0%';
    const bar = prog.parentElement; if (bar) bar.style.display = 'none';
    if (sub) sub.textContent = '';
    return;
  }
  const bar = prog.parentElement; if (bar) bar.style.display = '';
  const t = tier(tp);
  if (t.next == null) {
    prog.style.width = '100%';
    if (sub) sub.textContent = 'Ανώτατο επίπεδο';
    return;
  }
  const span = t.next - t.floor;
  const pct = span > 0 ? Math.max(0, Math.min(100, ((tp - t.floor) / span) * 100)) : 0;
  prog.style.width = pct.toFixed(1) + '%';
  if (sub) sub.textContent = (t.next - tp).toLocaleString('el-GR') + ' πόντοι για ' + tier(t.next).name;
}

function _tierIcon(tier) {
  return { platinum: '👑', diamond: '💎', gold: '🥇', silver: '🥈', bronze: '🥉' }[tier] || '🥉';
}
function _tierName(tier) {
  const map = { platinum: 'Platinum', diamond: 'Diamond', gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };
  return map[tier] || '—';
}

function _showResult() {
  document.getElementById('idle')?.classList.add('hidden');
  document.getElementById('result-screen')?.classList.add('show');
}
function goBack() {
  document.getElementById('result-screen')?.classList.remove('show');
  document.getElementById('idle')?.classList.remove('hidden');
  const sinput = document.getElementById('sinput'); if (sinput) sinput.value = '';
  document.getElementById('cust-display').style.display = 'block';
  document.getElementById('not-found').style.display = 'none';
  setTimeout(() => sinput?.focus(), 100);
}

// ── L2.3A CORE: scan → server request → live status ───────────────────────
// L2.3B (2026-09-01): removed the invented 6-minute client-side hard-stop.
// The AUTHORITATIVE deadline is the request document's own `expiresAt`
// field (server-set to +5 minutes, matching the "έως 5λ" UI label). At
// `expiresAt` the tablet UI switches to an "expired — needs admin check"
// state. Closing the modal is local-only (no DB mutation) — the server
// itself flips the request to `expired` on the next approve/reject
// attempt via its own TTL guard. Never automatically recreates or retries
// the redemption.
let _activeUnsub = null;
let _activeTimeout = null;   // schedules the UI flip at authoritative expiresAt

function _teardownActiveRequest() {
  if (_activeUnsub) { try { _activeUnsub(); } catch (_) {} _activeUnsub = null; }
  if (_activeTimeout) { clearTimeout(_activeTimeout); _activeTimeout = null; }
}

// Schedule the local UI flip AT the authoritative expiresAt from the
// request document. Does NOT mutate the request, does NOT retry, does NOT
// second-guess the server: at expiresAt we simply render "expired — needs
// admin verification" and the operator can close the modal locally. If
// the server later reports a terminal state via the subscription, that
// wins immediately.
function _scheduleExpiryFlip(expiresAtIsoOrMs, rewardLabel) {
  if (_activeTimeout) { clearTimeout(_activeTimeout); _activeTimeout = null; }
  const ms = typeof expiresAtIsoOrMs === 'number'
    ? expiresAtIsoOrMs
    : (expiresAtIsoOrMs ? new Date(expiresAtIsoOrMs).getTime() : NaN);
  if (!Number.isFinite(ms)) return;
  const delta = Math.max(0, ms - Date.now());
  _activeTimeout = setTimeout(() => {
    _renderApprovalOverlay('expired', { rewardLabel, needsAdminCheck: true });
    _playError();
    // Keep the listener alive — the server may still flip status to
    // approved/rejected via admin action, and we WANT to render that if
    // it lands. Only unsubscribe on explicit close.
  }, delta);
}

function closeApprovalOverlay() {
  _teardownActiveRequest();
  const ov = document.getElementById('qr-redeem-confirm'); if (ov) ov.style.display = 'none';
  // Card-QR reward picker container — clean up on close so a subsequent
  // approval overlay for a different flow doesn't render on top of stale buttons.
  document.getElementById('qrc-card-rewards')?.remove();
  if (typeof _releaseFocus === 'function') _releaseFocus();
}

// L2.3A hotfix (2026-08-31) — customer loyalty-card QR flow.
// The customer's Card-tab QR encodes the plain card string ("IP-ABC123").
// We call lookupCustomerByCardQr → render a masked customer + reward picker
// overlay → each reward tap fires createRedemptionRequestFromCard, then
// subscribes to the resulting request just like the 6-digit path.
async function _handleCardScan(cardQr) {
  if (!_tabletStoreId) { _showToast('❌ Δεν είσαι συνδεδεμένος ως tablet.'); return; }
  _teardownActiveRequest();
  _showApprovalOverlayLoading();
  try {
    const res = await lookupCustomerByCardQr(cardQr);
    if (!res.found) { _renderApprovalOverlay('error', { message: 'Δεν βρέθηκε πελάτης με αυτή την κάρτα.' }); _playError(); return; }
    if (res.blocked) { _renderApprovalOverlay('error', { message: 'Ο πελάτης είναι blocked.' }); _playError(); return; }
    _renderCardRewardPicker(cardQr, res);
  } catch (e) {
    _renderApprovalOverlay('error', { message: _friendlyErrorFor(e) });
    _playError();
  }
}

// Renders the picker inside the approval overlay: customer summary at the top,
// reward buttons in a scrollable list. Each reward button is a callable trigger.
function _renderCardRewardPicker(cardQr, res) {
  const overlay = document.getElementById('qr-redeem-confirm');
  if (!overlay) return;
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const errBox = document.getElementById('qrc-error');
  const btn = document.getElementById('qrc-confirm-btn');
  if (btn) btn.style.display = 'none';
  if (errBox) { errBox.textContent = ''; errBox.style.display = 'none'; }
  const p = res.projection || {};
  const rewards = (res.rewards || []).filter(r => r && r.id && Number.isFinite(r.cost) && r.cost > 0);
  setText('qrc-title', '💳 Επιλογή Ανταμοιβής');
  setText('qrc-customer', '👤 ' + (p.displayName || '—'));
  setText('qrc-reward', 'Διαθέσιμοι πόντοι: ' + (p.points || 0).toLocaleString('el-GR'));
  setText('qrc-pts', '');
  // Reward buttons — appended after the standard content in a dedicated
  // container. Cleared on any subsequent overlay render (close/state-change).
  let container = document.getElementById('qrc-card-rewards');
  if (!container) {
    container = document.createElement('div');
    container.id = 'qrc-card-rewards';
    container.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:16px;max-height:40vh;overflow-y:auto';
    // Insert before the error box for logical DOM order.
    const parent = errBox?.parentNode || overlay;
    parent.insertBefore(container, errBox || null);
  }
  container.innerHTML = '';
  const pts = Number(p.points || 0);
  for (const r of rewards) {
    const affordable = pts >= r.cost;
    const b = document.createElement('button');
    b.type = 'button';
    b.disabled = !affordable;
    b.textContent = `${r.title || 'Ανταμοιβή'} — ${r.cost} πόντοι` + (r.discount ? ` (${r.discount}€ έκπτωση)` : '');
    b.style.cssText = `padding:14px 18px;border-radius:12px;font-weight:800;font-family:inherit;font-size:.98rem;cursor:${affordable ? 'pointer' : 'not-allowed'};opacity:${affordable ? 1 : 0.45};background:${affordable ? '#8ae900' : '#333'};color:${affordable ? '#0a0a0a' : '#999'};border:none;text-align:left`;
    if (affordable) {
      b.onclick = async () => {
        // Immediate lock — the container-wide guard prevents rapid-fire.
        Array.from(container.querySelectorAll('button')).forEach(x => { x.disabled = true; x.style.opacity = 0.45; x.style.cursor = 'wait'; });
        try {
          const cRes = await createRedemptionRequestFromCard({ cardQrPayload: cardQr, rewardId: r.id });
          // Drop the picker and switch to pending state.
          container.remove();
          _renderApprovalOverlay('pending', cRes);
          _watchRequest(cRes.requestId);
          // Use the AUTHORITATIVE server-issued expiresAt — do not invent a
          // separate client policy. cRes.expiresAt is an ISO string from
          // createRedemptionRequestFromCard.
          _scheduleExpiryFlip(cRes.expiresAt, cRes.rewardLabel);
        } catch (e) {
          container.remove();
          _renderApprovalOverlay('error', { message: _friendlyErrorFor(e) });
          _playError();
        }
      };
    }
    container.appendChild(b);
  }
  if (!rewards.length) {
    // L2.3C explicit empty state — reuses the existing `.empty` visual
    // system from tablet.html (icon + title + supporting text) and adds
    // a local Close action so the operator can back out of the modal
    // without waiting or refreshing. Distinct from loading (which is the
    // "Έλεγχος κωδικού..." title before this handler runs), from error
    // (which uses _renderApprovalOverlay('error', …) in the catch above),
    // from insufficient-points (rewards exist but are all disabled by the
    // affordable check), and from server-side inactive/expired (which are
    // filtered before the tablet receives them).
    const empty = document.createElement('div');
    empty.setAttribute('data-l23c-empty', 'no-rewards');
    empty.setAttribute('role', 'status');
    empty.className = 'empty';
    empty.style.cssText = 'padding:24px 16px;text-align:center';
    empty.innerHTML =
      '<span class="e" aria-hidden="true">🎁</span>' +
      '<div style="font-weight:800;color:#eee;font-size:1.02rem;margin-bottom:6px">Δεν υπάρχουν διαθέσιμες προσφορές</div>' +
      '<div style="color:#aaa;font-size:.86rem;line-height:1.55">Δεν υπάρχει κάποια ενεργή προσφορά ή διαθέσιμη ανταμοιβή για αυτόν τον πελάτη αυτή τη στιγμή.</div>';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕ Κλείσιμο';
    closeBtn.setAttribute('data-l23c-empty-close', '1');
    closeBtn.style.cssText = 'margin-top:14px;padding:12px 20px;background:#8ae900;color:#0a0a0a;border:none;border-radius:12px;font-weight:800;cursor:pointer;font-family:inherit;font-size:.92rem';
    closeBtn.onclick = () => { closeApprovalOverlay(); };
    empty.appendChild(closeBtn);
    container.appendChild(empty);
  }
  overlay.style.display = 'flex';
  if (typeof _trapFocus === 'function') _trapFocus(overlay);
}

async function _sendScanRequest(code) {
  if (!/^\d{6}$/.test(code)) { _showToast('⚠️ Μη έγκυρος κωδικός.'); return; }
  if (!_tabletStoreId) { _showToast('❌ Δεν είσαι συνδεδεμένος ως tablet.'); return; }
  _teardownActiveRequest();
  _showApprovalOverlayLoading();
  try {
    const res = await createRedemptionRequest(code);
    _renderApprovalOverlay('pending', res);
    _watchRequest(res.requestId);
    // Use the AUTHORITATIVE server-issued expiresAt.
    _scheduleExpiryFlip(res.expiresAt, res.rewardLabel);
  } catch (e) {
    _renderApprovalOverlay('error', { message: _friendlyErrorFor(e) });
    _playError();
  }
}

function _friendlyErrorFor(e) {
  const c = e?.code || e?.details?.code || '';
  const m = e?.message || 'Unknown error';
  if (String(c).includes('permission-denied')) return 'Δεν έχεις δικαιώματα tablet.';
  if (String(c).includes('unauthenticated')) {
    // A Firebase-callable `unauthenticated` can mean EITHER the Auth ID
    // token is missing/expired OR the App Check token is missing/invalid.
    // Differentiate using the LIVE auth state so the error message points
    // the operator at the actual failure.
    const hasSession = !!(window._auth && window._auth.currentUser);
    if (hasSession) {
      return 'Πρόβλημα ασφάλειας συσκευής (App Check). Δοκίμασε ξανά. [code: unauth-app]';
    }
    return 'Συνεδρία έληξε — κάνε ξανά είσοδο. [code: unauth-session]';
  }
  if (String(c).includes('resource-exhausted')) return 'Πάρα πολλά scans — περίμενε 1 λεπτό.';
  if (String(c).includes('not-found')) return 'Ο κωδικός δεν υπάρχει.';
  if (String(c).includes('failed-precondition')) return m; // server business msgs are Greek
  // Unknown error: keep an already-Greek message, otherwise a safe generic —
  // never surface a raw English/technical string to the store operator.
  return /[Ͱ-Ͽ]/.test(m) ? m : 'Κάτι πήγε στραβά. Δοκίμασε ξανά.';
}

function _watchRequest(requestId) {
  _activeUnsub = subscribeToRequest(requestId, (evt) => {
    if (!evt) return;
    if (evt.status === 'pending') return;
    if (evt.status === 'approved') { _renderApprovalOverlay('approved', evt); _playSuccess(); _teardownActiveRequest(); return; }
    if (evt.status === 'rejected') { _renderApprovalOverlay('rejected', evt); _playError(); _teardownActiveRequest(); return; }
    if (evt.status === 'expired' || evt.status === 'missing') { _renderApprovalOverlay('expired', evt); _playError(); _teardownActiveRequest(); return; }
    if (evt.status === 'error') { _renderApprovalOverlay('error', { message: 'Απώλεια πρόσβασης — έλεγξε το ρόλο σου.' }); _teardownActiveRequest(); }
  });
}

function _showApprovalOverlayLoading() {
  const overlay = document.getElementById('qr-redeem-confirm');
  if (!overlay) return;
  // Strip any card-picker container from a prior scan.
  document.getElementById('qrc-card-rewards')?.remove();
  document.getElementById('qrc-title').textContent = 'Έλεγχος κωδικού...';
  document.getElementById('qrc-customer').textContent = '⏳';
  document.getElementById('qrc-reward').textContent = '';
  document.getElementById('qrc-pts').textContent = '';
  const errBox = document.getElementById('qrc-error');
  if (errBox) { errBox.textContent = ''; errBox.style.display = 'none'; }
  const btn = document.getElementById('qrc-confirm-btn');
  if (btn) btn.style.display = 'none';
  overlay.style.display = 'flex';
  if (typeof _trapFocus === 'function') _trapFocus(overlay);
}

function _renderApprovalOverlay(state, data) {
  const overlay = document.getElementById('qr-redeem-confirm');
  if (!overlay) return;
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const errBox = document.getElementById('qrc-error');
  const btn = document.getElementById('qrc-confirm-btn');
  if (btn) btn.style.display = 'none';
  if (errBox) { errBox.textContent = ''; errBox.style.display = 'none'; }
  if (state === 'pending') {
    setText('qrc-title', '⏳ Αναμονή έγκρισης από Admin');
    const p = data?.projection || {};
    setText('qrc-customer', '👤 ' + (p.displayName || '—'));
    setText('qrc-reward', data?.rewardLabel || '');
    const cost = data?.rewardCost || 0;
    if (cost > 0) setText('qrc-pts', '−' + cost + ' πόντοι από το υπόλοιπο');
    else if (cost < 0) setText('qrc-pts', '+' + (-cost) + ' πόντοι bonus');
    else setText('qrc-pts', '');
  } else if (state === 'approved') {
    setText('qrc-title', '✅ Εγκρίθηκε');
    setText('qrc-customer', 'Νέο υπόλοιπο: ' + (typeof data?.newPoints === 'number' ? data.newPoints.toLocaleString('el-GR') : '—') + ' πόντοι');
    setText('qrc-reward', ''); setText('qrc-pts', '');
  } else if (state === 'rejected') {
    setText('qrc-title', '❌ Απορρίφθηκε');
    setText('qrc-customer', data?.rejectReason ? ('Αιτία: ' + data.rejectReason) : 'Ο Admin απέρριψε το αίτημα.');
    setText('qrc-reward', ''); setText('qrc-pts', '');
  } else if (state === 'expired') {
    setText('qrc-title', '⏱️ Το αίτημα έληξε');
    // If we reached expiresAt without a server-side terminal event, the
    // request has NOT been finalized by the admin. Do NOT mutate it from
    // the tablet — the server flips it to `expired` on the next call.
    // Tell the operator to check the admin queue and offer a local Close.
    setText('qrc-customer',
      data?.needsAdminCheck
        ? 'Πέρασε ο χρόνος έγκρισης — έλεγξε την ουρά του Admin ή κλείσε αυτό το παράθυρο.'
        : 'Δοκίμασε ξανά με νέο κωδικό.');
    setText('qrc-reward', ''); setText('qrc-pts', '');
  } else if (state === 'error') {
    setText('qrc-title', 'Σφάλμα');
    if (errBox) { errBox.textContent = '⚠️ ' + (data?.message || 'Άγνωστο σφάλμα'); errBox.style.display = 'block'; }
    setText('qrc-customer', ''); setText('qrc-reward', ''); setText('qrc-pts', '');
  }
  overlay.style.display = 'flex';
  if (typeof _trapFocus === 'function') _trapFocus(overlay);
}

async function tabletLogout() {
  _teardownActiveRequest();
  try { await window._tabletSignOut(window._auth); } catch (_) {}
  _tabletActorUid = null; _tabletStoreId = null; _tabletStoreName = '—';
  document.getElementById('tablet-login').style.display = 'flex';
  document.getElementById('result-screen')?.classList.remove('show');
  document.getElementById('idle')?.classList.remove('hidden');
}

function setOnline(on) {
  const dot = document.getElementById('cdot');
  const txt = document.getElementById('ctxt');
  if (dot) dot.className = 'conn-dot ' + (on ? 'ok' : 'err');
  if (txt) txt.textContent = on ? 'Online' : 'Offline';
}
window.addEventListener('online', () => setOnline(true));
window.addEventListener('offline', () => setOnline(false));
setOnline(navigator.onLine);

// Admin route guard — refuse any in-app admin navigation.
function _guardAdminNav() {
  document.addEventListener('click', (ev) => {
    const a = ev.target?.closest?.('a[href*="/admin"]');
    if (!a) return;
    ev.preventDefault();
    _showToast('❌ Το tablet δεν έχει πρόσβαση στο Admin.');
  }, { capture: true });
}
_guardAdminNav();

void _tabletActorUid; // exposed via window.TABLET_BUILD_TAG for debugging

// ── Global exports for inline HTML handlers ────────────────────────────────
window.tabletLogin = tabletLogin;
window.tabletLogout = tabletLogout;
window.openQRScanner = openQRScanner;
window.closeQRScanner = closeQRScanner;
window.doSearch = doSearch;
window.searchByCard = searchByCard;
window.goBack = goBack;
window.closeApprovalOverlay = closeApprovalOverlay;
// Neutralized legacy handlers — old inline HTML may still call these.
window.openRedeemPanel = () => _showToast('ℹ️ Η εξαργύρωση γίνεται πλέον με QR από τον πελάτη.');
window.closeRedeemPanel = () => {};
window.confirmTabletRedeem = () => _showToast('ℹ️ Χειροκίνητη εξαργύρωση απενεργοποιήθηκε.');
window.confirmQRRedeem = () => {};
window.closeQRRedeemConfirm = closeApprovalOverlay;
window.handleRedeemQR = _sendScanRequest;
window.handleOfferQR = _sendScanRequest;
window.switchToManualSearch = () => { closeQRScanner(); document.getElementById('sinput')?.focus(); };
window.togglePassVis = (id) => {
  const el = document.getElementById(id); if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
};

// CSP-safe event delegation — replaces inline on* handlers. Runs after the
// window.* handlers above are assigned.
installDelegation();

window.dispatchEvent(new Event('tablet-ready'));
