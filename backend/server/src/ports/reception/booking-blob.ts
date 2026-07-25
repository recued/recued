/** D-210 A.8 slice 4b-ii — the booking's visitor fields, as ONE sealed blob.
 *
 *  ## What moved
 *
 *  Through 4b-i a booking's visitor fields lived in FOUR named columns
 *  (`visitor_name_encrypted` / `_email_` / `_phone_` / `_topic_`) plus a fifth
 *  ciphertext stashed in `metadata_blob` because § A.5.2 never gave `notes` a
 *  column. The merged table has ONE `submission_blob_encrypted`, so the five
 *  fold into it — which is the real work of the switch, and the reason
 *  `submission_blob_encrypted NOT NULL` can hold: `name` is admitted only as
 *  `'required'`, so a booking always has plaintext to seal.
 *
 *  ## 🔑 The KEY changes, and it has to
 *
 *  These seal under the FORM-submission PII key (`form-pii.ts`, HKDF info
 *  `…/form_submission_pii`, AAD `…/reception/form_submission/<ep>/<id>/<field>`),
 *  NOT the booking key (HKDF info `…/booking_visitor_pii`, AAD
 *  `…/reception/booking/…`) that `booking-pii.ts` used to derive — slice 4c
 *  deleted that module once this seal had moved. Both HKDF'd from the same
 *  reception sub-DEK, so no new key material ever existed or was needed.
 *
 *  ⛔ It is not a preference. The row IS a `reception_form_submission` row and
 *  every reader of that table opens with `openFormSubmissionField`. Leaving
 *  bookings on their own key would mean each reader must first ask which flow
 *  wrote a row before it can pick a key to open it with — reintroducing at the
 *  crypto layer exactly the two-substrates split the table merge removes.
 *
 *  ⚠ Pre-launch, zero installs ⇒ no migration: rows sealed under the old key
 *  are dev data. Recreate the dev DB. (D-062 posture; see the 4a schema note on
 *  the same point for `form_definition_id`.)
 *
 *  ## The shape is INTAKE's shape
 *
 *  `{ visitor_email?, fields }` — byte-for-byte the envelope `intake-form.ts`
 *  writes. A booking IS a form submission in every respect that matters to a
 *  reader (D-210 A.3), and `reception-recipe-runner-adapter.ts` already opens
 *  an intake blob and hands `.fields` straight to a recipe as
 *  `context.reception_submission`. One envelope means that reader can serve
 *  both without branching.
 *
 *  ⚠ `visitor_email` is redundant for a booking — `fields.email` is canonical,
 *  since the booking field vocabulary is CLOSED where an authored form's is not.
 *  It is carried anyway so the two blobs are one shape rather than two that
 *  merely resemble each other. Readers here take `fields.email`.
 *
 *  Spec: `docs/d-210-spec.md` § A.3; `docs/d-149-spec.md` § A.5.2 + § N.6. */

import {
  SCHEDULING_LINK_VISITOR_FIELD_NAMES,
  type SchedulingLinkVisitorFieldRequirements,
} from '@recued/contracts';

import { openFormSubmissionField, sealFormSubmissionField } from './form-pii.js';

/** Every declared visitor field, opened. `null` = the visitor left it blank OR
 *  the endpoint does not collect it — the two are indistinguishable HERE by
 *  design, exactly as they were when each field was its own nullable column.
 *  `booking-record.ts` is what re-separates them, against the CURRENT config. */
export type BookingVisitorFields = Readonly<
  Record<keyof SchedulingLinkVisitorFieldRequirements, string | null>
>;

/** ⛔ Empty string collapses to `null`, matching what the columns did:
 *  `sealBookingField` returned `null` for `''`, so a blank field and an absent
 *  one have always been the same row state. Preserving that keeps the switch a
 *  storage change rather than a silent semantic one. */
const normalize = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** Seal the visitor's fields into the one blob the merged table carries.
 *
 *  Every field in the closed vocabulary is written, present-or-null — NOT only
 *  the ones this endpoint declares. The columns behaved that way (five columns,
 *  some null, regardless of config) and `booking-record.ts` filters by the
 *  config it reads at DRAIN time. Writing only the declared set would move that
 *  decision to submit time, where a later config edit could not be honoured. */
export const sealBookingSubmissionBlob = async (input: {
  readonly key: Uint8Array;
  readonly endpoint_id: string;
  readonly submission_id: string;
  readonly fields: Partial<Record<keyof SchedulingLinkVisitorFieldRequirements, string | null | undefined>>;
}): Promise<string> => {
  const fields: Record<string, string | null> = {};
  for (const name of SCHEDULING_LINK_VISITOR_FIELD_NAMES) {
    fields[name] = normalize(input.fields[name]);
  }
  const email = fields.email;
  const blobJson = JSON.stringify({
    ...(email !== null ? { visitor_email: email } : {}),
    fields,
  });
  const sealed = await sealFormSubmissionField({
    key: input.key,
    endpoint_id: input.endpoint_id,
    submission_id: input.submission_id,
    field: 'submission_blob',
    plaintext: blobJson,
  });
  if (sealed === null) {
    // Unreachable — `blobJson` always carries the `fields` object, so it is
    // never empty. Loud rather than persisting a row whose NOT NULL blob would
    // have to be faked.
    throw new Error('sealBookingSubmissionBlob: seal returned null for a non-empty blob');
  }
  return sealed;
};

/** Open the blob back into the closed field map.
 *
 *  ⚠ THROWS on an unopenable ciphertext (rotated key, tampered row) — the same
 *  posture `openBookingField` had, and callers must keep treating it as a
 *  refusal rather than as empty fields. A recipe handed blanks would read them
 *  and write them.
 *
 *  A malformed-but-decryptable payload also throws: a blob that opens to
 *  something without `fields` is not "a booking with no fields", it is a row we
 *  do not understand, and guessing is how a blank record gets written. */
export const openBookingSubmissionBlob = async (input: {
  readonly key: Uint8Array;
  readonly endpoint_id: string;
  readonly submission_id: string;
  readonly ciphertext: string;
}): Promise<BookingVisitorFields> => {
  const plaintext = await openFormSubmissionField({
    key: input.key,
    endpoint_id: input.endpoint_id,
    submission_id: input.submission_id,
    field: 'submission_blob',
    ciphertext: input.ciphertext,
  });
  if (plaintext === null) {
    throw new Error('openBookingSubmissionBlob: the submission blob is absent');
  }
  const parsed = JSON.parse(plaintext) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('openBookingSubmissionBlob: the submission blob is not an object');
  }
  const rawFields = (parsed as { fields?: unknown }).fields;
  if (rawFields === null || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
    throw new Error('openBookingSubmissionBlob: the submission blob carries no fields');
  }
  const source = rawFields as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  for (const name of SCHEDULING_LINK_VISITOR_FIELD_NAMES) {
    const value = source[name];
    out[name] = typeof value === 'string' && value.length > 0 ? value : null;
  }
  return out as BookingVisitorFields;
};
