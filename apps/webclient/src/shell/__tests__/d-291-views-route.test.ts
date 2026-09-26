/** D-291 — Saved views is its own surface.
 *
 *  ⛔ WHAT THIS PINS IS THE REWRITE PLUS THE THING THE REWRITE BREAKS. Moving
 *  `#data/view/<id>` to `#views/<id>` is one line in the parser; the line that
 *  made it survivable is `dataAddress` deriving its surface from the hash. The
 *  Data route builds a saved-view address whenever a view is bound, and
 *  `hierarchicalAddressFromHash` THROWS when the hash does not parse as the
 *  surface it was handed — which is exactly how D-290's Today rewrite broke its
 *  own route mid-flight. Both halves are asserted together, because either one
 *  alone is wrong.
 */
import { describe, expect, it } from 'vitest';

import {
  parseShellRoute, serializeShellRoute, WEBCLIENT_ROUTE_IDS,
} from '../route.js';
import { hierarchicalAddressFromHash } from '../hierarchical-navigation.js';

const ID = 'view_00000000-0000-4000-8000-00000000000a';

describe('D-291 the #views surface', () => {
  it('is a real route id', () => {
    expect(WEBCLIENT_ROUTE_IDS).toContain('views');
  });

  it('re-points a bookmarked #data/view/<id> and keeps the id', () => {
    const parsed = parseShellRoute(`#data/view/${ID}`);
    expect(parsed.surface).toBe('views');
    // ⚠ The `view` segment is CONSUMED, not kept — the mount reads segment 0 as
    // the id. Leaving it would make `savedViewId` the literal string "view".
    expect(parsed.segments).toEqual([ID]);
  });

  it('parses its own address the same way', () => {
    const parsed = parseShellRoute(serializeShellRoute('views', ID));
    expect(parsed.surface).toBe('views');
    expect(parsed.segments).toEqual([ID]);
  });

  it('leaves a plain #data address alone', () => {
    const parsed = parseShellRoute('#data/contact');
    expect(parsed.surface).toBe('data');
    expect(parsed.segments).toEqual(['contact']);
  });

  /** ⛔ THE REGRESSION GUARD. This is the call the Data route makes on every
   *  navigation. Hardcoding `'data'` here throws the moment a view is bound. */
  it('addresses a bound view on the views surface without throwing', () => {
    const hash = serializeShellRoute('views', ID);
    const surface = parseShellRoute(hash).surface;
    expect(() => hierarchicalAddressFromHash(surface, hash)).not.toThrow();
    expect(() => hierarchicalAddressFromHash('data', hash))
      .toThrow(/expected data, received views/);
  });

  it('still addresses a diverged filter on the data surface', () => {
    const hash = serializeShellRoute('data', 'contact');
    expect(parseShellRoute(hash).surface).toBe('data');
    expect(() => hierarchicalAddressFromHash('data', hash)).not.toThrow();
  });
});
