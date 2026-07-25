/** D-210 WS3 — resolve a reception submission's SEALED visitor email at
 *  materialize time, for the `contact` projection branch.
 *
 *  ## Why the email is not simply in the payload
 *
 *  A contact IS an email-keyed identity, so the contact branch cannot run
 *  without one. But the intake review payload is deliberately email-free: it
 *  rides the compiled `review-then-approve` recipe as `context.event.payload`
 *  and lands in the held operation's args, which means it enters STEP STATE —
 *  readable by any step in that recipe, and editable at the approval gate. The
 *  visitor's address is sealed in the reception row precisely so it never
 *  becomes queryable data (D-138-gated).
 *
 *  So the email is resolved HERE instead: at the moment of materialize, from
 *  the submission id the payload's provenance metadata already carries,
 *  decrypting exactly one field and handing it straight to the contact upsert.
 *  It is never returned to the caller, never logged, and never re-enters the
 *  payload.
 *
 *  This is the same shape D-210 §7 established for `notify-booking-visitor`:
 *  the caller names the RECORD, the server resolves the identity. There the
 *  motive was that a recipe must not hold the address; here it is that a held
 *  operation must not carry it. Same seal, same answer.
 *
 *  ## Failure posture
 *
 *  Returns `null` for "no such submission / no email on it" — a data-level
 *  absence the caller turns into a fail-closed projection error (a contact with
 *  no key cannot be written, and inventing one would be inventing an identity).
 *  A LOCKED VAULT throws from the key getter and is deliberately left to
 *  propagate: that is transient, and the D-153 no-auto-resume posture wants the
 *  approval retried after unlock, not recorded as a permanent failure.
 *
 *  Spec: `docs/d-210-spec.md`; the seal is `ports/reception/form-pii.ts`. */

import { openFormSubmissionField } from '../form-pii.js';
import type { FormSubmissionStore } from '../../../storage/reception-form-store.js';

export interface ReceptionSealedVisitorEmailSeamDeps {
  /** The reception submission rows — read-only, by id. */
  readonly submissionStore: Pick<FormSubmissionStore, 'findById'>;
  /** Live form-PII key getter. Throws on a locked vault; see the header. */
  readonly getFormSubmissionPiiKey: () => Uint8Array;
}

/** Resolve one submission's sealed visitor email. `null` when the submission
 *  is unknown or carried no email (an `email: 'omit'` form). */
export type ReceptionSealedVisitorEmailResolver = (
  submission_id: string,
) => Promise<string | null>;

export const createReceptionSealedVisitorEmailSeam = (
  deps: ReceptionSealedVisitorEmailSeamDeps,
): ReceptionSealedVisitorEmailResolver => async (submission_id) => {
  const row = deps.submissionStore.findById(submission_id);
  if (row === null) return null;
  // Decrypt EXACTLY the one field. The submission blob (every answer the
  // visitor gave) is deliberately not opened here — the contact branch needs
  // an identity key, not the submission, and the mapped display name already
  // travelled in the payload as ordinary field data.
  const email = await openFormSubmissionField({
    key: deps.getFormSubmissionPiiKey(),
    endpoint_id: row.endpoint_id,
    submission_id: row.submission_id,
    field: 'visitor_email',
    ciphertext: row.visitor_email_encrypted,
  });
  return email !== null && email.trim().length > 0 ? email : null;
};
