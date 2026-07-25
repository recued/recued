import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { createIDBCollection, type IDBCollection } from '../idb-collection.js';

interface TestValue {
  id: string;
  label: string;
  count: number;
}

let counter = 0;
const uniqueDb = () => `idb-collection-test-${++counter}-${Date.now()}`;

// ────────────────────────────────────────────────────────────────

describe('createIDBCollection — get/set/has/delete', () => {
  let store: IDBCollection<TestValue>;
  beforeEach(() => { store = createIDBCollection<TestValue>({ dbName: uniqueDb() }); });

  it('get returns null for missing key', async () => {
    expect(await store.get('missing')).toBeNull();
  });

  it('set → get roundtrip', async () => {
    const value: TestValue = { id: 'a', label: 'Alpha', count: 1 };
    await store.set('key-a', value);
    expect(await store.get('key-a')).toEqual(value);
  });

  it('set overwrites existing key', async () => {
    await store.set('k', { id: 'a', label: 'Old', count: 0 });
    await store.set('k', { id: 'a', label: 'New', count: 1 });
    const fetched = await store.get('k');
    expect(fetched?.label).toBe('New');
  });

  it('has returns true for existing keys', async () => {
    await store.set('k', { id: 'a', label: 'x', count: 0 });
    expect(await store.has('k')).toBe(true);
    expect(await store.has('nothing')).toBe(false);
  });

  it('delete removes an entry', async () => {
    await store.set('k', { id: 'a', label: 'x', count: 0 });
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
    expect(await store.has('k')).toBe(false);
  });

  it('delete is a no-op for missing key', async () => {
    await store.delete('missing');
    // no throw = pass
  });

  it('stores complex nested values', async () => {
    interface Complex {
      nested: { deep: { value: number[] }; flag: boolean };
      meta: Record<string, string>;
    }
    const complex: IDBCollection<Complex> = createIDBCollection<Complex>({ dbName: uniqueDb() });
    const value: Complex = {
      nested: { deep: { value: [1, 2, 3] }, flag: true },
      meta: { a: 'x', b: 'y' },
    };
    await complex.set('c', value);
    expect(await complex.get('c')).toEqual(value);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBCollection — list operations', () => {
  let store: IDBCollection<TestValue>;
  beforeEach(() => { store = createIDBCollection<TestValue>({ dbName: uniqueDb() }); });

  it('list returns all values', async () => {
    await store.set('a', { id: 'a', label: 'A', count: 1 });
    await store.set('b', { id: 'b', label: 'B', count: 2 });
    await store.set('c', { id: 'c', label: 'C', count: 3 });
    const all = await store.list();
    expect(all).toHaveLength(3);
    expect(all.map((v) => v.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('list returns empty array when store is empty', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('listKeys returns all keys', async () => {
    await store.set('a', { id: 'a', label: 'A', count: 1 });
    await store.set('b', { id: 'b', label: 'B', count: 2 });
    const keys = await store.listKeys();
    expect(keys.sort()).toEqual(['a', 'b']);
  });

  it('size reflects entry count', async () => {
    expect(await store.size()).toBe(0);
    await store.set('a', { id: 'a', label: 'A', count: 1 });
    await store.set('b', { id: 'b', label: 'B', count: 2 });
    expect(await store.size()).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBCollection — prefix operations', () => {
  let store: IDBCollection<TestValue>;
  beforeEach(() => { store = createIDBCollection<TestValue>({ dbName: uniqueDb() }); });

  it('listByPrefix returns only matching entries', async () => {
    await store.set('user:alice', { id: 'alice', label: 'Alice', count: 1 });
    await store.set('user:bob', { id: 'bob', label: 'Bob', count: 2 });
    await store.set('admin:root', { id: 'root', label: 'Root', count: 99 });
    const users = await store.listByPrefix('user:');
    expect(users).toHaveLength(2);
    expect(users.map((e) => e.key).sort()).toEqual(['user:alice', 'user:bob']);
  });

  it('listByPrefix returns empty when no matches', async () => {
    await store.set('user:alice', { id: 'alice', label: 'Alice', count: 1 });
    expect(await store.listByPrefix('admin:')).toEqual([]);
  });

  it('deleteByPrefix removes only matching entries', async () => {
    await store.set('user:alice', { id: 'alice', label: 'Alice', count: 1 });
    await store.set('user:bob', { id: 'bob', label: 'Bob', count: 2 });
    await store.set('admin:root', { id: 'root', label: 'Root', count: 99 });
    const deleted = await store.deleteByPrefix('user:');
    expect(deleted).toBe(2);
    expect(await store.size()).toBe(1);
    expect(await store.has('admin:root')).toBe(true);
  });

  it('deleteByPrefix returns 0 on no match', async () => {
    await store.set('a', { id: 'a', label: 'A', count: 1 });
    expect(await store.deleteByPrefix('x')).toBe(0);
    expect(await store.size()).toBe(1);
  });

  it('listByPrefix handles empty prefix (returns everything)', async () => {
    await store.set('a', { id: 'a', label: 'A', count: 1 });
    await store.set('b', { id: 'b', label: 'B', count: 2 });
    const all = await store.listByPrefix('');
    expect(all).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBCollection — clear and persistence', () => {
  it('clear wipes all entries', async () => {
    const store = createIDBCollection<TestValue>({ dbName: uniqueDb() });
    await store.set('a', { id: 'a', label: 'A', count: 1 });
    await store.set('b', { id: 'b', label: 'B', count: 2 });
    await store.clear();
    expect(await store.size()).toBe(0);
    expect(await store.get('a')).toBeNull();
  });

  it('two collections with same dbName share state', async () => {
    const dbName = uniqueDb();
    const s1 = createIDBCollection<TestValue>({ dbName });
    await s1.set('shared', { id: 's', label: 'Shared', count: 42 });
    await s1.close();

    const s2 = createIDBCollection<TestValue>({ dbName });
    const fetched = await s2.get('shared');
    expect(fetched?.label).toBe('Shared');
  });

  it('different dbNames are isolated', async () => {
    const s1 = createIDBCollection<TestValue>({ dbName: uniqueDb() });
    const s2 = createIDBCollection<TestValue>({ dbName: uniqueDb() });
    await s1.set('x', { id: 'x', label: 'only-in-s1', count: 1 });
    expect(await s2.get('x')).toBeNull();
  });

  it('close releases the connection and next op reopens', async () => {
    const dbName = uniqueDb();
    const store = createIDBCollection<TestValue>({ dbName });
    await store.set('a', { id: 'a', label: 'A', count: 1 });
    await store.close();
    // Next op transparently reopens
    expect((await store.get('a'))?.label).toBe('A');
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBCollection — factory behavior', () => {
  it('throws when no IndexedDB implementation is available', () => {
    const g = globalThis as { indexedDB?: IDBFactory };
    const saved = g.indexedDB;
    g.indexedDB = undefined;
    try {
      expect(() => createIDBCollection<TestValue>({})).toThrow(/no IndexedDB implementation/);
    } finally {
      g.indexedDB = saved;
    }
  });

  it('accepts a custom IDBFactory via options.indexedDB', async () => {
    const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
    const store = createIDBCollection<TestValue>({ dbName: uniqueDb(), indexedDB: idb });
    await store.set('k', { id: 'a', label: 'A', count: 1 });
    expect((await store.get('k'))?.label).toBe('A');
  });
});

// ────────────────────────────────────────────────────────────────

describe('createIDBCollection — prefix edge cases', () => {
  let store: IDBCollection<TestValue>;
  beforeEach(() => { store = createIDBCollection<TestValue>({ dbName: uniqueDb() }); });

  it('listByPrefix honors the lexicographic upper bound (prefix+\\uffff)', async () => {
    // Keys that share the prefix are matched; keys that sort above the
    // upper-bound sentinel are not.
    await store.set('user:a', { id: 'a', label: 'A', count: 1 });
    await store.set('user:z', { id: 'z', label: 'Z', count: 26 });
    // A key whose prefix starts one byte above 'user:' should NOT be matched.
    await store.set('usfr:x', { id: 'x', label: 'X', count: 0 });
    const users = await store.listByPrefix('user:');
    expect(users.map(e => e.key).sort()).toEqual(['user:a', 'user:z']);
  });

  it('deleteByPrefix is idempotent — second call returns 0', async () => {
    await store.set('user:a', { id: 'a', label: 'A', count: 1 });
    await store.set('user:b', { id: 'b', label: 'B', count: 2 });
    expect(await store.deleteByPrefix('user:')).toBe(2);
    expect(await store.deleteByPrefix('user:')).toBe(0);
  });
});

describe('createIDBCollection — integration with createAuditLogStore', () => {
  it('serves as the backing for an audit log store', async () => {
    const { createAuditLogStore, buildAuditEntry } = await import('../index.js');
    type AuditEntryT = import('../audit.js').AuditEntry;

    const collection = createIDBCollection<AuditEntryT>({ dbName: uniqueDb() });
    const log = createAuditLogStore(collection);

    const entry = buildAuditEntry({
      recipe_id: 'test',
      recipe_hash: 'abcd1234',
      commit_status: 'succeeded',
      duration_ms: 100,
      errors: [],
    });
    await log.append(entry);

    const recent = await log.listRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].recipe_id).toBe('test');
  });
});
