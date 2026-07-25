/** D-145 PB4 / D-164 P6.2 — `selectSynthesisTier` pure function.
 *
 *  Per the D-164 P6.2 simplification. Tier selection is a
 *  *calculated* engine decision — the caller (channel layer +
 *  per-session user preference) decides the baseline, and PB4 encodes
 *  the post-baseline pipeline as a pure function with the closed-list
 *  table pinned in `@recued/contracts/tier-strategy`:
 *
 *    1. Compute baseline tier from `sessionPref ?? channelDefault`
 *       (D-164 P6.2: dropped `defaultTierForClassification(stage1, breadth)`
 *       — the retired classifier no longer feeds the selector; the
 *       caller now passes a pre-computed channel default and the
 *       optional per-session preference directly).
 *    2. Optionally raise via `modelHint` (rule 2)
 *    3. Clamp via `siBounds` (§ B.11 — `min_tier` raises floor,
 *       `max_tier` lowers ceiling; `min > max` halts as
 *       `standing_instruction_conflict`)
 *    4. Walk down via `downgradeIfOverBudget` (§ B.15.10 — cost
 *       ceiling demote / halt)
 *
 *  Returns a discriminated `SelectSynthesisTierResult` union — `'ok'`
 *  with the resolved tier + audit-friendly trace fields (baseline,
 *  whether modelHint raised, whether SI clamped, demotion steps), or
 *  `'halt'` with the closed-list reason the orchestrator maps to a
 *  `PlanStatus` (`cancelled_si_conflict` / `cancelled_cost_ceiling`).
 *
 *  Determinism invariant: same `(channelDefault, sessionPref,
 *  siBounds, budget, modelHint)` always produces same result. The PB4
 *  ratchet test pins the table; `assertTierStrategyInvariants` (in
 *  contracts) keeps the substrate constants in lockstep with `MODEL_TIERS`.
 *
 *  Spec: § B.3 + § B.15.10 + § B.15.8 +
 *  docs/d-164-prompt-cache-consolidation-pending-design.md § P6.2. */

import {
  TIER_RANK,
  clampToBounds,
  downgradeIfOverBudget,
  highestTier,
  type ModelTier,
  type SelectSynthesisTierResult,
  type SiTierBounds,
  type TierBudget,
} from '@recued/contracts';

export interface SelectSynthesisTierInput {
  /** Per-channel default tier — chat = `'fast'`, etc. Required baseline.
   *  D-164 P6.2 replaced the retired `stage1` classifier input with
   *  this caller-supplied channel default; the chat-orchestrator
   *  hardcodes it per channel. */
  readonly channelDefault: ModelTier;
  /** Optional per-session user preference. When present, overrides
   *  `channelDefault` as the baseline (the user explicitly chose
   *  `'reasoning'` for this session, etc.). When absent, the baseline
   *  is `channelDefault`. */
  readonly sessionPref?: ModelTier;
  readonly siBounds?: SiTierBounds;
  readonly budget: TierBudget;
  readonly modelHint?: ModelTier;
}

/** Pure function. No side effects, no IO, no AI calls.
 *
 *  Returns `kind: 'ok'` with the resolved tier + trace fields, OR
 *  `kind: 'halt'` with one of three reasons the orchestrator maps to
 *  `PlanStatus`:
 *    - `'standing_instruction_conflict'` → `cancelled_si_conflict`
 *    - `'cost_ceiling_min_floor'` → `cancelled_cost_ceiling`
 *    - `'cost_ceiling_no_lower'` → `cancelled_cost_ceiling`
 *
 *  The trace fields (`baseline_tier`, `clamped_tier`, `hint_raised`,
 *  `si_clamped`, `demotion_steps`) populate the Plan IR's
 *  `selection_trace` + Transparency Stream events (`cost_ceiling.demoted`)
 *  so audit replay reproduces the decision deterministically. */
export const selectSynthesisTier = (input: SelectSynthesisTierInput): SelectSynthesisTierResult => {
  const bounds = input.siBounds ?? {};

  // ── Step 1: baseline from sessionPref ?? channelDefault ──────────
  const baseline: ModelTier = input.sessionPref ?? input.channelDefault;

  // ── Step 2: modelHint raises (rule 2) ────────────────────────────
  let raised: ModelTier = baseline;
  let hint_raised = false;
  if (input.modelHint !== undefined) {
    const next = highestTier(raised, input.modelHint);
    if (TIER_RANK[next] > TIER_RANK[raised]) hint_raised = true;
    raised = next;
  }

  // ── Step 3: clamp via SI bounds ─────────────────────────────────
  const clamped = clampToBounds(raised, bounds);
  if (clamped === null) {
    return {
      kind: 'halt',
      reason: 'standing_instruction_conflict',
      detail: `SI bounds conflict: min_tier='${bounds.min_tier}' > max_tier='${bounds.max_tier}'`,
    };
  }
  const si_clamped =
    TIER_RANK[clamped] !== TIER_RANK[raised]
      || (bounds.min_tier !== undefined && TIER_RANK[clamped] === TIER_RANK[bounds.min_tier] && TIER_RANK[raised] < TIER_RANK[bounds.min_tier])
      || (bounds.max_tier !== undefined && TIER_RANK[clamped] === TIER_RANK[bounds.max_tier] && TIER_RANK[raised] > TIER_RANK[bounds.max_tier]);

  // ── Step 4: downgrade if over budget ─────────────────────────────
  const downgrade = downgradeIfOverBudget(clamped, input.budget, bounds);
  if (downgrade.kind === 'halt') {
    return {
      kind: 'halt',
      reason: downgrade.reason,
      halted_at_tier: downgrade.halted_at_tier,
      detail:
        downgrade.reason === 'cost_ceiling_min_floor'
          ? `cost ceiling exceeded; cannot demote below SI min_tier='${bounds.min_tier}'`
          : `cost ceiling exceeded; already at lowest tier '${downgrade.halted_at_tier}'`,
    };
  }

  return {
    kind: 'ok',
    tier: downgrade.tier,
    baseline_tier: baseline,
    clamped_tier: clamped,
    hint_raised,
    si_clamped,
    demotion_steps: downgrade.steps,
  };
};
