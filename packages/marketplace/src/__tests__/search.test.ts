import { describe, it, expect } from 'vitest';
import { search, matchesQuery, rankListings } from '../search.js';
import type { MarketplaceListing, SearchQuery } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Listing fixtures
// ────────────────────────────────────────────────────────────────

const mkListing = (overrides: Partial<MarketplaceListing> = {}): MarketplaceListing => ({
  recipe_id: overrides.recipe_id ?? 'test-recipe',
  publisher_id: 'test-publisher',
  version: 1,
  recipe_hash: 'abcd1234',
  name: overrides.name ?? 'Test Recipe',
  description: overrides.description ?? 'A test fixture recipe',
  platforms: overrides.platforms ?? ['hubspot'],
  tags: overrides.tags ?? ['test'],
  author: overrides.author ?? 'test-author',
  published_at: overrides.published_at ?? 1_000_000,
  updated_at: overrides.updated_at ?? 1_000_000,
  download_count: overrides.download_count ?? 0,
  rating: overrides.rating ?? { average: 0, count: 0 },
  variant_group: null,
  fork_of: null,
  recipe: null,
  signature: null,
  ...overrides,
});

const dealRisk = mkListing({
  recipe_id: 'deal-risk', name: 'Deal Risk Detector',
  description: 'Highlights risky deals', tags: ['deal', 'risk', 'sales'],
  platforms: ['hubspot'], author: 'recued-core',
  published_at: 1_000_000, updated_at: 2_000_000, download_count: 500,
  rating: { average: 4.5, count: 100 },
});

const staleDeals = mkListing({
  recipe_id: 'stale-deals', name: 'Stale Deal Finder',
  description: 'Shows deals with no recent activity', tags: ['deal', 'stale', 'sales'],
  platforms: ['hubspot', 'salesforce'], author: 'recued-core',
  published_at: 2_000_000, updated_at: 2_500_000, download_count: 200,
  rating: { average: 4.0, count: 50 },
});

const emailDraft = mkListing({
  recipe_id: 'email-draft', name: 'Email Draft Composer',
  description: 'AI-powered email drafter', tags: ['email', 'ai'],
  platforms: ['gmail'], author: 'community-user',
  published_at: 500_000, updated_at: 500_000, download_count: 1000,
  rating: { average: 3.8, count: 20 },
});

const unratedNew = mkListing({
  recipe_id: 'unrated-new', name: 'Brand New Recipe',
  description: 'Just published', tags: ['new'],
  platforms: ['hubspot'],
  published_at: 3_000_000, updated_at: 3_000_000, download_count: 0,
  rating: { average: 0, count: 0 },
});

const fixtures = [dealRisk, staleDeals, emailDraft, unratedNew];

// ────────────────────────────────────────────────────────────────
// matchesQuery
// ────────────────────────────────────────────────────────────────

describe('matchesQuery', () => {
  it('empty query matches everything', () => {
    expect(matchesQuery(dealRisk, {})).toBe(true);
  });

  it('text query is case-insensitive substring match', () => {
    expect(matchesQuery(dealRisk, { text: 'DEAL' })).toBe(true);
    expect(matchesQuery(dealRisk, { text: 'risk' })).toBe(true);
    expect(matchesQuery(dealRisk, { text: 'nothing' })).toBe(false);
  });

  it('text query matches against description', () => {
    expect(matchesQuery(emailDraft, { text: 'AI-powered' })).toBe(true);
  });

  it('text query matches against tags', () => {
    expect(matchesQuery(dealRisk, { text: 'sales' })).toBe(true);
  });

  it('tags filter requires ALL specified tags', () => {
    expect(matchesQuery(dealRisk, { tags: ['deal', 'risk'] })).toBe(true);
    expect(matchesQuery(dealRisk, { tags: ['deal', 'nonexistent'] })).toBe(false);
  });

  it('platforms filter requires AT LEAST ONE match', () => {
    expect(matchesQuery(staleDeals, { platforms: ['salesforce'] })).toBe(true);
    expect(matchesQuery(staleDeals, { platforms: ['hubspot', 'gmail'] })).toBe(true);
    expect(matchesQuery(staleDeals, { platforms: ['pipedrive'] })).toBe(false);
  });

  it('author filter is exact', () => {
    expect(matchesQuery(dealRisk, { author: 'recued-core' })).toBe(true);
    expect(matchesQuery(dealRisk, { author: 'someone-else' })).toBe(false);
  });

  it('min_rating filter allows unrated listings (rating count = 0)', () => {
    // Unrated listings should not be filtered out — new recipes need a
    // chance to be discovered.
    expect(matchesQuery(unratedNew, { min_rating: 4 })).toBe(true);
  });

  it('min_rating filter excludes rated listings below threshold', () => {
    expect(matchesQuery(emailDraft, { min_rating: 4 })).toBe(false); // 3.8 < 4
    expect(matchesQuery(dealRisk, { min_rating: 4 })).toBe(true);    // 4.5 >= 4
  });

  it('combines multiple filters as AND', () => {
    const q: SearchQuery = { text: 'deal', platforms: ['hubspot'] };
    expect(matchesQuery(dealRisk, q)).toBe(true);
    expect(matchesQuery(staleDeals, q)).toBe(true);
    expect(matchesQuery(emailDraft, q)).toBe(false); // platform mismatch
  });

  it('whitespace-only text is treated as empty', () => {
    expect(matchesQuery(dealRisk, { text: '   ' })).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// rankListings
// ────────────────────────────────────────────────────────────────

describe('rankListings', () => {
  it('default sort is popular (download_count desc)', () => {
    const ranked = rankListings([...fixtures], {});
    expect(ranked[0].recipe_id).toBe('email-draft'); // 1000 downloads
    expect(ranked[1].recipe_id).toBe('deal-risk');   // 500
    expect(ranked[2].recipe_id).toBe('stale-deals'); // 200
    expect(ranked[3].recipe_id).toBe('unrated-new'); // 0
  });

  it('sort by newest → by published_at desc', () => {
    const ranked = rankListings([...fixtures], { sort: 'newest' });
    expect(ranked.map((l) => l.recipe_id)).toEqual([
      'unrated-new', 'stale-deals', 'deal-risk', 'email-draft',
    ]);
  });

  it('sort by oldest → by published_at asc', () => {
    const ranked = rankListings([...fixtures], { sort: 'oldest' });
    expect(ranked.map((l) => l.recipe_id)).toEqual([
      'email-draft', 'deal-risk', 'stale-deals', 'unrated-new',
    ]);
  });

  it('sort by rating puts unrated last', () => {
    const ranked = rankListings([...fixtures], { sort: 'rating' });
    expect(ranked[0].recipe_id).toBe('deal-risk'); // 4.5
    expect(ranked[1].recipe_id).toBe('stale-deals'); // 4.0
    expect(ranked[2].recipe_id).toBe('email-draft'); // 3.8
    expect(ranked[3].recipe_id).toBe('unrated-new'); // unrated → last
  });

  it('sort by updated → updated_at desc', () => {
    const ranked = rankListings([...fixtures], { sort: 'updated' });
    expect(ranked[0].recipe_id).toBe('unrated-new'); // 3_000_000
    expect(ranked[1].recipe_id).toBe('stale-deals'); // 2_500_000
  });

  it('popular sort with text query applies relevance boost', () => {
    // 'deal' exact-matches the name "Deal Risk Detector" partially,
    // and also appears in "Stale Deal Finder". email-draft has no match
    // for 'deal' but has higher downloads — relevance wins.
    const ranked = rankListings([...fixtures], { sort: 'popular', text: 'deal' });
    expect(ranked[0].recipe_id).toBe('deal-risk');
    // email-draft should not be first despite having 1000 downloads
    expect(ranked[0].recipe_id).not.toBe('email-draft');
  });

  it('deterministic tiebreaker: recipe_id asc when primary is equal', () => {
    const a = mkListing({ recipe_id: 'a', download_count: 100 });
    const b = mkListing({ recipe_id: 'b', download_count: 100 });
    const ranked = rankListings([b, a], {});
    expect(ranked.map((l) => l.recipe_id)).toEqual(['a', 'b']);
  });
});

// ────────────────────────────────────────────────────────────────
// search (end-to-end)
// ────────────────────────────────────────────────────────────────

describe('search', () => {
  it('returns matching listings with total and query echo', () => {
    const result = search(fixtures, { tags: ['deal'] });
    expect(result.total).toBe(2);
    expect(result.listings.length).toBe(2);
    expect(result.query.tags).toEqual(['deal']);
  });

  it('paginates via limit + offset', () => {
    const page1 = search(fixtures, { limit: 2, offset: 0 });
    const page2 = search(fixtures, { limit: 2, offset: 2 });
    expect(page1.listings.length).toBe(2);
    expect(page2.listings.length).toBe(2);
    expect(page1.total).toBe(4);
    expect(page2.total).toBe(4);
    // No overlap
    const ids1 = new Set(page1.listings.map((l) => l.recipe_id));
    for (const l of page2.listings) expect(ids1.has(l.recipe_id)).toBe(false);
  });

  it('empty query returns all listings with default sort', () => {
    const result = search(fixtures, {});
    expect(result.listings.length).toBe(4);
    expect(result.total).toBe(4);
  });

  it('empty listings array returns empty result', () => {
    const result = search([], { text: 'anything' });
    expect(result.listings).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('text + type + platform combined', () => {
    const result = search(fixtures, {
      text: 'deal',
      platforms: ['hubspot'],
    });
    expect(result.listings.map((l) => l.recipe_id).sort()).toEqual(['deal-risk', 'stale-deals']);
  });
});
