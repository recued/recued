/** D-148 § A.7 — `isPathResolution`, the runtime validator for a
 *  `PathResolution` arriving from outside the type system.
 *
 *  ⚠ THIS PREDICATE EXISTED AS TWO PRIVATE COPIES before 2026-09-17 —
 *  `backend/server/src/exposure-handler.ts` (validating an rpc argument off
 *  the wire) and `backend/server/src/exposure/sqlite-store.ts` (validating a
 *  `state_json` cell read back from disk). Mutation found that BOTH had only
 *  the `lan` half pinned: dropping `typeof public === 'boolean'` left every
 *  test in both suites green. Two copies of one rule, drifted the same way,
 *  is how the wire end and the stored end could disagree about what a valid
 *  cell is — so the rule now lives once, next to the type, with the tests
 *  that keep both halves honest. */

import { describe, expect, it } from 'vitest';
import { isPathResolution } from '../network.js';

describe('D-148 § A.7 — isPathResolution', () => {
  it('accepts a cell whose bits are both real booleans', () => {
    for (const cell of [
      { lan: true, public: true },
      { lan: true, public: false },
      { lan: false, public: true },
      { lan: false, public: false },
    ]) {
      expect(isPathResolution(cell), `${JSON.stringify(cell)} was rejected`).toBe(true);
    }
  });

  it('⛔⛔ rejects a non-boolean `public` bit — the half that decides internet exposure', () => {
    // ⛔ Every value here is truthy or coerces. A cell that merely HAS the key
    // would be persisted verbatim and read by the listener as "on", which is
    // how a hand-edited or half-written row binds a path to the public
    // listener without anyone having toggled it.
    for (const bad of [1, 0, 'true', 'false', '', null, undefined, {}, [], NaN]) {
      expect(
        isPathResolution({ lan: true, public: bad }),
        `public: ${JSON.stringify(bad)} was accepted as a resolution`,
      ).toBe(false);
    }
  });

  it('⛔ rejects a non-boolean `lan` bit', () => {
    for (const bad of [1, 0, 'true', 'false', '', null, undefined, {}, [], NaN]) {
      expect(
        isPathResolution({ lan: bad, public: true }),
        `lan: ${JSON.stringify(bad)} was accepted as a resolution`,
      ).toBe(false);
    }
  });

  it('rejects a cell missing either key', () => {
    expect(isPathResolution({ lan: true })).toBe(false);
    expect(isPathResolution({ public: true })).toBe(false);
    expect(isPathResolution({})).toBe(false);
  });

  it('rejects values that are not objects at all', () => {
    // ⚠ `null` is the one that needs its own guard: `typeof null === 'object'`,
    // so a bare typeof check admits it and the property reads then throw.
    for (const bad of [null, undefined, 0, 1, '', 'lan', true, false, NaN]) {
      expect(
        isPathResolution(bad),
        `${JSON.stringify(bad)} was accepted as a resolution`,
      ).toBe(false);
    }
  });

  it('ignores extra keys (the shape is a floor, not an exact match)', () => {
    // The stored row is projected field-by-field by both callers, so an extra
    // key is inert. Pinned so a future tightening to an exact-match predicate
    // is a deliberate decision with a red test, not a silent behaviour change.
    expect(isPathResolution({ lan: true, public: false, stale_field: 1 })).toBe(true);
  });

  it('narrows the type for TypeScript callers', () => {
    const value: unknown = { lan: true, public: false };
    if (isPathResolution(value)) {
      const bits: [boolean, boolean] = [value.lan, value.public];
      expect(bits).toEqual([true, false]);
    } else {
      expect.unreachable('a valid cell failed the guard');
    }
  });
});
