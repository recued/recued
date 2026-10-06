// D-181 Slice 2 — the engine-side glue for the long-op lane governor.
//
// Every ingredient invocation on the primary step/prefetch path funnels through
// `invokeGoverned`: it classifies the call by ingredient kind, acquires a lane
// slot from `ctx.laneGovernor` (or the no-op governor when none is wired), runs
// the call **inline, awaited**, and releases the slot on settle (success OR
// failure OR crash — the slot-leak correctness-must). See D-181 §5.
//
// Scope (slice 2): this covers the dominant heavy case — `service`-kind
// ingredients (docling/ffmpeg/whisper) on the `local-heavy` lane, dispatched via
// `ctx.ingredientExecutor` from step-runner + prefetch. The D-165 catalog-gateway
// dispatch path (`catalog-gateway.ts`) is deliberately NOT governed here: its
// `ctx.ingredientExecutor` calls are REST/api pagination (`external-io`, high-N,
// low urgency) and its subprocess path runs through a separate
// `cliInvocationExecutor`. Governing the catalog path is a documented follow-up.

import {
  callClassForKind,
  FAST_LANE_MAX_DURATION_MS,
  isGatedCallClass,
  NO_OP_LANE_GOVERNOR,
  type CallClass,
} from '@recued/contracts';
import type { StepMeta, StepOptions } from '@recued/contracts';
import type { ExecutionContext } from './types.js';
import { requireRecipe } from './require-recipe.js';

/** Resolve a slug's governance class from its manifest.
 *
 *  An explicit `fast_path: true` manifest bypasses the semaphore regardless of
 *  kind (D-181 §3d — the curated opt-out for a known-cheap op the publish-gate
 *  walk can't *prove* cheap). Otherwise the call class is the static op-kind
 *  classification.
 *
 *  A kind that can't be resolved (no `manifestGetter` — dbless tests, where no
 *  governor is wired anyway) defaults to `external-io`: the *default-gated*
 *  classification (§3d — misclassification fails safe), and the cheaper lane to
 *  gate into since it never throttles in practice. On the server the manifest
 *  is always resolvable, so real classification always happens. */
export const resolveCallClass = (ctx: ExecutionContext, slug: string): CallClass => {
  const manifest = ctx.manifestGetter?.(slug);
  if (manifest?.fast_path === true) return 'fast-path';
  const kindClass = manifest?.kind ? callClassForKind(manifest.kind) : 'external-io';
  // D-181 §10 — duration-threshold demotion (default-gated). A GATED-kind op that
  // has only ever completed quickly (worst successful run < the threshold) skips
  // the lane. An unknown op (no record) or a once-slow op keeps its gated kind
  // class — the safe direction: over-gating a fast op just briefly holds a slot
  // the lane drains fast, whereas wrongly bypassing a heavy op risks unbounded
  // concurrency. `ai-governor` / `fast-path` are never demoted (already bypass).
  if (isGatedCallClass(kindClass)) {
    const maxMs = ctx.opDurationClassifier?.recordedMaxMs(slug);
    if (maxMs !== undefined && maxMs < FAST_LANE_MAX_DURATION_MS) return 'fast-path';
  }
  return kindClass;
};

/** Wrap a single ingredient invocation in a lane-governor slot.
 *
 *  `fast-path` / `ai-governor` classes and inherited same-lane requests get a
 *  `lane: null` lease and bypass the semaphore. A gated class waits for a slot
 *  first (queueing if its lane is full), then runs the call inline. The slot is
 *  released in `finally` with the settle outcome — a thrown error keeps the
 *  default `failed` (and re-throws), a clean return reports `succeeded`. */
export const invokeGoverned = async (
  ctx: ExecutionContext,
  slug: string,
  input: Record<string, unknown>,
  output: Record<string, string> | undefined,
  stepOptions: StepOptions | undefined,
  stepMeta: StepMeta | undefined,
): Promise<unknown> => {
  const recipe = requireRecipe(ctx);
  const governor = ctx.laneGovernor ?? NO_OP_LANE_GOVERNOR;
  const lease = await governor.acquire({
    call_class: resolveCallClass(ctx, slug),
    descriptor: {
      recipe_id: recipe.recipe_id,
      slug,
      // D-181 slice 4 — run_id + step_id let the active list group a run's
      // heavy calls and the registry map a kill/cancel back to the run.
      ...(ctx.run_id !== undefined ? { run_id: ctx.run_id } : {}),
      ...(stepMeta?.step_id !== undefined ? { step_id: stepMeta.step_id } : {}),
    },
    ...(ctx.heldLanes ? { held_lanes: ctx.heldLanes } : {}),
    // D-181 slice 4 — killing the run aborts its queued (not-yet-dispatched)
    // heavy calls; a running subprocess is SIGKILLed out-of-band by the registry.
    ...(ctx.runAbortSignal ? { signal: ctx.runAbortSignal } : {}),
  });
  let outcome: 'succeeded' | 'failed' = 'failed';
  // D-181 §10 — measure the CALL time (after the slot is acquired, so queue-wait
  // is excluded) to feed the duration-threshold classifier. Recorded only on a
  // clean settle below.
  const callStart = Date.now();
  try {
    // D-181 slice 4 — a kill that landed while this call queued for a slot must
    // not now dispatch a fresh side effect.
    if (ctx.runAbortSignal?.aborted) throw new RunKilledError();
    const dispatch = () => ctx.ingredientExecutor(slug, input, output, stepOptions, stepMeta);
    const result = ctx.reviewedExecution
      ? await ctx.reviewedExecution.invoke({ slug, input, output, catalog: false, connection_name: '', stepMeta,
        ...(stepOptions?.pii_fields !== undefined ? { pii_fields: stepOptions.pii_fields } : {}) }, dispatch)
      : await dispatch();
    // A kill that landed DURING this call: the in-flight call already ran (there
    // is no mid-flight cancel — "no mid-flight LLM abort"), but the run MUST NOT
    // proceed to later steps. Fail this step so the engine halts; the result is
    // discarded (the late outcome is tombstoned, never re-applied).
    if (ctx.runAbortSignal?.aborted) throw new RunKilledError();
    outcome = 'succeeded';
    return result;
  } finally {
    lease.release(outcome);
    // D-181 §10 — record a SUCCESSFUL call's duration so the next time this op
    // dispatches the classifier can demote it to the fast lane if it stays fast.
    // Never recorded on a failure / kill (a truncated duration would wrongly
    // demote a slow op) — so an op that never succeeds fast stays gated.
    if (outcome === 'succeeded') {
      ctx.opDurationClassifier?.record(slug, Date.now() - callStart);
    }
  }
};

/** Thrown by `invokeGoverned` when the run's kill signal aborted around a gated
 *  call — the run is halted at the step boundary (D-181 §7). The audit anchor
 *  reads `killed` from the in-flight registry regardless of this error's type;
 *  the distinct class only keeps the halt legible in logs. */
export class RunKilledError extends Error {
  readonly code = 'run_killed';
  constructor() {
    super('run killed by the owner via the live active-list');
    this.name = 'RunKilledError';
  }
}

/** Fail a draining engine at the next safe step/protocol boundary after the
 * host has abandoned the caller-facing await. This never cancels an upstream
 * AI inference; it only prevents its late value from advancing the killed run. */
export const throwIfRunKilled = (ctx: Pick<ExecutionContext, 'runAbortSignal'>): void => {
  if (ctx.runAbortSignal?.aborted) throw new RunKilledError();
};
