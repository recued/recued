import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryCollection } from '../in-memory.js';
import type { Collection } from '../types.js';

interface TestValue {
  name: string;
  count: number;
}

let store: Collection<TestValue>;

beforeEach(() => {
  store = createInMemoryCollection<TestValue>();
});

describe('createInMemoryCollection', () => {
  describe('get/set', () => {
    it('returns null for missing key', async () => {
      expect(await store.get('missing')).toBeNull();
    });

    it('stores and retrieves values', async () => {
      await store.set('a', { name: 'alice', count: 1 });
      expect(await store.get('a')).toEqual({ name: 'alice', count: 1 });
    });

    it('overwrites existing entries', async () => {
      await store.set('a', { name: 'alice', count: 1 });
      await store.set('a', { name: 'alice', count: 2 });
      expect((await store.get('a'))?.count).toBe(2);
    });
  });

  describe('has', () => {
    it('true for existing', async () => {
      await store.set('a', { name: 'alice', count: 1 });
      expect(await store.has('a')).toBe(true);
    });
    it('false for missing', async () => {
      expect(await store.has('missing')).toBe(false);
    });
  });

  describe('delete', () => {
    it('removes entry', async () => {
      await store.set('a', { name: 'alice', count: 1 });
      await store.delete('a');
      expect(await store.has('a')).toBe(false);
    });

    it('no-op for missing key', async () => {
      await expect(store.delete('missing')).resolves.toBeUndefined();
    });
  });

  describe('list/listKeys', () => {
    it('lists all values', async () => {
      await store.set('a', { name: 'alice', count: 1 });
      await store.set('b', { name: 'bob', count: 2 });
      const list = await store.list();
      expect(list).toHaveLength(2);
      expect(list.map(v => v.name).sort()).toEqual(['alice', 'bob']);
    });

    it('lists all keys', async () => {
      await store.set('a', { name: 'alice', count: 1 });
      await store.set('b', { name: 'bob', count: 2 });
      expect((await store.listKeys()).sort()).toEqual(['a', 'b']);
    });
  });

  describe('listByPrefix', () => {
    it('returns matching entries', async () => {
      await store.set('user:alice', { name: 'alice', count: 1 });
      await store.set('user:bob', { name: 'bob', count: 2 });
      await store.set('admin:carol', { name: 'carol', count: 3 });

      const results = await store.listByPrefix('user:');
      expect(results).toHaveLength(2);
      expect(results.every(r => r.key.startsWith('user:'))).toBe(true);
    });

    it('empty result for no matches', async () => {
      await store.set('a', { name: 'alice', count: 1 });
      expect(await store.listByPrefix('nope:')).toEqual([]);
    });
  });

  describe('deleteByPrefix', () => {
    it('removes matching entries and returns count', async () => {
      await store.set('user:alice', { name: 'alice', count: 1 });
      await store.set('user:bob', { name: 'bob', count: 2 });
      await store.set('admin:carol', { name: 'carol', count: 3 });

      const count = await store.deleteByPrefix('user:');
      expect(count).toBe(2);
      expect(await store.size()).toBe(1);
      expect(await store.has('admin:carol')).toBe(true);
    });

    it('returns 0 when nothing matches', async () => {
      await store.set('a', { name: 'alice', count: 1 });
      expect(await store.deleteByPrefix('nope:')).toBe(0);
    });
  });

  describe('size and clear', () => {
    it('size starts at 0', async () => {
      expect(await store.size()).toBe(0);
    });

    it('size grows with entries', async () => {
      await store.set('a', { name: 'alice', count: 1 });
      await store.set('b', { name: 'bob', count: 2 });
      expect(await store.size()).toBe(2);
    });

    it('clear removes everything', async () => {
      await store.set('a', { name: 'alice', count: 1 });
      await store.set('b', { name: 'bob', count: 2 });
      await store.clear();
      expect(await store.size()).toBe(0);
    });
  });
});
