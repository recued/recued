/** D-316 amendment (2026-10-06) — the whole-warehouse known-value matcher a
 *  recipe's `content` PII tags are matched against, built at most ONCE PER RUN.
 *
 *  Every `content`-tagged call — a `pii-protect` step, an `ai-*` step's
 *  `llm.pii_fields` — used to build its own matcher, reading every contact and
 *  CRM-mirror name: measured ~20 ms and ~7 MB at 10,000 contacts, ~110 ms and
 *  ~36 MB at 50,000. Once auto-PII started adding content tags on its own, a
 *  per-item AI step over many items paid that per item. The run is the scope,
 *  as the turn is for the chat (its egress plan memoizes the same builder per
 *  turn): every call in one run shares one matcher.
 *
 *  ⚠ THE TRADE, accepted by the owner when asking for this: a contact added
 *  after a run's first content-tagged call is not matched by that run's later
 *  calls. The next run sees it.
 *
 *  ⛔ A DEGRADED MATCHER IS NEVER REUSED. The resolver's `isDegraded` is sticky
 *  (`chat-recall-index.ts`): one failed read — at build, or a per-text phone
 *  lookup later — marks it for good. Reused, one transient store error would
 *  fail every later content call of the run; instead the call that saw it
 *  fails closed (it does, by the resolver's own rule) and the next one builds
 *  afresh.
 *
 *  Lifecycle mirrors `run-token-usage.ts`: keyed by `run_id`, released at the
 *  run's terminal end (`releaseRunResources`, the handler's outer `finally`),
 *  and CAPPED for the runs that never get there. Unlike the token sink, an
 *  entry here is large, so the cap is small and covers runs in flight; an
 *  evicted run only builds again. */

import type { PiiKnownValueSource } from '@recued/transforms';

/** Runs whose matcher is retained at once. ~36 MB each at 50,000 contacts. */
export const RUN_KNOWN_VALUES_MAX_RUNS = 4;

export interface RunKnownValues {
  /** The run's matcher getter, handed to the engine context and the AI adapter:
   *  it builds on its first call and returns that matcher to every later call of
   *  the run. A call with no run id gets the plain builder — matched per call,
   *  as before, never under a shared key. */
  forRun(run_id: string | undefined): () => PiiKnownValueSource | undefined;
  /** Drop the run's matcher. Called at the run's terminal end; idempotent. */
  release(run_id: string): void;
  /** Runs currently retained. Test + diagnostics only. */
  size(): number;
}

export const createRunKnownValues = (
  build: () => PiiKnownValueSource | undefined,
  maxRuns: number = RUN_KNOWN_VALUES_MAX_RUNS,
): RunKnownValues => {
  const byRun = new Map<string, PiiKnownValueSource>();

  const matcherFor = (run_id: string): PiiKnownValueSource | undefined => {
    const kept = byRun.get(run_id);
    byRun.delete(run_id);
    if (kept !== undefined && !kept.isDegraded()) {
      byRun.set(run_id, kept); // re-insert: insertion order tracks recency
      return kept;
    }
    const built = build();
    if (built === undefined) return undefined;
    byRun.set(run_id, built);
    while (byRun.size > maxRuns) {
      const oldest = byRun.keys().next();
      if (oldest.done === true) break;
      byRun.delete(oldest.value);
    }
    return built;
  };

  return {
    forRun(run_id) {
      if (typeof run_id !== 'string' || run_id.length === 0) return build;
      return () => matcherFor(run_id);
    },
    release(run_id) {
      byRun.delete(run_id);
    },
    size: () => byRun.size,
  };
};
