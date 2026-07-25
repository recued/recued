/** D-145 § A.7.10 follow-on — `llm-result-cache-gc` housekeeping task.
 *
 *  Pairs with `d-145-pa9-6-llm-result-cache-store.test.ts` (the primitive
 *  unit tests). This file exercises the scheduled-task wrapper:
 *    - No-op when `ctx.llmResultCache` is undefined (substrate not wired).
 *    - Walks the cache + drops rows whose enrichment path no longer
 *      resolves to a row (the post-§A.7.9 cleanup residue case the
 *      lookup hot-path's lazy-delete never sees).
 *    - Preserves rows whose enrichment row still exists.
 *    - Emits exactly one audit row when rows_deleted > 0; zero audit
 *      rows on a clean sweep.
 *    - Registered through `STANDALONE_TASKS` so the scheduler picks it
 *      up alongside the four other deterministic-maintenance tasks. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composeEnrichmentPath,
  createLlmResultCacheStore,
  ensureHousekeepingSchema,
  type LlmResultCacheStore,
} from '../housekeeping/index.js';
import { llmResultCacheGcTask } from '../housekeeping/tasks/llm-result-cache-gc.js';
import { STANDALONE_TASKS } from '../housekeeping/registration.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type {
  HousekeepingAuditRow,
  HousekeepingContext,
} from '../housekeeping/registry.js';
import type { HousekeepingCursor } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Fixture
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let enrichmentStore: EnrichmentStore;
let cacheStore: LlmResultCacheStore;
let auditRows: HousekeepingAuditRow[];
let nowMs: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-6-cache-gc-task-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureHousekeepingSchema(db);
  enrichmentStore = createEnrichmentStore(db);
  cacheStore = createLlmResultCacheStore(db);
  auditRows = [];
  nowMs = 1_700_000_000_000;
});

afterEach(() => {
  enrichmentStore.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ctxWith = (
  override: Partial<HousekeepingContext> = {},
): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore,
  recipeStore: {} as never,
  now: () => nowMs,
  emitAuditRow: (row) => {
    auditRows.push(row);
  },
  llmResultCache: cacheStore,
  ...override,
});

/** Write the minimum-valid enrichment row so `readEnrichmentValueFromPath`
 *  returns a non-null value. The cache GC test only needs the resolver
 *  to distinguish "row exists" vs "row absent"; the actual value bytes
 *  don't matter, so the upsert uses the minimal field set the
 *  `EnrichmentStore.upsert` contract accepts. */
const insertEnrichmentRow = (
  topic: 'summary',
  scope: 'mail',
  target_id: string,
): void => {
  enrichmentStore.upsert({
    topic,
    scope,
    target_id,
    value: { text: 'cached' },
    authored_by: 'enrichment.summary',
  });
};

const insertCacheRow = (
  input_hash: string,
  result_path: string,
  result_hash = 'r',
): void => {
  cacheStore.insertOrIgnore({
    input_hash,
    result_hash,
    result_path,
    computed_at: nowMs,
  });
};

// ────────────────────────────────────────────────────────────────
// 1. Substrate gating
// ────────────────────────────────────────────────────────────────

describe('llmResultCacheGcTask — substrate gating', () => {
  it('completes as a no-op when ctx.llmResultCache is undefined', async () => {
    const result = await llmResultCacheGcTask.step(
      ctxWith({ llmResultCache: undefined }),
      { kind: 'complete' } satisfies HousekeepingCursor,
      10_000,
    );
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
    expect(auditRows).toEqual([]);
  });

  it('completes cleanly when the cache is empty (no audit row on zero deletes)', async () => {
    const result = await llmResultCacheGcTask.step(
      ctxWith(),
      { kind: 'complete' } satisfies HousekeepingCursor,
      10_000,
    );
    expect(result.status).toBe('complete');
    expect(auditRows).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. GC behavior — drops dangling refs, preserves live ones
// ────────────────────────────────────────────────────────────────

describe('llmResultCacheGcTask — dangling-ref detection', () => {
  it('drops cache rows whose enrichment path no longer resolves', async () => {
    // Two cache rows. One points at a live enrichment row; the other
    // points at a path that was reaped by § A.7.9 universal cleanup.
    insertEnrichmentRow('summary', 'mail', 'msg-live');
    insertCacheRow(
      'h-live',
      composeEnrichmentPath({
        topic: 'summary',
        scope: 'mail',
        target_id: 'msg-live',
      }),
    );
    insertCacheRow(
      'h-dangling',
      composeEnrichmentPath({
        topic: 'summary',
        scope: 'mail',
        target_id: 'msg-reaped',
      }),
    );

    const result = await llmResultCacheGcTask.step(
      ctxWith(),
      { kind: 'complete' } satisfies HousekeepingCursor,
      10_000,
    );

    expect(result.status).toBe('complete');
    // Dangling row is gone; live row survives.
    expect(cacheStore.lookup('h-dangling')).toBeNull();
    expect(cacheStore.lookup('h-live')).not.toBeNull();
  });

  it('drops cache rows whose path is malformed (schema-drift case)', async () => {
    // Pre-existing cache row from a legacy or corrupt write — path
    // doesn't start with `data.enrichment.` and parseEnrichmentPath
    // returns null. Treated as dangling.
    insertCacheRow('h-corrupt', 'legacy.broken.path.from.some.old.version');

    await llmResultCacheGcTask.step(
      ctxWith(),
      { kind: 'complete' } satisfies HousekeepingCursor,
      10_000,
    );
    expect(cacheStore.lookup('h-corrupt')).toBeNull();
  });

  it('drops cache rows whose topic is unknown to the registry', async () => {
    // The path is well-formed but the topic isn't registered. Could
    // arise during a registry retraction window; the cache entry is
    // unreachable so we drop it.
    insertCacheRow(
      'h-unknown-topic',
      'data.enrichment.nonexistent-topic.mail.msg-1',
    );

    await llmResultCacheGcTask.step(
      ctxWith(),
      { kind: 'complete' } satisfies HousekeepingCursor,
      10_000,
    );
    expect(cacheStore.lookup('h-unknown-topic')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Audit emission
// ────────────────────────────────────────────────────────────────

describe('llmResultCacheGcTask — audit emission', () => {
  it('emits exactly one audit row when rows_deleted > 0', async () => {
    insertCacheRow('h-1', 'data.enrichment.summary.mail.gone-1');
    insertCacheRow('h-2', 'data.enrichment.summary.mail.gone-2');

    await llmResultCacheGcTask.step(
      ctxWith(),
      { kind: 'complete' } satisfies HousekeepingCursor,
      10_000,
    );

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe('llm_result_cache_gc');
    expect(auditRows[0]?.run_mode).toBe('live');
    expect(auditRows[0]?.detail).toEqual({ rows_deleted: 2 });
  });

  it('emits zero audit rows when nothing was dangling (clean sweep silence)', async () => {
    insertEnrichmentRow('summary', 'mail', 'msg-1');
    insertCacheRow(
      'h-clean',
      composeEnrichmentPath({
        topic: 'summary',
        scope: 'mail',
        target_id: 'msg-1',
      }),
    );

    await llmResultCacheGcTask.step(
      ctxWith(),
      { kind: 'complete' } satisfies HousekeepingCursor,
      10_000,
    );
    expect(auditRows).toEqual([]);
    // Live row preserved.
    expect(cacheStore.lookup('h-clean')).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Registry presence
// ────────────────────────────────────────────────────────────────

describe('llmResultCacheGcTask — STANDALONE_TASKS registration', () => {
  it('is included in STANDALONE_TASKS by id', () => {
    const ids = STANDALONE_TASKS.map((t) => t.meta.id);
    expect(ids).toContain('llm-result-cache-gc');
  });

  it('declares kind:core + interruptible + the standard core tags', () => {
    // Pins the meta against the cache-eviction-beyond-ttl pattern so
    // schedulers + housekeeping panel renderers grouping by kind keep
    // working as the deterministic core grows.
    expect(llmResultCacheGcTask.meta.kind).toBe('core');
    expect(llmResultCacheGcTask.meta.interruptible).toBe(true);
    const tags = llmResultCacheGcTask.meta.tags ?? [];
    expect(tags).toContain('kind:core');
    expect(tags).toContain('surface:deterministic');
  });

  it('has no onInvalidate hook (time-driven sweep, not source-driven)', () => {
    expect(llmResultCacheGcTask.onInvalidate).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 5. Defensive callback shape
// ────────────────────────────────────────────────────────────────

describe('llmResultCacheGcTask — primitive interaction', () => {
  it('invokes gcDanglingRefs once per step with a resolvePathExists callback', async () => {
    let calls = 0;
    let lastArg: { resolvePathExists?: (path: string) => boolean } | undefined;
    const gcStub: LlmResultCacheStore['gcDanglingRefs'] = (args) => {
      calls += 1;
      lastArg = args;
      return { rows_deleted: 0 };
    };
    const cacheStub: LlmResultCacheStore = {
      ...cacheStore,
      gcDanglingRefs: gcStub,
    };
    await llmResultCacheGcTask.step(
      ctxWith({ llmResultCache: cacheStub }),
      { kind: 'complete' } satisfies HousekeepingCursor,
      10_000,
    );
    expect(calls).toBe(1);
    expect(typeof lastArg?.resolvePathExists).toBe('function');
  });
});
