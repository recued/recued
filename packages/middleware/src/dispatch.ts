/** D-160 amendment (D-164 § 6) — concurrent tool-call dispatch primitive.
 *
 *  When the LLM emits multiple `tool_use` blocks in one turn response,
 *  the framework can dispatch them in parallel — but only when every
 *  emitted call's tool declares `concurrency_safe: true`. Any
 *  `concurrency_safe: false` in the batch collapses the whole batch to
 *  sequential dispatch in emit order.
 *
 *  Bench-validated (D-164 § 6): ~40% token savings on multi-hop
 *  episodes (v5d 7.4K batched vs 12.5K sequential); explicit
 *  `tool_calls` array protocol shipped in the bench's `compose-agent.ts`;
 *  observed adoption 6/20 episodes on smoke (full-scale adoption rate
 *  ~30-40% expected). The framework owns the strategy + scheduling; the
 *  caller (the chat orchestrator in `backend/server/`) supplies the
 *  per-call `concurrency_safe` flag from whatever surface knows about
 *  the tool — `InternalToolRegistry.getByName(name).concurrency_safe`
 *  for registry-sourced calls (Tier 1 / Tier 2 / Tier 3),
 *  `EnrichmentDeclaration.concurrency_safe` for enrichment producers.
 *
 *  **Result-collecting both modes.** The primitive uses
 *  `Promise.allSettled`-shaped collection in parallel mode and a
 *  per-call try/catch in sequential mode; neither mode fail-fasts.
 *  The LLM observes per-tool outcomes (succeeded / failed) and reasons
 *  about the batch as a whole — bailing on the first failure would
 *  leave subsequent independent tools un-attempted, which is worse for
 *  multi-hop UX than collecting every result and handing the LLM the
 *  full picture.
 *
 *  Why a separate framework primitive vs the executor doing it inline:
 *  the executor is wired by callers (`backend/server/` to `@recued/llm`,
 *  tests to a stub). Centralising the parallel-vs-sequential decision
 *  here keeps the rule in one place — when the bench's adoption rate
 *  changes or a future failure mode argues for fail-fast in one mode,
 *  the seam to amend is exactly one file. The executor's job stays "run
 *  the AI call + hand the resulting tool_uses to the framework
 *  primitive."
 *
 *  Spec: D-164 § 6
 *  (Batch tool calling — framework affordance); D-160
 *  (the framework the primitive ships into). */

/** A single tool_use the framework should dispatch. The framework treats
 *  `payload` as opaque — caller-defined, threaded through to
 *  `executeOne` unchanged. `concurrency_safe` is the per-call gate that
 *  drives the strategy decision.
 *
 *  Source of truth for `concurrency_safe`:
 *    - **Enrichment producers** — `EnrichmentDeclaration.concurrency_safe`
 *      (D-164 P3; warehouse reads default `true`; future rate-limited
 *      producers may declare `false`).
 *    - **Tier 1 chat primitives** — `ToolEntry.concurrency_safe` projected
 *      from `TIER1_CONCURRENCY_SAFE` (every `*.search` declares `true`;
 *      `recipe.run` umbrella declares `false`).
 *    - **Tier 2 recipe entries** — `ToolEntry.concurrency_safe` from
 *      `buildTier2ToolEntry` (classification `'unknown'` → `false`;
 *      mutation recipes through the D-157 gateway can't race their own
 *      side-effects).
 *    - **Tier 3 vendor APIs** — `ToolEntry.concurrency_safe` from
 *      `buildTier3ToolEntry` (defaults `false`; future per-vendor
 *      override hook on `ConnectionMcpToolOverride`). */
export interface DispatchableToolCall<T> {
  readonly concurrency_safe: boolean;
  readonly payload: T;
}

/** Per-call outcome. Discriminated by `ok` so consumers can pattern-
 *  match without `instanceof` checks on the error class — the framework
 *  treats `error` as opaque (the caller's `executeOne` defines what
 *  shape it throws). */
export type ToolCallResult<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly error: unknown };

/** Strategy the primitive selected for the batch. `'empty'` is the
 *  vacuous case (caller handed zero calls — the result list is empty).
 *  `'parallel'` fires every call concurrently; `'sequential'` fires
 *  them one at a time in input order. */
export type ToolDispatchStrategy = 'parallel' | 'sequential' | 'empty';

export interface ToolCallDispatchInput<T, R> {
  /** The tool_use batch as emitted by the LLM, in emit order. The
   *  primitive preserves order in the returned `results` regardless of
   *  strategy. */
  readonly calls: ReadonlyArray<DispatchableToolCall<T>>;
  /** Per-call execution. The caller's TurnExecutor wraps the actual
   *  tool dispatch (registry lookup, gateway, audit emit, etc.); the
   *  framework primitive just decides ordering + collects results.
   *  Sync throws are treated as async rejects via the
   *  `Promise.resolve().then(() => executeOne(...))` wrapping. */
  readonly executeOne: (payload: T) => Promise<R>;
}

export interface ToolCallDispatchOutput<R> {
  /** Strategy actually used. Useful for transparency-stream emission
   *  ("ran 3 tools in parallel") + tests that pin behaviour by mode. */
  readonly strategy: ToolDispatchStrategy;
  /** Per-call outcomes in input order. Length matches `calls.length`. */
  readonly results: ReadonlyArray<ToolCallResult<R>>;
}

/** Decide strategy + dispatch a batch of tool_use calls.
 *
 *  Strategy decision:
 *    - `calls.length === 0`            → `'empty'`, no results.
 *    - every call `concurrency_safe`   → `'parallel'`, `Promise.allSettled`.
 *    - any call NOT `concurrency_safe` → `'sequential'`, one-by-one.
 *
 *  Result collection:
 *    - Parallel: fulfilment → `{ ok: true, value }`; rejection →
 *      `{ ok: false, error }`. Order preserved from `calls`.
 *    - Sequential: each call awaited inside a try/catch; failures are
 *      collected the same way and the loop continues to the next call.
 *      No fail-fast — the LLM observes the full batch outcome.
 *
 *  Sync executeOne throws are caught + surfaced as rejected results.
 *  Both `Promise.resolve(...).then` (parallel) and try/catch around the
 *  awaited promise (sequential) convert a synchronous throw to an
 *  async rejection before observation, so the result shape is uniform. */
export const dispatchToolCalls = async <T, R>(
  input: ToolCallDispatchInput<T, R>,
): Promise<ToolCallDispatchOutput<R>> => {
  const { calls, executeOne } = input;

  if (calls.length === 0) {
    return { strategy: 'empty', results: [] };
  }

  const allSafe = calls.every((call) => call.concurrency_safe === true);

  if (allSafe) {
    // Wrap each `executeOne` invocation in `Promise.resolve().then(...)`
    // so a sync throw lands on the promise chain as a rejection rather
    // than escaping the `map` synchronously and short-circuiting the
    // batch. `Promise.allSettled` then collects every outcome in order.
    const settled = await Promise.allSettled(
      calls.map((call) =>
        Promise.resolve().then(() => executeOne(call.payload)),
      ),
    );
    const results = settled.map((outcome): ToolCallResult<R> =>
      outcome.status === 'fulfilled'
        ? { ok: true, value: outcome.value }
        : { ok: false, error: outcome.reason },
    );
    return { strategy: 'parallel', results };
  }

  const results: ToolCallResult<R>[] = [];
  for (const call of calls) {
    try {
      const value = await executeOne(call.payload);
      results.push({ ok: true, value });
    } catch (error) {
      results.push({ ok: false, error });
    }
  }
  return { strategy: 'sequential', results };
};
