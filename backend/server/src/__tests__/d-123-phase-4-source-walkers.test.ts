/** D-123 Phase 4 — Source-walker registry tests.
 *
 *  Verifies the `mail` walker over a `CollectionRegistry` populated
 *  with stub `MailCollection`-shaped instances. The walker contract
 *  is composable: `walkAfter` returns records monotonically, and the
 *  registry routes per-`EnrichmentScope`. */

import { describe, expect, it } from 'vitest';

import type {
  Collection,
  CollectionPruneResult,
  CollectionSyncAdapter,
} from '../collections/types.js';
import type {
  CollectionHealth,
  CollectionListQuery,
  CollectionPlatform,
  CollectionRecord,
  CollectionSearchMatch,
  CollectionSearchQuery,
  CollectionState,
} from '@recued/contracts';

import { createCollectionRegistry } from '../collections/registry.js';
import {
  createMailSourceWalker,
  createSourceWalkerRegistry,
  createTestSourceWalkerRegistry,
} from '../housekeeping/source-walkers.js';

/** Minimal stub `Collection` honouring only the surface the mail
 *  walker reaches: `platform` / `slug` / `list` / `get`. */
const makeStubMailCollection = (
  slug: string,
  records: CollectionRecord[],
): Collection => {
  const byId = new Map(records.map((r) => [r.record_id, r]));
  const stubSync: CollectionSyncAdapter = {
    start: () => undefined,
    stop: () => undefined,
    state: () => 'idle' satisfies CollectionState,
  } as unknown as CollectionSyncAdapter;
  const stubGate: Collection['gate'] = {} as Collection['gate'];
  return {
    platform: 'mail' satisfies CollectionPlatform as CollectionPlatform,
    slug,
    gate: stubGate,
    upsert: () => undefined,
    delete: () => false,
    get: (record_id: string) => byId.get(record_id) ?? null,
    list: (query: CollectionListQuery) =>
      query.slug === slug ? [...records] : [],
    search: (_q: CollectionSearchQuery): CollectionSearchMatch[] => [],
    sync: stubSync,
    health: (): CollectionHealth => ({
      platform: 'mail',
      slug,
      last_indexed_at: 0,
      pending_queue_size: 0,
      error_count_24h: 0,
      state: 'idle',
    }),
    runRetention: async (): Promise<CollectionPruneResult> => ({
      ran: false,
      reason: 'unsupported_for_test',
      records_pruned: 0,
      bytes_freed: 0,
    } as unknown as CollectionPruneResult),
    close: async () => undefined,
  };
};

const fakeRecord = (record_id: string, hot: Record<string, unknown> = {}): CollectionRecord => ({
  record_id,
  received_at: 1_700_000_000_000,
  modified_at: 1_700_000_000_000,
  hot_fields: hot,
  size_bytes: 100,
  source_id: record_id,
});

describe('createMailSourceWalker', () => {
  it('walks live mail collections in slug-ASC order with record_id-ASC inside', () => {
    const registry = createCollectionRegistry();
    registry.register(makeStubMailCollection('z-account', [fakeRecord('m4'), fakeRecord('m1')]));
    registry.register(makeStubMailCollection('a-account', [fakeRecord('m3'), fakeRecord('m2')]));

    const walker = createMailSourceWalker(registry);
    const out = Array.from(walker.walkAfter('', 10));
    // a-account first (slug ASC), records sorted by id; then z-account.
    expect(out.map((r) => r.target_id)).toEqual(['m2', 'm3', 'm1', 'm4']);
  });

  it('respects batch_size to bound iteration', () => {
    const registry = createCollectionRegistry();
    registry.register(
      makeStubMailCollection('a', ['a', 'b', 'c', 'd', 'e'].map((id) => fakeRecord(id))),
    );
    const walker = createMailSourceWalker(registry);
    const out = Array.from(walker.walkAfter('', 3));
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.target_id)).toEqual(['a', 'b', 'c']);
  });

  it('resumes past the cursor_token across slug boundaries', () => {
    const registry = createCollectionRegistry();
    registry.register(makeStubMailCollection('a', [fakeRecord('a1'), fakeRecord('a2')]));
    registry.register(makeStubMailCollection('b', [fakeRecord('b1'), fakeRecord('b2')]));
    const walker = createMailSourceWalker(registry);

    // Walk first batch up to a2.
    const first = Array.from(walker.walkAfter('', 2));
    expect(first.map((r) => r.target_id)).toEqual(['a1', 'a2']);

    // Resume — should pick up b1 / b2.
    const last = first[first.length - 1]!;
    const second = Array.from(walker.walkAfter(last.cursor_token, 10));
    expect(second.map((r) => r.target_id)).toEqual(['b1', 'b2']);
  });

  it('hashes only thread-relevant hot fields (received_at irrelevant)', () => {
    const registry = createCollectionRegistry();
    registry.register(
      makeStubMailCollection('a', [
        fakeRecord('m1', { from: 'alice@x', subject: 'hi', thread_id: 't1', is_read: true }),
      ]),
    );
    const walker = createMailSourceWalker(registry);
    const [record] = Array.from(walker.walkAfter('', 10));
    const hash1 = walker.hashOf(record!);
    // Same record content under a different received_at → same hash.
    const updated = {
      ...record!,
      data: { ...record!.data, received_at: 9_999_999_999_999 },
    };
    expect(walker.hashOf(updated)).toBe(hash1);
  });

  it('hashes change when a thread-relevant field changes', () => {
    const registry = createCollectionRegistry();
    registry.register(
      makeStubMailCollection('a', [
        fakeRecord('m1', { from: 'alice@x', thread_id: 't1', is_read: true }),
      ]),
    );
    const walker = createMailSourceWalker(registry);
    const [record] = Array.from(walker.walkAfter('', 10));
    const before = walker.hashOf(record!);
    const after = walker.hashOf({
      ...record!,
      data: {
        ...record!.data,
        hot_fields: { ...record!.data.hot_fields, is_read: false },
      },
    });
    expect(before).not.toBe(after);
  });

  it('fetchOne resolves a record by target_id across all live mail collections', () => {
    const registry = createCollectionRegistry();
    registry.register(makeStubMailCollection('a', [fakeRecord('mA')]));
    registry.register(makeStubMailCollection('b', [fakeRecord('mB')]));
    const walker = createMailSourceWalker(registry);

    expect(walker.fetchOne('mA')?.target_id).toBe('mA');
    expect(walker.fetchOne('mB')?.target_id).toBe('mB');
    expect(walker.fetchOne('mZ')).toBeNull();
  });

  it('skips non-mail collections in the registry', () => {
    const registry = createCollectionRegistry();
    registry.register(makeStubMailCollection('a', [fakeRecord('mA')]));
    // Inject a non-mail collection (platform = file) — walker should ignore it.
    registry.register({
      ...makeStubMailCollection('a-file', []),
      platform: 'file' satisfies CollectionPlatform as CollectionPlatform,
      slug: 'a-file',
    } as unknown as Collection);

    const walker = createMailSourceWalker(registry);
    const out = Array.from(walker.walkAfter('', 10));
    expect(out.map((r) => r.target_id)).toEqual(['mA']);
  });
});

describe('createSourceWalkerRegistry', () => {
  it('routes the mail scope to a live mail walker', () => {
    const registry = createCollectionRegistry();
    registry.register(makeStubMailCollection('a', [fakeRecord('m1')]));
    const sw = createSourceWalkerRegistry({ collections: registry });
    const walker = sw.get('mail');
    expect(walker).toBeDefined();
    const out = Array.from(walker!.walkAfter('', 10));
    expect(out.map((r) => r.target_id)).toEqual(['m1']);
  });

  it('routes the calendar scope to a live calendar walker (D-131 A.5)', () => {
    const sw = createSourceWalkerRegistry({ collections: createCollectionRegistry() });
    // The walker is always registered — `get('calendar')` returns a
    // value even with an empty registry. The walker's walkAfter just
    // yields nothing in that case (no calendar collections to iterate).
    expect(sw.get('calendar')).toBeDefined();
    expect(Array.from(sw.get('calendar')!.walkAfter('', 10))).toEqual([]);
  });

  it('only registers contact when contactStore is supplied (D-131 A.4)', () => {
    const swWithout = createSourceWalkerRegistry({
      collections: createCollectionRegistry(),
    });
    expect(swWithout.get('contact')).toBeUndefined();
    expect(swWithout.get('file')).toBeDefined();
    expect(Array.from(swWithout.get('file')!.walkAfter('', 10))).toEqual([]);
  });
});

describe('createTestSourceWalkerRegistry', () => {
  it('lets tests inject a stub walker for any scope', () => {
    const stubCalls: string[] = [];
    const sw = createTestSourceWalkerRegistry({
      contact: {
        *walkAfter(_cursor, _batch_size) {
          stubCalls.push('walkAfter');
        },
        hashOf() {
          return 'h';
        },
        fetchOne() {
          return null;
        },
      },
    });
    const walker = sw.get('contact');
    expect(walker).toBeDefined();
    Array.from(walker!.walkAfter('', 10));
    expect(stubCalls).toEqual(['walkAfter']);
    expect(sw.get('mail')).toBeUndefined();
  });
});
