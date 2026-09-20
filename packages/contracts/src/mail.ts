/** D-127 — mail-send substrate constants + audit shapes.
 *  D-145 PA7 — mail_message canonical-schema constants.
 *
 *  This file is the canonical home for mail-collection constants that
 *  cross the public boundary (referenced from contracts consumers).
 *  Provider-private constants (`DEFAULT_SMTP_PORT`,
 *  `IMAP_SENT_FOLDER_FALLBACK_CANDIDATES`) currently live alongside
 *  their provider in `backend/server/src/collections/mail/imap-provider.ts`
 *  and don't need to live here — they're referenced only inside
 *  `backend/server/`. */

/** D-145 PA7 — `mail_message` canonical-schema subject upper bound.
 *  Per spec § A.5.1 (`subject: text (required, max 300)`). RFC 5322
 *  doesn't pin a hard limit; 300 chars is generous for typical subjects
 *  and keeps the column a normal SQLite TEXT cell. */
export const MAIL_MESSAGE_SUBJECT_MAX = 300;

/** D-172 P2 — Half-A per-attachment byte cap. There is no Recued byte
 *  ceiling (D-172 Resolved Q5) — the real constraint is the provider's
 *  input window — but the three providers' *inline* attachment paths
 *  differ (Gmail `raw` tolerates tens of MB; Graph's
 *  `fileAttachment.contentBytes` inline path caps at ~3 MB before it
 *  needs an upload session; SMTP varies by host). Half A ships a single
 *  conservative cap pegged to the smallest provider inline window so a
 *  too-large file surfaces a WARNING on the send (via
 *  `SentMessageMeta.warnings[]`) and is OMITTED from that provider's
 *  payload — never silently dropped without a trace (I-6). Per-modality
 *  / per-provider sizing (downscale, upload-session, chunking) is Half
 *  B. 3 MB raw bytes ≈ 4 MB base64-on-the-wire.
 *
 *  ⛔ LIVES HERE, NOT WITH THE SERVER THAT ENFORCES IT, BECAUSE TWO SIDES
 *  NEED IT AND `packages/` MAY NOT IMPORT `backend/`. The compose UI reads it
 *  to mark an over-cap file BEFORE the user sends, rather than letting them
 *  discover it from a post-send warning. ⚠ The server stays AUTHORITATIVE:
 *  the UI mark is advisory, and a compose that ignored it still has the file
 *  dropped + warned at `MailCollection.send`. Never let the UI check become
 *  the only one. */
export const MAIL_SEND_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;

/** D-172 P2 — warning code attached to `SentMessageMeta.warnings[]` when an
 *  attachment exceeded `MAIL_SEND_ATTACHMENT_MAX_BYTES` and was omitted. */
export const MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING = 'MAIL_SEND_ATTACHMENT_OVERSIZE' as const;

/** D-145 PA7 — closed list of `ref` targets the mail_message canonical
 *  schema points at. Tests pin these to catch silent schema drift. */
export const MAIL_MESSAGE_REF_CONTACT = 'data.contact';
export const MAIL_MESSAGE_REF_FILE = 'data.file';
export const MAIL_MESSAGE_REF_MESSAGE = 'data.mail.message';
export const MAIL_MESSAGE_REF_SOURCE = 'source.mail';

/** Recipient-count threshold above which the `mail_send` audit row
 *  redacts individual addresses and stores only the count. Keeps the
 *  audit feed readable for typical 1-to-5 sends while staying
 *  privacy-preserving for marketing-style fan-outs that mail to
 *  large user lists. Spec § P1.7 + § Constants. */
export const MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD = 10;

/** Optional caller-pinned identity carried through an outbound message and
 * indexed again when that message returns through provider source truth. The
 * value is deliberately a compact header token: accepting whitespace or
 * control characters here would make the generic mail-send surface a header-
 * injection primitive. */
export const MAIL_RECONCILIATION_ID_HEADER = 'x-recued-reconciliation-id' as const;
export const MAIL_RECONCILIATION_ID_MAX_LENGTH = 255;
export const MAIL_SENT_RECONCILIATION_MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;

const MAIL_RECONCILIATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const isMailReconciliationId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAIL_RECONCILIATION_ID_MAX_LENGTH
  && MAIL_RECONCILIATION_ID_PATTERN.test(value);

interface MailSentReconciliationEnvelope {
  reconciliation_id: string;
  recipient: string;
  subject: string;
  sent_after: number;
  sent_before: number;
}

/** Closed, provider-neutral proof request for one already-fenced outbound
 * message. The server derives every field from authoritative workflow,
 * response, and file records; recipes never author this shape directly.
 *
 * The discriminant is security-significant. `envelope` proves one exact
 * accepted message without silently making attachment evidence optional;
 * `attachment` retains the stronger byte/hash proof used by fulfillment. */
export interface MailSentEnvelopeReconciliationQuery
  extends MailSentReconciliationEnvelope {
  proof_kind: 'envelope';
}

export interface MailSentAttachmentReconciliationQuery
  extends MailSentReconciliationEnvelope {
  proof_kind: 'attachment';
  attachment_sha256: string;
  attachment_size_bytes: number;
  attachment_filename: string;
  attachment_mime_type: string;
}

export type MailSentReconciliationQuery =
  | MailSentEnvelopeReconciliationQuery
  | MailSentAttachmentReconciliationQuery;

export interface MailSentEnvelopeReconciliationMatch {
  proof_kind: 'envelope';
  source_id: string;
  provider_message_id: string;
  sent_at: number;
}

export interface MailSentAttachmentReconciliationMatch {
  proof_kind: 'attachment';
  source_id: string;
  provider_message_id: string;
  sent_at: number;
  attachment_sha256: string;
  attachment_size_bytes: number;
}

export type MailSentReconciliationMatch =
  | MailSentEnvelopeReconciliationMatch
  | MailSentAttachmentReconciliationMatch;

/** Absence is deliberately observational. Only `matched` is positive source
 * proof; ambiguity and unavailable material remain distinct fail-closed
 * outcomes for the workflow consumer. */
export type MailSentReconciliationResult =
  | {
      status: 'matched';
      match: MailSentReconciliationMatch;
      scanned_candidates: number;
    }
  | {
      status: 'not_found';
      scanned_candidates: number;
    }
  | {
      status: 'ambiguous';
      reason: 'duplicate_header' | 'multiple_messages' | 'source_mismatch';
      scanned_candidates: number;
    }
  | {
      status: 'unavailable';
      reason: 'unsupported' | 'provider_error' | 'scan_limit' | 'attachment_unreadable';
      scanned_candidates: number;
    };

/** ── The outbound send claim (D-207 slice 3d) ────────────────────────────────
 *
 *  ⛔ THE NO-RESEND FENCE IS THIS RECORD — NOT THE PROVIDER LOOKUP.
 *
 *  The lookup above was already general (this contract, and all three of
 *  Gmail/Graph/IMAP implement it). What was missing, and what D-200 kept privately
 *  inside its own `data.shared` workflow row, is the DURABLE PRE-DISPATCH CLAIM:
 *  "I am about to send message R." Written BEFORE the provider call, it is the only
 *  thing that survives a crash mid-send — and without it a reconciler has nothing
 *  to reconcile AGAINST and no query to derive.
 *
 *  ⛔ THE CLAIM IS SERVER-WRITTEN AND THE RECIPE NEVER AUTHORS THE QUERY. A recipe
 *  that could supply the recipient, subject, or window could forge a `matched` — and
 *  a forged `matched` marks a document DELIVERED that was never sent. So the op's
 *  input closure is the reconciliation id and NOTHING ELSE, and every field of the
 *  query is derived here from the row. The fence is the absent field, as it is for
 *  `order.open`'s missing price.
 *
 *  ## ⛔ NOTHING HERE EVER AUTHORIZES A RESEND — INCLUDING `not_found`
 *
 *  The tempting reading is that `not_found` means "it never went out, so send it
 *  again." It does not. Absent from the Sent folder is NOT the same as not sent: the
 *  provider may not have indexed it yet, the scan window can miss it, IMAP lags. A
 *  resend on `not_found` double-sends a customer their document, and there is no
 *  completeness proof available at this layer that could make it safe.
 *
 *  So the claim only ever moves FORWARD (`claimed`/`sent` → `reconciled` |
 *  `ambiguous`). A `not_found` leaves it exactly where it was, and a claim that has
 *  not been positively reconciled is one a machine must not re-send. Re-sending is an
 *  OWNER decision, made with the claim in front of them. This is D-200's invariant
 *  verbatim, and it is the one that was actually earning its keep. */
export const MAIL_SEND_CLAIM_STATUSES = [
  /** Durably recorded; the provider call is NOT known to have completed. A crash
   *  between the claim and the send lands here — which is the whole point. */
  'claimed',
  /** The provider acknowledged the send. Still not PROOF: the ack can be lost. */
  'sent',
  /** ★ Provider source truth confirms exactly one matching message. Terminal. */
  'reconciled',
  /** ★ Source truth is CONTRADICTORY (duplicate header / multiple messages /
   *  mismatch). An OWNER decision — never an automatic resend. Terminal to the
   *  machine; repeated ambiguity does not churn the revision. */
  'ambiguous',
] as const;

export type MailSendClaimStatus = (typeof MAIL_SEND_CLAIM_STATUSES)[number];

export const isMailSendClaimStatus = (value: unknown): value is MailSendClaimStatus =>
  typeof value === 'string'
  && (MAIL_SEND_CLAIM_STATUSES as readonly string[]).includes(value);

/** The statuses a reconcile may NOT move off — DERIVED, never re-typed beside the
 *  thing it guards. (This arc has now been bitten four times by a closed vocabulary
 *  copied next to what it protects.) */
export const MAIL_SEND_CLAIM_SETTLED_STATUSES = [
  'reconciled',
  'ambiguous',
] as const satisfies readonly MailSendClaimStatus[];

export const isMailSendClaimSettled = (status: MailSendClaimStatus): boolean =>
  (MAIL_SEND_CLAIM_SETTLED_STATUSES as readonly string[]).includes(status);

export interface MailSendClaim {
  /** PK. The caller-pinned header token already carried through the message by
   *  `MAIL_RECONCILIATION_ID_HEADER` — so the thing we search FOR is the thing we
   *  stamped, and the join needs no second identity. */
  readonly reconciliation_id: string;
  readonly status: MailSendClaimStatus;

  /** ⛔ WHICH mail account the message went out through — and therefore which
   *  provider's Sent folder is the source truth for it. Without this the reconciler
   *  does not know who to ask, and a fence that cannot find its provider is not a
   *  fence. It is recorded at claim time rather than passed in at reconcile time for
   *  the usual reason: a caller who could name the account could name one whose Sent
   *  folder happens to contain a matching message. */
  readonly sender_slug: string;

  /** ⛔ Every field below is written by the SERVER at claim time and is what the
   *  reconciliation query is DERIVED from. None of them is a recipe input. */
  readonly recipient: string;
  readonly subject: string;
  /** The window opens when we claimed — i.e. strictly before we dispatched. */
  readonly sent_after: number;

  readonly proof_kind: 'envelope' | 'attachment';
  readonly attachment_sha256: string | null;
  readonly attachment_size_bytes: number | null;
  readonly attachment_filename: string | null;
  readonly attachment_mime_type: string | null;

  readonly provider_message_id: string | null;
  readonly sent_at: number | null;
  readonly ambiguity_reason: string | null;

  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Derive the provider proof request FROM THE CLAIM. The caller supplies an id; this
 *  supplies everything the provider is asked. `null` when the row cannot produce an
 *  honest query — a claim with an `attachment` proof kind but no pinned bytes is
 *  malformed, and asking a weaker `envelope` question instead would silently
 *  downgrade the proof (the exact "declared but not backed" failure). */
export const mailSentReconciliationQueryFor = (
  claim: MailSendClaim,
  now: number,
): MailSentReconciliationQuery | null => {
  if (!isMailReconciliationId(claim.reconciliation_id)) return null;
  if (claim.recipient.length === 0 || claim.subject.length === 0) return null;

  // The window is bounded and derived — a caller cannot widen it to trawl for a
  // match, and cannot narrow it to manufacture a `not_found`.
  const sent_before = Math.min(
    now,
    claim.sent_after + MAIL_SENT_RECONCILIATION_MAX_WINDOW_MS,
  );
  if (sent_before < claim.sent_after) return null;

  const envelope = {
    reconciliation_id: claim.reconciliation_id,
    recipient: claim.recipient,
    subject: claim.subject,
    sent_after: claim.sent_after,
    sent_before,
  };

  if (claim.proof_kind === 'envelope') {
    return { proof_kind: 'envelope', ...envelope };
  }

  if (
    claim.attachment_sha256 === null
    || claim.attachment_size_bytes === null
    || claim.attachment_filename === null
    || claim.attachment_mime_type === null
  ) {
    return null;
  }

  return {
    proof_kind: 'attachment',
    ...envelope,
    attachment_sha256: claim.attachment_sha256,
    attachment_size_bytes: claim.attachment_size_bytes,
    attachment_filename: claim.attachment_filename,
    attachment_mime_type: claim.attachment_mime_type,
  };
};

/** Detail blob for `mail_send` activity rows. JSON-encoded into
 *  `ActivityEntry.detail`; the activity-feed UI parses it back to
 *  render structured fields. Body content is deliberately excluded —
 *  the audit row is a breadcrumb, not a copy of the message. */
export interface MailSendAuditDetail {
  /** Total recipient count (`to` + `cc` + `bcc`). Always present so
   *  the feed can render "sent to N recipients" even when the
   *  individual addresses are redacted. */
  recipient_count: number;
  /** Recipient addresses (deduped, sender excluded), listed when
   *  `recipient_count <= MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD`.
   *  Omitted (count-only) when above threshold. */
  recipients?: string[];
  /** Subject line — short string, included even when recipients are
   *  redacted (subjects are routine recipe outputs and are surfaced
   *  in the audit feed for matching against recipe runs). */
  subject: string;
  /** Provider-side Message-Id of the sent mail. Empty string on
   *  failure paths where the provider never produced one. */
  message_id: string;
  /** Body byte count (text body only — pre-attachments-v2). Useful for
   *  spotting outliers without storing the body itself. */
  body_bytes: number;
  /** True when `provider.send` returned without throwing. False when
   *  the call surfaced any non-warning error (capability gate, sender
   *  guard, transport failure). */
  success: boolean;
  /** Captured error code + message when `success === false`. Mirrors
   *  the `ConnectionAuditDetail.error` shape so renderers can share
   *  a code path. */
  error?: { code: string; message: string };
  /** Forwarded from `SentMessageMeta.warnings` (e.g. IMAP APPEND
   *  failed after SMTP succeeded — `MAIL_SEND_APPEND_FAILED`). Absent
   *  when the send had no warnings. */
  warnings?: Array<{ code: string; message: string }>;
  /** ⛔ WHAT ACTUALLY LEFT, per attachment. Present whenever the send carried
   *  any, for BOTH carriers.
   *
   *  D-172's I-4 made `handleFileRead` the one audited byte-egress path, so a
   *  record-id attachment left a `file_content_read` row naming it. A RUN-SCOPED
   *  temp attachment never touches that path — its bytes are the caller's own
   *  run output, not warehouse content — and so left NO audit trace of the
   *  attachment at all until this field. Bytes crossing the machine boundary owe
   *  a record regardless of which side of the warehouse they came from.
   *
   *  `sha256` is the content hash (the same value a persisted copy carries as
   *  `blob_hash`), so an attachment can be identified later without the bytes. */
  attachments?: Array<{
    filename: string;
    size_bytes: number;
    sha256: string;
    /** `record` — a durable `data.file` the owner keeps; `run_scoped` — bytes
     *  the caller produced in this run purely to send. */
    carrier: 'record' | 'run_scoped';
  }>;
  /** D-127 follow-on — originating recipe id when the call came from
   *  an engine-driven `mail-send` step. Absent when the call reached
   *  `MailCollection.send` directly (Settings → Connections probe,
   *  MCP agent, raw rpc client, tests). Lets the activity feed group
   *  outbound mails by recipe and lets failure-mode investigations
   *  pivot from a flagged audit row to the recipe that produced it. */
  recipe_id?: string;
  /** D-127 follow-on — originating step id (`step.<id>`) for kernel-
   *  driven calls. Pairs with `recipe_id`; absent for direct-rpc
   *  callers. */
  step_id?: string;
}

// ════════════════════════════════════════════════════════════════
// D-239 — mail write-back (message-state mutation)
// ════════════════════════════════════════════════════════════════
//
// `data.mail` was a read mirror plus one outbound verb: `send` creates a
// NEW message, it never touches an existing one. D-239 closes the gap the
// other warehouse collections had already closed — `data.calendar` writes
// back through `create` / `update` / `delete` / `rsvp` (D-117), `data.file`
// through `write` / `delete` / `move` (D-172) — with the same
// verified-then-reflected invariant D-117 decision 3 pins:
//
//   the warehouse is written ONLY after the provider returns a complete,
//   verified state for the mutated message. Adapter failure, timeout, or
//   any unverified outcome throws `MailAdapterError` and leaves the
//   warehouse untouched; the next sync tick reflects whatever actually
//   landed.
//
// ⛔ THE READ SIDE MOVED WITH THE WRITE SIDE, AND HAD TO. `mail-flag`
// writes `is_flagged`, which the mirror did not carry before this
// decision — so all three providers now canonicalize it on the way IN
// (IMAP `\Flagged`, Gmail's `STARRED` label, Graph's `flag.flagStatus`).
// Shipping the write alone would have produced a flag that "works", then
// silently reverts the first time that mailbox syncs: the write lands at
// the provider, and the next canonicalize overwrites the hot field with a
// value it never read. A write-back to a field the mirror does not read
// is not a half-feature, it is a wrong one.

/** Adapter-level error codes for a mail message-state mutation. Sibling
 *  of `CalendarAdapterErrorCode` and deliberately the same shape: these
 *  surface at the dispatcher and map onto recipe `fail_on` branches.
 *
 *  `io_error` is the load-bearing one — the "outcome unknown" variant.
 *  The mutation may or may not have landed on the provider, so the
 *  warehouse is NEVER written on this code. A recipe that must tell a
 *  verified failure from an ambiguous one gates on it explicitly. */
export type MailAdapterErrorCode =
  /** The provider no longer holds this message (already deleted, or moved
   *  out from under a stale warehouse row). Verified absence — the
   *  warehouse row may safely be dropped. */
  | 'message_not_found'
  /** `mail-move` named a destination folder / label the provider does not
   *  have. Rejected before any state change. */
  | 'folder_not_found'
  /** The grant does not cover mutation (Gmail without `gmail.modify`,
   *  Graph without `Mail.ReadWrite`, an IMAP mailbox opened read-only). */
  | 'permission_denied'
  /** Provider rate limit / quota. Retryable; nothing changed. */
  | 'quota_exceeded'
  /** Token expired or revoked mid-call. */
  | 'auth_expired'
  /** Network / 5xx / timeout / malformed response. OUTCOME UNKNOWN — may
   *  have succeeded provider-side. The warehouse stays untouched. */
  | 'io_error';

/** Thrown from the `MailProvider` mutation methods and caught at the mail
 *  dispatcher, which maps it to a typed `RpcError`
 *  (`backend/server/src/collections/mail/mail-errors.ts`). Mirrors
 *  `CalendarAdapterError` so a reader of either module follows one
 *  vocabulary. */
export class MailAdapterError extends Error {
  readonly code: MailAdapterErrorCode;
  readonly cause?: unknown;
  constructor(code: MailAdapterErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'MailAdapterError';
    this.code = code;
    this.cause = cause;
  }
}

/** The verified post-mutation state of one message, returned by every
 *  `MailProvider` mutation method. This is deliberately NARROW — it is
 *  not a `CanonicalMessage`.
 *
 *  ⛔ WHY NOT THE FULL MESSAGE, the shape `applyVerifiedUpsert` takes on
 *  calendar: a mail row's body is the expensive part (spilled to CAS
 *  above 64 KB), and re-fetching an entire RFC822 message to record that
 *  its `\Seen` flag moved would re-write that blob on every mark-read.
 *  The mutation touches exactly the mirrored state fields, so the verified
 *  payload carries exactly those; the collection folds them into the
 *  existing row's `hot_fields` and leaves body, size, and blob pointer
 *  alone. An event's canonical payload IS its state, which is why calendar
 *  can round-trip the whole object and mail should not. */
export interface MailMutationResult {
  /** The message's provider-native id AFTER the mutation.
   *
   *  ⚠ NOT NECESSARILY THE ID THAT WENT IN. A move re-keys the message on
   *  two of the three providers: IMAP `source_id` is `UID@folder` and both
   *  halves change on a COPY+EXPUNGE, and Graph's `POST /messages/{id}/move`
   *  returns a NEW resource id. Gmail alone keeps a stable id across a
   *  label change. The collection compares this against the row it read
   *  and re-keys rather than assuming identity — see
   *  `MailCollection.applyVerifiedMutation`. */
  source_id: string;
  is_read: boolean;
  is_flagged: boolean;
  /** Primary folder (IMAP path / Graph `parentFolderId`) or the Gmail
   *  label chosen by the same `LABEL_PRIORITY` fold the read path uses,
   *  so a mutated row's `folder` hot field is comparable with a synced
   *  one. */
  folder_or_label: string;
  /** Full post-mutation label set. Gmail only — IMAP and Graph model
   *  placement as a single folder and omit this, exactly as the read-side
   *  canonicalizers do. */
  labels?: string[];
}

/** What a `moveMessage` can honestly report. Either the message's verified
 *  new state, or `null`.
 *
 *  ⛔ `null` IS NOT A FAILURE — it means "the provider confirmed the move
 *  and cannot tell us the message's new identity". This is a real IMAP
 *  case, not a hypothetical: `UID MOVE` only returns a source→destination
 *  UID mapping on servers advertising UIDPLUS, and plenty do not. The move
 *  HAPPENED; we simply cannot name the result.
 *
 *  The three tempting alternatives are all worse:
 *    - echo the OLD `source_id` — it names a UID that no longer exists in
 *      the source folder, so every later mutation on that row 404s;
 *    - throw `io_error` — claims the outcome is unknown when it is known;
 *      a recipe would retry a move that already succeeded;
 *    - re-search the destination by Message-ID — extra round-trips on a
 *      header that is not guaranteed present, to reconstruct something the
 *      next sync tick supplies for free.
 *  So the collection DROPS the local row on `null` and lets the destination
 *  folder's sync re-ingest the message under its real new id — the same
 *  "let the next tick reconcile" discipline D-117 uses for a truncated
 *  recurring series. */
export type MailMoveOutcome = MailMutationResult | null;

/** Destination for `mail-move`. Exactly one of the two forms, matching how
 *  the providers actually model placement: a folder path (IMAP, Graph) or
 *  a label set (Gmail). The dispatcher rejects the form the target
 *  provider does not support rather than guessing a translation — a
 *  silent "closest folder" mapping is how mail ends up somewhere the user
 *  did not ask for. */
export interface MailMoveDestination {
  /** IMAP mailbox path (`INBOX/Archive`) or Graph folder id / well-known
   *  name (`archive`, `deleteditems`). */
  folder?: string;
  /** Gmail label ids to add. Combined with `remove_labels` this is a
   *  full `messages.modify` request. */
  add_labels?: string[];
  /** Gmail label ids to remove — pass `['INBOX']` for the archive
   *  gesture, which is what "move out of the inbox" means on Gmail. */
  remove_labels?: string[];
}
