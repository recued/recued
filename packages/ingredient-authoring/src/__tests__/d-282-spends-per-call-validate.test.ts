/** D-282 — `spends_per_call` on a pack operation row: accepted as a boolean,
 *  refused as anything else.
 *
 *  ⛔ A MALFORMED MARK IS READ AS "DOES NOT SPEND". The gate checks
 *  `spends_per_call === true`, so a `"yes"` or a `1` would let a metered view run
 *  on every tab switch while the pack looked marked. The row's key list is closed,
 *  so the key had to be admitted there too, or every marked pack would fail install.
 *
 *  The rule is per row, so a one-row composition carries it. That a shipped pack's
 *  marks validate end to end is `d-282-spends-per-call-shipped-pack.test.ts`, apart
 *  because it reads `community/packs` and the public export drops any test that does.
 */
import { describe, expect, it } from 'vitest';

import { validateComposition } from '../index.js';

const INVALID = 'composition_operation_spends_per_call_invalid';

/** The row alone: the composition is otherwise incomplete, and every assertion here
 *  filters to the one code, so its other findings do not matter. */
const markedHits = (value: unknown) =>
  validateComposition({
    schema_version: 1,
    slug: 'spends-per-call-probe',
    ingredients: [],
    operations: [{ id: 'lookup', ...(value === undefined ? {} : { spends_per_call: value }) }],
  } as never).issues.filter(({ code }) => code === INVALID);

describe('spends_per_call on an operation row', () => {
  it('true and false are accepted, and so is leaving it out: false states what absence means', () => {
    // Not vacuous: the refusal below proves this same row reaches the rule.
    for (const value of [true, false, undefined]) {
      expect(markedHits(value), JSON.stringify(value)).toEqual([]);
    }
  });

  it('⛔ refuses a value the gate would read as "does not spend"', () => {
    for (const value of ['yes', 1, null, {}]) {
      const hits = markedHits(value);
      expect(hits, JSON.stringify(value)).toHaveLength(1);
      expect(hits[0]?.severity).toBe('error');
      expect(hits[0]?.path).toBe('operations[0].spends_per_call');
    }
  });
});
