/** Phase G (D-109) — `collection.resync` + `collection.deleteRecord`
 *  rpc tests.
 *
 *  Tests exercise the handler in isolation using a spy Collection.
 *  Full-stack tests live in `phase-g-e2e.test.ts` (future). */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Collection,
  CollectionPruneResult,
} from '../collections/types.js';
import {
  handleCollectionDeleteRecord,
  handleCollectionResync,
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
  sync: over.sync ?? {
    start: async () => {},
    stop: async () => {},
  },
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
  } satisfies CollectionPruneResult)),
  close: over.close ?? (async () => {}),
});

describe('collection.resync', () => {
  it('invokes sync.start on the target collection', async () => {
    const registry = createCollectionRegistry();
    const start = vi.fn().mockResolvedValue(undefined);
    registry.register(fakeCollection({
      sync: { start, stop: async () => {} },
    }));
    const res = await handleCollectionResync(
      { registry },
      { platform: 'mail', slug: 'work' },
    );
    expect(res.ok).toBe(true);
    expect(start).toHaveBeenCalledOnce();
  });

  it('404s when the collection is not registered', async () => {
    const registry = createCollectionRegistry();
    await expect(
      handleCollectionResync(
        { registry },
        { platform: 'mail', slug: 'ghost' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('wraps source errors as collection_source_unreachable', async () => {
    const registry = createCollectionRegistry();
    registry.register(fakeCollection({
      sync: {
        start: async () => { throw new Error('imap down'); },
        stop: async () => {},
      },
    }));
    await expect(
      handleCollectionResync(
        { registry },
        { platform: 'mail', slug: 'work' },
      ),
    ).rejects.toMatchObject({ code: 'collection_source_unreachable' });
  });
});

describe('collection.deleteRecord', () => {
  it('removes the matching record_id', async () => {
    const registry = createCollectionRegistry();
    const del = vi.fn().mockReturnValue(true);
    registry.register(fakeCollection({ delete: del }));
    const res = await handleCollectionDeleteRecord(
      { registry },
      { platform: 'mail', slug: 'work', record_id: 'abc-1' },
    );
    expect(res.ok).toBe(true);
    expect(del).toHaveBeenCalledWith('abc-1');
  });

  it('404s COLLECTION_RECORD_NOT_FOUND when the row is missing', async () => {
    const registry = createCollectionRegistry();
    registry.register(fakeCollection({ delete: () => false }));
    await expect(
      handleCollectionDeleteRecord(
        { registry },
        { platform: 'mail', slug: 'work', record_id: 'ghost' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects empty record_id', async () => {
    const registry = createCollectionRegistry();
    registry.register(fakeCollection());
    await expect(
      handleCollectionDeleteRecord(
        { registry },
        { platform: 'mail', slug: 'work', record_id: '' },
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('surfaces 404 when the collection is unknown', async () => {
    const registry = createCollectionRegistry();
    await expect(
      handleCollectionDeleteRecord(
        { registry },
        { platform: 'mail', slug: 'ghost', record_id: 'abc' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('slice exposes both new methods', () => {
    const registry = createCollectionRegistry();
    const slice = makeCollectionHandlers({ registry });
    const methods = slice?.methods as readonly string[] | undefined;
    expect(methods).toContain('collection.resync');
    expect(methods).toContain('collection.deleteRecord');
  });
});
