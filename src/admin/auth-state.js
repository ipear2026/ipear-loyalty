// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Shared authentication state
//  Modules read `authState.authenticated` to gate data-loading calls.
//  admin-main.js writes to this object after successful unlock/logout.
// ═══════════════════════════════════════════════════════════════════════════
export const authState = {
  authenticated: false,
  actorUid: null,
  storeId: null,
  storeName: '—',
};
