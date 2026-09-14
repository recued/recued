/** D-268 ratchet — {@link ENVIRONMENT_RETRY_POLICY} covers the `environment`
 *  attribution bucket EXACTLY: every member has an entry, and nothing else does.
 *
 *  🔑 WHY A TEST AND NOT THE TYPE SYSTEM. The bucket is defined by a RUNTIME
 *  table (`ERROR_ATTRIBUTION`), so "the codes attributed `environment`" is not a
 *  type TypeScript can build a `Record` over. A full
 *  `Record<RecipeErrorCode, …>` would get the compiler's completeness check at
 *  the price of restating 85 entries the attribution table already determines —
 *  and a duplicated guarantee is the only way that guarantee breaks. This test
 *  buys the completeness without the duplication.
 *
 *  ⛔ IT CHECKS BOTH DIRECTIONS ON PURPOSE. A missing entry means a new code
 *  silently takes the fail-closed branch (stop at the first failure) with nobody
 *  having decided that; an EXTRA entry means someone answered "will waiting
 *  help" for a code whose treatment is already settled by attribution, where it
 *  will be read by nothing and will rot out of step. */

import { describe, expect, it } from 'vitest';

import { ENVIRONMENT_RETRY_POLICY } from '../automation-failure-policy.js';
import { ERROR_ATTRIBUTION } from '../errors.js';

const environmentCodes = Object.entries(ERROR_ATTRIBUTION)
  .filter(([, attribution]) => attribution === 'environment')
  .map(([code]) => code)
  .sort();

describe('D-268 ENVIRONMENT_RETRY_POLICY completeness', () => {
  it('the bucket is non-trivial, so a vacuous pass below is impossible', () => {
    // A positive control: if ERROR_ATTRIBUTION were ever restructured such that
    // this filter returned [], both assertions below would pass over nothing.
    expect(environmentCodes.length).toBeGreaterThan(50);
  });

  it('every `environment` code has a retry policy', () => {
    const missing = environmentCodes.filter((code) => ENVIRONMENT_RETRY_POLICY[code] === undefined);
    expect(missing).toEqual([]);
  });

  it('no non-`environment` code has one', () => {
    const environmentSet = new Set(environmentCodes);
    const extra = Object.keys(ENVIRONMENT_RETRY_POLICY)
      .filter((code) => !environmentSet.has(code))
      .sort();
    expect(extra).toEqual([]);
  });

  it('⛔ the policy is NOT uniform — a collapsed table would disable the feature silently', () => {
    // If the split ever degenerates to one value (the shape a wrongly-wired
    // `retryable` override would produce), every automation takes the same
    // treatment and the breaker becomes dead code — with every other test here
    // still green, because each of them would still describe a consistent table.
    const values = new Set(Object.values(ENVIRONMENT_RETRY_POLICY));
    expect([...values].sort()).toEqual(['retry', 'stop']);
  });
});
