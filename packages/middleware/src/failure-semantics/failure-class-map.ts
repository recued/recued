/** D-145 PB15 — closed map from `PlanStatus` to `FailureClass`.
 *
 *  Per § B.15.11 + § C.3.3. Every non-terminal-success plan status maps
 *  to exactly one failure_class for benchmark accounting. The map is
 *  the single source of truth — `composeFailureResult` consults it so
 *  callers never thread the class manually.
 *
 *  Closed-list registry — adding a new PlanStatus requires both:
 *    1. Widen `PLAN_STATUSES` in `@recued/contracts/recued-plan.ts`
 *    2. Add the corresponding entry here
 *  The ratchet test (`engine-failure-status-explicit.ratchet`) asserts
 *  every PlanStatus has a mapping.
 *
 *  Spec: § B.15.11 + § C.3.3. */

import {
  FAILURE_CLASS_SET,
  PLAN_STATUS_SET,
  type FailureClass,
  type PlanStatus,
} from '@recued/contracts';

/** Closed map. `'completed'` + `'preview_no_op'` map to `undefined`
 *  (no failure attribution). Every other status maps to a non-optional
 *  `FailureClass`.
 *
 *  Mapping rationale (per § C.3.3 benchmark categories):
 *
 *    - `cancelled_by_user` → `'capacity'` — user denied the engine the
 *      capability to proceed (approval declined / cancelled). Same
 *      bucket as capacity-gap for benchmark accounting; the AI did
 *      nothing wrong but the engine couldn't complete.
 *    - `cancelled_capacity_gap` → `'capacity'` — direct match.
 *    - `cancelled_si_conflict` → `'capacity'` — Standing Instruction
 *      conflict halts BEFORE the AI call; same bucket as capacity-gap
 *      because the engine couldn't compose a valid AI dispatch.
 *    - `cancelled_no_alternative` → `'synthesis'` — AI returned
 *      alternatives:[] + result:null; AI couldn't compose an acceptable
 *      solution from a sufficient packet.
 *    - `cancelled_privacy_violation` → `'privacy'` — direct match.
 *    - `cancelled_cost_ceiling` → `'cost'` — direct match.
 *    - `cancelled_malformed_ai` → `'synthesis'` — AI returned
 *      malformed output twice; the engine retried correctly but the
 *      generator couldn't produce a valid AIOutput shape.
 */
export const PLAN_STATUS_TO_FAILURE_CLASS: {
  readonly [K in PlanStatus]: FailureClass | undefined;
} = Object.freeze({
  completed: undefined,
  preview_no_op: undefined,
  cancelled_by_user: 'capacity',
  cancelled_capacity_gap: 'capacity',
  cancelled_si_conflict: 'capacity',
  cancelled_no_alternative: 'synthesis',
  cancelled_privacy_violation: 'privacy',
  cancelled_cost_ceiling: 'cost',
  cancelled_malformed_ai: 'synthesis',
});

/** Loader-time assertion: every `PlanStatus` has an entry. Drift
 *  surfaces immediately at module import (not at test time). */
{
  const mapKeys = Object.keys(PLAN_STATUS_TO_FAILURE_CLASS).sort();
  const expected = Array.from(PLAN_STATUS_SET).sort();
  if (
    mapKeys.length !== expected.length ||
    mapKeys.some((k, i) => k !== expected[i])
  ) {
    throw new Error(
      `PLAN_STATUS_TO_FAILURE_CLASS missing entries (have ${mapKeys.length}, want ${expected.length}): ${mapKeys.join(', ')} vs ${expected.join(', ')}`,
    );
  }
  for (const [status, klass] of Object.entries(PLAN_STATUS_TO_FAILURE_CLASS)) {
    if (klass !== undefined && !FAILURE_CLASS_SET.has(klass)) {
      throw new Error(
        `PLAN_STATUS_TO_FAILURE_CLASS['${status}'] = '${klass}' is not in FAILURE_CLASSES`,
      );
    }
  }
}

/** Returns the canonical FailureClass for a halt-status, or undefined
 *  for terminal-success statuses. Callers building plan results should
 *  use `composeFailureResult` instead — this is the substrate primitive
 *  it consults. */
export const failureClassForStatus = (status: PlanStatus): FailureClass | undefined =>
  PLAN_STATUS_TO_FAILURE_CLASS[status];
