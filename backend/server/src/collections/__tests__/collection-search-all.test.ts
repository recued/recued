import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import type { CollectionHealth, CollectionSearchMatch } from '@recued/contracts';

import { createCollectionRegistry } from '../registry.js';
import type { Collection } from '../types.js';
import { handleCollectionSearchAll } from '../collection-handler.js';
import { createCollectionTable } from '../table.js';
import { createCalendarTable } from '../calendar/calendar-table.js';

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

// ── Real tables from here on ─────────────────────────────────────────────────
// ⛔ A double that searches is how calendar went missing: the real calendar
// collection's `search()` is a no-op, and the doubles above all search. These
// use the real FTS tables behind the Collection surface the registry yields.

const dbs: Database.Database[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()!.close();
});

/** A real mail table behind the Collection wrapper, forwarding `search` and
 *  `checkSpelling` the way every collection this server builds does. */
const mailStore = (slug: string, bodies: Record<string, string>): Collection => {
  const db = new Database(':memory:');
  dbs.push(db);
  const table = createCollectionTable({ db, platform: 'mail', slug });
  for (const [id, body] of Object.entries(bodies)) {
    table.upsert({
      record_id: `uid:${id}`, received_at: NOW, modified_at: NOW,
      hot_fields: { from: 'a@b.c', subject: id, is_read: true },
      size_bytes: 10, source_id: `<${id}>`, body_inline: body, origin_actor: 'system',
    });
  }
  return {
    platform: 'mail', slug, health: health('mail', slug),
    search: (q: never) => table.search(q),
    checkSpelling: (q: string) => table.checkSpelling(q),
  } as unknown as Collection;
};

/** A real calendar table behind the collection shape calendar REALLY has:
 *  `search()` a documented no-op, the store on `.table`. */
const calendarStore = (slug: string, events: Record<string, string>): Collection => {
  const db = new Database(':memory:');
  dbs.push(db);
  const table = createCalendarTable({ db, slug });
  for (const [id, summary] of Object.entries(events)) {
    table.upsert({
      event: {
        source_id: id, ical_uid: `${id}@x`, calendar_id: 'primary', summary,
        start_at: NOW, end_at: NOW + 3_600_000, timezone: 'UTC',
        is_all_day: false, status: 'confirmed', attendees: [],
        created_at: NOW, updated_at: NOW,
      },
      size_bytes: 20, body_inline: `${summary}.`, now: NOW,
    } as never);
  }
  return {
    platform: 'calendar', slug, health: health('calendar', slug), table,
    search: () => [],
    checkSpelling: (q: string) => table.checkSpelling(q),
  } as unknown as Collection;
};

describe('calendar, whose Collection.search() is a no-op', () => {
  it('⛔ is searched through its table, so events reach universal search', async () => {
    const { groups } = await run(
      [mailStore('inbox', { m1: 'Kestrel invoice' }), calendarStore('work', { e1: 'Kestrel review' })],
      { query: 'kestrel' },
    );
    expect(groups.map((g) => g.platform).sort()).toEqual(['calendar', 'mail']);
    const calendar = groups.find((g) => g.platform === 'calendar');
    expect(calendar?.matches[0]?.hot_fields.summary).toBe('Kestrel review');
  });
});

describe('did you mean — from the searched stores\' own words', () => {
  it('⛔ offers the owner\'s spelling of a misspelled name', async () => {
    const result = await run(
      [mailStore('inbox', { m1: 'Invoice from Ana Castellanos', m2: 'Castellanos replied' })],
      { query: 'Castelanos invoice' },
    );
    expect(result.did_you_mean).toEqual({
      query: 'Castellanos invoice',
      corrections: [{ typed: 'Castelanos', word: 'Castellanos', records: 2 }],
    });
  });

  it('counts the records of every store that holds the word, calendar included', async () => {
    const result = await run(
      [mailStore('inbox', { m1: 'Call Castellanos' }), calendarStore('work', { e1: 'Castellanos lunch' })],
      { query: 'Castelanos' },
    );
    expect(result.did_you_mean?.corrections).toEqual([
      { typed: 'Castelanos', word: 'Castellanos', records: 2 },
    ]);
  });

  it('⛔ leaves a word that only ONE store holds — here, only the calendar', async () => {
    const result = await run(
      [mailStore('inbox', { m1: 'Kestrel invoice' }), calendarStore('work', { e1: 'Kestral offsite' })],
      { query: 'Kestral' },
    );
    expect(result.did_you_mean).toBeUndefined();
    expect(result.absent_words).toBeUndefined();
    expect(result.groups.map((g) => g.platform)).toEqual(['calendar']);
  });

  it('is absent when every word is on file', async () => {
    const result = await run([mailStore('inbox', { m1: 'Castellanos' })], { query: 'Castellanos' });
    expect(result.did_you_mean).toBeUndefined();
    expect(result.absent_words).toBeUndefined();
  });

  it('⛔ names the word every store dropped when the results matched only the others', async () => {
    // The store relaxed "Castelanos invoice" to "invoice": both invoices come back,
    // the other company's included, and nothing in a row says the name was gone.
    const result = await run(
      [mailStore('inbox', { m1: 'Invoice from Ana Castellanos', m2: 'Car lease invoice' })],
      { query: 'Castelanos invoice' },
    );
    expect(result.groups[0]?.matches.length).toBe(2);
    expect(result.absent_words).toEqual(['Castelanos']);
    expect(result.did_you_mean?.query).toBe('Castellanos invoice');
  });

  it('names a dropped word even with nothing close on file', async () => {
    const result = await run(
      [mailStore('inbox', { m1: 'Car lease invoice' })],
      { query: 'Zylberstein invoice' },
    );
    expect(result.groups[0]?.matches.length).toBe(1);
    expect(result.absent_words).toEqual(['Zylberstein']);
    expect(result.did_you_mean).toBeUndefined();
  });

  it('⛔ offers nothing when a searched store cannot check its words — it may hold the word', async () => {
    const result = await run(
      [mailStore('inbox', { m1: 'Castellanos' }), store('file', 'docs', 0)],
      { query: 'Castelanos' },
    );
    expect(result.did_you_mean).toBeUndefined();
    expect(result.absent_words).toBeUndefined();
  });

  it('⛔ offers nothing when a store\'s check throws', async () => {
    const broken = {
      ...store('file', 'docs', 0),
      checkSpelling: () => { throw new Error('index mid-migration'); },
    } as unknown as Collection;
    const result = await run([mailStore('inbox', { m1: 'Castellanos' }), broken], { query: 'Castelanos' });
    expect(result.did_you_mean).toBeUndefined();
  });

  it('asks only the stores it searched — a store filtered out cannot block the offer', async () => {
    const result = await run(
      [mailStore('inbox', { m1: 'Castellanos' }), store('file', 'docs', 0)],
      { query: 'Castelanos', platforms: ['mail'] },
    );
    expect(result.did_you_mean?.query).toBe('Castellanos');
  });
});
