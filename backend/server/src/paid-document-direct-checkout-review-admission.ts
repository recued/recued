/** D-200 Slice 6g.16 — exact paid admission for direct-checkout review.
 *
 * Both the D-149 drain (before creating an Inbox approval) and the D-199
 * pre-resume promotion hook use this one source check. The immutable Reception
 * submission/pair remains the join authority; provider return parameters and
 * the editable held projection are never consulted.
 *
 * D-207 3d·6 — the D-200 phase machine (`paid-document-fulfillment.ts`) and
 * the seven ops that wrote its `data.shared` state rows are deleted. Nothing
 * can create such a row any more, so on a fresh install every admission
 * defers at `state_missing` — the check is kept (owner boundary: the drain
 * and the D-199 hook are real consumers) with a NARROW inline validator that
 * preserves the exact admit/defer boundary: a row is admitted only in the one
 * shape the V4 flow ever admitted (schema_version 4, provider-verified
 * `paid`, request source matching this submission + pair). Both consumers
 * branch solely on `kind === 'admitted'`. */

import {
  PAID_DOCUMENT_FULFILLMENT_BUNDLE_KEY,
  isReceptionFormPairBinding,
  isPaidDocumentFulfillmentSubmissionId,
  recipeBundleSharedPrefix,
  type ReceptionFormPairBinding,
} from '@recued/contracts';

import type { SharedStore } from './storage/shared-store.js';

export type PaidDocumentDirectCheckoutReviewAdmissionReason =
  | 'not_configured'
  | 'source_unavailable'
  | 'state_missing'
  | 'state_invalid'
  | 'pair_mismatch'
  | 'payment_unverified'
  | 'approval_precedes_payment';

export type PaidDocumentDirectCheckoutReviewAdmissionOutcome =
  | {
      readonly kind: 'admitted';
      readonly state_revision: number;
      readonly verified_at: number;
    }
  | {
      readonly kind: 'deferred';
      readonly reason: PaidDocumentDirectCheckoutReviewAdmissionReason;
    };

export interface PaidDocumentDirectCheckoutReviewAdmissionInput {
  readonly submission_id: string;
  readonly pair_binding: ReceptionFormPairBinding;
  /** Present only at the D-199 pre-resume boundary. An approval answered before
   * verified payment may not become valid later merely because a recovery
   * sweep observes payment after the fact. */
  readonly approved_at?: number;
}

export type AdmitPaidDocumentDirectCheckoutReview = (
  input: PaidDocumentDirectCheckoutReviewAdmissionInput,
) => Promise<PaidDocumentDirectCheckoutReviewAdmissionOutcome>;

const deferred = (
  reason: PaidDocumentDirectCheckoutReviewAdmissionReason,
): PaidDocumentDirectCheckoutReviewAdmissionOutcome => ({ kind: 'deferred', reason });

/** The retired phase machine's stable row key for one submission. */
const legacyStateKey = (submissionId: string): string | null => {
  if (!isPaidDocumentFulfillmentSubmissionId(submissionId)) return null;
  const prefix = recipeBundleSharedPrefix(
    PAID_DOCUMENT_FULFILLMENT_BUNDLE_KEY,
    'state',
  );
  return prefix === null ? null : `${prefix}${submissionId}`;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const pairMatches = (
  left: ReceptionFormPairBinding,
  right: ReceptionFormPairBinding,
): boolean => left.version === right.version
  && left.form_definition_id === right.form_definition_id
  && left.recipe_id === right.recipe_id
  && left.recipe_version === right.recipe_version
  && left.pair_revision === right.pair_revision;

export const createPaidDocumentDirectCheckoutReviewAdmission = (
  sharedStore: Pick<SharedStore, 'read'> | undefined,
): AdmitPaidDocumentDirectCheckoutReview => async (input) => {
  if (sharedStore === undefined) return deferred('not_configured');
  if (typeof input?.submission_id !== 'string'
    || !isReceptionFormPairBinding(input.pair_binding)
    || (input.approved_at !== undefined
      && (!Number.isSafeInteger(input.approved_at) || input.approved_at < 0))) {
    return deferred('state_invalid');
  }
  const stateKey = legacyStateKey(input.submission_id);
  if (stateKey === null) return deferred('state_invalid');

  let stored: Awaited<ReturnType<SharedStore['read']>>;
  try {
    stored = await sharedStore.read(stateKey);
  } catch {
    return deferred('source_unavailable');
  }
  if (stored === null) return deferred('state_missing');
  const state = asRecord(stored.value);
  if (stored.key !== stateKey
    || state === null
    || stored.cas_revision === null
    || !Number.isSafeInteger(state.revision)
    || stored.cas_revision !== state.revision
    || state.schema_version !== 4
    || state.submission_id !== input.submission_id) {
    return deferred('state_invalid');
  }
  const checkout = asRecord(state.checkout);
  const request = asRecord(checkout?.request);
  const source = asRecord(request?.source);
  if (source === null
    || source.submission_id !== input.submission_id
    || !isReceptionFormPairBinding(source.pair_binding)
    || !pairMatches(source.pair_binding, input.pair_binding)) {
    return deferred('pair_mismatch');
  }
  const verifiedAt = checkout?.verified_at;
  if (state.phase !== 'paid'
    || checkout?.verified_status !== 'paid'
    || !Number.isSafeInteger(verifiedAt)
    || (verifiedAt as number) < 0) {
    return deferred('payment_unverified');
  }
  if (input.approved_at !== undefined && input.approved_at < (verifiedAt as number)) {
    return deferred('approval_precedes_payment');
  }
  return {
    kind: 'admitted',
    state_revision: state.revision as number,
    verified_at: verifiedAt as number,
  };
};
