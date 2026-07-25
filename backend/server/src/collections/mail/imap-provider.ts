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
} from '@recued/contracts';
import {
  assertMailSentReconciliationQuery,
  evaluateMailSentReconciliationCandidates,
  MAIL_SENT_RECONCILIATION_MAX_SCAN,
  MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES,
  mailAttachmentPartFromBytes,
  mailSentReconciliationAttachmentPartFromBytes,
  type CanonicalMessage,
  type InitialScanOptions,
  type InboundMailAttachmentPart,
  type MailProvider,
  type MailSentReconciliationCandidate,
  type MailSentReconciliationQuery,
  type MailSentReconciliationResult,
  type OutgoingMessage,
  type ProviderHealth,
  type ProviderSyncCallback,
  type ProviderSyncEventKind,
  type SentMessageMeta,
} from './provider.js';

// ────────────────────────────────────────────────────────────────
// Narrow client interface — exactly the imapflow surface we use.
// Production factory wraps `ImapFlow`; tests inject a fake so we
// don't spin up a real IMAP server (or the wildduck test harness)
// per suite.
// ────────────────────────────────────────────────────────────────

export interface ImapClient extends EventEmitter {
  readonly usable: boolean;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  mailboxOpen(path: string): Promise<MailboxObject>;
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

/** Narrow SMTP transport surface that matches what nodemailer's
 *  `Transporter` exposes for our send path. `raw` carries the
 *  fully-built RFC 5322 message; `envelope` overrides the SMTP
 *  envelope addresses (To / Cc / Bcc all live in `to`). Tests inject
 *  a fake to assert wire shape + drive error paths without spinning
 *  up a real SMTP server. */
export interface SmtpMailOptions {
  raw: string | Buffer;
  envelope: { from: string; to: string[] };
}

export interface SmtpSendResponse {
  /** RFC 5322 Message-Id the server actually delivered with. We
   *  generate the Message-Id client-side in `buildImapRfc5322` so
   *  this value matches what we sent — exposed here for symmetry
   *  with the gmail-api / graph response shapes. */
  messageId?: string;
  /** Free-form server response string (e.g. `"250 2.0.0 OK"`). */
  response?: string;
}

export interface SmtpTransport {
  sendMail(options: SmtpMailOptions): Promise<SmtpSendResponse>;
  /** Idempotent close — production transport pools sockets, the
   *  fake is a no-op. */
  close(): void;
}

export type SmtpTransportFactory = (config: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}) => SmtpTransport;

/** Wraps `nodemailer` for production. Same deferred-require pattern
 *  as `defaultImapClientFactory` — keeps the SMTP boot cost out of
 *  test runs that inject a fake transport. `nodemailer` ships
 *  without bundled types in the repo's tree, so we structural-type
 *  through `SmtpTransport` rather than reaching for `@types/nodemailer`
 *  (kept as a 1-line fix later if/when we ever need richer types). */
export const defaultSmtpTransportFactory: SmtpTransportFactory = (config) => {
  // Bench/dev seam — when `RECUED_BENCH_SMTP_OUTBOX` is set, route the send to
  // a no-network outbox-recording transport instead of nodemailer, so the
  // recued-substrate-bench can execute an APPROVED `mail-send` step offline
  // (the D-157 gate → approve → execute → audit round-trip). Lazy require so
  // production (env unset) never loads the dev module — a no-op there.
  if (process.env.RECUED_BENCH_SMTP_OUTBOX) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { benchSmtpFactoryFromEnv } = require('../../dev/bench-smtp-mock.js') as {
      benchSmtpFactoryFromEnv: () => SmtpTransportFactory | undefined;
    };
    const benchFactory = benchSmtpFactoryFromEnv();
    if (benchFactory) return benchFactory(config);
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require('nodemailer') as {
    createTransport: (cfg: unknown) => unknown;
  };
  return nodemailer.createTransport(config) as SmtpTransport;
};

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
export const IMAP_SENT_FOLDER_FALLBACK_CANDIDATES = [
  'Sent',
  'Sent Items',
  'Sent Messages',
  'INBOX.Sent',
] as const;

/** RFC 5322 Date header serialization. Mirrors the gmail-provider
 *  helper — `+0000` form, not `GMT`. */
const formatRfc5322Date = (ms: number): string =>
  new Date(ms).toUTCString().replace(/GMT$/, '+0000');

/** D-127 P1.5 — derive a UUID-based Message-Id whose host suffix
 *  matches the sender's domain so receiving MTAs see a coherent
 *  envelope ↔ Message-Id pairing. Falls back to the SMTP server
 *  hostname when the from address has no `@` (defensive — should
 *  not happen with a validated config). */
export const generateImapMessageId = (
  fromAddress: string,
  hostFallback: string,
  uuid: () => string = randomUUID,
): string => {
  const at = fromAddress.indexOf('@');
  const domain = at >= 0 ? fromAddress.slice(at + 1) : hostFallback;
  return `<${uuid()}@${domain}>`;
};

const newMimeBoundary = (rand: () => number): string =>
  `recued_${Date.now().toString(36)}_${rand().toString(36).slice(2, 10)}`;

/** D-172 P2 — RFC 2045 §6.8 base64 line wrap (≤76 chars/line). Mirrors
 *  the gmail-provider helper. */
const wrapBase64 = (b64: string): string =>
  (b64.match(/.{1,76}/g) ?? []).join('\r\n');

/** D-172 P2 — render the message body as one MIME part: bare
 *  text/plain, or a nested multipart/alternative when `body_html` is
 *  present. Used both at top level (no attachments) and as the lead
 *  part of a multipart/mixed (with attachments). */
const renderImapBodyPart = (
  msg: OutgoingMessage,
  rand: () => number,
): { contentTypeHeaders: string[]; body: string } => {
  if (msg.body_html) {
    const boundary = newMimeBoundary(rand);
    return {
      contentTypeHeaders: [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ],
      body: [
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        msg.body_text,
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        msg.body_html,
        `--${boundary}--`,
      ].join('\r\n'),
    };
  }
  return {
    contentTypeHeaders: [
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
    ],
    body: msg.body_text,
  };
};

/** D-127 P1.5 — RFC 5322 builder for the IMAP+SMTP send path.
 *  Differs from `buildGmailRfc5322` by adding explicit From and
 *  Message-Id headers (Gmail's API derives From from the OAuth
 *  account; SMTP requires both fields explicit). Otherwise the
 *  composition rules match: text/plain default, multipart/alternative
 *  when body_html is set, threading headers verbatim.
 *
 *  D-172 P2 — when `attachments` are present, the message is wrapped in
 *  a multipart/mixed container (body part first, each attachment a
 *  base64-encoded `Content-Disposition: attachment` part). The same
 *  RFC822 string is both SMTP-submitted (via `raw`) and IMAP-APPENDed
 *  to Sent, so attachments land in both places. */
export const buildImapRfc5322 = (
  msg: OutgoingMessage,
  meta: { from: string; messageId: string; sentAt: number },
  rand: () => number = Math.random,
): string => {
  const headers: string[] = [];
  headers.push('MIME-Version: 1.0');
  headers.push(`Date: ${formatRfc5322Date(meta.sentAt)}`);
  headers.push(`From: ${meta.from}`);
  headers.push(`Message-ID: ${meta.messageId}`);
  if (msg.reconciliation_id) {
    headers.push(`${MAIL_RECONCILIATION_ID_HEADER}: ${msg.reconciliation_id}`);
  }
  if (msg.to.length > 0) headers.push(`To: ${msg.to.join(', ')}`);
  if (msg.cc && msg.cc.length > 0) headers.push(`Cc: ${msg.cc.join(', ')}`);
  if (msg.bcc && msg.bcc.length > 0) headers.push(`Bcc: ${msg.bcc.join(', ')}`);
  headers.push(`Subject: ${msg.subject}`);
  if (msg.reply_to) headers.push(`Reply-To: ${msg.reply_to}`);
  if (msg.in_reply_to) headers.push(`In-Reply-To: ${msg.in_reply_to}`);
  if (msg.references && msg.references.length > 0) {
    headers.push(`References: ${msg.references.join(' ')}`);
  }

  const part = renderImapBodyPart(msg, rand);
  const attachments = msg.attachments ?? [];
  if (attachments.length === 0) {
    headers.push(...part.contentTypeHeaders);
    return `${headers.join('\r\n')}\r\n\r\n${part.body}`;
  }

  // D-172 P2 — multipart/mixed: body part first, then each attachment.
  const mixed = newMimeBoundary(rand);
  headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
  const segments: string[] = [
    `--${mixed}`,
    ...part.contentTypeHeaders,
    '',
    part.body,
  ];
  for (const att of attachments) {
    segments.push(
      `--${mixed}`,
      `Content-Type: ${att.mime_type}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      wrapBase64(att.bytes_b64),
    );
  }
  segments.push(`--${mixed}--`);
  return `${headers.join('\r\n')}\r\n\r\n${segments.join('\r\n')}`;
};

/** D-127 P1.5 — discover the Sent folder. RFC 6154 special-use
 *  `\Sent` flag wins; otherwise the first match against the known
 *  fallback candidate list (case-sensitive, mirrors what most
 *  modern servers expose). Returns null when no candidate matches —
 *  caller surfaces that as an APPEND warning. */
export const findSentFolder = async (
  client: ImapClient,
): Promise<string | null> => {
  if (typeof client.list !== 'function') return null;
  const list = await client.list();
  const flagged = list.find((box) => box.specialUse === '\\Sent');
  if (flagged) return flagged.path;
  const known = new Set(list.map((box) => box.path));
  for (const candidate of IMAP_SENT_FOLDER_FALLBACK_CANDIDATES) {
    if (known.has(candidate)) return candidate;
  }
  return null;
};

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
  if (parsed.html) return String(parsed.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
};

const hasAttachments = (parsed: ParsedMail): boolean =>
  Array.isArray(parsed.attachments)
    && parsed.attachments.some((a) => Boolean(a.filename));

const sourceIdFor = (uid: number, folder: string): string => `${uid}@${folder}`;

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
      disposition: attachment.contentDisposition === 'inline' ? 'inline' : 'attachment',
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
    disposition: attachment.contentDisposition === 'inline' ? 'inline' : 'attachment',
    bytes,
  });
});

export const canonicalizeImap = async (
  source: Buffer,
  opts: {
    uid: number;
    folder: string;
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
  return {
    source_id: sourceIdFor(opts.uid, opts.folder),
    rfc_message_id: parsed.messageId ?? undefined,
    ...(isMailReconciliationId(reconciliationId)
      ? { reconciliation_id: reconciliationId }
      : {}),
    from: parsed.from ? firstAddress(parsed.from) : '',
    to: addressToStringList(parsed.to),
    cc: addressToStringList(parsed.cc),
    subject: parsed.subject ?? '',
    thread_id: deriveThreadId(parsed),
    folder_or_label: opts.folder,
    is_read: flags.has('\\Seen'),
    has_attachments: hasAttachments(parsed) || attachments.length > 0,
    received_at: Number.isFinite(receivedAt) ? receivedAt : Date.now(),
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
  client: ImapClient | null;
  stopIdle: (() => void) | null;
  reconnecting: boolean;
  attempts: number;
}

const DEFAULT_IDLE_MS = 28 * 60 * 1000;
const DEFAULT_RECONNECT_CAP_MS = 60_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;

export const createImapProvider = (
  opts: CreateImapProviderOptions,
): MailProvider => {
  const clientFactory = opts.clientFactory ?? defaultImapClientFactory;
  const smtpFactory = opts.smtpFactory ?? defaultSmtpTransportFactory;
  const messageIdUuid = opts.messageIdUuid ?? randomUUID;
  const nowOf = (): number => opts.now?.() ?? Date.now();
  const sleepOf = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));

  const folders = new Map<string, FolderState>();
  let connected = false;
  let lastSuccessfulSyncAt = 0;
  let errorCount24h = 0;
  let pendingQueueSize = 0;
  let stopped = false;

  const makeClient = (folder: string): ImapClient => {
    const cfg = opts.config();
    return clientFactory({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.username, pass: cfg.password },
      maxIdleTime: cfg.maxIdleTime ?? DEFAULT_IDLE_MS,
      logger: false,
    });
  };

  const markError = (msg: string, err: unknown): void => {
    errorCount24h++;
    opts.log?.('warn', msg, { err: err instanceof Error ? err.message : String(err) });
  };

  const fetchAndEmit = async (
    state: FolderState,
    uid: number,
    kind: ProviderSyncEventKind,
    cb: ProviderSyncCallback,
  ): Promise<void> => {
    if (!state.client) return;
    if (kind === 'deleted') {
      await cb({ kind: 'deleted', source_id: sourceIdFor(uid, state.folder) });
      return;
    }
    pendingQueueSize++;
    try {
      const iter = state.client.fetch(
        [uid],
        { uid: true, flags: true, envelope: true, internalDate: true, source: true },
        { uid: true },
      );
      for await (const msg of iter) {
        if (!msg.source) continue;
        const canonical = await canonicalizeImap(msg.source, {
          uid: msg.uid,
          folder: state.folder,
          flags: msg.flags,
          internalDate: msg.internalDate,
        });
        await cb({ kind, source_id: canonical.source_id, message: canonical });
        lastSuccessfulSyncAt = nowOf();
      }
    } catch (err) {
      markError(`imap fetch failed uid=${uid} folder=${state.folder}`, err);
    } finally {
      pendingQueueSize = Math.max(0, pendingQueueSize - 1);
    }
  };

  const attachListeners = (
    state: FolderState,
    cb: ProviderSyncCallback,
  ): (() => void) => {
    const client = state.client;
    if (!client) return () => { /* nothing to detach */ };

    const onExists = (data: { count: number; prevCount: number }): void => {
      // New messages arrived. UIDs numbered prevCount+1..count.
      for (let seq = data.prevCount + 1; seq <= data.count; seq++) {
        void fetchAndEmit(state, seq, 'created', cb);
      }
    };
    const onExpunge = (data: { uid?: number; seq: number }): void => {
      const uid = data.uid ?? data.seq;
      void fetchAndEmit(state, uid, 'deleted', cb);
    };
    const onFlags = (data: { uid?: number; seq: number }): void => {
      const uid = data.uid ?? data.seq;
      void fetchAndEmit(state, uid, 'updated', cb);
    };
    const onClose = (): void => {
      if (stopped) return;
      if (state.reconnecting) return;
      void reconnect(state, cb);
    };
    const onError = (err: unknown): void => {
      markError(`imap client error folder=${state.folder}`, err);
    };

    client.on('exists', onExists);
    client.on('expunge', onExpunge);
    client.on('flags', onFlags);
    client.on('close', onClose);
    client.on('error', onError);

    return (): void => {
      client.off('exists', onExists);
      client.off('expunge', onExpunge);
      client.off('flags', onFlags);
      client.off('close', onClose);
      client.off('error', onError);
    };
  };

  const reconnect = async (
    state: FolderState,
    cb: ProviderSyncCallback,
  ): Promise<void> => {
    state.reconnecting = true;
    try {
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
      await sleepOf(delay);
      if (stopped) return;
      try {
        state.stopIdle?.();
      } catch { /* stale handle */ }
      state.stopIdle = null;
      state.client = makeClient(state.folder);
      await state.client.connect();
      await state.client.mailboxOpen(state.folder);
      state.stopIdle = attachListeners(state, cb);
      state.attempts = 0;
      lastSuccessfulSyncAt = nowOf();
    } catch (err) {
      markError(`imap reconnect failed folder=${state.folder}`, err);
      if (!stopped) void reconnect(state, cb);
    } finally {
      state.reconnecting = false;
    }
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
  // SMTP error mapping (nodemailer surfaces `code` + `responseCode`):
  //   EAUTH                                    → MAIL_SEND_AUTH_FAILED
  //   EENVELOPE / 5xx responseCode             → MAIL_SEND_RECIPIENT_INVALID
  //   ESOCKET / ECONNECTION / ETIMEDOUT / EDNS → MAIL_SEND_NETWORK_FAILED
  //   anything else                            → MAIL_SEND_NETWORK_FAILED
  const throwSmtpError = (err: unknown): never => {
    const e = err as { code?: string; responseCode?: number; message?: string };
    const message = e?.message ?? String(err);
    const detail = {
      kind: 'imap' as const,
      slug: opts.slug,
      smtp_code: e?.code,
      smtp_response_code: e?.responseCode,
    };
    if (e?.code === 'EAUTH') {
      throw new IngredientError(
        'MAIL_SEND_AUTH_FAILED',
        `SMTP authentication failed: ${message.slice(0, 200)}`,
        detail,
      );
    }
    if (
      e?.code === 'EENVELOPE'
      || (typeof e?.responseCode === 'number' && e.responseCode >= 500 && e.responseCode < 600
          && e.responseCode !== 530 && e.responseCode !== 535)
    ) {
      throw new IngredientError(
        'MAIL_SEND_RECIPIENT_INVALID',
        `SMTP rejected a recipient: ${message.slice(0, 200)}`,
        detail,
      );
    }
    throw new IngredientError(
      'MAIL_SEND_NETWORK_FAILED',
      `SMTP submission failed: ${message.slice(0, 200)}`,
      detail,
    );
  };

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
    const fromAddress = smtp.from ?? cfg.username;
    const messageId = generateImapMessageId(fromAddress, smtp.host, messageIdUuid);
    const sentAt = nowOf();
    const rfc822 = buildImapRfc5322(msg, { from: fromAddress, messageId, sentAt });

    // ── 1. SMTP submission ────────────────────────────────────
    const transport = smtpFactory({
      host: smtp.host,
      port: smtp.port ?? DEFAULT_SMTP_PORT,
      secure: smtp.secure ?? false,
      auth: {
        user: smtp.username ?? cfg.username,
        pass: smtp.password ?? cfg.password,
      },
    });
    const recipients = [...msg.to, ...(msg.cc ?? []), ...(msg.bcc ?? [])];
    try {
      await transport.sendMail({
        raw: rfc822,
        envelope: { from: fromAddress, to: recipients },
      });
    } catch (err) {
      try { transport.close(); } catch { /* swallow — transport already errored */ }
      markError('imap SMTP submission failed', err);
      throwSmtpError(err);
    }
    try { transport.close(); } catch { /* idempotent */ }

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
    const client = makeClient('__sent_reconciliation__');
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

  const sendCapable = !!opts.config().smtp;
  // D-127 P1.6 — accountEmail derives from the SMTP block's `from`
  // override, falling back to the IMAP username (which IS the email
  // for the vast majority of providers). Captured at construction
  // because re-enrollment recreates the provider anyway.
  const accountEmail =
    opts.config().smtp?.from
    ?? opts.config().username
    ?? '';

  const provider: MailProvider = {
    kind: 'imap',
    slug: opts.slug,
    sendCapable,
    accountEmail,

    async connect() {
      if (connected) return;
      const cfg = opts.config();
      for (const folder of cfg.folders) {
        const client = makeClient(folder);
        try {
          await client.connect();
          await client.mailboxOpen(folder);
        } catch (err) {
          markError(`imap connect failed folder=${folder}`, err);
          try { client.close(); } catch { /* swallow */ }
          throw err;
        }
        folders.set(folder, {
          folder,
          client,
          stopIdle: null,
          reconnecting: false,
          attempts: 0,
        });
      }
      connected = true;
      lastSuccessfulSyncAt = nowOf();
    },

    async initialScan(scanOpts: InitialScanOptions): Promise<void> {
      if (!connected) {
        throw new Error('imap provider: initialScan called before connect');
      }
      const since = new Date(Date.now() - scanOpts.backfill_days * 86400_000);
      for (const state of folders.values()) {
        if (!state.client) continue;
        pendingQueueSize++;
        try {
          const uids = await state.client.search({ since }, { uid: true });
          if (uids === false || !Array.isArray(uids) || uids.length === 0) {
            continue;
          }
          const iter = state.client.fetch(
            uids,
            { uid: true, flags: true, envelope: true, internalDate: true, source: true },
            { uid: true },
          );
          for await (const msg of iter) {
            if (!msg.source) continue;
            const canonical = await canonicalizeImap(msg.source, {
              uid: msg.uid,
              folder: state.folder,
              flags: msg.flags,
              internalDate: msg.internalDate,
            });
            const cont = await scanOpts.onMessage(canonical);
            lastSuccessfulSyncAt = nowOf();
            if (!cont) return;
          }
        } catch (err) {
          markError(`imap initialScan failed folder=${state.folder}`, err);
        } finally {
          pendingQueueSize = Math.max(0, pendingQueueSize - 1);
        }
      }
    },

    async startSync(cb: ProviderSyncCallback): Promise<() => Promise<void>> {
      if (!connected) {
        throw new Error('imap provider: startSync called before connect');
      }
      for (const state of folders.values()) {
        state.stopIdle = attachListeners(state, cb);
      }
      return async (): Promise<void> => {
        // Detach listeners but leave the clients open — `close` owns
        // the teardown so drain can run close once without double
        // LOGOUT.
        for (const state of folders.values()) {
          try { state.stopIdle?.(); } catch { /* detach best-effort */ }
          state.stopIdle = null;
        }
      };
    },

    async close(): Promise<void> {
      stopped = true;
      for (const state of folders.values()) {
        try { state.stopIdle?.(); } catch { /* detach best-effort */ }
        state.stopIdle = null;
        if (state.client) {
          try {
            if (state.client.usable) await state.client.logout();
            else state.client.close();
          } catch (err) {
            markError(`imap logout failed folder=${state.folder}`, err);
            try { state.client.close(); } catch { /* swallow */ }
          }
          state.client = null;
        }
      }
      folders.clear();
      connected = false;
    },

    health(): ProviderHealth {
      return {
        last_successful_sync_at: lastSuccessfulSyncAt,
        error_count_24h: errorCount24h,
        pending_queue_size: pendingQueueSize,
      };
    },

    lookupSentByReconciliationId,

    ...(sendCapable ? { send: sendImpl } : {}),
  };

  return provider;
};
