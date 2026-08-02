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
 *    { from, to, cc, subject, thread_id, folder, is_read,
 *      has_attachments, labels?, message_id, rfc_message_id?,
 *      reconciliation_id? }
 *
 *  `record_id` hashes the provider's `source_id`; two accounts
 *  sharing a Message-ID won't collide because each `(platform, slug)`
 *  gets its own SQLite table.
 */

import { createHash } from 'node:crypto';
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
  MailSendAuditDetail,
} from '@recued/contracts';
import { MAIL_SEND_AUDIT_RECIPIENT_REDACTION_THRESHOLD } from '@recued/contracts';
import { isMailReconciliationId } from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import { IngredientError } from '@recued/ingredients';

import type { BlobStore } from '../../storage/blob-store.js';
// D-207 slice 3d — the pre-dispatch claim: the general no-resend fence.
import { createMailSendClaimStore } from '../../storage/mail-send-claim-store.js';
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
import { classifyOAuthFailure, type MailSyncOutcome } from './provider.js';
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
  MailSentReconciliationQuery,
  MailSentReconciliationResult,
  OutgoingAttachment,
  ProviderSyncEvent,
} from './provider.js';
import {
  assertMailSentReconciliationQuery,
  detectMailAttachmentMimeType,
  normalizeRfcMessageId,
  type MailProvider,
} from './provider.js';

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
  /** D-121 Phase 1 — derivation hook fired after a successful upsert.
   *  The contact-derive integration uses this to materialize
   *  `data.contact` rows from From/To/CC headers; left undefined the
   *  collection runs unchanged. Errors thrown by the hook are
   *  swallowed via `bumpError` so a contact write failure never
   *  rolls back a verified mail ingest. */
  onMessageUpserted?: (msg: CanonicalMessage) => void;
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
 *  B. 3 MB raw bytes ≈ 4 MB base64-on-the-wire. */
export const MAIL_SEND_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;

/** D-172 P2 — non-fatal warning code attached to `SentMessageMeta`
 *  when an attachment exceeds `MAIL_SEND_ATTACHMENT_MAX_BYTES` and is
 *  dropped from the outbound payload. Surfaced on the `mail_send` audit
 *  row + the rpc response `warnings[]` so the user sees the omission. */
export const MAIL_SEND_ATTACHMENT_OVERSIZE_WARNING = 'MAIL_SEND_ATTACHMENT_OVERSIZE' as const;

const pickPrimaryFolder = (folderOrLabel: string, labels: string[] = []): string => {
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
  push(hot.from);
  push(hot.to);
  push(hot.cc);
  push(hot.subject);
  if (record.body_inline) parts.push(record.body_inline);
  return parts.join('\n');
};

/** Exported for unit testing (mirrors `mailFtsText`) — maps a
 *  `CanonicalMessage` to its stored `CollectionRecord` + body byte count,
 *  including the D-184 normalized `rfc_message_id` hot field. */
export const buildRecord = (
  msg: CanonicalMessage,
  nowOf: () => number,
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
    is_read: msg.is_read,
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
  /** D-172 P2 (Attachments-v2) — `data.file` record-id refs to attach.
   *  The INPUT carries refs (record-ids), NOT bytes: `MailCollection.send`
   *  resolves each through the Gateway-gated `file.read` (`handleFileRead`,
   *  the one audited byte-egress path — I-4) into an
   *  `OutgoingAttachment[]` before calling `provider.send`. Empty /
   *  absent => no attachments (the legacy text/html send). Resolution
   *  requires `fileReadDeps` to be wired on the collection; when a ref
   *  is present but `fileReadDeps` is absent the send throws
   *  `MAIL_SEND_ATTACHMENT_UNRESOLVABLE` rather than silently dropping
   *  the file (I-6). */
  attachments?: string[];
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
type ResolvedAttachment = OutgoingAttachment & { blob_hash: string };

/** D-127 P1.6 — `MailCollection` extends `Collection` with the
 *  mail-specific surface. The rpc handler runtime-checks the
 *  presence of `send` to narrow from the generic registry's
 *  `Collection` type. `sendCapable` and `accountEmail` mirror the
 *  underlying provider's fields so the picker / sender-resolution
 *  paths can read them without reaching through the provider. */
export interface MailCollection extends Collection {
  readonly platform: 'mail';
  readonly sendCapable: boolean;
  readonly accountEmail: string;
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
  });

  let state: CollectionState = 'idle';
  let lastIndexedAt = 0;
  let localErrorCount = 0;
  let stopSync: (() => Promise<void>) | undefined;
  /** Unsubscribe for the provider's per-attempt outcome stream. */
  let stopOutcomes: (() => void) | undefined;
  let startInFlight: Promise<void> | null = null;
  let syncGeneration = 0;
  let closed = false;

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
      touchSyncClock(outcome.at);
      return;
    }
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

  const materializeInboundAttachments = async (
    msg: CanonicalMessage,
    mailRecordId: string,
    shouldContinue: () => boolean,
  ): Promise<void> => {
    const attachments = msg.attachments ?? [];
    if (attachments.length === 0) return;

    const deps = opts.inboundAttachmentDeps?.();
    if (!deps) {
      bumpError(
        `mail attachment ingest skipped for ${msg.source_id}: inbound attachment deps not wired`,
        new Error('mail_attachment_deps_not_configured'),
      );
      return;
    }

    for (const [idx, part] of attachments.entries()) {
      if (!shouldContinue()) return;
      const sourcePartId = part.source_part_id || `part-${idx}`;
      try {
        const bytes = await part.fetchBytes();
        if (!shouldContinue()) return;
        const fileRecord = await deps.fileIngestor.ingest({
          bytes,
          filename: part.filename,
          mime_type: detectMailAttachmentMimeType(bytes, part.mime_type),
          origin: 'mail_attachment',
          source_id: `${mailRecordId}:${sourcePartId}`,
          now: nowOf(),
        });
        if (!shouldContinue()) return;
        await deps.attach(
          {
            file_id: fileRecord.record_id,
            to_collection: 'mail',
            to_id: mailRecordId,
            ...(deps.authored_by ? { authored_by: deps.authored_by } : {}),
          },
          deps.attachDeps,
        );
      } catch (err) {
        bumpError(`mail attachment ingest failed for ${msg.source_id}:${sourcePartId}`, err);
      }
    }
  };

  const upsertMessage = async (
    msg: CanonicalMessage,
    shouldContinue: () => boolean,
  ): Promise<void> => {
    const { record, bodyBytes } = buildRecord(msg, nowOf);
    try {
      if (!shouldContinue()) return;
      if (bodyBytes <= INLINE_CUTOFF_BYTES) {
        record.body_inline = msg.body_text ?? '';
      } else {
        record.blob_hash = await blobs.put(Buffer.from(msg.body_text, 'utf8'));
      }
      if (!shouldContinue()) return;
      const prev = table.upsert(record);
      if (prev) emitter.updated(record.record_id, prev.hot_fields);
      else emitter.created(record.record_id);
      lastIndexedAt = record.modified_at;
      // A message landing is the strongest possible proof that this mailbox is
      // syncing, so it is the honest anchor for `last_synced_at`. Writing the
      // clock ONLY at sync-lifecycle transitions would leave it frozen at boot
      // time while a healthy 30 s poll loop kept working — "last synced 6 h
      // ago" on a mailbox that is fine, which is a fresh lie in place of the
      // old one. Throttled, because this runs once per ingested message and a
      // 30-day backfill is thousands of them.
      touchSyncClock();
      await materializeInboundAttachments(msg, record.record_id, shouldContinue);
      if (!shouldContinue()) return;
      if (opts.onMessageUpserted) {
        try { opts.onMessageUpserted(msg); }
        catch (err) { bumpError(`mail onMessageUpserted hook failed for ${msg.source_id}`, err); }
      }
    } catch (err) {
      bumpError(`mail ingest failed for ${msg.source_id}`, err);
    }
  };

  const onSyncEvent = async (
    event: ProviderSyncEvent,
    shouldContinue: () => boolean,
  ): Promise<void> => {
    if (!shouldContinue()) return;
    if (event.kind === 'deleted') {
      const recordId = recordIdFor(event.source_id);
      const prev = table.delete(recordId);
      if (prev) emitter.deleted(recordId, prev.hot_fields);
      return;
    }
    if (!event.message) {
      bumpError(`sync event ${event.kind} missing message`, null);
      return;
    }
    await upsertMessage(event.message, shouldContinue);
  };

  const isCurrentGeneration = (generation: number): boolean =>
    !closed && syncGeneration === generation;

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
          const before = localErrorCount;
          await upsertMessage(msg, shouldContinue);
          if (!shouldContinue()) return false;
          if (localErrorCount > before) backfillRecorder.recordFailure();
          else backfillRecorder.recordImport(msg.received_at);
          return true;
        },
      });
      if (!shouldContinue()) return;
      // The provider cursor is now stable; this write is idempotent on restart.
      try { opts.instances?.markBackfillComplete('mail', slug); }
      catch (err) { bumpError('mail markBackfillComplete failed', err); }
      await backfillRecorder.finish();
    } catch (err) {
      if (!shouldContinue()) return;
      bumpError('mail initialScan failed', err);
      await backfillRecorder.finish('failed');
      reportSyncOutcome(classifySyncFailure(err));
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
  const send = async (args: MailSendInput): Promise<MailSendResult> => {
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
    let resolvedAttachments: ResolvedAttachment[] | undefined;
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
      for (const ref of args.attachments) {
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
        // Provider acknowledged, or provider source truth confirmed. The message went
        // out. Re-sending it is the one thing we must never do — so we do not, and we
        // say so rather than lying about having sent something new.
        if (claim.status === 'sent' || claim.status === 'reconciled') {
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
        throw new IngredientError(
          'MAIL_SEND_CLAIM_UNRESOLVED',
          claim.status === 'ambiguous'
            ? `mail-send: provider source truth for '${args.reconciliation_id}' is `
              + `contradictory (${claim.ambiguity_reason ?? 'unknown'}), so re-sending could `
              + 'duplicate a message the customer already has. This one needs a human.'
            : `mail-send: an earlier attempt at '${args.reconciliation_id}' never reported `
              + 'its outcome, so re-sending could duplicate a message the customer already '
              + 'has. Reconcile it against provider source truth (core.mail.sent.reconcile) '
              + 'first.',
          { slug, reconciliation_id: args.reconciliation_id, claim_status: claim.status },
        );
      }

      claimRevision = claim.revision;
    }

    let meta;
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
      // to prevent. It stays `claimed`, and only provider source truth may settle it.
      const code = err instanceof IngredientError ? err.code : 'UNKNOWN';
      const message = err instanceof Error ? err.message : String(err);
      await emitAudit(buildDetail(false, '', { error: { code, message } }));
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
    accountEmail: provider.accountEmail,
    upsert: (record) => { table.upsert(record); },
    delete: (record_id) => table.delete(record_id) !== null,
    get: (record_id) => table.get(record_id),
    list: (query: CollectionListQuery) => table.list(query),
    search: (query: CollectionSearchQuery): CollectionSearchMatch[] => table.search(query),
    countFrom: (email: string): number => table.countByAddress('from', email),
    health,
    runRetention,
    send,
    lookupSentByReconciliationId,
    async close() {
      closed = true;
      await sync.stop();
    },
  };
};
