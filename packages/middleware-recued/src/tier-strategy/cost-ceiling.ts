/** D-145 PB4 — mid-flight cost ceiling enforcement.
 *
 *  Per § B.15.10. After the initial `selectSynthesisTier` choice, the
 *  cumulative cost (`total_cost_cents` in the Plan IR) may approach
 *  the per-request budget ceiling as the orchestrator dispatches
 *  multi-turn rounds. PB4 ships:
 *
 *    - `evaluateCostCeiling` — pure pre-flight check ahead of the
 *      next `ai.synthesize` call. Returns `'ok'` when the
 *      next call fits, `'demote'` with the new tier when one-step
 *      demotion (reasoning → mid → fast) would fit, or `'halt'` when
 *      neither the current tier nor any lower tier within SI bounds
 *      would fit.
 *    - `applyCostCeiling` — convenience wrapper that derives the
 *      `cost_ceiling.demoted` / `cost_ceiling.halted` Transparency
 *      Stream event envelopes per § B.8.2 so the
 *      orchestrator policy can pipe them through `recordTransparency-
 *      Event` without re-implementing the audit shape.
 *
 *  These are pure helpers — the orchestrator policy decides when to
 *  call them (typically before each synthesis round).
 *  PB4 does NOT mutate the plan; the policy is responsible for
 *  threading the result through `recordTransparencyEvent` +
 *  `model_tier` updates.
 *
 *  Spec: § B.15.10 + § B.8.2. */

import {
  TIER_ESTIMATED_COST_CENTS,
  TIER_LATENCY_CEILINGS,
  TIER_RANK,
  defaultRedactionForKind,
  downgradeIfOverBudget,
  type ModelTier,
  type SiTierBounds,
  type TierBudget,
  type TransparencyEvent,
  type TransparencyEventEnvelope,
} from '@recued/contracts';

export const COST_CEILING_OUTCOMES = ['ok', 'demote', 'halt'] as const;
export type CostCeilingOutcome = (typeof COST_CEILING_OUTCOMES)[number];

export interface CostCeilingInput {
  /** The tier the orchestrator is currently planning to invoke. */
  readonly current_tier: ModelTier;
  /** Per-request budget headroom + ceiling. */
  readonly budget: TierBudget;
  /** Standing Instruction tier bounds — `min_tier` prevents
   *  demotion below floor. */
  readonly siBounds?: SiTierBounds;
  /** When set, the actual marginal cost (cents) the caller expects
   *  the next synthesis round to incur — overrides the substrate
   *  default `TIER_ESTIMATED_COST_CENTS[tier]`. No live caller
   *  supplies per-model estimates from `packages/llm` yet. */
  readonly next_call_cost_cents?: number;
  /** Codex P2 fold (§ C.3.6): cumulative engine-attributable wall-
   *  clock so far this request (from `executeRecuedRequest` entry —
   *  excludes bridge wait). When the next call's projected total
   *  would exceed `TIER_LATENCY_CEILINGS[current_tier].p95_wall_clock_ms`
   *  the evaluator demotes / halts the same way as the cost-cents
   *  walker. PB4 ships the signal; no live caller wires the elapsed
   *  measurement yet. Optional — when omitted, the latency check is
   *  skipped. */
  readonly elapsed_wall_clock_ms?: number;
  /** Estimated wall-clock the next call will add. No live caller
   *  supplies it yet; PB4 defaults to the per-tier
   *  `p50_wall_clock_ms` baseline. */
  readonly next_call_wall_clock_ms?: number;
  /** Codex P2 fold (§ C.3.6): cumulative tokens consumed by prior
   *  `ai.synthesize` rounds. When the next call's projected total
   *  would exceed `TIER_LATENCY_CEILINGS[current_tier].p95_token_cost`
   *  the evaluator demotes / halts. */
  readonly tokens_used_so_far?: number;
  /** Estimated tokens the next call will consume. PB4 ships the
   *  signal at the API surface; no live caller supplies the
   *  per-model estimate yet. */
  readonly next_call_tokens?: number;
}

export type CostCeilingResult =
  | { readonly outcome: 'ok'; readonly tier: ModelTier; readonly estimated_cents: number }
  | {
      readonly outcome: 'demote';
      readonly from_tier: ModelTier;
      readonly to_tier: ModelTier;
      readonly demotion_steps: number;
    }
  | {
      readonly outcome: 'halt';
      readonly halted_at_tier: ModelTier;
      readonly reason: 'cost_ceiling_min_floor' | 'cost_ceiling_no_lower';
    };

/** Codex P2 fold (§ C.3.6): cumulative wall-clock + token ceilings.
 *  Unlike the cents budget (which demotion *can* fit because lower
 *  tiers cost less per call), latency + token ceilings tighten as
 *  you demote — fast.p95_wall_clock_ms = 1500 is FAR less than
 *  reasoning.p95_wall_clock_ms = 20000. So if cumulative wall-clock
 *  or tokens already exceed the *current* tier's p95, demotion can
 *  never help (lower tiers have tighter ceilings). The check halts
 *  directly without walking. Returns null when the latency / token
 *  budgets are clean; otherwise the halt result.
 *
 *  PB4 ships the substrate signal; no live caller wires the elapsed
 *  measurement from the Plan IR yet. */
const checkLatencyAndTokenCeilings = (input: CostCeilingInput): CostCeilingResult | null => {
  const latency = TIER_LATENCY_CEILINGS[input.current_tier];
  if (input.elapsed_wall_clock_ms !== undefined) {
    const projected =
      input.elapsed_wall_clock_ms
      + (input.next_call_wall_clock_ms ?? latency.p50_wall_clock_ms);
    if (projected > latency.p95_wall_clock_ms) {
      return {
        outcome: 'halt',
        halted_at_tier: input.current_tier,
        reason: 'cost_ceiling_no_lower',
      };
    }
  }
  if (input.tokens_used_so_far !== undefined) {
    const projected =
      input.tokens_used_so_far + (input.next_call_tokens ?? latency.p50_token_cost);
    if (projected > latency.p95_token_cost) {
      return {
        outcome: 'halt',
        halted_at_tier: input.current_tier,
        reason: 'cost_ceiling_no_lower',
      };
    }
  }
  return null;
};

/** Pure pre-flight cost-ceiling evaluator. Returns whether the next
 *  `ai.synthesize` call fits the per-tier ceilings (cents
 *  + wall-clock + token cost per § C.3.6), requires a one-or-more-
 *  step demotion, or must halt. The orchestrator policy maps
 *  `'halt'` to `cancelled_cost_ceiling` per § B.15.10 + § B.5.1
 *  PlanStatus.
 *
 *  PB4 ships pessimistic substrate estimates via
 *  `TIER_ESTIMATED_COST_CENTS`. The optional `next_call_cost_cents`
 *  override threads through BOTH the fast-path check AND the budget
 *  walker — so when the caller's per-model estimate doesn't fit the
 *  current tier, the walker uses the same caller-supplied estimate
 *  for the current tier and substrate defaults for lower tiers
 *  (per-tier overrides from `packages/llm` are not wired yet). Codex P1
 *  fold: previously the override was discarded after the fast-path
 *  check, so the walker could return `ok` for a tier the caller's
 *  actual estimate didn't fit. Codex P2 fold: latency + token
 *  ceilings per § C.3.6 are checked at every walker step; no live
 *  caller supplies the elapsed signals yet. */
export const evaluateCostCeiling = (input: CostCeilingInput): CostCeilingResult => {
  // Codex P2 fold step 1: latency + token ceilings are halt-only at
  // the current tier (lower tiers have TIGHTER per-tier ceilings, so
  // demotion never helps). Check first — if cumulative wall-clock or
  // tokens already exceed the current tier's p95, halt immediately.
  const latencyHalt = checkLatencyAndTokenCeilings(input);
  if (latencyHalt !== null) return latencyHalt;

  const cost =
    input.next_call_cost_cents ?? TIER_ESTIMATED_COST_CENTS[input.current_tier];

  // Fast path: cents budget covers the next call at the current tier.
  if (input.budget.remaining_cents >= cost) {
    return { outcome: 'ok', tier: input.current_tier, estimated_cents: cost };
  }

  // Walk down via the substrate's downgrade helper. Thread the
  // caller-supplied estimate ONLY for the current tier — lower tiers
  // fall back to substrate defaults (the per-tier marginal-cost
  // estimate is shape-specific to the tier the caller was about to
  // invoke). A per-tier costFor lookup is not wired yet — it would
  // land once `packages/llm` carries per-model rates.
  const downgrade = downgradeIfOverBudget(
    input.current_tier,
    input.budget,
    input.siBounds ?? {},
    (tier) =>
      tier === input.current_tier && input.next_call_cost_cents !== undefined
        ? input.next_call_cost_cents
        : TIER_ESTIMATED_COST_CENTS[tier],
  );
  if (downgrade.kind === 'halt') {
    return {
      outcome: 'halt',
      halted_at_tier: downgrade.halted_at_tier,
      reason: downgrade.reason,
    };
  }
  if (TIER_RANK[downgrade.tier] === TIER_RANK[input.current_tier]) {
    // Defensive: walker said current tier fits (steps === 0). The
    // fast-path check above should have caught this.
    return {
      outcome: 'ok',
      tier: downgrade.tier,
      estimated_cents: cost,
    };
  }
  return {
    outcome: 'demote',
    from_tier: input.current_tier,
    to_tier: downgrade.tier,
    demotion_steps: downgrade.steps,
  };
};

// ── Transparency event helpers (§ B.8.2) ────────────────────────────

/** PB7 wire-envelope helper — wrap a closed `TransparencyEvent` into
 *  the PB7 `{ event, redaction, emitted_at }` shape with the per-kind
 *  default redaction tier. Settings filtering happens upstream when
 *  the envelope flows through `composeTransparencyEvent`. */
const wrapAsEnvelope = (event: TransparencyEvent): TransparencyEventEnvelope => ({
  event,
  redaction: defaultRedactionForKind(event.kind),
  emitted_at: Date.now(),
});

/** Build the `cost_ceiling.demoted` Transparency Stream envelope per
 *  § B.8.2. Closed event kind; the composer template renders the
 *  Recued-voiced narrative. PB7 wraps in the spec wire shape
 *  `{ event, redaction, emitted_at }`. */
export const buildCostCeilingDemotedEvent = (args: {
  from_tier: ModelTier;
  to_tier: ModelTier;
  demotion_steps?: number;
}): TransparencyEventEnvelope =>
  wrapAsEnvelope({
    kind: 'cost_ceiling.demoted',
    from_tier: args.from_tier,
    to_tier: args.to_tier,
    ...(args.demotion_steps !== undefined
      ? { demotion_steps: args.demotion_steps }
      : {}),
  });

/** Build the `cost_ceiling.halted` Transparency Stream envelope per
 *  § B.8.2. The orchestrator emits this BEFORE setting the plan's
 *  status to `cancelled_cost_ceiling`. */
export const buildCostCeilingHaltedEvent = (args: {
  reason: 'min_tier_floor' | 'no_lower_tier';
  halted_at_tier?: ModelTier;
}): TransparencyEventEnvelope =>
  wrapAsEnvelope({
    kind: 'cost_ceiling.halted',
    reason: args.reason,
    ...(args.halted_at_tier !== undefined
      ? { halted_at_tier: args.halted_at_tier }
      : {}),
  });

/** Build the `standing_instruction_conflict` Transparency Stream
 *  envelope per § B.15.8 + § B.8.2. The PB10 Standing Instructions
 *  substrate is the canonical emitter (it carries the actual
 *  `instruction_ids` of conflicting policies). PB4's tier policy
 *  helper emits a slim version with the bound values surfaced as a
 *  `conflict_kind: 'tier_bound'` discriminator + the conflicting
 *  min_tier / max_tier values — bound values are CLOSED-LIST
 *  ModelTier strings, never user content; safe to render in the
 *  audit-log + Transparency Stream payload. PB10 widens to attach
 *  instruction_ids when those land. */
export const buildStandingInstructionConflictEvent = (args: {
  conflict_kind: 'tier_bound';
  min_tier?: ModelTier;
  max_tier?: ModelTier;
  instruction_ids?: ReadonlyArray<string>;
}): TransparencyEventEnvelope =>
  wrapAsEnvelope({
    kind: 'standing_instruction_conflict',
    instruction_ids:
      args.instruction_ids !== undefined ? [...args.instruction_ids] : [],
    conflict_kind: args.conflict_kind,
    ...(args.min_tier !== undefined ? { min_tier: args.min_tier } : {}),
    ...(args.max_tier !== undefined ? { max_tier: args.max_tier } : {}),
  });

/** Map the cost-ceiling halt reason into the closed-list narrative
 *  reason the Transparency Stream renders + the ratchet test pins
 *  per § B.8.2. */
export const transparencyHaltReason = (
  reason: 'cost_ceiling_min_floor' | 'cost_ceiling_no_lower',
): 'min_tier_floor' | 'no_lower_tier' =>
  reason === 'cost_ceiling_min_floor' ? 'min_tier_floor' : 'no_lower_tier';

// ── Primitive-call outcome_summary helpers (§ B.15.10) ──────────────

/** § B.15.10 prescribed verbatim outcome_summary for a demoted
 *  `ai.synthesize` PrimitiveCall row. Codex P2 fold: PB4 surfaces the
 *  canonical wording so the `ai.synthesize` adapter can stamp it
 *  on the eventual synthesis call when `tier_demoted` fires. The
 *  demotion *decision* lives in the Transparency Stream event the
 *  draft already records; the *actuated demotion* would land on the
 *  PrimitiveCall row a live caller emits when the demoted call lands.
 *
 *  Closed-character-set: caller passes only ModelTier strings (closed
 *  list per `MODEL_TIERS`); never user content. Safe for audit.
 *
 *  Returns: `'demoted_due_to_cost_ceiling from=reasoning to=mid'`
 *  (verbatim phrase per spec + tier hint suffix). */
export const COST_CEILING_DEMOTION_OUTCOME_PHRASE = 'demoted_due_to_cost_ceiling';

export const formatCostCeilingDemotionOutcomeSummary = (
  from_tier: ModelTier,
  to_tier: ModelTier,
): string => `${COST_CEILING_DEMOTION_OUTCOME_PHRASE} from=${from_tier} to=${to_tier}`;

/** § B.15.10 — outcome_summary for an `ai.synthesize` PrimitiveCall
 *  that was halted (never actuated) due to cost-ceiling exhaustion.
 *  A live caller would stamp this on the synthetic `ai.synthesize`
 *  row with `status: 'cancelled'` when the orchestrator halts
 *  pre-call. */
export const COST_CEILING_HALT_OUTCOME_PHRASE = 'cancelled_due_to_cost_ceiling';

export const formatCostCeilingHaltOutcomeSummary = (
  reason: 'cost_ceiling_min_floor' | 'cost_ceiling_no_lower',
  halted_at_tier: ModelTier,
): string =>
  `${COST_CEILING_HALT_OUTCOME_PHRASE} reason=${transparencyHaltReason(reason)} tier=${halted_at_tier}`;
