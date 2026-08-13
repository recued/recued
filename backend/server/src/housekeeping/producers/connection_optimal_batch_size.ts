/** D-131 A.20 — `connection_optimal_batch_size` enrichment producer.
 *
 *  Third + final connection-scope housekeeping producer; closes the
 *  trio (A.18 health + A.19 last-used + A.20 batch size) and Phase A.
 *
 *  Same standalone-task multi-scope shape A.18 + A.19 use, with one
 *  twist: the registry's `valid_scopes: ['connection.api',
 *  'connection.mcp']` excludes `notification` (notification connections
 *  are fire-and-forget — no batching to tune). The cycle iterates only
 *  the api + mcp kinds; sweeps any `connection.notification` rows that
 *  somehow leaked in (defensive against historical residue).
 *
 *  Aggregates audit activities per `(kind, name)` over a 7d window
 *  and infers a recommended payload size in bytes from observed
 *  call data. The signal is inherently inferential — audit rows
 *  carry per-call `bytes_out` + `duration_ms` + `status`, not a
 *  literal "batch size". The producer infers the recommendation as
 *  the p75 payload of *successful + sub-target-duration* calls.
 *
 *  Algorithm:
 *
 *    1. **Connection scan.** `scanEnrolledConnections` from
 *       `_connection-records.ts`; filter the result to api + mcp kinds.
 *
 *    2. **Per-connection audit aggregation.** `collectConnection
 *       Activities` from `_audit-activities.ts`. The producer reads
 *       `ts` / `status` / `duration_ms` / `bytes_out` from each row.
 *
 *    3. **Stats.** Whole-window `median_duration_ms` (≥ p50 floor) +
 *       `p95_duration_ms` (≥ p95 floor); `median_payload_bytes` /
 *       `p95_payload_bytes` over rows that emitted `bytes_out`;
 *       `bytes_coverage` = bytes-emitting rows / total rows.
 *
 *    4. **Recommendation.** Filter to rows where `status = 'ok'` AND
 *       `duration_ms <= 2 * median_duration_ms` (proxy for "this call
 *       didn't tip over the rate limit / time out"). Take p75 of those
 *       rows' `bytes_out` as the recommended max payload bytes. Null
 *       when sample-of-safe-rows is below floor or median_duration_ms
 *       is null.
 *
 *    5. **Emit.** Always write a row (mirrors A.18 + A.19) so recipes
 *       have a uniform read surface for "no signal yet" cases.
 *
 *    6. **Sweep.** Delete rows whose `(scope, target_id)` doesn't
 *       appear in the fresh-connections set. Same orphan-cleanup
 *       pattern A.18 + A.19 use; cascade engine has no source-delete
 *       hook for connection records.
 *
 *  Window: `WINDOW_MS = 7d`. Matches `recompute_cadence: '7d'` from
 *  the registry — batch-size inference is a slow signal; daily
 *  recompute would just churn the row without adding signal. 7d
 *  smooths daily noise + gives enough samples on a moderately-used
 *  connection.
 *
 *  Token cost: 0. Pure SQL aggregation + sorted-array percentile.
 *  Idle-eligible by virtue of `is_ai_surface: false` + the registry's
 *  resolver returning `'auto'` for non-AI topics.
 *
 *  Spec: internal design notes line 60 +
 *        `ENRICHMENT_REGISTRY.connection_optimal_batch_size`. */

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type ConnectionKind,
  type ConnectionOptimalBatchSizeValue,
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
import { percentile } from './_stats.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Rolling window. 7d matches `recompute_cadence: '7d'` from the
 *  registry — batch-size inference is a slow signal; daily recompute
 *  would churn the row without adding signal. */
export const CONNECTION_OPTIMAL_BATCH_SIZE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Connection kinds this producer supports. Excludes `notification`
 *  — fire-and-forget connections have no meaningful batch-size signal.
 *  Mirrors the registry `valid_scopes` so the cycle filter and the
 *  registry stay in sync. */
export const SUPPORTED_KINDS: ReadonlyArray<ConnectionKind> = ['api', 'mcp'];

/** Minimum `sample_count` before any percentile reports a non-null
 *  value. Below 5 the percentile is essentially noise; recipes
 *  reading a 1-sample p50 would treat it as a real percentile. Same
 *  threshold A.18 uses for its p50. */
export const CONNECTION_OPTIMAL_BATCH_SIZE_P50_MIN_SAMPLE_COUNT = 5;

/** Minimum `sample_count` before p95 reports a non-null value. Same
 *  20-sample floor A.18 + `reply_patterns` use — matches mining-
 *  standard guidance for tail-quantile stability. */
export const CONNECTION_OPTIMAL_BATCH_SIZE_P95_MIN_SAMPLE_COUNT = 20;

/** Minimum count of safe-and-sized calls (status='ok' AND
 *  duration <= 2× median AND bytes_out emitted) before
 *  `recommended_max_payload_bytes` reports a non-null value. p75 of
 *  fewer than 5 samples is too noisy to drive recipe behaviour. */
export const CONNECTION_OPTIMAL_BATCH_SIZE_RECOMMENDATION_MIN_SAMPLE = 5;

/** Multiplier on the median duration that defines "fast enough" for
 *  the recommendation filter. 2× median catches the bulk of the
 *  distribution while excluding tail-latency outliers (slow calls
 *  often correlate with payloads that tipped a rate limit). */
export const CONNECTION_OPTIMAL_BATCH_SIZE_DURATION_BUDGET_MULT = 2;

/** Per-cycle token estimate for the Run-Now cost preview. Pure SQL +
 *  arithmetic; no LLM, no embeddings. Idle-eligible by construction. */
export const CONNECTION_OPTIMAL_BATCH_SIZE_TOKEN_ESTIMATE = 0;

/** Authored-by stamp for the producer's writes. */
export const CONNECTION_OPTIMAL_BATCH_SIZE_AUTHORED_BY =
  'system.housekeeping.connection_optimal_batch_size';

/** Topic key for this producer's emitted rows. */
export const CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC: EnrichmentTopic =
  'connection_optimal_batch_size';

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Fold a parsed-row batch into a `ConnectionOptimalBatchSizeValue`.
 *  Pure function — exposed so unit tests can drive it with synthetic
 *  rows without spinning up the audit table. Always returns a value;
 *  empty input produces the zero-shape (`sample_count: 0`, all
 *  percentiles null, `bytes_coverage: 0`).
 *
 *  Recommendation contract: `recommended_max_payload_bytes` is null
 *  when (a) sample_count is below the p50 floor, OR (b) the safe-and-
 *  sized subset is below the recommendation floor. Recipes can gate
 *  on `is_null` to skip low-confidence inferences. */
export const computeOptimalBatchSizeValue = (
  rows: ReadonlyArray<ParsedConnectionAuditRow>,
  now: number,
  window_ms: number = CONNECTION_OPTIMAL_BATCH_SIZE_WINDOW_MS,
): ConnectionOptimalBatchSizeValue => {
  const sample_count = rows.length;

  // Whole-window duration distribution.
  const allDurations = rows.map((r) => r.duration_ms).slice().sort((a, b) => a - b);
  const median_duration_ms =
    sample_count >= CONNECTION_OPTIMAL_BATCH_SIZE_P50_MIN_SAMPLE_COUNT
      ? percentile(allDurations, 0.5)
      : null;
  const p95_duration_ms =
    sample_count >= CONNECTION_OPTIMAL_BATCH_SIZE_P95_MIN_SAMPLE_COUNT
      ? percentile(allDurations, 0.95)
      : null;

  // Payload distribution (only over rows that emitted bytes_out).
  const bytesEmittedRows = rows.filter(
    (r): r is ParsedConnectionAuditRow & { bytes_out: number } =>
      r.bytes_out !== null,
  );
  const sortedBytes = bytesEmittedRows
    .map((r) => r.bytes_out)
    .slice()
    .sort((a, b) => a - b);
  const median_payload_bytes =
    bytesEmittedRows.length >= CONNECTION_OPTIMAL_BATCH_SIZE_P50_MIN_SAMPLE_COUNT
      ? percentile(sortedBytes, 0.5)
      : null;
  const p95_payload_bytes =
    bytesEmittedRows.length >= CONNECTION_OPTIMAL_BATCH_SIZE_P95_MIN_SAMPLE_COUNT
      ? percentile(sortedBytes, 0.95)
      : null;
  const bytes_coverage =
    sample_count > 0 ? bytesEmittedRows.length / sample_count : 0;

  // Recommendation: p75 of safe-and-sized calls. Requires both a
  // duration baseline (to define "fast enough") and a sample of
  // bytes-emitting successful calls within that budget.
  let recommended_max_payload_bytes: number | null = null;
  if (median_duration_ms !== null) {
    const budget =
      median_duration_ms * CONNECTION_OPTIMAL_BATCH_SIZE_DURATION_BUDGET_MULT;
    const safeSizedBytes = bytesEmittedRows
      .filter((r) => r.status === 'ok' && r.duration_ms <= budget)
      .map((r) => r.bytes_out)
      .slice()
      .sort((a, b) => a - b);
    if (
      safeSizedBytes.length >= CONNECTION_OPTIMAL_BATCH_SIZE_RECOMMENDATION_MIN_SAMPLE
    ) {
      recommended_max_payload_bytes = percentile(safeSizedBytes, 0.75);
    }
  }

  return {
    sample_count,
    median_duration_ms,
    p95_duration_ms,
    median_payload_bytes,
    p95_payload_bytes,
    recommended_max_payload_bytes,
    bytes_coverage,
    window_ms,
    computed_at: now,
  };
};

/** Sweep rows for connection records that no longer exist in the
 *  `connections` table OR whose scope is `connection.notification`
 *  (defensive — registry rejects new writes there, but this sweeps
 *  any historical residue). Same shape A.18 + A.19's sweeps use. */
export const sweepStaleOptimalBatchSizeRows = (
  ctx: HousekeepingContext,
  freshKeys: ReadonlySet<string>,
): { deleted: number } => {
  const existing = ctx.enrichmentStore.list({
    topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
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
export const runConnectionOptimalBatchSizeCycle = (
  ctx: HousekeepingContext,
): { produced: number; swept: number } => {
  const now = ctx.now();
  const cutoff = now - CONNECTION_OPTIMAL_BATCH_SIZE_WINDOW_MS;
  const supportedKinds: ReadonlySet<ConnectionKind> = new Set(SUPPORTED_KINDS);
  const connections = scanEnrolledConnections(ctx).filter((c) =>
    supportedKinds.has(c.kind),
  );
  if (connections.length === 0) {
    const sweep = sweepStaleOptimalBatchSizeRows(ctx, new Set());
    return { produced: 0, swept: sweep.deleted };
  }

  const freshKeys = new Set<string>();
  let produced = 0;
  for (const conn of connections) {
    const scope = SCOPE_FOR_CONNECTION_KIND[conn.kind];
    const rows = collectConnectionActivities(ctx, conn.kind, conn.name, cutoff);
    const value = computeOptimalBatchSizeValue(rows, now);
    ctx.enrichmentStore.upsert({
      topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
      scope,
      target_id: conn.name,
      value,
      authored_by: CONNECTION_OPTIMAL_BATCH_SIZE_AUTHORED_BY,
      event_at: now,
    });
    freshKeys.add(composeConnectionFreshKey(scope, conn.name));
    produced += 1;
  }

  const sweep = sweepStaleOptimalBatchSizeRows(ctx, freshKeys);
  return { produced, swept: sweep.deleted };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const connectionOptimalBatchSizeTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.connection_optimal_batch_size',
    description:
      'Per-connection inferred recommended max payload bytes — duration p50/p95 + payload p50/p95 + p75-of-safe-rows recommendation.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.connection_optimal_batch_size,
      isAiSurface: false,
    }),
  },
  topic: CONNECTION_OPTIMAL_BATCH_SIZE_TOPIC,
  is_ai_surface: false,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    runConnectionOptimalBatchSizeCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

/** Per-cycle token estimate for the Run-Now cost preview. Always 0
 *  (deterministic). */
export const connectionOptimalBatchSizeTokenEstimate = (): number =>
  CONNECTION_OPTIMAL_BATCH_SIZE_TOKEN_ESTIMATE;

/** Scope-of-read declaration surfaced in the Run-Now scope dialog +
 *  detail drawer. The producer reads from the connections table (one
 *  row per `(kind, name)`) plus the audit activity log filtered by
 *  `connection_<kind>` actions. Same scope-of-read shape A.18 / A.19
 *  use — the three connection-scope producers cover identical reads
 *  but extract different signals. */
export const connectionOptimalBatchSizeScopeReadDeclaration = [
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
      'detail.status',
      'detail.duration_ms',
      'detail.bytes_out',
    ],
  },
] as const;
