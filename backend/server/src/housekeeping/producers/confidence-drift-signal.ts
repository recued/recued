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
  computePSI,
  confidenceEmittingEnrichmentTopics,
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
 *  intact. PSI on small samples is unreliable; 30 is the rule-of-
 *  thumb floor in mining literature. */
export const MIN_SAMPLE_COUNT_RECENT = 30;

/** Minimum sample count in the baseline window. Larger floor than
 *  recent — the baseline anchors the comparison and noise on it
 *  contaminates every future computation. */
export const MIN_SAMPLE_COUNT_BASELINE = 100;

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

/** D-136 P4 — does this source topic auto-recompute on a `'significant'`
 *  drift fire? Closed list today: every topic registered with
 *  `temporal_class: 'stable_truth' + lifecycle_policy:
 *  'recompute_on_drift'`. Original D-136 P4 close cleared the bar with
 *  3 confidence-emitting AI surfaces (`purpose` / `summary` /
 *  `action_items`) plus `embedding` (qualifies structurally but is
 *  never visited because it doesn't emit confidence). D-145 PA9
 *  widened to 16 by registering 12 more work-entity + engine /
 *  reliability producers carrying the same classification triple. The
 *  exact list is pinned by the ratchet test in
 *  `d-136-phase-4-drift-as-input.test.ts`.
 *
 *  When this returns true, the drift producer enqueues
 *  `lifecycle_action_pending = 'recompute'` for the source topic AND
 *  suppresses the banner-firing realtime event: the system handles
 *  the drift automatically so the user doesn't need the banner.
 *
 *  Exported so tests can drive the closed-list lookup independently of
 *  the producer's database side-effects. */
export const sourceTopicAutoRecomputesOnDrift = (
  source_topic: EnrichmentTopic,
): boolean => {
  const def = ENRICHMENT_REGISTRY[source_topic];
  if (!def) return false;
  return (
    def.temporal_class === 'stable_truth' &&
    def.lifecycle_policy === 'recompute_on_drift'
  );
};

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
              authored_at
         FROM data_enrichment
        WHERE topic = ?
          AND authored_at >= ?
          AND authored_at <  ?
          AND json_extract(value, '$.confidence') IS NOT NULL`,
    )
    .all(topic, start_at, end_at) as Array<{ confidence: number | null; authored_at: number }>;
  const out: SampleRow[] = [];
  for (const r of rows) {
    if (typeof r.confidence === 'number' && Number.isFinite(r.confidence)) {
      out.push({ confidence: r.confidence, authored_at: r.authored_at });
    }
  }
  return out;
};

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

  const baselineDistribution = computeConfidenceHistogram(
    baselineSamples.map((r) => r.confidence),
  );
  const recentDistribution = computeConfidenceHistogram(
    recentSamples.map((r) => r.confidence),
  );
  const psi = computePSI(baselineDistribution, recentDistribution);
  const severity = psiSeverity(psi);

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
  const autoRecomputes = sourceTopicAutoRecomputesOnDrift(source_topic);
  // Round-12 audit fix (T1 § 8.1) — consult the cascade budget governor
  // BEFORE the transaction. The engine's two other topic-wide writers
  // reserve against the real fan-out and skip all-or-nothing over
  // `cascade_queue_depth_max_per_topic`; this third writer enqueued bare.
  // Declined ⇒ skip BOTH writes: the atomicity comment below is exactly why —
  // advancing the persisted severity without the enqueue is the silent loss
  // of recompute coverage the transaction exists to prevent, so a declined
  // topic leaves the prior severity in place and the next daily cycle sees
  // the same transition and re-asks under fresh headroom. Absent hook
  // (tests / dbless harnesses) ⇒ ungated, the ctx's standing optional-gate
  // semantic.
  if (fires === 'significant' && autoRecomputes && ctx.cascadeTopicAdmission) {
    const admission = ctx.cascadeTopicAdmission(source_topic);
    if (!admission.admitted) {
      return { processed: true, fired: null, governor_declined: { dropped: admission.dropped } };
    }
  }
  ctx.db.transaction(() => {
    upsertDriftSignal(ctx, signal);
    if (fires === 'significant' && autoRecomputes) {
      ctx.enrichmentStore.enqueueLifecycleActionForTopic(source_topic, 'recompute');
    }
  })();

  if (fires !== null && !autoRecomputes) {
    try {
      ctx.eventBus?.emit({
        kind: 'enrichment_drift_detected',
        source_topic,
        psi,
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
