// @vitest-environment jsdom
// Reproduces + guards the production "Κορυφαίοι Πελάτες / Φόρτωση…" infinite
// spinner, and proves the fixed lifecycle: LOADING → SUCCESS | EMPTY | ERROR+RETRY,
// with controlled re-subscription and no stale/detached rendering.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadLeaderboard, stopLbListener, _retryLeaderboard } from '../src/customer/ui/leaderboard-ui.js';
import { state } from '../src/state.js';

function setContainer() { document.body.innerHTML = '<div id="lb-container"><div class="lb-skeleton" aria-busy="true">Φόρτωση leaderboard</div></div>'; }
function lbHtml() { return document.getElementById('lb-container').innerHTML; }

// Controllable onSnapshot stub: capture next/error callbacks to fire manually,
// and count subscribe/unsubscribe calls to prove no listener stacking.
let _snapNext, _snapErr, _unsubCalls, _subCalls;
function installFirestore({ autoFire = null } = {}) {
  _unsubCalls = 0; _subCalls = 0;
  window._db = {};
  window._doc = (_db, col, id) => ({ col, id });
  window._onSnapshot = (_ref, next, err) => {
    _subCalls++;
    _snapNext = next; _snapErr = err;
    if (autoFire === 'empty') next({ exists: () => false });
    if (autoFire && autoFire.data) next({ exists: () => true, data: () => autoFire.data });
    return () => { _unsubCalls++; };
  };
}

beforeEach(() => { vi.useFakeTimers(); setContainer(); state.foundCustomer = null; stopLbListener(); });
afterEach(()  => { stopLbListener(); vi.useRealTimers(); delete window._db; delete window._doc; delete window._onSnapshot; });

describe('leaderboard lifecycle', () => {
  it('REGRESSION: a first snapshot that never arrives → RETRY state, never an infinite spinner', () => {
    installFirestore();                 // listener attaches but never calls back
    loadLeaderboard();
    expect(lbHtml()).toContain('Φόρτωση');        // LOADING
    vi.advanceTimersByTime(10000);                // watchdog elapses
    expect(lbHtml()).not.toContain('Φόρτωση…');   // spinner replaced
    expect(lbHtml()).toContain('Δοκίμασε ξανά');  // ERROR + RETRY affordance
  });

  it('SUCCESS: a snapshot with rows renders the leaderboard and clears the watchdog', () => {
    installFirestore();
    loadLeaderboard();
    _snapNext({ exists: () => true, data: () => ({ top: [{ name: 'Α.', totalPoints: 900 }, { name: 'Β.', totalPoints: 500 }], total: 2 }) });
    expect(lbHtml()).toContain('pts');
    vi.advanceTimersByTime(10000);
    expect(lbHtml()).not.toContain('Δοκίμασε ξανά');  // watchdog did NOT fire after success
  });

  it('EMPTY: a snapshot with no doc shows the ετοιμάζεται state (not a spinner)', () => {
    installFirestore();
    loadLeaderboard();
    _snapNext({ exists: () => false });
    expect(lbHtml()).toContain('ετοιμάζεται');
  });

  it('REGRESSION: re-entry after the container is re-rendered re-paints cached data (old guard left it stuck)', () => {
    installFirestore();
    loadLeaderboard();
    _snapNext({ exists: () => true, data: () => ({ top: [{ name: 'Α.', totalPoints: 900 }], total: 1 }) });
    expect(lbHtml()).toContain('pts');
    // Simulate a Profile re-render wiping the container back to a skeleton:
    setContainer();
    expect(lbHtml()).toContain('Φόρτωση leaderboard');
    loadLeaderboard();                 // was a no-op before the fix (→ stuck skeleton)
    expect(lbHtml()).toContain('pts'); // now re-paints cached data into the fresh node
  });

  it('error callback with no customer context → RETRY state', () => {
    installFirestore();
    loadLeaderboard();
    _snapErr({ message: 'permission-denied' });
    expect(lbHtml()).toContain('Δοκίμασε ξανά');
  });

  it('_retryLeaderboard unsubscribes the old listener before re-subscribing (no duplicates)', () => {
    installFirestore();
    loadLeaderboard();
    _snapErr({ message: 'unavailable' });
    _retryLeaderboard();
    expect(_unsubCalls).toBe(1);       // old listener torn down exactly once
    expect(_subCalls).toBe(2);         // re-subscribed exactly once (no stacking)
    expect(lbHtml()).toContain('Φόρτωση');  // fresh LOADING after re-subscribe
  });

  it('LISTENER QA: repeated loadLeaderboard (profile re-entry / keepalive) never stacks listeners', () => {
    installFirestore();
    loadLeaderboard();
    _snapNext({ exists: () => true, data: () => ({ top: [{ name: 'Α.', totalPoints: 10 }], total: 1 }) });
    loadLeaderboard(); loadLeaderboard(); setContainer(); loadLeaderboard();
    expect(_subCalls).toBe(1);         // still exactly ONE active subscription
    expect(_unsubCalls).toBe(0);       // nothing leaked
    // and a proper teardown unsubscribes exactly once:
    stopLbListener();
    expect(_unsubCalls).toBe(1);
  });
});
