/** D-149 P7 § A.5.4 + § N.6 — visitor-PII sub-DEK derivation +
 *  AEAD primitives for `reception_drop_blob_metadata.*_encrypted`
 *  columns.
 *
 *  Spec § N.6 declares the three `visitor_*_encrypted` columns
 *  (`visitor_email_encrypted` + `visitor_name_encrypted` +
 *  `visitor_description_encrypted`) as the per-pair PII storage tier —
 *  the substrate seals each ciphertext under a reception-scoped key
 *  with AAD binding so a stolen ciphertext can't be replayed against
 *  another row or another field.
 *
 *  Key derivation:
 *
 *    drop_key = HKDF-SHA256(reception_sub_dek,
 *                           info='recued/v1/reception/drop_blob_pii',
 *                           32 bytes)
 *
 *  The drop key is HKDF'd from the same `reception` sub-DEK the pepper
 *  + booking-PII + form-PII modules use, with a DIFFERENT info label
 *  so the four streams (pepper / booking-PII / form-PII / drop-PII) are
 *  cryptographically distinct. The substrate never carries the master
 *  DEK — `deriveDropBlobPiiKeyFromSubDek` takes the sub-DEK bin.ts
 *  already holds via `KeyManager.keyProvider('reception')`.
 *
 *  AAD binding:
 *
 *    aad = `recued/v1/reception/drop_blob/<endpoint_id>/<blob_id>/<field_name>`
 *
 *  AAD ties each ciphertext to a specific row + field, so moving a
 *  ciphertext between rows OR between fields fails to decrypt. This
 *  mirrors the chat-store pattern + the P5 booking-PII pattern + the
 *  P6 form-PII pattern.
 *
 *  Field set:
 *
 *    `visitor_email` — sealed separately so the engine can decrypt
 *      ONLY the email (e.g., for notification dispatch) without
 *      unsealing the visitor's name / description.
 *    `visitor_name` — sealed independently.
 *    `visitor_description` — sealed independently.
 *
 *  Pure module — no I/O. Production callers pass the sub-DEK in; tests
 *  derive an in-memory sub-DEK and exercise round-trip.
 *
 *  Spec: `docs/d-149-spec.md` § A.5.4 + § N.6. */

import { hkdfSync } from 'node:crypto';
import { decrypt, decodeCiphertext, encodeCiphertext, encrypt } from '@recued/crypto';

const DROP_PII_HKDF_INFO = 'recued/v1/reception/drop_blob_pii';
const DROP_PII_KEY_LENGTH = 32;
const AAD_PREFIX = 'recued/v1/reception/drop_blob';

/** Closed list of drop-PII field names. Each is the column suffix or
 *  payload key the store binds the AAD to. */
export const DROP_PII_FIELDS = [
  'visitor_email',
  'visitor_name',
  'visitor_description',
] as const;

export type DropPiiField = (typeof DROP_PII_FIELDS)[number];

export const DROP_PII_FIELD_SET: ReadonlySet<DropPiiField> = new Set(DROP_PII_FIELDS);

/** Derive the drop-blob PII AEAD key from the reception sub-DEK. Distinct
 *  info label keeps this key cryptographically separated from the per-IP-
 *  hash pepper + the booking-PII key + the form-PII key derived from the
 *  same sub-DEK. */
export const deriveDropBlobPiiKeyFromSubDek = (
  reception_sub_dek: Uint8Array | Buffer,
): Uint8Array => {
  if (reception_sub_dek.length !== 32) {
    throw new Error(
      `deriveDropBlobPiiKeyFromSubDek: sub_dek must be 32 bytes; got ${reception_sub_dek.length}`,
    );
  }
  const bytes = hkdfSync(
    'sha256',
    Buffer.from(reception_sub_dek),
    Buffer.alloc(0),
    Buffer.from(DROP_PII_HKDF_INFO, 'utf8'),
    DROP_PII_KEY_LENGTH,
  );
  return new Uint8Array(bytes);
};

/** Build the AAD bytes for a `(endpoint_id, blob_id, field)` triple.
 *  Pure function; UTF-8 encoded so the binding is deterministic across
 *  Node + browser hosts. */
export const buildDropBlobAad = (input: {
  endpoint_id: string;
  blob_id: string;
  field: DropPiiField;
}): Uint8Array => {
  const s = `${AAD_PREFIX}/${input.endpoint_id}/${input.blob_id}/${input.field}`;
  return new TextEncoder().encode(s);
};

/** Encrypt a visitor-typed payload. Returns a base64-encoded ciphertext
 *  string the store persists in the BLOB column.
 *
 *  `undefined` / `null` / empty-string inputs return `null` so the
 *  store can persist `NULL` for fields the visitor omitted (per spec
 *  § N.6 the visitor_*_encrypted columns are nullable). */
export const sealDropBlobPiiField = async (input: {
  key: Uint8Array;
  endpoint_id: string;
  blob_id: string;
  field: DropPiiField;
  plaintext: string | null | undefined;
}): Promise<string | null> => {
  if (input.plaintext === undefined || input.plaintext === null) return null;
  if (typeof input.plaintext !== 'string' || input.plaintext.length === 0) return null;
  const pt = new TextEncoder().encode(input.plaintext);
  const aad = buildDropBlobAad({
    endpoint_id: input.endpoint_id,
    blob_id: input.blob_id,
    field: input.field,
  });
  const ct = await encrypt(input.key, pt, aad);
  return encodeCiphertext(ct);
};

/** Decrypt a visitor-typed field. Returns `null` for a `null` ciphertext
 *  (visitor omitted the optional field). Production callers should let
 *  decrypt errors surface — a decrypt-fail means the row was tampered
 *  or the sub-DEK rotated. */
export const openDropBlobPiiField = async (input: {
  key: Uint8Array;
  endpoint_id: string;
  blob_id: string;
  field: DropPiiField;
  ciphertext: string | null;
}): Promise<string | null> => {
  if (input.ciphertext === null) return null;
  const ct = decodeCiphertext(input.ciphertext);
  const aad = buildDropBlobAad({
    endpoint_id: input.endpoint_id,
    blob_id: input.blob_id,
    field: input.field,
  });
  const pt = await decrypt(input.key, ct, aad);
  return new TextDecoder().decode(pt);
};
