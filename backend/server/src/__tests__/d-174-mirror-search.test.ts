/** D-174 #22 — `data.mirror.search` handler.
 *
 *  Fan-out keyword search over the warehouse mirror collections that feeds
 *  the Data drill-down's name→entity_id picker. Tests exercise the handler
 *  in isolation against spy Collections (mail/file generic FTS; calendar via
 *  its `.table`; crm has no local store).
 *
 *  The load-bearing assertion is the DOUBLED entity_id (`mail:mail:<id>`):
 *  the warehouse record_id self-prefixes, and `data.timeline` keys links /
 *  enrichments on `<collection>:<record_id>`, so the picker must emit that
 *  exact form or every result resolves to an empty timeline. */

import { describe, expect, it } from 'vitest';
import type { CollectionRecord } from '@recued/contracts';
import type { Collection } from '../collections/types.js';
import {
  handleMirrorSearch,
  makeCollectionHandlers,
} from '../collections/collection-handler.js';
import { createCollectionRegistry } from '../collections/registry.js';

const fakeCollection = (over: Partial<Collection> = {}): Collection => ({
  platform: over.platform ?? 'mail',
  slug: over.slug ?? 'work',
  gate: over.gate ?? ({} as never),
  upsert: over.upsert ?? (() => {}),
  delete: over.delete ?? (() => true),
  get: over.get ?? (() => null),
  list: over.list ?? (() => []),
  search: over.search ?? (() => []),
  sync: over.sync ?? { start: async () => {}, stop: async () => {} },
  health: over.health ?? (() => ({
    platform: 'mail' as const,
    slug: over.slug ?? 'work',
    last_indexed_at: 0,
    pending_queue_size: 0,
    error_count_24h: 0,
    state: 'connected' as const,
  })),
  runRetention: over.runRetention ?? (async () => ({
    pruned_count: 0,
    bytes_freed: 0,
    blob_hashes_freed: [],
    duration_ms: 1,
  })),
  close: over.close ?? (async () => {}),
});

const mailMatch = (record_id: string, subject: string, from: string) => ({
  record_id,
  hot_fields: { subject, from },
  rank: -1,
  snippet: '',
});

const fileRecord = (record_id: string, path: string): CollectionRecord =>
  ({ record_id, hot_fields: { path } } as unknown as CollectionRecord);

/** A calendar collection: the real store hangs off `.table` (the bare
 *  `Collection.search` is a no-op), and `isCalendarCollection` guards on
 *  `'table' in c`. */
const fakeCalendarCollection = (
  slug: string,
  matches: Array<{ record_id: string; summary: string; start_at: number }>,
): Collection =>
  ({
    ...fakeCollection({ platform: 'calendar', slug }),
    table: {
      search: () =>
        matches.map((m) => ({
          record_id: m.record_id,
          hot: { summary: m.summary, start_at: m.start_at, end_at: m.start_at + 1 },
          rank: -1,
          snippet: '',
        })),
    },
  } as unknown as Collection);

const registryOf = (...collections: Collection[]) => {
  const registry = createCollectionRegistry();
  for (const c of collections) registry.register(c);
  return registry;
};

describe('data.mirror.search', () => {
  it('mail — fans out, returns the DOUBLED entity_id with subject/from', async () => {
    const registry = registryOf(
      fakeCollection({
        platform: 'mail',
        slug: 'work',
        search: () => [mailMatch('mail:abc', 'Q3 proposal', 'sam@acme.test')],
      }),
      fakeCollection({
        platform: 'mail',
        slug: 'personal',
        search: () => [mailMatch('mail:def', 'Dinner plans', 'mum@home.test')],
      }),
    );
    const { results } = await handleMirrorSearch({ registry }, {
      kind: 'mail',
      query: 'plans',
    });
    expect(results).toEqual([
      { entity_id: 'mail:mail:abc', label: 'Q3 proposal', sublabel: 'sam@acme.test' },
      { entity_id: 'mail:mail:def', label: 'Dinner plans', sublabel: 'mum@home.test' },
    ]);
  });

  it('mail — empty subject falls back to a placeholder label', async () => {
    const registry = registryOf(
      fakeCollection({
        platform: 'mail',
        search: () => [mailMatch('mail:x', '', 'noreply@x.test')],
      }),
    );
    const { results } = await handleMirrorSearch({ registry }, { kind: 'mail', query: 'x' });
    expect(results[0]).toEqual({
      entity_id: 'mail:mail:x',
      label: '(no subject)',
      sublabel: 'noreply@x.test',
    });
  });

  it('files — substring-matches the path (not FTS), label = basename', async () => {
    const registry = registryOf(
      fakeCollection({
        platform: 'file',
        slug: 'docs',
        list: () => [
          fileRecord('file:a', 'projects/q3/README.md'),
          fileRecord('file:b', 'notes/lunch.txt'),
        ],
      }),
    );
    const { results } = await handleMirrorSearch({ registry }, { kind: 'files', query: 'readme' });
    expect(results).toEqual([
      { entity_id: 'file:file:a', label: 'README.md', sublabel: 'projects/q3/README.md' },
    ]);
  });

  it('calendar — searches via the table, entity_id doubled, label = summary', async () => {
    const registry = registryOf(
      fakeCalendarCollection('primary', [
        { record_id: 'cal:evt1', summary: 'Team standup', start_at: Date.parse('2026-06-20T09:30:00Z') },
      ]),
    );
    const { results } = await handleMirrorSearch({ registry }, { kind: 'calendar', query: 'standup' });
    expect(results[0]?.entity_id).toBe('calendar:cal:evt1');
    expect(results[0]?.label).toBe('Team standup');
    expect(results[0]?.sublabel).toBe('2026-06-20 09:30');
  });

  it('crm — no local store, returns empty', async () => {
    const registry = registryOf(fakeCollection({ platform: 'mail' }));
    expect(await handleMirrorSearch({ registry }, { kind: 'crm', query: 'acme' })).toEqual({
      results: [],
    });
  });

  it('dedups cross-source record_id collisions by entity_id', async () => {
    // Two file sources both holding `README.md` hash to the same record_id.
    const registry = registryOf(
      fakeCollection({
        platform: 'file',
        slug: 'src-a',
        list: () => [fileRecord('file:same', 'README.md')],
      }),
      fakeCollection({
        platform: 'file',
        slug: 'src-b',
        list: () => [fileRecord('file:same', 'README.md')],
      }),
    );
    const { results } = await handleMirrorSearch({ registry }, { kind: 'files', query: 'readme' });
    expect(results).toHaveLength(1);
    expect(results[0]?.entity_id).toBe('file:file:same');
  });

  it('empty query short-circuits to empty (no FTS error)', async () => {
    const registry = registryOf(
      fakeCollection({ platform: 'mail', search: () => [mailMatch('mail:x', 'hi', 'a@b.test')] }),
    );
    expect(await handleMirrorSearch({ registry }, { kind: 'mail', query: '   ' })).toEqual({
      results: [],
    });
  });

  it('returns empty when no collection of the kind is registered', async () => {
    const registry = registryOf(fakeCollection({ platform: 'mail' }));
    expect(await handleMirrorSearch({ registry }, { kind: 'calendar', query: 'x' })).toEqual({
      results: [],
    });
  });

  it('clamps limit to the ceiling and slices results', async () => {
    const many = Array.from({ length: 80 }, (_, i) => mailMatch(`mail:${i}`, `Subject ${i}`, 'a@b.test'));
    const registry = registryOf(fakeCollection({ platform: 'mail', search: () => many }));
    const { results } = await handleMirrorSearch({ registry }, {
      kind: 'mail',
      query: 'subject',
      limit: 999,
    });
    expect(results.length).toBe(50); // MIRROR_SEARCH_MAX_LIMIT
  });

  it('a fractional limit < 1 clamps to 1 (not floored to 0/empty)', async () => {
    const registry = registryOf(
      fakeCollection({ platform: 'mail', search: () => [mailMatch('mail:x', 'Hi', 'a@b.test')] }),
    );
    const { results } = await handleMirrorSearch({ registry }, {
      kind: 'mail',
      query: 'hi',
      limit: 0.5,
    });
    expect(results).toHaveLength(1);
  });

  it('a truly-empty query returns empty (not a validation error)', async () => {
    const registry = registryOf(
      fakeCollection({ platform: 'mail', search: () => [mailMatch('mail:x', 'Hi', 'a@b.test')] }),
    );
    expect(await handleMirrorSearch({ registry }, { kind: 'mail', query: '' })).toEqual({
      results: [],
    });
  });

  it('rejects an unknown kind with bad_request', async () => {
    const registry = registryOf(fakeCollection());
    await expect(
      handleMirrorSearch({ registry }, { kind: 'bogus', query: 'x' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects a non-positive limit', async () => {
    const registry = registryOf(fakeCollection({ platform: 'mail' }));
    await expect(
      handleMirrorSearch({ registry }, { kind: 'mail', query: 'x', limit: 0 }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('is registered in the collection handler slice', () => {
    const slice = makeCollectionHandlers({ registry: createCollectionRegistry() });
    expect(slice?.methods).toContain('data.mirror.search');
    expect(slice?.handlers['data.mirror.search']).toBeTypeOf('function');
  });
});
