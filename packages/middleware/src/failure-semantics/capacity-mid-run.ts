/** D-145 PB15 — capacity-gap-mid-run detection helper.
 *
 *  Per § B.15.4. Capacities are snapshot at `capacity_spec` walk;
 *  mid-run capacity loss is detected at primitive-call time when the
 *  primitive returns one of the substrate-known capacity-gap statuses:
 *
 *    - `bridge_online` loss   → `bridge.dispatch` returns
 *      `mv3_lifecycle_killed` (D-148 § A.3.3) and idempotency cache
 *      replay on reconnect fails after step timeout. Engine treats
 *      as `capacity_gap_mid_run` if no reconnect within step
 *      timeout.
 *    - `ingredient_installed` loss → primitive call returns
 *      `ingredient_unavailable`.
 *    - `logged_in` cache invalidated → primitive call returns
 *      `capacity_gap_logged_in`.
 *
 *  This module ships the discriminator + decision: takes a
 *  `PrimitiveCall` row's status + outcome_summary + the original
 *  capacity_spec walk and produces a typed halt-or-continue decision.
 *
 *  Pure helper — no IO, no mutation. Orchestration policy calls per
 *  primitive_call return.
 *
 *  Spec: § B.15.4 + D-148 § A.3.3. */

import type { CapacityRequirement, PrimitiveCall } from '@recued/contracts';

/** Closed-list reasons the substrate recognizes as mid-run capacity
 *  loss (drift requires substrate D-spec work). */
export const CAPACITY_GAP_MID_RUN_REASONS = [
  'mv3_lifecycle_killed',
  'ingredient_unavailable',
  'capacity_gap_logged_in',
  'connection_revoked',
  'pool_quota_exhausted_mid_run',
] as const;
export type CapacityGapMidRunReason = (typeof CAPACITY_GAP_MID_RUN_REASONS)[number];
export const CAPACITY_GAP_MID_RUN_REASON_SET: ReadonlySet<CapacityGapMidRunReason> = new Set(
  CAPACITY_GAP_MID_RUN_REASONS,
);

/** Map a reason → the matching CapacityRequirement.kind. Used by the
 *  detector to synthesize the `capacity_gap_mid_run` transparency
 *  event's `gap` field when the original requirement isn't passed
 *  directly. */
const REASON_TO_REQUIREMENT_KIND: {
  readonly [K in CapacityGapMidRunReason]: CapacityRequirement['kind'];
} = Object.freeze({
  mv3_lifecycle_killed: 'bridge_online',
  ingredient_unavailable: 'ingredient_installed',
  capacity_gap_logged_in: 'logged_in',
  connection_revoked: 'connection_active',
  pool_quota_exhausted_mid_run: 'pool_quota_available',
});

export interface CapacityMidRunDetectInput {
  readonly call: PrimitiveCall;
  /** Optional original CapacityRequirement that became unavailable.
   *  When the policy threads it from the original capacity_spec walk,
   *  the result carries it verbatim; otherwise the detector synthesizes
   *  a minimal requirement from the reason discriminator. */
  readonly original_requirement?: CapacityRequirement;
}

export type CapacityMidRunDetectResult =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'gap_detected';
      readonly reason: CapacityGapMidRunReason;
      readonly gap: CapacityRequirement;
      readonly affected_intent_id?: string;
    };

/** Detect whether a PrimitiveCall row represents mid-run capacity loss.
 *  The detector inspects `call.status` + `call.outcome_summary` —
 *  status `'capacity_gap_mid_run'` is a direct hit; other statuses
 *  with a known-reason outcome_summary token also resolve. */
export const detectCapacityGapMidRun = (
  input: CapacityMidRunDetectInput,
): CapacityMidRunDetectResult => {
  const { call } = input;

  if (call.status !== 'capacity_gap_mid_run' && call.status !== 'error') {
    return { kind: 'ok' };
  }

  // Look up reason in the outcome_summary. Outcome summaries are
  // closed-character (audit-clean) so substring match is safe. We
  // search for any of the closed-list reasons.
  const summary = call.outcome_summary ?? '';
  let detectedReason: CapacityGapMidRunReason | undefined;
  for (const reason of CAPACITY_GAP_MID_RUN_REASONS) {
    if (summary.includes(reason)) {
      detectedReason = reason;
      break;
    }
  }

  if (detectedReason === undefined && call.status === 'error') {
    // status='error' without a known reason isn't a capacity gap —
    // it's a generic error. Let it pass.
    return { kind: 'ok' };
  }

  // capacity_gap_mid_run status with no known reason defaults to
  // bridge_online (most common mid-run loss path).
  const reason: CapacityGapMidRunReason = detectedReason ?? 'mv3_lifecycle_killed';

  // Build the gap requirement. Prefer the caller's threaded
  // requirement when available; otherwise synthesize a minimal one.
  let gap: CapacityRequirement;
  if (input.original_requirement !== undefined) {
    gap = input.original_requirement;
  } else {
    const reqKind = REASON_TO_REQUIREMENT_KIND[reason];
    switch (reqKind) {
      case 'bridge_online':
        gap = { kind: 'bridge_online' };
        break;
      case 'ingredient_installed':
        gap = { kind: 'ingredient_installed', slug: '<unknown>' };
        break;
      case 'logged_in':
        gap = { kind: 'logged_in', site: '<unknown>' };
        break;
      case 'connection_active':
        gap = { kind: 'connection_active', vendor: '<unknown>' };
        break;
      case 'pool_quota_available':
        gap = { kind: 'pool_quota_available', pool: 'free' };
        break;
      default:
        gap = { kind: 'bridge_online' };
    }
  }

  return {
    kind: 'gap_detected',
    reason,
    gap,
    ...(call.intent_id !== undefined ? { affected_intent_id: call.intent_id } : {}),
  };
};
