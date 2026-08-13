/** D-131 A.18 — `connection_health_trend` enrichment producer.
 *
 *  First connection-scope housekeeping producer. Aggregates audit
 *  activities for each enrolled connection record into a per-record
 *  Shape A row carrying error rate, latency p50 / p95, and the most
 *  recent failure cause. Surfaces inline on Settings → Connections so a
 *  user can spot a flaky integration before a recipe fails on it.
 *
 *  Standalone `HousekeepingTaskInstance` (matches `organizationTask` /
 *  `semanticClusterTask` precedent) — the per-record harness ties one
 *  task to a single `source_scope`, but `connection_health_trend` spans
 *  three scopes (`connection.api` / `connection.mcp` /
 *  `connection.notification`) under one topic. One standalone task
 *  iterates every kind in a single cycle, emits one Shape A row per
 *  `(kind, name)` pair, and sweeps any rows whose connection records
 *  no longer exist.
 *
 *  Algorithm:
 *
 *    1. **Connection scan.** `SELECT kind, name FROM connections` —
 *       no SQL filter. Cap at `MAX_CONNECTIONS_SCANNED` (defensive;
 *       typical user has < 20 enrolled connections).
 *
 *    2. **Per-connection audit aggregation.** For each `(kind, name)`,
 *       query `audit_activities` for rows where
 *       `json_extract(data, '$.action') = 'connection_<kind>'` AND
 *       `json_extract(data, '$.target') = name` AND
 *       `json_extract(data, '$.timestamp') >= cutoff`. Each row's
 *       `data.detail` is the JSON-encoded `ConnectionAuditDetail`
 *       (`status` / `duration_ms` / `error?` / …); JSON-parse and fold.
 *
 *    3. **Stats.** `call_count`, `error_count`, `error_rate`, sorted
 *       latency samples → `p50` (≥ `P50_MIN_SAMPLE_COUNT` = 5) and
 *       `p95` (≥ `P95_MIN_SAMPLE_COUNT` = 20). Below-floor percentiles
 *       surface as `null` — the same null-or-finite contract
 *       `reply_patterns` uses so recipes can `is_null`-gate cleanly.
 *
 *    4. **Last failure.** Newest activity row with `status = 'error'`
 *       contributes `last_failure = { ts, error_code, error_message }`;
 *       null when no error in window.
 *
 *    5. **Emit.** Always write a row even when `call_count = 0` so
 *       recipes have a uniform read surface for "this connection
 *       hasn't been used" inferences.
 *
 *    6. **Sweep.** Delete rows whose `target_id` doesn't appear in the
 *       fresh-connections set (record was un-enrolled).
 *
 *  Window: `WINDOW_MS = 7d`. Wider than the `recompute_cadence: '24h'`
 *  in the registry — the cadence drives how often we recompute, the
 *  window decides what data each computation looks at. 7d smooths
 *  daily noise (an outage at 3am Tuesday isn't lost by Wednesday's
 *  pass) while still surfacing "started failing this week" signals.
 *  Same precedent the `reply_patterns` 30d window uses.
 *
 *  Token cost: 0. Pure SQL aggregation + sorted-array percentile.
 *  Idle-eligible by virtue of `is_ai_surface: false` + the registry's
 *  resolver returning `'auto'` for non-AI topics.
 *
 *  Spec: internal design notes line 58 +
 *        `ENRICHMENT_REGISTRY.connection_health_trend`. */

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type ConnectionHealthTrendValue,
  type ConnectionKind,
  type EnrichmentScope,
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
  MAX_CONNECTIONS_SCANNED as SHARED_MAX_CONNECTIONS_SCANNED,
  scanEnrolledConnections as scanEnrolledConnectionsShared,
  SCOPE_FOR_CONNECTION_KIND as SHARED_SCOPE_FOR_CONNECTION_KIND,
  type EnrolledConnection as SharedEnrolledConnection,
} from './_connection-records.js';
import { percentile as sharedPercentile } from './_stats.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Rolling window for the aggregation. 7 days smooths daily noise
 *  while keeping the signal recent enough to fire alerts within the
 *  same business week as the regression. Wider than the 24h
 *  `recompute_cadence` deliberately — cadence is "how often", window
 *  is "over what data". Same precedent `reply_patterns` uses with its
 *  30d window. */
export const CONNECTION_HEALTH_TREND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap on connections walked in one cycle. Re-exported from the
 *  shared `_connection-records.ts` so existing callers (tests, bin
 *  wiring) keep their import path; the value lives in one place now. */
export const MAX_CONNECTIONS_SCANNED = SHARED_MAX_CONNECTIONS_SCANNED;

/** Minimum sample count before `p50` reports a non-null value. p50
 *  with < 5 samples is essentially the median of toy data; recipes
 *  reading a 1-sample p50 would treat it as a real percentile. */
export const CONNECTION_HEALTH_TREND_P50_MIN_SAMPLE_COUNT = 5;

/** Minimum sample count before `p95` reports a non-null value. Same
 *  threshold `reply_patterns.P95_MIN_SAMPLE_COUNT` uses — the 20-sample
 *  floor matches mining-standard guidance for tail-quantile stability. */
export const CONNECTION_HEALTH_TREND_P95_MIN_SAMPLE_COUNT = 20;

/** Per-cycle token estimate for the Run-Now cost preview. Pure SQL +
 *  arithmetic; no LLM, no embeddings. Idle-eligible by construction. */
export const CONNECTION_HEALTH_TREND_TOKEN_ESTIMATE = 0;

/** Authored-by stamp for the producer's writes. Matches the
 *  `system.housekeeping.<topic>` convention every other harness-driven
 *  producer follows; surfaces in the Memory tab as the row attribution. */
export const CONNECTION_HEALTH_TREND_AUTHORED_BY =
  'system.housekeeping.connection_health_trend';

/** Topic key for this producer's emitted rows. */
export const CONNECTION_HEALTH_TREND_TOPIC: EnrichmentTopic = 'connection_health_trend';

/** Re-export of the shared `kind → scope` mapping. Existing callers
 *  (tests + bin) import from this module by historical name. */
export const SCOPE_FOR_CONNECTION_KIND: Record<ConnectionKind, EnrichmentScope> =
  SHARED_SCOPE_FOR_CONNECTION_KIND;

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

type EnrolledConnection = SharedEnrolledConnection;

/** Local alias for the subset of `ParsedConnectionAuditRow` fields
 *  this producer reads. Centralised in `_audit-activities.ts`; kept as
 *  a named alias here so the file's existing call sites read naturally. */
type ParsedAuditRow = ParsedConnectionAuditRow;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Nearest-rank percentile — re-exported from the shared `_stats.ts`
 *  (extracted at A.20's third caller per the codebase convention).
 *  Existing callers (tests + bin) keep their import path. */
export const percentile = sharedPercentile;

/** List enrolled connection records as `(kind, name)` pairs.
 *  Re-exported from the shared `_connection-records.ts` so existing
 *  callers (tests, bin wiring) keep their import path. */
export const scanEnrolledConnections = scanEnrolledConnectionsShared;

/** Pull every audit activity for `(kind, name)` whose timestamp is at
 *  or after `cutoff`. Re-exported from the shared
 *  `_audit-activities.ts` so existing callers keep their import path. */
export const collectActivitiesForConnection = collectConnectionActivities;

/** Fold a parsed-row batch into a `ConnectionHealthTrendValue`. Pure
 *  function — exposed so unit tests can drive it with synthetic rows
 *  without spinning up the audit table. Always returns a value; an
 *  empty input produces the zero-call shape (`call_count: 0`,
 *  percentiles null, `last_failure` null). */
export const computeHealthTrendValue = (
  rows: ReadonlyArray<ParsedAuditRow>,
  now: number,
  window_ms: number = CONNECTION_HEALTH_TREND_WINDOW_MS,
): ConnectionHealthTrendValue => {
  const call_count = rows.length;
  let error_count = 0;
  let last_call_at: number | null = null;
  let last_failure: ConnectionHealthTrendValue['last_failure'] = null;
  const latencies: number[] = [];

  for (const row of rows) {
    if (row.status === 'error') {
      error_count += 1;
      if (last_failure === null || row.ts > last_failure.ts) {
        last_failure = {
          ts: row.ts,
          error_code: row.error_code ?? '',
          error_message: row.error_message ?? '',
        };
      }
    }
    if (last_call_at === null || row.ts > last_call_at) {
      last_call_at = row.ts;
    }
    latencies.push(row.duration_ms);
  }

  latencies.sort((a, b) => a - b);
  const error_rate = call_count > 0 ? error_count / call_count : 0;
  const latency_p50_ms = call_count >= CONNECTION_HEALTH_TREND_P50_MIN_SAMPLE_COUNT
    ? percentile(latencies, 0.5)
    : null;
  const latency_p95_ms = call_count >= CONNECTION_HEALTH_TREND_P95_MIN_SAMPLE_COUNT
    ? percentile(latencies, 0.95)
    : null;

  return {
    call_count,
    error_count,
    error_rate,
    latency_p50_ms,
    latency_p95_ms,
    last_call_at,
    last_failure,
    window_ms,
    computed_at: now,
  };
};

/** Sweep rows for connection records that no longer exist in the
 *  `connections` table. Walks every existing topic row across all
 *  three connection scopes; deletes any whose `(scope, target_id)`
 *  isn't in the fresh-connections set.
 *
 *  Pre-launch zero-installs semantics: cascade engine doesn't touch
 *  `aggregate`-policy rows on source change (the `aggregates_from`
 *  source is `audit`, not the source connection record), and there
 *  is no source-delete cascade for connection records. Manual sweep
 *  is the sole orphan-cleanup path. */
export const sweepStaleHealthTrendRows = (
  ctx: HousekeepingContext,
  freshKeys: ReadonlySet<string>,
): { deleted: number } => {
  const existing = ctx.enrichmentStore.list({
    topic: CONNECTION_HEALTH_TREND_TOPIC,
    fresh_only: false,
    limit: 1000,
  });
  let deleted = 0;
  for (const row of existing) {
    if (row.scope == null || row.target_id == null) continue;
    if (KIND_FOR_CONNECTION_SCOPE[row.scope] === undefined) continue;
    const key = composeFreshKey(row.scope, row.target_id);
    if (freshKeys.has(key)) continue;
    if (ctx.enrichmentStore.deleteById(row._id)) deleted += 1;
  }
  return { deleted };
};

/** Compose the `(scope, target_id)` membership key the sweep uses to
 *  decide whether a row was refreshed this cycle. Re-exported from the
 *  shared `_connection-records.ts` (same format used by every
 *  connection-scope producer's sweep). */
export const composeFreshKey = composeConnectionFreshKey;

// ────────────────────────────────────────────────────────────────
// Cycle
// ────────────────────────────────────────────────────────────────

/** One-shot scan-and-emit cycle. Exported for direct test access
 *  without the task wrapper. Returns `{ produced, swept }` for
 *  caller-side assertions on cycle output. */
export const runConnectionHealthTrendCycle = (
  ctx: HousekeepingContext,
): { produced: number; swept: number } => {
  const now = ctx.now();
  const cutoff = now - CONNECTION_HEALTH_TREND_WINDOW_MS;
  const connections = scanEnrolledConnections(ctx);
  if (connections.length === 0) {
    const sweep = sweepStaleHealthTrendRows(ctx, new Set());
    return { produced: 0, swept: sweep.deleted };
  }

  const freshKeys = new Set<string>();
  let produced = 0;
  for (const conn of connections) {
    const scope = SCOPE_FOR_CONNECTION_KIND[conn.kind];
    const rows = collectActivitiesForConnection(ctx, conn.kind, conn.name, cutoff);
    const value = computeHealthTrendValue(rows, now);
    ctx.enrichmentStore.upsert({
      topic: CONNECTION_HEALTH_TREND_TOPIC,
      scope,
      target_id: conn.name,
      value,
      authored_by: CONNECTION_HEALTH_TREND_AUTHORED_BY,
      event_at: now,
    });
    freshKeys.add(composeFreshKey(scope, conn.name));
    produced += 1;
  }

  const sweep = sweepStaleHealthTrendRows(ctx, freshKeys);
  return { produced, swept: sweep.deleted };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const connectionHealthTrendTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.connection_health_trend',
    description:
      'Per-connection rolling health rollup — call count, error rate, latency p50/p95, last-failure cause.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.connection_health_trend,
      isAiSurface: false,
    }),
  },
  topic: CONNECTION_HEALTH_TREND_TOPIC,
  is_ai_surface: false,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    runConnectionHealthTrendCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

/** Per-cycle token estimate for the Run-Now cost preview. Exposed
 *  separately from the task instance so the rpc handler that builds
 *  the preview can call it without instantiating a step. Always 0
 *  (deterministic). */
export const connectionHealthTrendTokenEstimate = (): number =>
  CONNECTION_HEALTH_TREND_TOKEN_ESTIMATE;

/** Scope-of-read declaration surfaced in the Run-Now scope dialog +
 *  detail drawer. The producer reads from the connections table (one
 *  row per `(kind, name)`) plus the audit activity log filtered by
 *  `connection_<kind>` actions.
 *
 *  ⛔ THIS SAID `data.memory` UNTIL 2026-08-11 — an owner-facing disclosure
 *  naming the WRONG STORE. It was written when `data.memory.*` was the audit
 *  collection; D-231 split the namespace and `data.memory` now means the
 *  owner's curated pool (`user_memory`), which this producer has never read.
 *  The field paths below are `audit_activities` columns. Keep it `data.audit`:
 *  the whole point of the dialog is telling the owner what gets read. */
export const connectionHealthTrendScopeReadDeclaration = [
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
      'detail.error.code',
    ],
  },
] as const;
