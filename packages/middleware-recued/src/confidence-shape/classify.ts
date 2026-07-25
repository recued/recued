/** D-137 P3 § A.5 — Confidence-shape dispatch classifier.
 *
 *  Pure function that consumes a sorted-by-similarity candidate list
 *  and returns one of four discrete patterns the chat agent loop uses
 *  to drive disambiguation UX. The spec is explicit that the user-
 *  facing surface is **threshold-free**: Mary never sees a confidence
 *  knob to tune. The thresholds below are *implementation parameters
 *  owned by the dispatch function*; they may be calibrated from
 *  telemetry without changing user-visible behaviour.
 *
 *  Four patterns per § A.5:
 *
 *    | Pattern | Distribution shape           | UX                              |
 *    |--------|-------------------------------|---------------------------------|
 *    | 1      | Single high, others low       | Execute silently; alternatives  |
 *    |        |                               | available but hidden            |
 *    | 2      | Single high, some close       | Optimistic execute with         |
 *    |        |                               | alternatives visible            |
 *    | 3      | All low (none dominant)       | Refuse to guess; show           |
 *    |        |                               | possibilities                   |
 *    | 4      | Empty after exhausting        | Refuse cleanly OR fall through  |
 *    |        | authorized sources            | to recipe execution             |
 *
 *  Internal numeric measures per the spec ("margin between top-1 and
 *  top-2, ratio of top-1 to mean, entropy of the candidate
 *  distribution, sample-count floors"):
 *
 *    - **DOMINANT_SCORE**     — min `score` for the top candidate to
 *      be considered "high"; below this, every candidate is "low" by
 *      construction.
 *    - **DOMINANT_MARGIN**    — min gap between top-1's score and the
 *      next-highest score. When met → Pattern 1 (silent execute).
 *      When unmet but top-1 is still ≥ `DOMINANT_SCORE` → Pattern 2
 *      (optimistic execute with alternatives).
 *    - **LOW_FLOOR**          — score below which a candidate counts
 *      as "low" for Pattern 3 detection. When every candidate is
 *      below this AND there are ≥2 plausible candidates → Pattern 3
 *      (refuse).
 *    - **TIEBREAK_EPSILON**   — score equality tolerance for the
 *      recency tiebreak. When |s_i - s_j| ≤ EPSILON, the recency
 *      resolver decides ordering; otherwise raw score wins.
 *
 *  Recency tiebreak (§ A.5 row 2 of the auxiliary table):
 *
 *    > When candidates are otherwise close in similarity, prefer the
 *    > most recent (last interaction, last updated). Most human
 *    > queries refer to recent context; this aligns the heuristic
 *    > with the data.
 *
 *  Implemented as an optional `recencyKey: (item: T) => number`. When
 *  provided, the classifier first sorts by score, then for adjacent
 *  pairs within `TIEBREAK_EPSILON` swaps in favor of higher
 *  `recencyKey`. Callers without a recency dimension omit the option;
 *  raw score ordering wins.
 *
 *  Pure: no I/O, no clock, no shared state. Same input → same output.
 *  Sample-floor handling: an empty candidate list always returns
 *  Pattern 4 regardless of thresholds (Pattern 4 is "empty after
 *  exhausting authorized sources" per the spec). A single-candidate
 *  input collapses to Pattern 1 iff score ≥ `DOMINANT_SCORE`,
 *  otherwise Pattern 3 (single weak candidate is still ambiguous —
 *  the agent shouldn't silently commit to a guess that even the
 *  scoring model isn't confident in). */

/** § A.5 — internal threshold parameters. NOT a user surface (the
 *  spec is explicit: "users never see a 'confidence threshold' knob
 *  whose behavior changes per-user"). Calibration is the dispatch
 *  function's concern; future telemetry-driven retuning happens here
 *  without UX impact. */
export const CONFIDENCE_DOMINANT_SCORE = 0.7 as const;
export const CONFIDENCE_DOMINANT_MARGIN = 0.2 as const;
export const CONFIDENCE_LOW_FLOOR = 0.5 as const;
export const CONFIDENCE_TIEBREAK_EPSILON = 0.05 as const;

/** § A.5 — pattern discriminator. Closed list per spec. */
export type ConfidencePattern = 1 | 2 | 3 | 4;

/** § A.5 — pattern-1: single high, others low. The agent executes
 *  silently using `top`; `alternatives` are accessible behind a
 *  "see other matches" affordance but not surfaced inline. */
export interface ConfidenceShapePattern1<T> {
  pattern: 1;
  top: T;
  alternatives: ReadonlyArray<T>;
  /** Internal numeric snapshot for transparency / telemetry. Never
   *  user-surfaced; flows to the audit row + § B.8 transparency
   *  stream so calibration can be tuned without re-instrumenting. */
  measures: ConfidenceMeasures;
}

/** § A.5 — pattern-2: single high, some close. The agent executes
 *  optimistically using `top` but renders `close` as visible
 *  alternatives ("I'm guessing Peter A — [answer]. Other Peters: B,
 *  C — click to redo"). */
export interface ConfidenceShapePattern2<T> {
  pattern: 2;
  top: T;
  close: ReadonlyArray<T>;
  alternatives: ReadonlyArray<T>;
  measures: ConfidenceMeasures;
}

/** § A.5 — pattern-3: all low. The agent refuses to commit; renders
 *  `candidates` as disambiguation chips (≤5 named) OR an open
 *  question when ambiguity is more abstract. The renderer reads
 *  `candidates.length` to decide. */
export interface ConfidenceShapePattern3<T> {
  pattern: 3;
  candidates: ReadonlyArray<T>;
  measures: ConfidenceMeasures;
}

/** § A.5 — pattern-4: empty. The agent refuses cleanly OR falls
 *  through to recipe execution (§ A.5 Pattern 4 row, § A.6, P3
 *  acceptance "empty-result-with-recipe-fallback"). The classifier
 *  itself only emits the discriminator; recipe matching is a
 *  separate `findRecipeFallback` pass. */
export interface ConfidenceShapePattern4 {
  pattern: 4;
  measures: ConfidenceMeasures;
}

/** § A.5 — internal numeric measures snapshot. Privacy invariant per
 *  PB7 § B.5.1: counts + ratios only; never candidate content. */
export interface ConfidenceMeasures {
  /** Number of input candidates (post-scoring, pre-classification). */
  candidate_count: number;
  /** Highest score in the input; `null` when input was empty OR no
   *  candidate carried a score. */
  top_score: number | null;
  /** Margin between top-1 and top-2 scores; `null` when fewer than
   *  two scored candidates. */
  top_margin: number | null;
  /** Arithmetic mean of all carried scores; `null` when no scored
   *  candidates. */
  mean_score: number | null;
}

/** § A.5 — discriminated union of every pattern outcome. */
export type ConfidenceShape<T> =
  | ConfidenceShapePattern1<T>
  | ConfidenceShapePattern2<T>
  | ConfidenceShapePattern3<T>
  | ConfidenceShapePattern4;

export interface ClassifyConfidenceShapeOptions<T> {
  /** Optional recency resolver. When provided, candidates within
   *  `CONFIDENCE_TIEBREAK_EPSILON` of each other in score are
   *  re-ordered so higher-recency wins. Callers without a recency
   *  dimension omit this option; raw score ordering applies. */
  recencyKey?: (item: T) => number;
  /** Override the dominant-score threshold. Production callers leave
   *  this undefined and inherit the substrate constant; tests pin
   *  for deterministic asserts. */
  dominantScore?: number;
  /** Override the dominant-margin threshold. Same caller posture. */
  dominantMargin?: number;
  /** Override the low-floor threshold. Same caller posture. */
  lowFloor?: number;
  /** Override the tiebreak epsilon. Same caller posture. */
  tiebreakEpsilon?: number;
}

/** § A.5 — one scored candidate. Input shape: caller passes raw
 *  `{ record, score? }` pairs (matching `ScopeSearchCandidate<T>`
 *  ergonomics so the chat-tool-handlers can call this with the
 *  fan-out envelope without remapping). */
export interface ScoredCandidate<T> {
  record: T;
  score?: number;
}

/** § A.5 — sort + tiebreak. Pure helper exported for callers that
 *  want the ordered list without the pattern dispatch (e.g. the
 *  compound-ambiguity cascade walks the sorted list directly).
 *  Stable: ties not within `epsilon` preserve input order. */
export const sortByScoreWithRecency = <T>(
  candidates: ReadonlyArray<ScoredCandidate<T>>,
  options: { recencyKey?: (item: T) => number; tiebreakEpsilon?: number } = {},
): ReadonlyArray<ScoredCandidate<T>> => {
  const epsilon = options.tiebreakEpsilon ?? CONFIDENCE_TIEBREAK_EPSILON;
  const indexed = candidates.map((c, idx) => ({ c, idx }));
  indexed.sort((a, b) => {
    const sa = typeof a.c.score === 'number' ? a.c.score : -Infinity;
    const sb = typeof b.c.score === 'number' ? b.c.score : -Infinity;
    if (Math.abs(sa - sb) > epsilon) {
      return sb - sa;
    }
    // Within tiebreak window — recency wins if resolver provided.
    if (options.recencyKey) {
      const ra = options.recencyKey(a.c.record);
      const rb = options.recencyKey(b.c.record);
      if (Number.isFinite(ra) && Number.isFinite(rb) && ra !== rb) {
        return rb - ra;
      }
    }
    // Stable fallback — input order.
    return a.idx - b.idx;
  });
  return indexed.map((entry) => entry.c);
};

const summariseMeasures = <T>(
  candidates: ReadonlyArray<ScoredCandidate<T>>,
): ConfidenceMeasures => {
  let topScore: number | null = null;
  let runnerUp: number | null = null;
  let scoredCount = 0;
  let sum = 0;
  for (const c of candidates) {
    if (typeof c.score !== 'number' || !Number.isFinite(c.score)) continue;
    scoredCount += 1;
    sum += c.score;
    if (topScore === null || c.score > topScore) {
      runnerUp = topScore;
      topScore = c.score;
    } else if (runnerUp === null || c.score > runnerUp) {
      runnerUp = c.score;
    }
  }
  return {
    candidate_count: candidates.length,
    top_score: topScore,
    top_margin:
      topScore !== null && runnerUp !== null ? topScore - runnerUp : null,
    mean_score: scoredCount > 0 ? sum / scoredCount : null,
  };
};

/** § A.5 — main dispatcher. Returns the discriminated shape. The
 *  caller decides what to do with it (orchestrator stamps onto the
 *  result envelope; UI renders accordingly).
 *
 *  Dispatch ladder (in order):
 *
 *    1. **Empty input** → Pattern 4 (regardless of thresholds).
 *    2. Sort + tiebreak by recency. The top entry is the candidate
 *       the agent would pick.
 *    3. **Top is "high"** (score ≥ DOMINANT_SCORE):
 *       - top-margin ≥ DOMINANT_MARGIN → Pattern 1 (silent execute)
 *       - else → Pattern 2 (execute with close alternatives visible)
 *    4. **Top is not "high"** (score < DOMINANT_SCORE OR no score):
 *       - candidate_count ≥ 2 → Pattern 3 (refuse + show)
 *       - candidate_count = 1 → Pattern 3 with a single-candidate
 *         list (single weak match is still ambiguous; the agent
 *         shouldn't commit silently)
 *
 *  Unscored candidates (no `score` field) collapse to "not high" for
 *  Pattern decisions but still surface in `candidates` / `alternatives`
 *  for the UX. The classifier doesn't invent scores. */
export const classifyConfidenceShape = <T>(
  candidates: ReadonlyArray<ScoredCandidate<T>>,
  options: ClassifyConfidenceShapeOptions<T> = {},
): ConfidenceShape<T> => {
  if (candidates.length === 0) {
    return {
      pattern: 4,
      measures: summariseMeasures(candidates),
    };
  }

  const sorted = sortByScoreWithRecency(candidates, {
    ...(options.recencyKey ? { recencyKey: options.recencyKey } : {}),
    ...(options.tiebreakEpsilon !== undefined
      ? { tiebreakEpsilon: options.tiebreakEpsilon }
      : {}),
  });
  const measures = summariseMeasures(sorted);

  const dominantScore = options.dominantScore ?? CONFIDENCE_DOMINANT_SCORE;
  const dominantMargin = options.dominantMargin ?? CONFIDENCE_DOMINANT_MARGIN;

  const top = sorted[0]!;
  const topScore =
    typeof top.score === 'number' && Number.isFinite(top.score) ? top.score : null;
  const second = sorted[1];
  const secondScore =
    second && typeof second.score === 'number' && Number.isFinite(second.score)
      ? second.score
      : null;

  const topIsHigh = topScore !== null && topScore >= dominantScore;
  if (topIsHigh) {
    const margin =
      secondScore !== null && topScore !== null
        ? topScore - secondScore
        : Infinity;
    if (margin >= dominantMargin) {
      return {
        pattern: 1,
        top: top.record,
        alternatives: sorted.slice(1).map((c) => c.record),
        measures,
      };
    }
    // "Single high, some close" — the close set is the prefix of
    // sorted[1..] whose scores are within DOMINANT_MARGIN of top.
    const close: T[] = [];
    const alternatives: T[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const entry = sorted[i]!;
      const entryScore =
        typeof entry.score === 'number' && Number.isFinite(entry.score)
          ? entry.score
          : null;
      const closeEnough =
        entryScore !== null && topScore - entryScore < dominantMargin;
      if (closeEnough) {
        close.push(entry.record);
      } else {
        alternatives.push(entry.record);
      }
    }
    return {
      pattern: 2,
      top: top.record,
      close,
      alternatives,
      measures,
    };
  }

  // Pattern 3 — top is not "high"; refuse to guess.
  return {
    pattern: 3,
    candidates: sorted.map((c) => c.record),
    measures,
  };
};
