/** D-150 — extraction support facade for `recued-bench`.
 *
 *  This file is intentionally dependency-free. It carries only the
 *  small routing / standing-instruction support surface that D-150 needs
 *  from `recued-plan.ts` and `contact-identity.ts`, without pulling the
 *  full Plan IR, contact alias resolver, warehouse, audit, or privacy
 *  substrate into the standalone benchmark wrapper.
 *
 *  If one of these closed lists changes in the source contracts, update
 *  this facade in the same commit; the D-150 facade ratchet test checks
 *  lockstep against the canonical source modules. */

export const D150_BENCH_SUPPORT_CONTRACT_VERSION = '1.0.0' as const;

// ── Minimal contact-property support for standing instructions ──────

export const CONTACT_IDENTITY_STATUSES = [
  'mention_only',
  'partial',
  'verified',
] as const;
export type ContactIdentityStatus = (typeof CONTACT_IDENTITY_STATUSES)[number];
export const CONTACT_IDENTITY_STATUS_SET: ReadonlySet<ContactIdentityStatus> =
  new Set(CONTACT_IDENTITY_STATUSES);

export const NETWORK_DOMAINS = [
  'family',
  'work',
  'social',
  'other',
] as const;
export type NetworkDomain = (typeof NETWORK_DOMAINS)[number];
export const NETWORK_DOMAIN_SET: ReadonlySet<NetworkDomain> = new Set(NETWORK_DOMAINS);

// ── Minimal Plan IR support for routing / trace contracts ──

export const OMISSION_REASON_CODES = [
  'privacy_class',
  'token_budget',
  'permission_scope',
  'recency_filter',
  'hallucination_risk',
  'cost_tier',
  'capacity_gap',
  'duplication',
] as const;
export type OmissionReasonCode = (typeof OMISSION_REASON_CODES)[number];
export const OMISSION_REASON_CODE_SET: ReadonlySet<OmissionReasonCode> =
  new Set(OMISSION_REASON_CODES);

export const NARROWING_REASON_CODES = [
  'topic_mismatch',
  'intent_kind_incompatible',
  'low_confidence',
  'cap_exceeded',
  'standing_instruction',
  'privacy_class',
  'tier3_disabled',
  'intent_kind_gate',
  'kind_gated',
] as const;
export type NarrowingReasonCode = (typeof NARROWING_REASON_CODES)[number];
export const NARROWING_REASON_CODE_SET: ReadonlySet<NarrowingReasonCode> =
  new Set(NARROWING_REASON_CODES);

export const CLASSIFICATION_INTENT_KINDS = [
  'commitment_extract',
  'task_extract',
  'recipe_action',
  'query',
  'chat_only',
] as const;
export type ClassificationIntentKind = (typeof CLASSIFICATION_INTENT_KINDS)[number];
export const CLASSIFICATION_INTENT_KIND_SET: ReadonlySet<ClassificationIntentKind> =
  new Set(CLASSIFICATION_INTENT_KINDS);

export type ContextBreadth = 'narrow' | 'wide';
export const CONTEXT_BREADTHS: ReadonlyArray<ContextBreadth> = [
  'narrow',
  'wide',
];

export const MODEL_TIERS = [
  'fast',
  'mid',
  'reasoning',
] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const MODEL_TIER_SET: ReadonlySet<ModelTier> = new Set(MODEL_TIERS);

export interface ContextSelectionToolsTrace {
  tier1_selected_count: number;
  tier1_selected_ids: string[];
  tier2_selected_count: number;
  tier2_selected_ids: string[];
  tier2_dropped_count: number;
  tier2_dropped_reasons: Partial<Record<NarrowingReasonCode, number>>;
  tier3_selected_count: number;
  tier3_selected_ids: string[];
  tier3_dropped_count: number;
  tier3_dropped_reasons: Partial<Record<NarrowingReasonCode, number>>;
}

export interface ContextSelectionTrace {
  recipe_candidates_considered: number;
  recipe_candidates_selected: string[];
  recipe_candidates_dropped: Array<{
    recipe_slug: string;
    reason_code: NarrowingReasonCode;
  }>;

  commitment_context_pulled: boolean;
  commitment_rows_count: number;

  // D-164 P6.7 — catalog-assembly snapshot replaces `stage1_*` echo.
  catalog_section_counts: Readonly<Record<string, number>>;
  catalog_short_circuited: boolean;

  tools?: ContextSelectionToolsTrace;
}

// ── D-137 Trio #E follow-on — report-time token cost compute ────────

/** Closed list of token-rate slots the cost-compute helper recognises.
 *  Mirrors the optional fields on `TokenUsageReport` plus the two
 *  mandatory ones. Bench callers supply per-slot $/Mtok (or any unit
 *  they like — the helper is unit-agnostic; output unit = input unit).
 *
 *  - `input` / `output` — always required (every adapter reports them).
 *  - `cache_read` — Anthropic / OpenAI / Gemini cache hits. Typically
 *    discounted (~10–50% of `input` rate).
 *  - `cache_write` — Anthropic-specific cache-create surcharge
 *    (typically ~125% of `input` rate).
 *  - `reasoning` — OpenAI o1 + Gemini thinking output. Subset of
 *    `output` already counted; pass a SEPARATE rate (often higher) and
 *    the helper bills reasoning at that rate while billing the
 *    non-reasoning portion (`output - reasoning`) at `output` rate.
 *    Anthropic rolls thinking into `output_tokens` without surfacing
 *    a separate count, so the field is absent there and the whole
 *    `output_tokens` value bills at `output` rate. */
export const BENCH_TOKEN_RATE_KEYS = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'reasoning',
] as const;
export type BenchTokenRateKey = (typeof BENCH_TOKEN_RATE_KEYS)[number];
export const BENCH_TOKEN_RATE_KEY_SET: ReadonlySet<BenchTokenRateKey> =
  new Set(BENCH_TOKEN_RATE_KEYS);

/** Caller-supplied rates. The helper multiplies `rate × token_count`
 *  directly — the rate MUST be expressed as **cost-per-single-token**
 *  in whatever unit the caller cares about (cents, dollars, sats…).
 *
 *  Published provider rates are typically quoted per Mtok (per
 *  million tokens). Convert before passing:
 *
 *    // Anthropic Claude Opus quoted at $15 / Mtok input + $75 / Mtok output
 *    const rates: BenchTokenRates = {
 *      input: 15 / 1_000_000,   // = 15e-6 USD/token
 *      output: 75 / 1_000_000,  // = 75e-6 USD/token
 *    };
 *    const usdCost = computeBenchTokenCost(usage, rates);
 *
 *  Codex Trio #E follow-on P2 fold #1 — passing the raw Mtok number
 *  (e.g. `{ input: 15 }`) against a 1M-token usage row would return
 *  15_000_000, not 15. Caller-side scaling discipline matters; the
 *  helper does not auto-detect units. */
export interface BenchTokenRates {
  /** Cost per single input token. */
  readonly input: number;
  /** Cost per single output token. */
  readonly output: number;
  /** Cost per single cache-read input token. Defaults to `input` rate. */
  readonly cache_read?: number;
  /** Cost per single cache-write input token (Anthropic-specific
   *  cache-create surcharge). Defaults to `input` rate. */
  readonly cache_write?: number;
  /** Cost per single reasoning / thinking output token. Defaults to
   *  `output` rate. */
  readonly reasoning?: number;
}

/** Token usage shape the helper accepts. Duck-types
 *  `TokenUsageReport` so bench callers can pass a row read from the
 *  audit log without importing the full report type. */
export interface BenchTokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_write_input_tokens?: number;
  readonly reasoning_tokens?: number;
}

/** Pure per-row cost compute. Multiplies each token bucket by its
 *  matching rate; cache + reasoning buckets fall through to `input` /
 *  `output` rates when the caller didn't supply a per-bucket rate
 *  (matches the contract that cache ⊂ input + reasoning ⊂ output, so
 *  unspecified rates default to the parent bucket's rate).
 *
 *  Semantics:
 *    - `non_cached_input = input_tokens - cache_read - cache_write`
 *      (NEVER negative — caller's responsibility to keep the contract
 *      `cache ⊂ input`; the helper Math.max-floors to 0).
 *    - `non_reasoning_output = output_tokens - reasoning`.
 *    - `cost = non_cached_input × input_rate
 *            + cache_read × (cache_read_rate ?? input_rate)
 *            + cache_write × (cache_write_rate ?? input_rate)
 *            + non_reasoning_output × output_rate
 *            + reasoning × (reasoning_rate ?? output_rate)`
 *
 *  All inputs are required to be finite non-negative numbers — the
 *  helper does not validate (it's intended to run on validated bench
 *  rows). Bench-side callers responsible for sanitation. */
export const computeBenchTokenCost = (
  usage: BenchTokenUsage,
  rates: BenchTokenRates,
): number => {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_write_input_tokens ?? 0;
  const reasoning = usage.reasoning_tokens ?? 0;
  const nonCachedInput = Math.max(0, usage.input_tokens - cacheRead - cacheWrite);
  const nonReasoningOutput = Math.max(0, usage.output_tokens - reasoning);
  const cacheReadRate = rates.cache_read ?? rates.input;
  const cacheWriteRate = rates.cache_write ?? rates.input;
  const reasoningRate = rates.reasoning ?? rates.output;
  return (
    nonCachedInput * rates.input
    + cacheRead * cacheReadRate
    + cacheWrite * cacheWriteRate
    + nonReasoningOutput * rates.output
    + reasoning * reasoningRate
  );
};
