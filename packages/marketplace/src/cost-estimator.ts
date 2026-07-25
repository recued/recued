/** D-122 Phase 4 — bulk-pack cost estimator (post-runs_on rip).
 *
 *  Pure computation. Given:
 *    - The recipes resolved from a `BulkPackManifest` plus per-recipe
 *      cost hints the caller supplies (expected daily fire count
 *      derived from a warehouse query + per-fire token estimate from
 *      manifest metadata or a heuristic).
 *    - The user's free-pool daily token budget.
 *
 *  Produce a per-recipe breakdown plus pack-level totals + an optional
 *  BYOK $/day estimate.
 *
 *  This is *planning* output. Per `feedback_no_per_recipe_budgets` and
 *  D-094, the runtime never enforces these numbers — they're a forecast
 *  the install dialog renders so the user can decide. Free-pool quota
 *  enforcement happens at the LLM dispatch layer (D-079), not here.
 *
 *  The pre-rip estimator decomposed costs by hot/warm/cold/lazy tier
 *  because the engine ran a tiered backfill scheduler. After the rip,
 *  recipes are reactive-only; there is no tier and no backfill walk.
 *  Costs are per-recipe daily-fire estimates summed into a flat total.
 */

import type { ResolvedPackRecipe } from './bulk-pack-resolver.js';

/** Per-recipe input the caller assembles. The caller queries the
 *  warehouse for whatever the recipe's trigger anchors against (e.g.
 *  upcoming calendar events for time-relative-watcher recipes; recent
 *  mail for `mail-watcher` recipes) and produces a daily-fire estimate
 *  from that. The per-fire token estimate comes from a manifest-level
 *  hint or a default. */
export interface PerRecipeCostInput {
  slug: string;
  /** Caller-estimated daily fire count for this recipe. */
  daily_fires: number;
  /** Caller-provided per-fire token estimate (manifest hint or
   *  default). */
  per_fire_tokens: number;
}

/** Inputs to the cost estimator. */
export interface CostEstimateInput {
  /** Resolved pack — entries with `failure` are skipped. */
  resolved: ResolvedPackRecipe[];
  /** Per-recipe cost hints, keyed by recipe slug. Recipes whose slug
   *  isn't present here contribute zero to the estimate. */
  per_recipe: Record<string, PerRecipeCostInput>;
  /** Per-day free-pool token budget (sum of `daily_cap_tokens` across
   *  the user's enabled API entries). The estimator computes the
   *  pack's share of this budget so the dialog can render headroom. */
  free_pool_tokens_per_day: number;
  /** USD per million BYOK tokens (e.g., $5 for typical Anthropic
   *  Sonnet). When present, the BYOK $/day estimate lights up in the
   *  dialog. */
  byok_dollars_per_mtoken?: number;
}

/** Per-recipe cost row. */
export interface PerRecipeCost {
  slug: string;
  daily_fires: number;
  daily_tokens: number;
}

/** Cost-estimate output — flat per-recipe rows plus pack totals. */
export interface CostEstimate {
  /** One row per resolved recipe (failures + recipes missing from
   *  `per_recipe` excluded). */
  per_recipe: PerRecipeCost[];
  /** Sum of `daily_fires` across the pack. */
  total_daily_fires: number;
  /** Sum of `daily_tokens` across the pack. */
  total_daily_tokens: number;
  /** Pack's share of the free-pool daily budget as a percentage
   *  (0..>100). `null` when `free_pool_tokens_per_day` is 0 (free
   *  pool not configured — the dialog shows a "free pool not
   *  configured" badge in that case). */
  free_pool_consumption_pct: number | null;
  /** Estimated BYOK cost per day in dollars when
   *  `byok_dollars_per_mtoken` was provided; otherwise `null`. */
  byok_dollars_per_day: number | null;
}

/** Compute the cost estimate. Pure — no IO, no time, no globals. */
export const estimatePackCost = (input: CostEstimateInput): CostEstimate => {
  const per_recipe: PerRecipeCost[] = [];
  for (const r of input.resolved) {
    if (r.failure != null || r.recipe == null) continue;
    const hint = input.per_recipe[r.recipe.recipe_id];
    if (hint == null) continue;
    per_recipe.push({
      slug: hint.slug,
      daily_fires: hint.daily_fires,
      daily_tokens: hint.daily_fires * hint.per_fire_tokens,
    });
  }

  const total_daily_fires = per_recipe.reduce((acc, r) => acc + r.daily_fires, 0);
  const total_daily_tokens = per_recipe.reduce((acc, r) => acc + r.daily_tokens, 0);
  const free_pool_consumption_pct = input.free_pool_tokens_per_day > 0
    ? (total_daily_tokens / input.free_pool_tokens_per_day) * 100
    : null;
  const byok_dollars_per_day = input.byok_dollars_per_mtoken == null
    ? null
    : (total_daily_tokens / 1_000_000) * input.byok_dollars_per_mtoken;

  return {
    per_recipe,
    total_daily_fires,
    total_daily_tokens,
    free_pool_consumption_pct,
    byok_dollars_per_day,
  };
};
