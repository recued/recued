/** D-115 Phase 6 — recipe-watcher handler.
 *
 *  Scans the local audit log for runs of a target `recipe_id` whose
 *  `finished_at` is strictly later than a caller-supplied cursor
 *  (`since_ms`). Three kinds:
 *
 *    - `succeeded_since` — runs with `commit_status === 'succeeded'`
 *      (post-D-153 P1 lifecycle enum; replaces the legacy
 *      `success: true` predicate).
 *    - `failed_since`    — runs with `commit_status === 'failed'`.
 *    - `stopped_since`   — user-cancelled runs (deferred; audit schema
 *      does not tag user-stop as a distinct outcome today; throws
 *      TRANSFORM_INVALID_INPUT with an explicit message).
 *
 *  Cursor advancement is the recipe author's job: the returned
 *  `runs[]` carries `finished_at` for each matching row so a
 *  downstream `shared-write` step can stamp the new cursor.
 *
 *  Returns a compact `RecipeWatcherRunSummary` per match — run_id +
 *  timing + trigger_source — intentionally NOT the full `AuditEntry`.
 *  `config_snapshot`, `steps`, and `errors` are excluded so a watcher
 *  tick doesn't fan potentially-sensitive payload snippets into a
 *  downstream recipe's execution context.
 *
 *  Lives in `@recued/ingredients` (not `backend/server/`) so the
 *  extension's local watcher dispatcher can read its own audit log
 *  via the same evaluator — D-115 Phase 6D. */

import type { AuditLogStore } from '@recued/storage';

import { IngredientError } from '../types.js';

export type RecipeWatcherKind =
  | 'succeeded_since'
  | 'failed_since'
  | 'stopped_since';

export interface RecipeWatcherArgs {
  kind: RecipeWatcherKind;
  recipe_id: string;
  since_ms: number;
}

export interface RecipeWatcherRunSummary {
  run_id: string;
  recipe_id: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  trigger_source: string | null;
}

export interface RecipeWatcherOutput {
  should_run: boolean;
  runs: RecipeWatcherRunSummary[];
  [field: string]: unknown;
}

export interface RecipeWatcherDeps {
  auditLog: AuditLogStore;
}

const VALID_KINDS: ReadonlySet<RecipeWatcherKind> = new Set([
  'succeeded_since',
  'failed_since',
  'stopped_since',
]);

const DEFAULT_LIMIT = 1000;

const validate = (args: RecipeWatcherArgs): void => {
  if (typeof args.kind !== 'string' || !VALID_KINDS.has(args.kind as RecipeWatcherKind)) {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'recipe-watcher: kind must be one of succeeded_since / failed_since / stopped_since',
      { got: args.kind },
    );
  }
  if (args.kind === 'stopped_since') {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'recipe-watcher: stopped_since is not supported yet — the audit schema does not record user-stop as a distinct outcome. Use failed_since or track stops via a shared.* cursor maintained by the stop action.',
      { kind: args.kind },
    );
  }
  if (typeof args.recipe_id !== 'string' || args.recipe_id.length === 0) {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'recipe-watcher: recipe_id must be a non-empty string',
      { got: args.recipe_id },
    );
  }
  if (
    typeof args.since_ms !== 'number' ||
    !Number.isFinite(args.since_ms) ||
    args.since_ms < 0
  ) {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'recipe-watcher: since_ms must be a finite non-negative number (epoch ms)',
      { got: args.since_ms },
    );
  }
};

export const evaluateRecipeWatcher = async (
  args: RecipeWatcherArgs,
  deps: RecipeWatcherDeps,
): Promise<RecipeWatcherOutput> => {
  validate(args);

  const entries = await deps.auditLog.listByRecipe(args.recipe_id, DEFAULT_LIMIT);
  const wantStatus: 'succeeded' | 'failed' =
    args.kind === 'succeeded_since' ? 'succeeded' : 'failed';

  const matches = entries.filter(
    (e) =>
      e.commit_status === wantStatus &&
      e.finished_at > args.since_ms,
  );

  const runs: RecipeWatcherRunSummary[] = matches.map((e) => ({
    run_id: e.run_id,
    recipe_id: e.recipe_id,
    started_at: e.started_at,
    finished_at: e.finished_at,
    duration_ms: e.duration_ms,
    trigger_source: e.trigger_source,
  }));

  // Sort ascending by finished_at so the consumer's last-seen cursor
  // advances monotonically. listByRecipe returns newest-first.
  runs.sort((a, b) => a.finished_at - b.finished_at);

  return {
    should_run: runs.length > 0,
    runs,
  };
};
