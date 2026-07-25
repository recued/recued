import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { tieredStore } from '../tiered.js';
import { createInMemoryStore } from '../in-memory.js';
import { createIDBStore } from '../idb.js';
import type { CacheEntry, CacheStore } from '../types.js';

const makeEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => ({
  key: 'key1',
  value: { foo: 'bar' },
  expires_at: Date.now() + 60_000,
  recipe_id: 'recipe-a',
  ingredient_slug: 'slug-x',
  size_bytes: 100,
  created_at: Date.now(),
  last_accessed_at: Date.now(),
  ...overrides,
});

/** Spy wrapper — counts how many times each method is called so tests
 *  can assert L1 vs L2 hit distribution. */
const spyStore = (inner: CacheStore) => {
  const calls = {
    get: 0, set: 0, delete: 0,
    deleteByRecipe: 0, size: 0, evictLRU: 0, clear: 0,
  };
  const wrapped: CacheStore = {
    async get(key) { calls.get++; return inner.get(key); },
    async set(entry) { calls.set++; return inner.set(entry); },
    async delete(key) { calls.delete++; return inner.delete(key); },
    async deleteByRecipe(id) { calls.deleteByRecipe++; return inner.deleteByRecipe(id); },
    async size() { calls.size++; return inner.size(); },
    async evictLRU(t) { calls.evictLRU++; return inner.evictLRU(t); },
    async clear() { calls.clear++; return inner.clear(); },
  };
  return { store: wrapped, calls };
};

let counter = 0;
const uniqueDb = () => `tiered-test-${++counter}-${Date.now()}`;

// ────────────────────────────────────────────────────────────────

describe('tieredStore — read path', () => {
  let l1Spy: ReturnType<typeof spyStore>;
  let l2Spy: ReturnType<typeof spyStore>;
  let store: CacheStore;

  beforeEach(() => {
    l1Spy = spyStore(createInMemoryStore());
    l2Spy = spyStore(createInMemoryStore());
    store = tieredStore(l1Spy.store, l2Spy.store);
  });

  it('returns null when both tiers miss', async () => {
    expect(await store.get('missing')).toBeNull();
    expect(l1Spy.calls.get).toBe(1);
    expect(l2Spy.calls.get).toBe(1);
  });

  it('L1 hit short-circuits — L2 never queried', async () => {
    await l1Spy.store.set(makeEntry({ value: 'from-l1' }));
    l1Spy.calls.get = 0; l2Spy.calls.get = 0; // reset after setup
    const result = await store.get('key1');
    expect((result as { value: string }).value).toBe('from-l1');
    expect(l1Spy.calls.get).toBe(1);
    expect(l2Spy.calls.get).toBe(0); // never touched
  });

  it('L1 miss + L2 hit hydrates L1', async () => {
    await l2Spy.store.set(makeEntry({ value: 'from-l2' }));
    // Reset counters after setup
    l1Spy.calls.set = 0;

    const result = await store.get('key1');
    expect((result as { value: string }).value).toBe('from-l2');
    // Hydration: L1 should have been written to
    expect(l1Spy.calls.set).toBe(1);

    // Second read should now be an L1 hit
    l1Spy.calls.get = 0; l2Spy.calls.get = 0;
    await store.get('key1');
    expect(l1Spy.calls.get).toBe(1);
    expect(l2Spy.calls.get).toBe(0);
  });

  it('L1 hydration preserves the original entry (last_accessed_at NOT bumped at store level)', async () => {
    const originalTimestamp = 1234567890;
    await l2Spy.store.set(makeEntry({
      last_accessed_at: originalTimestamp,
      value: 'x',
    }));
    await store.get('key1');
    const hydrated = await l1Spy.store.get('key1');
    expect(hydrated?.last_accessed_at).toBe(originalTimestamp);
  });
});

// ────────────────────────────────────────────────────────────────

describe('tieredStore — write path', () => {
  let l1Spy: ReturnType<typeof spyStore>;
  let l2Spy: ReturnType<typeof spyStore>;
  let store: CacheStore;

  beforeEach(() => {
    l1Spy = spyStore(createInMemoryStore());
    l2Spy = spyStore(createInMemoryStore());
    store = tieredStore(l1Spy.store, l2Spy.store);
  });

  it('set writes to both tiers', async () => {
    await store.set(makeEntry({ value: 'written' }));
    expect(l1Spy.calls.set).toBe(1);
    expect(l2Spy.calls.set).toBe(1);
    expect((await l1Spy.store.get('key1'))?.value).toBe('written');
    expect((await l2Spy.store.get('key1'))?.value).toBe('written');
  });

  it('overwrites propagate to both tiers', async () => {
    await store.set(makeEntry({ value: 'old' }));
    await store.set(makeEntry({ value: 'new' }));
    expect((await l1Spy.store.get('key1'))?.value).toBe('new');
    expect((await l2Spy.store.get('key1'))?.value).toBe('new');
  });
});

// ────────────────────────────────────────────────────────────────

describe('tieredStore — invalidation', () => {
  let l1Spy: ReturnType<typeof spyStore>;
  let l2Spy: ReturnType<typeof spyStore>;
  let store: CacheStore;

  beforeEach(() => {
    l1Spy = spyStore(createInMemoryStore());
    l2Spy = spyStore(createInMemoryStore());
    store = tieredStore(l1Spy.store, l2Spy.store);
  });

  it('delete removes from both tiers', async () => {
    await store.set(makeEntry());
    await store.delete('key1');
    expect(await l1Spy.store.get('key1')).toBeNull();
    expect(await l2Spy.store.get('key1')).toBeNull();
    expect(l1Spy.calls.delete).toBe(1);
    expect(l2Spy.calls.delete).toBe(1);
  });

  it('deleteByRecipe removes matching entries from both tiers', async () => {
    await store.set(makeEntry({ key: 'a', recipe_id: 'r1' }));
    await store.set(makeEntry({ key: 'b', recipe_id: 'r1' }));
    await store.set(makeEntry({ key: 'c', recipe_id: 'r2' }));
    await store.deleteByRecipe('r1');
    expect(await l1Spy.store.get('a')).toBeNull();
    expect(await l1Spy.store.get('b')).toBeNull();
    expect(await l1Spy.store.get('c')).not.toBeNull();
    expect(await l2Spy.store.get('a')).toBeNull();
    expect(await l2Spy.store.get('b')).toBeNull();
    expect(await l2Spy.store.get('c')).not.toBeNull();
  });

  it('clear empties both tiers', async () => {
    await store.set(makeEntry({ key: 'a' }));
    await store.set(makeEntry({ key: 'b' }));
    await store.clear();
    expect(await l1Spy.store.get('a')).toBeNull();
    expect(await l2Spy.store.get('a')).toBeNull();
    expect(l1Spy.calls.clear).toBe(1);
    expect(l2Spy.calls.clear).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────

describe('tieredStore — size and eviction', () => {
  let l1Spy: ReturnType<typeof spyStore>;
  let l2Spy: ReturnType<typeof spyStore>;
  let store: CacheStore;

  beforeEach(() => {
    l1Spy = spyStore(createInMemoryStore());
    l2Spy = spyStore(createInMemoryStore());
    store = tieredStore(l1Spy.store, l2Spy.store);
  });

  it('size() returns L2 size (source of truth, not L1)', async () => {
    // Populate L1 with MORE entries than L2 (simulating a stale L1)
    await l1Spy.store.set(makeEntry({ key: 'a', size_bytes: 100 }));
    await l1Spy.store.set(makeEntry({ key: 'b', size_bytes: 100 }));
    await l2Spy.store.set(makeEntry({ key: 'a', size_bytes: 100 }));

    // Only L2 counts — returns 100, not 200
    expect(await store.size()).toBe(100);
    expect(l2Spy.calls.size).toBe(1);
    expect(l1Spy.calls.size).toBe(0);
  });

  it('evictLRU operates on L2 only', async () => {
    await store.set(makeEntry({ key: 'a', size_bytes: 100, last_accessed_at: 1 }));
    await store.set(makeEntry({ key: 'b', size_bytes: 100, last_accessed_at: 2 }));

    await store.evictLRU(50); // evict everything
    expect(await l2Spy.store.size()).toBeLessThanOrEqual(50);
    expect(l2Spy.calls.evictLRU).toBe(1);
    expect(l1Spy.calls.evictLRU).toBe(0); // L1 is NOT directly evicted
  });

  it('post-eviction L1 staleness is bounded by expiry check (store layer has no expiry logic)', async () => {
    // Simulate: entry exists in both tiers; evictLRU drops L2. L1 still
    // has it. The cache *wrapper* checks expires_at, but the raw store
    // does not — so the entry appears in L1 reads until explicitly
    // deleted or cleared. This test documents that behavior.
    await store.set(makeEntry({ key: 'a', size_bytes: 1000, last_accessed_at: 1 }));
    await store.evictLRU(0);

    // L2 drained but L1 still has it
    expect(await l2Spy.store.get('a')).toBeNull();
    const fromL1 = await l1Spy.store.get('a');
    expect(fromL1).not.toBeNull(); // this is the documented staleness
  });
});

// ────────────────────────────────────────────────────────────────

describe('tieredStore — realistic in-memory + IDB pairing', () => {
  it('uses in-memory as L1 and IDB as L2 end-to-end', async () => {
    const l1 = createInMemoryStore();
    const l2 = createIDBStore({ dbName: uniqueDb() });
    const store = tieredStore(l1, l2);

    await store.set(makeEntry({ key: 'deal', value: { name: 'Acme' } }));

    // Verify both tiers have the entry
    const fromL1 = await l1.get('deal');
    const fromL2 = await l2.get('deal');
    expect(fromL1).not.toBeNull();
    expect(fromL2).not.toBeNull();
    expect((fromL1 as { value: { name: string } }).value.name).toBe('Acme');
    expect((fromL2 as { value: { name: string } }).value.name).toBe('Acme');

    // Clear only L1 (simulating sw restart); L2 should still have it
    await l1.clear();
    expect(await l1.get('deal')).toBeNull();

    // Now read via the tiered store — L1 miss, L2 hit, hydration
    const rehydrated = await store.get('deal');
    expect((rehydrated as { value: { name: string } }).value.name).toBe('Acme');

    // And L1 should now have it again
    expect(await l1.get('deal')).not.toBeNull();
  });
});
