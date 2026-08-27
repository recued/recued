/** D-250 § D8.1 slice 4 — recompute the owner metrics and fold them into both stores.
 *
 *  ⛔ COMPUTE ONLY, AND THAT IS AN AUTHORIZATION BOUNDARY RATHER THAN A SCOPE NOTE.
 *  § D4 splits the two acts because `resolveTrustCeiling` gives `housekeeping` the
 *  `admin` ceiling as "the server's own maintenance, outside the user-approval model".
 *  Recomputing a local number IS that. **Publishing an owner's activity to a public
 *  board is not**, and it carries its own bounded, revocable grant — it must never ride
 *  this task's exemption. Nothing here reaches the network.
 *
 *  ⚠ ZERO TOKEN, FULLY DETERMINISTIC, and § D4 records why that is load-bearing beyond
 *  cost: reproducible (a board compares like with like), auditable (the computation is
 *  code, not a model's judgement), and it sidesteps D-132 entirely — `enrichment_trust`,
 *  pool policy and Pause-AI all govern AI producers, so this needs none of them.
 *
 *  🔑 IDEMPOTENT BY CONSTRUCTION, WHICH IS WHY IT CAN RUN EVERY CYCLE. The snapshot is
 *  REPLACED whole; Burst's record ADVANCES by max. Running twice in a minute, or twenty
 *  times a day, converges to the same state — so the task needs no "already ran today"
 *  guard and no cursor beyond `complete`.
 */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';
import { METRIC_REGISTRY, OWNER_METRICS_COMPUTE_TASK_ID } from '@recued/contracts';

import { computeActivityMetrics } from '../../metrics/activity-metrics.js';
import { computeAnchorMetrics } from '../../metrics/anchor-metrics.js';
import { createMetricArtifactStore } from '../../metrics/artifact-store.js';
import { advanceDailyStreaks } from '../../metrics/daily-streaks.js';
import { createMetricSnapshotStore, type SnapshotMetric } from '../../metrics/snapshot-store.js';
import type { HousekeepingContext, HousekeepingTaskInstance } from '../registry.js';

const DAY_MS = 86_400_000;

/** § B3.5 — **UTC**, for both halves. A board where one participant's Tuesday ends eight
 *  hours before another's is not a ranking, and there is no server-level owner timezone
 *  to use for the dashboard instead, so it is UTC and must be LABELLED as such. */
export const utcDayStart = (now: number): number => Math.floor(now / DAY_MS) * DAY_MS;

/** ⛔⛔ BURST LOOKS BACK FURTHER THAN THE RATIOS DO, AND THIS IS A CORRECTNESS FIX
 *  RATHER THAN A TUNING KNOB. Burst is the longest STRETCH of activity, so a day
 *  boundary cuts any stretch spanning midnight — and unlike a ratio that error does not
 *  wash out: § B3.5a names it, and a record set from a truncated stretch is
 *  *second-order and PERMANENT*. Widening is safe in exactly one direction: the record
 *  advances by MAX, and the 1h idle gap still separates genuinely distinct stretches, so
 *  a wider window can only ever find an equal-or-longer TRUE stretch. It cannot glue two
 *  apart ones together and it cannot inflate.
 *  ⚠ This is NOT § B3.5b's rejected rolling-24h: that needed its own incremental
 *  statistics store because the metric would have to run hourly. This is one wider read
 *  on the same index, at the same cadence. */
export const BURST_LOOKBACK_MS = 2 * DAY_MS;

export const ownerMetricsComputeTask: HousekeepingTaskInstance = {
  meta: {
    id: OWNER_METRICS_COMPUTE_TASK_ID,
    description:
      'Recompute the D-250 owner metrics over the current UTC day and fold them into the '
      + 'snapshot (replaced whole) and artifact (advanced) stores. Deterministic, zero-token, '
      + 'local only — publishing is a separate act with its own grant (§ D4).',
    interruptible: true,
    kind: 'core',
    tags: ['kind:core', 'domain:metrics', 'surface:deterministic'],
  },

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    const now = ctx.now();
    const from = utcDayStart(now);
    // ⛔⛔ `to` IS THE END OF THE DAY, NOT `now`, AND THE DIFFERENCE IS A DROPPED ROW.
    // The compute functions use a half-open `[from, to)` — correct for a day boundary,
    // since it is what stops midnight belonging to two days. Passing `now` as `to` then
    // EXCLUDES anything stamped in the current millisecond, so the newest audit row —
    // often the very one that provoked the cycle — vanishes from its own measurement.
    // Nothing errors; the number is just quietly short.
    // ⚠ Measuring the whole day rather than the day-so-far costs nothing: rows cannot
    // exist in the future, so both windows hold identical data. And a partial day is the
    // right reading anyway — the snapshot is replaced every cycle, and § B3.5 notes a
    // ratio over a partial window is nearly identical because numerator and denominator
    // shift together. Counts are window-sensitive; ratios are not.
    const dayEnd = from + DAY_MS;
    const window = { from, to: dayEnd };

    const anchor = computeAnchorMetrics(ctx.db, window);
    const activity = computeActivityMetrics(ctx.db, window);

    // ⛔ SPLIT BY THE REGISTRY, NOT BY WHICH COMPUTE FUNCTION PRODUCED IT. `burst` comes
    // back alongside three snapshot metrics from `computeActivityMetrics`, so grouping
    // by source would put a record into a replaced-whole row and a quiet week would
    // erase a standing best. The snapshot store rejects that too — this is the reason
    // it has to.
    const snapshotMetrics: SnapshotMetric[] = [];
    const artifact = createMetricArtifactStore(ctx.db);

    for (const m of [...anchor.metrics, ...activity.metrics]) {
      const def = METRIC_REGISTRY[m.metric_id];
      if (def === undefined) continue;
      if (def.store === 'snapshot') {
        snapshotMetrics.push({
          metric_id: m.metric_id,
          metric_version: m.metric_version,
          reading: m.reading,
          // ⚠ LOCAL ONLY (§ D2) — carried so § D7's publish dialog can show the figures
          // the ratio came from, and so § D6's floor has a denominator to test.
          numerator: m.numerator,
          denominator: m.denominator,
        });
        continue;
      }
      // An artifact metric. Only `record` shapes are produced by these two compute
      // functions today; a streak or milestone arrives with its own producer.
      if (def.shape === 'record' && m.reading.kind === 'value') {
        artifact.advanceRecord(m.metric_id, m.reading.value, now);
      }
    }

    // Burst re-read over the wider window, then folded by max. ⚠ The value in the loop
    // above was the day-window observation; this can only raise it.
    const burstWide = computeActivityMetrics(ctx.db, {
      from: dayEnd - BURST_LOOKBACK_MS,
      to: dayEnd,
    }).metrics.find((m) => m.metric_id === 'burst');
    if (burstWide?.reading.kind === 'value') {
      artifact.advanceRecord('burst', burstWide.reading.value, now);
    }

    // ⛔ THE STREAKS ADVANCE, THEY DO NOT RECOMPUTE — and they walk COMPLETE days only,
    // never today. A streak feeds a RECORD, so a day credited early (before an
    // afternoon approval falsifies it) is a permanently wrong best.
    const streaks = advanceDailyStreaks(ctx.db, artifact, now);

    createMetricSnapshotStore(ctx.db).write({
      computed_at: now,
      window,
      metrics: snapshotMetrics,
      // ⚠ LOCAL ONLY — § D2 publishes the ratio and never the counts. Carried so the
      // dashboard can show coverage and so an unclassified trigger_source or risk_tier
      // is VISIBLE rather than silently reshaping a metric.
      diagnostics: {
        unclassified_runs: anchor.unclassified_runs,
        null_trigger_runs: anchor.null_trigger_runs,
        unknown_risk_rows: activity.unknown_risk_rows,
        economy_family: anchor.economy_family,
        hands_off_current: streaks.hands_off_current,
        hands_off_longest: streaks.hands_off_longest,
        // ⚠ Surfaced so the dashboard can say the streak broke because the SERVER WAS
        // OFF, not because a decision was answered — two very different readings that
        // a bare 0 cannot tell apart.
        streak_reset_for_gap: streaks.reset_for_gap,
        milestones_earned: streaks.milestones_earned,
      },
    });

    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};
