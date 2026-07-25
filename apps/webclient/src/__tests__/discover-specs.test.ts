/** The shared Discover specs — the ONE definition of what matches, ranks and
 *  facets across the webclient, `discover_listings` (SQL) and the marketplace
 *  SPA (which consumes the SQL through `/catalog/search`).
 *
 *  These assert the spec's CONTRACT rather than any one surface's rendering,
 *  because three consumers depend on it and only one of them is TypeScript.
 *  `scripts/verify-discover-parity.mjs` imports the same module and proves the
 *  SQL agrees with it. */

import { describe, expect, it } from 'vitest';

import { EMPTY_QUERY, runDiscover, type DiscoverQuery } from '../discover/discover-model.js';
import {
  CERTIFIED_RANKING_BOOST,
  packSpec,
  recipeSpec,
} from '../discover/discover-specs.js';
import type { CatalogPackRow, CatalogRecipeRow } from '../discover/catalog-client.js';

const recipe = (over: Partial<CatalogRecipeRow>): CatalogRecipeRow => ({
  recipe_id: 'detect-deal-risk-hubspot',
  publisher_id: 'recued-core',
  name: 'Deal Risk',
  description: '',
  type: '',
  version: 1,
  platforms: [],
  tags: [],
  download_count: 0,
  rating_avg: 0,
  rating_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  depends_on: [],
  ...over,
});

const pack = (over: Partial<CatalogPackRow>): CatalogPackRow => ({
  slug: 'sales-augmentation',
  publisher_id: 'recued-core',
  name: 'Sales Augmentation',
  description: '',
  version: 1,
  pack_kind: '',
  tags: [],
  download_count: 0,
  item_count: 0,
  recipe_refs: [],
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const q = (over: Partial<DiscoverQuery>): DiscoverQuery => ({ ...EMPTY_QUERY, ...over, perPage: 50 });

const ids = (rows: readonly CatalogRecipeRow[]): string[] => rows.map((r) => r.recipe_id);

describe('searchable text — the shareable identifier is in the haystack', () => {
  it('matches a recipe by its recipe_id, not just its name', () => {
    const corpus = [
      recipe({ recipe_id: 'detect-deal-risk-hubspot', name: 'Deal Risk' }),
      recipe({ recipe_id: 'summarize-inbox-gmail', name: 'Inbox Digest' }),
    ];
    // The slug is what gets pasted into a chat or an issue; the name shares no
    // token with it, so this can only pass via `recipe_id`.
    const out = runDiscover(corpus, recipeSpec, q({ search: 'detect-deal-risk-hubspot' }));
    expect(ids(out.pageRows)).toEqual(['detect-deal-risk-hubspot']);
  });

  it('matches a pack by its slug', () => {
    const corpus = [
      pack({ slug: 'sales-augmentation', name: 'Revenue Tools' }),
      pack({ slug: 'inbox-triage', name: 'Mail Tools' }),
    ];
    const out = runDiscover(corpus, packSpec, q({ search: 'sales-augmentation' }));
    expect(out.pageRows.map((r) => r.slug)).toEqual(['sales-augmentation']);
  });

  it('still ANDs terms across fields (id term + tag term)', () => {
    const corpus = [
      recipe({ recipe_id: 'detect-deal-risk-hubspot', tags: ['revenue'] }),
      recipe({ recipe_id: 'detect-deal-risk-salesforce', tags: ['ops'] }),
    ];
    // `revenue` appears in neither id, so only the AND of both terms selects
    // one row. (Terms are SUBSTRINGS, not tokens — a `sales` term here would
    // also match `…-salesforce`, which is the engine behaving correctly.)
    const out = runDiscover(corpus, recipeSpec, q({ search: 'detect-deal revenue' }));
    expect(ids(out.pageRows)).toEqual(['detect-deal-risk-hubspot']);
  });
});

describe('publisher facet', () => {
  it('is declared on both kinds — /publishers/<handle> is this facet with one value', () => {
    expect(recipeSpec.facets.map((f) => f.key)).toContain('publisher');
    expect(packSpec.facets.map((f) => f.key)).toContain('publisher');
  });

  it('narrows recipes to one publisher and counts the alternatives', () => {
    const corpus = [
      recipe({ recipe_id: 'a', publisher_id: 'recued-core' }),
      recipe({ recipe_id: 'b', publisher_id: 'recued-core' }),
      recipe({ recipe_id: 'c', publisher_id: 'acme' }),
    ];
    const out = runDiscover(corpus, recipeSpec, q({ filters: { publisher: ['recued-core'] } }));
    expect(ids(out.pageRows)).toEqual(['a', 'b']);
    // Drop-one-out: the facet's own selection is ignored when counting itself,
    // so `acme` stays visible rather than zeroing into a dead end.
    expect(out.facets.publisher).toEqual([
      { value: 'recued-core', count: 2 },
      { value: 'acme', count: 1 },
    ]);
  });
});

describe('popular sorter — downloads plus the certified boost', () => {
  it('floats a certified row over an uncertified one within the boost', () => {
    const corpus = [
      recipe({ recipe_id: 'plain', download_count: 40, publisher_certified: false }),
      recipe({ recipe_id: 'certified', download_count: 0, publisher_certified: true }),
    ];
    // 0 + 50 > 40. Ordering by raw downloads would put `plain` first, so this
    // pins the boost itself rather than the sort direction.
    expect(ids(runDiscover(corpus, recipeSpec, q({ sort: 'popular' })).pageRows))
      .toEqual(['certified', 'plain']);
    expect(ids(runDiscover(corpus, recipeSpec, q({ sort: 'downloads' })).pageRows))
      .toEqual(['plain', 'certified']);
  });

  it('does not float it past a lead wider than the boost', () => {
    const corpus = [
      recipe({ recipe_id: 'plain', download_count: CERTIFIED_RANKING_BOOST + 1, publisher_certified: false }),
      recipe({ recipe_id: 'certified', download_count: 0, publisher_certified: true }),
    ];
    expect(ids(runDiscover(corpus, recipeSpec, q({ sort: 'popular' })).pageRows))
      .toEqual(['plain', 'certified']);
  });

  it('touches ONLY `popular` — `name` and `newest` rank a certified row no higher', () => {
    // Re-homed from the marketplace SPA's `certified.test.ts` when its copy of
    // the ranking was deleted (D-180 stage 4). The boost is worth 50 installs
    // on one sorter; a certified publisher must not quietly own the top of the
    // alphabet or of the newest list as well.
    const corpus = [
      recipe({ recipe_id: 'aaa', name: 'aaa', created_at: '2026-01-01', publisher_certified: false }),
      recipe({ recipe_id: 'zzz', name: 'zzz', created_at: '2026-01-01', publisher_certified: true }),
    ];
    expect(ids(runDiscover(corpus, recipeSpec, q({ sort: 'name' })).pageRows))
      .toEqual(['aaa', 'zzz']);
    expect(ids(runDiscover(corpus, recipeSpec, q({ sort: 'newest' })).pageRows))
      .toEqual(['aaa', 'zzz']);
  });

  it('breaks ties by id, so equal scores are stable rather than insertion-ordered', () => {
    const corpus = [
      recipe({ recipe_id: 'zebra' }),
      recipe({ recipe_id: 'alpha' }),
    ];
    expect(ids(runDiscover(corpus, recipeSpec, q({ sort: 'popular' })).pageRows))
      .toEqual(['alpha', 'zebra']);
  });

  it('applies to packs on the same terms', () => {
    const corpus = [
      pack({ slug: 'plain', download_count: 40 }),
      pack({ slug: 'certified', download_count: 0, publisher_certified: true }),
    ];
    expect(runDiscover(corpus, packSpec, q({ sort: 'popular' })).pageRows.map((r) => r.slug))
      .toEqual(['certified', 'plain']);
  });
});

describe('updated sorter', () => {
  it('ranks on updated_at, newest first', () => {
    const corpus = [
      recipe({ recipe_id: 'old', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' }),
      recipe({ recipe_id: 'new', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' }),
    ];
    expect(ids(runDiscover(corpus, recipeSpec, q({ sort: 'updated' })).pageRows)).toEqual(['new', 'old']);
  });

  it('falls back to created_at for a row projected without updated_at', () => {
    const corpus = [
      recipe({ recipe_id: 'no-updated', created_at: '2026-09-01T00:00:00Z' }),
      recipe({ recipe_id: 'has-updated', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' }),
    ];
    // Without the fallback the undefined key would sort last regardless of how
    // recent the row actually is.
    expect(ids(runDiscover(corpus, recipeSpec, q({ sort: 'updated' })).pageRows))
      .toEqual(['no-updated', 'has-updated']);
  });
});

describe('sorter order is load-bearing', () => {
  // `resolveSorter` AND the SQL's per-kind valid-sort list both fall back to the
  // spec's FIRST sorter. Reordering this object silently re-ranks every unsorted
  // query on both surfaces, which no rendering test would catch.
  it('keeps `downloads` first on both kinds', () => {
    expect(Object.keys(recipeSpec.sorters)[0]).toBe('downloads');
    expect(Object.keys(packSpec.sorters)[0]).toBe('downloads');
  });

  it('resolves an empty or unknown sort to downloads, not to a new sorter', () => {
    const corpus = [
      recipe({ recipe_id: 'few', download_count: 1 }),
      recipe({ recipe_id: 'many', download_count: 99 }),
    ];
    for (const sort of ['', 'nonexistent', 'RATING']) {
      expect(ids(runDiscover(corpus, recipeSpec, q({ sort })).pageRows)).toEqual(['many', 'few']);
    }
  });

  it('packs have no rating sorter, so `rating` falls back rather than ordering by one', () => {
    expect(Object.keys(packSpec.sorters)).not.toContain('rating');
    const corpus = [pack({ slug: 'few', download_count: 1 }), pack({ slug: 'many', download_count: 99 })];
    expect(runDiscover(corpus, packSpec, q({ sort: 'rating' })).pageRows.map((r) => r.slug))
      .toEqual(['many', 'few']);
  });
});
