// ═══════════════════════════════════════════════════════════════════════════
//  SERVICE WORKER REGISTRATION (auto-update mechanism)
//
//  Registers /sw-customer.js at root scope so the app can push a new bundle
//  to already-open tabs without waiting for the user to close/re-open.
//
//  Extracted from the old push-notifications.js during the push+PWA-install
//  strip. Kept here so main.js has a single entry point to boot the SW.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from './logger.js';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  sessionStorage.removeItem('ipear_sw_reloading');

  window.addEventListener('load', () => {
    // Compatibility cleanup: older builds registered a service worker at
    // `/sw.js`, which no longer exists — Cloudflare Pages now answers that
    // path with the SPA fallback (text/html), so the browser's periodic
    // update of the stale registration fails with
    // "unsupported MIME type ('text/html')". Unregister ONLY that obsolete
    // `/sw.js` registration; never touch the active `sw-customer.js` one, so
    // there is no cache/data loss and no overlapping workers.
    try {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const reg of regs) {
          const url = (reg.active || reg.waiting || reg.installing)?.scriptURL || '';
          if (/\/sw\.js(\?|$)/.test(url) && !url.includes('sw-customer.js')) {
            reg.unregister().then((ok) => logger.log('[SW] removed stale /sw.js registration:', ok))
                            .catch((e) => logger.warn('[SW] stale /sw.js unregister failed:', e?.message || e));
          }
        }
      }).catch(() => {});
    } catch (_) { /* never block SW boot on cleanup */ }

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
