/** Phase D (D-106) — IMAP provider (Commit 13).
 *
 *  Implements `MailProvider` against `imapflow`. One `ImapClient` per
 *  configured folder because IMAP connections carry a single SELECT'd
 *  mailbox; IDLE is mailbox-scoped too, so keeping the connections
 *  independent means a slow INBOX watcher doesn't starve Archive (and
 *  vice versa).
 *
 *  Canonicalization path:
 *    1. Fetch UID + envelope + flags + source (RFC-822) from imapflow.
 *    2. Run `mailparser.simpleParser(source)` for plaintext + HTML +
 *       header extraction.
 *    3. Fold into `CanonicalMessage`.
 *
 *  IDLE loop:
 *    - imapflow auto-starts IDLE on `mailboxOpen`; it re-issues IDLE
 *      every `maxIdleTime` ms (28 min default here, well inside the
 *      29-min RFC-recommended server timeout).
 *    - We listen for `exists` + `expunge` + `flags` events and fetch
 *      the affected UIDs on the fly.
 *    - `close` event → exponential backoff reconnect up to 60s.
 *
 *  Tests inject a narrow `ImapClient` so we don't need a real IMAP
 *  server. `DEFAULT_IMAP_CLIENT_FACTORY` wraps `ImapFlow` for prod.
 *
 *  D-127 P1.5 — outbound send. Provider opts in by setting
 *  `config.smtp` to the SMTP block captured at enrollment;
 *  `sendCapable` flips true iff the block is present (creds default
 *  to the IMAP creds when the SMTP block omits them — same-server
 *  setups don't need to repeat them). `send` builds RFC 5322 with
 *  a UUID-based Message-Id, submits via `nodemailer` SMTP, then
 *  IMAP APPENDs the canonicalized message to the user's Sent folder
 *  (path discovered via `\Sent` special-use flag, with
 *  `IMAP_SENT_FOLDER_FALLBACK_CANDIDATES` as the fallback). APPEND
 *  failure → `MAIL_SEND_APPEND_FAILED` warning attached to the
 *  returned `SentMessageMeta`; SMTP submission is *not* rolled back.
 *  SMTP error mapping: `EAUTH` → MAIL_SEND_AUTH_FAILED, `EENVELOPE` /
 *  responseCode in 5xx → MAIL_SEND_RECIPIENT_INVALID, network errors
 *  → MAIL_SEND_NETWORK_FAILED.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';
import type { AddressObject, ParsedMail } from 'mailparser';
import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlowOptions,
  MailboxObject,
  SearchObject,
} from 'imapflow';
import { IngredientError } from '@recued/ingredients';
import {
  isMailReconciliationId,
  MAIL_RECONCILIATION_ID_HEADER,
  MAIL_SENT_BY_MESSAGE_ID_MAX_MATCHES,
  MAIL_SENT_REPLIES_MAX_MATCHES,
  MailAdapterError,
  type MailSentByMessageIdMatch,
  type MailSentByMessageIdQuery,
  type MailSentByMessageIdResult,
  type MailSentRepliesQuery,
  type MailSentRepliesResult,
  type MailSentReplyMatch,
} from '@recued/contracts';
import {
  createMailSyncOutcomeReporter,
  assertMailSentReconciliationQuery,
  evaluateMailSentReconciliationCandidates,
  MAIL_SENT_RECONCILIATION_MAX_SCAN,
  MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES,
  mailAttachmentPartFromBytes,
  mailParsedFromName,
  mailParsedHeaderMap,
  mailPartDisposition,
  mailSentReconciliationAttachmentPartFromBytes,
  normalizeRfcMessageId,
  type CanonicalMessage,
  type InitialScanOptions,
  type MailSyncFailureKind,
  type MailSyncOutcomeListener,
  type InboundMailAttachmentPart,
  type MailFolderSnapshot,
  type MailMessageDirection,
  type MailMoveDestination,
  type MailMoveOutcome,
  type MailMutationResult,
  type MailProvider,
  type MailSentReconciliationCandidate,
  type MailSentReconciliationQuery,
  type MailSentReconciliationResult,
  type OutgoingMessage,
  type ProviderHealth,
  type ProviderSyncCallback,
  type ProviderSyncEventKind,
  type SavedDraftMeta,
  type SentMessageMeta,
} from './provider.js';
import type { OAuthAccountStore } from './oauth.js';
import { settleWithin, STOP_GRACE_MS } from '../../lifecycle/settle-within.js';
import { CollectionStoppedError, throwIfStopped } from '../stop-signal.js';

// ────────────────────────────────────────────────────────────────
// Narrow client interface — exactly the imapflow surface we use.
// Production factory wraps `ImapFlow`; tests inject a fake so we
// don't spin up a real IMAP server (or the wildduck test harness)
// per suite.
// ────────────────────────────────────────────────────────────────

export interface ImapClient extends EventEmitter {
  readonly usable: boolean;
  /** The open folder as the server last described it (`exists` follows each
   *  EXISTS and EXPUNGE), `false` while none is open. */
  readonly mailbox?: MailboxObject | false;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  /** `readOnly` opens with EXAMINE: a read that must not touch `\Seen`. */
  mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<MailboxObject>;
  search(
    query: SearchObject,
    options?: { uid?: boolean },
  ): Promise<number[] | false>;
  fetch(
    range: string | number[],
    query: FetchQueryObject,
    options?: { uid?: boolean },
  ): AsyncIterable<FetchMessageObject>;
  idle(): Promise<boolean>;
  /** D-127 P1.5 — list mailboxes including their RFC 6154 special-use
   *  flag (`\Sent`, `\Trash`, etc.). Optional so existing in-memory
   *  fakes keep compiling. The send path uses this to discover the
   *  Sent folder by flag before falling back to known names. */
  list?(): Promise<Array<{ path: string; specialUse?: string }>>;
  /** D-127 P1.5 — IMAP APPEND of a fully-formed RFC 5322 message
   *  into the named mailbox. Optional for the same reason as `list`.
   *  We pass `\Seen` so the Sent record doesn't show up unread in
   *  the user's mailbox UI. */
  append?(
    path: string,
    content: string | Buffer,
    flags?: string[],
  ): Promise<unknown>;

  // ── D-239 write-back verbs ──────────────────────────────────────
  //
  // Optional for the same reason `list` / `append` are: in-tree fakes
  // predate them and out-of-tree clients need not grow. `mutationCapable`
  // probes for the whole group at connect time, so a client missing any
  // one of them reports incapable rather than half-capable.
  //
  // All four take a UID range and are called with `{ uid: true }`, because
  // this provider addresses messages by UID everywhere else and a sequence
  // number is a mailbox POSITION that shifts under any concurrent EXPUNGE
  // — using one here would eventually mutate the wrong message.

  /** IMAP `UID STORE +FLAGS`. */
  messageFlagsAdd?(
    range: string | number[],
    flags: string[],
    options?: { uid?: boolean },
  ): Promise<boolean>;
  /** IMAP `UID STORE -FLAGS`. */
  messageFlagsRemove?(
    range: string | number[],
    flags: string[],
    options?: { uid?: boolean },
  ): Promise<boolean>;
  /** IMAP `UID MOVE` (or the COPY+STORE+EXPUNGE fallback imapflow runs on
   *  servers without the MOVE extension). `destination.uidMap` carries the
   *  source→destination UID mapping when the server supports UIDPLUS. */
  messageMove?(
    range: string | number[],
    destination: string,
    options?: { uid?: boolean },
  ): Promise<{ path?: string; destination?: string; uidMap?: Map<number, number> } | boolean>;
  /** IMAP `UID STORE +FLAGS (\Deleted)` + EXPUNGE, which is what a mail
   *  client's delete button does. */
  messageDelete?(
    range: string | number[],
    options?: { uid?: boolean },
  ): Promise<boolean>;
}

export type ImapClientFactory = (
  opts: ImapFlowOptions & { host: string; port: number; auth: { user: string; pass: string } },
) => ImapClient;

/** Wraps `ImapFlow` for production. Kept behind a factory so bin.ts
 *  can compose without importing imapflow directly in every call
 *  path, and so unit tests skip the real network stack. */
export const defaultImapClientFactory: ImapClientFactory = (opts) => {
  // Deferred import so loading `imap-provider` in tests that inject
  // a fake client doesn't pull in the imapflow bundle unnecessarily
  // — the IDLE timer + TLS socket setup have non-trivial boot cost.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ImapFlow } = require('imapflow') as typeof import('imapflow');
  return new ImapFlow(opts) as unknown as ImapClient;
};

// ────────────────────────────────────────────────────────────────
// D-127 P1.5 — SMTP transport (narrow nodemailer surface)
// ────────────────────────────────────────────────────────────────

import {
  defaultSmtpTransportFactory, submitSmtp, buildSmtpRfc5322 as buildImapRfc5322,
  generateSmtpMessageId as generateImapMessageId, type SmtpTransportFactory,
} from './smtp.js';
export {
  defaultSmtpTransportFactory, smtpProvablyNotAccepted, buildSmtpRfc5322 as buildImapRfc5322,
  generateSmtpMessageId as generateImapMessageId,
} from './smtp.js';
export type { SmtpMailOptions, SmtpSendResponse, SmtpTransport, SmtpTransportFactory } from './smtp.js';

// ────────────────────────────────────────────────────────────────
// Config + factory types
// ────────────────────────────────────────────────────────────────

export interface ImapProviderConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  folders: string[];
  /** Idle restart cadence. imapflow default is 28 minutes; exposed so
   *  tests can shorten it without patching internals. */
  maxIdleTime?: number;
  /** Upper bound for exponential backoff on reconnect. Default 60s. */
  reconnectCapMs?: number;
  /** Initial reconnect delay. Default 1s. Doubles each attempt up to
   *  `reconnectCapMs`. */
  reconnectInitialMs?: number;
  /** D-127 P1.5 — outbound SMTP block. When present the provider
   *  becomes send-capable; SMTP creds default to IMAP creds when
   *  unset (most providers use the same credentials for both). */
  smtp?: ImapSmtpConfig;
}

/** D-127 P1.5 — SMTP connection block on `ImapProviderConfig`.
 *  Optional fields default per spec § A.7.1: port → 587, secure →
 *  false (STARTTLS via 587), username/password → IMAP equivalents,
 *  from → IMAP username (assumed to be the email address). */
export interface ImapSmtpConfig {
  host: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  /** From address for outbound mail. Defaults to IMAP username when
   *  omitted; users can override when their submission identity
   *  differs from the inbound login (rare but valid). */
  from?: string;
}

export interface CreateImapProviderOptions {
  slug: string;
  config: () => ImapProviderConfig;
  clientFactory?: ImapClientFactory;
  /** D-127 P1.5 — SMTP transport factory. Production wraps
   *  `nodemailer`; tests inject a fake to drive auth / network /
   *  recipient error paths without a real SMTP server. */
  smtpFactory?: SmtpTransportFactory;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** Test hook — skip the debounce / retry sleeps so suites run fast. */
  sleep?: (ms: number) => Promise<void>;
  /** D-127 P1.5 — Message-Id UUID generator hook. Defaults to
   *  `node:crypto.randomUUID`. Tests inject a deterministic value. */
  messageIdUuid?: () => string;
  /** Durable pair-local journal for live IDLE notifications: IMAP pushes a
   *  notification once, so a callback rejection must be remembered explicitly
   *  until the collection acknowledges it. It also keeps each folder's UID
   *  cursor (`imap.<slug>.cursor.<folder>`). Production always supplies the
   *  shared account store. */
  deliveryStore?: OAuthAccountStore;
}

// ────────────────────────────────────────────────────────────────
// D-127 P1.5 — outbound send constants + helpers
// ────────────────────────────────────────────────────────────────

/** Default SMTP submission port (RFC 6409, STARTTLS). 465 is implicit
 *  TLS; 25 is unauth + relay (rejected by all modern submission
 *  hosts). */
export const DEFAULT_SMTP_PORT = 587;

/** Sent-folder name candidates for IMAP servers that don't expose
 *  the standard `\Sent` special-use flag. Tried in order; the first
 *  match in the listed mailboxes wins. `INBOX.Sent` is the
 *  Cyrus / Courier prefix style. */
/** D-264 — the `\Drafts` twin of the Sent chain. Same shape and same reason:
 *  RFC 6154 special-use is authoritative where the server publishes it, and
 *  these are the names in the wild when it does not. */
export const IMAP_DRAFTS_FOLDER_FALLBACK_CANDIDATES = [
  'Drafts',
  'Draft',
  'INBOX.Drafts',
  '[Gmail]/Drafts',
] as const;

export const IMAP_SENT_FOLDER_FALLBACK_CANDIDATES = [
  'Sent',
  'Sent Items',
  'Sent Messages',
  'INBOX.Sent',
  // D-318 audit — a server that advertises no `\\Sent` folder names it in the
  // mailbox's own language.
  'Gesendet',
  'Gesendete Elemente',
  'INBOX.Gesendet',
  'Envoyés',
  'Éléments envoyés',
  'Enviados',
  'Elementos enviados',
  'Posta inviata',
  'Verzonden items',
  'Skickat',
  'Sendt',
] as const;

/** D-127 P1.5 — discover the Sent folder. RFC 6154 special-use
 *  `\Sent` flag wins; otherwise the first match against the known
 *  fallback candidate list (case-sensitive, mirrors what most
 *  modern servers expose). Returns null when no candidate matches —
 *  caller surfaces that as an APPEND warning. */
/** Special-use flag first, then a name-fallback chain. Shared by the Sent and
 *  Drafts lookups so the two cannot drift in how they resolve a folder — only
 *  in WHICH folder they resolve. */
const findSpecialUseFolder = async (
  client: ImapClient,
  specialUse: string,
  fallbacks: readonly string[],
): Promise<string | null> => {
  if (typeof client.list !== 'function') return null;
  const list = await client.list();
  const flagged = list.find((box) => box.specialUse === specialUse);
  if (flagged) return flagged.path;
  const known = new Set(list.map((box) => box.path));
  for (const candidate of fallbacks) {
    if (known.has(candidate)) return candidate;
  }
  return null;
};

export const findSentFolder = async (
  client: ImapClient,
): Promise<string | null> =>
  findSpecialUseFolder(client, '\\Sent', IMAP_SENT_FOLDER_FALLBACK_CANDIDATES);

/** D-264 — where a parked draft goes. */
export const findDraftsFolder = async (
  client: ImapClient,
): Promise<string | null> =>
  findSpecialUseFolder(client, '\\Drafts', IMAP_DRAFTS_FOLDER_FALLBACK_CANDIDATES);

// ────────────────────────────────────────────────────────────────
// Canonicalization helpers
// ────────────────────────────────────────────────────────────────

const addressToStringList = (v: AddressObject | AddressObject[] | undefined): string[] => {
  if (!v) return [];
  const entries = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const a of entries) {
    for (const item of a.value) {
      if (item.address) out.push(item.address);
    }
  }
  return out;
};

const firstAddress = (v: AddressObject | AddressObject[] | undefined): string =>
  addressToStringList(v)[0] ?? '';

const stripAngleBrackets = (id: string): string => {
  if (id.startsWith('<') && id.endsWith('>')) return id.slice(1, -1);
  return id;
};

const deriveThreadId = (parsed: ParsedMail): string => {
  // Classic RFC-5322 thread reconstruction: root of the References
  // chain if present, else In-Reply-To, else the Message-ID itself.
  // Strip angle brackets so IMAP thread_ids match the bare-id shape
  // Gmail's threadId + Graph's conversationId expose.
  if (Array.isArray(parsed.references) && parsed.references.length > 0) {
    return stripAngleBrackets(parsed.references[0]);
  }
  if (typeof parsed.references === 'string' && parsed.references) {
    return stripAngleBrackets(parsed.references);
  }
  if (parsed.inReplyTo) return stripAngleBrackets(parsed.inReplyTo);
  if (parsed.messageId) return stripAngleBrackets(parsed.messageId);
  return '';
};

const bodyTextFor = (parsed: ParsedMail): string => {
  if (parsed.text && parsed.text.length > 0) return parsed.text;
  // Don't drag in html-to-text transitively — mailparser already
  // populates `textAsHtml`, but that's HTML with formatting. For the
  // FTS-indexed body we want plain text; strip tags with a cheap
  // fallback. Users with HTML-only messages still get searchable
  // content.
  // A tag ends before the next `<`: `[^>]` retried from every `<` of a broken
  // email to its end: 500 KB of them took nine seconds.
  if (parsed.html) return String(parsed.html).replace(/<[^<>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
};

const hasAttachments = (parsed: ParsedMail): boolean =>
  Array.isArray(parsed.attachments)
    && parsed.attachments.some((a) => Boolean(a.filename));

const sourceIdFor = (uid: number, folder: string): string => `${uid}@${folder}`;

/** UIDs per `UID SEARCH` when a catch-up asks which known messages remain. */
const CATCH_UP_UID_CHUNK = 500;

/** UIDVALIDITY as text (imapflow hands back a bigint), `null` if absent. */
const uidValidityOf = (box: MailboxObject | undefined): string | null => {
  const value = (box as { uidValidity?: unknown } | undefined)?.uidValidity;
  return typeof value === 'bigint' || typeof value === 'number' ? String(value) : null;
};
/** UIDNEXT, `null` if absent or not a positive integer. */
const uidNextOf = (box: MailboxObject | undefined): number | null => {
  const value = (box as { uidNext?: unknown } | undefined)?.uidNext;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
};

type ImapMailboxIdentity = { path: string; specialUse?: string };

/** RFC 6154 special-use flags are language-neutral. `INBOX` is the one
 * RFC-reserved mailbox name and remains safe when LIST is unavailable. On a
 * server that flags no Sent or Drafts folder, the name the send and draft
 * lookups fall back to classifies too. All other unclassified/localized paths
 * stay unknown so downstream recipes can fail closed. */
export const imapMessageDirectionForMailbox = (
  folder: string,
  mailboxes: readonly ImapMailboxIdentity[] = [],
): MailMessageDirection => {
  const match = mailboxes.find((mailbox) => mailbox.path === folder)
    ?? mailboxes.find((mailbox) => (
      folder.toUpperCase() === 'INBOX' && mailbox.path.toUpperCase() === 'INBOX'
    ));
  switch ((match?.specialUse ?? '').toLowerCase()) {
    case '\\sent': return 'outbound';
    case '\\drafts': return 'draft';
    case '\\inbox': return 'inbound';
    default:
      if (folder.toUpperCase() === 'INBOX') return 'inbound';
      // D-315 §7.4 — on a server that flags no folder, the folder the Sent and
      // Drafts lookups fall back to (D-127, D-264) is that folder here too.
      if (fallbackFolder(mailboxes, '\\Sent', IMAP_SENT_FOLDER_FALLBACK_CANDIDATES) === folder) return 'outbound';
      if (fallbackFolder(mailboxes, '\\Drafts', IMAP_DRAFTS_FOLDER_FALLBACK_CANDIDATES) === folder) return 'draft';
      return 'unknown';
  }
};

/** The folder `findSpecialUseFolder` settles on by name: none when a folder
 *  carries the flag (that one is the folder), else the first candidate the
 *  server lists. */
const fallbackFolder = (
  mailboxes: readonly ImapMailboxIdentity[],
  specialUse: string,
  fallbacks: readonly string[],
): string | null => {
  if (mailboxes.some((mailbox) => (mailbox.specialUse ?? '').toLowerCase() === specialUse.toLowerCase())) return null;
  const known = new Set(mailboxes.map((mailbox) => mailbox.path));
  return fallbacks.find((candidate) => known.has(candidate)) ?? null;
};

const parsedAttachmentParts = (parsed: ParsedMail): InboundMailAttachmentPart[] => {
  const parts: InboundMailAttachmentPart[] = [];
  for (const [idx, attachment] of (parsed.attachments ?? []).entries()) {
    const bytes = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(attachment.content ?? '');
    parts.push(mailAttachmentPartFromBytes({
      filename: attachment.filename ?? `attachment-${idx + 1}`,
      mime_type: attachment.contentType,
      source_part_id: `part-${idx}`,
      disposition: mailPartDisposition(attachment.contentDisposition, attachment.related === true),
      bytes,
    }));
  }
  return parts;
};

const parsedReconciliationAttachmentParts = (
  parsed: ParsedMail,
): InboundMailAttachmentPart[] => (parsed.attachments ?? []).map((attachment, idx) => {
  const bytes = Buffer.isBuffer(attachment.content)
    ? attachment.content
    : Buffer.from(attachment.content ?? '');
  return mailSentReconciliationAttachmentPartFromBytes({
    filename: attachment.filename,
    mime_type: attachment.contentType,
    source_part_id: `part-${idx}`,
    disposition: mailPartDisposition(attachment.contentDisposition, attachment.related === true),
    bytes,
  });
});

export const canonicalizeImap = async (
  source: Buffer,
  opts: {
    uid: number;
    folder: string;
    direction?: MailMessageDirection;
    flags: Set<string> | undefined;
    internalDate: Date | string | undefined;
  },
): Promise<CanonicalMessage> => {
  const parsed = await simpleParser(source);
  const attachments = parsedAttachmentParts(parsed);
  const reconciliationHeaderKey = MAIL_RECONCILIATION_ID_HEADER.toLowerCase();
  const reconciliationHeaderCount = parsed.headerLines.filter(
    (header) => header.key.toLowerCase() === reconciliationHeaderKey,
  ).length;
  const reconciliationId = reconciliationHeaderCount === 1
    ? parsed.headers.get(reconciliationHeaderKey)
    : undefined;
  const receivedAt = parsed.date instanceof Date
    ? parsed.date.getTime()
    : opts.internalDate instanceof Date
      ? opts.internalDate.getTime()
      : typeof opts.internalDate === 'string'
        ? Date.parse(opts.internalDate)
        : Date.now();
  const flags = opts.flags ?? new Set<string>();
  // D-318 step 1 — the server's own INTERNALDATE, kept beside the Date line.
  const providerReceivedAt = opts.internalDate instanceof Date
    ? opts.internalDate.getTime()
    : typeof opts.internalDate === 'string'
      ? Date.parse(opts.internalDate)
      : Number.NaN;
  return {
    source_id: sourceIdFor(opts.uid, opts.folder),
    rfc_message_id: parsed.messageId ?? undefined,
    ...(isMailReconciliationId(reconciliationId)
      ? { reconciliation_id: reconciliationId }
      : {}),
    from: parsed.from ? firstAddress(parsed.from) : '',
    from_name: mailParsedFromName(parsed.from),
    headers: mailParsedHeaderMap(parsed),
    to: addressToStringList(parsed.to),
    cc: addressToStringList(parsed.cc),
    subject: parsed.subject ?? '',
    thread_id: deriveThreadId(parsed),
    folder_or_label: opts.folder,
    direction: opts.direction ?? imapMessageDirectionForMailbox(opts.folder),
    is_read: flags.has('\\Seen'),
    is_flagged: flags.has('\\Flagged'),
    has_attachments: hasAttachments(parsed) || attachments.length > 0,
    received_at: Number.isFinite(receivedAt) ? receivedAt : Date.now(),
    ...(Number.isFinite(providerReceivedAt) ? { provider_received_at: providerReceivedAt } : {}),
    body_text: bodyTextFor(parsed),
    body_html: typeof parsed.html === 'string' ? parsed.html : undefined,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
};

// ────────────────────────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────────────────────────

interface FolderState {
  folder: string;
  direction: MailMessageDirection;
  /** The connection this folder was opened for: `close()` aborts it. Work for
   *  the folder (a reconnect, a catch-up, a delivery retry) stops on it rather
   *  than on `stopped` alone, which the next `connect()` clears again. */
  signal: AbortSignal;
  client: ImapClient | null;
  stopIdle: (() => void) | null;
  reconnectTask: Promise<void> | null;
  deliveryRetryTask: Promise<void> | null;
  pollTasks: Set<Promise<void>>;
  attempts: number;
  /** Fallback for servers that cannot emit QRESYNC VANISHED UIDs. Sequence
   *  numbers are mailbox positions, not identifiers, and shift on EXPUNGE. */
  seqToUid: Map<number, number>;
  /** UIDVALIDITY and UIDNEXT as the folder's last open reported them, `null`
   *  where the server did not: a catch-up fetches the UIDs from `uidNext` up. */
  uidValidity: string | null;
  uidNext: number | null;
  /** UIDs IDLE delivered while a catch-up runs, so the catch-up does not
   *  deliver the same message twice; `null` when none runs. */
  createdDuringCatchUp: Set<number> | null;
  /** The highest UID delivered as `created`: where IDLE moves the cursor. */
  highestCreated: number;
  /** The stored cursor's UIDNEXT (`imap.<slug>.cursor.<folder>`): every UID
   *  below it was delivered or known. `null` when none is stored for this
   *  folder's current UIDVALIDITY. */
  storedUidNext: number | null;
  /** Set when an IDLE batch failed: a lower UID may be unfetched, so the
   *  stored cursor waits for a catch-up to account for it. */
  cursorHeld: boolean;
  /** Whether live sync has started on this folder (`startSync`, or the
   *  reconnect that stood in for it). A folder whose connection closed before
   *  then is owed the start's catch-up, from the stored cursor. */
  syncStarted: boolean;
}

interface PendingImapDelivery {
  schema_version: 1;
  folder: string;
  uid: number;
  kind: ProviderSyncEventKind;
}

type ImapFetchAddressing = 'uid' | 'sequence';

const DEFAULT_IDLE_MS = 28 * 60 * 1000;
const DEFAULT_RECONNECT_CAP_MS = 60_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;

/** How long `close()` waits for a folder's LOGOUT before it closes the socket.
 *  An idle connection answers DONE + LOGOUT in a round trip or two; a LOGOUT
 *  still unanswered by then is queued behind a command or talking to a server
 *  that has gone quiet, and closing destroys the socket either way. Half of
 *  `STOP_GRACE_MS`, so what the closed socket rejects can unwind inside it. */
export const IMAP_LOGOUT_GRACE_MS = 500;

/** Timeouts for a one-off client (`makeClient(…, { lookup: true })`), the ones
 *  password repair's verification client uses: imapflow's own defaults are
 *  90 s to connect and 5 minutes of silence, and a lookup's caller waited that
 *  long on a server that had stopped answering. */
export const IMAP_LOOKUP_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 15_000,
} as const;

/** One header's value from a fetched header block (`fetch({ headers })`),
 *  unfolded, or `null`. */
const headerValueOf = (block: Buffer | string | undefined, name: string): string | null => {
  if (block === undefined) return null;
  const unfolded = String(block).replace(/\r?\n[ \t]+/g, ' ');
  const line = unfolded.split(/\r?\n/).find((entry) => entry.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  const value = line?.slice(name.length + 1).trim();
  return value ? value : null;
};

export const createImapProvider = (
  opts: CreateImapProviderOptions,
): MailProvider => {
  const clientFactory = opts.clientFactory ?? defaultImapClientFactory;
  const smtpFactory = opts.smtpFactory ?? defaultSmtpTransportFactory;
  const messageIdUuid = opts.messageIdUuid ?? randomUUID;
  const nowOf = (): number => opts.now?.() ?? Date.now();
  const sleepOf = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));

  const folders = new Map<string, FolderState>();
  const pendingDeliveries = new Map<string, PendingImapDelivery>();
  const deliveriesInFlight = new Map<string, Promise<void>>();
  let pendingDeliveriesLoaded = false;
  let lastBackfillDays: number | null = null;
  let connected = false;
  let lastSuccessfulSyncAt = 0;
  let errorCount24h = 0;
  let pendingQueueSize = 0;
  let stopped = false;
  /** Aborted by `close()`, armed again by `connect()`; each folder's state
   *  keeps the signal it was opened under (`FolderState.signal`). */
  let session = new AbortController();
  /** Clients still connecting. They are in `folders` only once every folder
   *  has opened, so `close()` reaches them here — closing one fails the
   *  connect it belongs to rather than leaving it to open after the stop. */
  const connecting = new Set<ImapClient>();
  /** Commands of ours in flight, per client. A LOGOUT queues behind them —
   *  behind the rest of a first scan's FETCH, which imapflow reads to its end
   *  even once we stop consuming it — so `close()` skips LOGOUT on a busy
   *  client and closes its socket at once. */
  const busy = new WeakMap<ImapClient, number>();
  const cancelReconnectDelays = new Set<() => void>();

  /** A folder whose connection was closed: none of its work may go on. */
  const retired = (state: FolderState): boolean => stopped || state.signal.aborted;

  const occupy = async <T>(client: ImapClient, run: () => Promise<T>): Promise<T> => {
    busy.set(client, (busy.get(client) ?? 0) + 1);
    try {
      return await run();
    } finally {
      const left = (busy.get(client) ?? 1) - 1;
      if (left > 0) busy.set(client, left);
      else busy.delete(client);
    }
  };

  const waitForReconnectDelay = async (ms: number): Promise<void> => {
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
    cancelReconnectDelays.add(cancel);
    try {
      await Promise.race([sleepOf(ms), cancelled]);
    } finally {
      cancelReconnectDelays.delete(cancel);
    }
  };

  const markError = (msg: string, err: unknown): void => {
    errorCount24h++;
    opts.log?.('warn', msg, { err: err instanceof Error ? err.message : String(err) });
  };

  /** `lookup`: a one-off client — a Sent lookup, one message read again, a
   *  mutation, a capability probe — that runs a few commands and logs out. It
   *  gets `IMAP_LOOKUP_TIMEOUTS`. ⛔ Never a folder's sync client: its IDLE
   *  connection is quiet for minutes by design, and a 15 s socket timeout would
   *  end it.
   *
   *  ⛔ Every client listens for `'error'` from the moment it exists. Once
   *  `connect()` has resolved, imapflow reports a reset socket, a socket timeout
   *  or a protocol failure as an `'error'` event, and an emitter with no
   *  `'error'` listener throws it — out of a socket callback, so the whole
   *  server goes. A folder's client listened only once `startSync` attached its
   *  listeners, so a connection reset during the first scan (minutes, for a
   *  large mailbox), while a reconnect opened the folder, or during the LOGOUT
   *  at a stop crashed the server. The failure is handled where it lands: the
   *  command the closed socket rejects fails its caller, and a sync connection
   *  that closed is reconnected (`attachListeners`' `'close'`, or `startSync`
   *  for one that closed before sync started). */
  const makeClient = (folder: string, { lookup = false }: { lookup?: boolean } = {}): ImapClient => {
    const cfg = opts.config();
    const client = clientFactory({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.username, pass: cfg.password },
      maxIdleTime: cfg.maxIdleTime ?? DEFAULT_IDLE_MS,
      // VANISHED carries a stable UID. Without QRESYNC a plain EXPUNGE only
      // carries a shifting sequence number; we retain a conservative mapping
      // fallback below, but never fabricate a UID from the sequence itself.
      qresync: true,
      logger: false,
      ...(lookup ? IMAP_LOOKUP_TIMEOUTS : {}),
    });
    client.on('error', (err: unknown) => {
      // A lookup's failure is its caller's to count.
      if (lookup) {
        opts.log?.('warn', `imap ${folder} connection failed`, {
          err: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      markError(`imap client error folder=${folder}`, err);
    });
    return client;
  };

  /** End a client's session within `IMAP_LOGOUT_GRACE_MS`: LOGOUT when it is
   *  idle, then close the socket regardless. Closing destroys the socket and
   *  rejects every command still queued on it, so whatever was waiting on the
   *  client settles at once instead of after imapflow's 5-minute socket
   *  timeout. */
  const endSession = async (client: ImapClient, folder: string): Promise<void> => {
    if (client.usable && !busy.has(client)) {
      const loggedOut = (async () => client.logout())().catch((err: unknown) => {
        markError(`imap logout failed folder=${folder}`, err);
      });
      await settleWithin(loggedOut, IMAP_LOGOUT_GRACE_MS);
    }
    try { client.close(); } catch { /* already closed */ }
  };

  /** A folder's UIDs matching `query`. imapflow's `search` answers `undefined`
   *  on a client whose connection is gone and `false` when the command failed;
   *  neither is an empty folder. Read as one, a catch-up moved the cursor past
   *  mail it never listed, or reported every message it asked about as
   *  deleted. */
  const listUids = async (client: ImapClient, query: SearchObject): Promise<number[]> => {
    const found = await client.search(query, { uid: true });
    if (!Array.isArray(found)) throw new Error('imap search returned no result: the folder is not open');
    return found;
  };

  const resolveFolderDirection = async (
    client: ImapClient,
    folder: string,
  ): Promise<MailMessageDirection> => {
    if (folder.toUpperCase() === 'INBOX') return 'inbound';
    if (typeof client.list !== 'function') return 'unknown';
    try {
      return imapMessageDirectionForMailbox(folder, await client.list());
    } catch (err) {
      // Direction enrichment is safety metadata, not a reason to take an
      // otherwise readable mailbox offline. Unknown is fail-closed downstream.
      opts.log?.('warn', `imap LIST failed while classifying folder=${folder}`, {
        err: err instanceof Error ? err.message : String(err),
      });
      return 'unknown';
    }
  };

  /** Is this an IMAP AUTHENTICATION failure (wrong password, app-password
   *  revoked) rather than a transport one?
   *
   *  `imapflow` throws an `AuthenticationFailure` subclass carrying
   *  `authenticationFailed = true`, and tags enhanced errors with
   *  `serverResponseCode` (`imapflow/lib/tools.js`) — both STRUCTURAL fields, so
   *  this is not a message-text match. Anything unrecognized is `'transient'` ON
   *  PURPOSE: telling users to re-enter working credentials because a socket
   *  dropped teaches them to re-auth reflexively, which is a worse failure than
   *  a slow "degraded". */
  const isImapAuthFailure = (err: unknown): boolean => {
    if (typeof err !== 'object' || err === null) return false;
    const e = err as {
      authenticationFailed?: unknown;
      serverResponseCode?: unknown;
      code?: unknown;
    };
    if (e.authenticationFailed === true) return true;
    if (e.serverResponseCode === 'AUTHENTICATIONFAILED') return true;
    // `EAUTH` is nodemailer's SMTP-side code — an SMTP-shaped error can reach
    // here when a credential is shared with the send path.
    return e.code === 'EAUTH';
  };

  /** Per-attempt outcome reporting — see `MailSyncOutcome` in provider.ts.
   *
   *  IMAP reports `initial_scan` and `reconnect` only. It is IDLE-driven, so
   *  there is no periodic poll attempt to report and inventing one would be a
   *  fabricated signal: its liveness IS the open connection, and losing that
   *  surfaces here as a `reconnect` outcome. */
  const outcomes = createMailSyncOutcomeReporter({
    now: nowOf,
    classifyError: (err): MailSyncFailureKind =>
      isImapAuthFailure(err) ? 'auth' : 'transient',
  });

  /** Folders currently known to be DISCONNECTED, with why.
   *
   *  ⚠ A `MailSyncOutcome` carries no folder identity, and the consumer treats
   *  any `ok` as proof the mailbox is working. One client per folder means Inbox
   *  can reconnect while Archive is still down — and reporting Inbox's success
   *  provider-wide would clear a state that is still true, then flap as the
   *  Archive retry loop re-reports it. So reconnect success is reported only when
   *  NO folder is left down. */
  const downFolders = new Map<string, MailSyncFailureKind>();

  /** Report a folder's reconnect result, aggregated across folders. A failure is
   *  always reported (it is true the moment it happens, and `auth` outranks
   *  `transient` so a bad credential is never masked by a flaky socket). */
  const reportReconnect = (
    folder: string,
    ok: boolean,
    failure?: MailSyncFailureKind,
  ): void => {
    if (ok) {
      downFolders.delete(folder);
      if (downFolders.size > 0) return; // another folder is still offline
      outcomes.report('reconnect', true);
      return;
    }
    downFolders.set(folder, failure ?? 'transient');
    const worst = [...downFolders.values()].includes('auth') ? 'auth' : 'transient';
    outcomes.report('reconnect', false, worst);
  };

  const pendingDeliveryPrefix = `imap.${opts.slug}.pending_delivery.`;
  const pendingDeliveryKey = (delivery: PendingImapDelivery): string =>
    `${pendingDeliveryPrefix}${Buffer.from(delivery.folder, 'utf8').toString('base64url')}.${delivery.uid}.${delivery.kind}`;

  const isPendingDelivery = (value: unknown): value is PendingImapDelivery => {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<PendingImapDelivery>;
    return candidate.schema_version === 1
      && typeof candidate.folder === 'string'
      && candidate.folder.length > 0
      && Number.isSafeInteger(candidate.uid)
      && (candidate.uid ?? 0) > 0
      && (candidate.kind === 'created'
        || candidate.kind === 'updated'
        || candidate.kind === 'deleted');
  };

  const loadPendingDeliveries = async (): Promise<void> => {
    if (pendingDeliveriesLoaded) return;
    if (!opts.deliveryStore?.getAll) {
      pendingDeliveriesLoaded = true;
      return;
    }
    let all: Record<string, string>;
    try {
      all = await opts.deliveryStore.getAll();
    } catch (err) {
      markError('imap pending-delivery journal read failed', err);
      throw err;
    }
    const invalidRows: unknown[] = [];
    for (const [key, raw] of Object.entries(all)) {
      if (!key.startsWith(pendingDeliveryPrefix)) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isPendingDelivery(parsed) || pendingDeliveryKey(parsed) !== key) {
          throw new Error('journal key/value mismatch');
        }
        pendingDeliveries.set(key, parsed);
      } catch (err) {
        // Retain malformed rows for inspection instead of silently deleting
        // the only durable evidence that a notification was not acknowledged.
        markError(`imap pending-delivery journal row invalid key=${key}`, err);
        invalidRows.push(err);
      }
    }
    pendingDeliveriesLoaded = true;
    if (invalidRows.length > 0) {
      throw new AggregateError(
        invalidRows,
        'imap pending-delivery journal contains invalid rows',
      );
    }
  };

  const rememberDelivery = async (delivery: PendingImapDelivery): Promise<string> => {
    const key = pendingDeliveryKey(delivery);
    if (pendingDeliveries.has(key)) return key;
    // Persist before invoking the collection callback. A crash after this write
    // produces a harmless duplicate; a crash before it cannot be called an ack.
    await opts.deliveryStore?.set(key, JSON.stringify(delivery));
    pendingDeliveries.set(key, delivery);
    return key;
  };

  const forgetDelivery = async (key: string): Promise<void> => {
    // Delete durably before removing the in-memory row. If this write fails the
    // callback may replay, preserving at-least-once semantics.
    await opts.deliveryStore?.delete(key);
    pendingDeliveries.delete(key);
  };

  /** A folder's UID cursor, kept beside the delivery journal so a restart can
   *  fetch what was added while the server was down, moved-in mail included,
   *  whatever its date. Outside `pending_delivery.` (its loader refuses rows it
   *  cannot read); removing the mailbox removes every `imap.<slug>.` key. */
  const cursorKey = (folder: string): string =>
    `imap.${opts.slug}.cursor.${Buffer.from(folder, 'utf8').toString('base64url')}`;

  /** The stored UIDNEXT, or `null` when none is stored, it cannot be read, or
   *  it was kept under another UIDVALIDITY (every UID then names another
   *  message, and only a full re-list reads the folder again). */
  const loadCursor = async (folder: string, uidValidity: string | null): Promise<number | null> => {
    if (!opts.deliveryStore || uidValidity === null) return null;
    let raw: string | null;
    try {
      raw = await opts.deliveryStore.get(cursorKey(folder));
    } catch (err) {
      markError(`imap cursor read failed folder=${folder}`, err);
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { schema_version?: unknown; uid_validity?: unknown; uid_next?: unknown };
      if (parsed.schema_version !== 1 || parsed.uid_validity !== uidValidity) return null;
      const next = parsed.uid_next;
      return typeof next === 'number' && Number.isSafeInteger(next) && next > 0 ? next : null;
    } catch {
      return null;
    }
  };

  /** Moves a folder's stored cursor up to `uidNext`, once every UID below it
   *  was delivered or known. Never back, and not while `cursorHeld`. */
  const advanceCursor = async (state: FolderState, uidNext: number): Promise<void> => {
    // A closed connection's view of the folder moves no cursor: what it did not
    // reach before the close, the next start fetches from here.
    if (!opts.deliveryStore || state.uidValidity === null || state.cursorHeld || retired(state)) return;
    if (state.storedUidNext !== null && uidNext <= state.storedUidNext) return;
    try {
      await opts.deliveryStore.set(cursorKey(state.folder), JSON.stringify({
        schema_version: 1,
        uid_validity: state.uidValidity,
        uid_next: uidNext,
      }));
      state.storedUidNext = uidNext;
    } catch (err) {
      markError(`imap cursor write failed folder=${state.folder}`, err);
    }
  };

  const deliverAcknowledged = async (
    delivery: PendingImapDelivery,
    event: Parameters<ProviderSyncCallback>[0],
    cb: ProviderSyncCallback,
  ): Promise<void> => {
    const key = await rememberDelivery(delivery);
    const existing = deliveriesInFlight.get(key);
    if (existing) return existing;
    const task = (async (): Promise<void> => {
      await cb(event);
      await forgetDelivery(key);
      lastSuccessfulSyncAt = nowOf();
    })();
    deliveriesInFlight.set(key, task);
    try {
      await task;
    } finally {
      if (deliveriesInFlight.get(key) === task) deliveriesInFlight.delete(key);
    }
  };

  const fetchAndEmit = async (
    state: FolderState,
    identifier: number,
    kind: ProviderSyncEventKind,
    cb: ProviderSyncCallback,
    addressing: ImapFetchAddressing = 'uid',
  ): Promise<boolean> => {
    if (!state.client) return false;
    pendingQueueSize++;
    try {
      if (kind === 'deleted') {
        const delivery: PendingImapDelivery = {
          schema_version: 1,
          folder: state.folder,
          uid: identifier,
          kind,
        };
        await deliverAcknowledged(
          delivery,
          { kind: 'deleted', source_id: sourceIdFor(identifier, state.folder) },
          cb,
        );
        return true;
      }

      const mappedUid = addressing === 'sequence'
        ? state.seqToUid.get(identifier)
        : identifier;
      const preJournalKey = addressing === 'uid'
        ? await rememberDelivery({
            schema_version: 1,
            folder: state.folder,
            uid: identifier,
            kind,
          })
        : undefined;
      const client = state.client;
      if (!client) return false;
      const iter = client.fetch(
        addressing === 'uid' ? [identifier] : String(identifier),
        { uid: true, flags: true, envelope: true, internalDate: true, source: true },
        ...(addressing === 'uid' ? [{ uid: true }] : []),
      );
      let found = false;
      await occupy(client, async () => {
        for await (const msg of iter) {
          if (retired(state)) throw new CollectionStoppedError();
          found = true;
          if (!Number.isSafeInteger(msg.uid) || msg.uid <= 0) {
            throw new Error(`imap FETCH returned an invalid UID for ${addressing}=${identifier}`);
          }
          if (Number.isSafeInteger(msg.seq) && msg.seq > 0) {
            state.seqToUid.set(msg.seq, msg.uid);
          }
          const delivery: PendingImapDelivery = {
            schema_version: 1,
            folder: state.folder,
            uid: msg.uid,
            kind,
          };
          // Once FETCH reveals the stable UID, persist the notification before
          // parsing its body. A malformed/transient canonicalization failure is
          // just as retryable as a rejected collection callback.
          await rememberDelivery(delivery);
          if (!msg.source) {
            throw new Error(`imap FETCH returned no source for uid=${msg.uid}`);
          }
          const canonical = await canonicalizeImap(msg.source, {
            uid: msg.uid,
            folder: state.folder,
            direction: state.direction,
            flags: msg.flags,
            internalDate: msg.internalDate,
          });
          await deliverAcknowledged(
            delivery,
            { kind, source_id: canonical.source_id, message: canonical },
            cb,
          );
          if (kind === 'created') {
            state.createdDuringCatchUp?.add(msg.uid);
            state.highestCreated = Math.max(state.highestCreated, msg.uid);
          }
        }
      });
      if (!found) {
        // A closed connection's FETCH comes back empty rather than failing: that
        // is no message expunged meanwhile. Not delivered, so its journal row
        // stays for the retry or the next start.
        if (retired(state) || !client.usable) {
          throw new Error(`imap connection closed before FETCH answered ${addressing}=${identifier}`);
        }
        // A flags/update notification can race an EXPUNGE. If we already knew
        // the stable UID, converge the mirror with a tombstone; for a brand-new
        // sequence with no UID there is nothing safe to fabricate.
        if (mappedUid !== undefined) {
          const deletedDelivery: PendingImapDelivery = {
            schema_version: 1,
            folder: state.folder,
            uid: mappedUid,
            kind: 'deleted',
          };
          await deliverAcknowledged(
            deletedDelivery,
            { kind: 'deleted', source_id: sourceIdFor(mappedUid, state.folder) },
            cb,
          );
          if (preJournalKey && preJournalKey !== pendingDeliveryKey(deletedDelivery)) {
            await forgetDelivery(preJournalKey);
          }
        } else {
          throw new Error(`imap FETCH returned no message for ${addressing}=${identifier}`);
        }
      }
      return true;
    } catch (err) {
      // Closed meanwhile: not delivered, and no failure of the mailbox's. Its
      // journal row, if it has one, waits for the next start.
      if (retired(state)) return false;
      // The journal row remains when the callback or its durable cleanup fails.
      // Return false so the owned retry loop is admitted without terminating
      // the IDLE listener for unrelated messages.
      outcomes.noteFailure(isImapAuthFailure(err) ? 'auth' : 'transient');
      markError(`imap delivery failed ${addressing}=${identifier} folder=${state.folder}`, err);
      return false;
    } finally {
      pendingQueueSize = Math.max(0, pendingQueueSize - 1);
    }
  };

  const drainPendingDeliveries = async (
    state: FolderState,
    cb: ProviderSyncCallback,
  ): Promise<boolean> => {
    let allAcknowledged = true;
    const pending = [...pendingDeliveries.values()]
      .filter((delivery) => delivery.folder === state.folder);
    for (const delivery of pending) {
      if (retired(state)) return false;
      const ok = await fetchAndEmit(state, delivery.uid, delivery.kind, cb, 'uid');
      if (!ok) allAcknowledged = false;
    }
    return allAcknowledged;
  };

  const deliveryRetryLoop = async (
    state: FolderState,
    cb: ProviderSyncCallback,
  ): Promise<void> => {
    let attempts = 0;
    while (!retired(state) && [...pendingDeliveries.values()].some(
      (delivery) => delivery.folder === state.folder,
    )) {
      if (retired(state)) return;
      if (attempts > 0) {
        const cfg = opts.config();
        const cap = cfg.reconnectCapMs ?? DEFAULT_RECONNECT_CAP_MS;
        const init = cfg.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
        await waitForReconnectDelay(Math.min(init * Math.pow(2, attempts - 1), cap));
        if (retired(state)) return;
      }
      attempts++;
      await outcomes.run('poll', async () => {
        await drainPendingDeliveries(state, cb);
      });
      if (retired(state)) return;
    }
  };

  const scheduleDeliveryRetry = (
    state: FolderState,
    cb: ProviderSyncCallback,
  ): void => {
    if (
      retired(state)
      || state.deliveryRetryTask
      || ![...pendingDeliveries.values()].some((delivery) => delivery.folder === state.folder)
    ) return;
    let task!: Promise<void>;
    task = deliveryRetryLoop(state, cb)
      .catch((err) => {
        if (!retired(state)) markError(`imap delivery retry failed folder=${state.folder}`, err);
      })
      .finally(() => {
        if (state.deliveryRetryTask === task) state.deliveryRetryTask = null;
      });
    state.deliveryRetryTask = task;
  };

  /** Every message the folder holds and its flags, in one `UID FETCH 1:*
   *  (FLAGS)` (`MailFolderSnapshot`). `null` when the read cannot be taken for
   *  the whole folder: fewer messages than the folder said it held, or a
   *  client that does not say. */
  const readFolder = async (state: FolderState, client: ImapClient): Promise<MailFolderSnapshot | null> => {
    const read_at = nowOf();
    const heldBefore = client.mailbox ? client.mailbox.exists : undefined;
    if (typeof heldBefore !== 'number') return null;
    const messages = new Map<string, { is_read: boolean; is_flagged: boolean }>();
    if (heldBefore > 0) {
      await occupy(client, async () => {
        for await (const msg of client.fetch('1:*', { uid: true, flags: true }, { uid: true })) {
          // A read cut short is no snapshot: the collection would take every
          // message it did not reach for deleted.
          if (retired(state)) throw new CollectionStoppedError();
          if (!Number.isSafeInteger(msg.uid) || msg.uid <= 0) continue;
          const flags = msg.flags ?? new Set<string>();
          messages.set(sourceIdFor(msg.uid, state.folder), {
            is_read: flags.has('\\Seen'),
            is_flagged: flags.has('\\Flagged'),
          });
        }
      });
    }
    // A message can arrive or go during the read; fewer than both counts is a
    // short read, and a short read would take what it missed for deleted.
    const heldAfter = client.mailbox ? client.mailbox.exists : undefined;
    if (typeof heldAfter !== 'number' || messages.size < Math.min(heldBefore, heldAfter)) {
      markError(`imap folder read was short folder=${state.folder} read=${messages.size} held=${heldBefore}`, null);
      return null;
    }
    return { folder: state.folder, read_at, messages };
  };

  /** Mail that arrived, and mail removed, while a folder was not listening.
   *  IDLE reports only what happens while it is attached: a reconnect brought
   *  the folder back with what came in meanwhile counted into its size and
   *  never fetched, so that mail waited for a restart's re-list; and a message
   *  expunged meanwhile stayed in the warehouse. `startSync` has the same gap
   *  between the first scan's listing and IDLE attaching.
   *
   *  New: the UIDs from the last open's UIDNEXT up that nothing delivered
   *  (`known`, the UIDs the folder held before it stopped listening, and what
   *  IDLE has delivered since this open). Gone: a known UID the window no
   *  longer lists is asked about by UID first, because a message that only aged
   *  out of the window is still there. After a restart (`reconcile`), first the
   *  flags of every message, for the collection to check its rows against
   *  (`readFolder`). Runs after the listeners attach, so nothing that arrives
   *  meanwhile is missed; one batch, one `poll` attempt. */
  const startCatchUp = (
    state: FolderState,
    cb: ProviderSyncCallback,
    args: {
      from: number | null;
      known: ReadonlySet<number>;
      goneCandidates: readonly number[];
      /** After a restart: reconcile the folder's stored rows (`readFolder`). */
      reconcile?: boolean;
    },
  ): void => {
    const client = state.client;
    if (!client || (args.from === null && args.goneCandidates.length === 0 && !args.reconcile)) return;
    // Opened before any await: IDLE was attached just before this call, and
    // whatever it delivers from here on is recorded for the loop below.
    const deliveredByIdle = new Set<number>();
    state.createdDuringCatchUp = deliveredByIdle;
    let task!: Promise<void>;
    task = outcomes.run('poll', () => occupy(client, async () => {
      let acknowledged = true;
      let highestSeen = 0;
      if (args.reconcile) {
        // The flags changed and the messages deleted while the server was
        // down. Not held like a delivery: the next start reads the folder
        // again, and the cursor does not depend on it.
        try {
          const snapshot = await readFolder(state, client);
          if (retired(state) || state.client !== client) return;
          if (snapshot) await cb({ kind: 'folder', source_id: state.folder, folder: snapshot });
        } catch (err) {
          if (!retired(state)) markError(`imap folder reconcile failed folder=${state.folder}`, err);
        }
      }
      if (args.from !== null) {
        if (retired(state) || state.client !== client) return;
        const from = args.from;
        const listed = await listUids(client, { uid: `${from}:*` });
        // `N:*` names the highest UID even when it is below N.
        const fresh = listed
          .filter((uid) => uid >= from && !args.known.has(uid))
          .sort((a, b) => a - b);
        for (const uid of listed) highestSeen = Math.max(highestSeen, uid);
        for (const uid of fresh) {
          if (retired(state) || state.client !== client) return;
          if (deliveredByIdle.has(uid)) continue;
          if (!(await fetchAndEmit(state, uid, 'created', cb))) acknowledged = false;
        }
      }
      for (let i = 0; i < args.goneCandidates.length; i += CATCH_UP_UID_CHUNK) {
        if (retired(state) || state.client !== client) return;
        const chunk = args.goneCandidates.slice(i, i + CATCH_UP_UID_CHUNK);
        const still = new Set(await listUids(client, { uid: chunk.join(',') }));
        for (const uid of chunk) {
          if (still.has(uid)) continue;
          if (!(await fetchAndEmit(state, uid, 'deleted', cb))) acknowledged = false;
        }
      }
      if (!acknowledged) {
        scheduleDeliveryRetry(state, cb);
        return;
      }
      // Closed or reconnected meanwhile: what this pass listed is not the whole
      // folder, and the cursor waits for the next one.
      if (retired(state) || state.client !== client) return;
      // Every UID below this open's UIDNEXT, and every one just listed, is now
      // delivered or known, and IDLE carries on from here: the stored cursor
      // moves up, and an earlier failed IDLE batch no longer holds it.
      if (state.uidNext !== null) {
        state.cursorHeld = false;
        await advanceCursor(state, Math.max(state.uidNext, highestSeen + 1));
      }
    })).catch((err) => {
      if (!retired(state)) markError(`imap catch-up failed folder=${state.folder}`, err);
    }).finally(() => {
      if (state.createdDuringCatchUp === deliveredByIdle) state.createdDuringCatchUp = null;
      state.pollTasks.delete(task);
    });
    state.pollTasks.add(task);
  };

  const attachListeners = (
    state: FolderState,
    cb: ProviderSyncCallback,
  ): (() => void) => {
    const client = state.client;
    if (!client) return () => { /* nothing to detach */ };

    // Each IDLE notification is one `poll` attempt. Without this the live path
    // reported NOTHING: `fetchAndEmit` swallows into `markError` and the
    // listeners launch it with `void`, so an established connection could fail
    // every FETCH indefinitely while the collection stayed 'healthy'. An EXISTS
    // covering N messages is ONE attempt, not N — the user experiences "did my
    // mail arrive", and N outcomes would also defeat the consumer's throttle.
    const pollBatch = (run: () => Promise<boolean>): void => {
      let task!: Promise<void>;
      task = outcomes.run('poll', async () => {
        const acknowledged = await run();
        if (!acknowledged) scheduleDeliveryRetry(state, cb);
      }).catch((err) => {
        // `run` rethrows; nothing above this is listening, and the outcome has
        // already been emitted, so this only keeps the rejection unhandled-safe.
        markError(`imap idle batch failed folder=${state.folder}`, err);
      }).finally(() => {
        state.pollTasks.delete(task);
      });
      state.pollTasks.add(task);
    };

    const onExists = (data: { count: number; prevCount: number }): void => {
      // EXISTS exposes mailbox counts; prevCount+1..count are SEQUENCE
      // positions, never UIDs. FETCH by sequence and journal the stable UID it
      // returns before acknowledging the notification.
      pollBatch(async () => {
        let allAcknowledged = true;
        for (let seq = data.prevCount + 1; seq <= data.count; seq++) {
          if (!(await fetchAndEmit(state, seq, 'created', cb, 'sequence'))) {
            allAcknowledged = false;
          }
        }
        // Every new message of this batch is delivered, so the stored cursor
        // moves past them. A failed batch may leave a lower UID unfetched: the
        // cursor then waits for a catch-up.
        if (!allAcknowledged) state.cursorHeld = true;
        else if (state.highestCreated > 0) await advanceCursor(state, state.highestCreated + 1);
        return allAcknowledged;
      });
    };
    const onExpunge = (data: { uid?: number; seq?: number }): void => {
      const uid = data.uid ?? (data.seq === undefined ? undefined : state.seqToUid.get(data.seq));
      if (data.seq !== undefined) {
        const shifted = new Map<number, number>();
        for (const [seq, mappedUid] of state.seqToUid) {
          if (seq === data.seq) continue;
          shifted.set(seq > data.seq ? seq - 1 : seq, mappedUid);
        }
        state.seqToUid = shifted;
      } else if (uid !== undefined) {
        for (const [seq, mappedUid] of state.seqToUid) {
          if (mappedUid === uid) state.seqToUid.delete(seq);
        }
      }
      if (uid === undefined) {
        outcomes.report('poll', false, 'transient');
        markError(
          `imap expunge lacked a stable UID folder=${state.folder} seq=${String(data.seq)}`,
          null,
        );
        return;
      }
      pollBatch(() => fetchAndEmit(state, uid, 'deleted', cb));
    };
    const onFlags = (data: { uid?: number; seq: number }): void => {
      pollBatch(() => fetchAndEmit(
        state,
        data.uid ?? data.seq,
        'updated',
        cb,
        data.uid === undefined ? 'sequence' : 'uid',
      ));
    };
    const onClose = (): void => {
      if (retired(state)) return;
      scheduleReconnect(state, cb);
    };

    // No `'error'` listener here: every client has had one since it was made
    // (`makeClient`), and keeps it after these detach.
    client.on('exists', onExists);
    client.on('expunge', onExpunge);
    client.on('flags', onFlags);
    client.on('close', onClose);

    return (): void => {
      client.off('exists', onExists);
      client.off('expunge', onExpunge);
      client.off('flags', onFlags);
      client.off('close', onClose);
    };
  };

  const rebuildSequenceMap = async (state: FolderState): Promise<void> => {
    state.seqToUid.clear();
    const client = state.client;
    if (!client || lastBackfillDays === null) return;
    const since = new Date(nowOf() - lastBackfillDays * 86400_000);
    await occupy(client, async () => {
      const uids = await client.search({ since }, { uid: true });
      if (uids === false || uids.length === 0) return;
      const iter = client.fetch(uids, { uid: true }, { uid: true });
      for await (const msg of iter) {
        if (retired(state)) return;
        if (
          Number.isSafeInteger(msg.seq)
          && msg.seq > 0
          && Number.isSafeInteger(msg.uid)
          && msg.uid > 0
        ) {
          state.seqToUid.set(msg.seq, msg.uid);
        }
      }
    });
  };

  const reconnectLoop = async (
    state: FolderState,
    cb: ProviderSyncCallback,
  ): Promise<void> => {
    while (!retired(state)) {
      // Exponential backoff — capped so a bad credential or hard
      // outage doesn't spin at 60 s forever, but also doesn't retry
      // at full speed and trip rate limits. Initial 1 s → 2 → 4 → 8 →
      // 16 → 32 → cap 60. Matches Phase B audit retention + Phase C
      // lifecycle retry cadence.
      const cfg = opts.config();
      const cap = cfg.reconnectCapMs ?? DEFAULT_RECONNECT_CAP_MS;
      const init = cfg.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
      state.attempts++;
      const delay = Math.min(init * Math.pow(2, state.attempts - 1), cap);
      try {
        await waitForReconnectDelay(delay);
      } catch (err) {
        if (!retired(state)) markError(`imap reconnect delay failed folder=${state.folder}`, err);
        return;
      }
      if (retired(state)) return;

      let candidate: ImapClient | null = null;
      let box: MailboxObject | undefined;
      let known = new Set<number>();
      try {
        state.stopIdle?.();
      } catch { /* stale handle */ }
      state.stopIdle = null;
      if (state.client) {
        try { state.client.close(); } catch { /* stale transport */ }
        state.client = null;
      }

      try {
        candidate = makeClient(state.folder);
        state.client = candidate;
        await candidate.connect();
        if (retired(state)) {
          try { candidate.close(); } catch { /* shutdown containment */ }
          if (state.client === candidate) state.client = null;
          return;
        }
        const opened = candidate;
        await occupy(opened, async () => {
          state.direction = await resolveFolderDirection(opened, state.folder);
          throwIfStopped(state.signal);
          box = await opened.mailboxOpen(state.folder);
          throwIfStopped(state.signal);
        });
        // What the folder held before it stopped listening, for the catch-up.
        known = new Set(state.seqToUid.values());
        // Sequence positions can change while disconnected. Rebuild the
        // mapping for the same backfill window rather than carrying stale
        // positions into a non-QRESYNC EXPUNGE fallback.
        await rebuildSequenceMap(state);
        if (retired(state)) {
          try { candidate.close(); } catch { /* shutdown containment */ }
          if (state.client === candidate) state.client = null;
          return;
        }
      } catch (err) {
        try { candidate?.close(); } catch { /* failed attempt cleanup */ }
        if (candidate && state.client === candidate) state.client = null;
        if (retired(state)) return;
        markError(`imap reconnect failed folder=${state.folder}`, err);
        // Reported per ATTEMPT, not once per outage: the owned loop retries, so
        // a permanently-bad credential keeps re-asserting `auth` rather than
        // reporting once and going quiet.
        reportReconnect(state.folder, false, isImapAuthFailure(err) ? 'auth' : 'transient');
        continue;
      }

      state.stopIdle = attachListeners(state, cb);
      // The connection closed before sync started on it: this reconnect stands
      // in for `startSync`, and owes that start's catch-up.
      const starting = !state.syncStarted;
      state.syncStarted = true;
      scheduleDeliveryRetry(state, cb);
      // What came and went while the folder was down (`startCatchUp`).
      const validity = uidValidityOf(box);
      const renumbered = state.uidValidity !== null && validity !== null && validity !== state.uidValidity;
      const from = state.uidNext;
      const inWindow = new Set(state.seqToUid.values());
      state.uidValidity = validity ?? state.uidValidity;
      state.uidNext = uidNextOf(box) ?? state.uidNext;
      if (renumbered) {
        // Every UID changed meaning, so there is nothing to compare with: the
        // next start's re-list reads the folder under its new numbering. The
        // stored cursor named the old numbering, so it is dropped and held.
        markError(`imap UIDVALIDITY changed folder=${state.folder}; missed mail waits for the next start`, null);
        state.storedUidNext = null;
        state.cursorHeld = true;
      } else {
        startCatchUp(state, cb, {
          // A start catches up from the stored cursor, which reaches mail added
          // while the server was down, moved-in mail included, and reads every
          // message's flags against it — as `startSync` would have.
          from: starting ? (state.storedUidNext ?? from) : from,
          known,
          goneCandidates: [...known].filter((uid) => !inWindow.has(uid)),
          reconcile: starting && state.storedUidNext !== null,
        });
      }
      state.attempts = 0;
      lastSuccessfulSyncAt = nowOf();
      // This folder is back — reported as provider-wide success only if it was
      // the last one down.
      reportReconnect(state.folder, true);
      return;
    }
  };

  const scheduleReconnect = (
    state: FolderState,
    cb: ProviderSyncCallback,
  ): void => {
    if (retired(state) || state.reconnectTask) return;
    let task!: Promise<void>;
    task = reconnectLoop(state, cb)
      .catch((err) => {
        // The loop contains expected transport failures. This final boundary
        // owns programmer/config failures too so EventEmitter never launches an
        // unhandled rejection.
        if (!retired(state)) markError(`imap reconnect loop failed folder=${state.folder}`, err);
      })
      .finally(() => {
        if (state.reconnectTask === task) state.reconnectTask = null;
      });
    state.reconnectTask = task;
  };

  // ── outbound send (D-127 P1.5) ──────────────────────────────
  //
  // SMTP submission via a `nodemailer` transport built once per call
  // (transports pool sockets internally and we close after each
  // send so connection-per-recipe semantics stay simple). After a
  // successful submission we IMAP APPEND the same RFC 5322 to the
  // user's Sent folder — best-effort: if discovery or APPEND fails,
  // the SMTP submission is *not* rolled back; we attach a
  // `MAIL_SEND_APPEND_FAILED` warning to the returned meta so P1.7
  // can audit it.
  //
  const appendToSentBestEffort = async (
    rfc822: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    // Reuse any open client for APPEND — imapflow's `append` doesn't
    // disturb the SELECT'd mailbox so this is safe to interleave with
    // IDLE on the inbound folders.
    const state = folders.values().next().value;
    if (!state || !state.client) {
      return { ok: false, reason: 'no IMAP client connected for APPEND' };
    }
    if (typeof state.client.list !== 'function' || typeof state.client.append !== 'function') {
      return { ok: false, reason: 'IMAP client lacks list/append capability' };
    }
    let folder: string | null;
    try {
      folder = await findSentFolder(state.client);
    } catch (err) {
      return {
        ok: false,
        reason: `Sent folder discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!folder) {
      return {
        ok: false,
        reason: `no Sent folder found via \\Sent flag or fallback chain (${IMAP_SENT_FOLDER_FALLBACK_CANDIDATES.join(', ')})`,
      };
    }
    try {
      await state.client.append(folder, rfc822, ['\\Seen']);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: `IMAP APPEND to ${folder} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };

  /** D-264 — APPEND the message into `\Drafts` with the `\Draft` flag.
   *
   *  ⛔ NO SMTP. That is the entire point: an IMAP mailbox enrolled without an
   *  SMTP block is `sendCapable: false` and can still do this, which is the
   *  case D-264 exists for. The `from` address therefore falls back to the IMAP
   *  username rather than reading `smtp.from`, which may not exist.
   *
   *  ⚠ IMAP HAS NO UPDATE VERB. Superseding a `prior` draft means deleting it,
   *  which needs the D-239 delete verb — a DIFFERENT capability from the
   *  `list`+`append` pair this method requires. When the client lacks it the
   *  draft is still saved and `replaced` comes back FALSE with a warning: the
   *  owner has two copies and is told so, rather than the method claiming a
   *  replacement it did not perform. */
  const saveDraftImpl = async (
    msg: OutgoingMessage,
    prior?: { source_id: string },
  ): Promise<SavedDraftMeta> => {
    const cfg = opts.config();
    const fromAddress = cfg.smtp?.from ?? cfg.username;
    const messageId = generateImapMessageId(fromAddress, cfg.host, messageIdUuid);
    const savedAt = nowOf();
    const rfc822 = buildImapRfc5322(msg, { from: fromAddress, messageId, sentAt: savedAt });

    const state = folders.values().next().value;
    if (!state || !state.client) {
      throw new IngredientError('MAIL_DRAFT_NOT_CAPABLE',
        `IMAP provider ${opts.slug} has no connected client for APPEND`,
        { kind: 'imap', slug: opts.slug });
    }
    const client = state.client;
    if (typeof client.list !== 'function' || typeof client.append !== 'function') {
      throw new IngredientError('MAIL_DRAFT_NOT_CAPABLE',
        `IMAP client for ${opts.slug} lacks list/append`,
        { kind: 'imap', slug: opts.slug });
    }
    let folder: string | null;
    try {
      folder = await findDraftsFolder(client);
    } catch (err) {
      markError('imap Drafts folder discovery failed', err);
      throw new IngredientError('MAIL_DRAFT_FOLDER_NOT_FOUND',
        `Drafts folder discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        { kind: 'imap', slug: opts.slug });
    }
    if (!folder) {
      throw new IngredientError('MAIL_DRAFT_FOLDER_NOT_FOUND',
        `no Drafts folder found via \\Drafts flag or fallback chain `
        + `(${IMAP_DRAFTS_FOLDER_FALLBACK_CANDIDATES.join(', ')})`,
        { kind: 'imap', slug: opts.slug });
    }

    let appended: unknown;
    try {
      appended = await client.append(folder, rfc822, ['\\Draft']);
    } catch (err) {
      markError('imap Drafts APPEND failed', err);
      throw new IngredientError('MAIL_DRAFT_WRITE_FAILED',
        `IMAP APPEND to ${folder} failed: ${err instanceof Error ? err.message : String(err)}`,
        { kind: 'imap', slug: opts.slug });
    }
    // imapflow returns `{ uid, uidValidity, ... }` when the server answers
    // APPENDUID; plenty of servers do not, and the generated Message-Id is the
    // only handle left. Either way the id must be a value a later export can
    // hand back, so it is never empty.
    const uid = (appended as { uid?: unknown } | null)?.uid;
    const source_id = typeof uid === 'number' && Number.isSafeInteger(uid)
      ? String(uid)
      : messageId;

    const warnings: Array<{ code: string; message: string }> = [];
    // ⛔⛔ THE PRIOR DRAFT IS NEVER DELETED HERE, AND THAT IS A CORRECTNESS
    // DECISION, NOT A GAP. This originally called
    // `client.messageDelete(priorUid, { uid: true })`, which would have DESTROYED
    // UNRELATED INBOX MAIL: `append` deliberately does not disturb the SELECTed
    // mailbox (see `appendToSentBestEffort`), so the client is still on the sync
    // folder — INBOX — when the delete runs. A UID is only meaningful inside the
    // mailbox it belongs to, so "delete UID 7" deleted INBOX's message 7 while
    // the draft in Drafts survived, and the call then reported
    // `replaced: true`. Silent, irreversible, and it looked like success.
    //
    // Selecting Drafts first is not the fix either: this client is shared with
    // the live sync loop, and moving its selection mid-sync is the exact side
    // effect APPEND was chosen to avoid.
    //
    // So IMAP does what IMAP can do — it appends, and says the old copy is still
    // there. That is the honest outcome the `replaced` contract exists to carry.
    const replaced = false;
    if (prior) {
      warnings.push({ code: 'MAIL_DRAFT_PRIOR_NOT_REMOVED',
        message: 'IMAP cannot replace a saved draft, so the earlier copy is still '
          + 'in your Drafts folder. Delete it in your mail app.' });
    }

    lastSuccessfulSyncAt = nowOf();
    return { source_id, saved_at: savedAt, replaced,
      ...(warnings.length > 0 ? { warnings } : {}) };
  };

  const sendImpl = async (msg: OutgoingMessage): Promise<SentMessageMeta> => {
    const cfg = opts.config();
    const smtp = cfg.smtp;
    if (!smtp) {
      // Defensive — sendCapable should already gate this, but the
      // lockstep helper expects a typed error if a caller bypasses it.
      throw new IngredientError(
        'MAIL_SEND_NOT_CAPABLE',
        `IMAP provider ${opts.slug} has no SMTP block configured`,
        { kind: 'imap', slug: opts.slug },
      );
    }
    let submission: Awaited<ReturnType<typeof submitSmtp>>;
    try {
      submission = await submitSmtp({
        kind: 'imap', slug: opts.slug, msg,
        config: { host: smtp.host, port: smtp.port ?? DEFAULT_SMTP_PORT,
          secure: smtp.secure ?? false, username: smtp.username ?? cfg.username,
          password: smtp.password ?? cfg.password, from: smtp.from ?? cfg.username },
        factory: smtpFactory, now: nowOf, uuid: messageIdUuid,
      });
    } catch (err) {
      // The mailbox's health counts what a failed send says about the ACCOUNT:
      // SMTP could not be reached, refused the sign-in, or failed. A recipient
      // SMTP refused is the message's problem, the line Gmail and Graph draw too,
      // and a send stopped before submission is not SMTP's. Lost when submission
      // moved into `submitSmtp`, which owns no health.
      const details = err instanceof IngredientError ? err.details : undefined;
      if (!(err instanceof IngredientError && err.code === 'MAIL_SEND_RECIPIENT_INVALID')
        && details?.dispatch_blocked !== true) {
        markError(`imap SMTP submission failed code=${String(details?.smtp_code ?? 'none')} `
          + `response=${String(details?.smtp_response_code ?? 'none')}`, err);
      }
      throw err;
    }
    const { meta: submitted, raw: rfc822 } = submission;
    const { message_id: messageId, sent_at: sentAt } = submitted;

    // ── 2. IMAP APPEND to Sent (best-effort) ──────────────────
    const append = await appendToSentBestEffort(rfc822);
    const warnings: NonNullable<SentMessageMeta['warnings']> = [];
    if (!append.ok) {
      markError('imap APPEND to Sent failed (non-fatal)', append.reason);
      warnings.push({ code: 'MAIL_SEND_APPEND_FAILED', message: append.reason });
    }

    lastSuccessfulSyncAt = nowOf();
    const meta: SentMessageMeta = {
      // SMTP has no server-side id — we use the Message-Id we
      // generated client-side as both `source_id` (for warehouse
      // ingestion lookup) and `message_id` (RFC 5322 header).
      source_id: messageId,
      message_id: messageId,
      sent_at: sentAt,
      // SMTP doesn't expose a thread-id concept; recipes thread by
      // walking In-Reply-To / References on the warehouse-side
      // canonicalization.
    };
    if (warnings.length > 0) meta.warnings = warnings;
    return meta;
  };

  const reconciliationHeaderValues = (parsed: ParsedMail): string[] => {
    const key = MAIL_RECONCILIATION_ID_HEADER.toLowerCase();
    return parsed.headerLines
      .filter((header) => header.key.toLowerCase() === key)
      .map((header) => {
        const colon = header.line.indexOf(':');
        return colon >= 0 ? header.line.slice(colon + 1).trim() : '';
      });
  };

  const imapReconciliationCandidate = async (
    source: Buffer,
    uid: number,
    folder: string,
    internalDate: Date | string | undefined,
  ): Promise<MailSentReconciliationCandidate> => {
    const parsed = await simpleParser(source);
    const internalTime = internalDate instanceof Date
      ? internalDate.getTime()
      : typeof internalDate === 'string'
        ? Date.parse(internalDate)
        : Number.NaN;
    const sentAt = Number.isSafeInteger(internalTime)
      ? internalTime
      : parsed.date?.getTime();
    if (!Number.isSafeInteger(sentAt) || (sentAt as number) < 0) {
      throw new Error(`imap message ${uid}@${folder} missing a safe sent timestamp`);
    }
    return {
      source_id: sourceIdFor(uid, folder),
      rfc_message_id: parsed.messageId ?? undefined,
      reconciliation_header_values: reconciliationHeaderValues(parsed),
      to: addressToStringList(parsed.to),
      cc: addressToStringList(parsed.cc),
      bcc: addressToStringList(parsed.bcc),
      subject: parsed.subject ?? '',
      sent_at: sentAt as number,
      attachments: parsedReconciliationAttachmentParts(parsed),
      attachment_set_complete: true,
    };
  };

  const lookupSentByReconciliationId = async (
    query: MailSentReconciliationQuery,
  ): Promise<MailSentReconciliationResult> => {
    assertMailSentReconciliationQuery(query);
    const candidates: MailSentReconciliationCandidate[] = [];
    const client = makeClient('__sent_reconciliation__', { lookup: true });
    try {
      await client.connect();
      const sentFolder = await findSentFolder(client);
      if (!sentFolder) {
        throw new Error('imap reconciliation could not discover a Sent folder');
      }
      await client.mailboxOpen(sentFolder);
      // RFC 3501 date searches are day-granular. Search one wider ending day,
      // then enforce the exact millisecond interval against fetched source.
      const uids = await client.search({
        header: { [MAIL_RECONCILIATION_ID_HEADER]: query.reconciliation_id },
        since: new Date(query.sent_after),
        before: new Date(query.sent_before + 24 * 60 * 60 * 1_000),
      }, { uid: true });
      if (uids === false || uids.length === 0) {
        lastSuccessfulSyncAt = nowOf();
        return evaluateMailSentReconciliationCandidates(query, candidates, true);
      }
      if (uids.length > MAIL_SENT_RECONCILIATION_MAX_SCAN) {
        return evaluateMailSentReconciliationCandidates(query, candidates, false);
      }
      let metadataFetched = 0;
      const sourceSizes = new Map<number, number>();
      const metadataIter = client.fetch(
        uids,
        { uid: true, size: true },
        { uid: true },
      );
      for await (const message of metadataIter) {
        metadataFetched++;
        if (
          !Number.isSafeInteger(message.size)
          || message.size! <= 0
          || message.size! > MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES
        ) {
          return {
            status: 'unavailable',
            reason: 'attachment_unreadable',
            scanned_candidates: candidates.length,
          };
        }
        sourceSizes.set(message.uid, message.size!);
      }
      if (metadataFetched !== uids.length) {
        throw new Error('imap Sent source changed during reconciliation preflight');
      }
      let fetched = 0;
      const iter = client.fetch(
        uids,
        {
          uid: true,
          flags: true,
          envelope: true,
          internalDate: true,
          source: { maxLength: MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES + 1 },
        },
        { uid: true },
      );
      for await (const message of iter) {
        fetched++;
        if (!message.source) {
          throw new Error(`imap reconciliation message uid=${message.uid} omitted source`);
        }
        if (message.source.length !== sourceSizes.get(message.uid)) {
          throw new Error(`imap reconciliation message uid=${message.uid} changed after preflight`);
        }
        candidates.push(await imapReconciliationCandidate(
          Buffer.from(message.source),
          message.uid,
          sentFolder,
          message.internalDate,
        ));
      }
      if (fetched !== uids.length) {
        throw new Error('imap Sent source changed during reconciliation fetch');
      }
      lastSuccessfulSyncAt = nowOf();
      return evaluateMailSentReconciliationCandidates(query, candidates, true);
    } catch (err) {
      markError('imap sent reconciliation lookup failed', err);
      return {
        status: 'unavailable',
        reason: 'provider_error',
        scanned_candidates: candidates.length,
      };
    } finally {
      try {
        if (client.usable) await client.logout();
        else client.close();
      } catch {
        try { client.close(); } catch { /* best-effort dedicated client close */ }
      }
    }
  };

  /** D-318 step 2 — proof (a): the messages in this account's Sent folder that
   *  carry one Message-ID, on a dedicated client like the D-200 lookup above.
   *  `SEARCH HEADER` matches a substring, so each hit's envelope Message-ID is
   *  compared exactly; the folder is the server's record that the account sent
   *  it. Opened read-only: a lookup never touches `\Seen`. */
  const lookupSentByMessageId = async (
    query: MailSentByMessageIdQuery,
  ): Promise<MailSentByMessageIdResult> => {
    const client = makeClient('__sent_lookup__', { lookup: true });
    try {
      await client.connect();
      const sentFolder = await findSentFolder(client);
      // No Sent folder to read: this mailbox cannot be asked, which is not an
      // outage to wait out (the audit).
      if (!sentFolder) return { status: 'unavailable', reason: 'unsupported' };
      await client.mailboxOpen(sentFolder, { readOnly: true });
      const uids = await client.search({ header: { 'message-id': query.rfc_message_id } }, { uid: true });
      if (uids === false || uids.length === 0) return { status: 'not_found' };
      const matches: MailSentByMessageIdMatch[] = [];
      const iter = client.fetch(
        uids.slice(0, MAIL_SENT_BY_MESSAGE_ID_MAX_MATCHES),
        { uid: true, envelope: true, internalDate: true },
        { uid: true },
      );
      for await (const message of iter) {
        const envelope = message.envelope;
        if (normalizeRfcMessageId(envelope?.messageId) !== query.rfc_message_id) continue;
        const sentAt = message.internalDate instanceof Date
          ? message.internalDate.getTime()
          : typeof message.internalDate === 'string' ? Date.parse(message.internalDate) : Number.NaN;
        matches.push({
          to: (envelope?.to ?? []).flatMap((address) => (address.address ? [address.address] : [])),
          subject: envelope?.subject ?? '',
          sent_at: Number.isFinite(sentAt) ? sentAt : 0,
        });
      }
      return matches.length > 0 ? { status: 'found', matches } : { status: 'not_found' };
    } catch (err) {
      markError('imap sent lookup by message id failed', err);
      return { status: 'unavailable', reason: 'provider_error' };
    } finally {
      try {
        if (client.usable) await client.logout();
        else client.close();
      } catch {
        try { client.close(); } catch { /* best-effort dedicated client close */ }
      }
    }
  };

  /** D-318 — the replies this account SENT to one Message-ID: has the chat
   *  mailbox answered this request? `SEARCH HEADER In-Reply-To` in the Sent
   *  folder, on a dedicated read-only client like the proof's lookup above. The
   *  search matches a substring, so each hit's envelope In-Reply-To is compared
   *  exactly. */
  const lookupSentReplies = async (
    query: MailSentRepliesQuery,
  ): Promise<MailSentRepliesResult> => {
    const client = makeClient('__sent_replies__', { lookup: true });
    try {
      await client.connect();
      const sentFolder = await findSentFolder(client);
      if (!sentFolder) return { status: 'unavailable', reason: 'unsupported' };
      await client.mailboxOpen(sentFolder, { readOnly: true });
      const uids = await client.search({ header: { 'in-reply-to': query.rfc_message_id } }, { uid: true });
      if (uids === false || uids.length === 0) return { status: 'not_found' };
      const matches: MailSentReplyMatch[] = [];
      const iter = client.fetch(
        uids.slice(0, MAIL_SENT_REPLIES_MAX_MATCHES),
        { uid: true, envelope: true, internalDate: true, headers: [MAIL_RECONCILIATION_ID_HEADER] },
        { uid: true },
      );
      for await (const message of iter) {
        if (normalizeRfcMessageId(message.envelope?.inReplyTo) !== query.rfc_message_id) continue;
        const sentAt = message.internalDate instanceof Date
          ? message.internalDate.getTime()
          : typeof message.internalDate === 'string' ? Date.parse(message.internalDate) : Number.NaN;
        matches.push({
          reconciliation_id: headerValueOf(message.headers, MAIL_RECONCILIATION_ID_HEADER),
          sent_at: Number.isFinite(sentAt) ? sentAt : 0,
        });
      }
      return matches.length > 0 ? { status: 'found', matches } : { status: 'not_found' };
    } catch (err) {
      markError('imap sent replies lookup failed', err);
      return { status: 'unavailable', reason: 'provider_error' };
    } finally {
      try {
        if (client.usable) await client.logout();
        else client.close();
      } catch {
        try { client.close(); } catch { /* best-effort dedicated client close */ }
      }
    }
  };

  // ── D-239 write-back ────────────────────────────────────────────
  //
  // IMAP is the adapter where the write-back is genuinely awkward, and the
  // shape below is the consequence of three facts about the protocol:
  //
  //  1. A message is addressed by `UID@folder`, so the FOLDER is part of
  //     the identity and a mutation must open the right mailbox first.
  //  2. `UID MOVE` re-keys the message, and only tells you the new UID on
  //     servers advertising UIDPLUS. See `MailMoveOutcome` for what we do
  //     when it does not.
  //  3. STORE does not echo the resulting flag set, so "verified" here
  //     means a FETCH after the write — not the write's own return value.
  //     imapflow's `messageFlagsAdd` resolves `true` on a server that
  //     accepted the command; that is an acknowledgement, not a reading.

  /** Split `UID@folder` back into its parts. Splits at the FIRST `@`
   *  because a UID is an unsigned integer and cannot contain one, while a
   *  folder path very much can (`INBOX/a@b` is a legal mailbox name). A
   *  `lastIndexOf` here would truncate such a folder and open the wrong
   *  mailbox. */
  const parseSourceId = (
    source_id: string,
  ): { uid: number; folder: string } => {
    const at = source_id.indexOf('@');
    const uid = at > 0 ? Number(source_id.slice(0, at)) : NaN;
    const folder = at > 0 ? source_id.slice(at + 1) : '';
    if (!Number.isSafeInteger(uid) || uid <= 0 || folder.length === 0) {
      throw new MailAdapterError(
        'message_not_found',
        `imap source_id '${source_id}' is not a 'UID@folder' identity`,
      );
    }
    return { uid, folder };
  };

  /** Translate a thrown imapflow error into the typed adapter error.
   *
   *  ⛔ THE DEFAULT IS `io_error`, AND THAT IS THE WHOLE POINT. An IMAP
   *  command that fails for an unrecognized reason has an UNKNOWN outcome
   *  — the server may have applied it and dropped the connection before
   *  acknowledging. Classifying an unknown failure as a definite one would
   *  let the warehouse move on a mutation that never happened, or stay put
   *  on one that did. Only the two structurally-identifiable cases below
   *  are claimed with confidence. */
  const imapMutationError = (
    err: unknown,
    verb: string,
    source_id: string,
  ): MailAdapterError => {
    if (err instanceof MailAdapterError) return err;
    if (isImapAuthFailure(err)) {
      return new MailAdapterError(
        'auth_expired',
        `imap ${verb} on '${source_id}' failed authentication`,
        err,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/\[TRYCREATE\]|NONEXISTENT|no such mailbox/i.test(message)) {
      return new MailAdapterError(
        'folder_not_found',
        `imap ${verb} on '${source_id}': ${message}`,
        err,
      );
    }
    if (/READ-ONLY/i.test(message)) {
      return new MailAdapterError(
        'permission_denied',
        `imap ${verb} on '${source_id}': the mailbox is open read-only`,
        err,
      );
    }
    return new MailAdapterError(
      'io_error',
      `imap ${verb} on '${source_id}' failed — outcome unknown, the change may have been applied: ${message}`,
      err,
    );
  };

  /** Run a mutation against a DEDICATED short-lived client, mirroring
   *  `lookupSentByReconciliationId`.
   *
   *  ⛔ IT DOES NOT REUSE THE WATCHER'S CONNECTION, deliberately. The
   *  per-folder clients in `folders` sit in IDLE; issuing commands on one
   *  means interrupting and restarting that IDLE, which turns every
   *  mark-read into a reconnect risk on the mailbox the user is actually
   *  watching. Worse, a mutation may target a folder that is not watched
   *  at all, in which case there is no connection to borrow. One
   *  short-lived client is slower per call and cannot disturb sync. */
  const withMutationClient = async <T>(
    verb: string,
    source_id: string,
    folder: string,
    fn: (client: ImapClient) => Promise<T>,
  ): Promise<T> => {
    const client = makeClient(`__mutate_${verb}__`, { lookup: true });
    try {
      await client.connect();
      await client.mailboxOpen(folder);
      return await fn(client);
    } catch (err) {
      const mapped = imapMutationError(err, verb, source_id);
      // `io_error` is the ambiguous class, so it is the one worth counting
      // toward instance health; a definite refusal (auth, read-only, no
      // such mailbox) is a configuration answer, not a flapping mailbox.
      if (mapped.code === 'io_error' || mapped.code === 'auth_expired') {
        markError(`imap ${verb} failed`, err);
      }
      throw mapped;
    } finally {
      try {
        if (client.usable) await client.logout();
        else client.close();
      } catch {
        try { client.close(); } catch { /* best-effort dedicated client close */ }
      }
    }
  };

  /** D-315 §4.4 — one message read again, whole, on a connection of its own
   *  that EXAMINEs the folder (a read must not mark it seen). The id carries
   *  no UIDVALIDITY, so a caller that holds the message's RFC id checks it
   *  still matches: a renumbered mailbox hands back another message under
   *  the same UID. `null` when the UID is no longer in the folder. */
  const fetchMessageImpl = async (source_id: string): Promise<CanonicalMessage | null> => {
    const { uid, folder } = parseSourceId(source_id);
    const client = makeClient('__fetch_message__', { lookup: true });
    try {
      await client.connect();
      const direction = folders.get(folder)?.direction ?? await resolveFolderDirection(client, folder);
      await client.mailboxOpen(folder, { readOnly: true });
      const iter = client.fetch(
        [uid],
        { uid: true, flags: true, internalDate: true, source: true },
        { uid: true },
      );
      for await (const message of iter) {
        if (message.uid !== uid || !message.source) continue;
        return await canonicalizeImap(message.source, {
          uid,
          folder,
          direction,
          flags: message.flags,
          internalDate: message.internalDate,
        });
      }
      return null;
    } finally {
      try {
        if (client.usable) await client.logout();
        else client.close();
      } catch {
        try { client.close(); } catch { /* best-effort dedicated client close */ }
      }
    }
  };

  /** Read the message's flags back after a STORE, so the reflected state is
   *  something the server SAID rather than something we assumed. Absence
   *  here is meaningful: a message that no longer matches its UID was moved
   *  or expunged out from under us, which is a verified `message_not_found`
   *  and lets the caller drop a stale warehouse row. */
  const fetchVerifiedState = async (
    client: ImapClient,
    uid: number,
    folder: string,
  ): Promise<MailMutationResult> => {
    const iter = client.fetch([uid], { uid: true, flags: true }, { uid: true });
    for await (const message of iter) {
      if (message.uid !== uid) continue;
      const flags = message.flags ?? new Set<string>();
      return {
        source_id: sourceIdFor(uid, folder),
        is_read: flags.has('\\Seen'),
        is_flagged: flags.has('\\Flagged'),
        folder_or_label: folder,
      };
    }
    throw new MailAdapterError(
      'message_not_found',
      `imap could not re-read UID ${uid} in '${folder}' after the write — the message is no longer there`,
    );
  };

  const requireFlagVerbs = (
    client: ImapClient,
  ): {
    add: NonNullable<ImapClient['messageFlagsAdd']>;
    remove: NonNullable<ImapClient['messageFlagsRemove']>;
  } => {
    if (
      typeof client.messageFlagsAdd !== 'function'
      || typeof client.messageFlagsRemove !== 'function'
    ) {
      throw new MailAdapterError(
        'permission_denied',
        'the IMAP client does not expose the flag verbs',
      );
    }
    return { add: client.messageFlagsAdd, remove: client.messageFlagsRemove };
  };

  /** Set or clear one system flag, then read the result back. Shared by
   *  `markImpl` (`\Seen`) and `flagImpl` (`\Flagged`) — the two differ only
   *  in which flag they name, and writing them twice is how the two
   *  drift. */
  const storeFlag = async (
    verb: string,
    source_id: string,
    flag: string,
    on: boolean,
  ): Promise<MailMutationResult> => {
    const { uid, folder } = parseSourceId(source_id);
    return withMutationClient(verb, source_id, folder, async (client) => {
      const verbs = requireFlagVerbs(client);
      const applied = on
        ? await verbs.add.call(client, [uid], [flag], { uid: true })
        : await verbs.remove.call(client, [uid], [flag], { uid: true });
      if (applied === false) {
        // imapflow resolves `false` when the range matched nothing — a
        // definite answer, not an ambiguous one: the server processed the
        // command and found no such message.
        throw new MailAdapterError(
          'message_not_found',
          `imap ${verb}: UID ${uid} is not in '${folder}'`,
        );
      }
      return fetchVerifiedState(client, uid, folder);
    });
  };

  const markImpl = async (args: {
    source_id: string;
    read: boolean;
  }): Promise<MailMutationResult> =>
    storeFlag('mark', args.source_id, '\\Seen', args.read);

  const flagImpl = async (args: {
    source_id: string;
    flagged: boolean;
  }): Promise<MailMutationResult> =>
    storeFlag('flag', args.source_id, '\\Flagged', args.flagged);

  const moveImpl = async (args: {
    source_id: string;
    destination: MailMoveDestination;
  }): Promise<MailMoveOutcome> => {
    const target = args.destination.folder;
    if (!target) {
      throw new MailAdapterError(
        'folder_not_found',
        'imap move requires a destination folder — Gmail label sets have no IMAP equivalent',
      );
    }
    const { uid, folder } = parseSourceId(args.source_id);
    if (target === folder) {
      // A move to the folder the message is already in is a no-op the
      // server may or may not accept; answering from what we know avoids
      // an EXPUNGE round-trip that could genuinely lose the message on a
      // server that implements MOVE as COPY-then-delete.
      return withMutationClient('move', args.source_id, folder, (client) =>
        fetchVerifiedState(client, uid, folder));
    }
    return withMutationClient('move', args.source_id, folder, async (client) => {
      if (typeof client.messageMove !== 'function') {
        throw new MailAdapterError(
          'permission_denied',
          'the IMAP client does not expose the move verb',
        );
      }
      const result = await client.messageMove([uid], target, { uid: true });
      if (result === false) {
        throw new MailAdapterError(
          'message_not_found',
          `imap move: UID ${uid} is not in '${folder}'`,
        );
      }
      const uidMap = typeof result === 'object' && result !== null
        ? result.uidMap
        : undefined;
      const newUid = uidMap?.get(uid);
      if (newUid === undefined) {
        // UIDPLUS absent — the move is CONFIRMED, its result unnameable.
        // See `MailMoveOutcome` for why this is `null` rather than a throw
        // or an echo of the old id.
        return null;
      }
      return {
        source_id: sourceIdFor(newUid, target),
        // ⚠ Carried over, NOT re-read. The message now lives in the
        // destination mailbox, which this client does not have open, and
        // reopening to FETCH would cost a round-trip to learn flags that
        // MOVE preserves by definition (RFC 6851 §3.3). The destination
        // folder's own sync is the authority from here on.
        is_read: false,
        is_flagged: false,
        folder_or_label: target,
      } satisfies MailMutationResult;
    });
  };

  const deleteImpl = async (args: { source_id: string }): Promise<void> => {
    const { uid, folder } = parseSourceId(args.source_id);
    await withMutationClient('delete', args.source_id, folder, async (client) => {
      if (typeof client.messageDelete !== 'function') {
        throw new MailAdapterError(
          'permission_denied',
          'the IMAP client does not expose the delete verb',
        );
      }
      const removed = await client.messageDelete([uid], { uid: true });
      if (removed === false) {
        throw new MailAdapterError(
          'message_not_found',
          `imap delete: UID ${uid} is not in '${folder}'`,
        );
      }
    });
  };

  /** Whether this instance's IMAP client exposes the whole write-back
   *  group. Probed once against a throwaway client — `clientFactory`
   *  CONSTRUCTS without connecting (imapflow opens its socket in
   *  `connect()`), so this costs an object and no I/O.
   *
   *  ⚠ Probed uniformly for production and for injected fakes rather than
   *  branching on whether a factory was supplied. A `opts.clientFactory
   *  === undefined ⇒ capable` shortcut would make the real path the one
   *  path no test ever evaluates. */
  let mutationCapableMemo: boolean | undefined;
  const probeMutationCapable = (): boolean => {
    if (mutationCapableMemo !== undefined) return mutationCapableMemo;
    try {
      const probe = makeClient('__mutation_probe__', { lookup: true });
      mutationCapableMemo =
        typeof probe.messageFlagsAdd === 'function'
        && typeof probe.messageFlagsRemove === 'function'
        && typeof probe.messageMove === 'function'
        && typeof probe.messageDelete === 'function';
    } catch {
      // A factory that cannot even construct is certainly not capable.
      mutationCapableMemo = false;
    }
    return mutationCapableMemo;
  };

  /** D-264 — the DRAFT pair, probed the same lazy way and deliberately NOT
   *  folded into `probeMutationCapable`. Parking a draft is an APPEND into a
   *  folder found by special-use flag, so it needs exactly what
   *  `appendToSentBestEffort` already checks for at :1350 — `list` + `append`
   *  — and none of D-239's flag/move/delete quartet. The two happen to agree
   *  on imapflow; a client that grew one group and not the other would make
   *  a single shared probe answer the wrong question for one of them. */
  let draftCapableMemo: boolean | undefined;
  const probeDraftCapable = (): boolean => {
    if (draftCapableMemo !== undefined) return draftCapableMemo;
    try {
      const probe = makeClient('__draft_probe__', { lookup: true });
      draftCapableMemo =
        typeof probe.list === 'function'
        && typeof probe.append === 'function';
    } catch {
      draftCapableMemo = false;
    }
    return draftCapableMemo;
  };

  const sendCapable = !!opts.config().smtp;
  // D-127 P1.6 — accountEmail derives from the SMTP block's `from`
  // override, falling back to the IMAP username (which IS the email
  // for the vast majority of providers). Captured at construction
  // because re-enrollment recreates the provider anyway.
  const accountEmail =
    opts.config().smtp?.from
    ?? opts.config().username
    ?? '';

  /** The backfill body, lifted out of the public `initialScan` so the outcome
   *  reporter can wrap the whole sweep as one attempt. A folder failure does
   *  not prevent the remaining folders from being scanned, but it is rethrown
   *  after the sweep: resolving here tells MailCollection that it may mark the
   *  whole backfill complete. */
  const scanAllFolders = async (scanOpts: InitialScanOptions, signal: AbortSignal): Promise<void> => {
    lastBackfillDays = scanOpts.backfill_days;
    const since = new Date(nowOf() - scanOpts.backfill_days * 86400_000);
    const failures: unknown[] = [];
    let aborted = false;
    // A snapshot: `close()` empties `folders`, and a connect after it fills the
    // map with the next connection's folders, which this scan must not read.
    for (const state of [...folders.values()]) {
      throwIfStopped(signal);
      const client = state.client;
      if (!client) continue;
      pendingQueueSize++;
      try {
        // Busy for the whole folder, callbacks included: the FETCH streams on
        // while each message is stored, so `close()` closes this socket rather
        // than queue a LOGOUT behind the rest of the folder.
        await occupy(client, async () => {
          const uids = await client.search({ since }, { uid: true });
          if (!Array.isArray(uids)) throw new Error(`imap initial scan could not search folder=${state.folder}`);
          scanOpts.onAccessVerified?.();
          if (uids.length === 0) return;
          const iter = client.fetch(
            uids,
            { uid: true, flags: true, envelope: true, internalDate: true, source: true },
            { uid: true },
          );
          for await (const msg of iter) {
            throwIfStopped(signal);
            if (!Number.isSafeInteger(msg.uid) || msg.uid <= 0) {
              throw new Error(`imap initial scan returned an invalid UID folder=${state.folder}`);
            }
            if (
              Number.isSafeInteger(msg.seq)
              && msg.seq > 0
              && Number.isSafeInteger(msg.uid)
              && msg.uid > 0
            ) {
              state.seqToUid.set(msg.seq, msg.uid);
            }
            if (!msg.source) {
              throw new Error(`imap initial scan omitted source uid=${msg.uid} folder=${state.folder}`);
            }
            const canonical = await canonicalizeImap(msg.source, {
              uid: msg.uid,
              folder: state.folder,
              direction: state.direction,
              flags: msg.flags,
              internalDate: msg.internalDate,
            });
            const cont = await scanOpts.onMessage(canonical);
            lastSuccessfulSyncAt = nowOf();
            if (!cont) {
              aborted = true;
              break;
            }
          }
          // A closed client's FETCH ends early without an error: this folder
          // was not read to its end.
          throwIfStopped(signal);
        });
      } catch (err) {
        // Stopped: the backfill is not complete (so this throws, as a failure
        // does), and a stop is no failure of the mailbox's.
        if (signal.aborted) throw new CollectionStoppedError();
        // Continue through the other folders, then reject the aggregate so the
        // collection cannot persist a false `backfill_complete` marker.
        outcomes.noteFailure(isImapAuthFailure(err) ? 'auth' : 'transient');
        markError(`imap initialScan failed folder=${state.folder}`, err);
        failures.push(err);
      } finally {
        pendingQueueSize = Math.max(0, pendingQueueSize - 1);
      }
      if (aborted) break;
    }
    throwIfStopped(signal);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'imap initial scan was incomplete');
    }
  };

  const provider: MailProvider = {
    kind: 'imap',
    slug: opts.slug,
    sendCapable,
    /** True once every folder opened with a stored cursor its UIDVALIDITY still
     *  matches: the catch-up when sync starts then fetches what was added while
     *  the server was down, moved-in mail included, so a restart lists only the
     *  days since the last sync. Read after `connect`, as the collection does. */
    get resumesFromCursor() {
      return connected && folders.size > 0 && [...folders.values()].every((state) => state.storedUidNext !== null);
    },
    // D-239 — a GETTER, not a captured value: the probe constructs a client
    // and we do not want to pay for that (nor to run an injected factory)
    // during provider construction, which happens on every boot for every
    // enrolled mailbox. Memoized inside, so the cost is once per instance
    // and only if something actually asks.
    get mutationCapable() {
      return probeMutationCapable();
    },
    /** D-264 — lazy for the same reason as its neighbour. */
    get draftCapable() {
      return probeDraftCapable();
    },
    accountEmail,
    fetchMessage: fetchMessageImpl,

    async connect() {
      if (connected) return;
      // `sync.stop()` closes transport state while the vault is sealed, and
      // `sync.start()` reuses this provider on unlock. Reopen reconnect
      // admission here; leaving the terminal flag set makes the next socket
      // loss silently permanent after the first lock/unlock cycle.
      stopped = false;
      if (session.signal.aborted) session = new AbortController();
      const signal = session.signal;
      downFolders.clear();
      const cfg = opts.config();
      const opened = new Map<string, FolderState>();
      try {
        for (const folder of cfg.folders) {
          throwIfStopped(signal);
          const client = makeClient(folder);
          // Reachable by `close()` until every folder has opened (`connecting`).
          connecting.add(client);
          let direction: MailMessageDirection = 'unknown';
          let box: MailboxObject | undefined;
          try {
            await client.connect();
            throwIfStopped(signal);
            direction = await resolveFolderDirection(client, folder);
            throwIfStopped(signal);
            box = await client.mailboxOpen(folder);
            throwIfStopped(signal);
          } catch (err) {
            connecting.delete(client);
            try { client.close(); } catch { /* failed transport containment */ }
            throw err;
          }
          opened.set(folder, {
            folder,
            direction,
            signal,
            client,
            stopIdle: null,
            reconnectTask: null,
            deliveryRetryTask: null,
            pollTasks: new Set(),
            attempts: 0,
            seqToUid: new Map(),
            uidValidity: uidValidityOf(box),
            uidNext: uidNextOf(box),
            createdDuringCatchUp: null,
            highestCreated: 0,
            storedUidNext: await loadCursor(folder, uidValidityOf(box)),
            cursorHeld: false,
            syncStarted: false,
          });
        }
        // Closed while the last folder's cursor was read.
        throwIfStopped(signal);
      } catch (err) {
        if (!signal.aborted) markError('imap connect failed', err);
        // Connection admission is all-or-nothing. If folder N fails after
        // folders 1..N-1 opened, close those transports now; otherwise a later
        // connect retry creates a second set while the first remains live.
        // (`folders` holds none of them: they are published below, all at once.)
        await Promise.allSettled([...opened.values()].map((state) => {
          const client = state.client;
          state.client = null;
          if (client === null) return Promise.resolve();
          connecting.delete(client);
          return endSession(client, state.folder);
        }));
        connected = false;
        throw err;
      }
      for (const [folder, state] of opened) {
        if (state.client) connecting.delete(state.client);
        folders.set(folder, state);
      }
      connected = true;
      lastSuccessfulSyncAt = nowOf();
    },

    async initialScan(scanOpts: InitialScanOptions): Promise<void> {
      if (!connected) {
        throw new Error('imap provider: initialScan called before connect');
      }
      // The guard above stays OUTSIDE the wrapper: calling initialScan before
      // connect is a wiring bug in the caller, not a sync attempt, and reporting
      // it as a failed scan would blame the mailbox for our own mistake.
      const signal = session.signal;
      return outcomes.run('initial_scan', () => scanAllFolders(scanOpts, signal));
    },

    onSyncOutcome(listener: MailSyncOutcomeListener) {
      return outcomes.subscribe(listener);
    },

    async startSync(cb: ProviderSyncCallback): Promise<() => Promise<void>> {
      if (!connected) {
        throw new Error('imap provider: startSync called before connect');
      }
      const signal = session.signal;
      await loadPendingDeliveries();
      // Closed while the journal was read: attach nothing to a closed folder.
      throwIfStopped(signal);
      for (const state of folders.values()) {
        // A connection that closed before now — during the first scan, or while
        // another folder's ran — had no `'close'` listener to notice, and IDLE on
        // it would never hear a thing. It reconnects instead, and the reconnect
        // runs this start's catch-up.
        if (!state.client?.usable) {
          scheduleReconnect(state, cb);
          continue;
        }
        // What the first scan listed; anything newer arrived before IDLE
        // attached, and the catch-up fetches it (`startCatchUp`).
        const known = new Set(state.seqToUid.values());
        state.stopIdle = attachListeners(state, cb);
        state.syncStarted = true;
        scheduleDeliveryRetry(state, cb);
        // From the stored cursor after a restart (it reaches mail added while
        // the server was down, moved-in mail included), else this open's
        // UIDNEXT. With a stored cursor the folder kept its numbering, so its
        // rows can be checked against it: the flags changed and the messages
        // deleted meanwhile.
        startCatchUp(state, cb, {
          from: state.storedUidNext ?? state.uidNext,
          known,
          goneCandidates: [],
          reconcile: state.storedUidNext !== null,
        });
      }
      return async (): Promise<void> => {
        // Detach listeners but leave the clients open — `close` owns
        // the teardown so drain can run close once without double
        // LOGOUT.
        for (const state of folders.values()) {
          try { state.stopIdle?.(); } catch { /* detach best-effort */ }
          state.stopIdle = null;
        }
        // A pass still running is waiting on this mailbox's server or on its
        // collection; `close` (which the collection runs beside this) closes
        // the sockets under it, and the wait is bounded either way.
        await settleWithin(Promise.allSettled(
          [...folders.values()].flatMap((state) => [...state.pollTasks]),
        ), STOP_GRACE_MS);
      };
    },

    async close(): Promise<void> {
      // Everything below the first await runs at once: admission closes, the
      // connection's signal aborts what is in flight, and the folders leave
      // `folders` — so a connect after this builds a connection of its own
      // rather than one this close is still tearing down.
      stopped = true;
      session.abort(new CollectionStoppedError('the imap provider was closed'));
      for (const cancel of [...cancelReconnectDelays]) cancel();
      const states = [...folders.values()];
      folders.clear();
      connected = false;
      // A client still connecting has no session to log out of.
      for (const client of connecting) {
        try { client.close(); } catch { /* connect containment */ }
      }
      connecting.clear();
      const tasks = states.flatMap((state) => [
        ...(state.reconnectTask ? [state.reconnectTask] : []),
        ...(state.deliveryRetryTask ? [state.deliveryRetryTask] : []),
        ...state.pollTasks,
      ]);

      // Every folder's session ends at once, not one after another: LOGOUT on
      // an idle client, raced against `IMAP_LOGOUT_GRACE_MS`, then the socket
      // closes — which rejects the commands the reconnect, catch-up and retry
      // tasks are waiting on, so they settle soon after. Each loop also checks
      // its folder's signal after every network await and closes a transport
      // that opened late anyway. The wait for them is bounded: a task still
      // running past it can no longer move a cursor or deliver (`retired`), and
      // what it had not delivered waits for the next start.
      const ended = states.map((state) => {
        try { state.stopIdle?.(); } catch { /* detach best-effort */ }
        state.stopIdle = null;
        const client = state.client;
        state.client = null;
        return client ? endSession(client, state.folder) : Promise.resolve();
      });
      await settleWithin(Promise.allSettled([...ended, ...tasks]), STOP_GRACE_MS);
      // Defensive final fence for a client implementation whose `connect()`
      // ignored the first close and completed before its retired check.
      for (const state of states) {
        if (!state.client) continue;
        try { state.client.close(); } catch { /* shutdown containment */ }
        state.client = null;
      }
    },

    health(): ProviderHealth {
      return {
        last_successful_sync_at: lastSuccessfulSyncAt,
        error_count_24h: errorCount24h,
        pending_queue_size: pendingQueueSize + pendingDeliveries.size,
      };
    },

    lookupSentByReconciliationId,
    lookupSentByMessageId,
    lookupSentReplies,

    ...(sendCapable ? { send: sendImpl } : {}),
    // D-264 — attached UNCONDITIONALLY, unlike `send`.
    //
    // ⛔ `...(probeDraftCapable() ? { saveDraft } : {})` looks like the lockstep
    // `send` uses and is not: that spread EVALUATES the probe at construction,
    // on every boot for every enrolled mailbox, which is exactly the cost
    // `draftCapable`'s getter defers. `sendCapable` can gate method presence
    // because it is a config read; this one cannot.
    //
    // Gating on the FLAG rather than on method presence is the rule D-239
    // already set — "the dispatcher's capability gate reads the flag rather
    // than probing for methods" — and `saveDraftImpl` refuses with
    // `MAIL_DRAFT_NOT_CAPABLE` anyway if it is called on a client that cannot.
    saveDraft: saveDraftImpl,

    // D-239 — attached UNCONDITIONALLY, unlike gmail/graph, because IMAP's
    // capability is a property of the CLIENT rather than of a grant, and
    // probing it here would run `probeMutationCapable()` during
    // construction — the exact cost the getter above exists to defer. The
    // dispatcher's gate reads `mutationCapable` before it calls any of
    // these, and each one re-checks the specific verb it needs, so an
    // incapable client refuses legibly instead of throwing a TypeError.
    markMessage: markImpl,
    flagMessage: flagImpl,
    moveMessage: moveImpl,
    deleteMessage: deleteImpl,
  };

  return provider;
};
