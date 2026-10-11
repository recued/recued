/** The Packs route's styles hold the packs surface's, whichever of the two
 *  modules loads first.
 *
 *  ⛔ `packs-surface.ts` used to import `resolvePackInput` from
 *  `bootstrap-packs-route.ts`, which imports the surface's styles while it loads
 *  (`PACKS_ROUTE_STYLES`). Loaded surface-first, the route ran mid-cycle, read
 *  `PACKS_SURFACE_STYLES` before it existed, and joined an empty string in its
 *  place. In the shared app test pool (`isolate: false`) the first file to load
 *  either module decides it for every later file in that worker, so
 *  `d-187-packs-route.test.ts` went red whenever `packs-surface.test.ts` ran
 *  before it, which a sweep's file order decides (seen 2026-10-10). This file
 *  imports the surface FIRST, the order that broke. */

import { describe, expect, it } from 'vitest';

import { PACKS_SURFACE_STYLES } from '../packs/packs-surface.js';
import { PACKS_ROUTE_STYLES } from '../packs/bootstrap-packs-route.js';

describe('the Packs route styles, loaded surface-first', () => {
  it('hold the packs surface styles', () => {
    expect(PACKS_SURFACE_STYLES.length).toBeGreaterThan(0);
    expect(PACKS_ROUTE_STYLES).toContain(PACKS_SURFACE_STYLES);
  });
});
