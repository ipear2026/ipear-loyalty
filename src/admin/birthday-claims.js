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
      const custRef = window._doc(db, 'ipear_customers', claim.customerId);
      const custSnap = await window._getDoc(custRef);
      if (!custSnap.exists()) return;
      const cust = custSnap.data();
      if (cust.blocked || !cust.birthday) return;

      const bday = new Date(cust.birthday + 'T00:00:00');
      const now = new Date();
      if (bday.getMonth() !== now.getMonth() || bday.getDate() !== now.getDate()) return;

      const newPts = (cust.points || 0) + BDAY_BONUS_PTS;
      const newTot = (cust.totalPoints || 0) + BDAY_BONUS_PTS;
      await window._updateDoc(custRef, { points: newPts, totalPoints: newTot });
      await window._addDoc(window._col(db, 'ipear_transactions'), {
        customerId: claim.customerId,
        customerUid: claim.customerUid || '',
        customerEmail: claim.customerEmail || '',
        customerName: claim.customerName || '',
        card: claim.card || '',
        type: 'add',
        points: BDAY_BONUS_PTS,
        amount: 0,
        category: '🎂 Birthday Bonus',
        note: 'Χρόνια Πολλά ' + claim.year + '! 🎉',
        date: new Date().toISOString(),
      });
      await window._updateDoc(window._doc(db, 'ipear_birthday_claims', claimDoc.id), {
        processed: true,
        processedAt: new Date().toISOString(),
      });
      awarded++;
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
