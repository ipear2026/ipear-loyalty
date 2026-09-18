// @vitest-environment node
// ───────────────────────────────────────────────────────────────────────────
//  Signup error classification — unit tests.
//  Verifies each failure category maps to the correct, non-generic Greek
//  message, and that only genuine offline/network failures claim "internet".
// ───────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import {
  SIGNUP_STAGE, SIGNUP_MSG, classifySignupError, buildSignupLog, makeCorrelationId,
} from '../src/customer/signup-errors.js';

const ONLINE = { online: true };

describe('classifySignupError', () => {
  it('G — genuine offline wins over everything', () => {
    const r = classifySignupError(SIGNUP_STAGE.FIRESTORE_CREATE, { code: 'unavailable' }, { online: false });
    expect(r.category).toBe('G-offline');
    expect(r.userMsg).toBe(SIGNUP_MSG.OFFLINE);
  });

  it('E — App Check / reCAPTCHA error', () => {
    const r = classifySignupError(SIGNUP_STAGE.FIRESTORE_CREATE, { code: 'appCheck/fetch-status-error' }, ONLINE);
    expect(r.category).toBe('E-appcheck');
    expect(r.userMsg).toBe(SIGNUP_MSG.APPCHECK);
  });

  it('E — App Check inferred from a failed appCheckStatus', () => {
    const r = classifySignupError(SIGNUP_STAGE.FIRESTORE_CREATE, { message: 'timeout' }, { online: true, appCheckStatus: 'failed' });
    expect(r.category).toBe('E-appcheck');
  });

  it('D — Firebase Auth generic', () => {
    const r = classifySignupError(SIGNUP_STAGE.AUTH_CREATE, { code: 'auth/internal-error' }, ONLINE);
    expect(r.category).toBe('D-auth');
    expect(r.userMsg).toBe(SIGNUP_MSG.AUTH);
  });

  it('D — Firebase Auth duplicate email', () => {
    const r = classifySignupError(SIGNUP_STAGE.AUTH_CREATE, { code: 'auth/email-already-in-use' }, ONLINE);
    expect(r.category).toBe('D-auth-dup');
    expect(r.userMsg).toBe(SIGNUP_MSG.AUTH_DUP);
  });

  it('A — auth/network-request-failed is a network failure, not a generic auth error', () => {
    const r = classifySignupError(SIGNUP_STAGE.AUTH_CREATE, { code: 'auth/network-request-failed' }, ONLINE);
    expect(r.category).toBe('A-network');
    expect(r.userMsg).toBe(SIGNUP_MSG.NETWORK);
  });

  it('F — Firestore create timeout (wrapped error unwrapped via .cause)', () => {
    const wrapped = new Error('Πρόβλημα σύνδεσης με τη βάση.');
    wrapped.cause = new Error('Timeout: Firestore customer create');
    const r = classifySignupError(SIGNUP_STAGE.FIRESTORE_CREATE, wrapped, ONLINE);
    expect(r.category).toBe('F-firestore');
    expect(r.userMsg).toBe(SIGNUP_MSG.FIRESTORE);
    expect(r.code).toMatch(/timeout/i);
  });

  it('F — Firestore unavailable', () => {
    const r = classifySignupError(SIGNUP_STAGE.FIRESTORE_CREATE, { code: 'unavailable' }, ONLINE);
    expect(r.category).toBe('F-firestore');
  });

  it('C — OTP verification failure (4xx)', () => {
    const e = new Error('wrong code'); e.httpStatus = 400;
    const r = classifySignupError(SIGNUP_STAGE.VERIFY_OTP, e, { online: true, httpStatus: 400 });
    expect(r.category).toBe('C-otp');
    expect(r.userMsg).toBe(SIGNUP_MSG.OTP);
  });

  it('B — SMS/Brevo failure on send-otp', () => {
    const e = new Error('brevo 500'); e.httpStatus = 502;
    const r = classifySignupError(SIGNUP_STAGE.SEND_OTP, e, { online: true, httpStatus: 502 });
    expect(r.category).toBe('B-sms');
    expect(r.userMsg).toBe(SIGNUP_MSG.SMS);
  });

  it('A — worker 5xx on check-registration', () => {
    const e = new Error('boom'); e.httpStatus = 503;
    const r = classifySignupError(SIGNUP_STAGE.CHECK, e, { online: true, httpStatus: 503 });
    expect(r.category).toBe('A-server');
    expect(r.userMsg).toBe(SIGNUP_MSG.SERVER);
  });

  it('A — fetch TypeError = network', () => {
    const r = classifySignupError(SIGNUP_STAGE.CHECK, new TypeError('Failed to fetch'), ONLINE);
    expect(r.category).toBe('A-network');
    expect(r.userMsg).toBe(SIGNUP_MSG.NETWORK);
  });
});

describe('buildSignupLog — redaction', () => {
  it('emits stage/category/code/httpStatus/appCheck/cid/ts and NO PII', () => {
    const cls = classifySignupError(SIGNUP_STAGE.SEND_OTP, Object.assign(new Error('x'), { httpStatus: 500 }), { online: true, httpStatus: 500 });
    const log = buildSignupLog(SIGNUP_STAGE.SEND_OTP, cls, { appCheckStatus: 'ready', cid: 'sg_abc', httpStatus: 500 });
    expect(log.evt).toBe('signup_failure');
    expect(log.stage).toBe(SIGNUP_STAGE.SEND_OTP);
    expect(log.category).toBe('B-sms');
    expect(log.httpStatus).toBe(500);
    expect(log.appCheck).toBe('ready');
    expect(log.cid).toBe('sg_abc');
    expect(typeof log.ts).toBe('string');
    // No PII fields ever present
    const keys = Object.keys(log).join(',');
    for (const forbidden of ['email', 'phone', 'password', 'otp', 'code ', 'name', 'token']) {
      expect(keys.includes(forbidden)).toBe(false);
    }
  });
});

describe('makeCorrelationId', () => {
  it('returns a short sg_ id and is reasonably unique', () => {
    const a = makeCorrelationId(), b = makeCorrelationId();
    expect(a).toMatch(/^sg_[0-9a-f]+$/);
    expect(a).not.toBe(b);
  });
});
