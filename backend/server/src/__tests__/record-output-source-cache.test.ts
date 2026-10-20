import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createInMemoryStore } from '@recued/cache';
import type { CacheEntry } from '@recued/contracts';
import { createBlobStore } from '../storage/blob-store.js';
import { createSQLiteCacheStore } from '../storage/sqlite-cache-store.js';
import { recordOutputSourceCache } from '../record-output-source-cache.js';
import { handleCacheGet, handleCachePut, handleCacheSince } from '../cache-rpc-handler.js';

let directory: string;
let db: Database.Database;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'recued-record-cache-proof-')); db = new Database(join(directory, 'cache.db')); });
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
const entry = (): CacheEntry => ({ key: 'fixture', value: { id: '42' }, ingredient_slug: 'publisher/crm', recipe_id: 'r',
  created_at: Date.now(), last_accessed_at: Date.now(), expires_at: Date.now() + 60_000, size_bytes: 11,
  category: 'data', risk_tier: 'read' });

describe('private cached record source receipts', () => {
  it('survives reopening SQLite and never appears in cache RPC data', async () => {
    const blobs = createBlobStore(join(directory, 'blobs'));
    let cache = createSQLiteCacheStore(db, blobs);
    const value = entry();
    await cache.set(value);
    recordOutputSourceCache(cache, db).set(value, { host_proof: 'private' });
    const deps = { db, blobs, store: cache };
    expect(await handleCacheGet(deps, { key: value.key })).toEqual({ entry: value });
    const page = await handleCacheSince(deps, { cursor: 0 });
    expect(page.entries).toEqual([value]);
    db.close(); db = new Database(join(directory, 'cache.db'));
    cache = createSQLiteCacheStore(db, blobs);
    const read = (await cache.get(value.key))!;
    expect(recordOutputSourceCache(cache, db).get(read)).toEqual({ host_proof: 'private' });
  });

  it('binds receipts to key, payload, catalog, timestamp and expiry', () => {
    const proof = recordOutputSourceCache(createInMemoryStore());
    const value = entry();
    const metadata = { host_proof: { source: 'original' } };
    proof.set(value, metadata);
    metadata.host_proof.source = 'changed';
    expect(proof.get(value)).toEqual({ host_proof: { source: 'original' } });
    for (const changed of [{ ...value, key: 'another' }, { ...value, value: { id: '99' } },
      { ...value, ingredient_slug: 'publisher/other' }, { ...value, created_at: value.created_at + 1 },
      { ...value, expires_at: value.expires_at + 1 }]) expect(proof.get(changed)).toBeUndefined();
    const returned = proof.get(value) as { host_proof: { source: string } };
    returned.host_proof.source = 'mutated';
    expect(proof.get(value)).toEqual({ host_proof: { source: 'original' } });
  });

  it('refuses forged peer payloads and ignores peer-supplied metadata', async () => {
    const blobs = createBlobStore(join(directory, 'blobs'));
    const cache = createSQLiteCacheStore(db, blobs);
    const proof = recordOutputSourceCache(cache, db);
    const value = entry();
    await cache.set(value); proof.set(value, { host_proof: 'real' });
    await handleCachePut({ db, blobs, store: cache }, { entries: [{ ...value, value: { id: 'forged' },
      record_source: { host_proof: 'real' }, evidence_json: '{"host_proof":"real"}' }] });
    expect(proof.get((await cache.get(value.key))!)).toBeUndefined();
  });

  it.each(['delete', 'recipe', 'prefix', 'evict', 'clear'] as const)(
    'removes private receipts when the cached value is removed by %s', async removal => {
      const cache = createSQLiteCacheStore(db, createBlobStore(join(directory, 'blobs')));
      const proof = recordOutputSourceCache(cache, db);
      const value = entry();
      await cache.set(value); proof.set(value, { host_proof: 'remove' });
      const other = { ...value, key: 'other', recipe_id: 'another' };
      await cache.set(other); proof.set(other, { host_proof: 'keep' });
      if (removal === 'delete') await cache.delete(value.key);
      if (removal === 'recipe') await cache.deleteByRecipe(value.recipe_id);
      if (removal === 'prefix') await cache.deleteByPrefix!('fixture');
      if (removal === 'evict') await cache.evictLRU(0);
      if (removal === 'clear') await cache.clear();
      expect(await cache.get(value.key)).toBeNull();
      expect(proof.get(value)).toBeUndefined();
      const remaining = db.prepare('SELECT count(*) AS total FROM record_output_cache_sources').get() as { total: number };
      expect(remaining.total).toBe(['evict', 'clear'].includes(removal) ? 0 : 1);
    });

  it('does not recreate a receipt if the cache entry was evicted before receipt capture', async () => {
    const cache = createSQLiteCacheStore(db, createBlobStore(join(directory, 'blobs')));
    const proof = recordOutputSourceCache(cache, db);
    const value = entry();
    await cache.set(value); await cache.delete(value.key);
    proof.set(value, { host_proof: 'late' });
    expect(proof.get(value)).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS total FROM record_output_cache_sources').get()).toEqual({ total: 0 });
  });

  it('prunes receipts orphaned before deletion tracking was installed', async () => {
    const blobs = createBlobStore(join(directory, 'blobs'));
    const cache = createSQLiteCacheStore(db, blobs);
    const value = entry();
    await cache.set(value); recordOutputSourceCache(cache, db).set(value, { host_proof: 'legacy' });
    db.exec('DROP TRIGGER record_output_cache_sources_delete; DELETE FROM cache_entries');
    const reopened = createSQLiteCacheStore(db, blobs);
    expect(recordOutputSourceCache(reopened, db).get(value)).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS total FROM record_output_cache_sources').get()).toEqual({ total: 0 });
  });

  it('does not attest expired entries, including explicit stale cache reuse', () => {
    const proof = recordOutputSourceCache(createInMemoryStore(), db);
    const value = { ...entry(), expires_at: Date.now() - 1 };
    proof.set(value, { host_proof: 'expired' });
    expect(proof.get(value)).toBeUndefined();
  });
});
