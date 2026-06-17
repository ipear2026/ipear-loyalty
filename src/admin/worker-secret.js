// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Cloudflare Worker secret storage
//  Session-first (dies with tab) with one-shot localStorage migration so any
//  legacy persisted secret is promoted to sessionStorage and removed.
//  SEC-FIX: never persist secrets in localStorage.
// ═══════════════════════════════════════════════════════════════════════════
const SECRET_KEY = 'ipear_worker_secret';

export function getWorkerSecret() {
  const ss = sessionStorage.getItem(SECRET_KEY);
  if (ss) return ss;
  const ls = localStorage.getItem(SECRET_KEY);
  if (ls) {
    sessionStorage.setItem(SECRET_KEY, ls);
    localStorage.removeItem(SECRET_KEY);
    return ls;
  }
  return '';
}

export function setWorkerSecret(secret) {
  sessionStorage.setItem(SECRET_KEY, secret);
}

export function clearWorkerSecret() {
  sessionStorage.removeItem(SECRET_KEY);
  localStorage.removeItem(SECRET_KEY);
}
