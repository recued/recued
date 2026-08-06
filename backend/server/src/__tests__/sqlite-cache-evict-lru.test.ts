/** `evictLRU` on the SQLite cache store — which rows go, and in what order.
 *
 *  ⛔ WHY THIS FILE EXISTS. Nothing asserted the L in LRU. `cache-gate.test.ts`
 *  has two `evictLRU` tests and both check only the freed BYTE TOTAL — and they
 *  run `createInMemoryStore`, a different implementation. The SQLite
 *  `evictLRU`, the one the server actually runs, had no direct test at all.
 *
 *  That mattered the moment it changed shape: it used to `.all()` the entire
 *  table and break out of the loop; it now `.iterate()`s and stops early, and
 *  collects keys before deleting rather than deleting mid-cursor. Every one of
 *  those is a way to evict the WRONG rows while still freeing the right number
 *  of bytes — which is exactly what the existing assertions measure. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CacheEntry } from '@recued/cache';

import { createBlobStore } from '../storage/blob-store.js';
import { createSQLiteCacheStore } from '../storage/sqlite-cache-store.js';

const mkEntry = (o: Partial<CacheEntry> & { key: string }): CacheEntry => ({
  value: { v: 1 },
  expires_at: 4_000_000_000_000,
  recipe_id: 'r',
  ingredient_slug: 'i',
  size_bytes: 100,
  created_at: 1,
  last_accessed_at: 1,
  ...o,
} as CacheEntry);

describe('SQLite evictLRU', () => {
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createSQLiteCacheStore>;
  let deltas: number[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hz-lru-'));
    db = new Database(join(dir, 'c.db'));
    deltas = [];
    store = createSQLiteCacheStore(db, createBlobStore(join(dir, 'blobs')), {
      onBytesChanged: (d) => deltas.push(d),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = async (): Promise<void> => {
    // Deliberately inserted NEWEST-FIRST, so an implementation that evicts in
    // insertion order rather than by `last_accessed_at` produces a different
    // answer and fails.
    for (const [key, at] of [['e', 5], ['d', 4], ['c', 3], ['b', 2], ['a', 1]] as const) {
      await store.set(mkEntry({ key, size_bytes: 100, last_accessed_at: at }));
    }
  };

  it('⛔ evicts the LEAST recently accessed rows first', async () => {
    await seed();
    // 500 bytes present, target 300 ⇒ free 200 ⇒ exactly the two oldest.
    await store.evictLRU(300);
    const remaining = (db
      .prepare('SELECT key FROM cache_entries ORDER BY key')
      .all() as Array<{ key: string }>).map((r) => r.key);
    expect(remaining).toEqual(['c', 'd', 'e']);
  });

  it('⛔ STOPS once it has freed enough — it does not drain the cache', async () => {
    await seed();
    await store.evictLRU(400); // free 100 ⇒ one row
    expect(await store.size()).toBe(400);
    const remaining = (db
      .prepare('SELECT key FROM cache_entries ORDER BY key')
      .all() as Array<{ key: string }>).map((r) => r.key);
    expect(remaining).toEqual(['b', 'c', 'd', 'e']);
  });

  it('does nothing when already under target', async () => {
    await seed();
    deltas.length = 0;
    await store.evictLRU(500);
    expect(deltas).toEqual([]);
    expect(await store.size()).toBe(500);
  });

  it('reports exactly the bytes it removed', async () => {
    await seed();
    deltas.length = 0;
    await store.evictLRU(250);
    const freed = -deltas.reduce((s, d) => s + d, 0);
    // Byte accounting must agree with the rows actually gone, or the storage
    // gate believes in space that is not there.
    expect(await store.size()).toBe(500 - freed);
    expect(freed).toBeGreaterThanOrEqual(250);
  });

  it('evicts everything when the target is zero', async () => {
    await seed();
    await store.evictLRU(0);
    expect(await store.size()).toBe(0);
  });

  it('⛔ the TTL sweep SEARCHes on expires_at rather than scanning', async () => {
    // The predicate the cadence sweep filters on. Without an index it planned
    // as a full SCAN, which costs the whole cache on every run — worst exactly
    // when the cache is HEALTHY and there is nothing to evict, because then it
    // reads every row to find none. A correct answer read the slow way is
    // still the bug, so this asserts the PLAN, not the result.
    await seed();
    const plan = (db
      .prepare(`EXPLAIN QUERY PLAN DELETE FROM cache_entries
                WHERE rowid IN (SELECT rowid FROM cache_entries
                                 WHERE expires_at < ? LIMIT ?)`)
      .all(1, 1) as Array<{ detail: string }>).map((r) => r.detail).join(' ; ');
    expect(plan).toMatch(/USING (COVERING )?INDEX cache_expires_at/);
    expect(plan).not.toMatch(/SCAN cache_entries(?! USING)/);
  });

  it('honours last_accessed_at updated by touch(), not insertion order', async () => {
    await seed();
    // 'a' is the oldest; touching it makes it the NEWEST, so 'b' and 'c'
    // should go instead. An implementation reading a stale ordering, or one
    // iterating a mutating cursor, gets this wrong.
    // `touch` is OPTIONAL on the CacheStore interface. Asserted rather than
    // `!`-ed: if the SQLite store ever stopped implementing it, this test
    // would silently stop testing what its name says.
    expect(store.touch).toBeTypeOf('function');
    await store.touch?.('a', { last_accessed_at: 99 });
    await store.evictLRU(300);
    const remaining = (db
      .prepare('SELECT key FROM cache_entries ORDER BY key')
      .all() as Array<{ key: string }>).map((r) => r.key);
    expect(remaining).toEqual(['a', 'd', 'e']);
  });
});
