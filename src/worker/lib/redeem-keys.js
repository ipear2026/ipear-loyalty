export const REDEEM_FAIL_KEY_PREFIX  = 'redeem:fail:';
export const REDEEM_BLOCK_KEY_PREFIX = 'redeem:block:';

export function makeRedeemRateKey(source, actorUid, sessionId, ip) {
  return `${source}|${actorUid || 'anon'}|${sessionId || 'nosession'}|${ip}`;
}

export function makeFailKey(key) {
  return `${REDEEM_FAIL_KEY_PREFIX}${key}`;
}

export function makeBlockKey(key) {
  return `${REDEEM_BLOCK_KEY_PREFIX}${key}`;
}
