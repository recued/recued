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
