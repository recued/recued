/** D-149 § N.6 "Open submission detail" — open ONE reception record's sealed blob, for the
 *  paired owner's `reception.record.open`.
 *
 *  Both record kinds share the merged table's one `submission_blob_encrypted`, sealed under
 *  the form-submission key (`form-pii.ts`), so one key opens either. They differ only in where
 *  the visitor's address lives: an intake seals it separately (`visitor_email_encrypted`, so
 *  the engine can read the address without the body); a booking keeps it as `fields.email`.
 *
 *  ⚠ THROWS on anything it cannot open — a rotated key, a tampered row, a blob without
 *  `fields`. The caller must answer that as "could not be opened", never as a record with no
 *  answers: an owner told "they left nothing" stops looking.
 *
 *  Spec: D-149 § N.6 + § A.14.1; D-210 § A.3. */

import type { ReceptionSealedRecord } from '../../reception-record-handler.js';
import type { FormSubmissionSummary } from '../../storage/reception-form-store.js';
import { openBookingSubmissionBlob } from './booking-blob.js';
import { openFormSubmissionField } from './form-pii.js';

export const openReceptionRecordBlob = async (input: {
  readonly key: Uint8Array;
  readonly row: FormSubmissionSummary;
}): Promise<ReceptionSealedRecord> => {
  const { key, row } = input;
  const at = { key, endpoint_id: row.endpoint_id, submission_id: row.submission_id };
  if (row.record_kind === 'booking') {
    const fields = await openBookingSubmissionBlob({ ...at, ciphertext: row.submission_blob_encrypted });
    return { visitor_email: fields.email, fields };
  }
  const [blob, email] = await Promise.all([
    openFormSubmissionField({ ...at, field: 'submission_blob', ciphertext: row.submission_blob_encrypted }),
    openFormSubmissionField({ ...at, field: 'visitor_email', ciphertext: row.visitor_email_encrypted }),
  ]);
  if (blob === null) throw new Error('openReceptionRecordBlob: the submission blob is absent');
  const parsed = JSON.parse(blob) as unknown;
  const fields = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { fields?: unknown }).fields
    : undefined;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('openReceptionRecordBlob: the submission blob carries no fields');
  }
  return {
    visitor_email: email !== null && email.length > 0 ? email : null,
    fields: fields as Readonly<Record<string, unknown>>,
  };
};
