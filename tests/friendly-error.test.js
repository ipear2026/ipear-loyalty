// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { friendlyError } from '../src/utils.js';

describe('friendlyError — raw technical errors → natural Greek', () => {
  it.each([
    [{ code: 'permission-denied' },           'δικαίωμα'],
    [{ message: 'Missing or insufficient permissions.' }, 'δικαίωμα'],
    [{ code: 'unauthenticated' },             'δικαίωμα'],
    [new Error('Failed to fetch'),            'σύνδεση'],
    [{ message: 'network error' },            'σύνδεση'],
    [{ code: 'unavailable' },                 'σύνδεση'],
    [{ message: 'deadline-exceeded timeout' },'άργησε'],
    [{ code: 'not-found' },                   'βρέθηκε'],
    [{ code: 'resource-exhausted' },          'Πολλές'],
  ])('%o → contains "%s"', (err, needle) => {
    expect(friendlyError(err)).toContain(needle);
  });

  it('already-Greek messages pass through unchanged', () => {
    expect(friendlyError(new Error('Μη έγκυρο ποσό'))).toBe('Μη έγκυρο ποσό');
  });
  it('unknown bare-English never leaks → generic Greek', () => {
    expect(friendlyError(new Error('WeirdInternalThing'))).toBe('Κάτι πήγε στραβά. Δοκιμάστε ξανά.');
    expect(friendlyError(null)).toBe('Κάτι πήγε στραβά. Δοκιμάστε ξανά.');
  });
});
