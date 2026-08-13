/** D-131 A.19 — `connection_last_used_pattern` enrichment producer.
 *
 *  Second connection-scope housekeeping producer. Aggregates audit
 *  activities for each enrolled connection record into a per-record
 *  Shape A row carrying total call count, last-used timestamp,
 *  per-recipe usage breakout, distinct-recipe count, unattributed
 *  (direct-rpc) count, and a 24-element UTC hourly histogram.
 *
 *  Surfaces inline on Settings → Connections so the user can spot
 *  idle connections (last used 32 days ago → suggest retiring) and
 *  understand which recipes drive each connection's traffic.
 *
 *  Standalone `HousekeepingTaskInstance` (matches `connectionHealth
 *  TrendTask` precedent) — same multi-scope-per-record reason: one
 *  topic spans three scopes (`connection.api` / `connection.mcp` /
 *  `connection.notification`), and the per-record harness ties one
 *  task to a single `source_scope`. One standalone task iterates
 *  every kind in a single cycle, emits one Shape A row per `(kind,
 *  name)`, and sweeps any rows whose connection records no longer
 *  exist.
 *
 *  Algorithm:
 *
 *    1. **Connection scan.** `scanEnrolledConnections` from the shared
 *       `_connection-records.ts` — `SELECT kind, name FROM connections`,
 *       capped at `MAX_CONNECTIONS_SCANNED`.
 *
 *    2. **Per-connection audit aggregation.** `collectConnection
 *       Activities` from the shared `_audit-activities.ts` — pre-narrows
 *       on `(action, target, timestamp >= cutoff)` and JSON-parses each
 *       row's detail blob into `ParsedConnectionAuditRow`. The producer
 *       reads `ts` + `recipe_id` from each row.
 *
 *    3. **Stats.** Total call count; most-recent ts (`last_used_at`);
 *       per-recipe bucket aggregating `call_count` + per-recipe
 *       `last_used_at`; unattributed count for rows whose detail had
 *       no `recipe_id`; UTC hourly histogram (24 buckets).
 *
 *    4. **Recipes array.** Sorted by `call_count` desc, `recipe_id`
 *       asc on ties; capped at `MAX_RECIPES_IN_BREAKOUT` to bound the
 *       row size against pathological callers. The full distinct count
 *       lives in `distinct_recipes` so the truncation is explicit.
 *
 *    5. **Emit.** Always write a row even when `call_count = 0` so
 *       recipes have a uniform read surface for "this connection
 *       hasn't been used" inferences (mirrors A.18's always-emit policy).
 *
 *    6. **Sweep.** Delete rows whose `(scope, target_id)` doesn't
 *       appear in the fresh-connections set (record was un-enrolled).
 *       Same orphan-cleanup-by-sweep pattern A.18 uses (cascade engine
 *       has no source-delete hook for connection records).
 *
 *  Window: `WINDOW_MS = 30d`. Wider than A.18's 7d because the user
 *  signals this producer surfaces (idle-connection retirement, hourly
 *  cadence) need a meaningful sample. A connection used twice a week
 *  has 2 calls in a 7d window — too sparse for an hourly histogram.
 *  30d gives 8-12 calls per workday connection, enough to see weekday
 *  patterns and confidently mark a connection idle (a week-long quiet
 *  period is plausibly vacation; a month-long quiet period suggests
 *  retirement). The registry's `recompute_cadence: '24h'` is orthogonal
 *  — cadence is "how often to recompute", window is "over what data
 *  each computation looks at".
 *
 *  Token cost: 0. Pure SQL aggregation + array sort. Idle-eligible by
 *  virtue of `is_ai_surface: false` + the registry's resolver returning
 *  `'auto'` for non-AI topics.
 *
 *  Spec: internal design notes line 59 +
 *        `ENRICHMENT_REGISTRY.connection_last_used_pattern`. */

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type ConnectionLastUsedPatternRecipeBreakout,
  type ConnectionLastUsedPatternValue,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';
import {
  collectConnectionActivities,
  type ParsedConnectionAuditRow,
} from './_audit-activities.js';
import {
  composeConnectionFreshKey,
  KIND_FOR_CONNECTION_SCOPE,
  scanEnrolledConnections,
  SCOPE_FOR_CONNECTION_KIND,
} from './_connection-records.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Rolling window for the aggregation. 30 days — the hourly histogram
 *  + idle-detection signals need a meaningful sample. A connection
 *  used twice a week has 2 calls in a 7d window (too sparse for a
 *  histogram); 30d gives 8-12 calls per workday connection, enough to
 *  see weekday patterns + confidently mark a connection idle. */
export const CONNECTION_LAST_USED_PATTERN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Cap on the recipes-array breakout — bounds the row size against a
 *  pathological caller that wires a connection into many recipes. The
 *  full distinct count lives on `distinct_recipes` so truncation is
 *  explicit on the read side. 10 recipes per connection covers the
 *  vast majority of users; surfacing the top-10 plus a numeric "and N
 *  more" via `distinct_recipes` is the right read shape for the UI. */
export const MAX_RECIPES_IN_BREAKOUT = 10;

/** Per-cycle token estimate for the Run-Now cost preview. Pure SQL +
 *  arithmetic; no LLM, no embeddings. Idle-eligible by construction. */
export const CONNECTION_LAST_USED_PATTERN_TOKEN_ESTIMATE = 0;

/** Authored-by stamp for the producer's writes. Matches the
 *  `system.housekeeping.<topic>` convention every other harness-driven
 *  producer follows; surfaces in the Memory tab as the row attribution. */
export const CONNECTION_LAST_USED_PATTERN_AUTHORED_BY =
  'system.housekeeping.connection_last_used_pattern';

/** Topic key for this producer's emitted rows. */
export const CONNECTION_LAST_USED_PATTERN_TOPIC: EnrichmentTopic =
  'connection_last_used_pattern';

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Build the empty 24-element histogram. Exported so callers / tests
 *  can compare against it without re-deriving. */
export const emptyHourHistogram = (): number[] =>
  Array.from({ length: 24 }, () => 0);

/** Fold a parsed-row batch into a `ConnectionLastUsedPatternValue`.
 *  Pure function — exposed so unit tests can drive it with synthetic
 *  rows without spinning up the audit table. Always returns a value;
 *  an empty input produces the zero-call shape (`call_count: 0`,
 *  `last_used_at: null`, empty arrays).
 *
 *  Contract: sum of `recipes[].call_count` (after un-truncation) plus
 *  `unattributed_call_count` equals `call_count`. Tests pin this. */
export const computeLastUsedPatternValue = (
  rows: ReadonlyArray<ParsedConnectionAuditRow>,
  now: number,
  window_ms: number = CONNECTION_LAST_USED_PATTERN_WINDOW_MS,
  max_recipes: number = MAX_RECIPES_IN_BREAKOUT,
): ConnectionLastUsedPatternValue => {
  const call_count = rows.length;
  let last_used_at: number | null = null;
  let unattributed_call_count = 0;
  const hour_histogram = emptyHourHistogram();
  const recipeMap = new Map<string, ConnectionLastUsedPatternRecipeBreakout>();

  for (const row of rows) {
    if (last_used_at === null || row.ts > last_used_at) {
      last_used_at = row.ts;
    }
    const hour = new Date(row.ts).getUTCHours();
    if (hour >= 0 && hour < 24) {
      hour_histogram[hour] = (hour_histogram[hour] ?? 0) + 1;
    }

    if (row.recipe_id === null) {
      unattributed_call_count += 1;
      continue;
    }
    const existing = recipeMap.get(row.recipe_id);
    if (existing === undefined) {
      recipeMap.set(row.recipe_id, {
        recipe_id: row.recipe_id,
        call_count: 1,
        last_used_at: row.ts,
      });
    } else {
      existing.call_count += 1;
      if (row.ts > existing.last_used_at) existing.last_used_at = row.ts;
    }
  }

  const recipes = Array.from(recipeMap.values())
    .sort((a, b) => {
      if (b.call_count !== a.call_count) return b.call_count - a.call_count;
      return a.recipe_id.localeCompare(b.recipe_id);
    })
    .slice(0, max_recipes);

  return {
    call_count,
    last_used_at,
    recipes,
    distinct_recipes: recipeMap.size,
    unattributed_call_count,
    hour_histogram,
    window_ms,
    computed_at: now,
  };
};

/** Sweep rows for connection records that no longer exist in the
 *  `connections` table. Walks every existing topic row across all
 *  three connection scopes; deletes any whose `(scope, target_id)`
 *  isn't in the fresh-connections set.
 *
 *  Same orphan-cleanup-by-sweep pattern A.18 uses — cascade engine
 *  has no source-delete hook for connection records (the
 *  `aggregates_from` source is `audit`, not the source connection
 *  record), so the manual sweep is the sole orphan-cleanup path. */
export const sweepStaleLastUsedPatternRows = (
  ctx: HousekeepingContext,
  freshKeys: ReadonlySet<string>,
): { deleted: number } => {
  const existing = ctx.enrichmentStore.list({
    topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
    fresh_only: false,
    limit: 1000,
  });
  let deleted = 0;
  for (const row of existing) {
    if (row.scope == null || row.target_id == null) continue;
    if (KIND_FOR_CONNECTION_SCOPE[row.scope] === undefined) continue;
    const key = composeConnectionFreshKey(row.scope, row.target_id);
    if (freshKeys.has(key)) continue;
    if (ctx.enrichmentStore.deleteById(row._id)) deleted += 1;
  }
  return { deleted };
};

// ────────────────────────────────────────────────────────────────
// Cycle
// ────────────────────────────────────────────────────────────────

/** One-shot scan-and-emit cycle. Exported for direct test access
 *  without the task wrapper. Returns `{ produced, swept }` for
 *  caller-side assertions on cycle output. */
export const runConnectionLastUsedPatternCycle = (
  ctx: HousekeepingContext,
): { produced: number; swept: number } => {
  const now = ctx.now();
  const cutoff = now - CONNECTION_LAST_USED_PATTERN_WINDOW_MS;
  const connections = scanEnrolledConnections(ctx);
  if (connections.length === 0) {
    const sweep = sweepStaleLastUsedPatternRows(ctx, new Set());
    return { produced: 0, swept: sweep.deleted };
  }

  const freshKeys = new Set<string>();
  let produced = 0;
  for (const conn of connections) {
    const scope = SCOPE_FOR_CONNECTION_KIND[conn.kind];
    const rows = collectConnectionActivities(ctx, conn.kind, conn.name, cutoff);
    const value = computeLastUsedPatternValue(rows, now);
    ctx.enrichmentStore.upsert({
      topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
      scope,
      target_id: conn.name,
      value,
      authored_by: CONNECTION_LAST_USED_PATTERN_AUTHORED_BY,
      event_at: now,
    });
    freshKeys.add(composeConnectionFreshKey(scope, conn.name));
    produced += 1;
  }

  const sweep = sweepStaleLastUsedPatternRows(ctx, freshKeys);
  return { produced, swept: sweep.deleted };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const connectionLastUsedPatternTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.connection_last_used_pattern',
    description:
      'Per-connection cadence rollup — total calls, last-used ts, per-recipe breakout, hourly histogram.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.connection_last_used_pattern,
      isAiSurface: false,
    }),
  },
  topic: CONNECTION_LAST_USED_PATTERN_TOPIC,
  is_ai_surface: false,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    runConnectionLastUsedPatternCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

/** Per-cycle token estimate for the Run-Now cost preview. Exposed
 *  separately from the task instance so the rpc handler that builds
 *  the preview can call it without instantiating a step. Always 0
 *  (deterministic). */
export const connectionLastUsedPatternTokenEstimate = (): number =>
  CONNECTION_LAST_USED_PATTERN_TOKEN_ESTIMATE;

/** Scope-of-read declaration surfaced in the Run-Now scope dialog +
 *  detail drawer. The producer reads from the connections table (one
 *  row per `(kind, name)`) plus the audit activity log filtered by
 *  `connection_<kind>` actions. Same shape A.18 declares — the two
 *  producers cover identical scope-of-read but extract different
 *  signals from it. */
export const connectionLastUsedPatternScopeReadDeclaration = [
  {
    collection: 'connection',
    sample_field_paths: ['kind', 'name'],
  },
  {
    collection: 'data.audit',
    sample_field_paths: [
      'action',
      'target',
      'timestamp',
      'detail.recipe_id',
    ],
  },
] as const;
