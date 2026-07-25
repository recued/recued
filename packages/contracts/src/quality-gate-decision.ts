/** D-202 task 4a — the pure quality-gate decision orchestrator.
 *
 *  The gateway's ask-branch (`commit-gateway.ts`) consumes this: when the D-177
 *  authorization gate would ASK the owner to approve a dispatch and no
 *  authorization session grant matched, this composes the D-202 three-conjunct
 *  gate to decide whether a standing QUALITY delegation lets the send proceed
 *  without the per-artifact review.
 *
 *  It stitches two already-built pure primitives:
 *    1. {@link admitByOpRiskWithoutQualityLifts} — re-derives the AUTHORIZATION
 *       conjunct: op-risk under the trust ceiling with the "review the AI output"
 *       lifts (outbound-send / commitment-proposal) STRIPPED. So an owner-driven
 *       outbound send RELAXES to `admit` (the lifted `ask` was purely the review),
 *       while a contracted AI's write / a destructive op stay `ask` (a genuine
 *       authorization concern quality must never skip — spec §12.1).
 *    2. {@link evaluateThreeConjunctGate} — composes that authorization verdict
 *       with the matching-quality-delegation flag (un-paused by Switch A/B) and
 *       the whole-document conjunct.
 *
 *  The net rule (spec §1): `send iff authorization ∧ per-region quality ∧
 *  whole-document`. A `send` verdict skips the ask; anything else routes to the
 *  uniform review. Pure — no I/O, no clock, no mutation; the gateway supplies the
 *  delegation-match result + persisted switch state from its injected dep.
 *
 *  ⚠ The authorization conjunct is an args-BLIND op-risk recompute — see the
 *  SOUNDNESS BOUND on {@link admitByOpRiskWithoutQualityLifts}: it is a faithful
 *  authorization stand-in only while op-risk+lift is the admission's sole `ask`
 *  source. A value-bound (spec §1) or any future args-keyed `ask` MUST instead
 *  route this conjunct through the real suppressed-lift admission, else a
 *  value-bound-tripped send with a quality delegation would wrongly skip (§12.1).
 *
 *  Spec: `docs/d-202-spec.md` (§0.1 plain anchor, §1 the gate, §12.1 authz
 *  independence) + `docs/d-202-quality-gate-seams.md` (§4 the 4a wiring). */

import type { ExecutionSource } from './commits.js';
import type { RiskTier } from './ingredient.js';
import {
  admitByOpRiskWithoutQualityLifts,
  resolveTrustCeiling,
} from './op-risk-admission.js';
import {
  evaluateThreeConjunctGate,
  type AuthorizationVerdict,
  type QualityGateSwitches,
  type ThreeConjunctResult,
} from './quality-delegation.js';

/** What {@link resolveQualityGateDecision} needs from the gateway's ask-branch.
 *  Everything is per-dispatch state the gate already holds: the dispatched slug
 *  + the ask decision's `risk_tier` + the run's `ExecutionSource` (for the trust
 *  ceiling), plus the two quality-specific inputs the injected dep resolves. */
export interface QualityGateDecisionInputs {
  /** The dispatched ingredient slug (the ask decision's tool). */
  readonly slug: string;
  /** The ask decision's `effective_risk_tier` — the op-risk the authorization
   *  conjunct is re-derived from (audit-honest; a send carries `write`). */
  readonly risk_tier: RiskTier;
  /** The run's execution source — drives the applicable trust ceiling
   *  ({@link resolveTrustCeiling}: owner/automation `admin`, contracted door LOW). */
  readonly source: ExecutionSource;
  /** An accepted quality delegation matches this dispatch's `(recipe, op)`
   *  (`matchesQualityDelegation` over the active set, resolved by the gate's
   *  injected dep). v1 binary quality verdict (§14). */
  readonly qualityDelegationMatches: boolean;
  /** The owner's persisted Switch A/B kill-switch state (§4). */
  readonly switches: QualityGateSwitches;
  /** The whole-document conjunct — ALWAYS evaluated, NEVER fully delegated
   *  (§12.2). v1 single-node placeholder defaults to `true` ("the one region
   *  passes"); the mechanism is deferred (§13). */
  readonly wholeDocumentPasses?: boolean;
}

/** D-202 §1 — compose the three-conjunct send gate at the authorization
 *  ask-branch. Re-derives the authorization conjunct WITHOUT the quality-review
 *  lifts (so a lift-driven owner send resolves to `admit` and a matching quality
 *  delegation can auto-accept it, while a genuine authz `ask` — a contracted
 *  write, a destructive op — holds regardless of quality, §12.1), then folds in
 *  the quality delegation + Switch A/B + whole-document. Returns the full
 *  {@link ThreeConjunctResult} (`send` skips the ask; `review` routes to the
 *  owner; `deny` is a hard authorization refusal, unreachable from an ask-branch
 *  where a deny already threw). Pure. */
export const resolveQualityGateDecision = (
  inputs: QualityGateDecisionInputs,
): ThreeConjunctResult => {
  const authorization: AuthorizationVerdict = admitByOpRiskWithoutQualityLifts({
    slug: inputs.slug,
    risk_tier: inputs.risk_tier,
    ceiling: resolveTrustCeiling(inputs.source),
  }).verdict;
  return evaluateThreeConjunctGate({
    authorization,
    qualityDelegationMatches: inputs.qualityDelegationMatches,
    switches: inputs.switches,
    wholeDocumentPasses: inputs.wholeDocumentPasses ?? true,
  });
};
