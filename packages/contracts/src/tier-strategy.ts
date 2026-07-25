/** D-145 PB4 — tier strategy substrate.
 *
 *  Per § B.3 (AI-tier-aware composition) + § B.15.10 (cost ceiling
 *  demote/halt) + § C.3.6 (per-tier latency / cost ceilings).
 *  Closed-list constants + pure helpers; no IO, no behavior. The
 *  middleware tier-strategy layer
 *  (`packages/middleware-recued/src/tier-strategy/`) composes these
 *  primitives into `selectSynthesisTier`, packet-shape budget
 *  enforcement, and mid-flight cost-ceiling demotion.
 *
 *  Naming discipline: `ModelTier` (`'fast' | 'mid' | 'reasoning'`) is
 *  the closed list that flows from `RecuedRequest.model_hint` through
 *  `RecuedPlan.model_tier`. PB4 adds the *rank* (0/1/2 ordering),
 *  *budget shape* (per-tier packet bytes + alternative count + round
 *  count + token cost ceiling), and *demotion policy* (one-step
 *  reasoning → mid → fast) — all pinned at substrate level so engine
 *  + tests + Plan IR audit replay agree on the same constants.
 *
 *  Spec: D-145 § B.3 + § B.15.10 + § C.3.6. */

import type { ModelTier } from './recued-plan.js';
import { MODEL_TIERS, MODEL_TIER_SET } from './recued-plan.js';

// ── PB4.1 — Tier rank ───────────────────────────────────────────────

/** Monotonic rank — `fast` is cheapest, `reasoning` strongest. The
 *  rank scaffolds tier-comparison helpers (`tierAtLeast`,
 *  `nextLowerTier`) without leaking ordinal arithmetic into call
 *  sites. */
export const TIER_RANK: { readonly [K in ModelTier]: number } = Object.freeze({
  fast: 0,
  mid: 1,
  reasoning: 2,
});

export const TIER_BY_RANK: ReadonlyArray<ModelTier> = Object.freeze([
  'fast',
  'mid',
  'reasoning',
]);

/** Pure compare. Returns the higher (stronger) of the two tiers — the
 *  per-request `model_hint` raises floor ("if modelHint set → tier =
 *  highestOf(tier, modelHint)"). */
export const highestTier = (a: ModelTier, b: ModelTier): ModelTier =>
  TIER_RANK[a] >= TIER_RANK[b] ? a : b;

/** Pure compare. Returns the lower (cheaper) of the two tiers. */
export const lowestTier = (a: ModelTier, b: ModelTier): ModelTier =>
  TIER_RANK[a] <= TIER_RANK[b] ? a : b;

/** Pure compare. True iff `tier` is at least as strong as `floor`. */
export const tierAtLeast = (tier: ModelTier, floor: ModelTier): boolean =>
  TIER_RANK[tier] >= TIER_RANK[floor];

/** Returns the next-lower tier or `null` when already at floor. */
export const nextLowerTier = (tier: ModelTier): ModelTier | null => {
  const r = TIER_RANK[tier];
  return r > 0 ? TIER_BY_RANK[r - 1]! : null;
};

// ── PB4.2 — Per-tier packet shape budget ────────────────────────────

/** Per § B.3.1 — packet shape per tier. Engine narrows context to the
 *  tier's budget BEFORE invoking `ai.synthesize`; over-budget packets
 *  fail packet-shape validation rather than silently truncating
 *  (truncation hides what was dropped from the audit trail). */
export interface TierPacketBudget {
  /** Max serialized packet bytes flowing into `ai.synthesize`. § B.3.1
   *  table: fast ≤ 1KB, mid ≤ 8KB, reasoning ≤ 32KB. */
  readonly max_packet_bytes: number;
  /** Max alternatives the engine includes in the AI packet (the
   *  fixed_slots-respecting set per § B.6). § B.3.1 table: fast 1-2,
   *  mid 3-5, reasoning 5-8. PB4 ships the upper bound; lower-bound
   *  guidance is non-enforced. */
  readonly max_alternatives: number;
  /** Max synthesis rounds per turn at this tier. § B.3.1 table:
   *  typically 1 for fast, 1-2 for mid, 2-3 for reasoning. PB4 enforces
   *  the upper bound; the orchestrator widens the multi-round policy
   *  later. */
  readonly max_rounds: number;
}

export const TIER_PACKET_BUDGETS: { readonly [K in ModelTier]: TierPacketBudget } =
  Object.freeze({
    fast: Object.freeze({ max_packet_bytes: 1_024, max_alternatives: 2, max_rounds: 1 }),
    mid: Object.freeze({ max_packet_bytes: 8_192, max_alternatives: 5, max_rounds: 2 }),
    reasoning: Object.freeze({
      max_packet_bytes: 32_768,
      max_alternatives: 8,
      max_rounds: 3,
    }),
  });

// ── PB4.3 — Per-tier latency + token cost ceilings (§ C.3.6) ─────────

/** P50 / P95 wall-clock + token cost ceilings per tier. Substrate-
 *  pinned so PB4 demotion logic + tier selection + PC3
 *  benchmark scoring + Plan IR replay all agree on the same numbers.
 *  Wall-clock is engine-attributable (excludes bridge wait); token
 *  cost is the cumulative `ai.synthesize` budget per request. */
export interface TierLatencyCeiling {
  readonly p50_wall_clock_ms: number;
  readonly p95_wall_clock_ms: number;
  readonly p50_token_cost: number;
  readonly p95_token_cost: number;
}

export const TIER_LATENCY_CEILINGS: { readonly [K in ModelTier]: TierLatencyCeiling } =
  Object.freeze({
    fast: Object.freeze({
      p50_wall_clock_ms: 800,
      p95_wall_clock_ms: 1_500,
      p50_token_cost: 800,
      p95_token_cost: 2_000,
    }),
    mid: Object.freeze({
      p50_wall_clock_ms: 2_000,
      p95_wall_clock_ms: 4_000,
      p50_token_cost: 4_000,
      p95_token_cost: 10_000,
    }),
    reasoning: Object.freeze({
      p50_wall_clock_ms: 8_000,
      p95_wall_clock_ms: 20_000,
      p50_token_cost: 16_000,
      p95_token_cost: 50_000,
    }),
  });

// ── PB4.4 — Per-tier estimated marginal cost (cents) ─────────────────

/** Conservative estimate of the marginal cost (in cents) of running a
 *  *single* `ai.synthesize` call at each tier. Used by
 *  `downgradeIfOverBudget` to decide whether the next call would
 *  exceed `budget.cost_ceiling_cents`. PB4 ships pessimistic numbers
 *  so demotion fires before the actual call lands; no live caller swaps in
 *  provider-specific accounting yet (`packages/llm` carries the precise
 *  per-model rates).
 *
 *  Numbers chosen from p95 token-cost × Anthropic-tier-equivalent
 *  blended pricing (rough): fast ≈ Haiku ($0.25 in/$1.25 out per
 *  MTok); mid ≈ Sonnet ($3 in/$15 out); reasoning ≈ Opus thinking
 *  ($15 in/$75 out). Per-call estimate assumes 50/50 input/output
 *  mix at the p95 token ceiling. */
export const TIER_ESTIMATED_COST_CENTS: { readonly [K in ModelTier]: number } =
  Object.freeze({
    fast: 1, // ~$0.01 — Haiku at 2k token p95
    mid: 8, // ~$0.08 — Sonnet at 10k token p95
    reasoning: 70, // ~$0.70 — Opus thinking at 50k token p95
  });

// ── PB4.5 — selectSynthesisTier inputs / outputs ─────────────────────

/** Standing Instruction tier bounds per § B.11 — `min_tier` raises
 *  floor, `max_tier` lowers ceiling. Substrate validator catches
 *  `min_tier > max_tier` as `standing_instruction_conflict` (§ B.15.8). */
export interface SiTierBounds {
  readonly min_tier?: ModelTier;
  readonly max_tier?: ModelTier;
}

/** Per-request budget signal — `remaining_cents` is the headroom
 *  before the per-request cost ceiling; `cost_ceiling_cents` is the
 *  ceiling itself (typically derived from D-132 daily-budget config
 *  per § B.3.2 rule 3). Both fields are optional to ease unit-test
 *  setup; engine production callers always populate them. */
export interface TierBudget {
  readonly remaining_cents: number;
  readonly cost_ceiling_cents: number;
}

/** Discriminated union over the result of `selectSynthesisTier`. The
 *  orchestrator policy maps `'halt'` outcomes to the matching
 *  `PlanStatus` (`cancelled_si_conflict` for tier-bound conflict,
 *  `cancelled_cost_ceiling` for budget exhaustion). */
export type SelectSynthesisTierResult =
  | {
      readonly kind: 'ok';
      readonly tier: ModelTier;
      /** Tier that the caller-supplied baseline produced, before
       *  `modelHint` raise / SI clamp / budget downgrade. Useful for
       *  Plan IR audit + Transparency Stream replay. D-164 P6.2: the
       *  baseline is `sessionPref ?? channelDefault`. */
      readonly baseline_tier: ModelTier;
      /** Tier that survived the SI clamp + modelHint raise. Can
       *  differ from `tier` after budget downgrade. */
      readonly clamped_tier: ModelTier;
      /** Whether the modelHint actually raised the baseline. */
      readonly hint_raised: boolean;
      /** Whether the SI clamp narrowed (raised floor or lowered
       *  ceiling) the resolved tier. */
      readonly si_clamped: boolean;
      /** Number of one-step demotions applied by the budget walker
       *  (0 when the clamped tier fits the budget). */
      readonly demotion_steps: number;
    }
  | {
      readonly kind: 'halt';
      readonly reason: 'standing_instruction_conflict' | 'cost_ceiling_min_floor' | 'cost_ceiling_no_lower';
      readonly detail: string;
      /** When the halt is `'cost_ceiling_*'`, the tier the budget
       *  walker was unable to demote past. */
      readonly halted_at_tier?: ModelTier;
    };

// ── PB4.7 — clampToBounds (pure) ────────────────────────────────────

/** Apply SI bounds to a candidate tier. Returns `null` when bounds
 *  conflict (`min_tier > max_tier`); orchestrator maps to
 *  `cancelled_si_conflict` per § B.15.8.
 *
 *  Behavior:
 *    - `min_tier = 'reasoning'` → tier raised to `reasoning` regardless
 *      of input
 *    - `max_tier = 'fast'` → tier lowered to `fast` regardless of input
 *    - both set + `min > max` → null (conflict)
 *    - bounds undefined → returns input tier unchanged */
export const clampToBounds = (
  tier: ModelTier,
  bounds: SiTierBounds,
): ModelTier | null => {
  const { min_tier, max_tier } = bounds;
  if (
    min_tier !== undefined
    && max_tier !== undefined
    && TIER_RANK[min_tier] > TIER_RANK[max_tier]
  ) {
    return null;
  }
  let result: ModelTier = tier;
  if (min_tier !== undefined && TIER_RANK[result] < TIER_RANK[min_tier]) {
    result = min_tier;
  }
  if (max_tier !== undefined && TIER_RANK[result] > TIER_RANK[max_tier]) {
    result = max_tier;
  }
  return result;
};

// ── PB4.8 — downgradeIfOverBudget (pure) ────────────────────────────

/** Result of the budget-aware downgrade walker. */
export type DowngradeResult =
  | {
      readonly kind: 'ok';
      readonly tier: ModelTier;
      /** Demotions applied (0 when input tier fits budget). */
      readonly steps: number;
    }
  | {
      readonly kind: 'halt';
      readonly reason: 'cost_ceiling_min_floor' | 'cost_ceiling_no_lower';
      readonly halted_at_tier: ModelTier;
    };

/** Per § B.15.10 budget downgrade:
 *    - if `tier`'s estimated cost > `remaining_cents`, demote one level
 *      (reasoning → mid → fast)
 *    - if already at `fast` AND still over budget → halt with
 *      `cost_ceiling_no_lower`
 *    - if `siBounds.min_tier` prevents further demotion below floor →
 *      halt with `cost_ceiling_min_floor`
 *
 *  PB4 estimates cost via `TIER_ESTIMATED_COST_CENTS[tier]`; no live
 *  caller swaps in provider-specific accounting yet, though `packages/llm` carries
 *  per-model rates. The optional `costFor` override lets callers
 *  supply per-tier marginal-cost estimates that account for the
 *  specific request shape (e.g. token packet size × per-model rates) —
 *  the walker uses the override at every step, so demotion decisions
 *  reflect the caller's actual budget rather than the substrate
 *  default. When `costFor(tier)` returns a non-finite value the
 *  walker falls back to `TIER_ESTIMATED_COST_CENTS[tier]` for that
 *  step (defensive — never let a misbehaving caller stall the walker).
 *
 *  Pure function — no side effects; PB4 mid-flight cost-ceiling
 *  ratchet (`packages/middleware-recued/src/tier-strategy/cost-ceiling.ts`)
 *  calls this at each synthesis-round boundary. */
export const downgradeIfOverBudget = (
  tier: ModelTier,
  budget: TierBudget,
  bounds: SiTierBounds = {},
  costFor?: (tier: ModelTier) => number,
): DowngradeResult => {
  let current = tier;
  let steps = 0;
  // Defensive bound — TIER_BY_RANK has length === MODEL_TIERS.length,
  // so the walker terminates within that many iterations. The +1
  // covers the final "current === fast and still over budget" check.
  const maxIterations = TIER_BY_RANK.length + 1;
  for (let i = 0; i < maxIterations; i++) {
    const overrideCost = costFor?.(current);
    const estimate =
      overrideCost !== undefined && Number.isFinite(overrideCost) && overrideCost >= 0
        ? overrideCost
        : TIER_ESTIMATED_COST_CENTS[current];
    if (budget.remaining_cents >= estimate) {
      return { kind: 'ok', tier: current, steps };
    }
    // Already at the SI min_tier floor — cannot go lower.
    if (bounds.min_tier !== undefined && TIER_RANK[current] <= TIER_RANK[bounds.min_tier]) {
      return {
        kind: 'halt',
        reason: 'cost_ceiling_min_floor',
        halted_at_tier: current,
      };
    }
    const lower = nextLowerTier(current);
    if (lower === null) {
      return {
        kind: 'halt',
        reason: 'cost_ceiling_no_lower',
        halted_at_tier: current,
      };
    }
    current = lower;
    steps += 1;
  }
  // Defensive — should be unreachable. Fail closed by halting at the
  // current tier rather than looping forever.
  return {
    kind: 'halt',
    reason: 'cost_ceiling_no_lower',
    halted_at_tier: current,
  };
};

// ── PB4.9 — Validator: TIER_RANK / MODEL_TIERS in lockstep ──────────

/** Substrate self-check: every `ModelTier` in `MODEL_TIERS` MUST have
 *  a matching `TIER_RANK` entry; every `TIER_RANK` rank MUST be in
 *  `[0, MODEL_TIERS.length)`. PB4 ratchet test asserts; the
 *  in-module `assertTierStrategyInvariants` is a defensive runtime
 *  check the orchestrator could call at boot. */
export const assertTierStrategyInvariants = (): void => {
  for (const tier of MODEL_TIERS) {
    if (!(tier in TIER_RANK)) {
      throw new Error(`TIER_RANK missing entry for '${tier}'`);
    }
    if (!(tier in TIER_PACKET_BUDGETS)) {
      throw new Error(`TIER_PACKET_BUDGETS missing entry for '${tier}'`);
    }
    if (!(tier in TIER_LATENCY_CEILINGS)) {
      throw new Error(`TIER_LATENCY_CEILINGS missing entry for '${tier}'`);
    }
    if (!(tier in TIER_ESTIMATED_COST_CENTS)) {
      throw new Error(`TIER_ESTIMATED_COST_CENTS missing entry for '${tier}'`);
    }
  }
  for (let i = 0; i < TIER_BY_RANK.length; i++) {
    const tier = TIER_BY_RANK[i]!;
    if (TIER_RANK[tier] !== i) {
      throw new Error(`TIER_BY_RANK[${i}]='${tier}' but TIER_RANK['${tier}']=${TIER_RANK[tier]}`);
    }
    if (!MODEL_TIER_SET.has(tier)) {
      throw new Error(`TIER_BY_RANK[${i}]='${tier}' is not in MODEL_TIER_SET`);
    }
  }
};
