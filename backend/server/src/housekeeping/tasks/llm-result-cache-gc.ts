/** D-145 § A.7.10 follow-on — `llm-result-cache-gc` housekeeping task.
 *
 *  Walks `llm_result_cache` rows and drops any whose `result_path` no
 *  longer resolves to a current enrichment row.
 *
 *  Why a scheduled sweep when the lookup hot-path already lazy-deletes?
 *  The lookup invariant (§ A.7.10) only fires for inputs the engine
 *  actually re-queries. Cache entries for one-shot LLM calls (forwarded
 *  mail chains the user never opens again, signature blocks from a
 *  contact who later got merged away, etc.) become orphaned when the
 *  universal cleanup (§ A.7.9) deletes the underlying enrichment row
 *  via a forward-walk null-cleanup or cascade source-delete — and the
 *  cache table can grow unbounded with rows that will never be touched
 *  by another lookup. This task closes the leak.
 *
 *  Cursor: `{ kind: 'complete' }` — `gcDanglingRefs` walks the full
 *  table in one pass and returns the row count; there's no useful
 *  cursor to persist between runs. Budget-yield is opt-out — the
 *  underlying primitive doesn't take a row limit, and the per-row
 *  cost is a single SQLite point lookup (~µs) so a 10K-row cache
 *  resolves well inside any realistic budget. A future refactor that
 *  needs row-by-row budgeting would extend the store primitive with a
 *  `limit?` argument; not warranted today.
 *
 *  No `onInvalidate` — dangling refs accumulate naturally with daily
 *  enrichment GC. Nothing about a single source-record write produces
 *  a dangling ref the scheduler needs to surface immediately; the next
 *  idle cycle picks the residue up.
 *
 *  No-op when `ctx.llmResultCache` is absent (tests, harnesses without
 *  the PA9.6 cache substrate wired). Symmetric with the producer
 *  wrapper's cache-miss-on-undefined behavior — degrade cleanly rather
 *  than throw at use-site.
 *
 *  Spec: `docs/d-145-spec.md` § A.7.10 (cache substrate) +
 *  [[project_handover_2026_05_26_d145_a79_pa9_6_pa9_7_landed]] (PA9.6
 *  landing memo, scheduled-gc called out as deferred follow-on).
 */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';
import { LLM_RESULT_CACHE_GC_TASK_ID } from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

import { readEnrichmentValueFromPath } from '../llm-result-cache-store.js';

export const llmResultCacheGcTask: HousekeepingTaskInstance = {
  meta: {
    id: LLM_RESULT_CACHE_GC_TASK_ID,
    description:
      'Drop llm_result_cache rows whose result_path no longer resolves to an enrichment row (cleanup residue from forward-walk null-cleanup + cascade source-delete that lookup hot-path lazy-delete misses).',
    interruptible: true,
    kind: 'core',
    tags: ['kind:core', 'domain:enrichment', 'surface:deterministic'],
  },

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    // Substrate not wired — fresh boots without the PA9.6 cache table
    // + harness tests without `llmResultCache` on ctx. Same cache-miss-
    // on-undefined invariant as `runAIProducer`'s cache lookup branch.
    if (!ctx.llmResultCache) {
      return { status: 'complete', cursor: { kind: 'complete' } };
    }

    const { rows_deleted } = ctx.llmResultCache.gcDanglingRefs({
      resolvePathExists: (path) =>
        // `readEnrichmentValueFromPath` returns null for three distinct
        // dangling cases: malformed path (schema drift), unknown topic
        // (registry retraction), and "no row at this path" (the
        // actual GC target). Treating all three as "dangling" is
        // correct — none can serve a cache hit.
        readEnrichmentValueFromPath(ctx.enrichmentStore, path) !== null,
    });

    if (rows_deleted > 0) {
      ctx.emitAuditRow({
        ts: ctx.now(),
        event_at: ctx.now(),
        action: 'llm_result_cache_gc',
        target: '',
        run_mode: 'live',
        detail: { rows_deleted },
      });
    }

    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};
