/** D-133 — Population Stability Index for confidence drift detection.
 *
 *  Pure / portable / testable in isolation. The producer in
 *  `backend/server/src/housekeeping/producers/confidence-drift-signal.ts`
 *  + future UI logic + tests share this module. Spec:
 *  `docs/d-133-spec.md`. */

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

/** Map a PSI scalar to its severity bucket per the mining-standard
 *  thresholds. `>= 0.25` → `'significant'`; `>= 0.10` → `'moderate'`;
 *  else `'none'`. */
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
   *  unbounded as they diverge. */
  psi: number;
  severity: DriftSeverity;
  baseline_window: DriftWindow;
  recent_window: DriftWindow;
  /** 10-bin histogram of confidence in the baseline window. Each
   *  entry is the proportion of samples in that bin (sums to 1.0). */
  baseline_distribution: ReadonlyArray<number>;
  recent_distribution: ReadonlyArray<number>;
  computed_at: number;
  /** Set when the user dismissed the drift banner for the latest
   *  `(source_topic, severity-transition)` pair. Cleared on the next
   *  severity transition. Per `docs/d-133-spec.md` decision §8 — kept
   *  on the row to avoid a parallel dismissal-tracking schema. */
  dismissed_at?: number;
}
