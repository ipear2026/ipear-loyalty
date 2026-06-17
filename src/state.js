// ═══════════════════════════════════════════════════════════════════════════
//  Shared mutable state — cross-module singleton
//  Structurally required for clean ES module boundaries.
//  In the monolith these were top-level script-scope variables.
// ═══════════════════════════════════════════════════════════════════════════
export const state = {
  foundCustomer: null,
  _maintenanceMode: false,
  _maintenanceUnsub: null,
};
