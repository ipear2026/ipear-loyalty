// Regression tests for the CSP-safe event-delegation dispatcher
// (src/dom-delegate.js). These prove the Phase-19 refactor — which replaced
// every inline on* handler with data-action / data-key-action / data-enter-focus
// attributes so the CSP can drop `script-src 'unsafe-inline'` — dispatches to
// the same window.* handlers with the same arguments the inline handlers used.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installDelegation } from '../src/dom-delegate.js';

// Install exactly ONCE: listeners live on `document`, which persists across
// tests in jsdom. Re-installing per test would stack listeners and multi-fire.
installDelegation(document);

function fire(el, type, init = {}) {
  el.dispatchEvent(new (type === 'keydown' ? KeyboardEvent : MouseEvent)(type, { bubbles: true, cancelable: true, ...init }));
}

describe('dom-delegate — click (data-action)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

  it('calls window.<action> with no args', () => {
    window.fnA = vi.fn();
    document.body.innerHTML = '<button data-action="fnA">x</button>';
    fire(document.querySelector('button'), 'click');
    expect(window.fnA).toHaveBeenCalledTimes(1);
    expect(window.fnA).toHaveBeenCalledWith();
  });

  it('passes a string arg verbatim (no numeric coercion)', () => {
    window.fnTab = vi.fn();
    document.body.innerHTML = '<div data-action="fnTab" data-arg="home"></div>';
    fire(document.querySelector('div'), 'click');
    expect(window.fnTab).toHaveBeenCalledWith('home');
  });

  it('coerces a numeric arg to Number (e.g. navigateOfferQR(-1))', () => {
    window.fnNum = vi.fn();
    document.body.innerHTML = '<div data-action="fnNum" data-arg="-1"></div>';
    fire(document.querySelector('div'), 'click');
    expect(window.fnNum).toHaveBeenCalledWith(-1);
  });

  it('passes up to three ordered args (arg/arg2/arg3)', () => {
    window.fnRedeem = vi.fn();
    document.body.innerHTML = '<button data-action="fnRedeem" data-arg="r1" data-arg2="Label" data-arg3="instore"></button>';
    fire(document.querySelector('button'), 'click');
    expect(window.fnRedeem).toHaveBeenCalledWith('r1', 'Label', 'instore');
  });

  it('dispatches from a child click via closest()', () => {
    window.fnClose = vi.fn();
    document.body.innerHTML = '<button data-action="fnClose"><span class="ico">x</span></button>';
    fire(document.querySelector('.ico'), 'click');
    expect(window.fnClose).toHaveBeenCalledTimes(1);
  });

  it('binds `this` to the data-action element (copy-button feedback path)', () => {
    let seen = null;
    window.fnThis = function () { seen = this; };
    document.body.innerHTML = '<button data-action="fnThis" data-arg="CODE1">c</button>';
    const btn = document.querySelector('button');
    fire(btn, 'click');
    expect(seen).toBe(btn);
  });

  it('warns but does not throw when the handler is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.body.innerHTML = '<button data-action="doesNotExist">x</button>';
    expect(() => fire(document.querySelector('button'), 'click')).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe('dom-delegate — keydown (data-key-action / data-enter-focus)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

  it('fires on Enter with karg args', () => {
    window.kTab = vi.fn();
    document.body.innerHTML = '<div data-key-action="kTab" data-karg="rewards"></div>';
    fire(document.querySelector('div'), 'keydown', { key: 'Enter' });
    expect(window.kTab).toHaveBeenCalledWith('rewards');
  });

  it('ignores Space unless data-key-space="1"', () => {
    window.kNoSpace = vi.fn();
    window.kSpace = vi.fn();
    document.body.innerHTML =
      '<div id="a" data-key-action="kNoSpace"></div>' +
      '<div id="b" data-key-action="kSpace" data-key-space="1"></div>';
    fire(document.getElementById('a'), 'keydown', { key: ' ' });
    fire(document.getElementById('b'), 'keydown', { key: ' ' });
    expect(window.kNoSpace).not.toHaveBeenCalled();
    expect(window.kSpace).toHaveBeenCalledTimes(1);
  });

  it('data-enter-focus moves focus to the target element on Enter only', () => {
    document.body.innerHTML =
      '<input id="src" data-enter-focus="dst"><input id="dst">';
    const src = document.getElementById('src');
    fire(src, 'keydown', { key: ' ' });
    expect(document.activeElement).not.toBe(document.getElementById('dst'));
    fire(src, 'keydown', { key: 'Enter' });
    expect(document.activeElement).toBe(document.getElementById('dst'));
  });

  it('an element with BOTH click and keydown uses disjoint arg namespaces (no double-fire)', () => {
    window.both = vi.fn();
    document.body.innerHTML =
      '<div data-action="both" data-arg="c" data-key-action="both" data-karg="k" data-key-space="1"></div>';
    const el = document.querySelector('div');
    fire(el, 'click');
    expect(window.both).toHaveBeenLastCalledWith('c');
    fire(el, 'keydown', { key: 'Enter' });
    expect(window.both).toHaveBeenLastCalledWith('k');
    expect(window.both).toHaveBeenCalledTimes(2);
  });

  it('ignores non-activating keys', () => {
    window.kX = vi.fn();
    document.body.innerHTML = '<div data-key-action="kX"></div>';
    fire(document.querySelector('div'), 'keydown', { key: 'Tab' });
    expect(window.kX).not.toHaveBeenCalled();
  });
});
