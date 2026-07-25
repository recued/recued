/** D-115 Phase 6B — mail-watcher handler tests. */

import { describe, it, expect, vi } from 'vitest';
import { IngredientError } from '@recued/ingredients';
import type { CollectionRecord, CollectionListQuery } from '@recued/contracts';

import type { Collection } from '../../types.js';
import { handleMailWatcher } from '../mail-watcher.js';

const mkRecord = (
  overrides: Partial<CollectionRecord> & Pick<CollectionRecord, 'record_id' | 'received_at'>,
): CollectionRecord => ({
  record_id: overrides.record_id,
  received_at: overrides.received_at,
  modified_at: overrides.modified_at ?? overrides.received_at,
  hot_fields: overrides.hot_fields ?? {},
  size_bytes: overrides.size_bytes ?? 1024,
  source_id: overrides.source_id ?? 'imap',
});

const mkCollection = (records: CollectionRecord[]): Collection => ({
  platform: 'mail',
  slug: 'primary',
  get: (id: string) => records.find((r) => r.record_id === id) ?? null,
  list: (query: CollectionListQuery) => {
    let rs = records.slice();
    if (query.since !== undefined) rs = rs.filter((r) => r.received_at >= query.since!);
    if (query.filters) {
      for (const [k, v] of Object.entries(query.filters)) {
        rs = rs.filter((r) => r.hot_fields[k] === v);
      }
    }
    rs.sort((a, b) => b.received_at - a.received_at);
    const limit = query.limit ?? 50;
    return rs.slice(0, limit);
  },
  search: () => [],
  async close() {},
} as unknown as Collection);

const nowFixed = () => 10_000;

describe('handleMailWatcher — routing', () => {
  it('returns no-fire on unknown slug', async () => {
    const r = await handleMailWatcher(
      { getCollection: () => undefined, now: nowFixed },
      { slug: 'missing' },
    );
    expect(r.should_run).toBe(false);
    expect(r.items).toEqual([]);
    expect(r.last_seen_at).toBe(10_000);
  });
  it('returns no-fire when resolved collection is non-mail', async () => {
    const bogus = {
      platform: 'file',
      slug: 'primary',
      list: () => [],
    } as unknown as Collection;
    const r = await handleMailWatcher(
      { getCollection: () => bogus, now: nowFixed },
      { slug: 'primary' },
    );
    expect(r.should_run).toBe(false);
  });
});

describe('handleMailWatcher — since filter', () => {
  it('returns matches with received_at >= since', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'a', received_at: 1000 }),
      mkRecord({ record_id: 'b', received_at: 2000 }),
      mkRecord({ record_id: 'c', received_at: 3000 }),
    ]);
    const r = await handleMailWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'primary', since: 1500 },
    );
    expect(r.should_run).toBe(true);
    expect(r.items.map((x) => x.record_id)).toEqual(['b', 'c']);
    expect(r.last_seen_at).toBe(3000);
  });
  it('items sorted ascending by received_at', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'late', received_at: 5000 }),
      mkRecord({ record_id: 'mid', received_at: 3000 }),
      mkRecord({ record_id: 'early', received_at: 2000 }),
    ]);
    const r = await handleMailWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'primary' },
    );
    expect(r.items.map((x) => x.record_id)).toEqual(['early', 'mid', 'late']);
  });
  it('quiet window rolls last_seen_at to now', async () => {
    const collection = mkCollection([]);
    const r = await handleMailWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'primary', since: 5000 },
    );
    expect(r.should_run).toBe(false);
    expect(r.last_seen_at).toBe(10_000);
  });
});

describe('handleMailWatcher — filters', () => {
  it('exact match on from', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'a', received_at: 1000, hot_fields: { from: 'boss@x.com' } }),
      mkRecord({ record_id: 'b', received_at: 2000, hot_fields: { from: 'spam@y.com' } }),
    ]);
    const r = await handleMailWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'primary', from: 'boss@x.com' },
    );
    expect(r.items.map((x) => x.record_id)).toEqual(['a']);
  });
  it('subject substring case-insensitive', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'a', received_at: 1000, hot_fields: { subject: 'Urgent: invoice #42' } }),
      mkRecord({ record_id: 'b', received_at: 2000, hot_fields: { subject: 'FYI — meeting' } }),
      mkRecord({ record_id: 'c', received_at: 3000, hot_fields: { subject: 'urgent follow-up' } }),
    ]);
    const r = await handleMailWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'primary', subject: 'urgent' },
    );
    expect(r.items.map((x) => x.record_id).sort()).toEqual(['a', 'c']);
  });
  it('label exact membership', async () => {
    const collection = mkCollection([
      mkRecord({ record_id: 'a', received_at: 1000, hot_fields: { labels: ['Important', 'Work'] } }),
      mkRecord({ record_id: 'b', received_at: 2000, hot_fields: { labels: ['Personal'] } }),
      mkRecord({ record_id: 'c', received_at: 3000, hot_fields: { labels: [] } }),
    ]);
    const r = await handleMailWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'primary', label: 'Important' },
    );
    expect(r.items.map((x) => x.record_id)).toEqual(['a']);
  });
  it('AND-combines from + subject + label', async () => {
    const collection = mkCollection([
      mkRecord({
        record_id: 'match',
        received_at: 1000,
        hot_fields: { from: 'boss@x.com', subject: 'Urgent', labels: ['Work'] },
      }),
      mkRecord({
        record_id: 'wrong_from',
        received_at: 2000,
        hot_fields: { from: 'intern@x.com', subject: 'Urgent', labels: ['Work'] },
      }),
      mkRecord({
        record_id: 'wrong_subject',
        received_at: 3000,
        hot_fields: { from: 'boss@x.com', subject: 'fyi', labels: ['Work'] },
      }),
      mkRecord({
        record_id: 'wrong_label',
        received_at: 4000,
        hot_fields: { from: 'boss@x.com', subject: 'Urgent', labels: ['Personal'] },
      }),
    ]);
    const r = await handleMailWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'primary', from: 'boss@x.com', subject: 'urgent', label: 'Work' },
    );
    expect(r.items.map((x) => x.record_id)).toEqual(['match']);
  });
});

describe('handleMailWatcher — limit', () => {
  it('caps items at explicit limit', async () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      mkRecord({ record_id: `r${i}`, received_at: 1000 + i * 100 }),
    );
    const collection = mkCollection(records);
    const r = await handleMailWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'primary', limit: 5 },
    );
    expect(r.items).toHaveLength(5);
  });
  it('over-fetches when subject filter set', async () => {
    const listSpy = vi.fn((_query: CollectionListQuery) => [] as CollectionRecord[]);
    const collection = {
      platform: 'mail',
      slug: 'primary',
      list: listSpy,
    } as unknown as Collection;
    await handleMailWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'primary', subject: 'x', limit: 10 },
    );
    const query = listSpy.mock.calls[0][0] as CollectionListQuery;
    expect(query.limit).toBe(40); // limit * SUBJECT_OVERFETCH_FACTOR
  });
});

describe('handleMailWatcher — item shape', () => {
  it('strips body_inline + blob_hash from items', async () => {
    const collection = mkCollection([
      mkRecord({
        record_id: 'a',
        received_at: 1000,
        hot_fields: { subject: 'x' },
      }),
    ]);
    const r = await handleMailWatcher(
      { getCollection: () => collection, now: nowFixed },
      { slug: 'primary' },
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

describe('handleMailWatcher — validation', () => {
  it('rejects missing slug', async () => {
    await expect(
      handleMailWatcher({ getCollection: () => undefined, now: nowFixed }, {}),
    ).rejects.toThrow(IngredientError);
  });
  it('rejects empty slug', async () => {
    await expect(
      handleMailWatcher({ getCollection: () => undefined, now: nowFixed }, { slug: '' }),
    ).rejects.toThrow(/slug/);
  });
});
