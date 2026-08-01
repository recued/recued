/** Phase D (D-106) — MailProvider interface.
 *
 *  Three concrete implementations land later (Commits 13 / 14 / 15):
 *  IMAP (`imapflow`), Gmail REST, Microsoft Graph. Each one is free
 *  to own its transport + canonicalization but presents the same
 *  narrow surface to `MailCollection` so the outer code stays
 *  provider-agnostic.
 *
 *  Lifecycle:
 *    `connect()`    — bring the provider online (OAuth refresh,
 *                     IMAP LOGIN, etc.). Called from
 *                     `MailCollection.sync.start()` before the scan.
 *    `initialScan()`— fetch the last `backfill_days` of messages,
 *                     firing `onMessage` per entry. Returning
 *                     `false` from the callback aborts the scan —
 *                     used in tests / budget-aware ingestion.
 *    `startSync()`  — begin continuous delta polling / IDLE push.
 *                     Returns a stop function; `MailCollection`
 *                     calls it on drain.
 *    `close()`      — release connections + timers. Idempotent.
 *    `health()`     — current provider state snapshot; surfaces via
 *                     the collection's heartbeat envelope.
 *
 *  D-127 P1.1 — Outbound `send` capability. Optional per-provider —
 *  IMAP gains it when an SMTP block is supplied at enrollment;
 *  gmail-api / graph gain it when the OAuth grant includes the
 *  send scope. Providers set `sendCapable: false` and leave `send`
 *  undefined when not configured for outbound. Per-provider `send`
 *  implementations land in P1.3 (gmail) / P1.4 (graph) / P1.5 (imap).
 *
 *  D-127 P1.2 — `assertSendCapable` upgrades from plain Error to
 *  typed `IngredientError('MAIL_SEND_NOT_CAPABLE', …)` so the rpc
 *  layer + recipe error UI route the failure through the standard
 *  `RecipeErrorCode` plumbing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  isMailReconciliationId,
  MAIL_SENT_RECONCILIATION_MAX_WINDOW_MS,
  type MailSentAttachmentReconciliationQuery,
  type MailSentEnvelopeReconciliationQuery,
  type MailSentReconciliationQuery,
  type MailSentReconciliationResult,
} from '@recued/contracts';
import { IngredientError } from '@recued/ingredients';

export type {
  MailSentAttachmentReconciliationMatch,
  MailSentAttachmentReconciliationQuery,
  MailSentEnvelopeReconciliationMatch,
  MailSentEnvelopeReconciliationQuery,
  MailSentReconciliationMatch,
  MailSentReconciliationQuery,
  MailSentReconciliationResult,
} from '@recued/contracts';
export { MAIL_SENT_RECONCILIATION_MAX_WINDOW_MS } from '@recued/contracts';

export type MailProviderKind = 'imap' | 'gmail' | 'graph';

export interface InboundMailAttachmentPart {
  filename: string;
  mime_type: string;
  size: number;
  source_part_id: string;
  /** MIME disposition as observed at source. D-200 reconciliation requires a
   * real attachment; an inline part with the same bytes is not equivalent. */
  disposition?: 'attachment' | 'inline';
  fetchBytes(): Promise<Buffer>;
}

const FILENAME_MAX_BYTES = 255;

export const sanitizeMailAttachmentFilename = (raw: string, fallback = 'attachment'): string => {
  let s = String(raw ?? '').normalize('NFC');
  const parts = s.split(/[\\/]/);
  s = parts[parts.length - 1] ?? '';
  s = s.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length === 0 || s === '.' || s === '..') s = fallback;
  if (Buffer.byteLength(s, 'utf8') <= FILENAME_MAX_BYTES) return s;

  const dotIdx = s.lastIndexOf('.');
  const ext = dotIdx > 0 && s.length - dotIdx <= 16 ? s.slice(dotIdx) : '';
  const extBytes = Buffer.byteLength(ext, 'utf8');
  const room = Math.max(1, FILENAME_MAX_BYTES - extBytes);
  const stem = dotIdx > 0 ? s.slice(0, dotIdx) : s;
  return Buffer.from(stem, 'utf8').subarray(0, room).toString('utf8') + ext;
};

export const normalizeMailAttachmentMimeType = (raw: string | undefined): string => {
  const mime = String(raw ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mime.length > 0 ? mime : 'application/octet-stream';
};

const startsWith = (buf: Buffer, bytes: number[]): boolean => {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
};

const looksLikeText = (head: Buffer): boolean => {
  for (const b of head) {
    if (b === 0x00) return false;
    if (b < 0x09) return false;
    if (b === 0x0b || b === 0x0c) return false;
    if (b > 0x0d && b < 0x20) return false;
  }
  return true;
};

export const detectMailAttachmentMimeType = (
  bytes: Buffer,
  reported: string | undefined,
): string => {
  const head = bytes.subarray(0, 16);
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (
    startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
    head.length >= 12 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'image/gif';
  }
  const normalized = normalizeMailAttachmentMimeType(reported);
  if (head.length === 0 || looksLikeText(head)) {
    return normalized.startsWith('text/') ? normalized : 'text/plain';
  }
  return normalized;
};

export const mailAttachmentPartFromBytes = (input: {
  filename: string | undefined;
  mime_type: string | undefined;
  source_part_id: string;
  disposition?: 'attachment' | 'inline';
  bytes: Buffer;
}): InboundMailAttachmentPart => {
  const bytes = Buffer.from(input.bytes);
  return {
    filename: sanitizeMailAttachmentFilename(input.filename ?? '', 'attachment'),
    mime_type: detectMailAttachmentMimeType(bytes, input.mime_type),
    size: bytes.length,
    source_part_id: input.source_part_id,
    disposition: input.disposition ?? 'attachment',
    async fetchBytes() {
      return Buffer.from(bytes);
    },
  };
};

/** D-200 source proof must preserve provider-observed metadata. The ordinary
 * inbound helper intentionally sanitizes filenames and magic-detects MIME for
 * safe warehouse materialization; doing either here could launder a mismatched
 * source attachment into the expected `document.pdf` / `application/pdf`. */
export const mailSentReconciliationAttachmentPartFromBytes = (input: {
  filename: string | undefined;
  mime_type: string | undefined;
  source_part_id: string;
  disposition?: 'attachment' | 'inline';
  bytes: Buffer;
}): InboundMailAttachmentPart => {
  const bytes = Buffer.from(input.bytes);
  return {
    filename: input.filename ?? '',
    mime_type: normalizeMailAttachmentMimeType(input.mime_type),
    size: bytes.length,
    source_part_id: input.source_part_id,
    disposition: input.disposition ?? 'attachment',
    async fetchBytes() {
      return Buffer.from(bytes);
    },
  };
};

/** Provider-agnostic message shape. Mail adapters canonicalize their
 *  native message object into this before handing off to the outer
 *  `MailCollection`. */
export interface CanonicalMessage {
  /** Stable identifier within this provider/account. IMAP uses
   *  `UID@folder`; Gmail uses its `id`; Graph uses the message id.
   *  `MailCollection` hashes it into the row-level `record_id`. */
  source_id: string;
  /** RFC 5322 `Message-ID` header value — provider-agnostic, globally
   *  unique by construction, and the join key for the D-184 Decision 2
   *  CRM-email ↔ `data.mail` twin resolution (matched against the CRM
   *  engagement's `meta.message_id` / `hs_email_internet_message_id`).
   *  Distinct from `source_id` (which is provider-native: Gmail/Graph
   *  ids and IMAP `UID@folder` are NOT the Message-ID). Raw header value
   *  here (may carry surrounding `<>`); `MailCollection` normalizes it
   *  into the queryable `rfc_message_id` hot field. Absent when the
   *  provider/message exposes no Message-ID. */
  rfc_message_id?: string;
  /** Valid provider-carried X-Recued-Reconciliation-ID value, when present.
   * MailCollection revalidates it before indexing. */
  reconciliation_id?: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** Thread identifier (Gmail `threadId`, Graph `conversationId`,
   *  IMAP `References/In-Reply-To` chain). Empty when the provider
   *  doesn't expose threading. */
  thread_id: string;
  /** Primary folder or label — `INBOX`, `IMPORTANT`, etc. */
  folder_or_label: string;
  is_read: boolean;
  has_attachments: boolean;
  /** Unix-ms receipt timestamp at the source. */
  received_at: number;
  /** Plaintext body (canonicalized from HTML when only HTML exists). */
  body_text: string;
  /** Optional raw HTML body. Stored only when the caller enables
   *  HTML ingestion (future commit — Phase D keeps FTS on text). */
  body_html?: string;
  /** Provider-specific labels (Gmail). Empty for IMAP/Graph. */
  labels?: string[];
  /** Inbound attachment parts. Each part fetches bytes server-side for
   *  later CAS ingest; providers never upload bytes to a cloud service. */
  attachments?: InboundMailAttachmentPart[];
}

/** D-200 source-truth reconciliation deliberately scans a bounded historical
 * Sent window. A complete scan may prove one exact accepted message; an
 * incomplete scan or provider failure can never be reinterpreted as absence. */
export const MAIL_SENT_RECONCILIATION_MAX_SCAN = 200;
export const MAIL_SENT_RECONCILIATION_MAX_ATTACHMENT_BYTES = 3 * 1_024 * 1_024;
/** MIME/base64 framing adds overhead above the decoded 3 MiB artifact. Provider
 * adapters preflight whole-source reads against this ceiling. */
export const MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES = 5 * 1_024 * 1_024;

/** Provider-private candidate used only while proving an unresolved outbound
 * send. `reconciliation_header_values` retains every raw occurrence so a
 * duplicate header cannot be collapsed into one apparently exact identity.
 * Attachment bytes stay behind fetch closures and never enter the result. */
export interface MailSentReconciliationCandidate {
  source_id: string;
  rfc_message_id?: string;
  reconciliation_header_values: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  sent_at: number;
  attachments: InboundMailAttachmentPart[];
  /** False when the provider exposed an attachment kind/page that this adapter
   * could not enumerate exactly. Such a candidate is unavailable for proof,
   * never a source mismatch or a negative result. */
  attachment_set_complete: boolean;
}

const isSafeTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** Closed input validation shared by the collection boundary and every live
 * adapter. Throwing BAD_INPUT here keeps malformed time windows and hashes from
 * turning into expensive provider scans. */
export const assertMailSentReconciliationQuery = (
  query: MailSentReconciliationQuery,
): void => {
  const envelopeKeys = new Set([
    'proof_kind',
    'reconciliation_id',
    'recipient',
    'subject',
    'sent_after',
    'sent_before',
  ]);
  const attachmentKeys = new Set([
    ...envelopeKeys,
    'attachment_sha256',
    'attachment_size_bytes',
    'attachment_filename',
    'attachment_mime_type',
  ]);
  const allowedKeys = query.proof_kind === 'envelope'
    ? envelopeKeys
    : query.proof_kind === 'attachment'
      ? attachmentKeys
      : null;
  const baseValid = allowedKeys !== null
    && Object.keys(query).every((key) => allowedKeys.has(key))
    && isMailReconciliationId(query.reconciliation_id)
    && isBoundedString(query.recipient, 320)
    && query.recipient.trim() === query.recipient
    && isBoundedString(query.subject, 998)
    && query.subject.trim() === query.subject
    && isSafeTimestamp(query.sent_after)
    && isSafeTimestamp(query.sent_before)
    && query.sent_before > query.sent_after
    && query.sent_before - query.sent_after <= MAIL_SENT_RECONCILIATION_MAX_WINDOW_MS;
  const attachmentValid = query.proof_kind !== 'attachment' || (
    /^[a-f0-9]{64}$/.test(query.attachment_sha256)
    && Number.isSafeInteger(query.attachment_size_bytes)
    && query.attachment_size_bytes > 0
    && query.attachment_size_bytes <= MAIL_SENT_RECONCILIATION_MAX_ATTACHMENT_BYTES
    && isBoundedString(query.attachment_filename, 255)
    && query.attachment_filename.trim() === query.attachment_filename
    && isBoundedString(query.attachment_mime_type, 255)
    && query.attachment_mime_type.trim() === query.attachment_mime_type
  );
  const valid = baseValid && attachmentValid;
  if (!valid) {
    throw new IngredientError(
      'BAD_INPUT',
      'mail sent reconciliation query is malformed or exceeds its bounded source-truth window',
    );
  }
};

const normalizedAddress = (value: string): string => value.trim().toLowerCase();
const normalizedMime = (value: string): string =>
  value.split(';', 1)[0]?.trim().toLowerCase() ?? '';

/** Provider-neutral exactness gate. Adapters own discovery; this function owns
 * the security decision so Gmail, Graph, and IMAP cannot drift on duplicate
 * headers, envelope fields, time bounds, or attachment-byte proof. */
export const evaluateMailSentReconciliationCandidates = async (
  query: MailSentReconciliationQuery,
  candidates: MailSentReconciliationCandidate[],
  scanComplete: boolean,
): Promise<MailSentReconciliationResult> => {
  assertMailSentReconciliationQuery(query);
  const scannedCandidates = candidates.length;
  const identified = candidates.filter((candidate) =>
    candidate.reconciliation_header_values.some(
      (value) => value.trim() === query.reconciliation_id,
    ));

  if (identified.some((candidate) => candidate.reconciliation_header_values.length !== 1)) {
    return {
      status: 'ambiguous',
      reason: 'duplicate_header',
      scanned_candidates: scannedCandidates,
    };
  }
  if (identified.length > 1) {
    return {
      status: 'ambiguous',
      reason: 'multiple_messages',
      scanned_candidates: scannedCandidates,
    };
  }
  if (identified.length === 0) {
    return scanComplete
      ? { status: 'not_found', scanned_candidates: scannedCandidates }
      : {
          status: 'unavailable',
          reason: 'scan_limit',
          scanned_candidates: scannedCandidates,
        };
  }

  const candidate = identified[0]!;
  if (!scanComplete) {
    return {
      status: 'unavailable',
      reason: 'scan_limit',
      scanned_candidates: scannedCandidates,
    };
  }
  const envelopeMatches = candidate.to.length === 1
    && normalizedAddress(candidate.to[0]!) === normalizedAddress(query.recipient)
    && candidate.cc.length === 0
    && candidate.bcc.length === 0
    && candidate.subject === query.subject
    && isSafeTimestamp(candidate.sent_at)
    && candidate.sent_at >= query.sent_after
    && candidate.sent_at < query.sent_before;
  if (!envelopeMatches) {
    return {
      status: 'ambiguous',
      reason: 'source_mismatch',
      scanned_candidates: scannedCandidates,
    };
  }
  const providerMessageId = (candidate.rfc_message_id ?? candidate.source_id).trim();
  if (providerMessageId.length === 0 || providerMessageId.length > 2_048) {
    return {
      status: 'ambiguous',
      reason: 'source_mismatch',
      scanned_candidates: scannedCandidates,
    };
  }
  if (query.proof_kind === 'envelope') {
    return {
      status: 'matched',
      scanned_candidates: scannedCandidates,
      match: {
        proof_kind: 'envelope',
        source_id: candidate.source_id,
        provider_message_id: providerMessageId,
        sent_at: candidate.sent_at,
      },
    };
  }
  if (!candidate.attachment_set_complete) {
    return {
      status: 'unavailable',
      reason: 'attachment_unreadable',
      scanned_candidates: scannedCandidates,
    };
  }
  if (candidate.attachments.length !== 1) {
    return {
      status: 'ambiguous',
      reason: 'source_mismatch',
      scanned_candidates: scannedCandidates,
    };
  }

  const attachment = candidate.attachments[0]!;
  if (
    !Number.isSafeInteger(attachment.size)
    || attachment.size !== query.attachment_size_bytes
    || attachment.disposition !== 'attachment'
    || attachment.filename !== query.attachment_filename
    || normalizedMime(attachment.mime_type) !== normalizedMime(query.attachment_mime_type)
  ) {
    return {
      status: 'ambiguous',
      reason: 'source_mismatch',
      scanned_candidates: scannedCandidates,
    };
  }

  let bytes: Buffer;
  try {
    bytes = await attachment.fetchBytes();
  } catch {
    return {
      status: 'unavailable',
      reason: 'attachment_unreadable',
      scanned_candidates: scannedCandidates,
    };
  }
  const attachmentSha256 = createHash('sha256').update(bytes).digest('hex');
  if (
    bytes.length !== query.attachment_size_bytes
    || attachmentSha256 !== query.attachment_sha256
  ) {
    return {
      status: 'ambiguous',
      reason: 'source_mismatch',
      scanned_candidates: scannedCandidates,
    };
  }

  return {
    status: 'matched',
    scanned_candidates: scannedCandidates,
    match: {
      proof_kind: 'attachment',
      source_id: candidate.source_id,
      provider_message_id: providerMessageId,
      sent_at: candidate.sent_at,
      attachment_sha256: attachmentSha256,
      attachment_size_bytes: bytes.length,
    },
  };
};

/** D-184 Decision 2 — normalize an RFC 5322 `Message-ID` for twin
 *  matching: strip a single pair of surrounding angle brackets + trim.
 *  Case is preserved (Message-IDs are case-sensitive per RFC 5322
 *  §3.6.4). Both the `data.mail` capture side (the `rfc_message_id` hot
 *  field) and the engagement-resolver join side run inputs through this
 *  so a CRM `<id@host>` and an inbound-mail `id@host` line up. Returns
 *  `undefined` for empty / missing input. */
export const normalizeRfcMessageId = (
  raw: string | null | undefined,
): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim();
  if (s.length >= 2 && s.startsWith('<') && s.endsWith('>')) {
    s = s.slice(1, -1).trim();
  }
  return s.length > 0 ? s : undefined;
};

/** Live-sync event kinds. `created` covers a brand-new message; the
 *  provider MUST not fire `created` twice for the same source_id.
 *  `updated` fires on flag / label changes. `deleted` includes
 *  both permanent deletions and soft-deletes (Gmail trash) when the
 *  provider classifies them that way. */
export type ProviderSyncEventKind = 'created' | 'updated' | 'deleted';

export interface ProviderSyncEvent {
  kind: ProviderSyncEventKind;
  source_id: string;
  /** Present on `created` and `updated`, omitted on `deleted`. */
  message?: CanonicalMessage;
}

export type ProviderSyncCallback = (event: ProviderSyncEvent) => Promise<void>;

export interface ProviderHealth {
  /** Unix-ms of the last successful fetch / poll / idle tick. 0
   *  before the first success. */
  last_successful_sync_at: number;
  /** Rolling error count across the last 24 h. */
  error_count_24h: number;
  /** Depth of the provider's internal fetch / delta queue. */
  pending_queue_size: number;
}

export interface InitialScanOptions {
  backfill_days: number;
  onMessage: (msg: CanonicalMessage) => Promise<boolean>;
}

// ════════════════════════════════════════════════════════════════
// Per-attempt sync outcomes
//
// `ProviderHealth.last_successful_sync_at` cannot answer "is this mailbox
// working right now" for two reasons, both discovered the hard way:
//
//   1. It is a LIFETIME clock, and non-inbound work advances it — a successful
//      send bumps it, so does sent-reconciliation. A mailbox that can send but
//      cannot read reads as freshly synced.
//   2. It only ever moves FORWARD. Providers swallow their own tick failures
//      (`markError`), so a token revoked after startup leaves the clock frozen
//      at its last success with nothing to distinguish that from a quiet
//      mailbox — and a successful but EMPTY poll leaves it frozen too.
//
// So providers report each ATTEMPT: what phase it was, whether it succeeded,
// and — when it failed — whether the credential or the provider was at fault.
// Only the provider can make that call: it knows an IMAP `EAUTH` from a socket
// reset, and a token-endpoint 400 (`invalid_grant`) from an API 400 (bad
// request). Handing the raw error upward and classifying it there is how the
// first cut of this got IMAP wrong.
// ════════════════════════════════════════════════════════════════

/** Which lifecycle attempt an outcome describes. `poll` covers one delta /
 *  history tick (Gmail / Graph) or one IDLE-driven fetch batch (IMAP);
 *  `reconnect` is IMAP's backoff loop re-establishing a dropped connection. */
export type MailSyncPhase = 'initial_scan' | 'poll' | 'reconnect';

/** Why an attempt failed, in the only two categories that change what the USER
 *  must do: re-consent (`auth`) versus wait (`transient`). Anything finer is
 *  detail for the log, not for a state the UI renders. */
export type MailSyncFailureKind = 'auth' | 'transient';

export interface MailSyncOutcome {
  phase: MailSyncPhase;
  /** True for a completed attempt — INCLUDING one that found nothing. An empty
   *  successful poll is the single most common healthy outcome and the whole
   *  reason this is reported separately from message delivery. */
  ok: boolean;
  /** Set iff `ok === false`. */
  failure?: MailSyncFailureKind;
  at: number;
}

export type MailSyncOutcomeListener = (outcome: MailSyncOutcome) => void;

/** Google / Graph API error `reason` values that genuinely mean "the credential
 *  or its consent is insufficient". Everything ELSE at 403 — and Gmail sends a
 *  lot at 403 — is quota.
 *
 *  🔑 403 is NOT an auth status on these APIs. Gmail returns 403 for
 *  `rateLimitExceeded` / `userRateLimitExceeded` / `quotaExceeded`, all of which
 *  want backoff, not re-consent
 *  (developers.google.com/workspace/gmail/api/guides/handle-errors). Mapping 403
 *  → auth wholesale trains users to re-authorize a perfectly good account every
 *  time they hit a rate limit. */
const API_AUTH_REASONS: readonly string[] = [
  'insufficientPermissions',
  'insufficientScope',
  'forbidden',
  'authError',
  'unauthorized',
];

/** Classify an API READ failure.
 *
 *  401 is unambiguous: the credential was rejected. 403 needs the body's
 *  `reason`, and absent a recognizable auth reason it is treated as
 *  `transient` — the deliberately CONSERVATIVE direction. Misreading a real auth
 *  failure as transient costs a slower diagnosis; misreading quota as auth sends
 *  the user to re-consent for nothing and teaches them the prompt is noise.
 *
 *  ⚠ Deliberately NOT used for token-endpoint failures — see
 *  {@link classifyOAuthFailure}, where 400 means something entirely different. */
export const classifyMailApiStatus = (
  status: number,
  body?: string,
): MailSyncFailureKind => {
  if (status === 401) return 'auth';
  if (status !== 403) return 'transient';
  if (body === undefined) return 'transient';
  return API_AUTH_REASONS.some((reason) => body.includes(reason)) ? 'auth' : 'transient';
};

/** Classify a token exchange / refresh failure.
 *
 *  ⛔ **The STATUS alone cannot decide this, because RFC 6749 § 5.2 returns 400
 *  for five different errors and only ONE of them is the user's problem:**
 *
 *    `invalid_grant`          → the grant is gone (revoked, expired, or the
 *                               7-day Testing-mode expiry). RE-CONSENT. This is
 *                               the single most common death of a long-lived
 *                               mailbox, and it arrives as HTTP 400.
 *    `invalid_client`         → our client id/secret is wrong.
 *    `invalid_scope`          → we asked for a scope the app cannot have.
 *    `unsupported_grant_type` /
 *    `invalid_request`        → our request is malformed.
 *
 *  The last four are OUR misconfiguration. Re-authorizing fixes none of them, so
 *  they report `transient` ("not working") rather than sending the owner through
 *  a consent screen that cannot help.
 *
 *  429 / 5xx are transient regardless of reason: the credential is fine, the
 *  endpoint is busy or broken. A 401 with no parsed reason is auth — that is the
 *  canonical rejected-credential status and `missing_refresh_token` uses it. */
export const classifyOAuthFailure = (
  status: number,
  oauthError?: string,
): MailSyncFailureKind => {
  if (status === 429 || status >= 500) return 'transient';
  if (oauthError === 'invalid_grant') return 'auth';
  // A reason we recognize as NOT invalid_grant is our own config problem.
  if (oauthError !== undefined) return 'transient';
  // No parseable reason — fall back to the status. 401 is a rejected credential;
  // a bare 400 could be either, so stay conservative.
  return status === 401 ? 'auth' : 'transient';
};

export interface MailSyncOutcomeReporter {
  /** Register a listener; returns its unsubscribe. */
  subscribe(listener: MailSyncOutcomeListener): () => void;
  /** Record the classified cause of a failure the provider is about to SWALLOW
   *  (the `getWithRetry`-returns-null shape). Consumed by the enclosing
   *  {@link run}, which is what turns a silent early-return into a reported
   *  failure instead of a reported success. */
  noteFailure(kind: MailSyncFailureKind): void;
  /** Emit one outcome directly, for an attempt that is not shaped like a wrapped
   *  call — IMAP's self-re-entering reconnect loop, which reports from inside its
   *  own catch. Prefer {@link run} whenever there is a function to wrap. */
  report(phase: MailSyncPhase, ok: boolean, failure?: MailSyncFailureKind): void;
  /** Run one attempt, emitting EXACTLY one outcome. Rethrows whatever `fn`
   *  throws, so existing control flow is untouched — this observes, it does not
   *  intercept. A throw is classified by the reporter's `classifyError`; a
   *  clean return with a noted swallow is that swallow; a clean return with
   *  nothing noted is a success. */
  run<T>(phase: MailSyncPhase, fn: () => Promise<T>): Promise<T>;
}

/** One attempt's mutable note slot, scoped by `AsyncLocalStorage`. */
interface AttemptScope { noted?: MailSyncFailureKind }

/** ⛔ `AsyncLocalStorage`, NOT a module-level "current attempt".
 *
 *  Poll ticks can OVERLAP: the providers' `defaultScheduler` is
 *  `setInterval(() => { void cb().catch(…) })`, which never awaits the previous
 *  tick, so any tick slower than the 30 s interval runs alongside its successor.
 *  With one shared `noted` variable that silently corrupts the report — tick A
 *  hits a 403 and sets it, tick B finishes clean and CONSUMES A's note (reporting
 *  B as failed), then A finishes to find the slot cleared and reports itself
 *  HEALTHY. The attempt that actually failed would claim success, which is the
 *  exact false-healthy this substrate exists to remove.
 *
 *  ALS scopes correctly across every `await` inside an attempt, so a note lands
 *  on the attempt that made it. Same reasoning, same mechanism as
 *  `cacheProbeStore` in `commit-gateway-wiring.ts`. */
const attemptStore = new AsyncLocalStorage<AttemptScope>();

export const createMailSyncOutcomeReporter = (deps: {
  now: () => number;
  /** Provider-specific: only the provider can tell its own auth error from a
   *  transport one. */
  classifyError: (err: unknown) => MailSyncFailureKind;
}): MailSyncOutcomeReporter => {
  const listeners = new Set<MailSyncOutcomeListener>();

  const emit = (phase: MailSyncPhase, ok: boolean, failure?: MailSyncFailureKind): void => {
    const outcome: MailSyncOutcome = {
      phase,
      ok,
      ...(failure !== undefined ? { failure } : {}),
      at: deps.now(),
    };
    for (const listener of listeners) {
      // A listener is the collection's durable reporting sink. It must never be
      // able to break the sync it is describing.
      try { listener(outcome); } catch { /* swallow */ }
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    noteFailure(kind) {
      const scope = attemptStore.getStore();
      // Outside any attempt (a send, a reconciliation lookup) there is nothing to
      // attribute this to — the caller's own error handling owns it.
      if (scope === undefined) return;
      // An `auth` note outranks a `transient` one within a single attempt: a
      // tick that hit both a 429 and a 401 needs the re-consent surfaced, and
      // the 401 is the one the user can act on.
      if (scope.noted === 'auth') return;
      scope.noted = kind;
    },
    report(phase, ok, failure) {
      emit(phase, ok, failure);
    },
    async run(phase, fn) {
      const scope: AttemptScope = {};
      return attemptStore.run(scope, async () => {
        try {
          const result = await fn();
          if (scope.noted !== undefined) emit(phase, false, scope.noted);
          else emit(phase, true);
          return result;
        } catch (err) {
          emit(phase, false, scope.noted ?? deps.classifyError(err));
          throw err;
        }
      });
    },
  };
};

export interface MailProvider {
  readonly kind: MailProviderKind;
  readonly slug: string;

  /** D-127 P1.1 — true iff this provider instance is configured to
   *  send. For gmail-api / graph: OAuth grant includes the Send
   *  scope. For imap: enrollment supplied an SMTP block. Read by
   *  `MailCollection` and surfaced on the instance row so the
   *  picker filters senders correctly. */
  readonly sendCapable: boolean;

  /** D-127 P1.6 — canonical address of the mail account behind this
   *  provider instance. Drives the rpc-layer sender ≠ `to` guard
   *  (spec § A.8). For OAuth providers this populates from the
   *  granted profile (gmail's `emailAddress`, graph's
   *  `userPrincipalName`) — set via `config.account_email` until
   *  P4.x wires the post-OAuth profile fetch. For IMAP it derives
   *  from the SMTP block's `from` field, defaulting to the IMAP
   *  username. Empty string is allowed when the address is not yet
   *  known (pre-P4.x); the rpc layer skips the self-loop guard in
   *  that case rather than rejecting every send. */
  readonly accountEmail: string;

  /** Bring the provider online. Throws `COLLECTION_SOURCE_UNREACHABLE`-
   *  shaped errors when the source is unreachable so
   *  `MailCollection` can stamp the right collection state. */
  connect(): Promise<void>;
  /** Fetch the last `backfill_days` of messages. `onMessage` runs
   *  per entry; returning `false` aborts the scan. Implementations
   *  should stream so millions of rows don't land in RAM. */
  initialScan(opts: InitialScanOptions): Promise<void>;
  /** Begin continuous sync. Returns a stop function that cancels
   *  timers / closes IDLE connections. */
  startSync(cb: ProviderSyncCallback): Promise<() => Promise<void>>;
  /** Release connections + timers. Called from
   *  `MailCollection.close()` on drain. Idempotent. */
  close(): Promise<void>;
  health(): ProviderHealth;

  /** Subscribe to per-attempt sync outcomes; returns the unsubscribe.
   *
   *  Optional so existing fakes and out-of-tree providers keep compiling. When a
   *  provider does NOT implement it, the collection falls back to reporting only
   *  the start-attempt outcome — honest, just coarser. See {@link MailSyncOutcome}
   *  for why `health()` cannot substitute for this. */
  onSyncOutcome?(listener: MailSyncOutcomeListener): () => void;

  /** D-127 P1.1 — outbound send. Optional. Implementations set
   *  `sendCapable: true` and provide this method together; both
   *  fields move in lockstep. Sent messages also land in the
   *  provider's Sent folder (passive — Gmail / Graph file
   *  automatically; IMAP+SMTP IMAP-APPENDs after submission per
   *  P1.5). Throws `MAIL_SEND_*` typed errors on failure. */
  send?(msg: OutgoingMessage): Promise<SentMessageMeta>;

  /** D-200 — server-internal source-truth lookup for an already-fenced send.
   * Providers must inspect their Sent source and pass candidates through the
   * shared exactness gate. `not_found` is never failure/resend authority. */
  lookupSentByReconciliationId?(
    query: MailSentReconciliationQuery,
  ): Promise<MailSentReconciliationResult>;
}

/** D-172 P2 (Attachments-v2) — a single resolved outbound attachment.
 *  `MailCollection.send` resolves each `data.file` ref through the
 *  Gateway-gated `file.read` (the one audited byte-egress path, I-4)
 *  BEFORE handing the message to `provider.send`, so providers never
 *  touch the warehouse — they receive bytes already-decoded.
 *
 *  `bytes_b64` is the plaintext (post-decryption) file content,
 *  base64-encoded. base64 is the native shape Gmail (`raw` RFC822
 *  body part) and Graph (`contentBytes`) want; the IMAP/nodemailer
 *  path decodes it to a Buffer. Carrying one canonical encoding all
 *  three providers render from keeps the resolve layer provider-
 *  agnostic. */
export interface OutgoingAttachment {
  /** Sanitized display filename (visitor/sender-supplied at ingest).
   *  Used verbatim as the MIME `Content-Disposition: attachment;
   *  filename=` / Graph `name` / nodemailer `filename`. */
  filename: string;
  /** Server-detected MIME type (magic bytes, not the reported value)
   *  from the `data.file` record. Drives the part's `Content-Type`. */
  mime_type: string;
  /** Plaintext file bytes, base64-encoded (RFC 4648 standard, not
   *  base64url). */
  bytes_b64: string;
  /** Decoded byte length — the over-size cap check reads this without
   *  re-decoding. */
  size_bytes: number;
}

/** D-127 P1.1 — outbound message shape passed to `MailProvider.send`.
 *  At least one of `to` / `cc` / `bcc` must be non-empty (provider-
 *  level guard). Body content is plaintext + optional HTML.
 *
 *  D-172 P2 — `attachments` carries already-resolved file bytes (refs
 *  resolved to `OutgoingAttachment[]` at `MailCollection.send`). When
 *  omitted / empty, providers compose the same text-or-multipart/
 *  alternative body they always have. */
export interface OutgoingMessage {
  /** Primary recipients. Each entry is an RFC 5322 mailbox
   *  ("alice@example.com" or "Alice Example <alice@example.com>"). */
  to: string[];
  /** Carbon-copy recipients. Empty array elided when the provider
   *  doesn't accept empty `cc`. */
  cc?: string[];
  /** Blind carbon-copy recipients. Provider-side handling — Gmail /
   *  Graph honor it server-side; SMTP submission lists them in the
   *  envelope but not headers. */
  bcc?: string[];
  /** Subject line. Empty string allowed (some providers normalize
   *  to "(no subject)"). */
  subject: string;
  /** Plaintext body. Always present — providers fall back to
   *  text/plain MIME part when no HTML is supplied. */
  body_text: string;
  /** Optional HTML body. When set, providers compose a
   *  multipart/alternative MIME container with both text and HTML
   *  parts so recipient clients pick the best rendering. */
  body_html?: string;
  /** RFC 5322 In-Reply-To header. Populates thread continuity in
   *  the recipient's mail client + the provider's own thread index. */
  in_reply_to?: string;
  /** RFC 5322 References header — full ancestry chain (parent
   *  Message-Ids of every prior message in the thread). Adapters
   *  derive from `in_reply_to` when not supplied. */
  references?: string[];
  /** Reply-To header. Defaults to the sender's own address when
   *  omitted; supply explicitly when a different reply route is
   *  desired. */
  reply_to?: string;
  /** Compact caller-pinned identity carried as
   * X-Recued-Reconciliation-ID across every provider. */
  reconciliation_id?: string;
  /** D-172 P2 — resolved file attachments. Each carries decoded
   *  bytes (base64) + filename + mime so the provider renders a
   *  native attachment part (Gmail multipart/mixed; Graph
   *  fileAttachment; IMAP nodemailer attachment). Empty / absent =>
   *  no attachments. The send layer (`MailCollection.send`) has
   *  already resolved the `data.file` refs through the Gateway-gated
   *  `file.read` — providers never reach the warehouse. */
  attachments?: OutgoingAttachment[];
}

/** D-127 P1.1 — successful-send return shape from
 *  `MailProvider.send`. Carries the provider-side identifier the
 *  warehouse will eventually index when the next inbound delta
 *  picks the Sent record up. `_id` (canonical record id) lands on
 *  the rpc layer's response, not here — providers don't see the
 *  warehouse's record-id derivation. */
export interface SentMessageMeta {
  /** Provider-side identifier — Gmail message id, Graph id, or
   *  RFC 5322 Message-Id header for SMTP submission. The
   *  warehouse hashes this into `record_id` when ingesting the
   *  Sent record on the next delta. */
  source_id: string;
  /** RFC 5322 Message-Id header value. Equal to `source_id` for
   *  Gmail (server-side identifier doubles as Message-Id) and
   *  SMTP (we generate it client-side); for Graph it's a separate
   *  header that needs an extra fetch — graph-provider populates
   *  via the synchronous-send + drafts chain (P1.4 § implementation
   *  note). */
  message_id: string;
  /** Unix-ms send timestamp. */
  sent_at: number;
  /** Thread identifier when the provider exposes one — Gmail's
   *  `threadId`, Graph's `conversationId`. Empty for SMTP. */
  thread_id?: string;
  /** D-127 P1.5 — non-fatal warnings the provider hit during the
   *  send. Surfaced on the audit row by P1.7 so users can see
   *  side-effects that didn't roll the SMTP submission back. The
   *  IMAP provider populates this with `MAIL_SEND_APPEND_FAILED`
   *  when SMTP submission succeeds but the IMAP APPEND to the
   *  user's Sent folder fails — the recipient still got the email,
   *  but the local Sent folder is one record off until the next
   *  reconcile. */
  warnings?: Array<{ code: string; message: string }>;
}

/** D-127 P1.1/1.2 — type-narrowing assertion. Throws
 *  `MAIL_SEND_NOT_CAPABLE` `IngredientError` when the provider
 *  isn't configured to send; otherwise narrows the type so callers
 *  can invoke `provider.send(...)` without a bang or optional-chain.
 *
 *  Pattern: callers gate the dispatch site once via this helper
 *  and then call `provider.send` freely inside the narrowed scope.
 *  The lockstep guard (sendCapable: true + send: undefined) hits
 *  the same code path — defensive against a buggy provider that
 *  flips the flag without wiring the method.  */
export function assertSendCapable(
  provider: MailProvider,
): asserts provider is MailProvider & {
  readonly sendCapable: true;
  send: (msg: OutgoingMessage) => Promise<SentMessageMeta>;
} {
  if (!provider.sendCapable || typeof provider.send !== 'function') {
    throw new IngredientError(
      'MAIL_SEND_NOT_CAPABLE',
      `Mail account ${provider.kind}/${provider.slug} is not configured to send. Re-enroll with sending enabled, or pick a different mail account.`,
      { kind: provider.kind, slug: provider.slug },
    );
  }
}
