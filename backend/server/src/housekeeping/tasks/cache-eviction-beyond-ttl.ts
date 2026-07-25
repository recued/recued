/** D-123 Phase 3 — `cache-eviction-beyond-ttl` housekeeping task.
 *
 *  Sweeps `cache_entries` rows whose `expires_at` is in the past.
 *  In-band cache reads only evict on access; rows that haven't been
 *  read since they expired stay in the table indefinitely. The
 *  housekeeping cycle is the only thing that picks them up.
 *
 *  Schema-fit deviation from spec §3.2: there is one
 *  `cache_entries` table, not separate `cache_l1` + `cache_l2`
 *  tables. The single-table cache-store schema in
 *  `backend/server/src/storage/sqlite-cache-store.ts:43-59` is the
 *  whole storage surface; the L1/L2 split lives at the cache
 *  contract layer (`packages/cache/`) above the SQLite store, not
 *  in the storage shape itself.
 *
 *  Cursor: `{ kind: 'complete' }` — every step is a fresh sweep at
 *  `now()`, so there is no useful per-row cursor to persist.
 *  Returning `'complete'` lets `last_status: 'complete'` settle and
 *  downstream tasks proceed; the next cycle re-fires with a new
 *  `now()` if more rows have expired in the interim.
 *
 *  No `onInvalidate` — TTL expiry is purely time-driven; nothing
 *  about a source-record write makes a non-expired row eligible.
 *
 *  Spec: D-123 §3.2. */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

/** Max rows deleted per inner DELETE — bounds transaction size +
 *  lets the scheduler yield mid-sweep on backed-up TTL queues. */
const CACHE_EVICTION_BATCH = 1000;

export const cacheEvictionBeyondTtlTask: HousekeepingTaskInstance = {
  meta: {
    id: 'cache-eviction-beyond-ttl',
    description:
      'Delete cache_entries rows whose TTL has elapsed — cleans up entries the in-band cache reads never picked up.',
    interruptible: true,
    kind: 'core',
    tags: ['kind:core', 'domain:cache', 'surface:deterministic'],
  },

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    // The cache table may not exist on a server that has never run
    // a recipe with caching — the SQLite cache store creates it
    // lazily on first construction. Probe defensively so the task
    // is a no-op rather than throwing on fresh installs.
    const tableExists =
      (
        ctx.db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='cache_entries'`,
          )
          .get() as { name: string } | undefined
      )?.name === 'cache_entries';
    if (!tableExists) {
      return { status: 'complete', cursor: { kind: 'complete' } };
    }

    const start = ctx.now();
    const deleteStmt = ctx.db.prepare(`
      DELETE FROM cache_entries
       WHERE rowid IN (
         SELECT rowid FROM cache_entries
          WHERE expires_at < ?
          LIMIT ?
       )
    `);

    while (true) {
      const elapsed = ctx.now() - start;
      if (elapsed >= budget_ms) {
        return {
          status: 'yield',
          reason: 'budget_exhausted',
          cursor: { kind: 'complete' },
        };
      }

      const result = deleteStmt.run(ctx.now(), CACHE_EVICTION_BATCH);
      const changes = Number(result.changes ?? 0);

      if (changes === 0) {
        return { status: 'complete', cursor: { kind: 'complete' } };
      }
      if (changes < CACHE_EVICTION_BATCH) {
        return { status: 'complete', cursor: { kind: 'complete' } };
      }
      // Otherwise iterate — there were exactly BATCH expired rows
      // in this pass, more may remain.
    }
  },
};
