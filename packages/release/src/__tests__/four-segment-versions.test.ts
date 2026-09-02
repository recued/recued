import { describe, expect, it } from 'vitest';

// The release tooling cannot import this module — those scripts run without a
// built dist/ — so it mirrors the comparator in
// `backend/server/scripts/version-guard.mjs`. The ratchet on that mirror lives
// in `test/four-segment-comparator-ratchet.test.ts`, not here: it has to import
// both sides, and `packages/` may never import from `backend/`.
import { compareVersions } from '../resolve.js';

/** A same-day hotfix is `yy.m.d.n`, and the fourth segment used to be TRUNCATED
 *  rather than rejected: `26.8.31.1` compared EQUAL to `26.8.31`, so
 *  `resolveRelease` took its `<= 0` branch and answered `up-to-date`. The
 *  manifest was ACCEPTED — sequence is a separate gate and passes — and the
 *  owner was told there was nothing to install. Silent, on the one path that
 *  exists to deliver an urgent fix.
 *
 *  ⚠ These are ordering assertions, not a scheme endorsement: the everyday
 *  version stays `yy.m.d`. What they pin is that a fourth segment ORDERS, and
 *  that adding it changed nothing about how plain triples compare. */
describe('four-segment versions order, and triples are untouched', () => {
  const newer = (a: string, b: string): boolean => compareVersions(a, b) > 0;

  it('a hotfix is newer than the release it fixes', () => {
    expect(newer('26.9.1.1', '26.9.1')).toBe(true);
    expect(newer('26.9.1.2', '26.9.1.1')).toBe(true);
  });

  it('and older than the next ordinary release', () => {
    expect(newer('26.9.2', '26.9.1.9')).toBe(true);
    expect(newer('26.10.1', '26.9.1.1')).toBe(true);
  });

  it('a missing fourth segment reads as 0, so triples compare as they always did', () => {
    expect(compareVersions('26.8.31', '26.8.31')).toBe(0);
    expect(newer('26.9.1', '26.8.31')).toBe(true);
    expect(newer('26.8.31', '26.8.30')).toBe(true);
    expect(newer('26.8.30', '26.8.31')).toBe(false);
    // The base is equal and neither carries an ordinal — still equal.
    expect(compareVersions('26.9.1', '26.9.1')).toBe(0);
  });

  it('⛔ the case the release driver refuses: a suffix on a triple already in the field', () => {
    // This is CORRECT ordering — 26.8.31.1 IS newer. The hazard is not the
    // arithmetic here, it is that servers WITHOUT this comparator truncate and
    // read `up-to-date`. `release.mjs` refuses to publish such a version until
    // the fleet's newest release carries the four-segment read.
    expect(newer('26.8.31.1', '26.8.31')).toBe(true);
  });
});
