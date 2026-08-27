import { describe, expect, it } from 'vitest';
import type { ServerRecipeListEntry } from '@recued/contracts';

import { parseShellRoute } from '../../shell/route.js';
import type { PackAppRecipe, PackAppSurface } from '../pack-app-model.js';
import {
  packAppViewAddress,
  packDetailAddress,
  packsListAddress,
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
    });
    expect(parsePacksAddress(parseShellRoute('#packs/rental-book/use/list-buildings')))
      .toEqual({
        kind: 'pack',
        packSlug: 'rental-book',
        viewId: 'list-buildings',
      });
    expect(parsePacksAddress(parseShellRoute('#recipes/x'))).toBeNull();
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
