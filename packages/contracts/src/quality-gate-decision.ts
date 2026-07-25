/** D-202 task 4a — the pure quality-gate decision orchestrator.
 *
 *  The gateway's ask-branch (`commit-gateway.ts`) consumes this: when the D-177
 *  authorization gate would ASK the owner to approve a dispatch and no
 *  authorization session grant matched, this composes the D-202 three-conjunct
 *  gate to decide whether a standing QUALITY delegation lets the send proceed
 *  without the per-artifact review.
 *
 *  It stitches two already-built pure primitives:
 *    1. D-209 §1.7 authorization provenance captured by the real admission
 *       resolver after every authorization layer and before review lifts.
 *    2. {@link evaluateThreeConjunctGate} — composes that authorization verdict
 *       with the matching-quality-delegation flag (un-paused by Switch A/B) and
 *       the whole-document conjunct.
 *
 *  The net rule (spec §1): `send iff authorization ∧ per-region quality ∧
 *  whole-document`. A `send` verdict skips the ask; anything else routes to the
 *  uniform review. Pure — no I/O, no clock, no mutation; the gateway supplies the
 *  delegation-match result + persisted switch state from its injected dep.
 *
 *  Provenance is deliberately consumed rather than reconstructing from risk: a
 *  source/profile or owner `always` tightening must survive quality delegation.
 *
 *  Spec: D-202 (§0.1 plain anchor, §1 the gate, §12.1 authz
 *  independence) + D-202 (§4 the 4a wiring). */

import type { AuthorizationProvenance } from './ingredient-catalog.js';
import {
  evaluateThreeConjunctGate,
  type AuthorizationVerdict,
  type QualityGateSwitches,
  type ThreeConjunctResult,
} from './quality-delegation.js';

/** What {@link resolveQualityGateDecision} needs from the gateway's ask-branch.
 *  Everything is per-dispatch state the gate already holds: the authorization
 *  provenance from the ask decision plus the quality-specific inputs. */
export interface QualityGateDecisionInputs {
  /** D-209 §1.7 — captured by the real authorization path before review lifts. */
  readonly authorization_provenance: AuthorizationProvenance;
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
 *  ask-branch. Reads the authorization conjunct captured BEFORE quality-review
 *  lifts (so a lift-driven owner send resolves to `admit` and a matching quality
 *  delegation can auto-accept it, while a genuine authz `ask` — a contracted
 *  write or owner `always` — holds regardless of quality, §12.1), then folds in
 *  the quality delegation + Switch A/B + whole-document. Returns the full
 *  {@link ThreeConjunctResult} (`send` skips the ask; `review` routes to the
 *  owner; `deny` is a hard authorization refusal, unreachable from an ask-branch
 *  where a deny already threw). Pure. */
export const resolveQualityGateDecision = (
  inputs: QualityGateDecisionInputs,
): ThreeConjunctResult => {
  const authorization: AuthorizationVerdict =
    inputs.authorization_provenance.pre_lift_approval === 'never'
      ? 'admit'
      : 'ask';
  return evaluateThreeConjunctGate({
    authorization,
    qualityDelegationMatches: inputs.qualityDelegationMatches,
    switches: inputs.switches,
    wholeDocumentPasses: inputs.wholeDocumentPasses ?? true,
  });
};
