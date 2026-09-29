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
  MailAdapterError,
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
  mailSentReconciliationAttachmentPartFromBytes,
  mimeFilenameParameter,
  type CanonicalMessage,
  type InitialScanOptions,
  type MailSyncFailureKind,
  type MailSyncOutcomeListener,
  type InboundMailAttachmentPart,
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
/** The PRODUCTION transport. Nothing else — no env branch.
 *
 *  ⛔ This used to consult `RECUED_BENCH_SMTP_OUTBOX` and, when set, divert the
 *  send to a no-network outbox recorder so the substrate-bench could execute an
 *  APPROVED `mail-send` offline. The lazy `require` meant production never
 *  LOADED the dev module, but the branch itself shipped: esbuild statically
 *  bundled it, so `dist/bin.js` carried the diversion. One env var on a real
 *  server therefore made every outbound mail silently not-send while the mock
 *  returned a synthetic `250 2.0.0 OK` — a delivery failure reported as
 *  `success: true`.
 *
 *  Callers that need a different transport now INJECT one:
 *  `MailAdapterBundle.smtpFactory` → `createImapProvider({ smtpFactory })`
 *  (`compose.ts`). The bench supplies it through its own source-patch step
 *  (internal benchmarks), the same mechanism it already
 *  uses for `wire-chat-orchestrator.ts` — so the diversion exists only in the
 *  bench's own bundle and cannot reach a release artifact. */
export const defaultSmtpTransportFactory: SmtpTransportFactory = (config) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require('nodemailer') as {
    createTransport: (cfg: unknown) => unknown;
  };
  return nodemailer.createTransport(config) as SmtpTransport;
};

/** Does this SMTP failure PROVE the server never accepted the message?
 *
 *  Only then may the send claim start afresh (`not_sent`); anything else is an
 *  unknown outcome, because an SMTP server that has taken the whole message may
 *  deliver it even when the reply never reaches us.
 *
 *  Proof is one of:
 *   - the server's own REFUSAL: a 4xx/5xx reply, at any stage. Acceptance is a
 *     2xx after the message, and nodemailer only raises an error carrying a code
 *     when the server said no;
 *   - a stage that ends before the message is ever transmitted: DNS, TLS, sign-in
 *     (`EDNS` / `ETLS` / `EAUTH`), the envelope (`EENVELOPE`, `EREQUIRETLS`);
 *   - the socket never connected (`syscall` `connect` / `getaddrinfo`).
 *
 *  ⚠ NOT `command === 'CONN'`: nodemailer labels EVERY socket error and timeout
 *  that way, including ones in the middle of the message. */
export const smtpProvablyNotAccepted = (err: unknown): boolean => {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; responseCode?: unknown; syscall?: unknown };
  if (typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 600) {
    return true;
  }
  if (
    e.code === 'EDNS' || e.code === 'ETLS' || e.code === 'EAUTH'
    || e.code === 'EENVELOPE' || e.code === 'EREQUIRETLS'
  ) {
    return true;
  }
  return e.syscall === 'connect' || e.syscall === 'getaddrinfo';
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
  /** Durable pair-local journal for live IDLE notifications. IMAP has no
   *  provider cursor equivalent to Gmail historyId or Graph deltaLink, so a
   *  callback rejection must be remembered explicitly until the collection
   *  acknowledges it. Production always supplies the shared account store. */
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
      `Content-Type: ${att.mime_type}; ${mimeFilenameParameter('name', att.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${mimeFilenameParameter('filename', att.filename)}`,
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
  client: ImapClient | null;
  stopIdle: (() => void) | null;
  reconnectTask: Promise<void> | null;
  deliveryRetryTask: Promise<void> | null;
  pollTasks: Set<Promise<void>>;
  attempts: number;
  /** Fallback for servers that cannot emit QRESYNC VANISHED UIDs. Sequence
   *  numbers are mailbox positions, not identifiers, and shift on EXPUNGE. */
  seqToUid: Map<number, number>;
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
  const cancelReconnectDelays = new Set<() => void>();

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

  const makeClient = (folder: string): ImapClient => {
    const cfg = opts.config();
    return clientFactory({
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
    });
  };

  const markError = (msg: string, err: unknown): void => {
    errorCount24h++;
    opts.log?.('warn', msg, { err: err instanceof Error ? err.message : String(err) });
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
      const iter = state.client.fetch(
        addressing === 'uid' ? [identifier] : String(identifier),
        { uid: true, flags: true, envelope: true, internalDate: true, source: true },
        ...(addressing === 'uid' ? [{ uid: true }] : []),
      );
      let found = false;
      for await (const msg of iter) {
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
      }
      if (!found) {
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
      if (stopped) return false;
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
    while (!stopped && [...pendingDeliveries.values()].some(
      (delivery) => delivery.folder === state.folder,
    )) {
      if (stopped) return;
      if (attempts > 0) {
        const cfg = opts.config();
        const cap = cfg.reconnectCapMs ?? DEFAULT_RECONNECT_CAP_MS;
        const init = cfg.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
        await waitForReconnectDelay(Math.min(init * Math.pow(2, attempts - 1), cap));
        if (stopped) return;
      }
      attempts++;
      await outcomes.run('poll', async () => {
        await drainPendingDeliveries(state, cb);
      });
      if (stopped) return;
    }
  };

  const scheduleDeliveryRetry = (
    state: FolderState,
    cb: ProviderSyncCallback,
  ): void => {
    if (
      stopped
      || state.deliveryRetryTask
      || ![...pendingDeliveries.values()].some((delivery) => delivery.folder === state.folder)
    ) return;
    let task!: Promise<void>;
    task = deliveryRetryLoop(state, cb)
      .catch((err) => {
        if (!stopped) markError(`imap delivery retry failed folder=${state.folder}`, err);
      })
      .finally(() => {
        if (state.deliveryRetryTask === task) state.deliveryRetryTask = null;
      });
    state.deliveryRetryTask = task;
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
      if (stopped) return;
      scheduleReconnect(state, cb);
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

  const rebuildSequenceMap = async (state: FolderState): Promise<void> => {
    state.seqToUid.clear();
    if (!state.client || lastBackfillDays === null) return;
    const since = new Date(nowOf() - lastBackfillDays * 86400_000);
    const uids = await state.client.search({ since }, { uid: true });
    if (uids === false || uids.length === 0) return;
    const iter = state.client.fetch(uids, { uid: true }, { uid: true });
    for await (const msg of iter) {
      if (
        Number.isSafeInteger(msg.seq)
        && msg.seq > 0
        && Number.isSafeInteger(msg.uid)
        && msg.uid > 0
      ) {
        state.seqToUid.set(msg.seq, msg.uid);
      }
    }
  };

  const reconnectLoop = async (
    state: FolderState,
    cb: ProviderSyncCallback,
  ): Promise<void> => {
    while (!stopped) {
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
        if (!stopped) markError(`imap reconnect delay failed folder=${state.folder}`, err);
        return;
      }
      if (stopped) return;

      let candidate: ImapClient | null = null;
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
        if (stopped) {
          try { candidate.close(); } catch { /* shutdown containment */ }
          if (state.client === candidate) state.client = null;
          return;
        }
        state.direction = await resolveFolderDirection(candidate, state.folder);
        await candidate.mailboxOpen(state.folder);
        // Sequence positions can change while disconnected. Rebuild the
        // mapping for the same backfill window rather than carrying stale
        // positions into a non-QRESYNC EXPUNGE fallback.
        await rebuildSequenceMap(state);
        if (stopped) {
          try { candidate.close(); } catch { /* shutdown containment */ }
          if (state.client === candidate) state.client = null;
          return;
        }
      } catch (err) {
        try { candidate?.close(); } catch { /* failed attempt cleanup */ }
        if (candidate && state.client === candidate) state.client = null;
        if (stopped) return;
        markError(`imap reconnect failed folder=${state.folder}`, err);
        // Reported per ATTEMPT, not once per outage: the owned loop retries, so
        // a permanently-bad credential keeps re-asserting `auth` rather than
        // reporting once and going quiet.
        reportReconnect(state.folder, false, isImapAuthFailure(err) ? 'auth' : 'transient');
        continue;
      }

      state.stopIdle = attachListeners(state, cb);
      scheduleDeliveryRetry(state, cb);
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
    if (stopped || state.reconnectTask) return;
    let task!: Promise<void>;
    task = reconnectLoop(state, cb)
      .catch((err) => {
        // The loop contains expected transport failures. This final boundary
        // owns programmer/config failures too so EventEmitter never launches an
        // unhandled rejection.
        if (!stopped) markError(`imap reconnect loop failed folder=${state.folder}`, err);
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
  // SMTP error mapping (nodemailer surfaces `code` + `responseCode`):
  //   EAUTH                                    → MAIL_SEND_AUTH_FAILED
  //   EENVELOPE / 5xx responseCode             → MAIL_SEND_RECIPIENT_INVALID
  //   ESOCKET / ECONNECTION / ETIMEDOUT / EDNS → MAIL_SEND_NETWORK_FAILED
  //   anything else                            → MAIL_SEND_NETWORK_FAILED
  //
  // …and, separately, whether the failure PROVES the server never accepted the
  // message (`not_sent: true`, which lets the send claim start afresh — see
  // `smtpProvablyNotAccepted`).
  const throwSmtpError = (err: unknown): never => {
    const e = err as { code?: string; responseCode?: number; message?: string };
    const message = e?.message ?? String(err);
    const detail = {
      kind: 'imap' as const,
      slug: opts.slug,
      smtp_code: e?.code,
      smtp_response_code: e?.responseCode,
      ...(smtpProvablyNotAccepted(err) ? { not_sent: true } : {}),
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
    const fromAddress = smtp.from ?? cfg.username;
    const messageId = generateImapMessageId(fromAddress, smtp.host, messageIdUuid);
    const sentAt = nowOf();
    const rfc822 = buildImapRfc5322(msg, { from: fromAddress, messageId, sentAt });

    // ── 1. SMTP submission ────────────────────────────────────
    // ⛔ Built inside its own catch. A transport that cannot even be built has
    // sent nothing, and must say so: it used to throw a bare error from outside
    // the SMTP mapping, which left the send claim `claimed` — and every retry of
    // that exact message refused as outcome-unknown (found live: a `require` gap
    // in the transport factory).
    let transport: SmtpTransport;
    try {
      transport = smtpFactory({
        host: smtp.host,
        port: smtp.port ?? DEFAULT_SMTP_PORT,
        secure: smtp.secure ?? false,
        auth: {
          user: smtp.username ?? cfg.username,
          pass: smtp.password ?? cfg.password,
        },
      });
    } catch (err) {
      markError('imap SMTP transport could not be built', err);
      const message = err instanceof Error ? err.message : String(err);
      throw new IngredientError(
        'MAIL_SEND_NETWORK_FAILED',
        `SMTP submission could not start: ${message.slice(0, 200)}`,
        { kind: 'imap', slug: opts.slug, not_sent: true },
      );
    }
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
    const client = makeClient(`__mutate_${verb}__`);
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
    const client = makeClient('__fetch_message__');
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
      const probe = makeClient('__mutation_probe__');
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
      const probe = makeClient('__draft_probe__');
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
  const scanAllFolders = async (scanOpts: InitialScanOptions): Promise<void> => {
    lastBackfillDays = scanOpts.backfill_days;
    const since = new Date(nowOf() - scanOpts.backfill_days * 86400_000);
    const failures: unknown[] = [];
    let aborted = false;
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
      } catch (err) {
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
    if (failures.length > 0) {
      throw new AggregateError(failures, 'imap initial scan was incomplete');
    }
  };

  const provider: MailProvider = {
    kind: 'imap',
    slug: opts.slug,
    sendCapable,
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
      downFolders.clear();
      const cfg = opts.config();
      const opened = new Map<string, FolderState>();
      try {
        for (const folder of cfg.folders) {
          const client = makeClient(folder);
          let direction: MailMessageDirection = 'unknown';
          try {
            await client.connect();
            direction = await resolveFolderDirection(client, folder);
            await client.mailboxOpen(folder);
          } catch (err) {
            try { client.close(); } catch { /* failed transport containment */ }
            throw err;
          }
          opened.set(folder, {
            folder,
            direction,
            client,
            stopIdle: null,
            reconnectTask: null,
            deliveryRetryTask: null,
            pollTasks: new Set(),
            attempts: 0,
            seqToUid: new Map(),
          });
        }
      } catch (err) {
        markError('imap connect failed', err);
        // Connection admission is all-or-nothing. If folder N fails after
        // folders 1..N-1 opened, close those transports now; otherwise a later
        // connect retry creates a second set while the first remains live.
        for (const state of opened.values()) {
          const client = state.client;
          if (client === null) continue;
          try {
            if (client.usable) await client.logout();
            else client.close();
          } catch {
            try { client.close(); } catch { /* cleanup containment */ }
          }
        }
        folders.clear();
        connected = false;
        throw err;
      }
      for (const [folder, state] of opened) folders.set(folder, state);
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
      return outcomes.run('initial_scan', () => scanAllFolders(scanOpts));
    },

    onSyncOutcome(listener: MailSyncOutcomeListener) {
      return outcomes.subscribe(listener);
    },

    async startSync(cb: ProviderSyncCallback): Promise<() => Promise<void>> {
      if (!connected) {
        throw new Error('imap provider: startSync called before connect');
      }
      await loadPendingDeliveries();
      for (const state of folders.values()) {
        state.stopIdle = attachListeners(state, cb);
        scheduleDeliveryRetry(state, cb);
      }
      return async (): Promise<void> => {
        // Detach listeners but leave the clients open — `close` owns
        // the teardown so drain can run close once without double
        // LOGOUT.
        for (const state of folders.values()) {
          try { state.stopIdle?.(); } catch { /* detach best-effort */ }
          state.stopIdle = null;
        }
        await Promise.allSettled(
          [...folders.values()].flatMap((state) => [...state.pollTasks]),
        );
      };
    },

    async close(): Promise<void> {
      stopped = true;
      for (const cancel of [...cancelReconnectDelays]) cancel();
      const states = [...folders.values()];
      const reconnects = states
        .map((state) => state.reconnectTask)
        .filter((task): task is Promise<void> => task !== null);
      const deliveryRetries = states
        .map((state) => state.deliveryRetryTask)
        .filter((task): task is Promise<void> => task !== null);
      const pollTasks = states.flatMap((state) => [...state.pollTasks]);

      // Close current transports immediately so an in-progress connect/open is
      // interrupted where the client supports it, then await every admitted
      // reconnect. The reconnect loop checks `stopped` after each network await
      // and closes a transport that nevertheless opened late.
      for (const state of states) {
        try { state.stopIdle?.(); } catch { /* detach best-effort */ }
        state.stopIdle = null;
        if (state.client) {
          const client = state.client;
          state.client = null;
          try {
            if (client.usable) await client.logout();
            else client.close();
          } catch (err) {
            markError(`imap logout failed folder=${state.folder}`, err);
            try { client.close(); } catch { /* swallow */ }
          }
        }
      }
      await Promise.allSettled(reconnects);
      await Promise.allSettled(deliveryRetries);
      await Promise.allSettled(pollTasks);
      // Defensive final fence for a client implementation whose `connect()`
      // ignored the first close and completed immediately before its stopped
      // check. Reconnect tasks have settled, so no new client can appear now.
      for (const state of states) {
        if (!state.client) continue;
        try { state.client.close(); } catch { /* shutdown containment */ }
        state.client = null;
      }
      folders.clear();
      connected = false;
    },

    health(): ProviderHealth {
      return {
        last_successful_sync_at: lastSuccessfulSyncAt,
        error_count_24h: errorCount24h,
        pending_queue_size: pendingQueueSize + pendingDeliveries.size,
      };
    },

    lookupSentByReconciliationId,

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
