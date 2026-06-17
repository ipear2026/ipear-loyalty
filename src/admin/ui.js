// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Shared UI helpers (toast + modal close)
//  Imported by admin-main.js and any extracted admin/* module that needs
//  to report status or dismiss the current modal.
// ═══════════════════════════════════════════════════════════════════════════

let _toastTimer;

export function toast(message, type = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'show ' + type;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.className = '';
  }, 3500);
}

export function closeM() {
  document.querySelectorAll('.modal-bg').forEach((m) => m.classList.remove('show'));
  // Reset two-step modals back to template list
  ['me', 'ms', 'mv'].forEach((p) => {
    const tpl = document.getElementById(p + '-tpl');
    const cmp = document.getElementById(p + '-compose');
    const can = document.getElementById(p + '-cancel');
    if (tpl) tpl.style.display = '';
    if (cmp) cmp.style.display = 'none';
    if (can) can.style.display = '';
  });
}
