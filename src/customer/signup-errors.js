// ═══════════════════════════════════════════════════════════════════════════
//  Signup error classification + safe diagnostics
//
//  Pure module (no DOM, no network, no secrets). Given a failure at a known
//  signup stage, it returns a stable category, a clear Greek user message,
//  and a redacted log code. The point is to STOP showing a generic
//  "check your internet" message when the real cause is Worker / SMS /
//  App Check / Firestore / Auth — while never exposing raw backend
//  internals, stack traces, secrets, or PII to the user.
//
//  Categories (per incident spec):
//    A. Worker/network failure
//    B. SMS/Brevo failure
//    C. OTP verification failure
//    D. Firebase Auth failure
//    E. App Check / reCAPTCHA failure
//    F. Firestore write timeout/failure
//    G. genuine browser offline/network failure
// ═══════════════════════════════════════════════════════════════════════════

export const SIGNUP_STAGE = {
  CHECK:            'check-registration',
  SEND_OTP:         'send-sms-otp',
  VERIFY_OTP:       'verify-sms-otp',
  AUTH_CREATE:      'auth-create',
  FIRESTORE_CREATE: 'firestore-create',
  WELCOME:          'send-welcome',
};

// Clear, non-generic Greek user messages. Only the OFFLINE / NETWORK ones
// mention connectivity — every other category names its real cause.
export const SIGNUP_MSG = {
  OFFLINE:   'Φαίνεται πως είσαι εκτός σύνδεσης. Έλεγξε το internet και προσπάθησε ξανά.',
  NETWORK:   'Δεν υπάρχει σύνδεση με την υπηρεσία. Έλεγξε τη σύνδεσή σου και προσπάθησε ξανά.',
  SMS:       'Δεν μπορέσαμε να στείλουμε το SMS επιβεβαίωσης. Περίμενε λίγο και δοκίμασε ξανά.',
  OTP:       'Ο κωδικός επιβεβαίωσης δεν είναι σωστός ή έληξε. Ζήτησε νέο κωδικό και δοκίμασε ξανά.',
  APPCHECK:  'Η επαλήθευση ασφαλείας απέτυχε. Απενεργοποίησε προσωρινά ad blocker/VPN και προσπάθησε ξανά.',
  FIRESTORE: 'Η εγγραφή δημιουργήθηκε αλλά δεν ολοκληρώθηκε σωστά. Δοκίμασε ξανά σε λίγα δευτερόλεπτα.',
  AUTH:      'Δεν ήταν δυνατή η δημιουργία λογαριασμού. Δοκίμασε ξανά.',
  AUTH_DUP:  'Υπάρχει ήδη λογαριασμός με αυτό το email. Χρησιμοποίησε την Είσοδο.',
  SERVER:    'Προσωρινό πρόβλημα διακομιστή. Δοκίμασε ξανά σε λίγα λεπτά.',
};

/**
 * Classify a signup failure.
 * @param {string} stage  one of SIGNUP_STAGE.*
 * @param {*}      err    the thrown error (may carry .code / .message / .cause / .httpStatus)
 * @param {object} opts   { httpStatus, online (bool), appCheckStatus }
 * @returns {{category,userMsg,code,httpStatus}}
 */
export function classifySignupError(stage, err, opts = {}) {
  const e = (err && err.cause) ? err.cause : err;              // unwrap wrapped errors
  const code = String((e && e.code) || '');                    // real error code only
  const name = String((e && e.name) || '');                    // e.g. "TypeError"
  const msg  = String((e && e.message) || '');
  const httpStatus = Number(opts.httpStatus || (err && err.httpStatus) || (e && e.httpStatus) || 0) || 0;
  const online = (opts.online !== undefined)
    ? opts.online
    : (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true);
  const appCheckStatus = opts.appCheckStatus || '';

  const out = (category, userMsg, logCode) => ({ category, userMsg, code: logCode, httpStatus });

  // G. genuine offline — only claim "internet" when the browser is actually offline.
  if (online === false) return out('G-offline', SIGNUP_MSG.OFFLINE, 'offline');

  // E. App Check / reCAPTCHA — from the error itself or a known-bad App Check state.
  if (/app[-_ ]?check|recaptcha/i.test(code) || /app[-_ ]?check|recaptcha/i.test(msg) || appCheckStatus === 'failed') {
    return out('E-appcheck', SIGNUP_MSG.APPCHECK, 'appcheck-failed');
  }

  // D. Firebase Auth (auth/* codes)
  if (code.startsWith('auth/')) {
    if (code === 'auth/network-request-failed') return out('A-network', SIGNUP_MSG.NETWORK, code);
    if (code === 'auth/email-already-in-use')   return out('D-auth-dup', SIGNUP_MSG.AUTH_DUP, code);
    if (code === 'auth/too-many-requests')      return out('D-auth', SIGNUP_MSG.SERVER, code);
    return out('D-auth', SIGNUP_MSG.AUTH, code);
  }

  // F. Firestore create timeout/failure — the post-OTP customer-doc write.
  if (stage === SIGNUP_STAGE.FIRESTORE_CREATE
      || /^timeout/i.test(msg)
      || code === 'unavailable' || code === 'deadline-exceeded' || code === 'permission-denied') {
    const logCode = code || (/^timeout/i.test(msg) ? 'timeout' : 'firestore-failed');
    return out('F-firestore', SIGNUP_MSG.FIRESTORE, logCode);
  }

  // C. OTP verification failure
  if (stage === SIGNUP_STAGE.VERIFY_OTP && httpStatus < 500) {
    return out('C-otp', SIGNUP_MSG.OTP, httpStatus ? ('http-' + httpStatus) : 'otp-invalid');
  }

  // B. SMS / Brevo failure (send-otp stage, or resend)
  if (stage === SIGNUP_STAGE.SEND_OTP) {
    return out('B-sms', SIGNUP_MSG.SMS, httpStatus ? ('http-' + httpStatus) : 'sms-failed');
  }

  // A. Worker HTTP status present
  if (httpStatus >= 500) return out('A-server', SIGNUP_MSG.SERVER, 'http-' + httpStatus);
  if (httpStatus >= 400) return out('A-client', SIGNUP_MSG.SERVER, 'http-' + httpStatus);

  // A. fetch-level network failure (TypeError "Failed to fetch" etc.)
  if (code === 'TypeError' || name === 'TypeError' || /failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return out('A-network', SIGNUP_MSG.NETWORK, 'fetch-failed');
  }

  // Fallback — unknown, treat as network but tag the code for logs.
  return out('A-network', SIGNUP_MSG.NETWORK, code || 'unknown');
}

// Login-lookup messages — the customer-doc read after a successful sign-in.
// findCustomerByAuth already swallows permission-denied (treated as "no
// account"), so a bubbled error is always connectivity/security, never a
// missing document. Never say "can't reach database" for an App Check failure.
export const LOGIN_MSG = {
  OFFLINE:  'Φαίνεται πως είσαι εκτός σύνδεσης. Έλεγξε το internet και δοκίμασε ξανά.',
  NETWORK:  'Δεν μπορούμε να συνδεθούμε στην υπηρεσία τώρα. Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά.',
  APPCHECK: 'Η επαλήθευση ασφαλείας απέτυχε. Απενεργοποίησε προσωρινά ad blocker/VPN και δοκίμασε ξανά.',
  DATABASE: 'Προσωρινό πρόβλημα με τη βάση. Δοκίμασε ξανά σε λίγο.',
};

/**
 * Classify the transient error from the post-login customer-doc lookup.
 * Returns { category, code, title, userMsg } with a login-appropriate message.
 */
export function classifyLoginLookupError(err, opts = {}) {
  const c = classifySignupError('login-lookup', err, opts);
  let userMsg, title;
  switch (c.category) {
    case 'G-offline':  userMsg = LOGIN_MSG.OFFLINE;  title = 'Πρόβλημα σύνδεσης'; break;
    case 'E-appcheck': userMsg = LOGIN_MSG.APPCHECK; title = 'Έλεγχος ασφαλείας'; break;
    case 'F-firestore':userMsg = LOGIN_MSG.DATABASE; title = 'Προσωρινό πρόβλημα'; break;
    case 'A-server':   userMsg = LOGIN_MSG.DATABASE; title = 'Προσωρινό πρόβλημα'; break;
    default:           userMsg = LOGIN_MSG.NETWORK;  title = 'Πρόβλημα σύνδεσης';
  }
  return { category: c.category, code: c.code, title, userMsg };
}

/** Short, non-identifying correlation id for tying a UI failure to a log line. */
export function makeCorrelationId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const a = crypto.getRandomValues(new Uint8Array(6));
      return 'sg_' + Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (_) { /* fall through */ }
  return 'sg_' + Math.random().toString(16).slice(2, 14);
}

/**
 * Build a redacted, structured log record for a signup failure.
 * NEVER includes password, OTP, phone, email, tokens, or names.
 */
export function buildSignupLog(stage, classified, opts = {}) {
  return {
    evt:        'signup_failure',
    stage,
    category:   classified.category,
    code:       classified.code,
    httpStatus: classified.httpStatus || Number(opts.httpStatus || 0) || 0,
    appCheck:   opts.appCheckStatus || 'unknown',
    online:     (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') ? navigator.onLine : null,
    cid:        opts.cid || null,
    ts:         new Date().toISOString(),
  };
}
