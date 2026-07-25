/** The Discover specs — ONE definition of what matches, ranks and facets.
 *
 *  Split out of `recipe-discovery.ts` / `pack-discovery.ts` (which re-export
 *  them) for one reason: this module must stay **DOM-free and dependency-light**
 *  so `scripts/verify-discover-parity.mjs` can `import` it directly under Node's
 *  type stripping. The differential previously carried a hand-written MIRROR of
 *  these specs — a third definition of the search semantics, alongside this one
 *  and the SQL in `discover_listings`. A mirror that drifts makes the
 *  differential pass while the clients disagree, which is precisely the failure
 *  the differential exists to catch. It now compares the real artifact.
 *
 *  Three consumers, one definition:
 *   • webclient Discover — runs `runDiscover` over these locally (corpus mode)
 *     and exposes a SUBSET via `facetGroups` / `sortOptions`;
 *   • `discover_listings` (migration 029/030) — reproduces them in SQL;
 *   • marketplace SPA — consumes the SQL through `/catalog/search`, so its
 *     search behaviour IS this spec (it holds no search code of its own).
 *
 *  Each surface chooses which facets and sorts to SHOW. A key declared here is
 *  available, not mandatory — that is what lets this be a superset without
 *  putting a publisher chip group in the webclient's filter bar.
 */

import {
  byDateDesc,
  byNumberDesc,
  byStringAsc,
  type DiscoverSpec,
} from './discover-model.js';
import type { CatalogPackRow, CatalogRecipeRow } from './catalog-client.js';

/** Score bump applied to certified-publisher rows on the `popular` sort. Worth
 *  about 50 installs — a soft nudge, not a hard pin.
 *
 *  ⚠ `publisher_certified` is NOT a column on `recipes` / `packs`: `certified`
 *  lives on `publishers` (migration 016) and is stamped onto listing rows by the
 *  worker's `applyPublisherProfiles`. The SQL side therefore has to JOIN to
 *  reproduce this sorter — see migration 030. */
export const CERTIFIED_RANKING_BOOST = 50;

/** The `updated` sorter's key — last publish / meta-edit time, falling back to
 *  `created_at` for rows projected before `updated_at` was selected. */
const updatedKey = (r: { updated_at?: string; created_at: string }): string =>
  r.updated_at ?? r.created_at;

const popularScore = (r: { download_count: number; publisher_certified?: boolean }): number =>
  r.download_count + (r.publisher_certified === true ? CERTIFIED_RANKING_BOOST : 0);

export const recipeSpec: DiscoverSpec<CatalogRecipeRow> = {
  // `recipe_id` is in the haystack because the slug is the SHAREABLE identifier
  // — it is what gets pasted into a chat or an issue, and a reader who pastes
  // one expects to land on it. `description` carries the bulk of the text.
  searchableText: (r) =>
    `${r.name} ${r.description} ${r.tags.join(' ')} ${r.platforms.join(' ')} ${r.publisher_id} ${r.recipe_id}`,
  // No `type` facet: the column was dropped in migration 002, it is not in the
  // catalog projection, and `parseRecipeRow` therefore always read `''` — so
  // the facet produced no values and the chip group never rendered. The search
  // RPC declares the same facets, which is what keeps the two in step.
  facets: [
    { key: 'platform', values: (r) => r.platforms },
    { key: 'tag', values: (r) => r.tags },
    // Declared for the marketplace SPA: it renders a publisher chip group AND
    // its `/publishers/<handle>` view is this facet with one value selected.
    // The webclient exposes no publisher group — the handle vocabulary is
    // unbounded, so it would be a wall of chips.
    { key: 'publisher', values: (r) => [r.publisher_id] },
  ],
  // ⚠ ORDER IS LOAD-BEARING: the first entry is the fallback for an empty or
  // unknown `sort`, in `resolveSorter` AND in the SQL's per-kind valid-sort
  // list. `downloads` must stay first — moving it silently re-ranks every
  // unsorted query on both surfaces.
  sorters: {
    downloads: byNumberDesc((r) => r.download_count, (r) => r.recipe_id),
    rating: byNumberDesc((r) => r.rating_avg, (r) => r.recipe_id),
    newest: byDateDesc((r) => r.created_at, (r) => r.recipe_id),
    name: byStringAsc((r) => r.name),
    // Explicit type argument: inferring `Row` from the shared `popularScore` /
    // `updatedKey` accessors would bind it to their structural parameter type,
    // not the row.
    popular: byNumberDesc<CatalogRecipeRow>(popularScore, (r) => r.recipe_id),
    updated: byDateDesc<CatalogRecipeRow>(updatedKey, (r) => r.recipe_id),
  },
};

export const packSpec: DiscoverSpec<CatalogPackRow> = {
  // `slug` for the same reason `recipe_id` is on the recipe side.
  searchableText: (r) =>
    `${r.name} ${r.description} ${r.tags.join(' ')} ${r.publisher_id} ${r.service_kind ?? ''} ${r.slug}`,
  facets: [
    { key: 'service_kind', values: (r) => (r.service_kind !== undefined ? [r.service_kind] : []) },
    { key: 'pack_kind', values: (r) => (r.pack_kind !== '' ? [r.pack_kind] : []) },
    { key: 'tag', values: (r) => r.tags },
    // Packs need the publisher facet too — `/publishers/<handle>` lists a
    // publisher's packs alongside their recipes.
    { key: 'publisher', values: (r) => [r.publisher_id] },
  ],
  // `downloads` first — see the note on `recipeSpec.sorters`. Packs carry no
  // `rating_avg`, so they have no `rating` sorter; asking for one falls back.
  sorters: {
    downloads: byNumberDesc((r) => r.download_count, (r) => r.slug),
    newest: byDateDesc((r) => r.created_at, (r) => r.slug),
    name: byStringAsc((r) => r.name),
    popular: byNumberDesc<CatalogPackRow>(popularScore, (r) => r.slug),
    updated: byDateDesc<CatalogPackRow>(updatedKey, (r) => r.slug),
  },
};
