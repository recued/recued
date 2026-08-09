/** D-137 Trio #E — per-call token usage telemetry surfaced from the
 *  LLM layer through chat adapter results into the orchestrator.
 *
 *  Token-only by design. Cost ($) is intentionally NOT computed at
 *  this layer — rates drift, vary by pool / agreement, and each
 *  consumer (benchmark report, billing surface, audit log) may want
 *  to multiply the token counts by different sources of truth. Trio
 *  #E surfaces what was actually consumed; cost conversion is a
 *  report-time multiplication the consumer owns.
 *
 *  Fields are optional where providers don't expose them — only
 *  `input_tokens` / `output_tokens` / `total_tokens` are guaranteed
 *  populated (every adapter reports at minimum these three).
 *
 *  - `cache_read_input_tokens` — input tokens served from prompt
 *    cache. Anthropic exposes `usage.cache_read_input_tokens`;
 *    Gemini exposes `usageMetadata.cachedContentTokenCount`; OpenAI
 *    exposes `usage.prompt_tokens_details.cached_tokens`. Web-chat
 *    and free-pool entries that don't echo cache fields leave this
 *    undefined.
 *  - `cache_write_input_tokens` — input tokens spent CREATING the
 *    cache entry (Anthropic-specific surcharge; absent on other
 *    providers).
 *  - `reasoning_tokens` — extended-thinking / o1-reasoning output
 *    tokens. Anthropic includes thinking blocks in `output_tokens`
 *    already and does NOT expose a separate `reasoning_tokens`
 *    field (the `model_hint: 'thinking'` hint enables thinking but
 *    the counts roll up into output). OpenAI's o1 family exposes
 *    `usage.completion_tokens_details.reasoning_tokens` as a
 *    SUBSET of `completion_tokens`. Gemini's thinking models
 *    expose `usageMetadata.thoughtsTokenCount` similarly. The
 *    field semantics are "thinking output", treated as a subset
 *    of `output_tokens` — consumers that want non-thinking output
 *    compute `output_tokens - (reasoning_tokens ?? 0)`.
 *  - `model_id` — the resolved provider model id (e.g.
 *    `'claude-opus-4-7'`, `'gemini-2.0-pro'`, `'gpt-4o-mini'`).
 *    Same value the executor passed to the adapter's `slot.model`.
 *    Lets the benchmark + report-time cost compute disambiguate
 *    when a pool entry round-robins across multiple models.
 *  - `attribution` — slot / pool source identity so
 *    per-source rollups can compute "how much Mary spent on her
 *    free-pool Groq entries vs her BYOK Claude slot" without
 *    re-deriving from the executor side-channel.
 *
 *  D-137 Trio #E surface: every chat AI call returns
 *  `{ ..., usage? }`. Post-D-164 P6.3 the chat orchestrator owns the
 *  main-turn call directly (`executeAiCall` returns the usage report
 *  on the wrapped `executeLLM` response); per-call accumulation
 *  through `aggregateTokenUsageReports` in `chat-orchestrator.ts`'s
 *  tool loop produces the per-turn aggregate. Cost-ceiling enforcement
 *  (PB4) is ORTHOGONAL to this surface — PB4 uses static
 *  `TIER_ESTIMATED_COST_CENTS` for pre-flight ceiling checks; it
 *  does not consult per-call token counts. Trio #E is reporting-
 *  only telemetry. */

export interface TokenUsageReport {
  /** Input (prompt) tokens charged. Always populated. */
  readonly input_tokens: number;
  /** Output (completion) tokens charged. Always populated. Includes
   *  reasoning tokens when present (consumers subtract
   *  `reasoning_tokens` for non-thinking output). */
  readonly output_tokens: number;
  /** `input_tokens + output_tokens`. Cache + reasoning are subsets,
   *  not separate additive lines. Always populated. */
  readonly total_tokens: number;
  /** Input tokens served from prompt cache (Anthropic / Gemini /
   *  OpenAI cache hits). Subset of `input_tokens`. Absent when the
   *  provider doesn't expose a cache count or when no cache was
   *  used. */
  /** How many PROVIDER CALLS this report aggregates.
   *
   *  ⛔ WITHOUT THIS THE AGGREGATE IS UNATTRIBUTABLE. A turn emits ONE
   *  `recued.token_usage` carrying the sum across every call it made, so
   *  "one expensive call" and "three cheap ones" arrive identical. The
   *  long-conversation lane exists to detect a packet that GROWS with
   *  conversation length, and it read a turn at 10,706 input tokens against a
   *  flat ~5,300 baseline as 2.06x growth — when the likeliest reading is two
   *  calls of ~5,300 each, because the model chose to use a tool on that turn
   *  and not on the others. Same measure, opposite conclusions, no way to tell.
   *
   *  ⚠ COUNTS THE CALLS WHOSE TOKENS ARE IN THESE TOTALS, not calls attempted.
   *  A call that THREW produced no usage report, so it contributes neither
   *  tokens nor a count — a turn that called twice and lost one to a context
   *  overflow reports 1. That keeps the count and the sums describing the same
   *  set of calls, which is the only way per-call arithmetic means anything.
   *
   *  Absent on reports that predate this field or come from a path that does
   *  not count; a consumer should read `?? 1` for a single provider result and
   *  make no claim at all for an aggregate. */
  readonly provider_calls?: number;
  readonly cache_read_input_tokens?: number;
  /** Input tokens spent CREATING a cache entry. Anthropic-specific
   *  (`usage.cache_creation_input_tokens`). Subset of `input_tokens`. */
  readonly cache_write_input_tokens?: number;
  /** Reasoning / thinking output tokens. Subset of `output_tokens`.
   *  OpenAI o1: `completion_tokens_details.reasoning_tokens`.
   *  Gemini thinking: `usageMetadata.thoughtsTokenCount`. Anthropic
   *  thinking is INCLUDED in `output_tokens` without a separate
   *  count; the field stays undefined for Anthropic responses. */
  readonly reasoning_tokens?: number;
  /** Resolved provider model id the call hit. E.g.
   *  `'claude-opus-4-7'`, `'gemini-2.0-pro'`, `'gpt-4o-mini'`. */
  readonly model_id?: string;
  /** Source attribution — slot / pool — so per-source
   *  rollups stay accurate without re-deriving. Same union the
   *  packages/llm executor stamps on its internal `TokenUsage`. */
  readonly attribution?: TokenUsageAttribution;
}

/** Source discriminator. Mirrors `packages/llm`'s
 *  `TokenUsageAttribution` but lives in contracts so engine /
 *  backend / report layers can consume without importing from
 *  packages/llm. */
export type TokenUsageAttribution =
  | { readonly kind: 'slot'; readonly slot_key: 'slot_1' | 'slot_2' }
  | { readonly kind: 'pool'; readonly entry_id: string };

/** Pure aggregator. Sums two `TokenUsageReport`s field-wise. Used
 *  by the orchestrator to fold per-call usage into a running
 *  `total_usage` across the multi-round chat tool loop.
 *
 *  Optional fields stay optional in the aggregate: when EITHER
 *  input has the field populated (treated as 0 when undefined on
 *  the other side), the output carries the sum; when BOTH are
 *  undefined, the output stays undefined (so a chat session that
 *  never hit a cache doesn't carry a `cache_read_input_tokens: 0`
 *  field that misleads the reader into thinking the field was
 *  populated-and-zero).
 *
 *  `model_id` + `attribution` drop on aggregation — the
 *  aggregate represents the sum across heterogeneous sources, so
 *  no single id / attribution applies. Reports that need per-
 *  source breakdown should aggregate within a partition (group by
 *  attribution / model_id first, sum within each group). */
export const aggregateTokenUsageReports = (
  prev: TokenUsageReport | undefined,
  next: TokenUsageReport | undefined,
): TokenUsageReport | undefined => {
  if (prev === undefined && next === undefined) return undefined;
  // ⛔ NORMALISE THE SINGLE-REPORT PATHS, or the count is absent in exactly the
  // case that establishes the baseline. These early returns handed the report
  // back untouched, so a turn making ONE provider call — the overwhelming
  // majority — reported no `provider_calls` at all, and only multi-call turns
  // carried a number. A consumer comparing "1 call" against "absent" cannot
  // tell a quiet turn from an unannotated one, which is the ambiguity this
  // field exists to remove. Caught by running the long-conversation lane: it
  // printed `calls=?` on 14 of 14 turns.
  if (prev === undefined) return { ...next!, provider_calls: next!.provider_calls ?? 1 };
  if (next === undefined) return { ...prev, provider_calls: prev.provider_calls ?? 1 };
  const sumOpt = (a: number | undefined, b: number | undefined): number | undefined => {
    if (a === undefined && b === undefined) return undefined;
    return (a ?? 0) + (b ?? 0);
  };
  const cache_read = sumOpt(prev.cache_read_input_tokens, next.cache_read_input_tokens);
  const cache_write = sumOpt(prev.cache_write_input_tokens, next.cache_write_input_tokens);
  const reasoning = sumOpt(prev.reasoning_tokens, next.reasoning_tokens);
  // ⚠ A report with no `provider_calls` counts as ONE call, not zero — every
  // report that reaches here came from a provider result. Defaulting to 0 would
  // make an aggregate of two un-annotated reports claim it covered no calls,
  // which is worse than the ambiguity this field exists to remove.
  const calls = (prev.provider_calls ?? 1) + (next.provider_calls ?? 1);
  return {
    input_tokens: prev.input_tokens + next.input_tokens,
    output_tokens: prev.output_tokens + next.output_tokens,
    total_tokens: prev.total_tokens + next.total_tokens,
    provider_calls: calls,
    ...(cache_read !== undefined ? { cache_read_input_tokens: cache_read } : {}),
    ...(cache_write !== undefined ? { cache_write_input_tokens: cache_write } : {}),
    ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
  };
};
