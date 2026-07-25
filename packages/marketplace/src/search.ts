/** Pure search: query matching + ranking over an array of listings.
 *
 *  This module implements the client-side filtering and ranking logic.
 *  The SAME logic is used:
 *    1. Client-side over a cached listing set for offline search.
 *    2. (Later) Server-side as the reference implementation of the
 *       marketplace's search endpoint.
 *
 *  Keeping it pure + testable here means the server can be a thin
 *  adapter that hands the logic a listing array.
 */

import type { MarketplaceListing, SearchQuery, SearchResult, SortOrder } from './types.js';

/** Run a `SearchQuery` against a listing array and return a `SearchResult`.
 *  Pure. Deterministic for a given (listings, query) pair. */
export const search = (
  listings: readonly MarketplaceListing[],
  query: SearchQuery,
): SearchResult => {
  const matching = listings.filter((l) => matchesQuery(l, query));
  const ranked = rankListings(matching, query);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? ranked.length;
  const paged = ranked.slice(offset, offset + limit);
  return {
    listings: paged,
    total: matching.length,
    query,
  };
};

/** True if a listing passes all filters in the query. Text filtering is
 *  case-insensitive substring match against name + description + tags. */
export const matchesQuery = (
  listing: MarketplaceListing,
  query: SearchQuery,
): boolean => {
  // Text filter — searches name, description, and tags
  if (query.text && query.text.trim()) {
    const needle = query.text.trim().toLowerCase();
    const haystack = [
      listing.name,
      listing.description,
      ...listing.tags,
    ].join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  // Tags — listing must include ALL specified tags
  if (query.tags && query.tags.length > 0) {
    const listingTags = new Set(listing.tags);
    for (const t of query.tags) {
      if (!listingTags.has(t)) return false;
    }
  }

  // Platforms — listing must support AT LEAST ONE of the specified platforms
  if (query.platforms && query.platforms.length > 0) {
    const listingPlatforms = new Set(listing.platforms);
    const hasAny = query.platforms.some((p) => listingPlatforms.has(p));
    if (!hasAny) return false;
  }

  // Author (exact)
  if (query.author !== undefined && listing.author !== query.author) return false;

  // Minimum rating — listings with zero ratings are included (user would
  // rather discover new recipes than require a rating history). To
  // exclude unrated, callers should use min_rating on top of a count
  // filter (not supported yet — add if needed).
  if (query.min_rating !== undefined
      && listing.rating.count > 0
      && listing.rating.average < query.min_rating) {
    return false;
  }

  return true;
};

/** Sort listings according to `query.sort`. Default is 'popular'. Stable
 *  for equal-key cases — uses recipe_id as the deterministic tiebreaker.
 *
 *  For text queries, 'popular' rankings are additionally re-weighted by
 *  a relevance bonus: exact name match > name substring > description
 *  substring > tag match. This is intentional client-side only; the
 *  server may implement its own ranking. */
export const rankListings = (
  listings: MarketplaceListing[],
  query: SearchQuery,
): MarketplaceListing[] => {
  const sort: SortOrder = query.sort ?? 'popular';
  const text = query.text?.trim().toLowerCase() ?? null;

  const scoreRelevance = (l: MarketplaceListing): number => {
    if (!text) return 0;
    const name = l.name.toLowerCase();
    if (name === text) return 100;
    if (name.includes(text)) return 50;
    if (l.description.toLowerCase().includes(text)) return 20;
    if (l.tags.some((t) => t.toLowerCase().includes(text))) return 10;
    return 0;
  };

  const sorters: Record<SortOrder, (a: MarketplaceListing, b: MarketplaceListing) => number> = {
    newest: (a, b) => b.published_at - a.published_at,
    oldest: (a, b) => a.published_at - b.published_at,
    updated: (a, b) => b.updated_at - a.updated_at,
    popular: (a, b) => {
      // Primary: relevance (if text query). Secondary: download count.
      const rel = scoreRelevance(b) - scoreRelevance(a);
      if (rel !== 0) return rel;
      return b.download_count - a.download_count;
    },
    rating: (a, b) => {
      // Unrated listings sort last within the 'rating' sort.
      const ratedA = a.rating.count > 0 ? a.rating.average : -1;
      const ratedB = b.rating.count > 0 ? b.rating.average : -1;
      return ratedB - ratedA;
    },
  };

  const primary = sorters[sort];
  return [...listings].sort((a, b) => {
    const cmp = primary(a, b);
    if (cmp !== 0) return cmp;
    // Deterministic tiebreaker
    return a.recipe_id.localeCompare(b.recipe_id);
  });
};
