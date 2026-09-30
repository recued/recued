/** Phase D (D-106) — mail collection.
 *
 *  Composes `CollectionTable` + `MailProvider` + retention + emitter.
 *  Provider-agnostic — the outer code only knows about
 *  `CanonicalMessage` and `ProviderSyncEvent`. Commits 13 / 14 / 15
 *  supply concrete IMAP / Gmail / Graph implementations.
 *
 *  Body storage follows the spec's split:
 *    body_text ≤ 64 KB → `body_inline` (FTS-indexed).
 *    body_text > 64 KB → CAS blob via `blob_hash` (not FTS-indexed).
 *
 *  Hot fields (hand-specified per D-106 #2; no auto-promotion):
 *    { from, to, cc, subject, thread_id, folder, direction, is_read,
 *      has_attachments, labels?, message_id, rfc_message_id?,
 *      reconciliation_id? }
 *
 *  `record_id` hashes the provider's `source_id`, and ⛔ two accounts CAN
 *  share one: an IMAP `source_id` is `uid@folder`, and every IMAP account has
 *  a UID 7 in INBOX. Their ROWS never meet — each `(platform, slug)` gets its
 *  own SQLite table — but whatever else is keyed by the bare `record_id` is
 *  shared between them. Attachment files are named with their mailbox for that
 *  reason (`mail-attachment-source-id.ts`); links, annotations and
 *  enrichments are still keyed by the bare id.
 */

import { assertPreapprovalOrdinaryRun, currentPreapprovalIo } from '../../preapproval-io-context.js';
import { readConfinedTempBytes } from '../../execution/run-scratch.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MAIL_RFC_MESSAGE_ID_HOT_FIELD } from './mail-twin-resolver.js';
import type Database from 'better-sqlite3';
import type { StorageGate } from '@recued/storage-gate';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import type {
  CollectionAuthState,
  CollectionHealth,
  CollectionListQuery,
  CollectionRecord,
  CollectionSearchMatch,
  CollectionSearchQuery,
  CollectionState,
  Link,
  MailSendAuditDetail,
} from '@recued/contracts';
import { MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD } from '@recued/contracts';
import {
  MAIL_SEND_ATTACHMENT_MAX_BYTES,
  MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING,
} from '@recued/contracts';
import {
  isMailReconciliationId,
  isMailSendClaimDelivered,
  isTempFileRef,
  type TempFileRef,
} from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import { IngredientError } from '@recued/ingredients';

import type { BlobStore } from '../../storage/blob-store.js';
// D-207 slice 3d — the pre-dispatch claim: the general no-resend fence.
import { createMailSendClaimStore } from '../../storage/mail-send-claim-store.js';
import { mailSendClaimNeedsOwner } from '../../mail-send-outcome-ask.js';
import type { CollectionInstanceStore } from '../instance-store.js';
import type { CollectionRegistry } from '../registry.js';
import {
  handleFileRead,
  DATA_FILE_RECEIVED_SLUG,
  type FileReadDeps,
} from '../file/file-read-handler.js';
import type {
  AttachFileArgs,
  AttachFileDeps,
  AttachFileResult,
} from '../file/attach-file.js';
import type {
  DataFileRecord,
  InboundFileIngestInput,
} from '../file/inbound-file-collection.js';
import { createBackfillAuditRecorder } from '../../triggers/backfill-audit.js';
// `classifyOAuthStatus` is shared with the providers so the token-endpoint
// status policy (notably 400 = invalid_grant = auth) cannot drift between them.
import {
  classifyOAuthFailure,
  type MailMutationResult,
  type MailSyncOutcome,
  type SavedDraftMeta,
} from './provider.js';
// The auth-vs-transient discriminant for `classifySyncFailure`. Same module the
// providers throw from, so the classification cannot drift from the thrower.
import { OAuthError } from './oauth.js';
import {
  createCollectionTable,
  INLINE_CUTOFF_BYTES,
  type CollectionTable,
} from '../table.js';
import { createCollectionEmitter } from '../events.js';
import {
  createCollectionRetention,
  type CollectionRetention,
} from '../retention.js';
import type {
  Collection,
  CollectionPruneResult,
  CollectionSyncAdapter,
} from '../types.js';
import type {
  CanonicalMessage,
  MailMessageDirection,
  MailSentReconciliationQuery,
  MailSentReconciliationResult,
  MailSyncFailureKind,
  OutgoingAttachment,
  ProviderSyncEvent,
} from './provider.js';
import {
  assertMailSentReconciliationQuery,
  detectMailAttachmentMimeType,
  normalizeRfcMessageId,
  type MailProvider,
} from './provider.js';
import {
  legacyMailAttachmentSourceId,
  mailAttachmentFileId,
  mailRecordIdHeldByAnotherMailbox,
  scopedMailAttachmentSourceId,
} from './mail-attachment-source-id.js';

export interface MailCollectionConfig {
  /** Number of days to backfill on first boot. */
  backfill_days: number;
  /** Age-based retention window. Mail default per spec is 365 days. */
  retention_days: number;
  /** Forwarded to the Phase B gate registration in bin.ts. */
  quota_bytes: number;
}

export interface MailInboundFileIngestor {
  ingest(input: InboundFileIngestInput): Promise<DataFileRecord>;
}

export type MailAttachFileFn = (
  args: AttachFileArgs,
  deps: AttachFileDeps,
) => Promise<AttachFileResult>;

export interface MailInboundAttachmentDeps {
  fileIngestor: MailInboundFileIngestor;
  attach: MailAttachFileFn;
  attachDeps: AttachFileDeps;
  authored_by?: string;
}

/** D-315 — an attachment the ingest materialized into `data.file`. */
export interface MailUpsertAttachment {
  readonly file_id: string;
  readonly filename: string;
  readonly mime_type: string;
}

/** D-315 — what the collection knows about one upsert, for a derivation hook
 *  that must tell news from past mail (a mail fact triggers only on news). */
export interface MailUpsertContext {
  readonly slug: string;
  readonly record_id: string;
  /** The mailbox's own address, as the provider knows it; `''` when it does not. */
  readonly account_email: string;
  /** No row had this `record_id` before: the message is seen for the first
   *  time. A restart's re-list and a flag change are not first sightings. */
  readonly first_seen: boolean;
  /** The mailbox's first backfill had finished when this row landed, so a
   *  first sighting now is mail that arrived, not mail the backfill found. */
  readonly backfill_complete: boolean;
  /** The configured backfill window, in days. */
  readonly backfill_days: number;
  /** How long the mailbox keeps mail, in days: mail older than this was
   *  pruned, so a first sighting of it is mail found again, never news. */
  readonly retention_days?: number;
  /** The attachments materialized for this message, in its order. One whose
   *  ingest failed is absent (the failure is a collection error already). */
  readonly attachments: readonly MailUpsertAttachment[];
}

/** D-315 — a row that landed for the first time, before its attachments are
 *  fetched: what a hook needs to record that it is news, so a stop or a crash
 *  before the upsert hook runs does not make it past mail. */
export interface MailStoredContext {
  readonly slug: string;
  readonly record_id: string;
  readonly backfill_complete: boolean;
  readonly backfill_days: number;
  readonly retention_days?: number;
}

export interface CreateMailCollectionOptions {
  db: Database.Database;
  blobs: BlobStore;
  gate: StorageGate;
  bus: WarehouseEventBus;
  slug: string;
  /** Pre-constructed provider (Commit 13/14/15 factories). Each
   *  provider handles its own OAuth / IMAP specifics; the outer
   *  `MailCollection` only touches the narrow interface. */
  provider: MailProvider;
  config: () => MailCollectionConfig;
  auditLog?: AuditLogStore;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** The first wait before a failed first backfill is tried again
   *  (`MAIL_FIRST_SCAN_RETRY_MS`). Tests shorten it. */
  firstScanRetryMs?: number;
  /** D-121 Phase 1 — derivation hook fired after a successful upsert.
   *  The contact-derive integration uses this to materialize
   *  `data.contact` rows from From/To/CC headers; left undefined the
   *  collection runs unchanged. Errors thrown by the hook are
   *  swallowed via `bumpError` so a contact write failure never
   *  rolls back a verified mail ingest.
   *
   *  D-315 adds the context (`MailUpsertContext`): the mail-fact writer
   *  reads it to decide whether a fact may trigger. */
  onMessageUpserted?: (msg: CanonicalMessage, ctx: MailUpsertContext) => void;
  /** D-315 — a message stored for the first time, called the moment its row
   *  lands (before the attachments' awaits, which a stop can interrupt).
   *  Errors are swallowed via `bumpError`. */
  onMessageStored?: (msg: CanonicalMessage, ctx: MailStoredContext) => void;
  /** D-315 — rows a delete path removed: a provider-side delete, the
   *  collection's `delete`, or retention (age or storage pressure). Called
   *  once the rows are gone; what was derived from them goes too (a mail
   *  fact follows its email, ruling 29). Errors are swallowed via
   *  `bumpError`, like `onMessageUpserted`. */
  onRecordsRemoved?: (slug: string, record_ids: readonly string[]) => void;
  /** D-315 — a row re-keyed by a provider-verified move (IMAP and Graph
   *  mint a new id on move): the message is the same, only its id changed. */
  onRecordRekeyed?: (slug: string, from_record_id: string, to_record_id: string) => void;
  /** D-124 Phase 2.1 — instance store reference used to flip
   *  `collection_instances.backfill_complete` to true after the
   *  provider's `initialScan` resolves successfully. Optional so
   *  legacy in-memory test harnesses keep working without an instance
   *  row; production stacks always supply it via the mail compose
   *  root. */
  instances?: CollectionInstanceStore;
  /** D-172 P2 — lazy provider of the `file.read` deps used to resolve
   *  outbound `attachments` refs into bytes. Returns
   *  `{ registry, blobs, auditLog }` (the `handleFileRead` deps) or
   *  `undefined` when the file substrate isn't wired (dbless / no-CAS
   *  harness). Lazy because the collection registry is created AFTER
   *  the mail stack object in the boot composer — the getter defers the
   *  read to call time, when the registry is populated. When a send
   *  carries attachment refs but this returns `undefined`, the send
   *  throws `MAIL_SEND_ATTACHMENT_UNRESOLVABLE` (never silently drops —
   *  D-172 I-6). */
  fileReadDeps?: () => FileReadDeps | undefined;
  /** D-172 A.7 — lazy provider of inbound file-substrate deps used to
   *  materialize received mail MIME parts into `data.file.received` and
   *  link them onto the mail record. Lazy for the same boot-order reason
   *  as `fileReadDeps`: the file collection + registry are assembled by
   *  the composition root around the mail stack. Absent deps with
   *  surfaced attachment parts are logged as a collection error rather
   *  than silently dropped. */
  inboundAttachmentDeps?: () => MailInboundAttachmentDeps | undefined;
}

const recordIdFor = (sourceId: string): string =>
  `mail:${createHash('sha256').update(sourceId).digest('hex').slice(0, 32)}`;

/** ⚠ BOTH CONSTANTS MOVED TO `@recued/contracts` (`packages/contracts/src/mail.ts`),
 *  where their rationale now lives in full. The compose UI needs the cap to mark
 *  an over-cap file before send, and `packages/` may not import `backend/`.
 *  Re-exported here because this module was their home and their importers
 *  (the collection tests, the SMTP drive) name them from here — ONE definition,
 *  aliased, never copied. */
export { MAIL_SEND_ATTACHMENT_MAX_BYTES, MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING };

/** Exported so the dispatcher folds a mutation result's folder the SAME way
 *  the ingest path folds a synced message's. Two copies of this priority
 *  list would let a mutated row and a synced row disagree about which
 *  folder a Gmail message is "in", and `folder` is a filterable hot field —
 *  the disagreement would surface as a recipe's list query intermittently
 *  missing a message depending on how it was last touched. */
/** A failed first backfill is tried again after a minute, then twice as long
 *  each time, up to an hour. */
export const MAIL_FIRST_SCAN_RETRY_MS = 60_000;
export const MAIL_FIRST_SCAN_RETRY_MAX_MS = 3_600_000;

export const pickPrimaryFolder = (folderOrLabel: string, labels: string[] = []): string => {
  // Gmail: the first label in a deterministic priority order so
  // searches like `folder = 'INBOX'` behave predictably across
  // providers. `folder_or_label` is the provider's pick; fall back
  // to the labels list if the provider handed us empty.
  if (folderOrLabel) return folderOrLabel;
  const priority = ['INBOX', 'IMPORTANT', 'STARRED', 'SENT', 'DRAFT'];
  for (const p of priority) {
    if (labels.includes(p)) return p;
  }
  return labels[0] ?? '';
};

/** A message with the labels and folder its row holds now — a verified
 *  mutation while its attachments were fetched changed them there (D-315: the
 *  upsert hook reads them). */
const withRowLabels = (msg: CanonicalMessage, row: CollectionRecord): CanonicalMessage => {
  const labels = row.hot_fields.labels;
  const folder = row.hot_fields.folder;
  return {
    ...msg,
    ...(Array.isArray(labels)
      ? { labels: labels.filter((label): label is string => typeof label === 'string') }
      : msg.labels !== undefined ? { labels: [] } : {}),
    folder_or_label: typeof folder === 'string' ? folder : msg.folder_or_label,
  };
};

const normalizeMailAddress = (value: string): string => value.trim().toLowerCase();

/** Resolve only from strong evidence. Provider outbound/draft evidence and an
 * exact enrolled-account sender exclude self-originated mail; provider inbound
 * evidence then wins. Recipient matching covers moved/custom folders without
 * guessing that every non-Sent display name is inbound. */
export const resolveMailMessageDirection = (
  msg: CanonicalMessage,
  accountEmail = '',
): MailMessageDirection => {
  switch (msg.direction) {
    case 'outbound':
    case 'draft':
      return msg.direction;
    default:
      break;
  }

  const account = normalizeMailAddress(accountEmail);
  const from = normalizeMailAddress(msg.from);
  if (account.length > 0 && from.length > 0 && from === account) return 'outbound';
  if (msg.direction === 'inbound') return 'inbound';
  if (account.length === 0) return 'unknown';

  const addressedToAccount = [...msg.to, ...msg.cc]
    .some((address) => normalizeMailAddress(address) === account);
  if (from.length > 0 && from !== account && addressedToAccount) return 'inbound';
  return 'unknown';
};

/** Compose the FTS-indexed text for a mail record — sender + recipients +
 *  subject + body — so a "mail from / about <person or term>" query matches
 *  the SENDER / SUBJECT, not just the body. The mail-table analog of the
 *  calendar table's composite attendee index; without it `mail.search`'s
 *  body-only FTS can't answer "emails from <person>" (the sender lives in
 *  a hot field, off the index). Exported so the bench warehouse seeder
 *  indexes seeded mail identically (no drift between seeded + synced rows). */
export const mailFtsText = (record: CollectionRecord): string => {
  const hot = record.hot_fields ?? {};
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.length > 0) parts.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) if (typeof x === 'string' && x.length > 0) parts.push(x);
    }
  };
  // ⛔⛔ SUBJECT AND BODY FIRST, ADDRESSES LAST — THE ORDER IS THE SNIPPET.
  // `snippet()` returns a TOKEN window centred on the match, and this blob used
  // to open with from/to/cc: `ops@sandhurst-bench.test` alone tokenises to four
  // terms, so the address lines ate 8 of the 15 available tokens and the window
  // closed BEFORE the sentence that answered the question.
  //
  // Measured against a live model: mail.search returned
  //   `ops@…\nme@…\nRenewal notice period\nWe agreed the renewal…`
  // — cut four tokens short of "is 83 days" — and the model reported, correctly
  // for what it was handed, "the full message content isn't visible in the
  // search results". Reordering surfaces the figure for every query that
  // previously missed it.
  //
  // ⚠ MATCHING AND RANKING ARE UNAFFECTED. FTS5 term matching is
  // position-independent and BM25 scores on frequency + document length, not
  // offset. The addresses are still indexed and still searchable; they simply
  // stop occupying the part of the window a reader needs.
  push(hot.subject);
  if (record.body_inline) parts.push(record.body_inline);
  push(hot.from);
  push(hot.to);
  push(hot.cc);
  return parts.join('\n');
};

/** D-124 — what changed between a message's stored row and the row it
 *  becomes: its hot fields by name, and `body` and `received_at`. Nothing,
 *  for a message listed again as it was — a restart's scan reads every stored
 *  message again, and that is no update. */
export const mailChangedFields = (prev: CollectionRecord, next: CollectionRecord): string[] => {
  const keys = [...new Set([...Object.keys(prev.hot_fields), ...Object.keys(next.hot_fields)])].sort();
  const changed = keys.filter((key) => !isDeepStrictEqual(prev.hot_fields[key], next.hot_fields[key]));
  if ((prev.body_inline ?? null) !== (next.body_inline ?? null) || (prev.blob_hash ?? null) !== (next.blob_hash ?? null)) {
    changed.push('body');
  }
  if (prev.received_at !== next.received_at) changed.push('received_at');
  return changed;
};

/** Exported for unit testing (mirrors `mailFtsText`) — maps a
 *  `CanonicalMessage` to its stored `CollectionRecord` + body byte count,
 *  including the D-184 normalized `rfc_message_id` hot field. */
export const buildRecord = (
  msg: CanonicalMessage,
  nowOf: () => number,
  accountEmail = '',
): { record: CollectionRecord; bodyBytes: number } => {
  const bodyText = msg.body_text ?? '';
  const bodyBytes = Buffer.byteLength(bodyText, 'utf8');
  const hotFields: Record<string, unknown> = {
    from: msg.from,
    to: msg.to,
    cc: msg.cc,
    subject: msg.subject,
    thread_id: msg.thread_id,
    folder: pickPrimaryFolder(msg.folder_or_label, msg.labels),
    direction: resolveMailMessageDirection(msg, accountEmail),
    is_read: msg.is_read,
    // D-239 — mirrored so `mail-flag` has a field to write and the next
    // sync has the same field to confirm. Both halves shipped together;
    // see `CanonicalMessage.is_flagged` for why a write-back to an
    // unmirrored field is worse than no write-back at all.
    is_flagged: msg.is_flagged,
    has_attachments: msg.has_attachments,
    message_id: msg.source_id,
  };
  if (msg.labels && msg.labels.length > 0) hotFields.labels = msg.labels;
  // D-184 Decision 2 — queryable RFC822 Message-ID for the engagement
  // resolver's live CRM-email ↔ data.mail twin join. Stored separately
  // from `message_id` (which is the provider-native source_id, consumed
  // by contact-backfill); only present when the provider exposed one.
  const rfcMessageId = normalizeRfcMessageId(msg.rfc_message_id);
  if (rfcMessageId !== undefined) hotFields.rfc_message_id = rfcMessageId;
  if (isMailReconciliationId(msg.reconciliation_id)) {
    hotFields.reconciliation_id = msg.reconciliation_id;
  }

  const record: CollectionRecord = {
    record_id: recordIdFor(msg.source_id),
    received_at: msg.received_at,
    modified_at: nowOf(),
    hot_fields: hotFields,
    size_bytes: bodyBytes,
    source_id: msg.source_id,
  };
  return { record, bodyBytes };
};

/** D-127 P1.6 — input shape for `MailCollection.send` (mirrors the
 *  `collection.mail.send` rpc body). */
export interface MailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body_text: string;
  body_html?: string;
  in_reply_to?: string;
  references?: string[];
  reply_to?: string;
  reconciliation_id?: string;
  /** D-172 P2 (Attachments-v2) — the attachments to send.
   *
   *  ⛔⛔ TWO SHAPES, AND THE SHAPE IS THE LIFECYCLE. A `data.file` record-id
   *  string names something the owner KEEPS — read, sent, never touched. A
   *  `TempFileRef` names bytes the caller produced IN THIS RUN purely in order
   *  to send them: read, sent, and reclaimed with the run scratch. Nothing
   *  durable is created for the second kind, so there is nothing to delete
   *  afterwards and NO destructive authority anywhere on this path.
   *
   *  🔑 WHY NOT `{ file, cleanup_after }`. A caller-set flag is authority on the
   *  wire: `file-list` takes a caller-supplied slug, so a recipe can enumerate
   *  the owner's whole `received` warehouse and would then be able to mark any
   *  file of theirs disposable — destroying it under THIS op's `write` risk tier
   *  rather than `destructive`'s `always` approval floor. A temp ref cannot be
   *  forged into that: the confinement means the caller can only ever name bytes
   *  it just produced.
   *
   *  The INPUT carries refs, NOT bytes: `MailCollection.send`
   *  resolves each through the Gateway-gated `file.read` (`handleFileRead`,
   *  the one audited byte-egress path — I-4) into an
   *  `OutgoingAttachment[]` before calling `provider.send`. Empty /
   *  absent => no attachments (the legacy text/html send). Resolution
   *  requires `fileReadDeps` to be wired on the collection; when a ref
   *  is present but `fileReadDeps` is absent the send throws
   *  `MAIL_SEND_ATTACHMENT_UNRESOLVABLE` rather than silently dropping
   *  the file (I-6). */
  attachments?: (string | TempFileRef)[];
  /** ⛔ THE RUN SCOPE FOR A TEMP ATTACHMENT, and the only authorization on one:
   *  `readConfinedTempFile` confines the read to the producing run's scratch
   *  root. Required only when `attachments` carries a `TempFileRef`; the kernel
   *  refuses such a send without it. */
  run_id?: string;
  /** D-127 follow-on — engine-supplied step identity threaded from the
   *  kernel `mail-send` ingredient via `ResolvedCall.stepMeta`. When
   *  populated, the `mail_send` audit row carries both fields so the
   *  activity feed can pivot from a flagged row back to the originating
   *  recipe + step. Direct callers (Settings → Connections probe, MCP
   *  agent, tests) leave both undefined and the audit detail simply
   *  omits the fields. */
  recipe_id?: string;
  step_id?: string;
  /** D-210 audit finding 3b — suppress the recipient list in the `mail_send`
   *  audit detail, whatever the count.
   *
   *  The threshold logic (`recipient_count <= MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD`)
   *  is about FEED NOISE — a 200-recipient blast is unreadable, so it collapses
   *  to a count. It was never a PII decision, and a one-recipient send always
   *  lands on the attach branch.
   *
   *  That is wrong for a caller whose recipient is SEALED visitor PII the
   *  substrate promises never to surface. `notify-booking-visitor` opens the
   *  address from `reception_form_submission`, and its kernel manifest tells the
   *  model the address "is never surfaced in any branch" — but the send wrote it
   *  verbatim into a durable, backup-travelling `audit_activities.detail`.
   *
   *  Set by the caller that KNOWS its recipient is sealed, because only that
   *  caller does. `recipient_count`, subject and message-id are unaffected: the
   *  owner still sees that a notice went out, to how many, and can match it to a
   *  run — they just do not get a plaintext copy of a field the seal exists to
   *  hold. ⇒ [[provenance_that_lies_is_worse_than_absent]] */
  redact_audit_recipients?: boolean;
}

/** D-127 P1.6 — wire-shape return for `MailCollection.send`. Mirrors
 *  the spec § A.2 contract: provider-side ids + canonical-record
 *  fields (`_id` / `_collection`). `_id` is null when the Sent
 *  record hasn't been ingested yet — recipes that need the warehouse
 *  id can poll `data.mail.<slug>.<message_id>` afterwards. */
export interface MailSendResult {
  source_id: string;
  message_id: string;
  sent_at: number;
  thread_id?: string;
  warnings?: Array<{ code: string; message: string }>;
  /** Canonical record id of the sent message in the warehouse, or
   *  null when the inbound delta hasn't picked it up yet. */
  _id: string | null;
  _collection: 'data.mail';
  /** D-207 slice 3d — TRUE when a `reconciliation_id` was supplied and its claim was
   *  already settled as `reconciled` by provider source truth. Nothing was dispatched:
   *  the message is PROVEN to have gone out, and re-sending it is the one thing this
   *  substrate exists to prevent. A `reconciliation_id` therefore makes `mail-send`
   *  idempotent — which is the general property every recipe that sends mail wants. */
  already_sent?: boolean;
}

/** The provider's `OutgoingAttachment` plus the content hash we already read at
 *  resolve time. The hash is for the CLAIM (the byte-proof the reconciler will ask
 *  the provider to match); the provider itself has no use for it, so it is stripped
 *  before dispatch rather than widening the wire shape. */
/** `blob_hash` is the content sha256 — for a record it comes off the CAS read,
 *  for a run-scoped temp ref it is computed over the same bytes, so the D-207
 *  claim proof and the audit row are identical either way. `run_scoped` marks
 *  WHICH carrier it came from, so the audit can say so; absent means a record. */
type ResolvedAttachment = OutgoingAttachment & { blob_hash: string; run_scoped?: boolean };

/** D-127 P1.6 — `MailCollection` extends `Collection` with the
 *  mail-specific surface. The rpc handler runtime-checks the
 *  presence of `send` to narrow from the generic registry's
 *  `Collection` type. `sendCapable` and `accountEmail` mirror the
 *  underlying provider's fields so the picker / sender-resolution
 *  paths can read them without reaching through the provider. */
export interface MailCollection extends Collection {
  /** Records adjacent in time to an anchor — the reply direction (`next`) or
   *  the context direction (`prev`).
   *
   *  ⛔ DECLARED HERE, NOT ONLY ON `CollectionTable`. The chat handler iterates
   *  `registry.list()`, which yields these wrappers; a method that exists only
   *  on the table is invisible to it and the call silently returns nothing.
   *  Measured: the model asked for `near_id` correctly and got an empty result,
   *  then reported the PROPOSAL as the settled outcome. */
  neighbours(query: { anchor_id: string; next?: number; prev?: number }): CollectionRecord[];

  readonly platform: 'mail';
  readonly sendCapable: boolean;
  /** D-239 — mirrors `MailProvider.mutationCapable` so the dispatcher's
   *  capability gate reads it without reaching through the provider, the
   *  same way `sendCapable` is surfaced for the sender picker. */
  readonly mutationCapable: boolean;
  /** D-264 — mirrors `MailProvider.draftCapable` for the same reason, and
   *  narrowed to a plain boolean here: the provider field is optional so an
   *  out-of-tree adapter keeps compiling, but every consumer of a live
   *  collection should read a definite answer, not `undefined`. */
  readonly draftCapable: boolean;
  /** D-264 — park a message in the mailbox's Drafts folder.
   *
   *  ⛔ NOT a send, and never becomes one. The gate is `draftCapable`, the
   *  audit action is `mail_draft_saved_to_mailbox`, and there is no self-loop guard
   *  because nothing is delivered: a draft addressed to yourself is a note to
   *  yourself, which is a legitimate thing to park. */
  saveDraft(args: {
    to: string[]; cc?: string[]; bcc?: string[];
    subject: string; body_text: string; body_html?: string;
    in_reply_to?: string; references?: string[]; reply_to?: string;
    prior_source_id?: string;
    recipe_id?: string; step_id?: string;
  }): Promise<SavedDraftMeta>;
  readonly accountEmail: string;
  /** D-239 — the live provider, for the dispatcher's verified-then-
   *  reflected write path. Exposed rather than proxying all four verbs
   *  through this interface: the dispatcher already owns the gate /
   *  error-translation / reflect sequencing (mirroring
   *  `CalendarCollection.provider`), and a second set of pass-throughs
   *  here would be four more places for the two to drift. */
  readonly provider: MailProvider;
  /** D-239 — fold a provider-verified mutation into the warehouse row.
   *  `null` when the row is gone. See the implementation for why the body
   *  blob is never rewritten and `direction` is never recomputed. */
  applyVerifiedMutation(
    record_id: string,
    result: MailMutationResult,
  ): CollectionRecord | null;
  send(args: MailSendInput): Promise<MailSendResult>;
  /** Server-internal D-200 source-truth lookup. It is intentionally absent
   * from the generic collection rpc surface; only a source-checked workflow
   * transition may consume its result. */
  lookupSentByReconciliationId(
    query: MailSentReconciliationQuery,
  ): Promise<MailSentReconciliationResult>;
  /** D-164 P7 — precise count of mail records whose SENDER (`from`) is
   *  `email`, compared case-insensitively. Backs the prompt-cache "how many
   *  emails from `<Name>`?" short-circuit (the gate's mail-count lookup sums
   *  this across every registered mail collection). Delegates to the table's
   *  exact `COUNT(*)` (`countByAddress('from', …)`) — `from` is stored as a
   *  bare provider-normalised address, so the count is precise + exact
   *  regardless of mailbox size. READ-ONLY. */
  countFrom(email: string): number;
  /** Whether a file named by this email's id alone — the legacy attachment
   *  source id (`mail-attachment-source-id.ts`) — may hold another mailbox's
   *  attachment: this mailbox is IMAP and another mailbox's table holds a row
   *  under the same id. False for Gmail and Graph: their ids are the
   *  provider's own, so one held twice is one message enrolled twice. */
  legacyAttachmentsAmbiguous(record_id: string): boolean;
}

/** D-127 P1.6 — extract the bare email from an RFC 5322 mailbox
 *  string. `"Alice <alice@example.com>"` → `"alice@example.com"`,
 *  `"alice@example.com"` → `"alice@example.com"`. Lower-cases the
 *  result so the self-loop guard is case-insensitive (most servers
 *  treat the local part case-sensitively per RFC 5321 §2.4 but
 *  recipients in the wild are routinely supplied with mixed case
 *  for the same address — strict matching here would surface false
 *  negatives for the most common configuration mistake the guard
 *  exists to catch). */
const extractAddress = (mailbox: string): string => {
  const m = mailbox.match(/<([^>]+@[^>]+)>/);
  return (m ? m[1] : mailbox).trim().toLowerCase();
};

/** D-127 P1.7 — list of recipients to consider for audit-row inclusion.
 *  Combines `to + cc + bcc`, drops duplicates (case-insensitive) and
 *  the sender's own address (cc-self / bcc-self archival pattern is
 *  noise in the audit feed — the row already records the sender via
 *  `target`). Caller checks the resulting length against
 *  `MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD` to decide whether
 *  to attach the list or fall back to count-only. */
const dedupedRecipientsForAudit = (
  args: { to: string[]; cc?: string[]; bcc?: string[] },
  senderEmail: string,
): string[] => {
  const sender = senderEmail.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [args.to, args.cc ?? [], args.bcc ?? []]) {
    for (const r of list) {
      const key = extractAddress(r);
      if (key === sender) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
};

export const createMailCollection = (
  opts: CreateMailCollectionOptions,
): MailCollection => {
  const { db, blobs, gate, bus, slug, provider, log } = opts;
  const nowOf = (): number => opts.now?.() ?? Date.now();

  /** D-207 slice 3d — the no-resend fence. Shares the collection's own `db`, so no
   *  new injection: the claim and the send must live or die together, and a claim
   *  written to a different database than the one the send is recorded in is a fence
   *  that can silently be absent. */
  const claims = createMailSendClaimStore(db);

  const table: CollectionTable = createCollectionTable({
    db,
    platform: 'mail',
    slug,
    onBytesChanged: (delta) => { gate.addUsed(delta); },
    ftsTextFor: mailFtsText,
  });
  // ⛔ THE ONE COLLECTION THAT COUNTS BY ADDRESS. `countFrom` backs the chat
  // short-circuit for "how many emails from <Name>?", which answers WITHOUT an
  // LLM call — so it is on a user-visible latency path, over a collection
  // D-230 sized to 2 GB. Without this index the count scans the whole mailbox
  // every time; the query's JSON path was a BIND, which made an index
  // impossible until `countByAddress` was specialised per field.
  table.ensureAddressIndex('from');
  // The mail-twin join (`createMailTwinResolver` → `findByHotFieldIn`) looks up
  // by Message-ID with NO limit. Exact-match index, because Message-IDs are
  // case-sensitive and must not fold.
  table.ensureHotFieldIndex(MAIL_RFC_MESSAGE_ID_HOT_FIELD);

  const legacyAttachmentsAmbiguous = (record_id: string): boolean =>
    provider.kind === 'imap' && mailRecordIdHeldByAnotherMailbox(db, table.tableName, record_id);

  const emitter = createCollectionEmitter({
    bus,
    platform: 'mail',
    slug,
    entityType: 'message',
    now: () => nowOf(),
  });

  const retention: CollectionRetention = createCollectionRetention({
    table,
    platform: 'mail',
    slug,
    auditLog: opts.auditLog,
    now: () => nowOf(),
    config: () => ({ retentionDays: opts.config().retention_days }),
    onPruned: (record_ids) => notifyRemoved(record_ids),
  });

  let state: CollectionState = 'idle';
  let lastIndexedAt = 0;
  /** D-315 — where the row each upsert still in flight wrote lives now: a
   *  verified move gives an email a new id while its attachments download,
   *  and the upsert's hook reads it there. */
  const upserting = new Map<symbol, string>();
  let localErrorCount = 0;
  let stopSync: (() => Promise<void>) | undefined;
  /** Unsubscribe for the provider's per-attempt outcome stream. */
  let stopOutcomes: (() => void) | undefined;
  let startInFlight: Promise<void> | null = null;
  let syncGeneration = 0;
  let closed = false;
  /** A first backfill that failed is tried again later (see `retryFirstScan`). */
  let scanRetry: ReturnType<typeof setTimeout> | null = null;
  /** The provider's word on its last failed attempt: `'auth'` when the
   *  credential was refused. */
  let lastProviderFailure: MailSyncFailureKind | undefined;
  let scanRetryMs = opts.firstScanRetryMs ?? MAIL_FIRST_SCAN_RETRY_MS;
  const clearScanRetry = (): void => {
    if (scanRetry !== null) {
      clearTimeout(scanRetry);
      scanRetry = null;
    }
  };

  const bumpError = (msg: string, err: unknown): void => {
    localErrorCount++;
    log?.('warn', msg, { err: err instanceof Error ? err.message : String(err) });
  };

  // ────────────────────────────────────────────────────────────────
  // Durable sync-outcome reporting
  //
  // Mail had NO writer for `auth_state` / `last_synced_at` at all. Enroll
  // stamped `auth_state: 'healthy'` optimistically — before any fetch had
  // happened — and nothing ever revised it, so an instance that ingested zero
  // messages (sealed vault, dead refresh token, wrong scope) reported healthy
  // with no last-synced time for as long as it existed. There was no way, from
  // the rpc surface, to tell a working mailbox from a broken one. `file`
  // already reports through this same narrow store write (`file/compose.ts`,
  // `file/enroll.ts`); this is mail's missing half.
  //
  // ⚠ REPORTING ONLY, and that is load-bearing. `file` / `calendar` derive
  // effective caps as `caps AND auth_state === 'healthy'`, so a non-healthy
  // value there DISABLES writes. Mail has no such caps/dispatcher gate today,
  // which is why it is safe to report honestly here. If mail ever gains one,
  // re-check this: a sealed-vault instance must NOT lose `send` (the vault-
  // deferred path in `compose.ts` explicitly keeps `send` working while
  // sealed), which is why "deferred, never synced" is represented by a NULL
  // `last_synced_at` rather than by a non-healthy `auth_state`.
  const reportSyncOutcome = (
    auth_state: CollectionAuthState,
    last_synced_at?: number,
  ): void => {
    try {
      opts.instances?.updateAuthState('mail', slug, {
        auth_state,
        ...(last_synced_at !== undefined ? { last_synced_at } : {}),
      });
    } catch (err) {
      // A reporting write must never break a sync that otherwise worked.
      bumpError('mail updateAuthState failed', err);
    }
  };

  /** An expired credential and a flaky network need DIFFERENT things from the
   *  user — a re-consent versus patience — so they must not collapse into one
   *  state. Connections renders `'expired'` as "Needs re-auth", so mislabelling
   *  a 429 sends the user to re-consent for nothing.
   *
   *  ⚠ `err instanceof OAuthError` is NOT the discriminant, even though the name
   *  suggests it. `refreshAccessToken` wraps EVERY non-2xx from the token
   *  endpoint — 429 and 5xx included — in an `OAuthError` (`oauth.ts`: `if
   *  (!res.ok) throw new OAuthError('token_refresh_failed', res.status, …)`).
   *  The type only says "this came from the OAuth layer"; the STATUS says what
   *  happened. Same thresholds as `classifyHttpError` in `@recued/transport`
   *  (401/403 → auth, 429 → rate-limited, 5xx → server), remapped onto
   *  `CollectionAuthState` rather than importing a transport-shaped enum.
   *
   *  ⛔ This is the FALLBACK path, for a provider that does not implement
   *  `onSyncOutcome` (older fakes, out-of-tree providers). When one does — all
   *  three shipped providers do — its own typed outcome wins, because only the
   *  provider can tell an IMAP `AUTHENTICATIONFAILED` from a socket reset, or a
   *  token-endpoint 400 (`invalid_grant`) from an API 400 (bad request). */
  const classifySyncFailure = (err: unknown): CollectionAuthState => {
    if (!(err instanceof OAuthError)) return 'degraded';
    // No stored refresh token — there is no credential to retry with.
    if (err.code === 'missing_refresh_token') return 'expired';
    // Classified on the token endpoint's own `error` field, not the status —
    // RFC 6749 § 5.2 answers five different problems with HTTP 400 and only
    // `invalid_grant` is fixed by re-consenting. Shared with the providers via
    // `classifyOAuthFailure` so the two cannot drift; mapping onto
    // `CollectionAuthState` is this layer's job.
    return classifyOAuthFailure(err.status, err.oauth_error) === 'auth'
      ? 'expired'
      : 'degraded';
  };

  /** Map a provider's typed per-attempt outcome onto the durable row.
   *
   *  This is what closes the swallowed-tick gap: a scheduled poll that fails
   *  after startup now DOWNGRADES the row (a token revoked mid-life surfaces as
   *  "needs re-auth" instead of a mailbox that silently stops), and a poll that
   *  succeeds while finding NOTHING still advances the clock (a quiet mailbox no
   *  longer looks stale). Both run through the same throttle as message ingest,
   *  so a 30 s poll loop costs at most one row write a minute. */
  const onProviderOutcome = (outcome: MailSyncOutcome): void => {
    if (outcome.ok) {
      lastProviderFailure = undefined;
      touchSyncClock(outcome.at);
      return;
    }
    lastProviderFailure = outcome.failure;
    // A failure is reported immediately, un-throttled: the throttle exists to
    // bound redundant SUCCESS writes, and delaying bad news is the opposite of
    // the point. `reportSyncOutcome` is idempotent on an unchanged row.
    reportSyncOutcome(outcome.failure === 'auth' ? 'expired' : 'degraded');
  };

  /** Minimum gap between two `last_synced_at` writes driven by successful sync
   *  evidence. One row write per backfilled message — or per 30 s poll — would be
   *  thousands of redundant writes for no added truth; a minute's granularity is
   *  far finer than any surface that renders this ("synced 2 minutes ago"). */
  const SYNC_CLOCK_WRITE_INTERVAL_MS = 60_000;
  let lastSyncClockWriteAt = 0;

  /** Advance the durable sync clock, at most once per interval. Reports
   *  `'healthy'` alongside it: evidence that a fetch worked — a message landing,
   *  or a provider reporting a clean poll — means a stale `'expired'` from an
   *  earlier failed attempt must not outlive the recovery.
   *
   *  `at` lets a provider outcome stamp its own attempt time; message ingest
   *  passes nothing and takes the current clock. */
  const touchSyncClock = (at?: number): void => {
    const now = at ?? nowOf();
    if (now - lastSyncClockWriteAt < SYNC_CLOCK_WRITE_INTERVAL_MS) return;
    lastSyncClockWriteAt = now;
    reportSyncOutcome('healthy', now);
  };

  /** The email's attachment links to files. `[]` where no link store is wired:
   *  every part is then named with the mailbox, the name that is always right. */
  const attachmentLinksOf = async (deps: MailInboundAttachmentDeps, mailRecordId: string): Promise<Link[]> => {
    const store = deps.attachDeps.annotationDeps?.store;
    if (!store) return [];
    return (await store.outboundLinks('mail', mailRecordId))
      .filter((link) => link.role === 'attachment' && link.to_collection === 'file');
  };

  const attachmentFileStored = (deps: MailInboundAttachmentDeps, file_id: string): boolean => {
    try {
      const files = deps.attachDeps.registry?.get('file', deps.attachDeps.fileSlug ?? DATA_FILE_RECEIVED_SLUG);
      return files !== undefined && files.get(file_id) !== null;
    } catch {
      return false;
    }
  };

  /** Returns the attachments it materialized, for the upsert hook (D-315).
   *  `existed`: the email's row was here before this upsert. */
  const materializeInboundAttachments = async (
    msg: CanonicalMessage,
    mailRecordId: string,
    existed: boolean,
    shouldContinue: () => boolean,
  ): Promise<MailUpsertAttachment[]> => {
    const materialized: MailUpsertAttachment[] = [];
    const attachments = msg.attachments ?? [];
    if (attachments.length === 0) return materialized;

    const deps = opts.inboundAttachmentDeps?.();
    if (!deps) {
      bumpError(
        `mail attachment ingest skipped for ${msg.source_id}: inbound attachment deps not wired`,
        new Error('mail_attachment_deps_not_configured'),
      );
      return materialized;
    }

    // ⛔ An IMAP id is `uid@folder`, which another IMAP account holds too: named
    // by the id alone, both accounts' attachments were ONE file, each re-ingest
    // overwriting the other's. An IMAP part is named with this mailbox, except
    // where the legacy name is unambiguous and already in use — no other
    // mailbox holds the id, and its file is stored and linked — so an upgrade
    // renames no single-account file (`mail-attachment-source-id.ts`).
    const imap = provider.kind === 'imap';
    let shared = false;
    let links: Link[] = [];
    if (imap) {
      try {
        shared = legacyAttachmentsAmbiguous(mailRecordId);
        links = await attachmentLinksOf(deps, mailRecordId);
      } catch (err) {
        bumpError(`mail attachment links unreadable for ${msg.source_id}`, err);
      }
      if (!shouldContinue()) return materialized;
    }

    for (const [idx, part] of attachments.entries()) {
      if (!shouldContinue()) return materialized;
      const sourcePartId = part.source_part_id || `part-${idx}`;
      try {
        const bytes = await part.fetchBytes();
        if (!shouldContinue()) return materialized;
        const mimeType = detectMailAttachmentMimeType(bytes, part.mime_type);
        const legacySourceId = legacyMailAttachmentSourceId(mailRecordId, sourcePartId);
        const legacyFileId = mailAttachmentFileId(legacySourceId);
        const legacyLinks = links.filter((link) => link.to_id === legacyFileId);
        const keepLegacy = !imap
          || (!shared && legacyLinks.length > 0 && attachmentFileStored(deps, legacyFileId));
        const fileRecord = await deps.fileIngestor.ingest({
          bytes,
          filename: part.filename,
          mime_type: mimeType,
          origin: 'mail_attachment',
          source_id: keepLegacy ? legacySourceId : scopedMailAttachmentSourceId(slug, mailRecordId, sourcePartId),
          // D-124 — an old email's attachment, stored by the mailbox's first
          // scan, is past mail's: it starts no received-file trigger. Nor does
          // an attachment already stored under its legacy name and now renamed
          // with its mailbox: a trigger saw that file, and would run twice.
          // ⚠ An attachment first stored late — its email landed, the fetch
          // failed — still tells the trigger: no trigger has seen it yet.
          ...(!backfillComplete() || (existed && !keepLegacy && attachmentFileStored(deps, legacyFileId))
            ? { in_drain: true } : {}),
          now: nowOf(),
        });
        if (!shouldContinue()) return materialized;
        await deps.attach(
          {
            file_id: fileRecord.record_id,
            to_collection: 'mail',
            to_id: mailRecordId,
            ...(deps.authored_by ? { authored_by: deps.authored_by } : {}),
          },
          deps.attachDeps,
        );
        materialized.push({ file_id: fileRecord.record_id, filename: part.filename, mime_type: mimeType });
        // The mailbox's own file now stands for this part: the legacy link
        // goes, the legacy FILE stays — other stores may still name it.
        if (!keepLegacy && legacyLinks.length > 0) {
          try {
            for (const link of legacyLinks) await deps.attachDeps.annotationDeps.store.deleteLink(link._id);
          } catch (err) {
            bumpError(`mail legacy attachment link removal failed for ${msg.source_id}:${sourcePartId}`, err);
          }
        }
      } catch (err) {
        bumpError(`mail attachment ingest failed for ${msg.source_id}:${sourcePartId}`, err);
      }
    }
    return materialized;
  };

  /** D-315 — tell the derivation hooks which rows went. */
  const notifyRemoved = (record_ids: readonly string[]): void => {
    if (!opts.onRecordsRemoved || record_ids.length === 0) return;
    try { opts.onRecordsRemoved(slug, record_ids); }
    catch (err) { bumpError(`mail onRecordsRemoved hook failed for ${record_ids.length} record(s)`, err); }
  };

  /** Read on every first sighting rather than cached: `markBackfillComplete`
   *  flips it once, mid-life, and a cached `false` would keep every later
   *  message silent until a restart. */
  const backfillComplete = (): boolean => {
    try { return opts.instances?.get('mail', slug)?.backfill_complete === true; }
    catch (err) {
      bumpError('mail backfill state read failed', err);
      return false;
    }
  };

  const upsertMessage = async (
    msg: CanonicalMessage,
    shouldContinue: () => boolean,
  ): Promise<void> => {
    const { record, bodyBytes } = buildRecord(msg, nowOf, provider.accountEmail);
    const assertActive = (): void => {
      if (!shouldContinue()) {
        throw new Error('mail sync generation is no longer active');
      }
    };
    try {
      assertActive();
      if (bodyBytes <= INLINE_CUTOFF_BYTES) {
        record.body_inline = msg.body_text ?? '';
      } else {
        record.blob_hash = await blobs.put(Buffer.from(msg.body_text, 'utf8'));
      }
      // The generation can change while durable blob I/O is in flight. A
      // resolved stale callback would let the provider move its replay cursor
      // past a row this generation never committed.
      assertActive();
      const prev = table.upsert(record);
      const moving = Symbol(record.record_id);
      upserting.set(moving, record.record_id);
      try {
        if (prev) {
          // Only a change is an update, named by what changed: a restart's scan
          // reads every stored message again, and each would otherwise wake
          // every `updated` trigger and re-run the enrichment cascade.
          const changed = mailChangedFields(prev, record);
          if (changed.length > 0) emitter.updated(record.record_id, prev.hot_fields, changed);
        } else emitter.created(record.record_id);
        // D-315 — news is news from the moment the row lands: the upsert hook
        // runs after the attachments' awaits, and a stop in between would make a
        // replay see the row as old.
        if (!prev && opts.onMessageStored) {
          try {
            opts.onMessageStored(msg, {
              slug,
              record_id: record.record_id,
              backfill_complete: backfillComplete(),
              backfill_days: opts.config().backfill_days,
              retention_days: opts.config().retention_days,
            });
          } catch (err) { bumpError(`mail onMessageStored hook failed for ${msg.source_id}`, err); }
        }
        lastIndexedAt = record.modified_at;
        // A message landing is the strongest possible proof that this mailbox is
        // syncing, so it is the honest anchor for `last_synced_at`. Writing the
        // clock ONLY at sync-lifecycle transitions would leave it frozen at boot
        // time while a healthy 30 s poll loop kept working — "last synced 6 h
        // ago" on a mailbox that is fine, which is a fresh lie in place of the
        // old one. Throttled, because this runs once per ingested message and a
        // 30-day backfill is thousands of them.
        touchSyncClock();
        const attachments = await materializeInboundAttachments(msg, record.record_id, prev !== null, shouldContinue);
        // The row may already be durable here; rejecting still matters because a
        // provider that outlived stop must not persist a newer checkpoint. Replay
        // is idempotent and will converge attachments/hooks under the next owner.
        assertActive();
        // D-315 — deleted while its attachments were fetched: what the hook
        // derives (a fact, a contact) must not outlive the row it came from.
        // Moved, it is read where it is now: its old id is no row, and a folder
        // no sync reads would never bring it back.
        const recordId = upserting.get(moving) ?? record.record_id;
        const current = table.get(recordId);
        if (opts.onMessageUpserted && current !== null) {
          try {
            const firstSeen = !prev;
            // Relabelled or filed elsewhere meanwhile (a verified mutation), it
            // is read as its row holds it: a template may test a label.
            opts.onMessageUpserted(withRowLabels(msg, current), {
              slug,
              record_id: recordId,
              account_email: provider.accountEmail,
              first_seen: firstSeen,
              // Only a first sighting asks: nothing reads it otherwise.
              backfill_complete: firstSeen ? backfillComplete() : true,
              backfill_days: opts.config().backfill_days,
              retention_days: opts.config().retention_days,
              attachments,
            });
          } catch (err) { bumpError(`mail onMessageUpserted hook failed for ${msg.source_id}`, err); }
        }
      } finally {
        upserting.delete(moving);
      }
    } catch (err) {
      bumpError(`mail ingest failed for ${msg.source_id}`, err);
      // The provider owns the replay checkpoint. Resolving this callback would
      // acknowledge an event that never became durable, allowing Gmail's
      // historyId / Graph's deltaLink to move past it permanently. Preserve the
      // local diagnostic, then reject so the provider can hold and replay its
      // cursor. Optional derivation hooks remain best-effort above because the
      // canonical mail row has already landed before they run.
      throw err;
    }
  };

  const onSyncEvent = async (
    event: ProviderSyncEvent,
    shouldContinue: () => boolean,
  ): Promise<void> => {
    if (!shouldContinue()) {
      throw new Error('mail sync generation is no longer active');
    }
    if (event.kind === 'deleted') {
      const recordId = recordIdFor(event.source_id);
      const prev = table.delete(recordId);
      if (prev) {
        emitter.deleted(recordId, prev.hot_fields);
        notifyRemoved([recordId]);
      }
      return;
    }
    if (!event.message) {
      bumpError(`sync event ${event.kind} missing message`, null);
      throw new Error(`mail sync event '${event.source_id}' is missing its message payload`);
    }
    await upsertMessage(event.message, shouldContinue);
  };

  /** D-239 — reflect a provider-VERIFIED mutation into the warehouse row.
   *
   *  Called only after the adapter returned a complete post-mutation state
   *  (never on `io_error` — see `MailAdapterError`). Folds that state into
   *  the existing row's hot fields by read-modify-upsert, which is what
   *  keeps this cheap: `body_inline` / `blob_hash` / `size_bytes` /
   *  `received_at` are carried through UNTOUCHED, so marking a 4 MB
   *  message read does not rewrite its CAS blob.
   *
   *  Returns the updated record, or `null` when the row is no longer here
   *  — a concurrent retention pass or provider-side delete can remove it
   *  while the mutation is in flight, and re-creating it from a state
   *  fragment would resurrect a row with no body.
   *
   *  ⚠ `direction` is deliberately NOT recomputed on a folder change. It
   *  derives from the folder AND the enrolled account address
   *  (`resolveMailMessageDirection`), and a mutation result is not a
   *  `CanonicalMessage` — recomputing it from the fragment would mean
   *  guessing. Moving a message into Sent leaves `direction` stale until
   *  that folder's next sync, which is the same "let the tick reconcile"
   *  posture the rest of this path takes. */
  const applyVerifiedMutation = (
    record_id: string,
    result: MailMutationResult,
  ): CollectionRecord | null => {
    const prev = table.get(record_id);
    if (!prev) return null;

    const hot_fields: Record<string, unknown> = {
      ...prev.hot_fields,
      is_read: result.is_read,
      is_flagged: result.is_flagged,
      // Same fold the read path uses, so a mutated row's `folder` is
      // directly comparable with a synced one rather than being a second
      // dialect of the same field.
      folder: pickPrimaryFolder(result.folder_or_label, result.labels),
      message_id: result.source_id,
    };
    if (result.labels !== undefined) {
      // Mirrors `buildRecord`: the key is PRESENT only when non-empty.
      // Assigning `[]` instead of deleting would leave a row whose shape
      // differs from every synced row, and `labels` is a filterable hot
      // field — a stale empty array is a query result nobody expects.
      if (result.labels.length > 0) hot_fields.labels = result.labels;
      else delete hot_fields.labels;
    }

    const nextRecordId = recordIdFor(result.source_id);
    const next: CollectionRecord = {
      ...prev,
      record_id: nextRecordId,
      source_id: result.source_id,
      hot_fields,
      modified_at: nowOf(),
    };

    // ⛔ UPSERT BEFORE DELETE on a re-key (IMAP / Graph mint a new id on
    // move). Both rows point at the SAME CAS blob, and deleting the old
    // one first would leave that blob momentarily unreferenced — a window
    // an orphan sweep running concurrently could collect, taking the body
    // of a message that still exists. Byte accounting nets to zero either
    // way; the ordering is purely about never dropping the last reference.
    table.upsert(next);
    if (nextRecordId !== record_id) {
      table.delete(record_id);
      // An upsert still writing it follows it (D-315).
      for (const [moving, id] of upserting) if (id === record_id) upserting.set(moving, nextRecordId);
      if (opts.onRecordRekeyed) {
        try { opts.onRecordRekeyed(slug, record_id, nextRecordId); }
        catch (err) { bumpError(`mail onRecordRekeyed hook failed for ${record_id}`, err); }
      }
    }

    // A mutation that changed nothing (marking a read message read) is no
    // update. A move to a new id is: it changes the id's `message_id`.
    const changed = mailChangedFields(prev, next);
    if (changed.length > 0) emitter.updated(nextRecordId, prev.hot_fields, changed);
    lastIndexedAt = next.modified_at;
    return next;
  };

  const isCurrentGeneration = (generation: number): boolean =>
    !closed && syncGeneration === generation;

  /** D-124 / D-315 §5 — a mailbox whose first backfill never finished treats
   *  every message as found by it, so nothing it receives is new and no
   *  trigger fires until a restart's scan succeeds. The live loop still runs;
   *  the scan is tried again by starting over — stop, then start, so it never
   *  runs beside the live loop — waiting twice as long each time, up to an
   *  hour. A stop in between cancels it: the next start scans anyway. */
  /** A refused credential is not tried again on a timer: repeated failed
   *  sign-ins can lock an account, and signing in again starts a scan. */
  const credentialRefused = (err: unknown): boolean =>
    classifySyncFailure(err) === 'expired' || lastProviderFailure === 'auth';

  const retryFirstScan = (generation: number): void => {
    clearScanRetry();
    const delay = scanRetryMs;
    scanRetryMs = Math.min(scanRetryMs * 2, MAIL_FIRST_SCAN_RETRY_MAX_MS);
    scanRetry = setTimeout(() => {
      scanRetry = null;
      if (!isCurrentGeneration(generation)) return;
      void sync.stop()
        .then(() => sync.start())
        .catch((err: unknown) => {
          bumpError('mail first backfill retry failed', err);
          if (!closed && !backfillComplete() && !credentialRefused(err)) retryFirstScan(syncGeneration);
        });
    }, delay);
    scanRetry.unref?.();
  };

  /** Durable state reporting spans the whole sync lifetime, not just the start
   *  call. Generation checks make that reporting part of the owned lifecycle:
   *  an outcome or scan result arriving after stop cannot write SQLite. */
  const runSyncStart = async (generation: number): Promise<void> => {
    const shouldContinue = (): boolean => isCurrentGeneration(generation);
    state = 'syncing';
    // Subscribe BEFORE connect so the first attempt is observed. Drop any prior
    // subscription so a stop→start cycle never multiplies reporting writes.
    if (stopOutcomes) {
      try { stopOutcomes(); }
      catch (err) { bumpError('mail sync outcome detach failed', err); }
      stopOutcomes = undefined;
    }
    try {
      stopOutcomes = provider.onSyncOutcome?.((outcome) => {
        if (shouldContinue()) onProviderOutcome(outcome);
      });
    } catch (err) {
      // Outcome reporting is observability, not a prerequisite for fetching.
      // A broken optional subscriber must not strand an otherwise usable inbox.
      bumpError('mail sync outcome subscribe failed', err);
    }
    try {
      await provider.connect();
    } catch (err) {
      if (!shouldContinue()) return;
      state = 'error';
      bumpError('mail provider connect failed', err);
      // Report BEFORE rethrowing. `startLive` catches this and only logs, so
      // this write is the sole durable trace the caller ever sees.
      reportSyncOutcome(classifySyncFailure(err));
      throw err;
    }
    if (!shouldContinue()) return;

    // D-124 Phase 2.4 — record one sync-level `collection_backfill`
    // activity row at drain completion. Per-message failures are derived from
    // the local error-count delta because live ingest deliberately contains
    // individual malformed provider rows.
    const backfillRecorder = createBackfillAuditRecorder({
      auditLog: opts.auditLog,
      platform: 'mail',
      slug,
      now: nowOf,
      log,
    });
    try {
      await provider.initialScan({
        backfill_days: opts.config().backfill_days,
        onMessage: async (msg) => {
          if (!shouldContinue()) return false;
          try {
            await upsertMessage(msg, shouldContinue);
          } catch (err) {
            backfillRecorder.recordFailure();
            throw err;
          }
          if (!shouldContinue()) return false;
          backfillRecorder.recordImport(msg.received_at);
          return true;
        },
      });
      if (!shouldContinue()) return;
      // The provider cursor is now stable; this write is idempotent on restart.
      try { opts.instances?.markBackfillComplete('mail', slug); }
      catch (err) { bumpError('mail markBackfillComplete failed', err); }
      scanRetryMs = opts.firstScanRetryMs ?? MAIL_FIRST_SCAN_RETRY_MS;
      await backfillRecorder.finish();
    } catch (err) {
      if (!shouldContinue()) return;
      bumpError('mail initialScan failed', err);
      await backfillRecorder.finish('failed');
      reportSyncOutcome(classifySyncFailure(err));
      if (!backfillComplete() && !credentialRefused(err)) retryFirstScan(generation);
    }
    if (!shouldContinue()) return;

    try {
      const stop = await provider.startSync((event) =>
        onSyncEvent(event, shouldContinue));
      if (!shouldContinue()) {
        try { await stop(); } catch { /* stale start teardown */ }
        return;
      }
      stopSync = stop;
      state = 'connected';
      lastIndexedAt = nowOf();
      // Deliberately do not report healthy here: installing a listener is not
      // proof that an inbound fetch succeeded. Message/outcome evidence owns it.
    } catch (err) {
      if (!shouldContinue()) return;
      state = 'error';
      bumpError('mail startSync failed', err);
      reportSyncOutcome(classifySyncFailure(err));
    }
  };

  const sync: CollectionSyncAdapter = {
    start() {
      if (closed || stopSync) return Promise.resolve();
      if (startInFlight) return startInFlight;
      const generation = syncGeneration;
      let active: Promise<void>;
      active = runSyncStart(generation).finally(() => {
        if (startInFlight === active) startInFlight = null;
      });
      startInFlight = active;
      return active;
    },
    async stop() {
      // Invalidate provider callbacks before any asynchronous teardown.
      syncGeneration += 1;
      clearScanRetry();
      state = 'disconnected';
      const activeStart = startInFlight;
      const stops: Promise<void>[] = [];
      const failures: unknown[] = [];
      if (stopOutcomes) {
        try { stopOutcomes(); }
        catch (err) {
          bumpError('mail sync outcome detach failed', err);
          failures.push(err);
        }
        stopOutcomes = undefined;
      }
      if (stopSync) {
        const stop = stopSync;
        stopSync = undefined;
        try {
          stops.push(Promise.resolve(stop()).catch((err) => {
            bumpError('mail stopSync failed', err);
            failures.push(err);
          }));
        } catch (err) {
          bumpError('mail stopSync failed', err);
          failures.push(err);
        }
      }
      const closeProvider = async (): Promise<void> => {
        try {
          await provider.close();
        } catch (err) {
          bumpError('mail provider close failed', err);
          failures.push(err);
        }
      };
      stops.push(closeProvider());
      if (activeStart) stops.push(activeStart.catch(() => undefined));
      await Promise.all(stops);
      // `close()` above is also the cancellation signal for a slow connect or
      // scan. If that operation races through after the first close, it may
      // have acquired fresh sockets; the provider contract is idempotent, so a
      // final close after the owned start settles seals that late-open window.
      if (activeStart) await closeProvider();
      if (failures.length > 0) {
        throw new AggregateError(failures, 'mail collection failed to stop');
      }
    },
  };

  const health = (): CollectionHealth => {
    // Fold provider-reported metrics in so operators see a single
    // snapshot. Provider errors + local errors sum because a delta
    // failure followed by a canonicalization failure both matter.
    let providerHealth = { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    try { providerHealth = provider.health(); } catch { /* provider bugs shouldn't crash health reads */ }
    return {
      platform: 'mail',
      slug,
      last_indexed_at: Math.max(lastIndexedAt, providerHealth.last_successful_sync_at),
      pending_queue_size: providerHealth.pending_queue_size,
      error_count_24h: providerHealth.error_count_24h + localErrorCount,
      state,
    };
  };

  const runRetention = async (): Promise<CollectionPruneResult> => retention.run();

  // D-127 P1.6 — outbound send. Capability check + sender ≠ to
  // self-loop guard (spec § A.8) live at this layer; the underlying
  // provider's `send` does the actual transport. cc/bcc-self refs
  // are deliberately allowed — common archival pattern (deal-update
  // cc'd to self for record-keeping).
  //
  // D-127 P1.7 — emits one `mail_send` activity row per call (success
  // or non-warning failure). Body content is excluded for privacy;
  // the recipient list is included only when the total recipient
  // count is ≤ MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD.
  // Emission errors are swallowed via best-effort try/catch so a
  // back-pressured audit log can't break a recipe send.
  /** D-264 — park a message in the mailbox's Drafts folder.
   *
   *  Deliberately thin next to `send`, and each omission is a decision:
   *
   *    - **no self-loop guard.** That guard exists because mailing yourself on
   *      `To:` is almost always a mistake. Parking a message addressed to
   *      yourself is a note to yourself — a normal thing to want.
   *    - **no attachment resolution.** Attachment bytes are a gated egress path
   *      (`data-file-read`), and nothing about parking a draft needs them yet.
   *      An export drops `attachments` rather than half-resolving them, and the
   *      caller is told via a warning rather than left to infer it.
   *    - **no reconciliation id.** Nothing was submitted, so there is no
   *      response-less accepted message to find later.
   *
   *  What it keeps is the capability gate and the audit row, because both
   *  answer "what did Recued do to my mailbox". */
  const saveDraft = async (args: {
    to: string[]; cc?: string[]; bcc?: string[];
    subject: string; body_text: string; body_html?: string;
    in_reply_to?: string; references?: string[]; reply_to?: string;
    prior_source_id?: string;
    recipe_id?: string; step_id?: string;
  }): Promise<SavedDraftMeta> => {
    const emitDraftAudit = async (
      success: boolean, sourceId: string,
      extras: {
        // ⛔ THE PROVIDER'S ANSWER, not `prior !== undefined`. Graph's
        // update-then-create fallback returns `replaced: false` with a warning;
        // an audit row keyed on "a prior was supplied" then asserted a
        // replacement that did not happen — durably, to the owner investigating
        // why they have two drafts.
        replaced?: boolean;
        warnings?: Array<{ code: string; message: string }>;
        error?: { code: string; message: string };
      } = {},
    ): Promise<void> => {
      if (!opts.auditLog) return;
      try {
        const ts = Date.now();
        await opts.auditLog.logActivity({
          activity_id: `md-${ts}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: ts,
          action: 'mail_draft_saved_to_mailbox',
          target: `mail:${slug}`,
          detail: JSON.stringify({
            subject: args.subject,
            body_bytes: Buffer.byteLength(args.body_text, 'utf8'),
            recipient_count: args.to.length + (args.cc?.length ?? 0) + (args.bcc?.length ?? 0),
            draft_source_id: sourceId,
            replaced_prior: extras.replaced === true,
            success,
            ...(extras.warnings && extras.warnings.length > 0 ? { warnings: extras.warnings } : {}),
            ...(extras.error ? { error: extras.error } : {}),
            ...(args.recipe_id ? { recipe_id: args.recipe_id } : {}),
            ...(args.step_id ? { step_id: args.step_id } : {}),
          }),
        });
      } catch (err) {
        bumpError('mail_draft_saved_to_mailbox audit emission failed', err);
      }
    };

    if (!provider.draftCapable || typeof provider.saveDraft !== 'function') {
      const err = new IngredientError(
        'MAIL_DRAFT_NOT_CAPABLE',
        `Mail account ${provider.kind}/${slug} cannot save drafts to the mailbox. `
        + `Re-enroll it with write access, or keep the draft in Recued.`,
        { kind: provider.kind, slug },
      );
      await emitDraftAudit(false, '', { error: { code: err.code, message: err.message } });
      throw err;
    }

    try {
      const saved = await provider.saveDraft({
        to: args.to,
        ...(args.cc ? { cc: args.cc } : {}),
        ...(args.bcc ? { bcc: args.bcc } : {}),
        subject: args.subject,
        body_text: args.body_text,
        ...(args.body_html !== undefined ? { body_html: args.body_html } : {}),
        ...(args.in_reply_to !== undefined ? { in_reply_to: args.in_reply_to } : {}),
        ...(args.references ? { references: args.references } : {}),
        ...(args.reply_to !== undefined ? { reply_to: args.reply_to } : {}),
      }, args.prior_source_id !== undefined ? { source_id: args.prior_source_id } : undefined);
      await emitDraftAudit(true, saved.source_id, {
        replaced: saved.replaced,
        ...(saved.warnings ? { warnings: saved.warnings } : {}),
      });
      return saved;
    } catch (err) {
      const code = err instanceof IngredientError ? err.code : 'MAIL_DRAFT_WRITE_FAILED';
      const message = err instanceof Error ? err.message : String(err);
      await emitDraftAudit(false, '', { error: { code, message } });
      throw err;
    }
  };

  const send = async (args: MailSendInput): Promise<MailSendResult> => {
    const reviewed = currentPreapprovalIo();
    reviewed?.validateMail(slug, args);
    const totalRecipients = args.to.length
      + (args.cc?.length ?? 0)
      + (args.bcc?.length ?? 0);
    const bodyBytes = Buffer.byteLength(args.body_text ?? '', 'utf8');

    const emitAudit = async (
      detail: MailSendAuditDetail,
    ): Promise<void> => {
      if (!opts.auditLog) return;
      try {
        const ts = nowOf();
        const entry: ActivityEntry = {
          activity_id: `ms-${ts}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: ts,
          action: 'mail_send',
          target: `mail:${slug}`,
          detail: JSON.stringify(detail),
        };
        await opts.auditLog.logActivity(entry);
      } catch (err) {
        bumpError('mail_send audit emission failed', err);
      }
    };

    // ⛔ DECLARED BEFORE `buildDetail`, WHICH CLOSES OVER IT. It used to be
    // declared below, and `buildDetail` is CALLED on the early failure paths
    // (capability gate, self-loop guard) before that line is reached — so the
    // audit row threw `Cannot access 'resolvedAttachments' before
    // initialization` instead of recording the failure. Every one of those
    // paths reports a refusal, which is exactly when an audit row matters most.
    let resolvedAttachments: ResolvedAttachment[] | undefined;
    const buildDetail = (
      success: boolean,
      messageId: string,
      extras: {
        warnings?: Array<{ code: string; message: string }>;
        error?: { code: string; message: string };
      } = {},
    ): MailSendAuditDetail => {
      const recipients = dedupedRecipientsForAudit(args, provider.accountEmail);
      const detail: MailSendAuditDetail = {
        recipient_count: totalRecipients,
        subject: args.subject,
        message_id: messageId,
        body_bytes: bodyBytes,
        success,
      };
      // ⛔ NAME WHAT LEFT. Built from the RESOLVED set, so it reflects what was
      // actually handed to the provider — an over-cap attachment that was
      // dropped is absent here and present in `warnings`, which is the honest
      // pair. Without this a run-scoped attachment left no trace anywhere.
      if (resolvedAttachments !== undefined && resolvedAttachments.length > 0) {
        detail.attachments = resolvedAttachments.map((a) => ({
          filename: a.filename,
          size_bytes: a.size_bytes,
          sha256: a.blob_hash,
          carrier: a.run_scoped === true ? ('run_scoped' as const) : ('record' as const),
        }));
      }
      // `redact_audit_recipients` wins over the count threshold — the threshold
      // is a noise rule, this is a PII rule, and a sealed address must not be
      // attached just because there happened to be only one of it.
      if (
        args.redact_audit_recipients !== true
        && recipients.length <= MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD
      ) {
        detail.recipients = recipients;
      }
      if (extras.warnings && extras.warnings.length > 0) {
        detail.warnings = extras.warnings;
      }
      if (extras.error) {
        detail.error = extras.error;
      }
      // D-127 follow-on — engine-supplied step identity. Both fields are
      // optional in the audit detail shape; direct rpc callers (no
      // engine context) just leave them off the row.
      if (args.recipe_id && args.recipe_id.length > 0) {
        detail.recipe_id = args.recipe_id;
      }
      if (args.step_id && args.step_id.length > 0) {
        detail.step_id = args.step_id;
      }
      return detail;
    };

    if (args.reconciliation_id !== undefined
      && !isMailReconciliationId(args.reconciliation_id)) {
      const err = new IngredientError(
        'BAD_INPUT',
        'mail-send: reconciliation_id must be a bounded ASCII header token',
        { kind: provider.kind, slug },
      );
      await emitAudit(buildDetail(false, '', {
        error: { code: err.code, message: err.message },
      }));
      throw err;
    }

    if (!provider.sendCapable || typeof provider.send !== 'function') {
      const err = new IngredientError(
        'MAIL_SEND_NOT_CAPABLE',
        `Mail account ${provider.kind}/${slug} is not configured to send. Re-enroll with sending enabled, or pick a different mail account.`,
        { kind: provider.kind, slug },
      );
      await emitAudit(buildDetail(false, '', { error: { code: err.code, message: err.message } }));
      throw err;
    }
    const senderAddress = provider.accountEmail.trim().toLowerCase();
    if (senderAddress.length > 0) {
      for (const recipient of args.to) {
        const bare = extractAddress(recipient);
        if (bare === senderAddress) {
          const err = new IngredientError(
            'MAIL_SEND_SELF_LOOP_TO',
            `This recipe is configured to send mail to itself (${recipient}); this is almost always a configuration mistake. Adjust the recipient or move the address to bcc.`,
            { kind: provider.kind, slug, account_email: provider.accountEmail, offending: recipient },
          );
          await emitAudit(buildDetail(false, '', { error: { code: err.code, message: err.message } }));
          throw err;
        }
      }
    }

    // D-172 P2 — resolve `attachments` refs → bytes BEFORE provider.send.
    // Each ref is a `data.file.received.<id>` record-id. Per-ref order:
    //
    //   1. METADATA get (F3) — read the `data.file.received` record from the
    //      collection registry (`hot_fields.size` / `size_bytes`). Metadata
    //      stays freely resolvable (spec N.5 — "content is the gated
    //      surface"); reading it here is NOT the byte-egress path.
    //   2. SIZE preflight (review F3) — an over-cap ref is DROPPED + warned
    //      WITHOUT ever reading its bytes, so a near-quota file never gets
    //      read + base64'd (hundreds of MB) only to be discarded.
    //   3. BYTE read — `handleFileRead` is the ONE audited byte-egress path
    //      (I-4): it resolves the CAS blob, decodes it, logs
    //      `file_content_read`. The POLICY gate on this content read — the
    //      `(channel × actor × contract_id)` admission for `data-file-read`
    //      (review F2) — is enforced UPSTREAM at the Gateway dispatch
    //      boundary: a `mail-send` carrying attachments is refused there
    //      (PreflightDeniedError) when the call's scope is denied
    //      `data-file-read`, so this loop only ever runs for an
    //      already-admitted scope (see execute-handler's `evaluateAdmission`).
    //
    // A ref that fails to resolve (missing record / missing blob / remote
    // ref) is a hard error — partial attachment sends would silently mislead
    // the recipient about what they received, so we refuse the whole send
    // rather than ship a mail missing files the recipe author asked for.
    const resolveWarnings: Array<{ code: string; message: string }> = [];
    if (Array.isArray(args.attachments) && args.attachments.length > 0) {
      const readDeps = opts.fileReadDeps?.();
      if (!readDeps) {
        const err = new IngredientError(
          'MAIL_SEND_ATTACHMENT_UNRESOLVABLE',
          `mail-send: attachments were requested but the file substrate is not available on this server (no file-read deps wired). Re-send without attachments, or run a server build with the file collection enabled.`,
          { kind: provider.kind, slug, attachment_count: args.attachments.length },
        );
        await emitAudit(buildDetail(false, '', { error: { code: err.code, message: err.message } }));
        throw err;
      }
      // F3 — the `data.file.received` collection backs the metadata
      // preflight. Resolved once outside the loop. Absent (file substrate
      // not registered) means we cannot preflight a size; the byte-read
      // below then surfaces the same `collection_not_found` → wrapped
      // MAIL_SEND_ATTACHMENT_UNRESOLVABLE, so the over-cap drop just doesn't
      // engage — the send still fails closed on an unresolvable ref.
      const fileCollection = readDeps.registry.get('file', DATA_FILE_RECEIVED_SLUG);
      const kept: ResolvedAttachment[] = [];
      for (const [attachmentIndex, ref] of args.attachments.entries()) {
        // ⛔⛔ A RUN-SCOPED TEMP ATTACHMENT — bytes the caller made in order to
        // send them. Read under the scratch-root confinement, sent, and left to
        // the run's own reclaim. NOTHING DURABLE IS CREATED, so there is no
        // record to delete afterwards and no destructive authority here.
        //
        // 🔑 The confinement is the authorization. A recipe can only name a temp
        // file it produced in THIS run, so unlike a `cleanup_after` flag it
        // cannot be pointed at the owner's own files.
        //
        // ⚠ Held sends are the NORMAL path for this (`liftOutboundSend` asks the
        // owner), and the bytes survive it: `reclaimRunScratchUnlessResumable`
        // preserves the scratch of a run that is merely paused, and the run
        // resumes under the SAME run_id. Same property the ask-tier records
        // `import` depends on for its `csv_ref`.
        if (isTempFileRef(ref)) {
          if (reviewed) {
            // The preapproval replay reads by RECORD ID
            // (`readMailAttachment(recordId: string, …)`), so it cannot carry a
            // temp ref. Fail closed rather than resolve an attachment the
            // reviewer never saw.
            throw new IngredientError(
              'BAD_INPUT',
              'mail-send: a temp file_ref attachment cannot go through deferred review — '
                + 'persist it first if the send must be reviewed out of band',
              { slug, attachment_index: attachmentIndex },
            );
          }
          if (typeof args.run_id !== 'string' || args.run_id.length === 0) {
            // The kernel refuses this first; this is the fail-closed backstop for
            // a direct caller that assembled the args itself.
            throw new IngredientError(
              'MAIL_SEND_ATTACHMENT_UNRESOLVABLE',
              'mail-send: a temp file_ref attachment requires a run scope',
              { slug, attachment_index: attachmentIndex },
            );
          }
          let temp;
          try {
            temp = readConfinedTempBytes(ref, args.run_id);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const wrapped = new IngredientError(
              'MAIL_SEND_ATTACHMENT_UNRESOLVABLE',
              `mail-send: temp attachment could not be read: ${message}`,
              { kind: provider.kind, slug, attachment_index: attachmentIndex },
            );
            await emitAudit(buildDetail(false, '', { error: { code: wrapped.code, message: wrapped.message } }));
            throw wrapped;
          }
          if (temp.bytes.byteLength > MAIL_SEND_ATTACHMENT_MAX_BYTES) {
            // Same visible drop the record path takes — never a silent omission.
            const msg = `attachment '${temp.filename}' (${temp.bytes.byteLength} bytes) exceeds the ${MAIL_SEND_ATTACHMENT_MAX_BYTES}-byte attachment cap and was omitted from the send`;
            log?.('warn', `mail-send: ${msg}`, { slug });
            resolveWarnings.push({ code: MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING, message: msg });
            continue;
          }
          kept.push({
            filename: temp.filename,
            mime_type: temp.mime_type,
            bytes_b64: temp.bytes.toString('base64'),
            size_bytes: temp.bytes.byteLength,
            // ⛔ THE SAME VALUE A CAS RECORD WOULD CARRY. `blob_hash` is the
            // content sha256 (`handleFilePersist` computes it identically), and
            // the D-207 claim's `attachment_sha256` proof is built from it — so a
            // temp attachment reconciles exactly as a persisted one does.
            blob_hash: createHash('sha256').update(temp.bytes).digest('hex'),
            run_scoped: true,
          });
          continue;
        }
        if (reviewed) {
          const file = await reviewed.readMailAttachment(ref, attachmentIndex, readDeps);
          if (file.size_bytes > MAIL_SEND_ATTACHMENT_MAX_BYTES) {
            throw new IngredientError('preapproval_stale', 'A reviewed attachment exceeds the mail attachment limit.', { slug });
          }
          kept.push({ filename: file.filename, mime_type: file.mime_type, bytes_b64: file.bytes_b64,
            size_bytes: file.size_bytes, blob_hash: file.blob_hash });
          continue;
        }
        // F3 — preflight the size from record METADATA before reading bytes.
        // `hot_fields.size` is the canonical byte length set at ingest;
        // `size_bytes` on the CollectionRecord mirrors it. An over-cap ref is
        // dropped here — `handleFileRead` (the blob read + base64) is NEVER
        // called for it.
        const metaRecord = fileCollection?.get(ref);
        if (metaRecord) {
          const hot = metaRecord.hot_fields as Record<string, unknown>;
          const metaSize =
            typeof hot.size === 'number' && Number.isFinite(hot.size)
              ? hot.size
              : typeof metaRecord.size_bytes === 'number'
                ? metaRecord.size_bytes
                : undefined;
          if (metaSize !== undefined && metaSize > MAIL_SEND_ATTACHMENT_MAX_BYTES) {
            const displayName =
              typeof hot.filename === 'string' && hot.filename.length > 0
                ? hot.filename
                : ref;
            const msg = `attachment '${displayName}' (${metaSize} bytes) exceeds the ${MAIL_SEND_ATTACHMENT_MAX_BYTES}-byte attachment cap and was omitted from the send`;
            log?.('warn', `mail-send: ${msg}`, { slug, ref });
            resolveWarnings.push({ code: MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING, message: msg });
            continue;
          }
        }
        let file;
        try {
          file = await handleFileRead(readDeps, { record_id: ref });
        } catch (err) {
          // Map the RpcError-shaped file-read failures (file_not_found /
          // file_blob_missing / file_remote_unsupported / bad_request)
          // onto the recipe-friendly typed code so the surface is
          // consistent with the other MAIL_SEND_* codes. The original
          // file-read code is preserved in `details.file_read_code`.
          const fileCode = (err as { code?: string } | undefined)?.code;
          const message = err instanceof Error ? err.message : String(err);
          const wrapped = new IngredientError(
            'MAIL_SEND_ATTACHMENT_UNRESOLVABLE',
            `mail-send: attachment '${ref}' could not be read: ${message}`,
            { kind: provider.kind, slug, attachment_ref: ref, file_read_code: fileCode },
          );
          await emitAudit(buildDetail(false, '', { error: { code: wrapped.code, message: wrapped.message } }));
          throw wrapped;
        }
        if (file.size_bytes > MAIL_SEND_ATTACHMENT_MAX_BYTES) {
          // Backstop for the rare record whose metadata size was absent /
          // stale at preflight (e.g. a pre-stored `storage_ref` ingested
          // without `size_bytes`): the authoritative decoded length still
          // drops + warns (I-6: visible, never silent). The common path
          // already dropped over-cap refs above without reading bytes.
          const msg = `attachment '${file.filename}' (${file.size_bytes} bytes) exceeds the ${MAIL_SEND_ATTACHMENT_MAX_BYTES}-byte attachment cap and was omitted from the send`;
          log?.('warn', `mail-send: ${msg}`, { slug, ref });
          resolveWarnings.push({ code: MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING, message: msg });
          continue;
        }
        kept.push({
          filename: file.filename,
          mime_type: file.mime_type,
          bytes_b64: file.bytes_b64,
          size_bytes: file.size_bytes,
          blob_hash: file.blob_hash,
        });
      }
      if (kept.length > 0) resolvedAttachments = kept;
    }

    // ── D-207 slice 3d — the pre-dispatch claim ──────────────────────────────
    //
    // ⛔ THE CLAIM IS WRITTEN BEFORE THE SEND, AND THAT ORDERING IS THE WHOLE
    // FENCE. A crash — or a network timeout — between here and the provider's
    // acknowledgement leaves us unable to know whether the message went out. The
    // claim is the only thing that survives to be asked about later.
    //
    // ⚠ Note what does NOT happen in the catch below: the claim is NOT removed. A
    // `provider.send` that THROWS does not mean the mail did not go — an SMTP
    // timeout after the server accepted the message is an error to us and a
    // delivered mail to the customer. Deleting the claim on a throw would let a
    // retry double-send, which is the exact bug this substrate exists to prevent.
    let claimRevision: number | null = null;
    if (args.reconciliation_id !== undefined) {
      const recipients = [...args.to, ...(args.cc ?? []), ...(args.bcc ?? [])];
      // ⛔ Refuse rather than under-prove. The reconciliation query matches ONE
      // recipient envelope, so a fan-out send cannot be proven by it. Claiming on
      // `to[0]` and calling the result "reconciled" would be a silent downgrade of
      // what we assert to have proven — the declared-but-not-backed failure.
      if (recipients.length !== 1) {
        throw new IngredientError(
          'BAD_INPUT',
          'mail-send: reconciliation_id requires exactly one recipient — a fan-out send '
            + 'cannot be proven by a single-recipient envelope match',
          { slug, recipient_count: recipients.length },
        );
      }
      const attachment = resolvedAttachments?.length === 1
        ? resolvedAttachments[0]
        : undefined;
      const { result, claim } = claims.claim({
        reconciliation_id: args.reconciliation_id,
        // Whose Sent folder is source truth for this message. The reconciler cannot
        // ask the right provider without it, and it must not be told which to ask.
        sender_slug: slug,
        recipient: recipients[0] as string,
        subject: args.subject,
        ...(attachment
          ? {
            proof_kind: 'attachment' as const,
            attachment_sha256: attachment.blob_hash,
            attachment_size_bytes: attachment.size_bytes,
            attachment_filename: attachment.filename,
            attachment_mime_type: attachment.mime_type,
          }
          : { proof_kind: 'envelope' as const }),
        now: nowOf(),
      });

      // ⛔ A PRE-EXISTING CLAIM MEANS WE HAVE ALREADY TRIED. Every branch below is a
      // reason NOT to dispatch again — because `created` is the only state in which
      // nobody has yet attempted this message, and dispatching in any other is the
      // double-send this substrate exists to prevent.
      if (result === 'existing') {
        // Provider acknowledged, provider source truth confirmed, or the owner said
        // so. The message went out. Re-sending it is the one thing we must never do —
        // so we do not, and we say so rather than lying about having sent something new.
        if (isMailSendClaimDelivered(claim.status)) {
          return {
            source_id: '',
            message_id: claim.provider_message_id ?? '',
            sent_at: claim.sent_at ?? claim.updated_at,
            already_sent: true,
            _id: null,
            _collection: 'data.mail',
          };
        }

        // `claimed` — we tried and never learned the outcome (a crash, or a timeout
        // that may well have been an ACCEPTED message). This is the genuinely unknown
        // case, and it is EXACTLY the one a blind retry gets wrong: re-sending might
        // double-send, not re-sending might never send, and neither is safe to guess.
        //
        // `ambiguous` — provider source truth was CONTRADICTORY. Reconciling again
        // will not help (a settled claim does not move), so the honest instruction is
        // different: a human has to look.
        //
        // ⚠ The cost is real and it is the POINT: opting into a reconciliation_id is
        // opting into "never double-send this", and the price of that promise is that
        // an unresolved attempt gets RESOLVED rather than REPEATED. A recipe that would
        // rather risk a duplicate than stall simply omits the id and keeps ordinary
        // retry semantics.
        //
        // The way out is the OWNER's (`mail-send-outcome-ask.ts`): for an attempt
        // that has ended, the send dispatcher asks them "Did this email go out?".
        const ownerQuestion = mailSendClaimNeedsOwner(claim, nowOf());
        throw new IngredientError(
          'MAIL_SEND_CLAIM_UNRESOLVED',
          !ownerQuestion
            ? `An attempt to send this to ${claim.recipient} started moments ago and has `
              + 'not finished, so Recued will not start another. Try again in a few minutes.'
            : claim.status === 'ambiguous'
              ? `Your Sent folder has more than one message that could be this one to `
                + `${claim.recipient} (${claim.ambiguity_reason ?? 'unclear'}), so Recued will `
                + 'not send it again on its own. It has asked you whether it went out — '
                + 'answer under the bell; if it did not, the next run sends it.'
              : `Recued could not tell whether an earlier attempt to send this to `
                + `${claim.recipient} went out, so it will not send it again on its own. It `
                + 'has asked you whether it went out — answer under the bell; if it did '
                + 'not, the next run sends it.',
          { slug, reconciliation_id: args.reconciliation_id, claim_status: claim.status },
        );
      }

      claimRevision = claim.revision;
    }

    let meta;
    await reviewed?.beforeMailProvider(slug, args);
    assertPreapprovalOrdinaryRun();
    try {
      meta = await provider.send({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body_text: args.body_text,
        body_html: args.body_html,
        in_reply_to: args.in_reply_to,
        references: args.references,
        reply_to: args.reply_to,
        reconciliation_id: args.reconciliation_id,
        // `blob_hash` is stripped: it belongs to the CLAIM, not to the wire. The
        // provider has no use for a content hash, and a field that need not leave
        // the server should not.
        ...(resolvedAttachments
          ? {
            attachments: resolvedAttachments.map(
              ({ blob_hash: _hash, ...attachment }) => attachment,
            ),
          }
          : {}),
      });
    } catch (err) {
      // ⛔ THE CLAIM SURVIVES THIS. A `provider.send` that THROWS does not mean the
      // mail did not go out — an SMTP timeout after the server accepted the message
      // is an error to us and a delivered mail to the customer. Withdrawing the claim
      // here would let a retry double-send, which is the exact thing the claim exists
      // to prevent.
      //
      // What the attempt DID learn is recorded, though. A provider that PROVED the
      // message never reached it (`details.not_sent` — it refused it, or the send
      // failed before getting there) ends the claim `not_sent`, and the next attempt
      // sends. Anything else ends it `unknown`: the send dispatcher asks the owner
      // whether it went out, and nothing re-sends until they answer or source truth
      // settles it.
      if (args.reconciliation_id !== undefined && claimRevision !== null) {
        const notSent = err instanceof IngredientError && err.details?.not_sent === true;
        try {
          const ended = { reconciliation_id: args.reconciliation_id, expected_revision: claimRevision, now: nowOf() };
          if (notSent) claims.markNotSent(ended);
          else claims.markUnknown(ended);
        } catch (claimErr) {
          // The send's own failure is the answer; a claim write must not mask it.
          bumpError('mail send claim could not record how the attempt ended', claimErr);
        }
      }
      const code = err instanceof IngredientError ? err.code : 'UNKNOWN';
      const message = err instanceof Error ? err.message : String(err);
      await emitAudit(buildDetail(false, '', { error: { code, message } }));
      if (reviewed) throw new IngredientError('ACTION_DELIVERY_UNCERTAIN',
        'The reviewed mail provider did not confirm delivery. Check this attempt before sending again.', { slug });
      throw err;
    }
    // The provider acknowledged. Still not PROOF — an ack can be lost in transit —
    // so the claim moves to `sent`, not to a settled state. Only provider source
    // truth (the reconcile op) may settle it.
    if (args.reconciliation_id !== undefined && claimRevision !== null) {
      claims.markSent({
        reconciliation_id: args.reconciliation_id,
        expected_revision: claimRevision,
        provider_message_id: meta.message_id,
        sent_at: meta.sent_at,
        now: nowOf(),
      });
    }

    // Merge the over-size resolve-warnings with the provider's own
    // warnings (e.g. IMAP MAIL_SEND_APPEND_FAILED) so both surface on the
    // audit row + the rpc response.
    const mergedWarnings = [...resolveWarnings, ...(meta.warnings ?? [])];
    await emitAudit(buildDetail(true, meta.message_id, {
      ...(mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}),
    }));
    // The Sent record may already be in the warehouse if the
    // provider's inbound delta got there first (rare but possible
    // on gmail's tight history loop). Use the deterministic
    // record_id derivation to check; recipes can poll later when
    // _id is null.
    const expectedRecordId = recordIdFor(meta.source_id);
    const existing = table.get(expectedRecordId);
    return {
      source_id: meta.source_id,
      message_id: meta.message_id,
      sent_at: meta.sent_at,
      thread_id: meta.thread_id,
      ...(mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}),
      _id: existing ? expectedRecordId : null,
      _collection: 'data.mail',
    };
  };

  const lookupSentByReconciliationId = async (
    query: MailSentReconciliationQuery,
  ): Promise<MailSentReconciliationResult> => {
    assertMailSentReconciliationQuery(query);
    if (typeof provider.lookupSentByReconciliationId !== 'function') {
      return {
        status: 'unavailable',
        reason: 'unsupported',
        scanned_candidates: 0,
      };
    }
    try {
      return await provider.lookupSentByReconciliationId(query);
    } catch (err) {
      bumpError('mail sent reconciliation lookup failed', err);
      return {
        status: 'unavailable',
        reason: 'provider_error',
        scanned_candidates: 0,
      };
    }
  };

  return {
    platform: 'mail',
    slug,
    gate,
    sync,
    sendCapable: provider.sendCapable,
    // D-239 — a getter, because IMAP's `mutationCapable` is itself a lazy
    // getter on the provider. Reading it eagerly here would force that
    // probe at collection construction, i.e. on every boot for every
    // enrolled mailbox, which is exactly what the provider defers.
    get mutationCapable() {
      return provider.mutationCapable;
    },
    // D-264 — lazy for the same reason, and `?? false` because the provider
    // field is optional: an adapter that never declares it advertises nothing.
    get draftCapable() {
      return provider.draftCapable ?? false;
    },
    provider,
    applyVerifiedMutation,
    accountEmail: provider.accountEmail,
    upsert: (record) => { table.upsert(record); },
    delete: (record_id) => {
      const removed = table.delete(record_id) !== null;
      if (removed) notifyRemoved([record_id]);
      return removed;
    },
    get: (record_id) => table.get(record_id),
    list: (query: CollectionListQuery) => table.list(query),
    search: (query: CollectionSearchQuery): CollectionSearchMatch[] => table.search(query),
    // ⛔ MUST BE FORWARDED HERE, NOT JUST ON THE TABLE. The chat handler iterates
    // `registry.list()`, which yields these Collection wrappers — a method that
    // exists only on CollectionTable is invisible to it, and the call silently
    // returns nothing. Measured: the model correctly asked for `near_id` and got
    // an empty result, then reported the PROPOSAL as the outcome.
    neighbours: (query: Parameters<typeof table.neighbours>[0]) => table.neighbours(query),
    countFrom: (email: string): number => table.countByAddress('from', email),
    legacyAttachmentsAmbiguous,
    health,
    runRetention,
    send,
    saveDraft,
    lookupSentByReconciliationId,
    async close() {
      closed = true;
      await sync.stop();
    },
  };
};
