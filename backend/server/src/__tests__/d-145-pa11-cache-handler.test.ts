/** D-145 PA11 — `housekeeping.cache.stats` / `housekeeping.cache.clear`
 *  rpc handler tests.
 *
 *  Covers:
 *    - `stats` reads from `LlmResultCacheStore.stats()` + joins
 *      `state.get('llm-result-cache-gc').last_run_at` for the
 *      last-GC timestamp.
 *    - `stats` returns `last_gc_at: null` when the GC task has never
 *      run on this pair.
 *    - `stats` throws `unsupported` when `llmResultCache` is not wired.
 *    - `clear` rejects unregistered callers with `permission_denied`.
 *    - `clear` throws `unsupported` when `llmResultCache` is not wired.
 *    - `clear` paired-client check fires BEFORE substrate-availability
 *      (mirrors the topic.reset error-ordering invariant).
 *    - `clear` drops every row + returns rows_deleted; audit row
 *      stamps action + detail + by-instance_id.
 *    - `clear` succeeds even when auditLog.logActivity throws
 *      (best-effort audit). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcError } from '@recued/contracts';

import {
  composeEnrichmentPath,
  createLlmResultCacheStore,
  createHousekeepingStateStore,
  ensureHousekeepingSchema,
  type LlmResultCacheStore,
  type HousekeepingStateStore,
} from '../housekeeping/index.js';
import {
  createHousekeepingConfigStore,
  type HousekeepingConfigStore,
} from '../housekeeping/config-store.js';
import {
  handleHousekeepingCacheClear,
  handleHousekeepingCacheStats,
  type HousekeepingRpcDeps,
} from '../housekeeping-handler.js';

let dir: string;
let db: Database.Database;
let config: HousekeepingConfigStore;
let state: HousekeepingStateStore;
let cache: LlmResultCacheStore;
let auditEntries: Array<{ action: string; target: string; detail: string }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa11-handler-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureHousekeepingSchema(db);
  config = createHousekeepingConfigStore(db);
  state = createHousekeepingStateStore(db);
  cache = createLlmResultCacheStore(db);
  auditEntries = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const buildDeps = (
  overrides: Partial<HousekeepingRpcDeps> = {},
): HousekeepingRpcDeps => ({
  config,
  state,
  registry: () => [],
  runOnce: async () => ({
    preset: 'balanced',
    duration_ms: 0,
    tasks_stepped: 0,
    tasks_complete: 0,
    tasks_yielded: 0,
    tasks_errored: 0,
    per_task: [],
  }),
  llmResultCache: cache,
  auditLog: {
    logActivity: async (entry: {
      action: string;
      target?: string;
      detail?: string;
    }) => {
      auditEntries.push({
        action: entry.action,
        target: entry.target ?? '',
        detail: entry.detail ?? '',
      });
    },
  } as never,
  ...overrides,
});

const seedCacheRow = (n = 1): void => {
  for (let i = 0; i < n; i++) {
    cache.insertOrIgnore({
      input_hash: `h_${i}`,
      result_hash: `r_${i}`,
      result_path: composeEnrichmentPath({
        topic: 'summary',
        scope: 'mail',
        target_id: `mail_${i}`,
      }),
      computed_at: 1_700_000_000 + i,
    });
  }
};

// ────────────────────────────────────────────────────────────────
// housekeeping.cache.stats
// ────────────────────────────────────────────────────────────────

describe('housekeeping.cache.stats', () => {
  it('returns empty rollup + null last_gc_at on a fresh DB', async () => {
    const result = await handleHousekeepingCacheStats(buildDeps());
    expect(result).toEqual({
      total_entries: 0,
      total_hits: 0,
      per_topic: [],
      last_gc_at: null,
    });
  });

  it('aggregates per-topic + carries the last-GC timestamp', async () => {
    seedCacheRow(3);
    cache.incrementHitCount('h_0');
    cache.incrementHitCount('h_0');
    // Seed the GC task's state row so the join lights up.
    state.set({
      task_id: 'llm-result-cache-gc',
      cursor: { kind: 'complete' },
      last_status: 'complete',
      last_run_at: 1_700_000_999,
    });

    const result = await handleHousekeepingCacheStats(buildDeps());
    expect(result.total_entries).toBe(3);
    expect(result.total_hits).toBe(2);
    expect(result.per_topic).toEqual([
      { topic: 'summary', entry_count: 3, hit_count: 2 },
    ]);
    expect(result.last_gc_at).toBe(1_700_000_999);
  });

  it('throws unsupported when llmResultCache is not wired', async () => {
    await expect(
      handleHousekeepingCacheStats(buildDeps({ llmResultCache: undefined })),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      handleHousekeepingCacheStats(buildDeps({ llmResultCache: undefined })),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

// ────────────────────────────────────────────────────────────────
// housekeeping.cache.clear
// ────────────────────────────────────────────────────────────────

describe('housekeeping.cache.clear', () => {
  it('rejects an unregistered caller with permission_denied', async () => {
    seedCacheRow(1);
    await expect(
      handleHousekeepingCacheClear(buildDeps(), undefined),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(
      handleHousekeepingCacheClear(buildDeps(), { instance_id: null }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    // The cache row survives a rejected clear.
    expect(cache.stats().total_entries).toBe(1);
  });

  it('rejects with permission_denied BEFORE unsupported when both gates fire', async () => {
    // No paired client + no cache wired — the paired-client gate must
    // fire first, mirroring topic.reset's error-ordering invariant so
    // an unregistered caller can't probe substrate availability.
    await expect(
      handleHousekeepingCacheClear(
        buildDeps({ llmResultCache: undefined }),
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('throws unsupported when llmResultCache is not wired', async () => {
    await expect(
      handleHousekeepingCacheClear(buildDeps({ llmResultCache: undefined }), {
        instance_id: 'client_abc',
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('drops every row + reports the count + emits an audit row', async () => {
    seedCacheRow(3);
    cache.incrementHitCount('h_0');
    expect(cache.stats().total_entries).toBe(3);

    const result = await handleHousekeepingCacheClear(
      buildDeps({ now: () => 1_700_001_234 }),
      { instance_id: 'client_xyz' },
    );

    expect(result).toEqual({ ok: true, rows_deleted: 3 });
    expect(cache.stats()).toEqual({
      total_entries: 0,
      total_hits: 0,
      per_topic: [],
    });
    expect(auditEntries).toEqual([
      {
        action: 'housekeeping_cache_clear',
        target: '',
        detail: 'rows_deleted=3,by=client_xyz',
      },
    ]);
  });

  it('returns ok: true with rows_deleted: 0 against an empty cache', async () => {
    const result = await handleHousekeepingCacheClear(buildDeps(), {
      instance_id: 'client_xyz',
    });
    expect(result).toEqual({ ok: true, rows_deleted: 0 });
    // Audit row still fires — the action was deliberate, even if no
    // rows changed.
    expect(auditEntries).toEqual([
      {
        action: 'housekeeping_cache_clear',
        target: '',
        detail: 'rows_deleted=0,by=client_xyz',
      },
    ]);
  });

  it('succeeds even when auditLog.logActivity throws', async () => {
    seedCacheRow(2);
    const deps: HousekeepingRpcDeps = {
      ...buildDeps(),
      auditLog: {
        logActivity: async () => {
          throw new Error('disk full');
        },
      } as never,
    };
    const result = await handleHousekeepingCacheClear(deps, {
      instance_id: 'client_xyz',
    });
    expect(result).toEqual({ ok: true, rows_deleted: 2 });
    expect(cache.stats().total_entries).toBe(0);
  });

  it('skips audit emission entirely when no auditLog is wired', async () => {
    seedCacheRow(1);
    const deps: HousekeepingRpcDeps = {
      ...buildDeps(),
      auditLog: undefined,
    };
    const result = await handleHousekeepingCacheClear(deps, {
      instance_id: 'client_xyz',
    });
    expect(result).toEqual({ ok: true, rows_deleted: 1 });
    // auditEntries comes from the build-deps mock; this deps object
    // dropped the logger so nothing should land.
    expect(auditEntries).toEqual([]);
  });
});
