/** D-123 Phase 3 — `cache-eviction-beyond-ttl` task tests. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cacheEvictionBeyondTtlTask } from '../housekeeping/tasks/cache-eviction-beyond-ttl.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

let dir: string;
let db: Database.Database;
let now = 1_700_000_000_000;

const ensureCacheTable = () => {
  // Mirrors backend/server/src/storage/sqlite-cache-store.ts:43-59
  // (SCHEMA constant). Only the columns the eviction task touches
  // need NOT NULL semantics — the rest defaults to NULL via SQLite's
  // permissive insert path, which is fine for these tests.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      key              TEXT PRIMARY KEY,
      inline_value     TEXT,
      blob_hash        TEXT,
      expires_at       INTEGER NOT NULL,
      recipe_id        TEXT NOT NULL,
      ingredient_slug  TEXT NOT NULL,
      size_bytes       INTEGER NOT NULL,
      created_at       INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      category         TEXT,
      risk_tier        TEXT
    );
  `);
};

const insertCacheEntry = (key: string, expires_at: number, created_at = expires_at - 60_000): void => {
  db.prepare(`
    INSERT INTO cache_entries (
      key, inline_value, blob_hash, expires_at, recipe_id,
      ingredient_slug, size_bytes, created_at, last_accessed_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `).run(key, '{}', expires_at, 'recipe-test', 'ingredient-test', 2, created_at, created_at);
};

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

const countCacheRows = (): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM cache_entries`).get() as { c: number }).c;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-cache-eviction-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('cacheEvictionBeyondTtlTask metadata', () => {
  it('declares core kind, interruptible, no deps, no invalidate hook', () => {
    expect(cacheEvictionBeyondTtlTask.meta.id).toBe('cache-eviction-beyond-ttl');
    expect(cacheEvictionBeyondTtlTask.meta.kind).toBe('core');
    expect(cacheEvictionBeyondTtlTask.meta.interruptible).toBe(true);
    expect(cacheEvictionBeyondTtlTask.meta.depends_on).toBeUndefined();
    expect(cacheEvictionBeyondTtlTask.onInvalidate).toBeUndefined();
  });
});

describe('cacheEvictionBeyondTtlTask.step', () => {
  it('returns complete when the cache table does not exist (fresh server)', async () => {
    // No ensureCacheTable() — table is absent.
    const result = await cacheEvictionBeyondTtlTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('deletes expired rows and leaves live rows untouched', async () => {
    ensureCacheTable();
    insertCacheEntry('expired-1', now - 10_000); // expired
    insertCacheEntry('expired-2', now - 1);      // expired by 1ms
    insertCacheEntry('live-1',    now + 1_000);  // live
    insertCacheEntry('live-2',    now + 60_000); // live

    const result = await cacheEvictionBeyondTtlTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
    expect(countCacheRows()).toBe(2);
    const remaining = (db
      .prepare(`SELECT key FROM cache_entries ORDER BY key ASC`)
      .all() as Array<{ key: string }>).map((r) => r.key);
    expect(remaining).toEqual(['live-1', 'live-2']);
  });

  it('treats expires_at == now as still live (strict <)', async () => {
    ensureCacheTable();
    insertCacheEntry('exactly-now', now);
    insertCacheEntry('one-ms-past', now - 1);

    await cacheEvictionBeyondTtlTask.step(stubCtx(), { kind: 'complete' }, 60_000);

    const remaining = (db
      .prepare(`SELECT key FROM cache_entries ORDER BY key ASC`)
      .all() as Array<{ key: string }>).map((r) => r.key);
    expect(remaining).toEqual(['exactly-now']);
  });

  it('returns complete with no work when nothing has expired', async () => {
    ensureCacheTable();
    insertCacheEntry('live-1', now + 1_000);
    insertCacheEntry('live-2', now + 60_000);

    const result = await cacheEvictionBeyondTtlTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
    expect(countCacheRows()).toBe(2);
  });

  it('returns complete with a cursor of kind=complete', async () => {
    ensureCacheTable();
    insertCacheEntry('expired', now - 1);

    const result = await cacheEvictionBeyondTtlTask.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('yields with budget_exhausted when budget is zero', async () => {
    ensureCacheTable();
    insertCacheEntry('expired', now - 1);

    const result = await cacheEvictionBeyondTtlTask.step(stubCtx(), { kind: 'complete' }, 0);
    expect(result.status).toBe('yield');
    if (result.status === 'yield') {
      expect(result.reason).toBe('budget_exhausted');
    }
    // No DELETE attempted — row still present.
    expect(countCacheRows()).toBe(1);
  });
});
