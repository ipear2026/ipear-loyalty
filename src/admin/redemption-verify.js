// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN — Redemption Code Verification
//  Looks up a 6-digit code in both ipear_redemptions (rewards) and
//  ipear_offer_redemptions (offers), atomically marks it used inside a
//  Firestore transaction, and writes the corresponding ledger entry.
//
//  Dependencies on admin-main state (selected customer, store context)
//  are injected at module init via initRedemptionVerify(config) instead of
//  reaching into globals.
// ═══════════════════════════════════════════════════════════════════════════
import { escHtml, escJs } from '../utils.js';
import { toast } from './ui.js';
import { publishLeaderboard } from './leaderboard.js';

const DB = () => window._db;

// Injected by admin-main once on bootstrap.
let _ctx = {
  getStoreContext: () => ({ storeId: null, storeName: '—' }),
  onRedemptionApproved: () => {},
  refreshAdminViews: () => {},
};

export function initRedemptionVerify(config) {
  _ctx = { ..._ctx, ...config };
}

// ── Look up a code in both collections + render result card ───────────────
export async function verifyCode() {
  const raw = document.getElementById('rcode-in').value.replace(/\s/g, '').trim();
  if (raw.length !== 6 || !/^\d{6}$/.test(raw)) {
    toast('⚠️ Εισάγετε 6-ψήφιο κωδικό!', 'error');
    return;
  }
  const resEl = document.getElementById('rcode-result');
  resEl.style.display = 'none';
  try {
    const db = DB();
    let found = null;
    let foundId = null;
    let isOffer = false;

    const rSnap = await window._getDocs(
      window._query(window._col(db, 'ipear_redemptions'), window._where('code', '==', raw))
    );
    rSnap.forEach((d) => {
      const data = d.data ? d.data() : d;
      if (!found) {
        found = data;
        foundId = d.id || data.id;
      }
    });

    if (!found) {
      const oSnap = await window._getDocs(
        window._query(window._col(db, 'ipear_offer_redemptions'), window._where('code', '==', raw))
      );
      oSnap.forEach((d) => {
        const data = d.data ? d.data() : d;
        if (!found) {
          found = data;
          foundId = d.id || data.id;
          isOffer = true;
        }
      });
    }

    if (!found) {
      resEl.style.display = 'block';
      resEl.innerHTML = `<div style="background:rgba(255,59,48,.12);border:1px solid #ff3b30;border-radius:11px;padding:14px;color:#ff3b30;font-weight:700">⚠️ Άκυρος κωδικός ή έχει λήξει.</div>`;
      return;
    }
    if (found.used) {
      resEl.style.display = 'block';
      resEl.innerHTML = `<div style="background:rgba(255,149,0,.12);border:1px solid #ff9500;border-radius:11px;padding:14px;color:#ff9500;font-weight:700">⚠️ Αυτός ο κωδικός έχει ήδη χρησιμοποιηθεί.</div>`;
      return;
    }
    if (found.status === 'cancelled' || found.status === 'rejected') {
      resEl.style.display = 'block';
      resEl.innerHTML = `<div style="background:rgba(255,59,48,.12);border:1px solid #ff3b30;border-radius:11px;padding:14px;color:#ff3b30;font-weight:700">⚠️ Άκυρος κωδικός ή έχει λήξει.</div>`;
      return;
    }
    if (found.expiresAt && new Date() > new Date(found.expiresAt)) {
      resEl.style.display = 'block';
      resEl.innerHTML = `<div style="background:rgba(255,59,48,.12);border:1px solid #ff3b30;border-radius:11px;padding:14px;color:#ff3b30;font-weight:700">⚠️ Άκυρος κωδικός ή έχει λήξει.</div>`;
      return;
    }

    resEl.style.display = 'block';
    if (isOffer) {
      const bp = found.bonusPoints || found.pointsCost || 0;
      resEl.innerHTML = `<div style="background:linear-gradient(135deg,#0f1f00,#1a3300);border:1px solid #8ae900;border-radius:11px;padding:16px">
        <div style="color:#8ae900;font-weight:900;font-size:1.1rem;margin-bottom:8px">🎁 Προσφορά — Έγκυρος Κωδικός!</div>
        <div style="color:white;font-size:.92rem;margin-bottom:3px">👤 ${escHtml(found.customerName)} (${escHtml(found.card || '')})</div>
        <div style="color:white;font-size:.92rem;margin-bottom:14px">🎟️ ${escHtml(found.offerTitle)} ${bp > 0 ? '— +' + bp + ' bonus πόντοι' : ''}</div>
        <button class="btn btn-green btn-full" data-action="confirmOfferVerify" data-arg="${escJs(foundId)}" style="font-size:.95rem">
          🎁 Έγκριση Προσφοράς
        </button>
      </div>`;
    } else {
      resEl.innerHTML = `<div style="background:linear-gradient(135deg,#0f1f00,#1a3300);border:1px solid #8ae900;border-radius:11px;padding:16px">
        <div style="color:#8ae900;font-weight:900;font-size:1.1rem;margin-bottom:8px">✅ Έγκυρος Κωδικός!</div>
        <div style="color:white;font-size:.92rem;margin-bottom:3px">👤 ${escHtml(found.customerName)} (${escHtml(found.card)})</div>
        <div style="color:white;font-size:.92rem;margin-bottom:14px">🎟️ ${escHtml(found.label)} — ${found.points} πόντοι</div>
        <button class="btn btn-green btn-full" data-action="confirmVerify" data-arg="${escJs(foundId)}" data-arg2="${escJs(raw)}" style="font-size:.95rem">
          💶 Επιβεβαίωση &amp; Εξαργύρωση
        </button>
      </div>`;
    }
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  }
}

// ── Approve a REWARD redemption (debit points) ─────────────────────────────
export async function confirmVerify(redemptionId, code) {
  const vBtn = document.querySelector('#rcode-result button');
  if (vBtn) {
    vBtn.disabled = true;
    vBtn.textContent = '⏳ Εξαργύρωση...';
  }
  try {
    const db = DB();
    let found;
    let custId;
    let newPts;
    // Pre-generate ledger id so it lands in the SAME Firestore commit as the
    // balance debit + redemption mark-used. Was previously a separate addDoc
    // AFTER runTransaction, which could leave points deducted with no
    // customer-facing history row on network/permission/timing failure —
    // the exact "η εξαργύρωση reward δεν φαίνεται στο ιστορικό" bug.
    const verifyLedgerId = `redeem_verify_${redemptionId}`;
    const verifyNowIso = new Date().toISOString();
    const { storeId, storeName } = _ctx.getStoreContext();

    await window._runTransaction(db, async (txn) => {
      const redemRef = window._doc(db, 'ipear_redemptions', redemptionId);
      const redemSnap = await txn.get(redemRef);
      if (!redemSnap.exists()) throw new Error('⚠️ Άκυρος κωδικός ή έχει λήξει.');
      found = redemSnap.data();
      if (found.used === true || found.status === 'used') {
        throw new Error('Ο κωδικός έχει ήδη χρησιμοποιηθεί.');
      }
      if (found.status === 'cancelled' || found.status === 'rejected') {
        throw new Error('⚠️ Άκυρος κωδικός ή έχει λήξει.');
      }
      if (new Date() > new Date(found.expiresAt)) {
        throw new Error('⚠️ Άκυρος κωδικός ή έχει λήξει.');
      }

      let custRef = null;
      let custData = null;
      if (found.customerId) {
        custRef = window._doc(db, 'ipear_customers', found.customerId);
        const cs = await txn.get(custRef);
        if (cs.exists()) {
          custId = found.customerId;
          custData = cs.data();
        }
      }
      if (!custData && found.customerUid) {
        custRef = window._doc(db, 'ipear_customers', found.customerUid);
        const cs = await txn.get(custRef);
        if (cs.exists()) {
          custId = found.customerUid;
          custData = cs.data();
        }
      }
      if (!custId || !custData) throw new Error('Πελάτης δεν βρέθηκε.');

      const currentPts = custData.points || 0;
      if (currentPts < found.points) {
        throw new Error(`Ανεπαρκείς πόντοι (${currentPts} < ${found.points})`);
      }
      newPts = currentPts - found.points;

      txn.update(redemRef, { used: true, usedAt: verifyNowIso, status: 'used' });
      txn.update(custRef, { points: newPts });

      // Customer-facing ledger entry — same commit.
      // customerUid + customerEmail BOTH populated so the customer's
      // loadHistory matches via either branch of the Firestore read rule
      // (resource.data.customerUid == auth.uid OR customerEmail == auth.email).
      // Fallbacks are intentional: the redemption doc doesn't store email,
      // and customerUid can be empty if startRedemption ran before
      // auth.currentUser was populated.
      txn.set(window._doc(db, 'ipear_transactions', verifyLedgerId), {
        customerId: custId,
        customerUid: found.customerUid || custData.uid || '',
        customerEmail: found.customerEmail || custData.email || '',
        customerName: found.customerName || custData.name || '',
        card: found.card || custData.card || '',
        type: 'redeem',
        points: -found.points,
        discount: found.discount,
        label: found.label,
        redemptionCode: code,
        method: 'admin-verify',
        storeId: storeId || null,
        storeName,
        date: verifyNowIso,
      });
    });

    _ctx.onRedemptionApproved({ customerId: custId, newPoints: newPts });
    // Fire-and-forget leaderboard refresh so the customer's snapshot
    // listener on ipear_leaderboard/latest picks up the new rank.
    // Was missing — the old non-atomic path in admin-main.js called
    // _publishLeaderboard after every points change, but the verify
    // paths in this module never did, so reward redemptions silently
    // stopped updating the live leaderboard.
    publishLeaderboard().catch(() => {});

    document.getElementById('rcode-result').innerHTML = `<div style="background:linear-gradient(135deg,#0f1f00,#1a3300);border:1px solid #8ae900;border-radius:11px;padding:20px;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:8px">✅</div>
      <div style="color:#8ae900;font-weight:900;font-size:1.2rem;margin-bottom:4px">Εξαργύρωση Επιτυχής!</div>
      <div style="color:white;font-size:.9rem">${escHtml(found.label)} για <strong>${escHtml(found.customerName)}</strong></div>
      <div style="color:#888;font-size:.82rem;margin-top:4px">Αφαιρέθηκαν ${found.points} πόντοι</div>
    </div>`;
    document.getElementById('rcode-in').value = '';
    toast(`✅ ${found.label} — ${found.customerName}`, 'success');
    _ctx.refreshAdminViews();
  } catch (e) {
    toast('❌ ' + e.message, 'error');
    if (vBtn && document.body.contains(vBtn)) {
      vBtn.disabled = false;
      vBtn.textContent = '💶 Επιβεβαίωση & Εξαργύρωση';
    }
  }
}

// ── Approve an OFFER redemption (credit bonus pts) ─────────────────────────
export async function confirmOfferVerify(redemptionId) {
  const vBtn = document.querySelector('#rcode-result button');
  if (vBtn) {
    vBtn.disabled = true;
    vBtn.textContent = '⏳ Επεξεργασία...';
  }
  try {
    const db = DB();
    let found;
    let custDocId;
    let bonus = 0;
    // Pre-generate ledger id + capture store context so the ledger entry
    // can be written INSIDE the runTransaction. Was previously a separate
    // addDoc after the txn — same partial-failure shape as the reward
    // verify bug above, but for offer bonuses ("η εξαργύρωση προσφοράς
    // δεν φαίνεται").
    const offerLedgerId = `offer_verify_${redemptionId}`;
    const offerNowIso = new Date().toISOString();
    const { storeId, storeName } = _ctx.getStoreContext();

    await window._runTransaction(db, async (txn) => {
      // ── ALL READS FIRST ──
      const redRef = window._doc(db, 'ipear_offer_redemptions', redemptionId);
      const redSnap = await txn.get(redRef);
      if (!redSnap.exists()) throw new Error('Κωδικός δεν βρέθηκε.');
      found = redSnap.data();
      if (found.used) throw new Error('Ήδη χρησιμοποιημένος.');

      // SECURITY: bonus read from OFFER DOC (trusted), not redemption doc.
      const offerId = found.offerId;
      let offerBonus = 0;
      if (offerId) {
        const offersSnap = await window._getDocs(
          window._query(window._col(db, 'ipear_offers'), window._where('active', '==', true))
        );
        offersSnap.forEach((d) => {
          if (d.id === offerId || d.data().title === offerId) {
            offerBonus =
              Number(d.data().bonusPoints) || Number(d.data().pointsCost) || 0;
          }
        });
      }

      // Try customerId (auth UID) first, fallback to customerDocId (legacy).
      custDocId = found.customerId;
      let custRef = window._doc(db, 'ipear_customers', custDocId);
      let custSnap = await txn.get(custRef);
      if (!custSnap.exists() && found.customerDocId && found.customerDocId !== custDocId) {
        custDocId = found.customerDocId;
        custRef = window._doc(db, 'ipear_customers', custDocId);
        custSnap = await txn.get(custRef);
      }
      if (!custSnap.exists()) throw new Error('Πελάτης δεν βρέθηκε.');
      const cust = custSnap.data();
      if (cust.blocked) throw new Error('Ο πελάτης είναι blocked.');
      bonus = offerBonus;
      const newPts = (cust.points || 0) + bonus;
      const newTot = (cust.totalPoints || 0) + bonus;

      // ── ALL WRITES AFTER ──
      txn.update(redRef, { used: true, status: 'used', usedAt: offerNowIso });
      if (bonus > 0) {
        txn.update(custRef, { points: newPts, totalPoints: newTot });
        // Ledger entry in the same commit — only written when bonus > 0
        // so we don't create empty audit rows for zero-bonus offers.
        //
        // Field defensiveness: customerUid + customerEmail BOTH populated so
        // the customer's loadHistory hits a match via the rules' uid OR
        // email branch. In ipear_offer_redemptions, customerId IS the auth
        // uid (see startOfferRedemption in ui-renderers.js); customerDocId
        // is the legacy doc id. We prefer auth-uid for the rule-matched
        // customerUid field, falling back to the live customer doc's uid.
        txn.set(window._doc(db, 'ipear_transactions', offerLedgerId), {
          customerId: custDocId,
          customerUid: found.customerId || cust.uid || '',
          customerEmail: found.customerEmail || cust.email || '',
          customerName: found.customerName || cust.name || '',
          card: found.card || cust.card || '',
          type: 'add',
          points: bonus,
          category: '🎁 Προσφορά: ' + (found.offerTitle || ''),
          note: 'Offer approved via admin',
          method: 'admin-offer-verify',
          storeId: storeId || null,
          storeName,
          date: offerNowIso,
        });
      }
    });

    document.getElementById('rcode-result').innerHTML = `<div style="background:linear-gradient(135deg,#0f1f00,#1a3300);border:1px solid #8ae900;border-radius:11px;padding:20px;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:8px">🎁</div>
      <div style="color:#8ae900;font-weight:900;font-size:1.2rem;margin-bottom:4px">Προσφορά Εγκρίθηκε!</div>
      <div style="color:white;font-size:.9rem">${escHtml(found.offerTitle || '')} για <strong>${escHtml(found.customerName)}</strong></div>
      ${bonus > 0 ? `<div style="color:#8ae900;font-size:.9rem;margin-top:4px;font-weight:700">+${bonus} bonus πόντοι</div>` : ''}
    </div>`;
    document.getElementById('rcode-in').value = '';
    toast('🎁 ' + (found.offerTitle || 'Προσφορά') + ' — +' + bonus + ' πόντοι → ' + found.customerName, 'success');
    _ctx.refreshAdminViews();
    if (bonus > 0) publishLeaderboard().catch(() => {});
  } catch (e) {
    toast('❌ ' + e.message, 'error');
    if (vBtn && document.body.contains(vBtn)) {
      vBtn.disabled = false;
      vBtn.textContent = '🎁 Έγκριση Προσφοράς';
    }
  }
}
