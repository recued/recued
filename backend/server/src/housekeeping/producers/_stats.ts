/** Shared statistical helpers for housekeeping producers.
 *
 *  Lifted at A.20 — `percentile` had two callers (`reply_patterns`,
 *  `connection_health_trend`) and A.20 was the third per the codebase
 *  convention (extract on the third caller).
 *
 *  Nearest-rank percentile is the right shape for the producers' use
 *  cases (small sample sizes, integer ranks). All callers had identical
 *  semantics — empty input returns null, quantile clamped to [0, 1],
 *  rank = ceil(q * n), guarded against the 0th-percentile-on-empty
 *  edge case. Centralising means the same numerical contract applies
 *  to every percentile field across the producer surface. */

/** Nearest-rank percentile over a pre-sorted array. `samples` MUST
 *  already be sorted ASC. Returns null when the input is empty.
 *  Quantile is in [0, 1]; clamped just in case a future caller passes
 *  something out-of-range.
 *
 *  Math: `rank = max(1, ceil(q * n))`. The `max(1, …)` guards against
 *  `ceil(0 * n) = 0` so the 0th-percentile-on-non-empty input still
 *  returns `samples[0]`. The `?? null` final guard never triggers on
 *  well-sorted input but keeps the type narrow. */
export const percentile = (
  samples: ReadonlyArray<number>,
  q: number,
): number | null => {
  if (samples.length === 0) return null;
  const clamped = q <= 0 ? 0 : q >= 1 ? 1 : q;
  const rank = Math.max(1, Math.ceil(clamped * samples.length));
  return samples[rank - 1] ?? null;
};
