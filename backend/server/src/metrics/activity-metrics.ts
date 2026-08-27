/** D-250 § D8.1 slice 3 — the four metrics read from `audit_activities`.
 *
 *  ⛔⛔ THE SLICE SCOPE WAS WRONG IN TWO WAYS, BOTH IN OUR FAVOUR — recorded because the
 *  next person will otherwise re-derive the expensive version.
 *
 *  1. **No `operation_id` → risk lookup is needed.** § D8 said one was required because
 *     `risk_tier` is absent from the ActivityEntry COLUMNS. It is — but D-165 P0's
 *     `connection_gateway` row carries the resolved policy inside `detail`:
 *     `operation_id` / `operation_group` / **effective `risk_tier`** / `approval` /
 *     `outcome` / `recipe_id` / `step_id` / **`execution_source`**. Everything all four
 *     metrics need is already on the row.
 *  2. **No new index is needed.** The existing composite
 *     `audit_activities_action_ts_idx (action, timestamp DESC)` serves every query here.
 *     Verified with EXPLAIN QUERY PLAN, not assumed:
 *     `SEARCH audit_activities USING INDEX audit_activities_action_ts_idx`.
 *
 *  🔑 `detail` IS A JSON STRING INSIDE A JSON BLOB, so every read is a DOUBLE extract —
 *  `json_extract(json_extract(data,'$.detail'), '$.risk_tier')`. A single extract
 *  returns the string and every predicate against it silently fails to match.
 */

import type Database from 'better-sqlite3';

import {
  ASKABLE_RISK_TIERS,
  BURST_CHANNELS,
  BURST_IDLE_GAP_MS,
  GATEWAY_OP_ACTION,
  METRIC_ABSENT,
  METRIC_REGISTRY,
  metricRatio,
  metricValue,
  type MetricReading,
} from '@recued/contracts';

export interface ActivityMetricValue {
  readonly metric_id: string;
  readonly metric_version: number;
  readonly reading: MetricReading;
  /** ⚠ LOCAL ONLY — § D2 publishes the ratio, never the counts. Both sides, so § D7's
   *  publish dialog can show the figures the ratio came from. */
  readonly numerator: number;
  readonly denominator: number;
}

export interface ActivityMetricsResult {
  readonly window: { readonly from: number; readonly to: number };
  readonly metrics: readonly ActivityMetricValue[];
  /** Gateway rows whose `detail.risk_tier` is a string this build does not know.
   *  ⛔ SAME ROLE AS SLICE 2's `unclassified_runs`: a new risk tier is a TYPE ERROR in
   *  the registry, but a row written by an OLDER or NEWER server on a shared log is
   *  not, and it must not silently join a bucket. */
  readonly unknown_risk_rows: number;
}

const D = (path: string): string => `json_extract(json_extract(data, '$.detail'), '${path}')`;
const TS = `json_extract(data, '$.timestamp')`;
const ACTION = `json_extract(data, '$.action')`;
const quoted = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');

const ASKABLE = quoted(ASKABLE_RISK_TIERS);
const ALL_KNOWN_RISK = quoted([...ASKABLE_RISK_TIERS, 'read']);

interface GatewayRow {
  gateway_ops: number;
  composed_ops: number;
  askable_ops: number;
  unknown_risk: number;
}

/** Best stretch of model-initiated gateway ops inside the window.
 *
 *  ⛔ THIS IS A WINDOW OBSERVATION, NOT THE RECORD. Burst is `store: 'artifact'` — the
 *  record ADVANCES from its own prior value, so maxing this against what is already
 *  stored belongs to the artifact writer (amendment 17). Returning it as if it were the
 *  record would make a quiet week ERASE a standing best.
 *
 *  🔑 GAP-BOUNDED IN SQL VIA `LAG`, not row-by-row in JS: a stretch boundary is
 *  "previous row more than the idle gap ago", a running SUM over that flag numbers the
 *  stretches, and the answer is the largest group. One indexed scan, no materialising. */
const burstWindowBest = (
  db: Database.Database,
  window: { from: number; to: number },
): number | undefined => {
  const row = db
    .prepare(
      `SELECT MAX(cnt) AS best FROM (
         SELECT COUNT(*) AS cnt FROM (
           SELECT SUM(is_new) OVER (ORDER BY ts ROWS UNBOUNDED PRECEDING) AS grp FROM (
             SELECT ts, CASE
               WHEN prev IS NULL OR ts - prev > ${BURST_IDLE_GAP_MS} THEN 1 ELSE 0
             END AS is_new FROM (
               SELECT ${TS} AS ts, LAG(${TS}) OVER (ORDER BY ${TS}) AS prev
                 FROM audit_activities
                WHERE ${ACTION} = '${GATEWAY_OP_ACTION}'
                  AND ${TS} >= ? AND ${TS} < ?
                  AND ${D('$.execution_source.channel')} IN (${quoted(BURST_CHANNELS)})
             )
           )
         ) GROUP BY grp
       )`,
    )
    .get(window.from, window.to) as { best: number | null } | undefined;
  return row?.best ?? undefined;
};

export const computeActivityMetrics = (
  db: Database.Database,
  window: { from: number; to: number },
): ActivityMetricsResult => {
  const g = (db
    .prepare(
      `SELECT
         COUNT(*) AS gateway_ops,
         COALESCE(SUM(CASE WHEN ${D('$.recipe_id')} IS NOT NULL THEN 1 ELSE 0 END), 0)
           AS composed_ops,
         COALESCE(SUM(CASE WHEN ${D('$.risk_tier')} IN (${ASKABLE}) THEN 1 ELSE 0 END), 0)
           AS askable_ops,
         COALESCE(SUM(CASE WHEN ${D('$.risk_tier')} IS NOT NULL
                            AND ${D('$.risk_tier')} NOT IN (${ALL_KNOWN_RISK})
                           THEN 1 ELSE 0 END), 0) AS unknown_risk
       FROM audit_activities
       WHERE ${ACTION} = '${GATEWAY_OP_ACTION}' AND ${TS} >= ? AND ${TS} < ?`,
    )
    .get(window.from, window.to) as GatewayRow | undefined) ?? {
    gateway_ops: 0, composed_ops: 0, askable_ops: 0, unknown_risk: 0,
  };

  // ⛔ THE DENOMINATOR IS AN ANSWERED DECISION, NOT AN ASK RAISED. § D5.3 rules that
  // "auto-granted ÷ all approvals" CANNOT be computed — a standing delegation raises no
  // ask at all, so there is nothing to count. Counting answers instead measures the
  // EFFECT (more rules ⇒ fewer asks ⇒ more work per ask) without ever identifying an
  // auto-grant.
  const answered = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_activities
        WHERE ${ACTION} IN ('approval_allow', 'approval_deny')
          AND ${TS} >= ? AND ${TS} < ?`,
    )
    .get(window.from, window.to) as { n: number } | undefined)?.n ?? 0;

  const burst = burstWindowBest(db, window);

  return {
    window,
    metrics: [
      {
        metric_id: 'toolmaker',
        metric_version: METRIC_REGISTRY.toolmaker!.metric_version,
        reading: metricRatio(g.composed_ops, g.gateway_ops),
        numerator: g.composed_ops,
        denominator: g.gateway_ops,
      },
      {
        metric_id: 'waved_through',
        metric_version: METRIC_REGISTRY.waved_through!.metric_version,
        // ⛔⛔ THE `true` IS LOAD-BEARING: askable work with zero answered decisions is
        // the BEST case (§ D5.3 — "zero decisions is the best case, not an error"), and
        // it must rank above every finite value rather than vanish as a divide-by-zero.
        reading: metricRatio(g.askable_ops, answered, true),
        numerator: g.askable_ops,
        denominator: answered,
      },
      {
        metric_id: 'creator',
        metric_version: METRIC_REGISTRY.creator!.metric_version,
        // A count, so it is its own reading — and `publishable: false` (§ D2).
        reading: g.gateway_ops > 0 ? metricValue(g.askable_ops) : METRIC_ABSENT,
        numerator: g.askable_ops,
        denominator: g.gateway_ops,
      },
      {
        metric_id: 'burst',
        metric_version: METRIC_REGISTRY.burst!.metric_version,
        reading: burst === undefined ? METRIC_ABSENT : metricValue(burst),
        numerator: burst ?? 0,
        denominator: g.gateway_ops,
      },
    ],
    unknown_risk_rows: g.unknown_risk,
  };
};
