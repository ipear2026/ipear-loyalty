// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Birthday Claims Auto-Processor
//  Awards +50 pts to customers whose birthday is today and validates the
//  claim against the canonical customer doc (rejects blocked / wrong-date).
//  Idempotent: each claim has its own doc keyed by uid_year (Firestore rule).
// ═══════════════════════════════════════════════════════════════════════════
import { logger } from '../logger.js';
import { toast } from './ui.js';

const DB = () => window._db;
export const BDAY_BONUS_PTS = 50;

export async function processBirthdayClaims() {
  const db = DB();
  if (!db) return;
  try {
    const snap = await window._getDocs(
      window._query(
        window._col(db, 'ipear_birthday_claims'),
        window._where('processed', '==', false)
      )
    );
    if (snap.empty) return;

    let awarded = 0;
    const processOne = async (claimDoc) => {
      const claim = claimDoc.data();
      // Atomic: customer balance + ledger entry + claim processed flag,
      // all in one Firestore commit. Was three sequential separate writes,
      // any of which could fail mid-flight and leave the bonus partially
      // applied (credit landed, no ledger row, claim re-processable).
      // Deterministic ledger id (customerId+year) keeps it idempotent.
      const ledgerId = `birthday_claim_${claim.customerId}_${claim.year || new Date().getFullYear()}`;
      const nowIso = new Date().toISOString();
      let didAward = false;
      try {
        await window._runTransaction(db, async (txn) => {
          const custRef = window._doc(db, 'ipear_customers', claim.customerId);
          const custSnap = await txn.get(custRef);
          if (!custSnap.exists()) return;
          const cust = custSnap.data();
          if (cust.blocked || !cust.birthday) return;
          const bday = new Date(cust.birthday + 'T00:00:00');
          const now = new Date();
          if (bday.getMonth() !== now.getMonth() || bday.getDate() !== now.getDate()) return;

          const newPts = (cust.points || 0) + BDAY_BONUS_PTS;
          const newTot = (cust.totalPoints || 0) + BDAY_BONUS_PTS;
          txn.update(custRef, { points: newPts, totalPoints: newTot });
          txn.set(window._doc(db, 'ipear_transactions', ledgerId), {
            customerId: claim.customerId,
            customerUid: claim.customerUid || '',
            customerEmail: claim.customerEmail || cust.email || '',
            customerName: claim.customerName || cust.name || '',
            card: claim.card || cust.card || '',
            type: 'add',
            points: BDAY_BONUS_PTS,
            amount: 0,
            category: '🎂 Birthday Bonus',
            note: 'Χρόνια Πολλά ' + claim.year + '! 🎉',
            date: nowIso,
          });
          txn.update(window._doc(db, 'ipear_birthday_claims', claimDoc.id), {
            processed: true,
            processedAt: nowIso,
          });
          didAward = true;
        });
      } catch (e) {
        logger.warn('[birthday-claim]', claimDoc.id, e?.code || e?.message || e);
        return;
      }
      if (didAward) awarded++;
    };

    const promises = [];
    snap.forEach((d) => promises.push(processOne(d)));
    await Promise.all(promises);

    if (awarded > 0) {
      const customerLabel = awarded === 1 ? 'η' : 'ες';
      toast(
        `🎂 Birthday bonus: +${BDAY_BONUS_PTS} πόντοι σε ${awarded} πελάτ${customerLabel}`,
        'success'
      );
    }
  } catch (e) {
    logger.warn('[birthday-claims]', e.message);
  }
}
