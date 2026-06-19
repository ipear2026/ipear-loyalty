import { logger } from './logger.js';
import { state } from './state.js';
import { showToast } from './utils.js';

// ════════════════════════════════════════
//  PUSH NOTIFICATION UI STATE MACHINE
//  States: off → loading → on | error(→off)
// ════════════════════════════════════════
const _PUSH_TIMEOUT_MS = 20000;

export function _setPushUI(mode) {
  const btn = document.getElementById('push-btn');
  const desc = btn?.parentElement?.querySelector('p');
  if (!btn) return;
  btn.disabled = false;
  btn.style.opacity = '';
  if (mode === 'on' || mode === true) {
    btn.innerHTML = '✅ Ειδοποιήσεις Ενεργές';
    btn.style.background = 'linear-gradient(135deg,#6bb800,#8ae900)';
    btn.style.color = '#111111';
    btn.style.border = 'none';
    btn.dataset.pushState = 'on';
    if (desc) desc.innerHTML = 'Οι ειδοποιήσεις είναι <strong>ενεργοποιημένες</strong>. Θα λαμβάνεις προσφορές, bonus πόντους και ενημερώσεις. Πάτησε για απενεργοποίηση.';
  } else if (mode === 'loading') {
    btn.innerHTML = '<div class="spin" style="width:18px;height:18px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:8px"></div>Ενεργοποίηση…';
    btn.disabled = true;
    btn.style.opacity = '.7';
    btn.dataset.pushState = 'loading';
  } else {
    btn.innerHTML = '<span style="font-size:1rem">🔔</span> Ενεργοποίηση Ειδοποιήσεων';
    btn.style.background = 'linear-gradient(135deg,#6bb800,#8ae900)';
    btn.style.color = '#111111';
    btn.style.border = 'none';
    btn.dataset.pushState = 'off';
    if (desc) desc.innerHTML = 'Ενεργοποίησε τις ειδοποιήσεις για να λαμβάνεις προσφορές, bonus πόντους και ενημερώσεις κατευθείαν στην οθόνη σου.';
  }
}

export { _PUSH_TIMEOUT_MS };

// ── Re-sync push button to ground-truth state ──
export function _syncPushState() {
  if (!('Notification' in window)) return;
  const section = document.getElementById('push-section');
  if (!section) return;
  if (Notification.permission === 'denied') {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  const granted = Notification.permission === 'granted';
  const hasToken = !!(state.foundCustomer?.fcmToken);
  _setPushUI(granted && hasToken);
}

// ── Push onboarding (shown once after registration) ──
export function _showPushOnboarding() {
  const ov = document.getElementById('push-onboard');
  if (ov) ov.style.display = 'flex';
}
export function _dismissPushOnboard() {
  const ov = document.getElementById('push-onboard');
  if (ov) ov.style.display = 'none';
}
export async function _acceptPushOnboard() {
  _dismissPushOnboard();
  try {
    if (window._enablePush) await window._enablePush();
  } catch(e) {
    logger.warn('[push-onboard]', e);
    showToast('⚠️ Δεν ήταν δυνατή η ενεργοποίηση ειδοποιήσεων.', 'red');
  }
}

// ════════════════════════════════════════
//  SERVICE WORKER (auto-update mechanism)
// ════════════════════════════════════════
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  sessionStorage.removeItem('ipear_sw_reloading');

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw-customer.js')
      .then(reg => {
        if (reg.waiting) {
          reg.waiting.postMessage('SKIP_WAITING');
        }
        reg.addEventListener('updatefound', () => {
          const newSW = reg.installing;
          if (!newSW) return;
          newSW.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
              newSW.postMessage('SKIP_WAITING');
            }
          });
        });
      })
      .catch(e => logger.warn('[SW] failed', e));

    // Guard SW-driven reloads while the user is mid-redemption: a reload
    // tears down the active QR/code and the customer has to re-tap reward.
    // The flag is set/cleared by main.js around the redemption lifecycle.
    function _safeToReload() {
      if (sessionStorage.getItem('ipear_sw_reloading')) return false;
      if (typeof window._safeToReloadForSW === 'function' && !window._safeToReloadForSW()) {
        logger.log('[SW] reload deferred — redemption in progress');
        // Try again on next event; if user finishes / cancels redeem,
        // the next controllerchange or SW_UPDATED message will fire fresh.
        return false;
      }
      return true;
    }

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!_safeToReload()) return;
      sessionStorage.setItem('ipear_sw_reloading', '1');
      logger.log('[SW] New service worker activated — reloading for fresh code');
      window.location.reload();
    });

    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'SW_UPDATED') {
        logger.log('[SW] Received SW_UPDATED from service worker, version:', e.data.version);
        if (!_safeToReload()) return;
        sessionStorage.setItem('ipear_sw_reloading', '1');
        window.location.reload();
      }
    });
  });
}
