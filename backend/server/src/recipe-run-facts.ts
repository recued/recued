/** The small owner-facing receipt under a run's result — steps, items, provider
 *  calls, tokens, time — projected from the row that actually landed in the
 *  audit log. Shared by the `execute` rpc and `execution.get`, which hands a page
 *  the result of a held run once its approval let it finish. */

import type { RecipeRunFacts } from '@recued/contracts';
import type { AuditEntry } from '@recued/storage';

/** `total_usage` is intentionally optional on AuditEntry: an absent report can
 *  mean no AI call or telemetry eviction, so never invent a zero-cost claim. */
export const recipeRunFactsFromAuditEntry = (
  entry: AuditEntry,
): RecipeRunFacts | undefined => {
  if (entry.run_yield === undefined) return undefined;
  return {
    steps_run: entry.run_yield.steps_run,
    items_total: entry.run_yield.items_total,
    ...(typeof entry.run_yield.stopped_at === 'string'
      ? { stopped_at: entry.run_yield.stopped_at }
      : {}),
    ...(entry.total_usage !== undefined
      ? {
          provider_calls: entry.total_usage.provider_calls ?? 1,
          total_tokens: entry.total_usage.total_tokens,
        }
      : {}),
    duration_ms: entry.duration_ms,
  };
};
