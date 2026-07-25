/** D-149 P8 § A.5.5 + § N.6 — visitor-PII sub-DEK derivation +
 *  AEAD primitives for `reception_approval_intent.*_encrypted` columns.
 *
 *  Spec § N.6 declares the two `consumed_*_encrypted` columns
 *  (`consumed_by_visitor_email_encrypted` + `consumed_outcome_encrypted`)
 *  as the per-pair PII storage tier — the substrate seals each
 *  ciphertext under a reception-scoped key with AAD binding so a stolen
 *  ciphertext can't be replayed against another row or another field.
 *
 *  Key derivation:
 *
 *    approval_key = HKDF-SHA256(reception_sub_dek,
 *                               info='recued/v1/reception/approval_intent_pii',
 *                               32 bytes)
 *
 *  The approval key is HKDF'd from the same `reception` sub-DEK the
 *  pepper + booking-PII + form-PII + drop-PII modules use, with a
 *  DIFFERENT info label so the five streams (pepper / booking-PII /
 *  form-PII / drop-PII / approval-PII) are cryptographically distinct.
 *  The substrate never carries the master DEK —
 *  `deriveApprovalIntentPiiKeyFromSubDek` takes the sub-DEK bin.ts
 *  already holds via `KeyManager.keyProvider('reception')`.
 *
 *  AAD binding:
 *
 *    aad = `recued/v1/reception/approval_intent/<endpoint_id>/<intent_id>/<field_name>`
 *
 *  AAD ties each ciphertext to a specific row + field, so moving a
 *  ciphertext between rows OR between fields fails to decrypt. This
 *  mirrors the chat-store pattern + the P5 booking-PII pattern + the
 *  P6 form-PII pattern + the P7 drop-PII pattern.
 *
 *  Field set:
 *
 *    `visitor_email` — sealed separately so the engine can decrypt
 *      ONLY the email (e.g., for notification dispatch) without
 *      unsealing the outcome payload.
 *    `outcome` — the closed-shape outcome string (`approve` /
 *      `reject[:comment]` / `pick:<option_id>` / `confirm:<yes|no>` /
 *      `answer:<text>`). Sealed separately from the email so different
 *      consumers can unseal independently.
 *    `visitor_name` — sealed separately when the visitor self-identifies.
 *
 *  Pure module — no I/O. Production callers pass the sub-DEK in; tests
 *  derive an in-memory sub-DEK and exercise round-trip.
 *
 *  Spec: D-149 § A.5.5 + § N.6. */

import { hkdfSync } from 'node:crypto';
import { decrypt, decodeCiphertext, encodeCiphertext, encrypt } from '@recued/crypto';

const APPROVAL_PII_HKDF_INFO = 'recued/v1/reception/approval_intent_pii';
const APPROVAL_PII_KEY_LENGTH = 32;
const AAD_PREFIX = 'recued/v1/reception/approval_intent';

/** Closed list of approval-PII field names. Each is the column suffix
 *  or payload key the store binds the AAD to. */
export const APPROVAL_PII_FIELDS = [
  'visitor_email',
  'visitor_name',
  'outcome',
] as const;

export type ApprovalPiiField = (typeof APPROVAL_PII_FIELDS)[number];

export const APPROVAL_PII_FIELD_SET: ReadonlySet<ApprovalPiiField> = new Set(
  APPROVAL_PII_FIELDS,
);

/** Derive the approval-intent PII AEAD key from the reception sub-DEK.
 *  Distinct info label keeps this key cryptographically separated from
 *  the per-IP-hash pepper + the booking-PII + form-PII + drop-PII keys
 *  derived from the same sub-DEK. */
export const deriveApprovalIntentPiiKeyFromSubDek = (
  reception_sub_dek: Uint8Array | Buffer,
): Uint8Array => {
  if (reception_sub_dek.length !== 32) {
    throw new Error(
      `deriveApprovalIntentPiiKeyFromSubDek: sub_dek must be 32 bytes; got ${reception_sub_dek.length}`,
    );
  }
  const bytes = hkdfSync(
    'sha256',
    Buffer.from(reception_sub_dek),
    Buffer.alloc(0),
    Buffer.from(APPROVAL_PII_HKDF_INFO, 'utf8'),
    APPROVAL_PII_KEY_LENGTH,
  );
  return new Uint8Array(bytes);
};

/** Build the AAD bytes for a `(endpoint_id, intent_id, field)` triple.
 *  Pure function; UTF-8 encoded so the binding is deterministic across
 *  Node + browser hosts. */
export const buildApprovalIntentAad = (input: {
  endpoint_id: string;
  intent_id: string;
  field: ApprovalPiiField;
}): Uint8Array => {
  const s = `${AAD_PREFIX}/${input.endpoint_id}/${input.intent_id}/${input.field}`;
  return new TextEncoder().encode(s);
};

/** Encrypt a visitor-typed payload. Returns a base64-encoded ciphertext
 *  string the store persists in the BLOB column.
 *
 *  `undefined` / `null` / empty-string inputs return `null` so the
 *  store can persist `NULL` for fields the visitor omitted (per spec
 *  § N.6 the `consumed_*_encrypted` columns are nullable on the
 *  pre-consumption row + populated on the EXCLUSIVE flip). */
export const sealApprovalIntentPiiField = async (input: {
  key: Uint8Array;
  endpoint_id: string;
  intent_id: string;
  field: ApprovalPiiField;
  plaintext: string | null | undefined;
}): Promise<string | null> => {
  if (input.plaintext === undefined || input.plaintext === null) return null;
  if (typeof input.plaintext !== 'string' || input.plaintext.length === 0) return null;
  const pt = new TextEncoder().encode(input.plaintext);
  const aad = buildApprovalIntentAad({
    endpoint_id: input.endpoint_id,
    intent_id: input.intent_id,
    field: input.field,
  });
  const ct = await encrypt(input.key, pt, aad);
  return encodeCiphertext(ct);
};

/** Decrypt a visitor-typed field. Returns `null` for a `null`
 *  ciphertext (visitor omitted the optional field). Production callers
 *  should let decrypt errors surface — a decrypt-fail means the row
 *  was tampered or the sub-DEK rotated. */
export const openApprovalIntentPiiField = async (input: {
  key: Uint8Array;
  endpoint_id: string;
  intent_id: string;
  field: ApprovalPiiField;
  ciphertext: string | null;
}): Promise<string | null> => {
  if (input.ciphertext === null) return null;
  const ct = decodeCiphertext(input.ciphertext);
  const aad = buildApprovalIntentAad({
    endpoint_id: input.endpoint_id,
    intent_id: input.intent_id,
    field: input.field,
  });
  const pt = await decrypt(input.key, ct, aad);
  return new TextDecoder().decode(pt);
};
