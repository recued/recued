/** D-210 §3 — the ONE rule that decides whether a pending reception row still owes the
 *  DEFAULT dispatch, shared by every kind's drain processor.
 *
 *  ## The rule
 *
 *  The compiled `review-then-approve` recipe a drain fires through `FireReceptionWorkflow`
 *  is the **DEFAULT** — what a submission becomes when the owner paired NOTHING. It is not
 *  "the reception path"; it is the fallback for an unpaired endpoint.
 *
 *      pair_binding === null   →  the default dispatches. The ordinary D-149 / D-173 funnel.
 *      pair_binding !== null   →  the SUBMIT path already ran the owner's recipe through the
 *                                 D-207 gated runner (`coordinatePairedRun`), and its ops held
 *                                 at the Gateway under the door's own contract. Firing the
 *                                 default too would materialize a SECOND artifact for ONE
 *                                 submission.
 *
 *  ⚠ The row is the authority, not the pair table. A pair bound AFTER a row was submitted
 *  must not retroactively claim that row — the binding is stamped at render/submit time
 *  precisely so the drain reads what actually happened, never what is true now.
 *
 *  ## The one legacy exception, and why it INVERTS rather than bends the rule
 *
 *  A D-200 paid direct-checkout pair ran no recipe at submit, so for it the default IS the
 *  path — deliberately DEFERRED until provider truth says paid (D-200 slice 6g.16). That is
 *  the only shape in which a paired row may still dispatch.
 *
 *  ⚠ It is a corpse held open for old servers. D-207 3d·6 deleted the phase machine and the
 *  seven ops that wrote its `data.shared` state rows, and 3d·6c deleted its coordinator, so
 *  NOTHING can create such a state row any more: on a fresh install this admitter always
 *  defers at `state_missing` and the branch is a constant. It admits only for a v4 row an
 *  already-upgraded server happens to hold. It dies with its pack — and when it goes, this
 *  whole function collapses to `pair_binding === null`.
 *
 *  ⛔ Do NOT read the admitter as "payment decides whether reception dispatches." It does
 *  not, and has not since the eviction. Payment decides one legacy profile's DEFERRAL; the
 *  binding decides everything else. Anyone generalizing this later should delete the branch,
 *  not widen it.
 *
 *  Spec: D-210 §3; D-207 §5.3; D-149 § A.5.3. */

import {
  isReceptionFormPairBinding,
  type ReceptionPairBinding,
} from '@recued/contracts';

import type { AdmitPaidDocumentDirectCheckoutReview } from '../../paid-document-direct-checkout-review-admission.js';

export interface PairedRowDefaultDispatchInput {
  /** The row's OWN stamped binding — never a live re-read of the pair table. `null` = the
   *  endpoint was unpaired when this row was taken. */
  readonly pair_binding: ReceptionPairBinding | null;
  /** The row's id (`submission_id` / `request_id`) — the join the legacy admitter reads. */
  readonly row_id: string;
  /** Absent ⇒ the legacy exception cannot be evaluated ⇒ a paired row does not dispatch
   *  (fail closed). Composition omits it only on a partial boot. */
  readonly admitPaidDirectCheckoutReview?: AdmitPaidDocumentDirectCheckoutReview;
}

/** `true` ⇒ this row still owes the DEFAULT dispatch (the compiled review-then-approve
 *  recipe). `false` ⇒ it does not: either the submit path already ran the owner's paired
 *  recipe, or the one legacy profile is deferring until payment.
 *
 *  Fail-closed by construction: every uncertain path returns `false`. A `false` never
 *  classifies the row corrupt — the caller leaves it pending, which stays retryable. */
export const rowOwesDefaultDispatch = async (
  input: PairedRowDefaultDispatchInput,
): Promise<boolean> => {
  // UNPAIRED — the default is the whole path.
  if (input.pair_binding === null) return true;

  // PAIRED, and NOT form-shaped ⇒ a D-210 scheduling pair (v3). The legacy deferral below
  // is a D-200 PAID-DOCUMENT profile keyed on a form submission id; a booking is not one and
  // can never be admitted by it. Narrow here rather than let the admitter answer: handed a
  // v3 it would look up a submission id that cannot exist, return `not_found`, and the row
  // would take the DEFAULT path — the paired recipe silently skipped in favour of the
  // pack's. The exception does not apply, so the paired path owns the row.
  if (!isReceptionFormPairBinding(input.pair_binding)) return false;

  // PAIRED — the submit path owns it, EXCEPT for the dying D-200 deferral above.
  if (input.admitPaidDirectCheckoutReview === undefined) return false;
  const admission = await input.admitPaidDirectCheckoutReview({
    submission_id: input.row_id,
    pair_binding: input.pair_binding,
  }).catch(() => null);
  // Source unavailability is retryable. The admitter is designed not to throw, but an
  // injected seam must still fail closed without classifying the encrypted row as corrupt.
  return admission !== null && admission.kind === 'admitted';
};
