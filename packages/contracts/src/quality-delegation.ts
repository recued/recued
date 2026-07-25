/** D-202 — Quality Delegation: the PURE vocabulary for the SECOND delegation
 *  axis on the D-177 gate.
 *
 *  D-177 learns AUTHORIZATION ("may this op run?"). D-202 adds QUALITY ("is the
 *  output good enough to ship?"). Both are owner-minted grant kinds in the same
 *  `contract_definition` substrate, both minted suggest→accept (no silent
 *  promotion), both consumed at the D-157 gate. The send-time gate is a
 *  CONJUNCTION of three verdicts evaluated at EVERY send (spec §1):
 *
 *      send iff:  authorization  ∧  per-region quality  ∧  whole-document
 *
 *  Composition is definitional: a quality delegation removes ONLY the quality
 *  review; the authorization verdict (including the owner's value-bounds) is
 *  re-derived INDEPENDENTLY every send — a quality delegation NEVER grants
 *  authority to send (invariant §12.1). The whole-document conjunct always runs
 *  and is NEVER fully delegated (§12.2).
 *
 *  ── What this module ships (Slice 0 — the degenerate single node, §14) ──
 *    - the coarse **(recipe, op)-grain** matcher {@link matchesQualityDelegation}
 *      (NOT `matchesGateGrant` — a quality grant carries no per-call payload
 *      identity; governance is coarse per §5);
 *    - the **Switch A/B** kill-switch as a gate-OVERRIDE ({@link QualityGateSwitches}
 *      + resolvers) — it never writes learner state, always reversible (§12.12);
 *    - the pure **three-conjunct** evaluator {@link evaluateThreeConjunctGate}, v1
 *      quality verdict = binary "is there an accepted quality delegation for this
 *      (recipe, op)?", whole-document = "the one region must pass."
 *
 *  ── What this module RESERVES but does not yet use (§14 "reserve the shape") ──
 *    - {@link QualityRegion} (`region_id` / `source_ref` / `region_hash` /
 *      `upstream_deps`) — the per-region learner state; v1 is a single
 *      whole-template node, so nothing populates these until region decomposition
 *      (Slice 3) earns it;
 *    - {@link QUALITY_VERDICT_REASONS} + {@link reasonTrainsQuality} — the
 *      reason-coded signal taxonomy the Slice 1 reject-driven learner consumes
 *      ("only default-reason verdicts train," §12.3). No learner reads them yet.
 *
 *  This is the PURE substrate (no I/O, no clock reads, no mutation). The store
 *  mint (`mintQualityDelegation`), the gate wiring, the Switch A/B flag storage,
 *  and the #contracts surface are the backend slices that CALL these predicates.
 *
 *  Spec: `docs/d-202-spec.md` (ops-first — §§1–5 operations, §§6–10 foundation,
 *  §§11–16 honesty). Parent: `docs/d-177-spec.md`. */

import type { BoundRecipeRef, ContractDefinition } from './contract-definition.js';
import { isContractActive } from './contract-definition.js';

/** The `contract_definition.grant_kind` literal a quality delegation carries.
 *  Re-exported as a named constant so consumers never hand-write the string (the
 *  same reason `CONTRACT_DEFINITION_SCOPE` is a constant). Added to
 *  `CONTRACT_GRANT_KINDS` (`contract-definition.ts`) + the `grant_kind`
 *  value-shape enum (`contract-schema.ts`). */
export const QUALITY_DELEGATION_GRANT_KIND = 'quality_delegation';

/** Local narrow-string guard (each contract module carries its own — mirrors
 *  `session-grant.ts` / `delegation-suggestion.ts`; keeps this module
 *  dependency-free). */
const nonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

// ════════════════════════════════════════════════════════════════
// Reserved reason-code taxonomy (§2, §13 — the Slice 1 learner consumes it)
// ════════════════════════════════════════════════════════════════

/** D-202 §2 — the reason-coded signal vocabulary the delivery surface produces.
 *  Verdicts are SYMMETRIC and default+override; **only default-reason verdicts
 *  train the quality learner** (§12.3):
 *
 *    - `quality_bad`  — DEFAULT reject reason → trains (knocks region confidence);
 *    - `policy`       — reject OVERRIDE → routes to the authorization axis, no
 *                       quality training (a mis-coded `policy` reject that lands
 *                       as `quality_bad` costs only latency, §8 asymmetry);
 *    - `quality_good` — DEFAULT approve reason → trains (credits, §8);
 *    - `ship_anyway`  — approve OVERRIDE → sends, no quality credit.
 *
 *  RESERVED for Slice 0: the full taxonomy + tie-strength calibration is a
 *  build-time decision (§13); Slice 0 has no learner, so nothing trains yet.
 *  {@link reasonTrainsQuality} is the single predicate the Slice 1 learner gates
 *  on, so the "only defaults train" rule lives in ONE place. */
export const QUALITY_VERDICT_REASONS = [
  'quality_bad',
  'policy',
  'quality_good',
  'ship_anyway',
] as const;

export type QualityVerdictReason = (typeof QUALITY_VERDICT_REASONS)[number];

/** True iff `reason` is a DEFAULT-reason verdict that TRAINS the quality learner
 *  (§12.3). The two override reasons (`policy` reject, `ship_anyway` approve)
 *  never touch quality confidence. Reserved: Slice 0 has no learner to gate; this
 *  is the seam the Slice 1 reject-driven learner reads so the invariant is
 *  enforced in exactly one place. Pure. */
export const reasonTrainsQuality = (reason: QualityVerdictReason): boolean =>
  reason === 'quality_bad' || reason === 'quality_good';

// ════════════════════════════════════════════════════════════════
// Reserved region model (§5, §6, §9, §14 — populated by decomposition, Slice 3+)
// ════════════════════════════════════════════════════════════════

/** D-202 §5/§9 — one region of a quality grant's INTERNAL learner state. A
 *  quality delegation is ONE grant per (recipe, op); the region graph is that
 *  grant's internal state, NOT per-region grant rows (§5 "coarse governance").
 *
 *  RESERVED per §14 so granularity is a later config flip, not a re-architecture.
 *  v1 (Slice 0) is a single whole-template node — nothing populates this until
 *  region decomposition (Slice 3) is justified by template churn. The two reset
 *  identities (§5, §12.7):
 *
 *    - `region_hash`  = a content hash over the region's TEMPLATE TEXT → a
 *                       template edit resets THAT region locally (standing);
 *    - `source_ref`   = a content hash over the region's DECLARED upstream data
 *                       closure `hash(sorted[(source_id, source_version,
 *                       semantics_tag)])`, TEMPLATE TEXT EXCLUDED → a
 *                       source-semantics change drives §3's standing pause,
 *                       global-by-source (§7). An UNDECLARED read makes the
 *                       region NOT delegable (fail closed, §12.8). */
export interface QualityRegion {
  readonly region_id: string;
  /** Content hash over the region's template text (edit-local reset identity). */
  readonly region_hash?: string;
  /** Content hash over the declared upstream data closure — no template text
   *  (standing source-drift reset identity, global-by-source). */
  readonly source_ref?: string;
  /** The region's declared upstream reads (`source_id`s) `source_ref` closes
   *  over; an undeclared read leaves the region non-delegable (§12.8). */
  readonly upstream_deps?: ReadonlyArray<string>;
}

// ════════════════════════════════════════════════════════════════
// The coarse (recipe, op)-grain quality-delegation matcher (§5)
// ════════════════════════════════════════════════════════════════

/** What {@link matchesQualityDelegation} needs to identify a send's (recipe, op).
 *  DELIBERATELY narrow — the quality axis governs at the coarse (recipe, op)
 *  grain (§5), so unlike {@link SessionGrantMatchContext} it carries NO
 *  `risk_tier`, NO `arg_shape_hash`, NO `canonical_payload_hash`: the quality
 *  grant is not per-call. `operation_id` is optional (a simple-form dispatch
 *  carries none); recipe identity is optional so a recipe-less dispatch simply
 *  never matches a recipe-bound quality grant (fail closed). */
export interface QualityDelegationMatchContext {
  readonly ingredient_slug: string;
  /** The catalog op's short `operations`-map key, present exactly when the
   *  dispatch carried a trusted `surface_operation_key` (same rule as the
   *  session matcher). Absent on simple-form dispatches. */
  readonly operation_id?: string;
  /** The dispatching run's recipe identity — both halves required to match a
   *  quality grant (recipe content drift re-asks, like a delegation rule). */
  readonly recipe_id?: string;
  readonly recipe_hash?: string;
}

/** D-202 §1/§5 — true iff `grant` is an ACTIVE quality delegation that admits
 *  the send described by `ctx` at `nowMs`. The QUALITY-axis analogue of
 *  {@link matchesDelegationRule}, but at the COARSE (recipe, op) grain — it binds
 *  on recipe identity + op, NOT on a per-call payload hash. Pure — no I/O, no
 *  clock reads, no mutation. Matching is NOT consumption: a quality delegation
 *  is a standing auto-accept, so there is no per-match use decrement (contrast
 *  the session/delegation grants' bounded-by-construction use budget). The
 *  clauses, all fail-closed:
 *
 *    - `grant_kind` is the EXPLICIT `'quality_delegation'` literal — absent
 *      (= standing), the authorization gate-grant literals, and any future
 *      vocabulary all fail closed (the same disjoint-vocabulary posture the
 *      session/delegation matchers hold);
 *    - LIVE (`isContractActive`): not revoked, not past `expiry_at`, not out of
 *      `uses_remaining`. A quality delegation MAY be standing (no bounds) —
 *      governed by the §3 invalidation ladder + the §4 kill-switch, not a use
 *      budget — so, unlike the authorization gate grants, it is NOT required to
 *      carry `expiry_at`/`uses_remaining`; `isContractActive` treats absent
 *      bounds as unbounded-active, which is the intended standing posture;
 *    - recipe identity: `bound_recipe` present and BOTH halves equal (recipe_id
 *      + recipe_hash). Content drift (`recipe_hash`) re-asks — the v1
 *      whole-template reset (§14): a recipe-less dispatch, or a grant missing
 *      `bound_recipe`, never matches;
 *    - op: the `ingredient_ids` axis must EXPLICITLY name the dispatched slug
 *      (never a wildcard — the same anti-cross-tool strictness the gate grants
 *      hold, so a quality grant can't leak across tools sharing a recipe), and
 *      the `operation_ids` axis is wildcard-or-equal (empty = any op under the
 *      ingredient; a restricted axis the ctx can't satisfy fails closed). */
export const matchesQualityDelegation = (
  grant: ContractDefinition,
  ctx: QualityDelegationMatchContext,
  nowMs: number,
): boolean => {
  // Explicit literal only — every other grant_kind is inert on this axis.
  if (grant.grant_kind !== QUALITY_DELEGATION_GRANT_KIND) return false;
  // Live — the same lifecycle every contract runs. Absent bounds ⇒ standing.
  if (!isContractActive(grant, nowMs)) return false;
  // Recipe identity — both halves equal. A recipe-less dispatch (recipe_id /
  // recipe_hash absent) never matches a recipe-bound quality grant.
  const bound: BoundRecipeRef | undefined | null = grant.bound_recipe;
  if (
    bound === undefined
    || bound === null
    || !nonEmptyString(bound.recipe_id)
    || !nonEmptyString(bound.recipe_hash)
    || bound.recipe_id !== ctx.recipe_id
    || bound.recipe_hash !== ctx.recipe_hash
  ) {
    return false;
  }
  // Op — ingredient axis EXPLICIT (never wildcard), operation axis wildcard-or-equal.
  if (!grant.scope.ingredient_ids?.includes(ctx.ingredient_slug)) return false;
  const opAxis = grant.scope.operation_ids;
  if (opAxis !== undefined && opAxis.length > 0) {
    // A restricted operation axis the dispatch can't satisfy fails closed.
    if (!nonEmptyString(ctx.operation_id) || !opAxis.includes(ctx.operation_id)) {
      return false;
    }
  }
  return true;
};

// ════════════════════════════════════════════════════════════════
// Switch A/B — the kill-switch as a gate-OVERRIDE (§4, §12.12)
// ════════════════════════════════════════════════════════════════

/** D-202 §4 — the owner's global-pause kill-switch, TWO switches mapped to the
 *  two axes, implemented as a gate OVERRIDE (learner state is never touched —
 *  §12.12). One channel-agnostic flag; control/status canonical in #contracts:
 *
 *    - `all_paused`     — **Switch A**: pause BOTH axes → every action returns to
 *                         full manual approve (the authorization delegation AND
 *                         the quality delegation both read as not-delegable);
 *    - `quality_paused` — **Switch B**: pause the QUALITY axis only → outputs
 *                         return to per-artifact review, authorization grants
 *                         stay live. The targeted security failsafe.
 *
 *  By construction: training is PRESERVED (the gate reads grants as not-delegable;
 *  it never writes learner state) and manual review CONTINUES while paused, so
 *  reversal is instant and LOSSLESS. Modeled as a coarse boolean short-circuit,
 *  the same shape as the D-188 master pause (`OpAdmissionGate.isFrozenByPause`). */
export interface QualityGateSwitches {
  /** Switch A — pause both axes (authorization delegation + quality delegation). */
  readonly all_paused: boolean;
  /** Switch B — pause the quality axis only. */
  readonly quality_paused: boolean;
}

/** The default (nothing paused) — both switches off. */
export const NO_QUALITY_GATE_PAUSE: QualityGateSwitches = {
  all_paused: false,
  quality_paused: false,
};

/** D-202 §4 — the persisted, owner-facing STATUS of the two-switch quality
 *  kill-switch: the two {@link QualityGateSwitches} booleans plus each switch's
 *  rising-edge timestamp. The `server.setQualitySwitch` /
 *  `server.getQualitySwitches` rpc DTO (owner-only) + the value the server-state
 *  store persists. A `QualityGateSwitchStatus` IS a {@link QualityGateSwitches}
 *  structurally, so it passes straight into {@link authorizationDelegationPaused}
 *  / {@link qualityDelegationPaused} at the gate. The `*_since` fields feed the
 *  §4 self-evidencing status surface (how long an axis has been paused). */
export interface QualityGateSwitchStatus extends QualityGateSwitches {
  /** Epoch-ms Switch A (both-axes pause) was engaged; null when off. */
  readonly all_since: number | null;
  /** Epoch-ms Switch B (quality-only pause) was engaged; null when off. */
  readonly quality_since: number | null;
}

/** True iff the AUTHORIZATION-delegation axis is currently suppressed — Switch A
 *  only (Switch B leaves authorization live). Applied at the authorization
 *  delegation CONSUME site: when true, the gate ignores any matching
 *  authorization delegation/session grant and falls to manual approval. Pure. */
export const authorizationDelegationPaused = (sw: QualityGateSwitches): boolean =>
  sw.all_paused;

/** True iff the QUALITY-delegation axis is currently suppressed — Switch A OR
 *  Switch B (either pauses quality). Applied at the quality CONSUME site: when
 *  true, the gate ignores any matching quality delegation and routes the output
 *  to per-artifact review. Pure. */
export const qualityDelegationPaused = (sw: QualityGateSwitches): boolean =>
  sw.all_paused || sw.quality_paused;

// ════════════════════════════════════════════════════════════════
// The three-conjunct send gate (§1 — pure composition)
// ════════════════════════════════════════════════════════════════

/** The authorization-axis verdict handed to the three-conjunct gate — the D-177
 *  admission decision, re-derived INDEPENDENTLY every send (§12.1). Switch A's
 *  effect on authorization delegation is applied UPSTREAM at the authz
 *  consume site (via {@link authorizationDelegationPaused}); this gate consumes
 *  the resolved verdict. */
export type AuthorizationVerdict = 'admit' | 'ask' | 'deny';

/** The three-conjunct send decision. `'review'` routes to the owner (the gate's
 *  `'ask'`); `'send'` means all three conjuncts passed; `'deny'` is a hard
 *  authorization refusal. */
export type QualitySendVerdict = 'send' | 'review' | 'deny';

/** WHICH conjunct decided — so the consumer surfaces the right review (an
 *  authorization approval vs a quality/whole-doc review) and Memory records why. */
export type ThreeConjunctReason =
  /** Authorization refused outright — no send, no review escape. */
  | 'authorization_denied'
  /** Authorization is not delegated for this send → the owner approves the
   *  AUTHORIZATION (value-bound tripped, or no authz grant). Quality never
   *  subsumes this (§12.1). */
  | 'authorization_ask'
  /** Authorization admits, but no accepted quality delegation matches (or the
   *  quality axis is paused) → the owner reviews the OUTPUT. */
  | 'quality_not_delegated'
  /** Authorization admits and quality is delegated, but the whole-document
   *  conjunct flagged (§12.2 — never fully delegated) → the owner reviews. */
  | 'whole_document_flagged'
  /** All three conjuncts passed → send. */
  | 'all_conjuncts_pass';

export interface ThreeConjunctResult {
  readonly verdict: QualitySendVerdict;
  readonly reason: ThreeConjunctReason;
}

/** What {@link evaluateThreeConjunctGate} composes. `authorization` is the
 *  ALREADY-resolved D-177 verdict (Switch A applied upstream). `switches` gate
 *  the QUALITY axis here (Switch A + Switch B). */
export interface ThreeConjunctGateInputs {
  /** The authorization verdict, re-derived independently every send (§12.1). */
  readonly authorization: AuthorizationVerdict;
  /** An accepted quality delegation matches this (recipe, op)
   *  ({@link matchesQualityDelegation}). v1 binary quality verdict (§14). */
  readonly qualityDelegationMatches: boolean;
  /** The owner's Switch A/B kill-switch state (§4). */
  readonly switches: QualityGateSwitches;
  /** The whole-document conjunct — ALWAYS evaluated, NEVER fully delegated
   *  (§12.2). v1 single-node: "the one region must pass" (the consumer supplies
   *  this; the mechanism is deferred, §13). */
  readonly wholeDocumentPasses: boolean;
}

/** D-202 §1 — the send-time gate: `send iff authorization ∧ per-region quality ∧
 *  whole-document`, evaluated at EVERY send. Pure.
 *
 *  The composition preserves the definitional invariants (§12):
 *    - authorization is CONSUMED as given, re-derived independently every send —
 *      a `'deny'` denies and an `'ask'` reviews REGARDLESS of quality, so a
 *      quality delegation can only ever GATE a send authorization already admits;
 *      it NEVER upgrades authorization (§12.1);
 *    - the whole-document conjunct is checked whenever a send would otherwise
 *      proceed, so it is never skipped (§12.2);
 *    - quality auto-accept requires BOTH a matching grant AND the quality axis
 *      un-paused ({@link qualityDelegationPaused} folds Switch A + Switch B). */
export const evaluateThreeConjunctGate = (
  inputs: ThreeConjunctGateInputs,
): ThreeConjunctResult => {
  // Authorization is re-derived independently every send; quality never subsumes it.
  if (inputs.authorization === 'deny') {
    return { verdict: 'deny', reason: 'authorization_denied' };
  }
  if (inputs.authorization === 'ask') {
    return { verdict: 'review', reason: 'authorization_ask' };
  }
  // authorization === 'admit' — the quality axis may remove the quality review.
  const qualityAutoAccept =
    inputs.qualityDelegationMatches && !qualityDelegationPaused(inputs.switches);
  if (!qualityAutoAccept) {
    return { verdict: 'review', reason: 'quality_not_delegated' };
  }
  // The whole-document conjunct always runs — never fully delegated (§12.2).
  if (!inputs.wholeDocumentPasses) {
    return { verdict: 'review', reason: 'whole_document_flagged' };
  }
  return { verdict: 'send', reason: 'all_conjuncts_pass' };
};
