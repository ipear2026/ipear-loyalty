// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Leaderboard publisher
//  Computes the public top-20 (sorted by lifetime totalPoints, blocked
//  customers excluded) and writes it to ipear_leaderboard/latest. Called
//  from loadAll() with the existing snapshot, and from add/redeem flows
//  with no args (does its own fresh query).
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../logger.js';

const DB = () => window._db;

// Accepts an optional Firestore snapshot; if omitted, does a fresh query.
export async function publishLeaderboard(existingSnap) {
  try {
    const db = DB();
    if (!db) return;
    const snap = existingSnap ?? (await window._getDocs(window._col(db, 'ipear_customers')));
    if (snap.empty) return;

    const lbAll = [];
    snap.forEach((d) => {
      const c = d.data();
      if (c.blocked) return;
      lbAll.push({
        name: c.name || '—',
        points: c.points || 0,
        totalPoints: c.totalPoints || 0,
        card: c.card || '',
      });
    });
    lbAll.sort(
      (a, b) =>
        b.totalPoints - a.totalPoints ||
        (a.name || '').localeCompare(b.name || '', 'el')
    );

    // The customer renderer needs `card` to identify the viewer's own row
    // (highlight + skip pinned "Εσύ" footer). Cards are not secrets — they're
    // printed on physical loyalty cards and displayed on the customer home
    // screen. A leaderboard of top-20 cards isn't a meaningful PII leak;
    // abuse vectors (card spoofing) require physical presence + cashier
    // collusion, not the card number alone.
    const top20 = lbAll.slice(0, 20).map((c) => ({
      name: c.name
        .split(' ')
        .map((w, i) => (i === 0 ? w : (w[0] || '') + '.'))
        .join(' '),
      points: c.points,
      totalPoints: c.totalPoints,
      card: c.card,
    }));

    await window._setDoc(window._doc(db, 'ipear_leaderboard', 'latest'), {
      top: top20,
      total: lbAll.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    logger.warn('[leaderboard] publish failed:', e.message);
  }
}
