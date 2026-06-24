// ═══════════════════════════════════════════════════════════════════════════
//  Customer UI — Barrel re-export façade
//
//  The original 1552-line monolith was split into domain modules under
//  src/customer/ui/ during the Sprint 3 god-module refactor. This file
//  stays as the public import surface so main.js + auth.js don't need
//  to change their import paths.
//
//  Domain split:
//   • rewards-ui.js     — rewards catalog + home/list rendering
//   • offers-ui.js      — offers list, bottom sheet, multi-offer QR queue,
//                         e-shop coupon redemption
//   • leaderboard-ui.js — leaderboard rendering + viewer self-detection
//   • history-ui.js     — paginated transaction history
//   • misc-ui.js        — card-tab QR + referral copy/share
// ═══════════════════════════════════════════════════════════════════════════

export {
  startRewardsListener,
  stopRewardsListener,
  getActiveRewards,
  renderHomeRewards,
  renderRewardsList,
} from './customer/ui/rewards-ui.js';

export {
  startOffersListener,
  stopOffersListener,
  loadOffersData,
  openOfferSheet,
  closeOfferSheet,
  offerRedeemStep1,
  closeOfferConfirm,
  offerGenerateQR,
  cancelOfferQR,
  minimizeOfferQR,
  restoreOfferQR,
  navigateOfferQR,
  _offerTick,
  _stopOfferRedeemWatch,
  offerGenerateEshopCoupon,
  _copyEshopCoupon,
} from './customer/ui/offers-ui.js';

export {
  loadLeaderboard,
  stopLbListener,
  _expandLeaderboard,
  _collapseLb,
} from './customer/ui/leaderboard-ui.js';

export {
  loadHistory,
  loadHistoryMore,
  _toggleHistory,
} from './customer/ui/history-ui.js';

export {
  generateQR,
  copyReferral,
  shareReferral,
} from './customer/ui/misc-ui.js';
