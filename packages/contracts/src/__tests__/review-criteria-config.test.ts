/** D-250 addendum — review criteria as a feature-owned metadata key. */

import { describe, expect, it } from 'vitest';
import {
  REVIEW_CRITERIA_MAX,
  REVIEW_CRITERIA_METADATA_KEY,
  readReviewCriteria,
} from '../review-criteria-config.js';

const wrap = (v: unknown) => ({ [REVIEW_CRITERIA_METADATA_KEY]: v });
const one = [{ key: 'seq_id', label: 'Sequence id valid?' }];

describe('readReviewCriteria', () => {
  it('reads a bare array and a wrapped one', () => {
    expect(readReviewCriteria(wrap(one))?.criteria).toEqual(one);
    expect(readReviewCriteria(wrap({ criteria: one }))?.criteria).toEqual(one);
  });

  /** ⚠ MOST RECIPES WILL NEVER DECLARE ONE. An absent key is the normal case and must be
   *  indistinguishable from a recipe that predates the feature — which is the whole reason
   *  this is an optional metadata key rather than a schema change. */
  it('⚠ an absent declaration is null, not an error', () => {
    expect(readReviewCriteria({})).toBeNull();
    expect(readReviewCriteria(wrap(undefined))).toBeNull();
    expect(readReviewCriteria(null)).toBeNull();
    expect(readReviewCriteria('nonsense')).toBeNull();
  });

  /** ⛔ DEGRADES, NEVER THROWS. This is third-party manifest content read on a public,
   *  CDN-cached page: a malformed declaration must read as "declares none" — which the UI
   *  already handles — rather than take the page down or render half a form. */
  it('⛔ rejects a malformed declaration whole rather than partially accepting it', () => {
    expect(readReviewCriteria(wrap([{ key: 'k' }]))).toBeNull();              // no label
    expect(readReviewCriteria(wrap([{ label: 'L' }]))).toBeNull();            // no key
    expect(readReviewCriteria(wrap([{ key: '', label: 'L' }]))).toBeNull();
    expect(readReviewCriteria(wrap([one[0], { key: 'x' }]))).toBeNull();      // one bad entry
    expect(readReviewCriteria(wrap([]))).toBeNull();
    expect(readReviewCriteria(wrap([{ key: 'x'.repeat(121), label: 'L' }]))).toBeNull();
  });

  /** ⛔⛔ A DUPLICATE KEY REJECTS THE WHOLE DECLARATION. 039's primary key is
   *  `(review_id, criterion_key)`, so two criteria sharing a key give a form whose second
   *  verdict silently replaces the first — the reviewer would believe they answered both. */
  it('⛔⛔ refuses duplicate keys', () => {
    expect(readReviewCriteria(wrap([
      { key: 'k', label: 'A' }, { key: 'k', label: 'B' },
    ]))).toBeNull();
  });

  /** ⚠ Mirrors `MAX_VERDICTS_PER_REVIEW` — declaring more criteria than a reviewer may
   *  return verdicts for would build a form that cannot be submitted. */
  it('⚠ bounds the list at what a single review can answer', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `L${i}` }));
    expect(readReviewCriteria(wrap(many(REVIEW_CRITERIA_MAX)))).not.toBeNull();
    expect(readReviewCriteria(wrap(many(REVIEW_CRITERIA_MAX + 1)))).toBeNull();
  });
});
