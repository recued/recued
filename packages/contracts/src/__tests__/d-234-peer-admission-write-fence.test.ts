import { describe, expect, it } from 'vitest';
import {
  EXCHANGE_ADMISSION_WILDCARD,
  invalidExchangeAdmissionEntries,
  resolveExchangeAdmission,
} from '../connection.js';

const RECIPE = 'recued-core/peer-answer';

/** D-234 § 234.1 — the fence that stops a typo inverting a security posture.
 *
 *  ⛔ THE PAIR IS THE POINT, NOT EITHER HALF. `resolveExchangeAdmission`答 an
 *  unrecognized value with `auto_accept` ON PURPOSE, and the ceiling suite asserts
 *  that. Read alone, each half looks right; together they meant an owner could
 *  store `'ASK'` and silently get the OPPOSITE of what they wrote. These tests
 *  assert the composition: what the resolver would mis-read, the door now refuses. */
describe('peer_admission write fence', () => {
  it('accepts every legal value, and absence', () => {
    expect(invalidExchangeAdmissionEntries(undefined)).toEqual([]);
    expect(invalidExchangeAdmissionEntries({})).toEqual([]);
    expect(invalidExchangeAdmissionEntries({
      [RECIPE]: 'refuse',
      [EXCHANGE_ADMISSION_WILDCARD]: 'ask',
      'other/recipe': 'auto_accept',
    })).toEqual([]);
  });

  it('⛔ refuses exactly the values the resolver would silently read as auto_accept', () => {
    // Each of these is a plausible hand-edit. Each one resolves `auto_accept`
    // today — the opposite of the restriction the owner was writing.
    for (const value of ['ASK', 'Refuse', 'deny', 'refuse ', 'block', '', 'AUTO_ACCEPT']) {
      expect(resolveExchangeAdmission({ [RECIPE]: value }, RECIPE)).toBe('auto_accept');
      expect(
        invalidExchangeAdmissionEntries({ [RECIPE]: value }),
        `expected the door to refuse ${JSON.stringify(value)}`,
      ).toHaveLength(1);
    }
  });

  it('refuses non-string values and a non-object declaration', () => {
    expect(invalidExchangeAdmissionEntries({ [RECIPE]: true })).toHaveLength(1);
    expect(invalidExchangeAdmissionEntries({ [RECIPE]: null })).toHaveLength(1);
    expect(invalidExchangeAdmissionEntries({ [RECIPE]: ['refuse'] })).toHaveLength(1);
    // A bare string instead of a map is the same trap one level up: the owner
    // means "refuse everything" and the resolver reads auto_accept.
    expect(resolveExchangeAdmission('refuse', RECIPE)).toBe('auto_accept');
    expect(invalidExchangeAdmissionEntries('refuse')).toHaveLength(1);
    expect(invalidExchangeAdmissionEntries([])).toHaveLength(1);
  });

  it('names every offending entry, not just the first', () => {
    const bad = invalidExchangeAdmissionEntries({ a: 'ASK', b: 'deny', c: 'refuse' });
    expect(bad).toHaveLength(2);
    expect(bad.join(' ')).toContain('"a"');
    expect(bad.join(' ')).toContain('"b"');
    expect(bad.join(' ')).not.toContain('"c"');
  });

  it('⚠ leaves KEYS alone — a ceiling for a recipe not yet installed is legitimate', () => {
    expect(invalidExchangeAdmissionEntries({ 'not/installed/yet': 'refuse' })).toEqual([]);
  });

  it('does NOT change dispatch for values that are already stored', () => {
    expect(resolveExchangeAdmission({ [RECIPE]: 'refuse' }, RECIPE)).toBe('refuse');
    expect(resolveExchangeAdmission({ [RECIPE]: 'ask' }, RECIPE)).toBe('ask');
    expect(resolveExchangeAdmission({}, RECIPE)).toBe('auto_accept');
    expect(resolveExchangeAdmission(undefined, RECIPE)).toBe('auto_accept');
  });
});
