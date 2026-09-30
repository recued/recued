/** D-115/D-116 — Auto-disabled summarizer.
 *
 *  Pure roster→summary projection used by every kill-switch surface
 *  (extension sidebar banner, options-page list, server CLI status,
 *  server `/status` HTML mirror). The renderer functions live next
 *  to their respective surfaces — only the data shape lives here.
 *
 *  Each surface supplies its own:
 *    - `roster` source — extension reads `AutoRunScheduler.roster`,
 *      server reads `ServerAutoRunHandle.roster`.
 *    - `lookupName` — install registry on the extension, recipe-store
 *      `meta.name` on the server.
 *    - `lookupFailureReason` — last audit row on the extension,
 *      `CircuitBreakerStore.get(id).last_failure_reason` on the server.
 */

/** Minimal roster-entry shape the summarizer consumes. `AutoRunEntry`
 *  from `./auto-run.ts` is a structural superset; explicit `Like`
 *  alias keeps callers (esp. the server, which projects through its
 *  own SQLite schema) decoupled from full `AutoRunEntry`. */
export interface AutoRunEntryLike {
  recipe_id: string;
  /** D-319 — the dish whose timer this is (the server keys its breaker by it). */
  dish_id?: string;
  publisher_id: string;
  auto_disabled: boolean;
  consecutive_failures: number;
  process_id: string;
  last_finished_at?: number;
}

export interface AutoDisabledSummary {
  recipe_id: string;
  publisher_id: string;
  /** Display name resolved via `lookupName`. Falls back to `recipe_id`
   *  when the lookup returns null (e.g. recipe uninstalled but circuit
   *  state still hydrated). */
  name: string;
  consecutive_failures: number;
  /** Last audit row's process_id — opens the audit page filtered to
   *  that id. Null when the circuit broke from a non-persisted run. */
  last_process_id: string | null;
  last_finished_at: number | null;
  /** Most recent failure reason. Optional — renderers fall back to
   *  generic "stopped" copy when absent. */
  last_failure_reason?: string;
}

export interface SummarizeInput {
  roster: Iterable<AutoRunEntryLike>;
  /** Display-name lookup — return null when the recipe isn't known
   *  to the caller's registry. */
  lookupName?: (recipe_id: string) => string | null;
  /** Most recent failure reason for the given (recipe_id, process_id)
   *  pair — and, on the server, the dish whose timer it is (D-319).
   *  Optional; absent means "no recorded reason". */
  lookupFailureReason?: (recipe_id: string, process_id: string, dish_id?: string) => string | undefined;
}

/** Project an iterable of roster entries into UI-friendly summaries.
 *  Pure — no side effects, no I/O. Stable-ordered by `recipe_id` so
 *  every surface renders deterministically across ticks. */
export const summarizeAutoDisabled = (input: SummarizeInput): AutoDisabledSummary[] => {
  const out: AutoDisabledSummary[] = [];
  for (const entry of input.roster) {
    if (!entry.auto_disabled) continue;
    out.push({
      recipe_id: entry.recipe_id,
      publisher_id: entry.publisher_id,
      name: input.lookupName?.(entry.recipe_id) ?? entry.recipe_id,
      consecutive_failures: entry.consecutive_failures,
      last_process_id: entry.process_id,
      last_finished_at: entry.last_finished_at ?? null,
      last_failure_reason: input.lookupFailureReason?.(entry.recipe_id, entry.process_id, entry.dish_id),
    });
  }
  out.sort((a, b) => a.recipe_id.localeCompare(b.recipe_id));
  return out;
};
