import { getDb, doc, setDoc, onSnapshot } from '../services/firebase.js';
import { authState } from './auth-state.js';
import { toast } from './ui.js';
import { logger } from '../logger.js';

let _unsub = null;
let _active = false;

export function startMaintenanceListener() {
  if (_unsub || window.DEMO) return;
  try {
    const db = getDb();
    const ref = doc(db, 'settings', 'system');
    _unsub = onSnapshot(ref, snap => {
      if (!snap.exists()) { _updateUI(false); return; }
      const data = snap.data();
      _active = !!data.maintenance;
      _updateUI(_active);
    }, err => logger.warn('[maintenance] listener error:', err));
  } catch (e) {
    logger.warn('[maintenance] start failed:', e.message);
  }
}

export function stopMaintenanceListener() {
  if (!_unsub) return;
  try { _unsub(); } catch (_) {}
  _unsub = null;
  _active = false;
}

function _updateUI(active) {
  const wrap = document.getElementById('kill-switch-wrap');
  const toggle = document.getElementById('ks-toggle');
  const text = document.getElementById('ks-status-text');
  if (!wrap) return;
  if (active) {
    wrap.classList.add('active-maint');
    toggle.classList.add('on');
    text.textContent = 'ΕΝΕΡΓΟ — οι εξαργυρώσεις είναι απενεργοποιημένες σε όλα τα κανάλια';
  } else {
    wrap.classList.remove('active-maint');
    toggle.classList.remove('on');
    text.textContent = 'Απενεργοποιημένο — οι εξαργυρώσεις λειτουργούν κανονικά';
  }
}

export async function toggleKillSwitch() {
  if (!authState.authenticated) return;
  const newVal = !_active;
  const msg = newVal
    ? 'Θέλεις σίγουρα να ΕΝΕΡΓΟΠΟΙΗΣΕΙΣ τη Λειτουργία Συντήρησης;\n\nΟι εξαργυρώσεις θα απενεργοποιηθούν σε ΟΛΑ τα κανάλια (customer app, tablet).'
    : 'Απενεργοποίηση Λειτουργίας Συντήρησης;\n\nΟι εξαργυρώσεις θα ξαναλειτουργήσουν κανονικά.';
  if (!confirm(msg)) return;
  try {
    const db = getDb();
    await setDoc(doc(db, 'settings', 'system'), {
      maintenance: newVal,
      maintenanceUpdatedAt: new Date().toISOString(),
      maintenanceUpdatedBy: authState.actorUid || 'admin',
    });
    toast(newVal ? '🔴 Λειτουργία Συντήρησης ΕΝΕΡΓΗ' : '✅ Λειτουργία Συντήρησης ΑΠΕΝΕΡΓΟΠΟΙΗΘΗΚΕ', newVal ? 'error' : 'success');
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  }
}
