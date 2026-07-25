import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { CacheEntry } from '@recued/cache';
import { RpcError } from '@recued/contracts';
import {
  handleCacheGet,
  handleCachePut,
  handleCacheSince,
  type CacheRpcDeps,
} from '../cache-rpc-handler.js';
import { createBlobStore, createSQLiteCacheStore } from '../storage/index.js';

let workDir: string;
let deps: CacheRpcDeps;
let db: Database.Database;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'recued-cache-rpc-'));
  db = new Database(join(workDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const blobs = createBlobStore(join(workDir, 'blobs'));
  const store = createSQLiteCacheStore(db, blobs);
  deps = { store, db, blobs };
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

const mkEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => {
  const now = Date.now();
  return {
    key: `v1:pair-abc:ingredient@1:${Math.random().toString(36).slice(2)}`,
    value: { payload: 'x' },
    expires_at: now + 60_000,
    recipe_id: 'r',
    ingredient_slug: 'ingredient',
    size_bytes: 20,
    created_at: now,
    last_accessed_at: now,
    category: 'data',
    risk_tier: 'read',
    ...overrides,
  };
};

// ────────────────────────────────────────────────────────────────
// cache.get
// ────────────────────────────────────────────────────────────────

describe('handleCacheGet', () => {
  it('returns null for missing key', async () => {
    const res = await handleCacheGet(deps, { key: 'v1:pair-abc:x@1:missing' });
    expect(res.entry).toBeNull();
  });

  it('returns the entry when present', async () => {
    const entry = mkEntry();
    await deps.store.set(entry);
    const res = await handleCacheGet(deps, { key: entry.key });
    expect(res.entry?.key).toBe(entry.key);
  });

  it('rejects missing key', async () => {
    await expect(handleCacheGet(deps, {})).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects non-string key', async () => {
    await expect(handleCacheGet(deps, { key: 42 })).rejects.toBeInstanceOf(RpcError);
  });
});

// ────────────────────────────────────────────────────────────────
// cache.put
// ────────────────────────────────────────────────────────────────

describe('handleCachePut', () => {
  it('accepts a batch of entries', async () => {
    const entries = [mkEntry({ key: 'k1' }), mkEntry({ key: 'k2' })];
    const res = await handleCachePut(deps, { entries });
    expect(res.accepted).toBe(2);
    expect(res.skipped).toBe(0);

    const got1 = await deps.store.get('k1');
    const got2 = await deps.store.get('k2');
    expect(got1).not.toBeNull();
    expect(got2).not.toBeNull();
  });

  it('skips malformed entries but accepts valid ones in the same batch', async () => {
    const entries = [mkEntry({ key: 'valid' }), { not: 'a real entry' }];
    const res = await handleCachePut(deps, { entries });
    expect(res.accepted).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it('last-writer-wins: newer local beats older peer', async () => {
    const now = Date.now();
    await deps.store.set(mkEntry({ key: 'k', created_at: now }));
    const older = mkEntry({ key: 'k', created_at: now - 1000, value: 'peer-stale' });
    const res = await handleCachePut(deps, { entries: [older] });
    expect(res.skipped).toBe(1);

    const still = await deps.store.get('k');
    expect(still?.value).not.toBe('peer-stale');
  });

  it('last-writer-wins: newer peer beats older local', async () => {
    const now = Date.now();
    await deps.store.set(mkEntry({ key: 'k', created_at: now - 1000 }));
    const newer = mkEntry({ key: 'k', created_at: now, value: 'peer-fresh' });
    const res = await handleCachePut(deps, { entries: [newer] });
    expect(res.accepted).toBe(1);

    const got = await deps.store.get('k');
    expect(got?.value).toBe('peer-fresh');
  });

  it('rejects non-array entries', async () => {
    await expect(handleCachePut(deps, { entries: 'nope' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('rejects batch over limit', async () => {
    const huge = Array.from({ length: 201 }, (_, i) => mkEntry({ key: `k${i}` }));
    await expect(handleCachePut(deps, { entries: huge })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// cache.since
// ────────────────────────────────────────────────────────────────

describe('handleCacheSince', () => {
  it('returns entries created after cursor', async () => {
    const t0 = 1_000_000;
    await deps.store.set(mkEntry({ key: 'k1', created_at: t0 }));
    await deps.store.set(mkEntry({ key: 'k2', created_at: t0 + 100 }));
    await deps.store.set(mkEntry({ key: 'k3', created_at: t0 + 200 }));

    const res = await handleCacheSince(deps, { cursor: t0 + 50 });
    expect(res.entries.length).toBe(2);
    expect(res.entries[0].key).toBe('k2');
    expect(res.entries[1].key).toBe('k3');
  });

  it('returns next_cursor when hitting limit', async () => {
    for (let i = 0; i < 5; i++) {
      await deps.store.set(mkEntry({ key: `k${i}`, created_at: 1000 + i }));
    }
    const res = await handleCacheSince(deps, { cursor: 0, limit: 2 });
    expect(res.entries.length).toBe(2);
    expect(res.next_cursor).toBe(1001);
  });

  it('next_cursor is null when all results returned', async () => {
    await deps.store.set(mkEntry({ key: 'only', created_at: 1000 }));
    const res = await handleCacheSince(deps, { cursor: 0, limit: 100 });
    expect(res.next_cursor).toBeNull();
  });

  it('empty cursor defaults to 0 (full dump)', async () => {
    await deps.store.set(mkEntry({ key: 'k1', created_at: 1000 }));
    const res = await handleCacheSince(deps, {});
    expect(res.entries.length).toBe(1);
  });

  it('clamps limit to MAX_SINCE_LIMIT', async () => {
    const res = await handleCacheSince(deps, { cursor: 0, limit: 99_999 });
    expect(res.entries).toBeDefined(); // shouldn't blow up; limit clamped internally
  });
});

// D-103: cache.invalidate rpc removed. TTL + LRU handle expiry.

describe('cache-rpc — prefs.cache.sync_l2 gate', () => {
  const gatedDeps = (syncL2: boolean): CacheRpcDeps => ({
    ...deps,
    getPeerPrefs: () => ({ 'cache.sync_l2': syncL2 }),
  });

  it('cache.put drops step entries when sync_l2=false', async () => {
    const step = mkEntry({
      key: 'v1:pair-abc:step@1:a',
      category: 'step',
    });
    const data = mkEntry({
      key: 'v1:pair-abc:d@1:b',
      category: 'data',
    });
    const res = await handleCachePut(gatedDeps(false), { entries: [step, data] });
    expect(res.accepted).toBe(1);
    expect(res.skipped).toBe(1);
    expect(await deps.store.get(step.key)).toBeNull();
    expect(await deps.store.get(data.key)).not.toBeNull();
  });

  it('cache.put accepts step entries when sync_l2=true', async () => {
    const step = mkEntry({ key: 'v1:pair-abc:step@1:c', category: 'step' });
    const res = await handleCachePut(gatedDeps(true), { entries: [step] });
    expect(res.accepted).toBe(1);
    expect(await deps.store.get(step.key)).not.toBeNull();
  });

  it('cache.since filters step entries from the delta when sync_l2=false', async () => {
    // Seed two entries: one step, one data. Both land via the
    // underlying store (bypassing the put gate) so we test since-side
    // filtering independently.
    const step = mkEntry({
      key: 'v1:pair-abc:step@1:d',
      category: 'step',
      created_at: 1000,
    });
    const data = mkEntry({
      key: 'v1:pair-abc:d@1:e',
      category: 'data',
      created_at: 2000,
    });
    await deps.store.set(step);
    await deps.store.set(data);

    const res = await handleCacheSince(gatedDeps(false), { cursor: 0 });
    const keys = res.entries.map((e) => e.key);
    expect(keys).toContain(data.key);
    expect(keys).not.toContain(step.key);
  });

  it('cache.since returns all entries when sync_l2=true', async () => {
    const step = mkEntry({ key: 'v1:pair-abc:step@1:f', category: 'step' });
    const data = mkEntry({ key: 'v1:pair-abc:d@1:g', category: 'data' });
    await deps.store.set(step);
    await deps.store.set(data);

    const res = await handleCacheSince(gatedDeps(true), { cursor: 0 });
    const keys = res.entries.map((e) => e.key);
    expect(keys).toContain(step.key);
    expect(keys).toContain(data.key);
  });

  it('missing getPeerPrefs defaults to sync on (back-compat)', async () => {
    const step = mkEntry({ key: 'v1:pair-abc:step@1:h', category: 'step' });
    const res = await handleCachePut(deps, { entries: [step] });
    expect(res.accepted).toBe(1);
  });
});
