/** D-250 § D — run-scoped accumulation of provider token usage, so the run
 *  anchor can carry what the run SPENT alongside what it produced.
 *
 *  ⛔ WHY A SIDE CHANNEL RATHER THAN A RETURN VALUE. Usage does not come back
 *  from the AI adapter as data — it arrives on the `onTokenUsage` CALLBACK the
 *  LLM executor invokes after a provider result. There is no return path to
 *  thread it through, so something has to hold it between the call and the
 *  anchor write. This is that something, and it is deliberately the smallest
 *  possible one: an in-memory map, no store, no table, no new write.
 *
 *  ⛔⛔ AND THE SCOPE IS THE RUN, NOT THE STEP — measured against the obvious
 *  alternative and the opposite of where it first reads like it should go.
 *  Per-step attribution would need the callback to say WHICH step was in
 *  flight, and `prefetch.ts` runs prefetch steps CONCURRENTLY: a "current step"
 *  marker is correct only while execution is strictly sequential, and it is
 *  not. A run-keyed total is immune — every call adds to one bucket regardless
 *  of what else is running — and the anchor field is run-level anyway, so the
 *  narrower scope would buy an attribution nothing consumes and lose
 *  correctness for it.
 *
 *  ⚠ CAPPED, AND THE CAP IS LOAD-BEARING RATHER THAN DEFENSIVE. An entry is
 *  removed by {@link RunTokenUsageSink.take}, which the anchor write calls —
 *  but not every run reaches an anchor (an exception between the provider
 *  result and the write). Without a cap those entries accumulate for the life
 *  of the process. Eviction is oldest-first, and what it costs is one run's
 *  `total_usage` going absent, which is a state every reader already handles.
 *  ⛔ It must never throw or block: a statistics field may go missing; a run
 *  must not fail because of one. */

import { aggregateTokenUsageReports, type TokenUsageReport } from '@recued/contracts';

/** Live runs whose usage is retained before their anchor claims it.
 *
 *  Sized for "runs in flight plus the few that died before their anchor", not
 *  for history — nothing here is durable and nothing reads it twice. */
export const RUN_TOKEN_USAGE_MAX_ENTRIES = 256;

export interface RunTokenUsageSink {
  /** Fold one provider result into the run's total. Called once per provider
   *  call, from the AI adapter, after the call returned usage. */
  record(run_id: string, usage: TokenUsageReport): void;
  /** Read and REMOVE the run's total. Returns `undefined` when the run made no
   *  provider call — which is the common case and the reason the anchor field
   *  is omitted rather than zeroed. */
  take(run_id: string): TokenUsageReport | undefined;
  /** Entries currently retained. Test + diagnostics only. */
  size(): number;
}

export const createRunTokenUsageSink = (
  maxEntries: number = RUN_TOKEN_USAGE_MAX_ENTRIES,
): RunTokenUsageSink => {
  const totals = new Map<string, TokenUsageReport>();

  return {
    record(run_id, usage) {
      // ⚠ A run_id is required to attribute at all. A call arriving without
      // one (an out-of-tree dispatcher, a harness) is DROPPED rather than
      // bucketed under a placeholder key — a shared bucket would attribute one
      // run's spend to another, which is worse than not counting it.
      if (typeof run_id !== 'string' || run_id.length === 0) return;
      // ⛔ `aggregateTokenUsageReports` is the ONE summer. Adding the fields by
      // hand here would be a second implementation of `provider_calls`'
      // absent-counts-as-one rule, and the two would drift.
      const next = aggregateTokenUsageReports(totals.get(run_id), usage);
      if (next === undefined) return;
      // Re-insert so the map's insertion order tracks RECENCY, not first
      // touch — otherwise a long run that keeps spending is evicted ahead of a
      // finished one that never claimed its entry.
      totals.delete(run_id);
      totals.set(run_id, next);
      while (totals.size > maxEntries) {
        const oldest = totals.keys().next();
        if (oldest.done === true) break;
        totals.delete(oldest.value);
      }
    },

    take(run_id) {
      const usage = totals.get(run_id);
      if (usage !== undefined) totals.delete(run_id);
      return usage;
    },

    size() {
      return totals.size;
    },
  };
};
