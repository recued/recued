import { describe, expect, it } from 'vitest';
import type { ServerRecipeListEntry } from '@recued/contracts';

import { parseShellRoute } from '../../shell/route.js';
import type { PackAppRecipe, PackAppSurface } from '../pack-app-model.js';
import {
  packAppViewAddress,
  packDetailAddress,
  packsListAddress,
  packAppLookupAddress,
  parsePacksAddress,
  projectPackAppNavigation,
} from '../pack-app-navigation.js';

const view = (id: string, name = id): PackAppRecipe => ({
  recipe_id: id,
  name,
  description: `${name} description`,
  entry: { recipe_id: id } as ServerRecipeListEntry,
});

const surface = (views: PackAppRecipe[]): PackAppSurface => ({
  views,
  lookups: [view('lookup')],
  operations: [view('write')],
  automations: [view('automation')],
  missing: [],
});

describe('dynamic Business Pack navigation adapter', () => {
  it('builds list, pack, and generated-view addresses', () => {
    expect(packsListAddress().hash).toBe('#packs');
    expect(packDetailAddress('rental/book').hash).toBe('#packs/rental%2Fbook');
    expect(packAppViewAddress('rental-book', 'list buildings').hash)
      .toBe('#packs/rental-book/use/list%20buildings');
  });

  it('parses only the addressable pack/view hierarchy', () => {
    expect(parsePacksAddress(parseShellRoute('#packs'))).toEqual({ kind: 'list' });
    expect(parsePacksAddress(parseShellRoute('#packs/rental-book'))).toEqual({
      kind: 'pack',
      packSlug: 'rental-book',
      viewId: null,
      target: null,
    });
    expect(parsePacksAddress(parseShellRoute('#packs/rental-book/use/list-buildings')))
      .toEqual({
        kind: 'pack',
        packSlug: 'rental-book',
        viewId: 'list-buildings',
        target: null,
      });
    expect(parsePacksAddress(parseShellRoute('#recipes/x'))).toBeNull();
  });

  /** D-282 B5 — a detail page is a place. */
  it('builds and parses a lookup address, round-trip', () => {
    const address = packAppLookupAddress('rental-book', 'show-building', 'bld 42');
    expect(address.hash).toBe('#packs/rental-book/use/show-building/bld%2042');
    expect(parsePacksAddress(parseShellRoute(address.hash))).toEqual({
      kind: 'pack',
      packSlug: 'rental-book',
      viewId: 'show-building',
      target: 'bld 42',
    });
  });

  /** ⛔ A TARGET WITH NO VIEW IS A TRUNCATED ADDRESS, NOT A SHORTER ONE.
   *  `#packs/<slug>/nonsense/bld_42` has no recipe to hang the record on, and
   *  honouring the record alone would point it at whatever opened by default.
   *
   *  ⚠ NOTE WHAT IS *NOT* TESTED HERE. `#packs/rental-book/use//bld_42` does
   *  NOT land in this case: the shell router collapses empty segments, so that
   *  hash parses as `use/bld_42` and `bld_42` IS the view id. That is the
   *  router's rule, not this parser's, and asserting otherwise here would have
   *  encoded a belief about a module this one only consumes. */
  it('drops a target whose view segment is missing or blank', () => {
    expect(parsePacksAddress(parseShellRoute('#packs/rental-book/nope/bld_42')))
      .toEqual({ kind: 'pack', packSlug: 'rental-book', viewId: null, target: null });
    expect(parsePacksAddress(parseShellRoute('#packs/rental-book/use/show-building/%20')))
      .toEqual({
        kind: 'pack',
        packSlug: 'rental-book',
        viewId: 'show-building',
        target: null,
      });
  });

  it('projects only dynamically classified views into navigation nodes', () => {
    const projected = projectPackAppNavigation(
      'rental-book',
      surface([view('buildings', 'Buildings'), view('customers', 'Customers')]),
      'customers',
    );
    expect(projected.nodes.map((node) => node.id)).toEqual(['buildings', 'customers']);
    expect(projected.nodes[1]?.address.hash)
      .toBe('#packs/rental-book/use/customers');
    expect(projected.activeViewId).toBe('customers');
    expect(projected.requestedViewFound).toBe(true);
  });

  it('fails a stale view id to the first currently valid generated view', () => {
    const projected = projectPackAppNavigation(
      'rental-book',
      surface([view('buildings'), view('customers')]),
      'retired-view',
    );
    expect(projected.activeViewId).toBe('buildings');
    expect(projected.requestedViewFound).toBe(false);
  });

  it('never promotes lookups or operations when a pack has no views', () => {
    const projected = projectPackAppNavigation('tasks', surface([]), 'lookup');
    expect(projected.nodes).toEqual([]);
    expect(projected.activeViewId).toBeNull();
    expect(projected.requestedViewFound).toBe(false);
  });
});
