// ═══════════════════════════════════════════════════════════════════════════
//  i18n — Internationalization (Greek / English)
//  Detects browser language; defaults to Greek. Use _t('key') everywhere.
//
//  ── COPY STYLE GUIDE (toast / error / CTA strings across the app) ──
//
//  Apply these rules when adding ANY user-facing string in the customer
//  app (and ideally in admin/tablet too):
//
//    1. Singular informal — "Δοκίμασε ξανά" not "Παρακαλούμε δοκιμάστε".
//       The app talks to one customer at a time, like a friend at the till.
//    2. ≤ 1 emoji per string, at the START. Never trailing 🎉/🍐 fireworks.
//       "✅ Αντιγράφηκε" — yes.  "✅ Αντιγράφηκε! 🎉" — no.
//    3. No trailing periods on short toasts (≤ 6 words). Periods on
//       longer copy and on multi-sentence errors only.
//    4. Imperative CTAs — "Συνδέσου", "Δοκίμασε ξανά", "Πάρε την προσφορά".
//       Avoid passive ("Δοκιμάστε επανασύνδεση").
//    5. Prefer "Δεν έγινε X" over "Σφάλμα κατά X" for human readability.
//       The user doesn't need to know which subsystem failed.
//    6. Use the single-character ellipsis (…) in pending states, never "...".
//    7. Never expose raw e.message to the user — log it, show a clean line.
//
//  Existing toasts that don't follow these rules were tightened in the
//  delight-pass commit; new ones should follow from the start.
// ═══════════════════════════════════════════════════════════════════════════
export const _i18n = {
  el: {
    welcome_back:  'Καλωσήρθες πίσω',
    good_morning:  'Καλημέρα',
    good_evening:  'Καλησπέρα',
    points:        'πόντοι',
    points_lbl:    'Πόντοι',
    progress:      'Πρόοδος',
    logout:        'Αποσύνδεση',
    rw_1000:       '5€ Έκπτωση',
    rw_2500:       '15€ Έκπτωση',
    rw_4000:       '30€ Έκπτωση',
    rw_tap:        '👆 Πάτα για κωδικό',
    rw_more:       'ακόμα',
    rw_code:       'Κωδικός',
    rw_need:       'χρειάζεσαι',
    rw_avail:      'Διαθέσιμοι Πόντοι',
    rw_locked:     '🔒 ',
    sec_rewards:   'Rewards',
    sec_all:       'Όλα →',
  },
  en: {
    welcome_back:  'Welcome back',
    good_morning:  'Good morning',
    good_evening:  'Good evening',
    points:        'points',
    points_lbl:    'Points',
    progress:      'Progress',
    logout:        'Log out',
    rw_1000:       '5€ Discount',
    rw_2500:       '15€ Discount',
    rw_4000:       '30€ Discount',
    rw_tap:        '👆 Tap for code',
    rw_more:       'more',
    rw_code:       'Code',
    rw_need:       'need',
    rw_avail:      'Available Points',
    rw_locked:     '🔒 ',
    sec_rewards:   'Rewards',
    sec_all:       'All →',
  }
};
export const _lang = (navigator.language || 'el').startsWith('en') ? 'en' : 'el';
export function _t(key) { return (_i18n[_lang] || _i18n.el)[key] || _i18n.el[key] || key; }
