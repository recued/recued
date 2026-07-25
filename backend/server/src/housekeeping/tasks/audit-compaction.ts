/** D-123 Phase 3 — `audit-compaction` housekeeping task.
 *
 *  Walks `audit_entries` in `started_at` ASC order and dedupes
 *  consecutive rows of the same `(recipe_id, recipe_hash)` that
 *  arrive within a 2-minute window, keeping the earliest. Targets
 *  the noisy reactive recipe shape — same-version recipe firing
 *  every tick, succeeding, producing near-identical audit rows
 *  with no work to do.
 *
 *  Schema-fit deviation from the spec text (handover note
 *  2026-04-29): the spec's §3.1 reads `data_memory` rows by
 *  `action='collection_synced'` + `detail.records_imported`. The
 *  actual `AuditEntry` shape (`packages/storage/src/audit.ts`)
 *  carries `recipe_id` / `recipe_hash` / `success`, with no
 *  `action` or `detail` fields. We dedupe on what's actually
 *  there: `(recipe_id, recipe_hash)` collapses noisy reactive
 *  recipes; the success-only filter avoids deleting failures
 *  (operators need every failure preserved).
 *
 *  Cursor: `{ kind: 'time', last_seen_at }`. Audit is append-only
 *  (after redaction) so the cursor moves forward only. On yield,
 *  cursor advances to the latest `started_at` processed; the
 *  bounded miss on resume (≤2 min of late-arriving dupes that
 *  span the yield boundary) is acceptable — duplicate-collapse
 *  is best-effort and the eager retention pruner closes the gap
 *  for genuinely-stale rows.
 *
 *  No `onInvalidate` — audit is append-only; nothing causes
 *  earlier rows to become eligible for re-compaction.
 *
 *  Spec: D-123 §3.1. */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

/** Compaction window — consecutive identical-`recipe_hash` runs of
 *  the same `recipe_id` arriving within this many ms collapse to
 *  the earliest. Two minutes balances "noisy reactive ticks
 *  collapse" against "operators want at least a sample of the
 *  cadence" — anything tighter starts erasing tick patterns the
 *  user installed the recipe to produce. */
export const AUDIT_COMPACTION_WINDOW_MS = 2 * 60_000;

/** Max rows pulled per inner loop. Bounds memory + lets the
 *  scheduler yield between batches when budget tightens. 1000 is
 *  a comfortable sweet spot — well below SQLite's `999`-bind-param
 *  ceiling and small enough for in-process iteration to stay under
 *  the cycle's typical 60s budget. */
const AUDIT_COMPACTION_BATCH = 1000;

interface AuditRow {
  key: string;
  started_at: number;
  recipe_id: string;
  recipe_hash: string;
}

const cursorStartedAt = (cursor: HousekeepingCursor): number =>
  cursor.kind === 'time' ? cursor.last_seen_at : 0;

export const auditCompactionTask: HousekeepingTaskInstance = {
  meta: {
    id: 'audit-compaction',
    description:
      'Dedupe same-recipe / same-hash audit rows within a 2-minute window — collapses noisy reactive ticks.',
    interruptible: true,
    kind: 'core',
    tags: ['kind:core', 'domain:audit', 'surface:deterministic'],
  },

  async step(
    ctx: HousekeepingContext,
    cursor: HousekeepingCursor,
    budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    const start = ctx.now();
    let last_seen_at = cursorStartedAt(cursor);

    const selectStmt = ctx.db.prepare(`
      SELECT key,
             json_extract(data, '$.started_at')   AS started_at,
             json_extract(data, '$.recipe_id')    AS recipe_id,
             json_extract(data, '$.recipe_hash')  AS recipe_hash
        FROM audit_entries
       WHERE json_extract(data, '$.started_at') > ?
         AND json_extract(data, '$.commit_status') = 'succeeded'
       ORDER BY json_extract(data, '$.started_at') ASC
       LIMIT ?
    `);

    const deleteStmt = ctx.db.prepare(`DELETE FROM audit_entries WHERE key = ?`);

    let total_deleted = 0;

    while (true) {
      const elapsed = ctx.now() - start;
      if (elapsed >= budget_ms) {
        return {
          status: 'yield',
          reason: 'budget_exhausted',
          cursor: { kind: 'time', last_seen_at },
        };
      }

      const rows = selectStmt.all(last_seen_at, AUDIT_COMPACTION_BATCH) as AuditRow[];
      if (rows.length === 0) {
        return {
          status: 'complete',
          cursor: { kind: 'time', last_seen_at },
        };
      }

      const toDelete: string[] = [];
      let anchor: { recipe_id: string; recipe_hash: string; started_at: number } | null = null;

      for (const row of rows) {
        if (
          anchor &&
          anchor.recipe_id === row.recipe_id &&
          anchor.recipe_hash === row.recipe_hash &&
          row.started_at - anchor.started_at <= AUDIT_COMPACTION_WINDOW_MS
        ) {
          toDelete.push(row.key);
        } else {
          anchor = {
            recipe_id: row.recipe_id,
            recipe_hash: row.recipe_hash,
            started_at: row.started_at,
          };
        }
        if (row.started_at > last_seen_at) last_seen_at = row.started_at;
      }

      if (toDelete.length > 0) {
        const tx = ctx.db.transaction((keys: readonly string[]) => {
          for (const k of keys) deleteStmt.run(k);
        });
        tx(toDelete);
        total_deleted += toDelete.length;
      }

      if (rows.length < AUDIT_COMPACTION_BATCH) {
        return {
          status: 'complete',
          cursor: { kind: 'time', last_seen_at },
        };
      }
      // Otherwise keep iterating against the next page.
    }
  },
};
