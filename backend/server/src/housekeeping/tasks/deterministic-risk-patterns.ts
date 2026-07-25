/** D-123 Phase 3 — `deterministic-risk-patterns` housekeeping task.
 *
 *  Walks `audit_entries` rows with `success=false` and groups by
 *  `recipe_id` over a rolling 24-hour window. When a recipe clears
 *  `RISK_PATTERN_FAILURE_THRESHOLD`, the task upserts one
 *  `runtime_risk` annotation against the recipe — surfaces in the
 *  Recipes tab as a yellow indicator without blocking execution
 *  (the existing `auto-run` circuit-breaker handles outright
 *  disable; this is the softer "you should look at this" signal).
 *
 *  Schema-fit deviation from spec §3.4 (handover note 2026-04-29):
 *  the spec text references `data_memory` rows by
 *  `action='recipe_failed'`. The actual `AuditEntry` shape carries
 *  `success: boolean` instead of an `action` field with that
 *  string value (`packages/storage/src/audit.ts`); the schema-fit
 *  filter is `success = 0` against `audit_entries`.
 *
 *  Cursor: `{ kind: 'complete' }` — every step re-aggregates the
 *  rolling 24h window; a per-row cursor would just produce stale
 *  state because the window slides forward each cycle.
 *
 *  `onInvalidate` fires on `recipe_upgrade` — when the user
 *  publishes a new recipe version, immediately drop any existing
 *  risk annotation for that recipe (the next cycle re-evaluates
 *  with whatever failure activity has happened since the upgrade).
 *  Without this hook, a user fixing a flagged recipe would still
 *  see the warning until the rolling window aged the failures out.
 *
 *  Spec: D-123 §3.4. */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingInvalidateHint,
  HousekeepingTaskInstance,
} from '../registry.js';

/** Rolling window the failure aggregation considers. 24 hours
 *  matches the spec's "5+ failures in 24 hours" example and gives
 *  the auto-run circuit-breaker (which auto-disables at 3
 *  consecutive failures) time to settle before this softer signal
 *  surfaces. */
export const RISK_PATTERN_WINDOW_MS = 24 * 60 * 60_000;

/** Per-recipe failure count required before the task emits a risk
 *  annotation. Five exceeds the auto-run circuit-breaker's
 *  3-failure auto-disable so the soft warning only fires when the
 *  user has unblocked a recipe but it keeps failing. */
export const RISK_PATTERN_FAILURE_THRESHOLD = 5;

export const RISK_PATTERN_AUTHORED_BY =
  'system.housekeeping.deterministic-risk-patterns';

/** Annotation key on the recipe; consumers read via
 *  `annotation-list` filtered to this key. */
export const RISK_PATTERN_ANNOTATION_KEY = 'runtime_risk';

/** Target collection used on the annotation row. The recipe is
 *  not a warehouse-collection record per se, but the annotation
 *  store accepts arbitrary `target_collection` strings — the
 *  Recipes UI reads the annotations for `'recipe'` + `target_id`
 *  ID match. */
export const RISK_PATTERN_TARGET_COLLECTION = 'recipe';

interface FailureAggregateRow {
  recipe_id: string;
  c: number;
}

const annotationTableExists = (ctx: HousekeepingContext): boolean =>
  (
    ctx.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='annotation'`,
      )
      .get() as { name: string } | undefined
  )?.name === 'annotation';

const auditTableExists = (ctx: HousekeepingContext): boolean =>
  (
    ctx.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='audit_entries'`,
      )
      .get() as { name: string } | undefined
  )?.name === 'audit_entries';

const riskAnnotationId = (recipe_id: string): string =>
  `hk-risk-patterns::${recipe_id}`;

export const deterministicRiskPatternsTask: HousekeepingTaskInstance = {
  meta: {
    id: 'deterministic-risk-patterns',
    description:
      'Flag recipes with elevated failure counts in the rolling 24h window — softer companion to the auto-run circuit-breaker.',
    interruptible: true,
    kind: 'core',
    tags: ['kind:core', 'domain:audit', 'surface:deterministic'],
  },

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    if (!auditTableExists(ctx) || !annotationTableExists(ctx)) {
      return { status: 'complete', cursor: { kind: 'complete' } };
    }

    const start = ctx.now();
    const window_start = start - RISK_PATTERN_WINDOW_MS;

    const rows = ctx.db
      .prepare(
        `SELECT json_extract(data, '$.recipe_id') AS recipe_id,
                COUNT(*) AS c
           FROM audit_entries
          WHERE json_extract(data, '$.started_at') >= ?
            AND json_extract(data, '$.commit_status') = 'failed'
          GROUP BY json_extract(data, '$.recipe_id')
         HAVING c >= ?
          ORDER BY recipe_id ASC`,
      )
      .all(window_start, RISK_PATTERN_FAILURE_THRESHOLD) as FailureAggregateRow[];

    const flaggedRecipeIds = new Set(rows.map((r) => r.recipe_id));

    const upsertStmt = ctx.db.prepare(`
      INSERT INTO annotation (
        id, target_collection, target_id, key,
        value_inline, blob_hash, size_bytes,
        authored_by_recipe_id, source_record_hash, recipe_hash, model_used,
        authored_at, event_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        value_inline = excluded.value_inline,
        size_bytes   = excluded.size_bytes,
        authored_at  = excluded.authored_at,
        source_record_hash = excluded.source_record_hash
    `);

    const tx = ctx.db.transaction((aggregate: readonly FailureAggregateRow[]) => {
      for (const row of aggregate) {
        const value = {
          pattern: 'runtime_risk',
          failure_count: row.c,
          window_hours: 24,
          computed_at: ctx.now(),
        };
        const value_inline = JSON.stringify(value);
        const size_bytes = Buffer.byteLength(value_inline, 'utf8');
        upsertStmt.run(
          riskAnnotationId(row.recipe_id),
          RISK_PATTERN_TARGET_COLLECTION,
          row.recipe_id,
          RISK_PATTERN_ANNOTATION_KEY,
          value_inline,
          size_bytes,
          RISK_PATTERN_AUTHORED_BY,
          `${row.recipe_id}|${row.c}`,
          RISK_PATTERN_AUTHORED_BY,
          ctx.now(),
        );
      }

      // Drop annotations whose recipes are no longer above
      // threshold — the rolling window has aged their failures
      // out, or a recipe upgrade quieted them. Restricting the
      // delete to our own `authored_by_recipe_id` stamp keeps
      // user-emitted `runtime_risk` annotations (recipe authors
      // hand-flagging their own recipes) untouched.
      if (flaggedRecipeIds.size === 0) {
        ctx.db
          .prepare(
            `DELETE FROM annotation
              WHERE authored_by_recipe_id = ?
                AND key = ?`,
          )
          .run(RISK_PATTERN_AUTHORED_BY, RISK_PATTERN_ANNOTATION_KEY);
      } else {
        const placeholders = [...flaggedRecipeIds].map(() => '?').join(',');
        ctx.db
          .prepare(
            `DELETE FROM annotation
              WHERE authored_by_recipe_id = ?
                AND key = ?
                AND target_id NOT IN (${placeholders})`,
          )
          .run(
            RISK_PATTERN_AUTHORED_BY,
            RISK_PATTERN_ANNOTATION_KEY,
            ...flaggedRecipeIds,
          );
      }
    });

    tx(rows);

    if (ctx.now() - start >= budget_ms) {
      return {
        status: 'yield',
        reason: 'budget_exhausted',
        cursor: { kind: 'complete' },
      };
    }
    return { status: 'complete', cursor: { kind: 'complete' } };
  },

  onInvalidate(ctx: HousekeepingContext, hint: HousekeepingInvalidateHint): void {
    // Only the recipe-upgrade case is meaningful — source
    // mutations on warehouse records don't shift recipe risk;
    // config changes ride the cycle interval.
    if (hint.reason !== 'recipe_upgrade') return;
    if (!hint.source_id) return;
    if (!annotationTableExists(ctx)) return;
    ctx.db
      .prepare(
        `DELETE FROM annotation
          WHERE authored_by_recipe_id = ?
            AND key = ?
            AND target_id = ?`,
      )
      .run(
        RISK_PATTERN_AUTHORED_BY,
        RISK_PATTERN_ANNOTATION_KEY,
        hint.source_id,
      );
  },
};

export const deterministicRiskAnnotationId = riskAnnotationId;
