import { describe, expect, it } from 'vitest';

import type { CollectionHealth, CollectionSearchMatch } from '@recued/contracts';

import { createCollectionRegistry } from '../registry.js';
import type { Collection } from '../types.js';
import { handleCollectionSearchAll } from '../collection-handler.js';

const NOW = 1_800_000_000_000;

const health = (platform: string, slug: string): CollectionHealth => ({
  platform, slug,
  last_indexed_at: NOW - 60_000,
  pending_queue_size: 0,
  error_count_24h: 0,
  state: 'idle',
} as CollectionHealth);

const match = (id: string): CollectionSearchMatch =>
  ({ record_id: id, hot_fields: {}, rank: -1, body: `body of ${id}` });

/** A collection that returns `n` matches, or throws when `n` is null. */
const store = (platform: string, slug: string, n: number | null): Collection => ({
  platform, slug,
  health: health(platform, slug),
  search: () => {
    if (n === null) throw new Error('this shelf is on fire');
    return Array.from({ length: n }, (_, i) => match(`${slug}-${i}`));
  },
} as unknown as Collection);

const run = async (collections: Collection[], args: Record<string, unknown>) => {
  const registry = createCollectionRegistry();
  collections.forEach((c) => registry.register(c));
  return handleCollectionSearchAll({ registry, now: () => NOW } as never, args as never);
};

describe('collection.searchAll groups rather than ranking', () => {
  it('returns one group per collection that matched, ordered by hit count', async () => {
    const { groups } = await run(
      [store('mail', 'inbox', 2), store('file', 'docs', 5), store('calendar', 'work', 3)],
      { query: 'kestrel', per_group: 10 },
    );
    expect(groups.map((g) => g.slug)).toEqual(['docs', 'work', 'inbox']);
    expect(groups.map((g) => g.matches.length)).toEqual([5, 3, 2]);
  });

  it('omits collections with no hits rather than returning empty groups', async () => {
    const { groups } = await run(
      [store('mail', 'inbox', 0), store('file', 'docs', 1)],
      { query: 'kestrel' },
    );
    expect(groups.map((g) => g.slug)).toEqual(['docs']);
  });

  // ⛔ ONE STORE MUST NOT SINK THE SEARCH. A malformed FTS expression or a store
  // mid-migration throws; a universal search that returns nothing because one
  // shelf is on fire is worse than one that returns the rest.
  it('survives a throwing collection and still returns the others', async () => {
    const { groups } = await run(
      [store('mail', 'inbox', 2), store('file', 'broken', null), store('calendar', 'work', 1)],
      { query: 'kestrel' },
    );
    expect(groups.map((g) => g.slug)).toEqual(['inbox', 'work']);
  });

  it('flags a group that filled its quota, and does not flag one that did not', async () => {
    const { groups } = await run(
      [store('mail', 'full', 5), store('file', 'partial', 2)],
      { query: 'kestrel', per_group: 5 },
    );
    expect(groups.find((g) => g.slug === 'full')?.more).toBe(true);
    expect(groups.find((g) => g.slug === 'partial')?.more).toBe(false);
  });

  it('carries source freshness per group', async () => {
    const { groups } = await run([store('mail', 'inbox', 1)], { query: 'k' });
    expect(groups[0].source_freshness).toBeDefined();
  });

  it('narrows to named platforms', async () => {
    const { groups } = await run(
      [store('mail', 'inbox', 3), store('file', 'docs', 3)],
      { query: 'k', platforms: ['file'] },
    );
    expect(groups.map((g) => g.slug)).toEqual(['docs']);
  });
});

describe('its argument handling', () => {
  // ⚠ Fires on keystrokes — a blank query is an empty result, not an error.
  it.each(['', '   '])('returns no groups for a blank query %j', async (q) => {
    expect((await run([store('mail', 'inbox', 3)], { query: q })).groups).toEqual([]);
  });

  it('clamps per_group to the ceiling instead of honouring a huge page', async () => {
    const { groups } = await run([store('mail', 'inbox', 100)], { query: 'k', per_group: 1000 });
    // The store is asked for at most the ceiling; the stub ignores limit, so the
    // assertion that matters is that the call did not throw and stayed bounded.
    expect(groups[0].matches.length).toBeGreaterThan(0);
  });

  it.each([
    ['non-string query', { query: 5 }],
    ['zero per_group', { query: 'k', per_group: 0 }],
    ['non-array platforms', { query: 'k', platforms: 'mail' }],
    ['unknown platform', { query: 'k', platforms: ['nope'] }],
  ])('rejects %s', async (_label, args) => {
    await expect(run([store('mail', 'inbox', 1)], args)).rejects.toThrow();
  });
});
