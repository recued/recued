import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createBlobStore } from '../storage/blob-store.js';
import { createSQLiteCacheStore, listReferencedBlobHashes } from '../storage/index.js';
import type { CacheEntry } from '@recued/cache';

let workDir: string;
let dbPath: string;
let blobRoot: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'recued-storage-'));
  dbPath = join(workDir, 'test.db');
  blobRoot = join(workDir, 'blobs');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const mkEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => ({
  key: 'v1:test:ingredient@1:deadbeef',
  value: { foo: 'bar' },
  expires_at: Date.now() + 60_000,
  recipe_id: 'r-1',
  ingredient_slug: 'ingredient',
  size_bytes: 20,
  created_at: Date.now(),
  last_accessed_at: Date.now(),
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Blob store
// ────────────────────────────────────────────────────────────────

describe('blob store — basic operations', () => {
  it('put returns a 64-char hex hash', async () => {
    const store = createBlobStore(blobRoot);
    const hash = await store.put(Buffer.from('hello'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('put + get round-trip', async () => {
    const store = createBlobStore(blobRoot);
    const data = Buffer.from('some payload');
    const hash = await store.put(data);
    const got = await store.get(hash);
    expect(got?.equals(data)).toBe(true);
  });

  it('get missing returns null', async () => {
    const store = createBlobStore(blobRoot);
    expect(await store.get('0'.repeat(64))).toBeNull();
  });

  it('has reflects existence', async () => {
    const store = createBlobStore(blobRoot);
    const hash = await store.put(Buffer.from('x'));
    expect(await store.has(hash)).toBe(true);
    expect(await store.has('0'.repeat(64))).toBe(false);
  });

  it('delete removes the blob', async () => {
    const store = createBlobStore(blobRoot);
    const hash = await store.put(Buffer.from('y'));
    await store.delete(hash);
    expect(await store.has(hash)).toBe(false);
  });

  it('delete missing blob is a no-op', async () => {
    const store = createBlobStore(blobRoot);
    await expect(store.delete('0'.repeat(64))).resolves.not.toThrow();
  });
});

describe('blob store — dedup', () => {
  it('same content → same hash → one file', async () => {
    const store = createBlobStore(blobRoot);
    const data = Buffer.from('dedup me');
    const h1 = await store.put(data);
    const h2 = await store.put(data);
    expect(h1).toBe(h2);
    // Only one file on disk despite two put calls
    expect(await store.totalBytes()).toBe(data.length);
  });

  it('different content → different hash', async () => {
    const store = createBlobStore(blobRoot);
    const h1 = await store.put(Buffer.from('a'));
    const h2 = await store.put(Buffer.from('b'));
    expect(h1).not.toBe(h2);
  });
});

describe('blob store — orphan sweep', () => {
  it('deletes blobs not in keepSet', async () => {
    const store = createBlobStore(blobRoot);
    const kept = await store.put(Buffer.from('keep'));
    const orphan = await store.put(Buffer.from('orphan'));
    expect(await store.has(orphan)).toBe(true);

    const deleted = await store.sweepOrphans(new Set([kept]));

    expect(deleted).toBe(1);
    expect(await store.has(kept)).toBe(true);
    expect(await store.has(orphan)).toBe(false);
  });

  it('empty keepSet deletes everything', async () => {
    const store = createBlobStore(blobRoot);
    await store.put(Buffer.from('a'));
    await store.put(Buffer.from('b'));
    const deleted = await store.sweepOrphans(new Set());
    expect(deleted).toBe(2);
    expect(await store.totalBytes()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// SQLite cache store
// ────────────────────────────────────────────────────────────────

describe('SQLite cache store — inline path', () => {
  it('stores and retrieves small values inline', async () => {
    const db = new Database(dbPath);
    const blobs = createBlobStore(blobRoot);
    const store = createSQLiteCacheStore(db, blobs);

    await store.set(mkEntry({ value: { small: 'payload' } }));
    const got = await store.get('v1:test:ingredient@1:deadbeef');

    expect(got?.value).toEqual({ small: 'payload' });
    // Nothing written to blob store
    expect(await blobs.totalBytes()).toBe(0);

    db.close();
  });
});

describe('SQLite cache store — blob path', () => {
  it('offloads large values to blob store via hash', async () => {
    const db = new Database(dbPath);
    const blobs = createBlobStore(blobRoot);
    // Use a small threshold so we don't have to build a 64KB fixture
    const store = createSQLiteCacheStore(db, blobs, { inlineThreshold: 10 });

    const bigValue = { text: 'this-is-longer-than-ten-bytes' };
    await store.set(mkEntry({ value: bigValue }));
    const got = await store.get('v1:test:ingredient@1:deadbeef');

    expect(got?.value).toEqual(bigValue);
    expect(await blobs.totalBytes()).toBeGreaterThan(0);

    db.close();
  });

  it('listReferencedBlobHashes surfaces blob refs for sweep', async () => {
    const db = new Database(dbPath);
    const blobs = createBlobStore(blobRoot);
    const store = createSQLiteCacheStore(db, blobs, { inlineThreshold: 5 });

    await store.set(mkEntry({ key: 'v1:a:x@1:h1', value: 'longer-than-five-chars' }));
    await store.set(mkEntry({ key: 'v1:a:x@1:h2', value: 'also-longer-than-five' }));

    const hashes = listReferencedBlobHashes(db);
    expect(hashes.size).toBe(2);

    db.close();
  });
});

describe('SQLite cache store — deletion + eviction', () => {
  it('delete removes the row', async () => {
    const db = new Database(dbPath);
    const blobs = createBlobStore(blobRoot);
    const store = createSQLiteCacheStore(db, blobs);

    await store.set(mkEntry());
    await store.delete('v1:test:ingredient@1:deadbeef');
    expect(await store.get('v1:test:ingredient@1:deadbeef')).toBeNull();

    db.close();
  });

  it('deleteByRecipe clears all entries for a recipe', async () => {
    const db = new Database(dbPath);
    const blobs = createBlobStore(blobRoot);
    const store = createSQLiteCacheStore(db, blobs);

    await store.set(mkEntry({ key: 'k1', recipe_id: 'r-a' }));
    await store.set(mkEntry({ key: 'k2', recipe_id: 'r-a' }));
    await store.set(mkEntry({ key: 'k3', recipe_id: 'r-b' }));

    await store.deleteByRecipe('r-a');

    expect(await store.get('k1')).toBeNull();
    expect(await store.get('k2')).toBeNull();
    expect(await store.get('k3')).not.toBeNull();

    db.close();
  });

  it('evictLRU removes oldest-accessed entries until size budget met', async () => {
    const db = new Database(dbPath);
    const blobs = createBlobStore(blobRoot);
    const store = createSQLiteCacheStore(db, blobs);

    await store.set(mkEntry({ key: 'k1', size_bytes: 100, last_accessed_at: 1000 }));
    await store.set(mkEntry({ key: 'k2', size_bytes: 100, last_accessed_at: 2000 }));
    await store.set(mkEntry({ key: 'k3', size_bytes: 100, last_accessed_at: 3000 }));

    await store.evictLRU(150);

    // Evict oldest-first until total ≤ target. 300 − 100 = 200 (still over),
    // 200 − 100 = 100 (under). So k1 and k2 are evicted, k3 survives.
    // Matches the reference in-memory store's semantics.
    expect(await store.get('k1')).toBeNull();
    expect(await store.get('k2')).toBeNull();
    expect(await store.get('k3')).not.toBeNull();

    db.close();
  });
});

describe('SQLite cache store — size accounting', () => {
  it('size() sums size_bytes across all entries', async () => {
    const db = new Database(dbPath);
    const blobs = createBlobStore(blobRoot);
    const store = createSQLiteCacheStore(db, blobs);

    await store.set(mkEntry({ key: 'a', size_bytes: 100 }));
    await store.set(mkEntry({ key: 'b', size_bytes: 250 }));

    expect(await store.size()).toBe(350);

    db.close();
  });

  it('clear removes everything', async () => {
    const db = new Database(dbPath);
    const blobs = createBlobStore(blobRoot);
    const store = createSQLiteCacheStore(db, blobs);

    await store.set(mkEntry({ key: 'a' }));
    await store.set(mkEntry({ key: 'b' }));
    await store.clear();

    expect(await store.size()).toBe(0);

    db.close();
  });
});

describe('SQLite cache store — persistence across open', () => {
  it('entries survive db close + reopen', async () => {
    {
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      const blobs = createBlobStore(blobRoot);
      const store = createSQLiteCacheStore(db, blobs);
      await store.set(mkEntry({ value: 'persisted' }));
      db.close();
    }
    {
      const db = new Database(dbPath);
      const blobs = createBlobStore(blobRoot);
      const store = createSQLiteCacheStore(db, blobs);
      const got = await store.get('v1:test:ingredient@1:deadbeef');
      expect(got?.value).toBe('persisted');
      db.close();
    }
  });
});
