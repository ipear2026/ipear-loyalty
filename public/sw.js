// ═══════════════════════════════════════════════════════════════════════════
//  TOMBSTONE SERVICE WORKER  —  /sw.js
//
//  Purpose: migrate clients still controlled by the OBSOLETE pre-rename
//  `/sw.js` worker onto the current build. Older builds registered `/sw.js`;
//  the app now registers `/sw-customer.js`. A client opened on an old build is
//  stuck: its old `/sw.js` serves old cached HTML+JS (which calls now-retired
//  Worker endpoints → the "endpoint-retired" toast), and the browser's periodic
//  update of that registration used to FAIL because `/sw.js` had become the SPA
//  HTML fallback (text/html + nosniff → "unsupported MIME type"). So the old
//  worker could never be replaced and the client never loaded the new bundle.
//
//  Serving this real JS at `/sw.js` makes that update SUCCEED. This worker then
//  purges every cache, unregisters itself, and reloads its window clients once.
//  The reloaded (now SW-less) client fetches fresh from the network → current
//  index.html → current bundle → registers `sw-customer.js` → converges.
//
//  Safety:
//   • Runs once per stale client (it unregisters itself; the reloaded client
//     registers `sw-customer.js`, never `/sw.js`) → NO reload loop.
//   • The reload is a GET navigation, never a POST replay; redemptions are
//     user-tap-initiated and the server is idempotent (deterministic ledger
//     ids) → NO repeated financial action on migration.
//   • Caches/serves NO application assets — it only tears the old worker down.
//   • Fresh clients never register `/sw.js`, so they are unaffected.
// ═══════════════════════════════════════════════════════════════════════════

self.addEventListener('install', () => {
  // Take over as fast as possible so `activate` runs on this update.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 1) Purge ALL caches — the old bundle + old index.html live here.
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) { /* best-effort */ }

    // 2) Take control of in-scope window clients so we can reload them. A real
    //    stale client is already controlled via its inherited /sw.js
    //    registration; claim() also covers any client not yet controlled by
    //    this worker (and makes the one-time reload deterministic).
    try { await self.clients.claim(); } catch (_) { /* best-effort */ }

    // 3) Unregister self — the active worker keeps running (and keeps
    //    controlling existing clients) for the rest of this handler, but once
    //    a client reloads it is served straight from the network with no SW.
    try { await self.registration.unregister(); } catch (_) { /* best-effort */ }

    // 4) Reload each controlled window client exactly once to pull fresh code.
    //    GET navigation only — never a POST replay — so no redemption/ledger
    //    action is repeated. Runs once (this worker then unregisters), so the
    //    reloaded client registers sw-customer.js, never /sw.js → no loop.
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        try { await client.navigate(client.url); } catch (_) { /* ignore per-client */ }
      }
    } catch (_) { /* best-effort */ }
  })());
});

// Passthrough: never cache or serve application assets during this worker's
// brief life, so nothing stale is handed back.
self.addEventListener('fetch', () => { /* defer to network */ });
