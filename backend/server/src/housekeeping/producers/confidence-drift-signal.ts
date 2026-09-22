/** D-133 — `confidence_drift_signal` housekeeping producer.
 *
 *  Computes the rolling Population Stability Index per AI-surface
 *  enrichment topic that emits `confidence: number`. Daily housekeeping
 *  cadence; pure SQL aggregation over `data_enrichment` — zero token
 *  cost.
 *
 *  Built as a standalone `HousekeepingTaskInstance` rather than a
 *  `buildEnrichmentProducerTask` wrap because the iteration shape is
 *  fundamentally different from the source-record walker pattern: it
 *  walks topics (max ~10) in a single pass, not records-per-topic
 *  with cursors. The drift task still registers with `kind:
 *  'enrichment'` and stamps `topic` + `is_ai_surface: false` so the
 *  D-132 trust gate applies (default `'auto'` for deterministic
 *  producers — user can disable per topic).
 *
 *  State-transition firing (spec §A.4 / decision §2): the producer
 *  reads its own prior row before emitting a new one and fires the
 *  realtime event ONLY on `'none'` → `'moderate'` or `'moderate'` →
 *  `'significant'` crossings. PSI bouncing within the same severity
 *  bucket does not re-fire — defends against banner spam.
 *
 *  D-136 P4 — drift signal becomes a lifecycle-queue input. On a
 *  `'significant'` state-transition fire whose source topic carries
 *  `temporal_class: 'stable_truth' + lifecycle_policy:
 *  'recompute_on_drift'`, the producer enqueues
 *  `lifecycle_action_pending = 'recompute'` for every row of the source
 *  topic — the cascade walker (P5) drains the queue. Such topics also
 *  suppress the realtime banner event: the system handles the drift
 *  automatically, so the user-facing banner would be noise. Today only
 *  `purpose` / `summary` / `action_items` clear both gates (the post-
 *  D-136 PSI-eligible 3 from `confidenceEmittingEnrichmentTopics()`).
 *
 *  Spec: D-133, D-136 §P4 + §A.11. */

import {
  ENRICHMENT_REGISTRY,
  computeConfidenceHistogram,
  computeHousekeepingMetaTags,
  compareLowConfidenceRates,
  computePSI,
  confidenceEmittingEnrichmentTopics,
  proportionDriftSeverity,
  shiftIsMeasurable,
  psiSeverity,
  type ConfidenceDriftSignal,
  type DriftSeverity,
  type DriftWindow,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Minimum sample count in the recent window for PSI to be computed.
 *  Below this, the producer skips the topic + leaves the prior row
 *  intact.
 *
 *  ⛔⛔ D-280 — RAISED 30 → 100, AND THE OLD VALUE WAS NOT CONSERVATIVE,
 *  IT WAS NOISE. "30 is the rule-of-thumb floor in mining literature"
 *  was the stated reason and it is a floor for a DIFFERENT
 *  measurement: a sample size for estimating one proportion, not for a
 *  10-bin histogram compared against another 10-bin histogram. At
 *  n=30 that is ~3 samples per bin, and PSI on sparse bins is decided
 *  by which bins happen to land empty and take the 1e-4 smoothing.
 *
 *  🔑 SIMULATED AGAINST THE SHIPPED IMPLEMENTATION — same binning,
 *  same epsilon, same 0.10/0.25 thresholds, both windows drawn from
 *  the SAME distribution so every fire is false:
 *
 *      baseline recent   false moderate   false significant
 *           100     30       14.2-26.5%           2.4-12.6%
 *           100    100         3.1-4.0%            0.1-0.8%
 *           300    100         0.8-1.5%            0.0-0.4%
 *
 *  (ranges span a 15%-zero and a 5%-zero confidence distribution; the
 *  rarer the second mode, the worse the old floor behaved.) It runs
 *  DAILY and fires on state transitions, so 14% per evaluation is a
 *  spurious fire most weeks, per topic — and D-136 P4 turns a
 *  `'significant'` one into a recompute of every row of the topic.
 *
 *  ⚠ Power is retained for shifts worth acting on: a refusal rate
 *  moving 15% → 30% still fires `'moderate'` 66% of the time and
 *  15% → 45% fires `'significant'` 94%. What was given up is
 *  sensitivity to shifts too small to separate from noise anyway.
 *
 *  ⚠ THE COST IS AVAILABILITY: a topic needs 100 rows in the 7-day
 *  recent window before drift is evaluated at all. That is the right
 *  trade — below it the statistic cannot tell drift from resampling,
 *  so the honest output is silence, which is what the floors already
 *  express. */
export const MIN_SAMPLE_COUNT_RECENT = 100;

/** Minimum sample count in the baseline window. Larger floor than
 *  recent — the baseline anchors the comparison and noise on it
 *  contaminates every future computation.
 *
 *  D-280 — raised 100 → 300 alongside the recent floor; the table
 *  above shows the baseline carrying roughly a further 4x reduction
 *  in false moderates on top of what the recent floor buys. */
export const MIN_SAMPLE_COUNT_BASELINE = 300;

/** Recent window — last 7 days. */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Baseline window — first 30 days after the producer's first row
 *  for the source topic. Anchors to "what the producer's distribution
 *  looked like when first deployed." Re-anchoring requires explicit
 *  user action (post-launch knob). */
export const BASELINE_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** Authored-by stamp for drift rows. Keeps drift signals
 *  distinguishable from the producers they measure. */
export const CONFIDENCE_DRIFT_AUTHORED_BY = 'system.housekeeping.confidence_drift_signal';

/** Topic key for the drift signal itself. */
export const CONFIDENCE_DRIFT_TOPIC: EnrichmentTopic = 'confidence_drift_signal';

// ────────────────────────────────────────────────────────────────
// Internal types
// ────────────────────────────────────────────────────────────────

interface SampleRow {
  confidence: number;
  authored_at: number;
  /** The model that produced the row. `''` for a row whose `model_id`
   *  column is NULL — a real bucket, not a missing one. */
  model_id: string;
}

// ────────────────────────────────────────────────────────────────
// Pure helpers (testable in isolation)
// ────────────────────────────────────────────────────────────────

/** Decide whether a severity transition should fire the realtime
 *  event. State-transition firing only — `'moderate'` → `'none'` is
 *  silent, `'significant'` → `'moderate'` is silent. The user already
 *  has the prior banner in their event log; only escalations + first
 *  crossings of moderate fire.
 *
 *  Returns the severity to fire (`'moderate'` or `'significant'`) or
 *  null to suppress. */
export const driftTransitionFires = (
  prior: DriftSeverity | null,
  next: DriftSeverity,
): 'moderate' | 'significant' | null => {
  if (next === 'none') return null;
  if (prior === null) return next; // first crossing
  if (prior === 'none' && next === 'moderate') return 'moderate';
  if (prior === 'none' && next === 'significant') return 'significant';
  if (prior === 'moderate' && next === 'significant') return 'significant';
  return null;
};

/** ⛔⛔ D-284 — `sourceTopicAutoRecomputesOnDrift` WAS HERE AND IS GONE,
 *  along with the action it gated.
 *
 *  🔑 THE INVARIANT IT VIOLATED: a stored AI result is invalidated by a
 *  change to the QUESTION — the input content, or the prompt/producer
 *  asking it — or by the user saying so. Never by a change in who
 *  answered, or in how they have been answering lately. D-275 applied
 *  that to the dedup key (a model swap stopped invalidating the cache);
 *  D-279 applied it to the comparison (PSI withholds across a model
 *  change); drift-triggered recompute was the last place it did not
 *  hold — a statement about the PRODUCER'S behaviour overwriting rows
 *  whose content nobody touched.
 *
 *  ⚠ AND CONTENT-CHANGE ALREADY COVERS THE CASE THAT MATTERS.
 *  `purpose` composes its fingerprint as `per_record_source_hash` —
 *  "the hash IS `source_record_hash`" — so an edited body misses the
 *  dedup probe and the next idle cycle recomputes that row by itself.
 *  A producer or prompt revision moves `producer_version_hash` and does
 *  the same corpus-wide. A user quality-vote maps to `'recompute'`
 *  through `recomputeOrDiscardForTopic`. Drift added exactly one case
 *  on top: re-ask an UNCHANGED input.
 *
 *  🏁 MEASURED, on that one case — 20 real bodies, three consecutive
 *  runs of the shipped prompt: **0/20 category changes**, every
 *  difference confidence jitter inside the top mode (1 ↔ 0.95 ↔ 0.9),
 *  disagreement 3 → 4 across runs, i.e. NOT converging. The recompute
 *  rewrote the detector's own input and nothing a consumer reads.
 *
 *  ⏭ Detection is unaffected: the banner fires (D-283). What went is
 *  the action, which is what D-133 and D-136 both specified at launch —
 *  now with a measurement behind it rather than an appeal to them. */

/** Derive the baseline + recent windows for a topic given the topic's
 *  earliest row timestamp and the current time. Returns null when
 *  the topic has no earliest row (no samples yet — producer skips). */
export const computeWindowsForTopic = (
  earliest_authored_at: number | null,
  now: number,
): { baseline: { start_at: number; end_at: number }; recent: { start_at: number; end_at: number } } | null => {
  if (earliest_authored_at === null) return null;
  return {
    baseline: {
      start_at: earliest_authored_at,
      end_at: earliest_authored_at + BASELINE_WINDOW_MS,
    },
    recent: {
      start_at: now - RECENT_WINDOW_MS,
      end_at: now,
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Producer implementation
// ────────────────────────────────────────────────────────────────

const queryEarliestAuthoredAt = (
  ctx: HousekeepingContext,
  topic: string,
): number | null => {
  const row = ctx.db
    .prepare(
      `SELECT MIN(authored_at) AS earliest
         FROM data_enrichment
        WHERE topic = ?`,
    )
    .get(topic) as { earliest: number | null } | undefined;
  return row?.earliest ?? null;
};

const queryConfidenceSamples = (
  ctx: HousekeepingContext,
  topic: string,
  start_at: number,
  end_at: number,
): SampleRow[] => {
  const rows = ctx.db
    .prepare(
      `SELECT json_extract(value, '$.confidence') AS confidence,
              authored_at,
              model_id
         FROM data_enrichment
        WHERE topic = ?
          AND authored_at >= ?
          AND authored_at <  ?
          AND json_extract(value, '$.confidence') IS NOT NULL`,
    )
    .all(topic, start_at, end_at) as Array<{
      confidence: number | null; authored_at: number; model_id: string | null;
    }>;
  const out: SampleRow[] = [];
  for (const r of rows) {
    if (typeof r.confidence === 'number' && Number.isFinite(r.confidence)) {
      out.push({
        confidence: r.confidence,
        authored_at: r.authored_at,
        model_id: r.model_id ?? '',
      });
    }
  }
  return out;
};

/** Sorted distinct `model_id`s in a window. A NULL column reads as `''`
 *  — one real bucket meaning "row written before the model was stamped",
 *  which must not silently merge with a named model. */
const distinctModels = (rows: readonly SampleRow[]): string[] =>
  [...new Set(rows.map((r) => r.model_id))].sort();

const sameModelSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((m, i) => m === b[i]);

const readPriorDriftSignal = (
  ctx: HousekeepingContext,
  source_topic: string,
): ConfidenceDriftSignal | null => {
  const real = ctx.enrichmentStore.getDerived(CONFIDENCE_DRIFT_TOPIC, `drift_${source_topic}`);
  if (!real) return null;
  return real.value as ConfidenceDriftSignal;
};

const upsertDriftSignal = (
  ctx: HousekeepingContext,
  signal: ConfidenceDriftSignal,
): void => {
  ctx.enrichmentStore.upsert({
    topic: CONFIDENCE_DRIFT_TOPIC,
    derived_entity_id: `drift_${signal.source_topic}`,
    value: signal,
    authored_by: CONFIDENCE_DRIFT_AUTHORED_BY,
    event_at: signal.computed_at,
  });
};

/** Process one source topic: query samples, compute PSI, decide
 *  transition, upsert + maybe emit. Returns the count of fired
 *  events (0 or 1). Exported for unit testing. */
export const processOneTopic = (
  ctx: HousekeepingContext,
  source_topic: EnrichmentTopic,
  now: number,
): {
  processed: boolean;
  fired: 'moderate' | 'significant' | null;
  /** R13 T1-Q2 — set iff the cascade governor declined this topic's
   *  recompute enqueue, so the caller can tell a declined cycle from a
   *  calm one and carry the governor's dropped count instead of
   *  discarding it. */
  governor_declined?: { dropped: number };
} => {
  const earliest = queryEarliestAuthoredAt(ctx, source_topic);
  const windows = computeWindowsForTopic(earliest, now);
  if (!windows) return { processed: false, fired: null };

  const baselineSamples = queryConfidenceSamples(
    ctx,
    source_topic,
    windows.baseline.start_at,
    windows.baseline.end_at,
  );
  const recentSamples = queryConfidenceSamples(
    ctx,
    source_topic,
    windows.recent.start_at,
    windows.recent.end_at,
  );

  if (
    baselineSamples.length < MIN_SAMPLE_COUNT_BASELINE ||
    recentSamples.length < MIN_SAMPLE_COUNT_RECENT
  ) {
    return { processed: false, fired: null };
  }

  // ⛔⛔ D-279 — WITHHOLD ACROSS A MODEL CHANGE, the same way the sample
  // floors above withhold on a thin window.
  //
  // PSI asks whether one distribution moved relative to another. That is
  // only a question about the WORLD while the producer is held fixed;
  // swap the model underneath and the two windows are samples from two
  // different instruments, so a large PSI says "the config changed",
  // which the user already knows. Worse, D-136 P4 turns a `'significant'`
  // fire into a recompute of every row of the topic — so reading a model
  // swap as drift spends the user's tokens on news they made themselves.
  //
  // 🔑 Withholding, rather than correcting for it. Rescaling across two
  // models would need a mapping between their confidence scales, and
  // there is none: D-278 measured the same prompt shape produce
  // [0.85, 0.9, 0.95] on one wording and [0, 0.9] on another. A
  // comparison that cannot be made honestly is not made.
  const baselineModels = distinctModels(baselineSamples);
  const recentModels = distinctModels(recentSamples);
  if (!sameModelSet(baselineModels, recentModels)) {
    return { processed: false, fired: null };
  }

  const baselineDistribution = computeConfidenceHistogram(
    baselineSamples.map((r) => r.confidence),
  );
  const recentDistribution = computeConfidenceHistogram(
    recentSamples.map((r) => r.confidence),
  );
  const psi = computePSI(baselineDistribution, recentDistribution);

  // ⛔⛔ D-281 — THE DECIDING STATISTIC IS THE PROPORTION TEST, NOT PSI.
  // PSI answers "did the shape of a 10-bin histogram move", which is a
  // question nobody asked and cannot be read off the number. The rate
  // answers "are we declining more often than we were", which is the
  // thing a reader acts on and can be stated in a sentence with its own
  // sample size and p-value.
  //
  // Measured on the shipped implementation at these floors, both windows
  // drawn from ONE population so every fire is false:
  //
  //             false moderate   false significant   power 15%→30%
  //   PSI          0.7 / 1.3%          0.0 / 0.4%           11.9%
  //   rate test    1.0 / 0.0%          0.0 / 0.0%           48.3%
  //
  // Same safety, four times the power on a doubling of the refusal rate.
  // `psi` is still computed and stored as a second view of the same
  // windows; it gates nothing.
  const shift = compareLowConfidenceRates(
    baselineSamples.map((r) => r.confidence),
    recentSamples.map((r) => r.confidence),
  );
  // ⚠ …and PSI covers the case the rate test cannot see. When every
  // sample in both windows falls the same side of the cut, the
  // proportion test has no variance to work with — that is the normal
  // shape for the deterministic `sample_count / 100` producers, and a
  // slide from 0.85 to 0.55 is a real change that refused nothing
  // either time. Each statistic decides where it has power.
  const severity = shiftIsMeasurable(shift)
    ? proportionDriftSeverity(shift)
    : psiSeverity(psi);

  const prior = readPriorDriftSignal(ctx, source_topic);
  const priorSeverity = prior?.severity ?? null;
  const fires = driftTransitionFires(priorSeverity, severity);

  // Severity transitions clear any prior dismissal on the row — the
  // user dismissed the prior crossing, but a new transition deserves
  // a fresh banner.
  const dismissed_at =
    prior?.dismissed_at !== undefined && priorSeverity === severity
      ? prior.dismissed_at
      : undefined;

  const baselineWindow: DriftWindow = {
    start_at: windows.baseline.start_at,
    end_at: windows.baseline.end_at,
    sample_count: baselineSamples.length,
  };
  const recentWindow: DriftWindow = {
    start_at: windows.recent.start_at,
    end_at: windows.recent.end_at,
    sample_count: recentSamples.length,
  };

  const signal: ConfidenceDriftSignal = {
    source_topic,
    psi,
    severity,
    baseline_window: baselineWindow,
    recent_window: recentWindow,
    baseline_distribution: baselineDistribution,
    recent_distribution: recentDistribution,
    computed_at: now,
    shift,
    ...(shiftIsMeasurable(shift) ? { low_confidence_delta: shift.delta } : {}),
    model_ids: recentModels,
    ...(dismissed_at !== undefined ? { dismissed_at } : {}),
  };

  // D-136 P4 — auto-recompute branch. PSI `'significant'` on a
  // stable_truth + recompute_on_drift source topic enqueues recompute
  // for every row of that topic; the cascade walker (P5) drains the
  // queue. `'moderate'` is below the recompute threshold per spec §P4
  // (only `'significant'` enqueues).
  //
  // Banner suppression follows a stricter rule: the realtime event is
  // suppressed for ALL non-null transitions (both moderate AND
  // significant) when the source topic auto-recomputes on drift. The
  // user gets nothing actionable from the banner because the system
  // either handles the drift now (significant → queued) or hasn't
  // decided to handle it yet (moderate → wait for significant). Per
  // spec §P4: "Drift banner UI fires for non-`'recompute_on_drift'`
  // topics." The persisted drift signal still exists so the drawer can
  // render the trajectory.
  //
  // Atomicity (post-Codex P2 review): the drift-signal upsert and the
  // lifecycle-action enqueue commit together inside a single
  // `ctx.db.transaction(...)`. If the queue write throws (or the
  // process crashes between the two writes), the prior severity is NOT
  // advanced, so the next cycle sees the same `null → significant`
  // transition and re-fires both writes. Without this atomicity the
  // signal-only write would advance the persisted prior severity to
  // `'significant'`, `driftTransitionFires` would return `null` on the
  // next cycle, and the rows would never enqueue while the banner stays
  // suppressed — silent loss of recompute coverage.
  // ⚠ The round-12 governor call (`cascadeTopicAdmission`) went with the
  // enqueue: it existed to reserve queue depth for a topic-wide fan-out
  // that no longer happens. The ctx hook stays for the cascade engine's
  // own two writers.
  upsertDriftSignal(ctx, signal);

  // ⛔⛔ D-283 — THE BANNER FIRES AGAIN, INCLUDING WHERE THE SYSTEM ACTS.
  // This read `fires !== null && !autoRecomputes`, and D-136 P4's reason
  // for the suppression was that "the system handles auto-recompute on
  // significant" so the banner would be noise. Two things were wrong with
  // that, neither visible at the time:
  //
  //  1. IT HID A SPEND. A `'significant'` fire enqueues a recompute of
  //     every row of the topic. Suppressing the banner meant the user's
  //     tokens went on a verdict they were never shown.
  //  2. IT DISABLED ITS OWN PROMOTION PATH. Audit § 26 Q3 closed the
  //     drift-action question as "ship UI banner only; banner
  //     click-through rate auto-promotes to auto-recompute per topic —
  //     defaults preserve user control." P4 assumed a mix, writing
  //     "future non-recompute AI-surface topics retain the existing
  //     D-133 banner". There is no mix: all five PSI-eligible topics are
  //     `recompute_on_drift`, so NO topic banners, so no click-through
  //     is collectable, so the telemetry meant to EARN auto-recompute
  //     can never accrue. The automation switched off the evidence for
  //     itself.
  //
  // ⇒ The banner fires on every transition. Where a recompute was also
  // enqueued the event says so and the copy tells the reader the work is
  // already running, which is the honest version of "you don't need to
  // act" — and leaves the click-through the promotion path needs.
  if (fires !== null) {
    try {
      ctx.eventBus?.emit({
        kind: 'enrichment_drift_detected',
        source_topic,
        psi,
        // Only when the proportion test is what decided — otherwise the
        // banner would quote a number that did not produce the verdict.
        ...(shiftIsMeasurable(shift) ? { low_confidence_delta: shift.delta } : {}),
        severity: fires,
        computed_at: now,
      });
    } catch {
      // Best-effort fan-out — the persisted signal is the source of
      // truth; the banner re-arms naturally once paired clients
      // reconnect and replay events from the bus ring.
    }
  }

  return { processed: true, fired: fires };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const confidenceDriftSignalTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.confidence_drift_signal',
    description:
      'Daily PSI on AI-surface producers — surfaces silent regression of confidence distributions before downstream symptoms appear.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.confidence_drift_signal,
      isAiSurface: false,
    }),
  },
  topic: CONFIDENCE_DRIFT_TOPIC,
  is_ai_surface: false,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    const now = ctx.now();
    const topics = confidenceEmittingEnrichmentTopics();
    let declined_topics = 0;
    let dropped_rows = 0;
    for (const topic of topics) {
      const outcome = processOneTopic(ctx, topic, now);
      if (outcome.governor_declined) {
        declined_topics += 1;
        dropped_rows += outcome.governor_declined.dropped;
      }
    }
    // Single-pass per cycle — drift is a daily signal; the harness
    // re-fires the task on each idle cycle.
    return {
      status: 'complete',
      cursor: { kind: 'complete' },
      ...(declined_topics > 0 ? { governor: { declined_topics, dropped_rows } } : {}),
    };
  },
};
