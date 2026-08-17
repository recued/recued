/** D-240 § D11 — `reception.lookup.revoke`: kill ONE submitter's viewback link.
 *
 *  ## Why it cannot be `reception.endpoint.rotate_token`
 *
 *  ⛔⛔ ROTATION IS PER-ENDPOINT AND THIS ACCESS IS PER-RECORD. Rotating the
 *  endpoint's bearer secret is the existing answer to "a link leaked", and for a
 *  `status_link` — one URL, one entity, shared with whoever the owner chose —
 *  it is the right one. A viewback credential is minted per SUBMISSION, so an
 *  endpoint with two hundred submitters has two hundred live links, and rotating
 *  to cut off one would cut off all of them.
 *
 *  ⇒ A per-record revoke. It is what makes a long-lived unauthenticated
 *  credential (§ D3) survivable: at 24 hours you wait a bad link out, at six
 *  weeks you need to be able to end it.
 *
 *  Reserved admin-only, like every `reception.*` method — the whole prefix is in
 *  `MCP_RESERVED_RPC_PREFIXES`, so this is paired-client-only by construction.
 *
 *  Spec: D-240 § D11. */

export interface ReceptionLookupRevokeInput {
  /** The endpoint the record belongs to. ⚠ REQUIRED alongside the record id
   *  rather than derived from it: the credential's scope is
   *  `(endpoint_id, record_id)`, and a revoke that matched on the record alone
   *  would be a different predicate from the one `peek` resolves on. Two
   *  predicates over one key space is how a revoke starts missing rows. */
  readonly endpoint_id: string;
  /** The submission the viewback was minted for. */
  readonly record_id: string;
}

export interface ReceptionLookupRevokeResult {
  /** How many live viewback credentials were revoked.
   *
   *  ⚠ `0` IS A SUCCESS, NOT AN ERROR — the link was already revoked, already
   *  expired, or never minted. The owner's intent ("this link must not work") is
   *  satisfied in every one of those cases, and reporting a failure would invite
   *  them to go looking for a problem that does not exist. The count is returned
   *  so the UI can say what happened rather than guess. */
  readonly revoked: number;
}

/** Closed list of refusals. ⛔ A missing record is NOT here: this rpc revokes
 *  CREDENTIALS, and whether a submission row still exists is a different
 *  question. Refusing on it would make a revoke impossible for exactly the case
 *  where it is most wanted — a record purged by retention whose link is somehow
 *  still out there. */
export const RECEPTION_LOOKUP_REVOKE_ERROR_CODES = [
  'permission_denied',
  'reception_lookup_revoke_invalid',
] as const;

export type ReceptionLookupRevokeErrorCode =
  (typeof RECEPTION_LOOKUP_REVOKE_ERROR_CODES)[number];
