/** D-149 P6 § A.5.3 + § N.6 — visitor-PII sub-DEK derivation +
 *  AEAD primitives for `reception_form_submission.*_encrypted` columns.
 *
 *  Spec § N.6 declares the two `visitor_*_encrypted` columns
 *  (`visitor_email_encrypted` + `submission_blob_encrypted`) as the
 *  per-pair PII storage tier — the substrate seals each ciphertext
 *  under a reception-scoped key with AAD binding so a stolen ciphertext
 *  can't be replayed against another row or another field.
 *
 *  Key derivation:
 *
 *    form_key = HKDF-SHA256(reception_sub_dek, info='recued/v1/reception/form_submission_pii', 32 bytes)
 *
 *  The form key is HKDF'd from the same `reception` sub-DEK the pepper
 *  + booking modules use, with a DIFFERENT info label so the three
 *  streams (pepper / booking-PII / form-PII) are cryptographically
 *  distinct. The substrate never carries the master DEK —
 *  `deriveFormSubmissionPiiKeyFromSubDek` takes the sub-DEK bin.ts
 *  already holds via `KeyManager.keyProvider('reception')`.
 *
 *  AAD binding:
 *
 *    aad = `recued/v1/reception/form_submission/<endpoint_id>/<submission_id>/<field_name>`
 *
 *  AAD ties each ciphertext to a specific row + field, so moving a
 *  ciphertext between rows OR between fields fails to decrypt. This
 *  mirrors the chat-store pattern + the P5 booking-PII pattern.
 *
 *  Field set:
 *
 *    `submission_blob` — the JSON-serialized visitor-typed field map
 *      (per the form_definition schema). Sealed as one ciphertext blob
 *      so the per-field values are server-side-only at rest. The
 *      engine reactive handler decrypts via `openFormSubmissionField`
 *      + projects per the submission_processing_rule.
 *    `visitor_email` — sealed separately so the engine can decrypt
 *      ONLY the email (e.g., for notification dispatch) without
 *      unsealing the full submission payload. Per § A.5.3 line 731
 *      this column is independent of the submission_blob payload.
 *
 *  Pure module — no I/O. Production callers pass the sub-DEK in; tests
 *  derive an in-memory sub-DEK and exercise round-trip.
 *
 *  Spec: D-149 § A.5.3 + § N.6. */

import { hkdfSync } from 'node:crypto';
import { decrypt, decodeCiphertext, encodeCiphertext, encrypt } from '@recued/crypto';

const FORM_PII_HKDF_INFO = 'recued/v1/reception/form_submission_pii';
const FORM_PII_KEY_LENGTH = 32;
const AAD_PREFIX = 'recued/v1/reception/form_submission';

/** Closed list of form-PII field names. Each is the column suffix or
 *  payload key the store binds the AAD to. */
export const FORM_PII_FIELDS = [
  'visitor_email',
  'submission_blob',
] as const;

export type FormPiiField = (typeof FORM_PII_FIELDS)[number];

export const FORM_PII_FIELD_SET: ReadonlySet<FormPiiField> = new Set(FORM_PII_FIELDS);

/** Derive the form-submission PII AEAD key from the reception sub-DEK.
 *  Distinct info label keeps this key cryptographically separated from
 *  the per-IP-hash pepper + the booking-PII key derived from the same
 *  sub-DEK. */
export const deriveFormSubmissionPiiKeyFromSubDek = (
  reception_sub_dek: Uint8Array | Buffer,
): Uint8Array => {
  if (reception_sub_dek.length !== 32) {
    throw new Error(
      `deriveFormSubmissionPiiKeyFromSubDek: sub_dek must be 32 bytes; got ${reception_sub_dek.length}`,
    );
  }
  const bytes = hkdfSync(
    'sha256',
    Buffer.from(reception_sub_dek),
    Buffer.alloc(0),
    Buffer.from(FORM_PII_HKDF_INFO, 'utf8'),
    FORM_PII_KEY_LENGTH,
  );
  return new Uint8Array(bytes);
};

/** Build the AAD bytes for a `(endpoint_id, submission_id, field)`
 *  triple. Pure function; UTF-8 encoded so the binding is deterministic
 *  across Node + browser hosts. */
export const buildFormSubmissionAad = (input: {
  endpoint_id: string;
  submission_id: string;
  field: FormPiiField;
}): Uint8Array => {
  const s = `${AAD_PREFIX}/${input.endpoint_id}/${input.submission_id}/${input.field}`;
  return new TextEncoder().encode(s);
};

/** Encrypt a visitor-typed payload. Returns a base64-encoded ciphertext
 *  string the store persists in the BLOB column.
 *
 *  `undefined` / `null` / empty-string inputs return `null` so the
 *  store can persist `NULL` for fields the visitor omitted (per spec
 *  § N.6 the `visitor_email_encrypted` column is nullable). The
 *  `submission_blob_encrypted` column is `NOT NULL` so callers MUST
 *  pass non-empty plaintext. */
export const sealFormSubmissionField = async (input: {
  key: Uint8Array;
  endpoint_id: string;
  submission_id: string;
  field: FormPiiField;
  plaintext: string | null | undefined;
}): Promise<string | null> => {
  if (input.plaintext === undefined || input.plaintext === null) return null;
  if (typeof input.plaintext !== 'string' || input.plaintext.length === 0) return null;
  const pt = new TextEncoder().encode(input.plaintext);
  const aad = buildFormSubmissionAad({
    endpoint_id: input.endpoint_id,
    submission_id: input.submission_id,
    field: input.field,
  });
  const ct = await encrypt(input.key, pt, aad);
  return encodeCiphertext(ct);
};

/** Decrypt a visitor-typed field. Returns `null` for a `null` ciphertext
 *  (visitor omitted the optional field). Production callers should let
 *  decrypt errors surface — a decrypt-fail means the row was tampered
 *  or the sub-DEK rotated. */
export const openFormSubmissionField = async (input: {
  key: Uint8Array;
  endpoint_id: string;
  submission_id: string;
  field: FormPiiField;
  ciphertext: string | null;
}): Promise<string | null> => {
  if (input.ciphertext === null) return null;
  const ct = decodeCiphertext(input.ciphertext);
  const aad = buildFormSubmissionAad({
    endpoint_id: input.endpoint_id,
    submission_id: input.submission_id,
    field: input.field,
  });
  const pt = await decrypt(input.key, ct, aad);
  return new TextDecoder().decode(pt);
};
