import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createStorageGate, type StorageGate } from '@recued/storage-gate';
import { createInMemoryCollection, createAuditLogStore, type AuditLogStore } from '@recued/storage';
import type { AuditEntry, ActivityEntry } from '@recued/storage';
import {
  createSQLiteCacheStore,
} from '../storage/sqlite-cache-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { handleCachePut, handleCacheGet, type CacheRpcDeps } from '../cache-rpc-handler.js';
import { createInMemoryStore } from '@recued/cache';
import type { CacheEntry } from '@recued/cache';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mkEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => ({
  key: 'k',
  value: { v: 1 },
  expires_at: Date.now() + 60_000,
  recipe_id: 'test',
  ingredient_slug: 'test-ing',
  size_bytes: 100,
  created_at: Date.now(),
  last_accessed_at: Date.now(),
  ...overrides,
});

describe('InMemoryStore — onBytesChanged', () => {
  it('reports positive delta on set', async () => {
    const deltas: number[] = [];
    const store = createInMemoryStore({ onBytesChanged: (d) => deltas.push(d) });
    await store.set(mkEntry({ key: 'a', size_bytes: 100 }));
    await store.set(mkEntry({ key: 'b', size_bytes: 250 }));
    expect(deltas).toEqual([100, 250]);
  });

  it('reports net delta on overwrite', async () => {
    const deltas: number[] = [];
    const store = createInMemoryStore({ onBytesChanged: (d) => deltas.push(d) });
    await store.set(mkEntry({ key: 'a', size_bytes: 100 }));
    deltas.length = 0;
    await store.set(mkEntry({ key: 'a', size_bytes: 300 }));
    expect(deltas).toEqual([200]); // 300 - 100
  });

  it('reports negative delta on delete', async () => {
    const deltas: number[] = [];
    const store = createInMemoryStore({ onBytesChanged: (d) => deltas.push(d) });
    await store.set(mkEntry({ key: 'a', size_bytes: 500 }));
    deltas.length = 0;
    await store.delete('a');
    expect(deltas).toEqual([-500]);
  });

  it('reports 0 delete on missing key', async () => {
    const deltas: number[] = [];
    const store = createInMemoryStore({ onBytesChanged: (d) => deltas.push(d) });
    await store.delete('never-existed');
    expect(deltas).toEqual([]);
  });

  it('reports freed bytes on evictLRU', async () => {
    const deltas: number[] = [];
    const store = createInMemoryStore({ onBytesChanged: (d) => deltas.push(d) });
    await store.set(mkEntry({ key: 'a', size_bytes: 100, last_accessed_at: 1 }));
    await store.set(mkEntry({ key: 'b', size_bytes: 200, last_accessed_at: 2 }));
    await store.set(mkEntry({ key: 'c', size_bytes: 300, last_accessed_at: 3 }));
    deltas.length = 0;
    await store.evictLRU(300); // need to free 300 bytes — evict oldest
    const totalFreed = deltas.reduce((s, d) => s + d, 0);
    expect(totalFreed).toBeLessThanOrEqual(-300);
  });

  it('reports sum of freed bytes on deleteByRecipe', async () => {
    const deltas: number[] = [];
    const store = createInMemoryStore({ onBytesChanged: (d) => deltas.push(d) });
    await store.set(mkEntry({ key: 'a', recipe_id: 'r1', size_bytes: 100 }));
    await store.set(mkEntry({ key: 'b', recipe_id: 'r1', size_bytes: 200 }));
    await store.set(mkEntry({ key: 'c', recipe_id: 'r2', size_bytes: 300 }));
    deltas.length = 0;
    await store.deleteByRecipe('r1');
    expect(deltas).toEqual([-300]);
  });

  it('no-op when onBytesChanged is undefined (legacy path)', async () => {
    const store = createInMemoryStore();
    await store.set(mkEntry({ key: 'a', size_bytes: 100 }));
    await store.delete('a');
    // Doesn't throw — and that's all we can assert at the behavioural level.
    expect(true).toBe(true);
  });

  it('protects callers from handler exceptions', async () => {
    const store = createInMemoryStore({
      onBytesChanged: () => { throw new Error('boom'); },
    });
    // Must not throw.
    await expect(store.set(mkEntry({ key: 'a', size_bytes: 100 }))).resolves.toBeUndefined();
  });
});

describe('SQLiteCacheStore — onBytesChanged', () => {
  let db: Database.Database;
  let tmpRoot: string;
  let deltas: number[];

  beforeEach(() => {
    db = new Database(':memory:');
    tmpRoot = mkdtempSync(join(tmpdir(), 'cache-gate-'));
    deltas = [];
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reports positive delta on set, net delta on overwrite, negative on delete', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSQLiteCacheStore(db, blobs, {
      onBytesChanged: (d) => deltas.push(d),
    });
    await store.set(mkEntry({ key: 'a', size_bytes: 100 }));
    await store.set(mkEntry({ key: 'a', size_bytes: 300 })); // overwrite
    await store.delete('a');
    expect(deltas).toEqual([100, 200, -300]);
  });

  it('reports total freed on evictLRU', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSQLiteCacheStore(db, blobs, {
      onBytesChanged: (d) => deltas.push(d),
    });
    await store.set(mkEntry({ key: 'a', size_bytes: 100, last_accessed_at: 1 }));
    await store.set(mkEntry({ key: 'b', size_bytes: 200, last_accessed_at: 2 }));
    deltas.length = 0;
    await store.evictLRU(50); // free at least 250 bytes
    const freed = deltas.reduce((s, d) => s + d, 0);
    expect(freed).toBe(-300);
  });

  it('reports total on clear', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSQLiteCacheStore(db, blobs, {
      onBytesChanged: (d) => deltas.push(d),
    });
    await store.set(mkEntry({ key: 'a', size_bytes: 100 }));
    await store.set(mkEntry({ key: 'b', size_bytes: 250 }));
    deltas.length = 0;
    await store.clear();
    expect(deltas).toEqual([-350]);
  });
});

describe('handleCachePut — gate admission check', () => {
  let gate: StorageGate;
  let auditLog: AuditLogStore;
  let auditBacking: ReturnType<typeof createInMemoryCollection<ActivityEntry>>;

  beforeEach(() => {
    // MIN_RESERVE_BYTES is 10 MB — use a 20 MB quota so the
    // available region is non-zero at 0% reserve.
    gate = createStorageGate({
      quota: 20 * 1024 * 1024,
      reservePct: 0,
      surface: 'cache',
      pressureRatio: 0.8,
    });
    auditBacking = createInMemoryCollection<ActivityEntry>();
    auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), auditBacking);
  });

  const mkDeps = (store = createInMemoryStore()): CacheRpcDeps => ({
    store,
    db: null as unknown as Database.Database,
    blobs: null as unknown as import('../storage/blob-store.js').BlobStore,
    gate,
    auditLog,
  });

  it('accepts writes under the gate pressure threshold', async () => {
    const store = createInMemoryStore({ onBytesChanged: (d) => gate.addUsed(d) });
    const deps = mkDeps(store);
    const res = await handleCachePut(deps, {
      entries: [{
        key: 'a', value: 1, expires_at: 9e12, recipe_id: 'r',
        ingredient_slug: 's', size_bytes: 100, created_at: 1, last_accessed_at: 1,
      }],
    });
    expect(res.accepted).toBe(1);
    expect(res.skipped).toBe(0);
  });

  it('rejects writes that would exceed writes_blocked', async () => {
    // Prime gate right at blockedAt so the next write fails.
    gate.setUsed(gate.info().blockedAt);
    const deps = mkDeps();
    const res = await handleCachePut(deps, {
      entries: [{
        key: 'a', value: 1, expires_at: 9e12, recipe_id: 'r',
        ingredient_slug: 's', size_bytes: 100, created_at: 1, last_accessed_at: 1,
      }],
    });
    expect(res.accepted).toBe(0);
    expect(res.skipped).toBe(1);
    await new Promise((r) => setImmediate(r));
    const activities = await auditLog.listActivities();
    expect(activities.some((a) => a.action === 'quota_exceeded' && a.target === 'cache')).toBe(true);
  });

  it('accepts overwrite when net delta is 0', async () => {
    // Add existing entry first using a direct store write so gate sees it.
    const store = createInMemoryStore({ onBytesChanged: (d) => gate.addUsed(d) });
    await store.set({
      key: 'a', value: 1, expires_at: 9e12, recipe_id: 'r',
      ingredient_slug: 's', size_bytes: 500, created_at: 1, last_accessed_at: 1,
    });
    // Now push gate close to blocked.
    gate.setUsed(gate.info().blockedAt - 100);

    const deps = mkDeps(store);
    const res = await handleCachePut(deps, {
      entries: [{
        key: 'a', value: 2, expires_at: 9e12, recipe_id: 'r',
        ingredient_slug: 's', size_bytes: 500, created_at: 2, last_accessed_at: 2,
      }],
    });
    // Same size_bytes → projected delta = 0 → admission succeeds.
    expect(res.accepted).toBe(1);
  });

  it('passes through when no gate is wired (legacy test path)', async () => {
    const deps: CacheRpcDeps = {
      store: createInMemoryStore(),
      db: null as unknown as Database.Database,
      blobs: null as unknown as import('../storage/blob-store.js').BlobStore,
    };
    const res = await handleCachePut(deps, {
      entries: [{
        key: 'a', value: 1, expires_at: 9e12, recipe_id: 'r',
        ingredient_slug: 's', size_bytes: 100_000_000, created_at: 1, last_accessed_at: 1,
      }],
    });
    expect(res.accepted).toBe(1);
  });

  it('rejections record the specific gate reason', async () => {
    gate.setUsed(gate.info().blockedAt);
    await handleCachePut(mkDeps(), {
      entries: [{
        key: 'a', value: 1, expires_at: 9e12, recipe_id: 'r',
        ingredient_slug: 's', size_bytes: 100, created_at: 1, last_accessed_at: 1,
      }],
    });
    await new Promise((r) => setImmediate(r));
    const activities = await auditLog.listActivities();
    const reject = activities.find((a) => a.action === 'quota_exceeded');
    expect(reject).toBeDefined();
    // Reason surfaces as detail — `writes_blocked` when over the user ceiling.
    expect(['writes_blocked', 'storage_pressure'].includes(reject!.detail ?? '')).toBe(true);
  });
});
