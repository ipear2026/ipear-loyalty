import { describe, it, expect } from 'vitest';
import {
  makeRedeemRateKey, makeFailKey, makeBlockKey,
  REDEEM_FAIL_KEY_PREFIX, REDEEM_BLOCK_KEY_PREFIX,
} from '../src/worker/lib/redeem-keys.js';

describe('makeRedeemRateKey', () => {
  it('joins all four parts with pipe separators', () => {
    expect(makeRedeemRateKey('tablet', 'uid1', 'sess1', '1.2.3.4'))
      .toBe('tablet|uid1|sess1|1.2.3.4');
  });

  it('substitutes "anon" when actorUid is falsy', () => {
    expect(makeRedeemRateKey('tablet', '', 'sess1', '1.2.3.4'))
      .toBe('tablet|anon|sess1|1.2.3.4');
    expect(makeRedeemRateKey('tablet', null, 'sess1', '1.2.3.4'))
      .toBe('tablet|anon|sess1|1.2.3.4');
  });

  it('substitutes "nosession" when sessionId is falsy', () => {
    expect(makeRedeemRateKey('admin', 'uid1', undefined, '1.2.3.4'))
      .toBe('admin|uid1|nosession|1.2.3.4');
  });

  it('preserves IP verbatim (caller is responsible for normalization)', () => {
    expect(makeRedeemRateKey('tablet', 'uid1', 'sess1', '2001:db8:0:0::/64'))
      .toBe('tablet|uid1|sess1|2001:db8:0:0::/64');
  });

  it('different sources produce different keys', () => {
    const a = makeRedeemRateKey('tablet', 'uid1', 'sess1', '1.2.3.4');
    const b = makeRedeemRateKey('admin',  'uid1', 'sess1', '1.2.3.4');
    expect(a).not.toBe(b);
  });
});

describe('makeFailKey / makeBlockKey', () => {
  it('prefixes the base key with redeem:fail:', () => {
    expect(makeFailKey('tablet|uid1|sess1|1.2.3.4'))
      .toBe(`${REDEEM_FAIL_KEY_PREFIX}tablet|uid1|sess1|1.2.3.4`);
  });

  it('prefixes the base key with redeem:block:', () => {
    expect(makeBlockKey('tablet|uid1|sess1|1.2.3.4'))
      .toBe(`${REDEEM_BLOCK_KEY_PREFIX}tablet|uid1|sess1|1.2.3.4`);
  });

  it('fail and block keys for the same base never collide', () => {
    expect(makeFailKey('x')).not.toBe(makeBlockKey('x'));
  });

  it('exports the expected prefix constants', () => {
    expect(REDEEM_FAIL_KEY_PREFIX).toBe('redeem:fail:');
    expect(REDEEM_BLOCK_KEY_PREFIX).toBe('redeem:block:');
  });
});
