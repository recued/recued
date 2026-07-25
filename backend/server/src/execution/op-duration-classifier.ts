// D-181 §10 — the duration-threshold classifier (server-side, in-memory).
//
// The simple, default-gated refinement of the static op-kind classification
// (`resolveCallClass`): an op (manifest slug) that has only ever completed
// quickly (worst successful call < `FAST_LANE_MAX_DURATION_MS`) is demoted to
// the fast lane; an unknown or once-slow op stays gated by its kind. A
// precaution, not a precise cost model — over-gating a fast op is harmless (the
// lane drains fast), so the default is always to gate, and only a proven-fast op
// earns the bypass.
//
// State is a per-process `Map<slug, worst-ms>` (sticky-max): once an op runs
// at/over the threshold it stays gated even after a later fast run, and a restart
// re-gates everything until each op re-proves itself fast. No persistence, no
// audit query — the "log" is just the running max of successful call durations,
// fed by the engine's `invokeGoverned` on each clean settle.

import type { OpDurationClassifier } from '@recued/contracts';

/** Construct the server's singleton op-duration classifier. */
export const createOpDurationClassifier = (): OpDurationClassifier => {
  const worstMsBySlug = new Map<string, number>();
  return {
    recordedMaxMs(slug) {
      return worstMsBySlug.get(slug);
    },
    record(slug, durationMs) {
      // Ignore a non-finite / negative sample defensively (a clock skew should
      // never demote an op); keep the per-slug maximum.
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      const prev = worstMsBySlug.get(slug);
      if (prev === undefined || durationMs > prev) worstMsBySlug.set(slug, durationMs);
    },
  };
};
