/** RUNG 4's write side — embed the owner's memory pool, on the owner's say-so.
 *
 *  `memory.search` falls through to a cosine scan when no lexical rung matched,
 *  but that scan needs a vector per entry. Nothing produced them until this
 *  task: `embedBacklog` existed, was resumable, was tested, and had NO CALLER —
 *  so `vectorCoverage()` was 0 on every real server and rung 4 permanently
 *  reported `not_embedded`. Built, typed, tested and unreachable.
 *
 *  ⛔ MANUAL ONLY, BY OWNER CHOICE. `idle_eligible: false` keeps it off every
 *  idle cycle; it fires from Run-Now and nowhere else. This is not caution for
 *  its own sake — the task spends embedding tokens per entry, and a pool import
 *  of 500 Q&As is 500 provider calls. The owner sees the cost preview and
 *  presses the button, or it does not run.
 *
 *  ⚠ THE FLAG ONLY WORKS BECAUSE THIS COMMIT MADE IT WORK. `isEligibleForIdleCycle`
 *  returned a bare `true` for every non-enrichment task, so `idle_eligible: false`
 *  was dead on a core task — the exact field this task depends on, silently
 *  ignored for the exact kind of task it was written for. Do not register a
 *  token-spending core task assuming the flag holds; assert it.
 *
 *  ⚠ NOT AN ENRICHMENT PRODUCER. It writes no `data_enrichment` row and claims
 *  no topic — the pool's vectors live in `user_memory_vec` beside the pool.
 *  Housekeeping is used here purely as the scheduler for a resumable,
 *  interruptible, token-spending backlog. */

import type { HousekeepingCursor, HousekeepingStepResult } from '@recued/contracts';

import type { HousekeepingContext, HousekeepingTaskInstance } from '../registry.js';
import { createMemoryEmbedder } from '../../memory-embedder.js';

export const MEMORY_EMBED_BACKLOG_TASK_ID = 'memory-embed-backlog';

/** Entries embedded per `step()`. Small because each is a provider round-trip:
 *  the step returns `'yield'` while work remains, so the scheduler re-enters
 *  with a fresh budget rather than one call blocking a whole cycle. */
export const MEMORY_EMBED_BATCH = 25;

/** Per-entry token estimate for the Run-Now cost preview. Embeddings have no
 *  decode side, so this is input-only and deliberately generous — a preview
 *  that under-promises is the one the owner can trust. */
export const MEMORY_EMBED_TOKEN_ESTIMATE = 250;

export const memoryEmbedBacklogTask: HousekeepingTaskInstance = {
  meta: {
    id: MEMORY_EMBED_BACKLOG_TASK_ID,
    description:
      'Embed memory entries so recall can find them by meaning when the words differ. '
      + 'Costs one embedding call per entry — runs only when you press Run now.',
    interruptible: true,
    kind: 'core',
    // ⛔ Load-bearing: without this the task would embed the whole pool on the
    // first idle cycle after boot, unasked.
    idle_eligible: false,
    tags: ['kind:core', 'domain:memory', 'surface:ai'],
  },
  is_ai_surface: true,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    const store = ctx.userMemoryStore;
    const embedder = createMemoryEmbedder(
      ctx.embed === undefined
        ? undefined
        : (manifest, input) => ctx.embed!(manifest, input),
    );
    // No pool, or no embeddings path (the pure-Anthropic case). Complete rather
    // than yield: re-entering would fail identically every cycle, and a task
    // that can never progress must not look like one making progress.
    if (store === undefined || embedder === undefined) {
      return { status: 'complete', cursor: { kind: 'complete' } };
    }

    const result = await store.embedBacklog(embedder, { limit: MEMORY_EMBED_BATCH });

    // ⚠ YIELD ONLY ON PROGRESS. If every entry in the batch failed — quota
    // exhausted, provider down — `remaining` is still positive, and yielding
    // would spin the same doomed batch for the rest of the cycle. Completing
    // leaves the backlog for the next Run-Now, when the cause may be gone.
    const madeProgress = result.embedded > 0;
    return madeProgress && result.remaining > 0
      ? { status: 'yield', reason: 'budget_exhausted', cursor: { kind: 'index', collection: 'user_memory', offset: 0 } }
      : { status: 'complete', cursor: { kind: 'complete' } };
  },
};
