/** D-145 PB4 — orchestrator tier policy helper.
 *
 *  Composes `selectSynthesisTier` + mid-flight cost ceiling + tier ↔
 *  PlanStatus halt mapping into a single helper the orchestration
 *  policy can call without re-implementing the substrate's halt
 *  semantics.
 *
 *  D-159 P0 relocated this helper from `orchestrator/` into
 *  `two-stage/`; D-164 P6.1 then relocated it (alongside its
 *  `selectSynthesisTier` + cost-ceiling dependencies) into the sibling
 *  `tier-strategy/` folder. It homes with `tier-strategy/` to keep
 *  `middleware !-> middleware-recued`. The helper reaches the
 *  framework only through an `import type { PlanDraft }` from
 *  `@recued/middleware` — the allowed `middleware-recued -> middleware`
 *  direction.
 *
 *  Pure-ish: returns the resolved tier + a boolean signaling whether
 *  the policy should halt; emission of Transparency Stream events
 *  goes through the supplied `draft`. No live caller wires this
 *  helper into the production policy yet.
 *
 *  Spec: § B.3 + § B.15.8 + § B.15.10 + § B.8.2. */

import type {
  FailureClass,
  ModelTier,
  PlanStatus,
  SiTierBounds,
  TierBudget,
} from '@recued/contracts';

import { selectSynthesisTier } from './select-tier.js';
import {
  buildCostCeilingDemotedEvent,
  buildCostCeilingHaltedEvent,
  buildStandingInstructionConflictEvent,
  evaluateCostCeiling,
  formatCostCeilingDemotionOutcomeSummary,
  formatCostCeilingHaltOutcomeSummary,
  transparencyHaltReason,
  type CostCeilingResult,
} from './cost-ceiling.js';
import type { PlanDraft } from '@recued/middleware/orchestrator/index.js';

/** Halt reasons surfaced to the orchestration policy. Closed list
 *  so the orchestrator's `OrchestrationPolicyResult` mapping stays
 *  pinned to the spec's `PlanStatus` taxonomy. */
export type TierPolicyHaltReason =
  | 'standing_instruction_conflict'
  | 'cost_ceiling_min_floor'
  | 'cost_ceiling_no_lower';

export const TIER_POLICY_HALT_TO_PLAN_STATUS: { readonly [K in TierPolicyHaltReason]: PlanStatus } =
  Object.freeze({
    standing_instruction_conflict: 'cancelled_si_conflict',
    cost_ceiling_min_floor: 'cancelled_cost_ceiling',
    cost_ceiling_no_lower: 'cancelled_cost_ceiling',
  });

export const TIER_POLICY_HALT_TO_FAILURE_CLASS: {
  readonly [K in TierPolicyHaltReason]: FailureClass;
} = Object.freeze({
  standing_instruction_conflict: 'capacity', // SI conflict halts before any AI call — capacity-class per § C.3.3
  cost_ceiling_min_floor: 'cost',
  cost_ceiling_no_lower: 'cost',
});

export interface ResolveSynthesisTierInput {
  /** Per-channel default tier — D-164 P6.2 replaced `stage1`. Required. */
  readonly channelDefault: ModelTier;
  /** Optional per-session user preference; when present overrides
   *  `channelDefault` as the baseline. D-164 P6.2. */
  readonly sessionPref?: ModelTier;
  readonly siBounds?: SiTierBounds;
  readonly budget: TierBudget;
  readonly modelHint?: ModelTier;
  /** When supplied, the helper records `cost_ceiling.demoted` on the
   *  draft on initial-selection demotion (i.e., when budget walker
   *  demoted the clamped tier before the call ran). */
  readonly draft?: PlanDraft;
  /** Codex P2 fold (§ B.15.8): when the SI substrate (PB10) supplies
   *  the conflicting Standing Instruction IDs, they thread into the
   *  `standing_instruction_conflict` Transparency Stream event. PB4
   *  alone has only the resolved bounds; PB10 widens to attach the
   *  source instruction_ids. */
  readonly conflicting_instruction_ids?: ReadonlyArray<string>;
}

export type ResolveSynthesisTierResult =
  | {
      readonly kind: 'ok';
      readonly tier: ModelTier;
      readonly baseline_tier: ModelTier;
      readonly demotion_steps: number;
      /** Codex P2 fold (§ B.15.10): canonical outcome_summary for the
       *  eventual `ai.synthesize` PrimitiveCall row. A live caller
       *  would stamp this on the actuated demoted call so audit replay
       *  can attribute the tier choice to a cost-ceiling decision.
       *  Only populated when `demotion_steps > 0`. */
      readonly demotion_outcome_summary?: string;
    }
  | {
      readonly kind: 'halt';
      readonly halt_reason: TierPolicyHaltReason;
      readonly status: PlanStatus;
      readonly failure_class: FailureClass;
      readonly user_response: string;
      readonly halted_at_tier?: ModelTier;
      /** Codex P2 fold (§ B.15.10): canonical outcome_summary for a
       *  synthetic `cancelled` `ai.synthesize` PrimitiveCall row a
       *  live caller may emit when the orchestrator halts pre-call.
       *  Only populated for cost_ceiling halts (NOT
       *  standing_instruction_conflict — SI halts have no associated
       *  AI primitive call). */
      readonly halt_outcome_summary?: string;
    };

/** Per-request user-facing halt copy. § B.15.10 + § B.15.8 prescribe
 *  exact wording; the helper centralizes it so every entry point
 *  produces the same message. */
const HALT_USER_RESPONSE: { readonly [K in TierPolicyHaltReason]: string } = Object.freeze({
  standing_instruction_conflict:
    "Two of your Standing Instructions for this kind of request conflict — I've added them to the Conflicts queue in Settings; you can adjust one to resolve.",
  cost_ceiling_min_floor:
    'This request was costlier than your budget allowed; I stopped before going over. You can adjust your AI budget in Settings or retry on a higher tier.',
  cost_ceiling_no_lower:
    'This request was costlier than your budget allowed; I stopped before going over. You can adjust your AI budget in Settings or retry on a higher tier.',
});

/** Resolve the synthesis tier with optional budget-walker demotion +
 *  Transparency Stream event emission. */
export const resolveSynthesisTier = (input: ResolveSynthesisTierInput): ResolveSynthesisTierResult => {
  const bounds = input.siBounds ?? {};
  const result = selectSynthesisTier({
    channelDefault: input.channelDefault,
    ...(input.sessionPref !== undefined ? { sessionPref: input.sessionPref } : {}),
    ...(input.siBounds !== undefined ? { siBounds: input.siBounds } : {}),
    budget: input.budget,
    ...(input.modelHint !== undefined ? { modelHint: input.modelHint } : {}),
  });

  if (result.kind === 'halt') {
    const haltReason = result.reason as TierPolicyHaltReason;
    if (input.draft) {
      // Codex P2 fold (§ B.15.8): SI conflict halts MUST emit
      // `standing_instruction_conflict` Transparency Stream event
      // BEFORE the orchestrator records the cancelled status. Bound
      // values are closed-list ModelTier strings — never user content.
      // PB10 will widen to attach the source instruction_ids when the
      // SI substrate lands; PB4 surfaces whatever the caller threaded.
      if (haltReason === 'standing_instruction_conflict') {
        input.draft.recordTransparencyEvent(
          buildStandingInstructionConflictEvent({
            conflict_kind: 'tier_bound',
            ...(bounds.min_tier !== undefined ? { min_tier: bounds.min_tier } : {}),
            ...(bounds.max_tier !== undefined ? { max_tier: bounds.max_tier } : {}),
            ...(input.conflicting_instruction_ids !== undefined
              ? { instruction_ids: input.conflicting_instruction_ids }
              : {}),
          }),
        );
      } else {
        input.draft.recordTransparencyEvent(
          buildCostCeilingHaltedEvent({
            reason: transparencyHaltReason(haltReason),
            ...(result.halted_at_tier !== undefined
              ? { halted_at_tier: result.halted_at_tier }
              : {}),
          }),
        );
      }
    }
    return {
      kind: 'halt',
      halt_reason: haltReason,
      status: TIER_POLICY_HALT_TO_PLAN_STATUS[haltReason],
      failure_class: TIER_POLICY_HALT_TO_FAILURE_CLASS[haltReason],
      user_response: HALT_USER_RESPONSE[haltReason],
      ...(result.halted_at_tier !== undefined ? { halted_at_tier: result.halted_at_tier } : {}),
      ...(haltReason !== 'standing_instruction_conflict' && result.halted_at_tier !== undefined
        ? {
            halt_outcome_summary: formatCostCeilingHaltOutcomeSummary(
              haltReason,
              result.halted_at_tier,
            ),
          }
        : {}),
    };
  }

  // Initial-selection demotion (selectSynthesisTier already walked the
  // budget). Emit cost_ceiling.demoted so the audit / Transparency
  // Stream record matches the substrate's halt semantics.
  if (input.draft && result.demotion_steps > 0) {
    input.draft.recordTransparencyEvent(
      buildCostCeilingDemotedEvent({
        from_tier: result.clamped_tier,
        to_tier: result.tier,
        demotion_steps: result.demotion_steps,
      }),
    );
  }

  return {
    kind: 'ok',
    tier: result.tier,
    baseline_tier: result.baseline_tier,
    demotion_steps: result.demotion_steps,
    ...(result.demotion_steps > 0
      ? {
          demotion_outcome_summary: formatCostCeilingDemotionOutcomeSummary(
            result.clamped_tier,
            result.tier,
          ),
        }
      : {}),
  };
};

// ── Mid-flight cost ceiling re-evaluation (per synthesis round) ──────

export interface MidFlightCostCheckInput {
  readonly current_tier: ModelTier;
  readonly budget: TierBudget;
  readonly siBounds?: SiTierBounds;
  readonly next_call_cost_cents?: number;
  /** Codex P2 fold (§ C.3.6): cumulative engine-attributable wall-
   *  clock + tokens consumed so far this request. No live caller
   *  plumbs these from the Plan IR yet. */
  readonly elapsed_wall_clock_ms?: number;
  readonly next_call_wall_clock_ms?: number;
  readonly tokens_used_so_far?: number;
  readonly next_call_tokens?: number;
  readonly draft?: PlanDraft;
}

export type MidFlightCostCheckResult =
  | { readonly kind: 'ok'; readonly tier: ModelTier; readonly estimated_cents: number }
  | {
      readonly kind: 'demoted';
      readonly from_tier: ModelTier;
      readonly to_tier: ModelTier;
      readonly demotion_steps: number;
      /** § B.15.10 canonical outcome_summary for the eventual demoted
       *  `ai.synthesize` PrimitiveCall — a live caller stamps onto the
       *  row. */
      readonly demotion_outcome_summary: string;
    }
  | {
      readonly kind: 'halt';
      readonly halt_reason: 'cost_ceiling_min_floor' | 'cost_ceiling_no_lower';
      readonly halted_at_tier: ModelTier;
      readonly status: PlanStatus;
      readonly failure_class: FailureClass;
      readonly user_response: string;
      /** § B.15.10 canonical outcome_summary for the synthetic
       *  cancelled `ai.synthesize` PrimitiveCall a live caller may emit. */
      readonly halt_outcome_summary: string;
    };

/** Pre-flight check before each multi-turn `ai.synthesize` round.
 *  Mirrors `evaluateCostCeiling` + emits the matching Transparency
 *  Stream events through the optional `draft`. No live caller wires
 *  the multi-turn loop call site yet. */
export const checkMidFlightCostCeiling = (
  input: MidFlightCostCheckInput,
): MidFlightCostCheckResult => {
  const result: CostCeilingResult = evaluateCostCeiling({
    current_tier: input.current_tier,
    budget: input.budget,
    ...(input.siBounds !== undefined ? { siBounds: input.siBounds } : {}),
    ...(input.next_call_cost_cents !== undefined
      ? { next_call_cost_cents: input.next_call_cost_cents }
      : {}),
    ...(input.elapsed_wall_clock_ms !== undefined
      ? { elapsed_wall_clock_ms: input.elapsed_wall_clock_ms }
      : {}),
    ...(input.next_call_wall_clock_ms !== undefined
      ? { next_call_wall_clock_ms: input.next_call_wall_clock_ms }
      : {}),
    ...(input.tokens_used_so_far !== undefined
      ? { tokens_used_so_far: input.tokens_used_so_far }
      : {}),
    ...(input.next_call_tokens !== undefined
      ? { next_call_tokens: input.next_call_tokens }
      : {}),
  });

  if (result.outcome === 'ok') {
    return { kind: 'ok', tier: result.tier, estimated_cents: result.estimated_cents };
  }
  if (result.outcome === 'demote') {
    if (input.draft) {
      input.draft.recordTransparencyEvent(
        buildCostCeilingDemotedEvent({
          from_tier: result.from_tier,
          to_tier: result.to_tier,
          demotion_steps: result.demotion_steps,
        }),
      );
    }
    return {
      kind: 'demoted',
      from_tier: result.from_tier,
      to_tier: result.to_tier,
      demotion_steps: result.demotion_steps,
      demotion_outcome_summary: formatCostCeilingDemotionOutcomeSummary(
        result.from_tier,
        result.to_tier,
      ),
    };
  }
  // halt
  if (input.draft) {
    input.draft.recordTransparencyEvent(
      buildCostCeilingHaltedEvent({
        reason: transparencyHaltReason(result.reason),
        halted_at_tier: result.halted_at_tier,
      }),
    );
  }
  return {
    kind: 'halt',
    halt_reason: result.reason,
    halted_at_tier: result.halted_at_tier,
    status: TIER_POLICY_HALT_TO_PLAN_STATUS[result.reason],
    failure_class: TIER_POLICY_HALT_TO_FAILURE_CLASS[result.reason],
    user_response: HALT_USER_RESPONSE[result.reason],
    halt_outcome_summary: formatCostCeilingHaltOutcomeSummary(
      result.reason,
      result.halted_at_tier,
    ),
  };
};
