// ═══════════════════════════════════════════════════════════════════════════
//  Customer UI — Shared helpers
//
//  Extracted from src/ui-renderers.js during the Sprint 3 god-module split.
//  Single home for the XSS-safe <img> factories shared by rewards-ui.js and
//  offers-ui.js — keeps the HIGH-3 security audit fix in one place instead
//  of getting duplicated across the new modules.
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
//  HIGH-3: Safe <img> factory.
//
//  Building the <img> via DOM API (createElement + property assignment) means
//  the browser handles every attribute escape — no string interpolation, no
//  hand-rolled `onerror=` template, no chance of attribute breakout from
//  admin-supplied `emoji` or `imageUrl`. Returns a real Element; callers can
//  either appendChild it or read `.outerHTML` (which is also safe because the
//  serializer escapes attributes when stringifying).
//
//  Used by rewards-ui.js (rw-img / rw-full-img) and offers-ui.js (op-img /
//  ocf-img / os-img). The cls argument doubles as the placeholder class via
//  cls + '-placeholder' on error fallback, so CSS for both states lives next
//  to the rendering module that owns the class prefix.
// ═══════════════════════════════════════════════════════════════════════════
export function _safeImgEl(cls, src, emoji) {
  const safeSrc = typeof src === 'string' ? src : '';
  const isData = safeSrc.startsWith('data:');
  const img = document.createElement('img');
  img.className = cls + (isData ? ' loaded' : '');
  img.src = safeSrc;
  img.alt = '';
  if (!isData) img.loading = 'lazy';
  img.decoding = 'async';
  const ph = cls + '-placeholder';
  const em = String(emoji || '🎁');
  img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
  img.addEventListener('error', () => {
    const d = document.createElement('div');
    d.className = ph;
    d.textContent = em;
    img.replaceWith(d);
  }, { once: true });
  return img;
}

// Module-scope helper for string-fragment callers.
// Safe because _safeImgEl never uses innerHTML or hand-rolled attribute injection.
export function _safeImgTag(cls, src, emoji) {
  return _safeImgEl(cls, src, emoji).outerHTML;
}
