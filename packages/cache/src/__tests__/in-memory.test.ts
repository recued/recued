import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryStore } from '../in-memory.js';
import type { CacheEntry, CacheStore } from '../types.js';

let store: CacheStore;

const makeEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => ({
  key: 'key1',
  value: { foo: 'bar' },
  expires_at: Date.now() + 60000,
  recipe_id: 'recipe-a',
  ingredient_slug: 'slug-x',
  size_bytes: 100,
  created_at: Date.now(),
  last_accessed_at: Date.now(),
  ...overrides,
});

beforeEach(() => {
  store = createInMemoryStore();
});

describe('createInMemoryStore', () => {
  describe('get/set', () => {
    it('returns null for missing key', async () => {
      expect(await store.get('missing')).toBeNull();
    });

    it('stores and retrieves entries', async () => {
      const entry = makeEntry();
      await store.set(entry);
      expect(await store.get('key1')).toEqual(entry);
    });

    it('overwrites existing entry on same key', async () => {
      await store.set(makeEntry({ value: 'old' }));
      await store.set(makeEntry({ value: 'new' }));
      const got = await store.get('key1');
      expect(got?.value).toBe('new');
    });
  });

  describe('delete', () => {
    it('removes entry', async () => {
      await store.set(makeEntry());
      await store.delete('key1');
      expect(await store.get('key1')).toBeNull();
    });

    it('no-op for missing key', async () => {
      await store.delete('missing');
      expect(await store.get('missing')).toBeNull();
    });
  });

  describe('deleteByRecipe', () => {
    it('removes all entries for a recipe', async () => {
      await store.set(makeEntry({ key: 'a', recipe_id: 'recipe-1' }));
      await store.set(makeEntry({ key: 'b', recipe_id: 'recipe-1' }));
      await store.set(makeEntry({ key: 'c', recipe_id: 'recipe-2' }));

      await store.deleteByRecipe('recipe-1');

      expect(await store.get('a')).toBeNull();
      expect(await store.get('b')).toBeNull();
      expect(await store.get('c')).not.toBeNull();
    });
  });

  describe('deleteByPrefix', () => {
    it('removes entries whose key starts with the prefix and returns the count', async () => {
      await store.set(makeEntry({ key: 'v1:inst-a:email-reader@abc' }));
      await store.set(makeEntry({ key: 'v1:inst-a:email-reader@def' }));
      await store.set(makeEntry({ key: 'v1:inst-a:deal-reader@xyz' }));

      const n = await store.deleteByPrefix!('v1:inst-a:email-reader@');

      expect(n).toBe(2);
      expect(await store.get('v1:inst-a:email-reader@abc')).toBeNull();
      expect(await store.get('v1:inst-a:email-reader@def')).toBeNull();
      expect(await store.get('v1:inst-a:deal-reader@xyz')).not.toBeNull();
    });

    it('returns 0 when no entries match', async () => {
      await store.set(makeEntry({ key: 'v1:inst-a:deal-reader@xyz' }));
      const n = await store.deleteByPrefix!('v1:inst-b:');
      expect(n).toBe(0);
    });
  });

  describe('size', () => {
    it('returns 0 for empty', async () => {
      expect(await store.size()).toBe(0);
    });

    it('sums entry sizes', async () => {
      await store.set(makeEntry({ key: 'a', size_bytes: 100 }));
      await store.set(makeEntry({ key: 'b', size_bytes: 250 }));
      expect(await store.size()).toBe(350);
    });
  });

  describe('evictLRU', () => {
    it('no-op when under target', async () => {
      await store.set(makeEntry({ key: 'a', size_bytes: 100 }));
      await store.evictLRU(1000);
      expect(await store.get('a')).not.toBeNull();
    });

    it('evicts oldest first until under target', async () => {
      const t = Date.now();
      await store.set(makeEntry({ key: 'old',    size_bytes: 100, last_accessed_at: t - 3000 }));
      await store.set(makeEntry({ key: 'mid',    size_bytes: 100, last_accessed_at: t - 2000 }));
      await store.set(makeEntry({ key: 'recent', size_bytes: 100, last_accessed_at: t - 1000 }));

      await store.evictLRU(150); // can hold ~1.5 entries → evict 2 oldest

      expect(await store.get('old')).toBeNull();
      expect(await store.get('mid')).toBeNull();
      expect(await store.get('recent')).not.toBeNull();
    });

    it('keeps most-recently-accessed entries', async () => {
      const t = Date.now();
      await store.set(makeEntry({ key: 'a', size_bytes: 100, last_accessed_at: t - 100 }));
      await store.set(makeEntry({ key: 'b', size_bytes: 100, last_accessed_at: t - 50 }));
      await store.set(makeEntry({ key: 'c', size_bytes: 100, last_accessed_at: t }));

      await store.evictLRU(100); // can hold 1 entry

      expect(await store.get('a')).toBeNull();
      expect(await store.get('b')).toBeNull();
      expect(await store.get('c')).not.toBeNull();
    });
  });

  describe('clear', () => {
    it('removes all entries', async () => {
      await store.set(makeEntry({ key: 'a' }));
      await store.set(makeEntry({ key: 'b' }));
      await store.clear();
      expect(await store.size()).toBe(0);
      expect(await store.get('a')).toBeNull();
    });
  });

  describe('touch', () => {
    it('bumps last_accessed_at without mutating value or other fields', async () => {
      const entry = makeEntry({ key: 'a', last_accessed_at: 1_000, value: { v: 1 } });
      await store.set(entry);
      await store.touch!('a', { last_accessed_at: 2_000 });
      const after = await store.get('a');
      expect(after?.last_accessed_at).toBe(2_000);
      expect(after?.value).toEqual({ v: 1 });
      expect(after?.created_at).toBe(entry.created_at);
    });

    it('optionally refreshes expires_at (sliding TTL)', async () => {
      const entry = makeEntry({ key: 'a', expires_at: 1_000 });
      await store.set(entry);
      await store.touch!('a', { last_accessed_at: 2_000, expires_at: 5_000 });
      const after = await store.get('a');
      expect(after?.expires_at).toBe(5_000);
    });

    it('is a no-op for missing keys', async () => {
      // No throw, no write.
      await store.touch!('nope', { last_accessed_at: 2_000 });
      expect(await store.get('nope')).toBeNull();
    });
  });
});
