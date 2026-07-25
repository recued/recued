/** D-115 Phase 6B — file-watcher handler tests. */

import { describe, it, expect, vi } from 'vitest';
import { IngredientError } from '@recued/ingredients';
import type { CollectionRecord, CollectionListQuery } from '@recued/contracts';

import type { Collection } from '../../types.js';
import { handleFileWatcher } from '../file-watcher.js';

const mkRecord = (
  overrides: Partial<CollectionRecord> & Pick<CollectionRecord, 'record_id'>,
): CollectionRecord => ({
  record_id: overrides.record_id,
  received_at: overrides.received_at ?? 1000,
  modified_at: overrides.modified_at ?? overrides.received_at ?? 1000,
  hot_fields: overrides.hot_fields ?? {},
  size_bytes: overrides.size_bytes ?? 4096,
  source_id: overrides.source_id ?? 'fs',
});

/** In-memory collection stub that honours `modified_since` +
 *  `limit` so the handler's fetch path can be exercised end-to-end. */
const mkCollection = (records: CollectionRecord[]): Collection => ({
  platform: 'file',
  slug: 'home',
  get: (id: string) => records.find((r) => r.record_id === id) ?? null,
  list: (query: CollectionListQuery) => {
    let rs = records.slice();
    if (query.modified_since !== undefined) {
      rs = rs.filter((r) => r.modified_at >= query.modified_since!);
    }
    rs.sort((a, b) => b.received_at - a.received_at);
    const limit = query.limit ?? 50;
    return rs.slice(0, limit);
  },
  search: () => [],
  async close() {},
} as unknown as Collection);

const nowFixed = () => 9999;

describe('handleFileWatcher — routing', () => {
  it('no-fire on unknown slug', async () => {
    const r = await handleFileWatcher(
      { getCollection: () => undefined, now: nowFixed },
      { slug: 'nope' },
    );
    expect(r.should_run).toBe(false);
    expect(r.last_seen_at).toBe(9999);
  });
  it('no-fire when resolved collection is non-file', async () => {
    const bogus = {
      platform: 'mail',
      slug: 'home',
      list: () => [],
    } as unknown as Collection;
    const r = await handleFileWatcher(
      { getCollection: () => bogus, now: nowFixed },
      { slug: 'home' },
    );
    expect(r.should_run).toBe(false);
  });
});

describe('handleFileWatcher — modified_since cursor', () => {
  it('returns matches with modified_at >= since', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'a', modified_at: 1000 }),
      mkRecord({ record_id: 'b', modified_at: 2000 }),
      mkRecord({ record_id: 'c', modified_at: 3000 }),
    ]);
    const r = await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home', since: 1500 },
    );
    expect(r.should_run).toBe(true);
    expect(r.items.map((x) => x.record_id)).toEqual(['b', 'c']);
    expect(r.last_seen_at).toBe(3000);
  });
  it('items sorted ascending by modified_at', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'late', modified_at: 5000 }),
      mkRecord({ record_id: 'early', modified_at: 2000 }),
      mkRecord({ record_id: 'mid', modified_at: 3000 }),
    ]);
    const r = await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home' },
    );
    expect(r.items.map((x) => x.record_id)).toEqual(['early', 'mid', 'late']);
  });
  it('quiet window rolls cursor to now', async () => {
    const collection = mkCollection([]);
    const r = await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home', since: 5000 },
    );
    expect(r.should_run).toBe(false);
    expect(r.last_seen_at).toBe(9999);
  });
  it('passes modified_since to the collection list query', async () => {
    const listSpy = vi.fn((_query: CollectionListQuery) => [] as CollectionRecord[]);
    const collection = {
      platform: 'file',
      slug: 'home',
      list: listSpy,
    } as unknown as Collection;
    await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home', since: 1234 },
    );
    const query = listSpy.mock.calls[0][0] as CollectionListQuery;
    expect(query.modified_since).toBe(1234);
    expect(query.since).toBeUndefined();
  });
});

describe('handleFileWatcher — filters', () => {
  it('path_prefix case-sensitive', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'a', modified_at: 1000, hot_fields: { path: '/Notes/todo.md' } }),
      mkRecord({ record_id: 'b', modified_at: 2000, hot_fields: { path: '/Projects/spec.md' } }),
      mkRecord({ record_id: 'c', modified_at: 3000, hot_fields: { path: '/notes/lower.md' } }),
    ]);
    const r = await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home', path_prefix: '/Notes' },
    );
    expect(r.items.map((x) => x.record_id)).toEqual(['a']);
  });
  it('extension match normalises leading dot + case', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'a', modified_at: 1000, hot_fields: { path: '/x/a.MD' } }),
      mkRecord({ record_id: 'b', modified_at: 2000, hot_fields: { path: '/x/b.txt' } }),
      mkRecord({ record_id: 'c', modified_at: 3000, hot_fields: { path: '/x/c.md' } }),
    ]);
    const rDot = await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home', extension: '.md' },
    );
    expect(rDot.items.map((x) => x.record_id).sort()).toEqual(['a', 'c']);
    const rNoDot = await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home', extension: 'md' },
    );
    expect(rNoDot.items.map((x) => x.record_id).sort()).toEqual(['a', 'c']);
  });
  it('size bounds — min + max', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'small', modified_at: 1000, hot_fields: { size: 100 } }),
      mkRecord({ record_id: 'mid', modified_at: 2000, hot_fields: { size: 5000 } }),
      mkRecord({ record_id: 'big', modified_at: 3000, hot_fields: { size: 100_000 } }),
    ]);
    const r = await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home', min_size: 1000, max_size: 10_000 },
    );
    expect(r.items.map((x) => x.record_id)).toEqual(['mid']);
  });
  it('size falls back to size_bytes when hot_fields.size absent', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'a', modified_at: 1000, size_bytes: 500 }),
      mkRecord({ record_id: 'b', modified_at: 2000, size_bytes: 50_000 }),
    ]);
    const r = await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home', max_size: 10_000 },
    );
    expect(r.items.map((x) => x.record_id)).toEqual(['a']);
  });
  it('AND-combines prefix + extension + size', async () => {
    const collection = mkCollection([
      mkRecord({
        record_id: 'match',
        modified_at: 1000,
        hot_fields: { path: '/docs/readme.md', size: 4096 },
      }),
      mkRecord({
        record_id: 'wrong_ext',
        modified_at: 2000,
        hot_fields: { path: '/docs/readme.txt', size: 4096 },
      }),
      mkRecord({
        record_id: 'wrong_path',
        modified_at: 3000,
        hot_fields: { path: '/other/readme.md', size: 4096 },
      }),
      mkRecord({
        record_id: 'too_big',
        modified_at: 4000,
        hot_fields: { path: '/docs/big.md', size: 1_000_000 },
      }),
    ]);
    const r = await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home', path_prefix: '/docs', extension: 'md', max_size: 10_000 },
    );
    expect(r.items.map((x) => x.record_id)).toEqual(['match']);
  });
});

describe('handleFileWatcher — limit', () => {
  it('caps items at explicit limit', async () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      mkRecord({ record_id: `r${i}`, modified_at: 1000 + i * 100 }),
    );
    const collection = mkCollection(records);
    const r = await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home', limit: 5 },
    );
    expect(r.items).toHaveLength(5);
  });
  it('over-fetches when filter set', async () => {
    const listSpy = vi.fn((_query: CollectionListQuery) => [] as CollectionRecord[]);
    const collection = {
      platform: 'file',
      slug: 'home',
      list: listSpy,
    } as unknown as Collection;
    await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home', extension: 'md', limit: 10 },
    );
    const query = listSpy.mock.calls[0][0] as CollectionListQuery;
    expect(query.limit).toBe(40);
  });
});

describe('handleFileWatcher — item shape', () => {
  it('strips body_inline + blob_hash', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'a', modified_at: 1000, hot_fields: { path: '/x.md' } }),
    ]);
    const r = await handleFileWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'home' },
    );
    const keys = Object.keys(r.items[0]).sort();
    expect(keys).toEqual([
      'hot_fields',
      'modified_at',
      'received_at',
      'record_id',
      'size_bytes',
      'source_id',
    ]);
  });
});

describe('handleFileWatcher — validation', () => {
  it('rejects missing slug', async () => {
    await expect(
      handleFileWatcher({ getCollection: () => undefined, now: nowFixed }, {}),
    ).rejects.toThrow(IngredientError);
  });
  it('rejects negative min_size', async () => {
    await expect(
      handleFileWatcher(
        { getCollection: () => undefined, now: nowFixed },
        { slug: 'home', min_size: -1 },
      ),
    ).rejects.toThrow(/min_size/);
  });
  it('rejects negative max_size', async () => {
    await expect(
      handleFileWatcher(
        { getCollection: () => undefined, now: nowFixed },
        { slug: 'home', max_size: -1 },
      ),
    ).rejects.toThrow(/max_size/);
  });
});
