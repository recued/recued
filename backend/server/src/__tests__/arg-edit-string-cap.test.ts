/** An approval-card edit is bounded before a pack-declared regex sees it.
 *
 *  ⛔ THE CONTRACT CANNOT EXPRESS THIS BOUND, WHICH IS WHY IT IS A CONSTANT AND
 *  NOT A FIELD. `ArgEditField.validation` is `{ min, max, pattern }`, and
 *  `min`/`max` are applied to a NUMBER — see the `number` branch of
 *  `enforceFieldShape`. A string field therefore has no declarable length, so
 *  the pattern ran against a caller-supplied string of any size, on a thread
 *  nothing can interrupt, with a cost that grows with input length.
 *
 *  ⚠ AND THE CALLER IS NOT ALWAYS THE OWNER. `resolveApprover` admits
 *  `paired_admin` AND `ask_landing` — a holder of an approval-link capability —
 *  and `validateEditsAgainstSchema` runs before any approver-kind branching.
 *  Nothing restricts edits to the owner. The older comment on that function
 *  still says "Admin-only, so never a privilege hole"; it predates the second
 *  authority, and this test exists because that reading was wrong.
 *
 *  🔑 ORDER IS THE PROPERTY UNDER TEST, not just the refusal. A cap applied
 *  AFTER the pattern would refuse the same inputs and prevent nothing — the
 *  regex would already have run. `refuses an oversize value before the pattern
 *  can run` pins the order with a pattern that would take minutes at the sizes
 *  the cap now forbids: if the cap ever moves below the pattern, that test does
 *  not fail, it HANGS, which is its own signal. */
import { describe, expect, it } from 'vitest';

import { ARG_EDIT_STRING_MAX } from '@recued/contracts';

import { validateEditsAgainstSchema } from '../reception-inbox-handler.js';

const METHOD = 'reception.inbox.approve';

/** One editable string arg carrying a pattern that is quadratic on long input —
 *  the shape `sqlite3` shipped before it was anchored. */
const schemaWithPattern = {
  fields: [
    {
      key: 'query',
      type: 'string' as const,
      validation: { pattern: '[\\s\\S]*\\S[\\s\\S]*' },
    },
  ],
};

const schemaPlain = { fields: [{ key: 'note', type: 'string' as const }] };

describe('approval-card edit string cap', () => {
  it('accepts a value at the cap', () => {
    const value = 'a'.repeat(ARG_EDIT_STRING_MAX);
    const out = validateEditsAgainstSchema({ note: value }, schemaPlain, METHOD);
    expect(out).toStrictEqual({ note: value });
  });

  it('refuses one character over, and names the limit', () => {
    const value = 'a'.repeat(ARG_EDIT_STRING_MAX + 1);
    expect(() => validateEditsAgainstSchema({ note: value }, schemaPlain, METHOD))
      .toThrow(new RegExp(`${ARG_EDIT_STRING_MAX} characters or fewer`));
  });

  it('⛔ refuses an oversize value BEFORE the pattern can run', () => {
    // 200k of pure whitespace: the pattern above has no `\S` to find, so it
    // retries from every start position. Unbounded this is minutes of
    // uninterruptible CPU. Bounded it is a length check and a refusal.
    const hostile = ' '.repeat(200_000);
    const started = Date.now();
    expect(() => validateEditsAgainstSchema({ query: hostile }, schemaWithPattern, METHOD))
      .toThrow(/characters or fewer/);
    // Generous: the point is "did not run the regex", not a benchmark.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('leaves a value under the cap to the pattern, which still decides', () => {
    // Blank-only fails the pattern; the cap must not swallow that verdict.
    expect(() => validateEditsAgainstSchema({ query: '   ' }, schemaWithPattern, METHOD))
      .toThrow(/does not match/);
    expect(validateEditsAgainstSchema({ query: 'ok' }, schemaWithPattern, METHOD))
      .toStrictEqual({ query: 'ok' });
  });
});
