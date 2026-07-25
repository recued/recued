/** D-145 PB15 — approval decision → failure mapping.
 *
 *  Per § B.15.3. When `approval.request` returns with the user's
 *  response, the engine maps the decision to the matching halt path:
 *
 *    - `decision: 'approved'` → continue (no failure)
 *    - `decision: 'declined'` → halt `cancelled_by_user`
 *    - `decision: 'cancelled'` → halt `cancelled_by_user`
 *    - `decision: 'timeout'` → halt `cancelled_by_user` with detail
 *      'approval_unavailable' (the spec calls this `approval_unavailable`
 *      but the canonical PlanStatus is `cancelled_by_user` — the
 *      audit-detail discriminator preserves the timeout reason).
 *
 *  Pure helper — caller decides when to call (typically immediately
 *  after `approval.request` returns).
 *
 *  Spec: § B.15.3 + D-113 approval substrate. */

import type { ApprovalDecision } from '../primitives/approval-request.js';
import { composeFailureResult, type ComposedFailureResult } from './compose-failure-result.js';

export type ApprovalHaltKind = 'denied' | 'expired' | 'cancelled';

export interface ApprovalMappingOk {
  readonly kind: 'continue';
}

export interface ApprovalMappingHalt {
  readonly kind: 'halt';
  readonly halt_kind: ApprovalHaltKind;
  readonly result: ComposedFailureResult;
}

export type ApprovalMappingResult = ApprovalMappingOk | ApprovalMappingHalt;

/** Map an `ApprovalDecision` to a continue / halt branch. Throws on
 *  unknown decisions (off-list — caller's adapter is misbehaving). */
export const mapApprovalDecision = (decision: ApprovalDecision): ApprovalMappingResult => {
  if (decision === 'approved') {
    return { kind: 'continue' };
  }
  if (decision === 'declined') {
    return {
      kind: 'halt',
      halt_kind: 'denied',
      result: composeFailureResult({
        status: 'cancelled_by_user',
        detail: '(approval_denied)',
      }),
    };
  }
  if (decision === 'cancelled') {
    return {
      kind: 'halt',
      halt_kind: 'cancelled',
      result: composeFailureResult({
        status: 'cancelled_by_user',
        detail: '(approval_cancelled)',
      }),
    };
  }
  if (decision === 'timeout') {
    return {
      kind: 'halt',
      halt_kind: 'expired',
      result: composeFailureResult({
        status: 'cancelled_by_user',
        detail: '(approval_unavailable)',
      }),
    };
  }
  // Off-list — defensive. Adapter is misbehaving.
  throw new Error(
    `mapApprovalDecision: unknown ApprovalDecision '${String(decision)}' — adapter returned an off-list value`,
  );
};
