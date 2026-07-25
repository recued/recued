/** D-145 PB15 — bridge-disconnect-after-Dry-Run detection.
 *
 *  Per § B.15.5. Dry Run (per § B.5.4) generates a plan with
 *  `preview: true` flag; user reviews + clicks Confirm. If the bridge
 *  disconnects between Dry Run and Confirm:
 *
 *    - Engine re-walks `capacity_spec` at Confirm time; if
 *      `bridge_online` capacity now fails, engine halts with
 *      `capacity_gap_post_dry_run`.
 *    - The original Dry Run plan persists (status: 'preview_no_op');
 *      a new plan with status: 'cancelled_capacity_gap' records the
 *      re-walk failure.
 *    - Engine offers `bridge_required: false` fallback when applicable
 *      (e.g., a request that touched social.facebook but could complete
 *      on memory.recall + commitments alone).
 *
 *  Pure helper — caller (the PB13 confirmRecuedRequest wrapper) feeds
 *  in the original Dry Run plan + the Confirm-time
 *  capacity-walk result. The helper decides:
 *    - `proceed` — no gap detected; safe to invoke
 *    - `halt` — bridge_online gap; failure result composed
 *    - `degrade` — bridge gap but the plan has a bridge_required:false
 *      fallback path (caller threads the fallback policy)
 *
 *  Spec: § B.15.5 + § B.5.4. */

import type { CapacityCheck, RecuedPlan } from '@recued/contracts';

import {
  composeFailureResult,
  type ComposedFailureResult,
} from './compose-failure-result.js';

export interface BridgeDisconnectInput {
  /** Original Dry Run plan (status: 'preview_no_op'). */
  readonly dry_run_plan: RecuedPlan;
  /** Re-walked capacity_spec at Confirm time. Caller threads through
   *  the same walker used at Dry Run; this helper only inspects the
   *  results. */
  readonly confirm_time_walks: ReadonlyArray<CapacityCheck>;
  /** True when the original plan had a bridge-free fallback path
   *  (e.g. memory.recall + commitments only) the caller can route to
   *  instead of halting. */
  readonly has_bridge_free_fallback?: boolean;
}

export type BridgeDisconnectDecision =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'halt'; readonly result: ComposedFailureResult }
  | { readonly kind: 'degrade_to_fallback'; readonly note: string };

/** Pure decision: does the Confirm-time capacity walk show a
 *  bridge_online gap that warrants halting? */
export const decideBridgeDisconnectPath = (
  input: BridgeDisconnectInput,
): BridgeDisconnectDecision => {
  // Find any bridge_online check that's now in a gap state (ok=false).
  const bridgeGap = input.confirm_time_walks.find(
    (check) => check.kind === 'bridge_online' && check.ok === false,
  );

  if (bridgeGap === undefined) {
    return { kind: 'proceed' };
  }

  if (input.has_bridge_free_fallback === true) {
    return {
      kind: 'degrade_to_fallback',
      note: `bridge_online_lost_post_dry_run dry_run_plan_id=${input.dry_run_plan.plan_id}`,
    };
  }

  return {
    kind: 'halt',
    result: composeFailureResult({
      status: 'cancelled_capacity_gap',
      detail: `(bridge_online_lost_post_dry_run dry_run_plan_id=${input.dry_run_plan.plan_id})`,
    }),
  };
};
