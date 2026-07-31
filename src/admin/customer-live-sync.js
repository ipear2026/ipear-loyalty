// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Live customer sync (formerly push-listener.js)
//
//  Watches ipear_customers and broadcasts change events to admin-main so its
//  in-memory `_allCustRows` cache (used by client-side search filter) stays
//  fresh while the admin has the tab open.
//
//  Push-specific responsibilities (KPI counters, subscribed-customers table,
//  bell icons) were stripped when the app dropped push notifications. Only
//  the cache-sync broadcast remains — without it, live customer edits made
//  by other admins or automated flows wouldn't reflect in this admin's
//  search results until a full reload.
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../logger.js';

const DB = () => window._db;

let _ctx = {
  // Called for each modified customer doc so admin-main can refresh its
  // _allCustRows cache.
  onCustomerChange: (_id, _data) => {},
};

export function initCustomerLiveSync(config) {
  _ctx = { ..._ctx, ...config };
}

let _unsub = null;

export function startCustomerLiveSync() {
  if (_unsub || window.DEMO) return;
  const db = DB();
  if (!db) return;

  _unsub = window._onSnapshot(
    window._col(db, 'ipear_customers'),
    (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'modified') {
          _ctx.onCustomerChange(change.doc.id, change.doc.data());
        }
      });
    },
    (err) => logger.warn('[customer-live-sync] error:', err)
  );
}

export function stopCustomerLiveSync() {
  if (_unsub) {
    try {
      _unsub();
    } catch {
      /* ignore */
    }
    _unsub = null;
  }
}
