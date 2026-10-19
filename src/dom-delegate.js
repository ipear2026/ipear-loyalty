// ═══════════════════════════════════════════════════════════════════════════
//  dom-delegate.js — CSP-safe event delegation (replaces inline on* handlers).
//
//  Lets markup drive behavior without `script-src 'unsafe-inline'`:
//    data-action="fn"                       → click → window.fn()
//    data-action="fn" data-arg="x"          → click → window.fn('x')  (coerced)
//    data-action="fn" data-arg data-arg2    → window.fn(a, b)
//    data-key-action="fn" data-karg="x"     → Enter (+Space if data-key-space="1")
//    data-enter-focus="elementId"           → Enter → focus(#elementId)
//
//  Click matches [data-action]; keydown matches [data-key-action]/[data-enter-focus]
//  — disjoint sets, so an element may carry both without double-firing.
//  Handler functions remain the existing window.* globals (unchanged).
// ═══════════════════════════════════════════════════════════════════════════

function _coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (v !== '' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
function _argsFrom(el, keys) {
  const a = [];
  for (const k of keys) if (el.dataset[k] !== undefined) a.push(_coerce(el.dataset[k]));
  return a;
}
function _call(name, args, el) {
  const fn = window[name];
  if (typeof fn !== 'function') {
    (window.logger && window.logger.warn ? window.logger.warn : console.warn)('[delegate] no handler:', name);
    return;
  }
  // `this` === the element carrying data-action, so handlers that formerly
  // received the inline `this` (e.g. a button to show "copied" feedback) keep
  // working. Existing handlers that ignore `this` are unaffected.
  fn.apply(el, args);
}

export function installDelegation(root = document) {
  // Click → data-action
  root.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-action]');
    if (!el) return;
    e.preventDefault();
    _call(el.dataset.action, _argsFrom(el, ['arg', 'arg2', 'arg3']), el);
  });
  // Keydown (Enter, optionally Space) → data-key-action / data-enter-focus
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest && e.target.closest('[data-key-action],[data-enter-focus]');
    if (!el) return;
    if (el.dataset.enterFocus) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const t = document.getElementById(el.dataset.enterFocus);
      if (t) t.focus();
      return;
    }
    // data-key-action: Enter always; Space only when data-key-space="1"
    if (e.key === ' ' && el.dataset.keySpace !== '1') return;
    e.preventDefault();
    _call(el.dataset.keyAction, _argsFrom(el, ['karg', 'karg2', 'karg3']), el);
  });
}
