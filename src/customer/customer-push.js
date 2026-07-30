// ═══════════════════════════════════════════════════════════════════════════
//  CUSTOMER PUSH HANDLERS
//
//  Owns the FCM token lifecycle for a logged-in customer:
//   • _enablePush  — permission prompt → getToken → write to ipear_customers/
//                    {id}.fcmToken + send confirmation push
//   • _disablePush — clear fcmToken on customer doc + flip UI
//   • _togglePush  — route to enable/disable based on current state
//
//  WHY THIS FILE EXISTS (not firebase-init.js):
//   firebase-init.js is shared by main.js (customer), admin-main.js, and
//   tablet-main.js. Push handlers are customer-only — they write to the
//   logged-in customer's doc (state.foundCustomer.id), which is never bound
//   on cashier surfaces. Living in shared init created two risks:
//     1. State pollution (10 state.foundCustomer refs in shared module)
//     2. Accidental invocation on /admin or /tablet (defended by surface
//        guards in the old version, but defense-in-depth is brittle)
//   Sprint 2 Epic 2.2 moved them here. firebase-init.js now only exposes
//   the FCM primitives (_messaging, getToken) the customer code consumes.
//
//  IMPORTED BY: src/main.js (for side effects — the file binds window._*
//  globals on load). Never imported by admin-main.js or tablet-main.js.
// ═══════════════════════════════════════════════════════════════════════════

import { getToken } from 'firebase/messaging';
import { state } from '../state.js';
import { showToast, _WORKER_URL } from '../utils.js';
import { VAPID_KEY } from '../firebase-init.js';
import { logger } from '../logger.js';

let _pushBusy = false;

function _withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

window._enablePush = async () => {
  if (_pushBusy) return;
  const _messaging = window._messaging;
  if (!_messaging) return showToast('❌ Messaging μη διαθέσιμο', 'red');
  if (!VAPID_KEY || VAPID_KEY === 'YOUR_FCM_VAPID_KEY') {
    return showToast('⚠️ VAPID key δεν έχει οριστεί', 'red');
  }

  // iOS Safari does NOT deliver web push unless the site is installed as a
  // PWA (Home Screen). Without this check the user grants permission, we
  // store a token, the toggle shows "on" — but no notification ever lands.
  // Apple has required PWA-install for web push since iOS 16.4 and this is
  // not negotiable, so block clearly here rather than letting the user blame
  // the app.
  const _ua = navigator.userAgent || '';
  const _isIOS = /iphone|ipad|ipod/i.test(_ua);
  const _isStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;
  if (_isIOS && !_isStandalone) {
    return showToast(
      '📱 Για iPhone: πρόσθεσε πρώτα την εφαρμογή στην Αρχική Οθόνη (Safari → Κοινοποίηση → Προσθήκη στην Αρχική Οθόνη). Μετά άνοιξέ την από το εικονίδιο και ενεργοποίησε ξανά.',
      'red',
    );
  }

  _pushBusy = true;
  const { _setPushUI, _PUSH_TIMEOUT_MS } = await import('../push-notifications.js');
  _setPushUI('loading');

  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      _setPushUI(false);
      _pushBusy = false;
      return showToast('❌ Δεν δόθηκε άδεια notifications', 'red');
    }

    // Let Firebase Messaging auto-register firebase-messaging-sw.js at its
    // default scope (/firebase-cloud-messaging-push-scope/). This does NOT
    // conflict with sw-customer.js which lives at root scope /.
    const token = await _withTimeout(
      getToken(_messaging, { vapidKey: VAPID_KEY }),
      _PUSH_TIMEOUT_MS,
    );

    if (!token) {
      _setPushUI(false);
      _pushBusy = false;
      return showToast('❌ Αποτυχία λήψης token', 'red');
    }

    if (state.foundCustomer?.id && window._db) {
      await _withTimeout(
        window._updateDoc(
          window._doc(window._db, 'ipear_customers', state.foundCustomer.id),
          { fcmToken: token, fcmUpdatedAt: new Date().toISOString() },
        ),
        _PUSH_TIMEOUT_MS,
      );
      state.foundCustomer.fcmToken = token;
    }

    _setPushUI(true);
    showToast('✅ Push notifications ενεργοποιήθηκαν!', 'green');

    // Confirmation push — proves end-to-end delivery (SW registered, FCM
    // accepted the token, OS surfaces the notification). Uses the worker's
    // self-push branch (idToken auth): server verifies the token, resolves
    // OUR uid, looks up OUR fcmToken from Firestore, pushes only to that.
    // The `tokens` array is intentionally not sent — the worker ignores it
    // in self-push mode so a customer can't aim a push at anyone else.
    (async () => {
      try {
        const idToken = await window._auth?.currentUser?.getIdToken();
        if (!idToken) return;
        await fetch(_WORKER_URL + '/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken,
            title: '🍐 iPear Loyalty',
            message: 'Έτοιμος για ειδοποιήσεις! Θα ενημερώνεσαι πρώτος για προσφορές & πόντους.',
          }),
        });
      } catch (_) {}
    })();
  } catch (e) {
    const { _setPushUI: resetUI } = await import('../push-notifications.js');
    resetUI(false);
    // Map known FCM error codes to user-friendly Greek copy. Raw e.message
    // is something like "FirebaseError: Messaging: A problem occurred while
    // subscribing the user to FCM (messaging/permission-blocked). (...)" —
    // useless to a real user. logger.error keeps the raw form for ops.
    const friendly =
        e.message === 'timeout'                                  ? '⏳ Η ενεργοποίηση καθυστερεί, δοκιμάστε ξανά'
      : e.code === 'messaging/permission-blocked'                ? '🔕 Έχεις μπλοκάρει τα notifications από τις ρυθμίσεις του browser. Άνοιξε τις άδειες της σελίδας και δοκίμασε ξανά.'
      : e.code === 'messaging/permission-default'                ? '🔕 Δεν δόθηκε άδεια. Δοκίμασε ξανά και πάτησε "Επιτρέπεται".'
      : e.code === 'messaging/failed-service-worker-registration' ? '🔄 Πρόβλημα service worker. Κάνε hard refresh (Cmd/Ctrl+Shift+R) και δοκίμασε ξανά.'
      : e.code === 'messaging/unsupported-browser'               ? '🚫 Ο browser σου δεν υποστηρίζει push notifications.'
      : e.code === 'messaging/token-subscribe-failed'            ? '📡 Αποτυχία εγγραφής. Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά.'
      : e.code === 'messaging/token-subscribe-no-token'          ? '📡 Δεν δόθηκε token από το FCM. Δοκίμασε ξανά σε λίγο.'
      : e.name === 'AbortError'                                  ? '⏳ Λήξη χρόνου, δοκίμασε ξανά.'
      :                                                            '❌ Σφάλμα ενεργοποίησης notifications.';
    showToast(friendly, 'red');
    logger.error('[push enable]', e.code || e.name, e.message);
  } finally {
    _pushBusy = false;
  }
};

window._disablePush = async () => {
  if (_pushBusy) return;
  _pushBusy = true;
  const { _setPushUI } = await import('../push-notifications.js');
  _setPushUI('loading');

  try {
    if (state.foundCustomer?.id && window._db) {
      await _withTimeout(
        window._updateDoc(
          window._doc(window._db, 'ipear_customers', state.foundCustomer.id),
          { fcmToken: '', fcmUpdatedAt: new Date().toISOString() },
        ),
        5000,
      );
      state.foundCustomer.fcmToken = '';
    }
    _setPushUI(false);
    showToast('🔕 Ειδοποιήσεις απενεργοποιήθηκαν', 'green');
  } catch (e) {
    _setPushUI(true);
    showToast('❌ ' + e.message, 'red');
  } finally {
    _pushBusy = false;
  }
};

window._togglePush = () => {
  if (state.foundCustomer?.fcmToken) window._disablePush();
  else window._enablePush();
};
