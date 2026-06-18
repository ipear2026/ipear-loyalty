import { describe, it, expect } from 'vitest';
import { normalizeGreekSMS } from '../src/worker/lib/sms.js';

describe('normalizeGreekSMS (GSM-7 transliteration)', () => {
  it('strips accents on lowercase vowels', () => {
    expect(normalizeGreekSMS('άέήίόύώ')).toBe('AEHIOYΩ');
  });

  it('strips accents on uppercase vowels', () => {
    expect(normalizeGreekSMS('ΆΈΉΊΌΎΏ')).toBe('AEHIOYΩ');
  });

  it('keeps GSM-7-safe Greek capitals intact', () => {
    expect(normalizeGreekSMS('ΓΔΘΛΞΠΣΦΨΩ')).toBe('ΓΔΘΛΞΠΣΦΨΩ');
  });

  it('maps Greek look-alike capitals to Latin', () => {
    expect(normalizeGreekSMS('ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ')).toBe('ABEZHIKMNOPTYX');
  });

  it('uppercases plain lowercase Greek according to GSM-7 rules', () => {
    // ipear → IΠEAP (π→Π safe, ε→E latin)
    expect(normalizeGreekSMS('ipear')).toBe('IPEAR');
    expect(normalizeGreekSMS('γεια')).toBe('ΓEIA');
  });

  it('handles final-sigma ς as Σ', () => {
    expect(normalizeGreekSMS('πελάτης')).toBe('ΠEΛATHΣ');
  });

  it('leaves digits and spaces alone', () => {
    expect(normalizeGreekSMS('CODE 1234')).toBe('CODE 1234');
  });

  it('uppercases unmapped Latin chars (consistent SMS casing)', () => {
    expect(normalizeGreekSMS('hello world')).toBe('HELLO WORLD');
  });

  it('mixed Greek + Latin + numbers', () => {
    expect(normalizeGreekSMS('Καλώς ήρθες, code 4242')).toBe('KAΛΩΣ HPΘEΣ, CODE 4242');
  });

  it('iota with diaeresis collapses to I', () => {
    expect(normalizeGreekSMS('ϊϋΪΫ')).toBe('IYIY');
  });

  it('does not crash on empty string', () => {
    expect(normalizeGreekSMS('')).toBe('');
  });
});
