// Use the test-scoped fake-indexeddb so each test gets a fresh global
// IDB. The /auto module also patches `globalThis.indexedDB`, which is
// what the default factory reads.
import 'fake-indexeddb/auto';

import { describe, it, expect, beforeEach } from 'vitest';
import { createIDBStore, type IDBCacheStore } from '../idb.js';
import type { CacheEntry } from '../types.js';

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

// Each test uses a unique dbName so the fake-indexeddb state doesn't
// leak between tests.
let counter = 0;
const uniqueDb = () => `test-cache-${++counter}-${Date.now()}`;

// ────────────────────────────────────────────────────────────────

describe('createIDBStore — get/set', () => {
  let store: IDBCacheStore;

  beforeEach(() => {
    store = createIDBStore({ dbName: uniqueDb() });
  });

  it('returns null for missing key', async () => {
    expect(await store.get('missing')).toBeNull();
  });

  it('stores and retrieves entries', async () => {
    const entry = makeEntry();
    await store.set(entry);
    const fetched = await store.get('key1');
    expect(fetched).toEqual(entry);
  });

  it('overwrites existing entry on same key', async () => {
    await store.set(makeEntry({ value: 'old' }));
    await store.set(makeEntry({ value: 'new' }));
    expect((await store.get('key1'))?.value).toBe('new');
  });

  it('distinguishes entries by key', async () => {
    await store.set(makeEntry({ key: 'a', value: 1 }));
    await store.set(makeEntry({ key: 'b', value: 2 }));
    expect((await store.get('a'))?.value).toBe(1);
    expect((await store.get('b'))?.value).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBStore — delete', () => {
  let store: IDBCacheStore;
  beforeEach(() => { store = createIDBStore({ dbName: uniqueDb() }); });

  it('removes an entry by key', async () => {
    await store.set(makeEntry());
    await store.delete('key1');
    expect(await store.get('key1')).toBeNull();
  });

  it('is a no-op for missing keys', async () => {
    await store.delete('nonexistent');
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('clear removes all entries', async () => {
    await store.set(makeEntry({ key: 'a' }));
    await store.set(makeEntry({ key: 'b' }));
    await store.clear();
    expect(await store.get('a')).toBeNull();
    expect(await store.get('b')).toBeNull();
    expect(await store.size()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBStore — deleteByRecipe', () => {
  let store: IDBCacheStore;
  beforeEach(() => { store = createIDBStore({ dbName: uniqueDb() }); });

  it('removes only entries matching the recipe_id', async () => {
    await store.set(makeEntry({ key: 'a', recipe_id: 'r1' }));
    await store.set(makeEntry({ key: 'b', recipe_id: 'r1' }));
    await store.set(makeEntry({ key: 'c', recipe_id: 'r2' }));
    await store.deleteByRecipe('r1');
    expect(await store.get('a')).toBeNull();
    expect(await store.get('b')).toBeNull();
    expect(await store.get('c')).not.toBeNull();
  });

  it('is a no-op when no entries match', async () => {
    await store.set(makeEntry({ recipe_id: 'r1' }));
    await store.deleteByRecipe('nobody');
    expect(await store.get('key1')).not.toBeNull();
  });

  it('handles empty store', async () => {
    await store.deleteByRecipe('r1');
    // no throw = pass
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBStore — size', () => {
  let store: IDBCacheStore;
  beforeEach(() => { store = createIDBStore({ dbName: uniqueDb() }); });

  it('returns 0 for empty store', async () => {
    expect(await store.size()).toBe(0);
  });

  it('sums size_bytes across all entries', async () => {
    await store.set(makeEntry({ key: 'a', size_bytes: 100 }));
    await store.set(makeEntry({ key: 'b', size_bytes: 250 }));
    await store.set(makeEntry({ key: 'c', size_bytes: 75 }));
    expect(await store.size()).toBe(425);
  });

  it('updates after delete', async () => {
    await store.set(makeEntry({ key: 'a', size_bytes: 100 }));
    await store.set(makeEntry({ key: 'b', size_bytes: 200 }));
    await store.delete('a');
    expect(await store.size()).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBStore — evictLRU', () => {
  let store: IDBCacheStore;
  beforeEach(() => { store = createIDBStore({ dbName: uniqueDb() }); });

  it('does nothing when total size is under target', async () => {
    await store.set(makeEntry({ key: 'a', size_bytes: 100 }));
    await store.set(makeEntry({ key: 'b', size_bytes: 100 }));
    await store.evictLRU(500);
    expect(await store.size()).toBe(200);
  });

  it('evicts oldest entries first (by last_accessed_at)', async () => {
    // Three entries with distinct last_accessed_at timestamps
    await store.set(makeEntry({ key: 'oldest',  size_bytes: 100, last_accessed_at: 1000 }));
    await store.set(makeEntry({ key: 'middle',  size_bytes: 100, last_accessed_at: 2000 }));
    await store.set(makeEntry({ key: 'newest',  size_bytes: 100, last_accessed_at: 3000 }));
    // Total = 300; target = 200 → must evict 'oldest'
    await store.evictLRU(200);
    expect(await store.get('oldest')).toBeNull();
    expect(await store.get('middle')).not.toBeNull();
    expect(await store.get('newest')).not.toBeNull();
  });

  it('evicts multiple oldest entries to hit the target', async () => {
    await store.set(makeEntry({ key: 'a', size_bytes: 100, last_accessed_at: 1000 }));
    await store.set(makeEntry({ key: 'b', size_bytes: 100, last_accessed_at: 2000 }));
    await store.set(makeEntry({ key: 'c', size_bytes: 100, last_accessed_at: 3000 }));
    await store.set(makeEntry({ key: 'd', size_bytes: 100, last_accessed_at: 4000 }));
    // Total = 400; target = 150 → evict a, b, c (only d remains)
    await store.evictLRU(150);
    expect(await store.get('a')).toBeNull();
    expect(await store.get('b')).toBeNull();
    expect(await store.get('c')).toBeNull();
    expect(await store.get('d')).not.toBeNull();
  });

  it('handles target = 0 by evicting everything', async () => {
    await store.set(makeEntry({ key: 'a', size_bytes: 100 }));
    await store.set(makeEntry({ key: 'b', size_bytes: 100 }));
    await store.evictLRU(0);
    expect(await store.size()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBStore — persistence across store instances', () => {
  it('two stores with same dbName share state', async () => {
    const dbName = uniqueDb();
    const s1 = createIDBStore({ dbName });
    await s1.set(makeEntry({ key: 'persist', value: 'survives' }));
    await s1.close();

    const s2 = createIDBStore({ dbName });
    const fetched = await s2.get('persist');
    expect(fetched?.value).toBe('survives');
  });

  it('different dbNames have isolated state', async () => {
    const s1 = createIDBStore({ dbName: uniqueDb() });
    const s2 = createIDBStore({ dbName: uniqueDb() });
    await s1.set(makeEntry({ key: 'x', value: 'only-in-s1' }));
    expect(await s2.get('x')).toBeNull();
  });

  it('close() releases the connection and next op reopens', async () => {
    const dbName = uniqueDb();
    const store = createIDBStore({ dbName });
    await store.set(makeEntry({ key: 'a', value: 1 }));
    await store.close();
    // After close, next op should transparently reopen
    const fetched = await store.get('a');
    expect(fetched?.value).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBStore — interface parity with in-memory', () => {
  it('implements the full CacheStore interface', () => {
    const store = createIDBStore({ dbName: uniqueDb() });
    expect(typeof store.get).toBe('function');
    expect(typeof store.set).toBe('function');
    expect(typeof store.delete).toBe('function');
    expect(typeof store.deleteByRecipe).toBe('function');
    expect(typeof store.size).toBe('function');
    expect(typeof store.evictLRU).toBe('function');
    expect(typeof store.clear).toBe('function');
    // IDB-specific extension
    expect(typeof store.close).toBe('function');
  });

  it('handles concurrent operations', async () => {
    const store = createIDBStore({ dbName: uniqueDb() });
    // Fire 10 writes in parallel; all should succeed
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.set(makeEntry({ key: `k${i}`, size_bytes: 10 })),
      ),
    );
    expect(await store.size()).toBe(100);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBStore — factory behavior', () => {
  it('accepts a custom IDBFactory (dependency injection)', async () => {
    // Use the fake-indexeddb global passed explicitly. This proves
    // the factory parameter works for non-global IDB cases.
    const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
    const store = createIDBStore({ dbName: uniqueDb(), indexedDB: idb });
    await store.set(makeEntry());
    expect(await store.get('key1')).not.toBeNull();
  });

  it('throws when no IndexedDB implementation is available', () => {
    const g = globalThis as { indexedDB?: IDBFactory };
    const saved = g.indexedDB;
    // Null out globalThis.indexedDB so the factory's fallback resolves to undefined.
    g.indexedDB = undefined;
    try {
      expect(() => createIDBStore({})).toThrow(/no IndexedDB implementation/);
    } finally {
      g.indexedDB = saved;
    }
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBStore — deleteByPrefix', () => {
  let store: IDBCacheStore;
  beforeEach(() => { store = createIDBStore({ dbName: uniqueDb() }); });

  it('returns 0 on an empty store', async () => {
    expect(await store.deleteByPrefix('anything')).toBe(0);
  });

  it('deletes only keys that start with the prefix and reports the count', async () => {
    await store.set(makeEntry({ key: 'recipe-a:step-1' }));
    await store.set(makeEntry({ key: 'recipe-a:step-2' }));
    await store.set(makeEntry({ key: 'recipe-b:step-1' }));
    await store.set(makeEntry({ key: 'unrelated' }));

    const deleted = await store.deleteByPrefix('recipe-a:');
    expect(deleted).toBe(2);
    expect(await store.get('recipe-a:step-1')).toBeNull();
    expect(await store.get('recipe-a:step-2')).toBeNull();
    expect(await store.get('recipe-b:step-1')).not.toBeNull();
    expect(await store.get('unrelated')).not.toBeNull();
  });

  it('returns 0 when no key matches the prefix', async () => {
    await store.set(makeEntry({ key: 'real-key' }));
    expect(await store.deleteByPrefix('ghost-')).toBe(0);
    expect(await store.get('real-key')).not.toBeNull();
  });

  it('treats the prefix boundary as exclusive-of-successor', async () => {
    // "ab" matches; "abc" matches; but "aX..." (ascii > 'b'[0]) does not.
    await store.set(makeEntry({ key: 'ab' }));
    await store.set(makeEntry({ key: 'abc' }));
    await store.set(makeEntry({ key: 'ac' }));

    const deleted = await store.deleteByPrefix('ab');
    expect(deleted).toBe(2);
    expect(await store.get('ac')).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBStore — touch', () => {
  let store: IDBCacheStore;
  beforeEach(() => { store = createIDBStore({ dbName: uniqueDb() }); });

  it('updates last_accessed_at on an existing entry', async () => {
    await store.set(makeEntry({ key: 'k', last_accessed_at: 1000 }));
    await store.touch('k', { last_accessed_at: 5000 });
    const e = await store.get('k');
    expect(e?.last_accessed_at).toBe(5000);
  });

  it('updates expires_at when provided', async () => {
    await store.set(makeEntry({ key: 'k', expires_at: 1000 }));
    await store.touch('k', { last_accessed_at: 2000, expires_at: 9999 });
    const e = await store.get('k');
    expect(e?.expires_at).toBe(9999);
    expect(e?.last_accessed_at).toBe(2000);
  });

  it('leaves expires_at unchanged when omitted', async () => {
    await store.set(makeEntry({ key: 'k', expires_at: 1000 }));
    await store.touch('k', { last_accessed_at: 2000 });
    const e = await store.get('k');
    expect(e?.expires_at).toBe(1000);
  });

  it('is a no-op when the key does not exist', async () => {
    await store.touch('ghost', { last_accessed_at: 5000 });
    expect(await store.get('ghost')).toBeNull();
  });
});
