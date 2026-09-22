/** D-133 — Population Stability Index for confidence drift detection.
 *
 *  Pure / portable / testable in isolation. The producer in
 *  `backend/server/src/housekeeping/producers/confidence-drift-signal.ts`
 *  + future UI logic + tests share this module. Spec:
 *  D-133. */

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Number of histogram bins for the PSI computation. 10 bins
 *  ([0,0.1), [0.1,0.2), ..., [0.9,1.0]) is the standard granularity
 *  for confidence-distribution drift detection. Confidence values
 *  outside [0, 1] clip to the nearest edge bin. */
export const PSI_BIN_COUNT = 10;

/** PSI thresholds — mining-standard (see Karakoulas 2004 and BI
 *  literature). PSI < this → severity `'none'`. */
export const PSI_THRESHOLD_MODERATE = 0.10;

/** PSI ≥ this → severity `'significant'`. Between thresholds → `'moderate'`. */
export const PSI_THRESHOLD_SIGNIFICANT = 0.25;

/** Laplace smoothing constant to avoid `log(0)` on empty bins. The
 *  standard 0.0001 keeps the smoothed proportion well below the
 *  threshold cutoffs while keeping the math finite. */
export const PSI_LAPLACE_EPSILON = 0.0001;

// ────────────────────────────────────────────────────────────────
// Severity
// ────────────────────────────────────────────────────────────────

export type DriftSeverity = 'none' | 'moderate' | 'significant';

/** Closed enumeration. Used by realtime-event validators + the
 *  drawer / banner UI. */
export const ALL_DRIFT_SEVERITIES: ReadonlyArray<DriftSeverity> = [
  'none',
  'moderate',
  'significant',
] as const;

// ────────────────────────────────────────────────────────────────
// Pure math
// ────────────────────────────────────────────────────────────────

/** Bin a single confidence value into `[0, PSI_BIN_COUNT)`. Values
 *  outside `[0, 1]` clip to the nearest edge bin; `1.0` is right-
 *  inclusive (lands in bin 9, not bin 10). */
const binIndexFor = (v: number): number => {
  if (Number.isNaN(v)) return 0;
  const raw = Math.floor(v * PSI_BIN_COUNT);
  if (raw < 0) return 0;
  if (raw >= PSI_BIN_COUNT) return PSI_BIN_COUNT - 1;
  return raw;
};

/** 10-bin histogram of confidence values. Returns proportions
 *  (sum to 1.0 when input non-empty; sum to 0 on empty input).
 *  Values outside `[0, 1]` clip to the nearest edge bin. */
export const computeConfidenceHistogram = (
  samples: ReadonlyArray<number>,
): ReadonlyArray<number> => {
  const counts = new Array<number>(PSI_BIN_COUNT).fill(0);
  if (samples.length === 0) return counts;
  for (const s of samples) {
    counts[binIndexFor(s)] += 1;
  }
  const denom = samples.length;
  return counts.map((c) => c / denom);
};

/** Population Stability Index between two normalized distributions.
 *  Both must have the same bin count + sum to 1.0 (or both empty).
 *  Empty bins use Laplace smoothing (`PSI_LAPLACE_EPSILON`) to avoid
 *  `log(0)`. Returns 0 when both inputs are empty. */
export const computePSI = (
  baseline: ReadonlyArray<number>,
  recent: ReadonlyArray<number>,
): number => {
  if (baseline.length !== recent.length) {
    throw new Error(
      `PSI: bin count mismatch — baseline ${baseline.length} vs recent ${recent.length}`,
    );
  }
  let psi = 0;
  for (let i = 0; i < baseline.length; i += 1) {
    const e = baseline[i] === 0 ? PSI_LAPLACE_EPSILON : baseline[i];
    const a = recent[i] === 0 ? PSI_LAPLACE_EPSILON : recent[i];
    psi += (a - e) * Math.log(a / e);
  }
  return psi;
};

// ────────────────────────────────────────────────────────────────
// D-281 — the statistic that DECIDES: a two-proportion test on the
// low-confidence rate. PSI below is retained as a diagnostic only.
// ────────────────────────────────────────────────────────────────

/** Confidence at or above this counts as a confident row; below it the
 *  producer effectively declined.
 *
 *  🔑 0.5 IS MEANINGFUL FOR BOTH SHAPES THESE TOPICS PRODUCE. D-278's
 *  anchoring made the narrated confidences near-binary — a zero mode and
 *  a 0.9-1.0 mode — so 0.5 separates them exactly and the rate IS the
 *  refusal rate. The deterministic producers compute
 *  `clamp(sample_count / 100, 0, 1)`, so the same cut reads as "rows
 *  derived from fewer than 50 samples". One number, interpretable in
 *  both worlds, which is what PSI over a 10-bin histogram never was. */
export const LOW_CONFIDENCE_CUT = 0.5;

/** Proportion of samples below `LOW_CONFIDENCE_CUT`. */
export const lowConfidenceRate = (
  samples: ReadonlyArray<number>,
): number => (samples.length === 0
  ? 0
  : samples.filter((v) => v < LOW_CONFIDENCE_CUT).length / samples.length);

/** Two-sided normal survival function — `erfc` is not in the JS stdlib,
 *  so this is the Abramowitz & Stegun 7.1.26 approximation, accurate to
 *  ~1.5e-7 absolute. Ample: the thresholds below are 0.01 and 0.001, and
 *  nothing here needs a p-value to more than two significant figures. */
const normalTwoSided = (z: number): number => {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 1 - y;
};

export interface ProportionShift {
  /** Low-confidence rate in the baseline window, 0..1. */
  baseline_rate: number;
  /** Low-confidence rate in the recent window, 0..1. */
  recent_rate: number;
  /** `recent_rate - baseline_rate`; signed, so a FALLING refusal rate is
   *  visible as drift too. */
  delta: number;
  /** Two-sided p-value of the pooled two-proportion z-test. `1` when
   *  either window is empty or the pooled rate is degenerate. */
  p_value: number;
  baseline_n: number;
  recent_n: number;
}

/** Pooled two-proportion z-test on the low-confidence rate. */
export const compareLowConfidenceRates = (
  baseline: ReadonlyArray<number>,
  recent: ReadonlyArray<number>,
): ProportionShift => {
  const nb = baseline.length;
  const nr = recent.length;
  const baseline_rate = lowConfidenceRate(baseline);
  const recent_rate = lowConfidenceRate(recent);
  const delta = recent_rate - baseline_rate;
  if (nb === 0 || nr === 0) {
    return { baseline_rate, recent_rate, delta, p_value: 1, baseline_n: nb, recent_n: nr };
  }
  const pooled = (baseline_rate * nb + recent_rate * nr) / (nb + nr);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nb + 1 / nr));
  // ⚠ `se === 0` when every sample on both sides fell the same side of the
  // cut. That is not evidence of stability, it is no variance to test —
  // p = 1 withholds rather than dividing by zero into a certainty.
  const p_value = se === 0 ? 1 : normalTwoSided(delta / se);
  return { baseline_rate, recent_rate, delta, p_value, baseline_n: nb, recent_n: nr };
};

/** ⛔⛔ BOTH A P-VALUE AND AN EFFECT SIZE, because either alone lies at
 *  these window sizes. Significance without an effect floor fires on a
 *  2-point move once the windows are large; an effect floor without
 *  significance fires on noise when they are small.
 *
 *  Measured against the shipped floors (baseline 300 / recent 100), both
 *  windows drawn from the same population so every fire is false:
 *
 *      false moderate 1.0% / 0.0%   false significant 0.0% / 0.0%
 *
 *  and power on a real shift: 15% → 30% fires `'significant'` 48% of the
 *  time, 15% → 45% fires it 99.6%. The PSI it replaced managed 11.9% on
 *  the same doubling at the same floors. */
export const DRIFT_SIGNIFICANT_P = 0.001;
export const DRIFT_SIGNIFICANT_DELTA = 0.15;
export const DRIFT_MODERATE_P = 0.01;
export const DRIFT_MODERATE_DELTA = 0.10;

/** Whether the cut actually PARTITIONS the observed data — i.e. whether
 *  the proportion test has anything to measure.
 *
 *  ⛔⛔ THE FALLBACK THIS ENABLES IS NOT A HEDGE, IT IS THE POINT. A rate
 *  test at any cut is blind to movement that stays on ONE SIDE of it:
 *  a topic whose confidence slides 0.85 → 0.55 has changed a great deal
 *  and refused nothing either time. That never happens to an anchored
 *  narrated confidence, which is 0 or 0.9-1.0 and nothing between — but
 *  it is the NORMAL case for the deterministic producers, whose
 *  `clamp(sample_count / 100, 0, 1)` is continuous.
 *
 *  🔑 So the statistic is chosen by what the DATA supports rather than
 *  by a per-topic declaration nobody would keep current: when samples
 *  fall on both sides of the cut the refusal rate is a real signal and
 *  decides; when they all fall on one side it has no power and PSI —
 *  which reads the whole distribution — is the only thing that can see
 *  the shift. Each statistic is used exactly where it has power. */
export const shiftIsMeasurable = (shift: ProportionShift): boolean => {
  if (shift.baseline_n === 0 || shift.recent_n === 0) return false;
  const allConfident = shift.baseline_rate === 0 && shift.recent_rate === 0;
  const allDeclined = shift.baseline_rate === 1 && shift.recent_rate === 1;
  return !allConfident && !allDeclined;
};

export const proportionDriftSeverity = (shift: ProportionShift): DriftSeverity => {
  const d = Math.abs(shift.delta);
  if (shift.p_value < DRIFT_SIGNIFICANT_P && d >= DRIFT_SIGNIFICANT_DELTA) return 'significant';
  if (shift.p_value < DRIFT_MODERATE_P && d >= DRIFT_MODERATE_DELTA) return 'moderate';
  return 'none';
};

/** Map a PSI scalar to its severity bucket per the mining-standard
 *  thresholds. `>= 0.25` → `'significant'`; `>= 0.10` → `'moderate'`;
 *  else `'none'`.
 *
 *  ⛔⛔ D-281 — THIS NO LONGER DECIDES ANYTHING. Severity comes from
 *  `proportionDriftSeverity`. Kept because the PSI scalar is still
 *  stored as a diagnostic and this is how it is bucketed for display,
 *  but a caller reaching for it to gate on is reaching for the
 *  statistic that measured a 14% false-positive rate at the old floors
 *  and 11.9% power on a doubling at the new ones. */
export const psiSeverity = (psi: number): DriftSeverity => {
  if (psi >= PSI_THRESHOLD_SIGNIFICANT) return 'significant';
  if (psi >= PSI_THRESHOLD_MODERATE) return 'moderate';
  return 'none';
};

// ────────────────────────────────────────────────────────────────
// Persistence shape
// ────────────────────────────────────────────────────────────────

/** Per-window summary attached to the persisted drift signal. Joined
 *  to make the window provenance visible in the drawer without a
 *  second query. */
export interface DriftWindow {
  start_at: number;
  end_at: number;
  sample_count: number;
}

/** The `confidence_drift_signal` value persisted under
 *  `data.enrichment.confidence_drift_signal.<source_topic>`. One row
 *  per AI-surface topic that emits `confidence: number` and has
 *  accumulated enough samples to clear the producer's floor. */
export interface ConfidenceDriftSignal {
  /** The AI-surface topic whose confidence distribution this signal
   *  measures. Stored as plain string at the schema layer; the
   *  producer guarantees membership in the registry's AI-surface
   *  set. */
  source_topic: string;
  /** PSI scalar — non-negative; ~0 when distributions match,
   *  unbounded as they diverge.
   *
   *  ⛔ D-281 — DIAGNOSTIC ONLY. `severity` is derived from `shift`, not
   *  from this. Retained because it is cheap, already on the wire, and
   *  a second view of the same windows is worth keeping while the new
   *  statistic accumulates history — but it decides nothing, and a
   *  surface that renders it beside a severity it did not produce is
   *  telling the reader the wrong story. */
  psi: number;
  /** D-281 — the two-proportion test on the low-confidence rate that
   *  DOES decide `severity`. Absent on rows written before D-281,
   *  which is "not recorded", never "no shift". */
  shift?: ProportionShift;
  /** D-283 — `shift.delta` alone.
   *
   *  ⛔ NOT REDUNDANT, AND THE REASON IS THE BANNER. A client that
   *  learns of a drift from the realtime event has only the narrow
   *  event payload and synthesises a `ConfidenceDriftSignal` from it.
   *  It cannot honestly build a `ProportionShift` — it has no rates,
   *  no n, no p-value — and inventing them to satisfy the shape would
   *  put fabricated statistics on a row. This field is the one number
   *  it genuinely knows, so the banner reads THIS and the drawer,
   *  which has the stored row, reads `shift`. */
  low_confidence_delta?: number;
  severity: DriftSeverity;
  baseline_window: DriftWindow;
  recent_window: DriftWindow;
  /** 10-bin histogram of confidence in the baseline window. Each
   *  entry is the proportion of samples in that bin (sums to 1.0). */
  baseline_distribution: ReadonlyArray<number>;
  recent_distribution: ReadonlyArray<number>;
  computed_at: number;
  /** D-279 — the distinct `model_id`s the two windows were computed
   *  over, sorted. A PSI number is only meaningful against a fixed
   *  producer; without this a reader cannot tell a real distribution
   *  shift from a config change. The producer WITHHOLDS a verdict
   *  entirely when the sets differ, so on a stored row this is one
   *  set — it is provenance for the row, not a comparison.
   *
   *  ⚠ ABSENT on rows written before D-279, which is "not recorded",
   *  never "no model". An empty array is a real answer: every sample
   *  carried a NULL `model_id`. */
  model_ids?: readonly string[];
  /** Set when the user dismissed the drift banner for the latest
   *  `(source_topic, severity-transition)` pair. Cleared on the next
   *  severity transition. Per D-133 decision §8 — kept
   *  on the row to avoid a parallel dismissal-tracking schema. */
  dismissed_at?: number;
}
