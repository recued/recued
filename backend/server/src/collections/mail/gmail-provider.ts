/** Phase D (D-106) — Gmail REST provider (Commit 14).
 *
 *  Implements `MailProvider` against the Gmail REST API v1 directly —
 *  no `googleapis` SDK per the spec's dep-bloat rejection. OAuth via
 *  refresh tokens in `account.gmail.{slug}.*`; incremental sync uses
 *  the `history` endpoint with a persisted `historyId` watermark.
 *
 *  Endpoints used:
 *    POST https://oauth2.googleapis.com/token       — via oauth.ts
 *    GET  /gmail/v1/users/me/profile                — first historyId
 *    GET  /gmail/v1/users/me/messages?q=newer_than  — list (paginated)
 *    GET  /gmail/v1/users/me/messages/{id}?format=raw — fetch RFC822
 *    GET  /gmail/v1/users/me/history?startHistoryId — incremental
 *    POST /gmail/v1/users/me/messages/send          — outbound (D-127 P1.3)
 *
 *  `format=raw` returns the base64url-encoded RFC-822 source — we
 *  decode then hand off to `mailparser.simpleParser` for full
 *  canonicalization. Keeps the canonicalizer consistent with IMAP.
 *
 *  Label mapping:
 *    - `folder_or_label` = first match from priority
 *      (INBOX > IMPORTANT > STARRED > SENT > DRAFT) or first label.
 *    - `labels[]` = full list.
 *    - Gmail "trash" is a labelAdded=TRASH event → we treat it as
 *      `deleted` (the message survives 30 days server-side, but from
 *      the warehouse's point of view it's gone).
 *
 *  Push subscriptions (Cloud Pub/Sub `watch`) require a public HTTPS
 *  endpoint — not used in Phase D (polling suffices for personal
 *  mailboxes; push follows in post-packaging work).
 *
 *  D-127 P1.3 — outbound send. Provider opts in by setting
 *  `config.granted_scopes` to the list returned at OAuth completion;
 *  `sendCapable` flips true iff the list contains `gmail.send`.
 *  `send` constructs an RFC 5322 message (text/plain or
 *  multipart/alternative when body_html is supplied), base64url-
 *  encodes it as the `raw` field, and POSTs to
 *  `users/me/messages/send`. Sent messages land in the INBOX/SENT
 *  label automatically — the next inbound `history` tick picks
 *  them up via the existing ingest path. Status mapping:
 *  401 / 403 → MAIL_SEND_AUTH_FAILED, 4xx → MAIL_SEND_RECIPIENT_INVALID,
 *  5xx → MAIL_SEND_NETWORK_FAILED.
 */

import { simpleParser } from 'mailparser';
import type { AddressObject, ParsedMail } from 'mailparser';
import { IngredientError } from '@recued/ingredients';
import {
  GOOGLE_TOKEN_URL,
  isMailReconciliationId,
  MAIL_RECONCILIATION_ID_HEADER,
} from '@recued/contracts';
import {
  ProviderPaginationGuard,
  readProviderStringContinuation,
} from '../../provider-pagination-guard.js';
import {
  mailAttachmentPartFromBytes,
  assertMailSentReconciliationQuery,
  evaluateMailSentReconciliationCandidates,
  MAIL_SENT_RECONCILIATION_MAX_SCAN,
  MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES,
  mailSentReconciliationAttachmentPartFromBytes,
  classifyMailApiStatus,
  classifyOAuthFailure,
  createMailSyncOutcomeReporter,
  normalizeMailAttachmentMimeType,
  sanitizeMailAttachmentFilename,
  type CanonicalMessage,
  type InitialScanOptions,
  type InboundMailAttachmentPart,
  type MailMessageDirection,
  type MailProvider,
  type MailSyncFailureKind,
  type MailSyncOutcomeListener,
  type MailSentReconciliationCandidate,
  type MailSentReconciliationQuery,
  type MailSentReconciliationResult,
  type OutgoingMessage,
  type ProviderHealth,
  type ProviderSyncCallback,
  type ProviderSyncEventKind,
  type SentMessageMeta,
} from './provider.js';
import {
  defaultHttpFetcher,
  getAccessToken,
  grantedScopesInclude,
  keyPrefix,
  OAuthError,
  requireProviderConfig,
  type HttpFetcher,
  type OAuthAccountStore,
  type OAuthProviderConfigSource,
} from './oauth.js';
import {
  startDrainingInterval,
  type ProviderPollScheduler,
  type ProviderPollStop,
} from '../draining-interval.js';

// ────────────────────────────────────────────────────────────────
// Gmail-specific config + constants
// ────────────────────────────────────────────────────────────────

export interface GmailProviderConfig {
  /** Matches the account.gmail.{slug}.* namespace entry. */
  account_slug: string;
  /** Days of backfill on first run. */
  backfill_days: number;
  /** Poll cadence for the history endpoint. Default 30 s per spec. */
  poll_seconds: number;
  /** Whitelist of labels to sync (empty = all). Gmail label ids:
   *  `INBOX`, `SENT`, `IMPORTANT`, user-defined Label_*. */
  label_filter?: string[];
  /** D-127 P1.3 — OAuth scopes the user actually granted at consent
   *  (parsed from the token-exchange `scope` field). Drives
   *  `sendCapable`: outbound is enabled only when this list contains
   *  the Gmail send scope, regardless of what was requested. P4.2
   *  wires the scope persistence end-to-end; until then callers leave
   *  this undefined and the provider stays read-only. */
  granted_scopes?: string[];
  /** D-127 P1.6 — canonical account email surfaced via
   *  `MailProvider.accountEmail`. Captured at OAuth completion from
   *  the gmail `users.getProfile` response (`emailAddress`). P4.2
   *  wires the populate path; until then the provider exposes empty
   *  string and the rpc-layer self-loop guard is a no-op. */
  account_email?: string;
}

export interface CreateGmailProviderOptions {
  slug: string;
  config: () => GmailProviderConfig;
  accountStore: OAuthAccountStore;
  providerConfig: OAuthProviderConfigSource;
  fetcher?: HttpFetcher;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** Test hook — override the poll scheduler so suites don't wait
   *  for real timers. Receives the tick callback; returns a stop
   *  function. Production uses `setInterval`. */
  scheduler?: ProviderPollScheduler;
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const LABEL_PRIORITY = ['INBOX', 'IMPORTANT', 'STARRED', 'SENT', 'DRAFT'] as const;
const DELETED_LABEL = 'TRASH';

/** D-127 P1.3 — OAuth scope that toggles outbound send capability.
 *  `sendCapable` flips true iff the user's granted-scope list contains
 *  this exact value. Documented at
 *  https://developers.google.com/identity/protocols/oauth2/scopes#gmail. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

// ────────────────────────────────────────────────────────────────
// Canonicalizer — shared body extraction with IMAP
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

const bodyTextFor = (parsed: ParsedMail): string => {
  if (parsed.text && parsed.text.length > 0) return parsed.text;
  if (parsed.html) return String(parsed.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
};

const hasAttachments = (parsed: ParsedMail): boolean =>
  Array.isArray(parsed.attachments)
    && parsed.attachments.some((a) => Boolean(a.filename));

const pickFolder = (labels: string[]): string => {
  for (const p of LABEL_PRIORITY) {
    if (labels.includes(p)) return p;
  }
  return labels[0] ?? '';
};

/** Gmail system-label IDs are stable across UI languages. Prefer Draft/Sent
 * over Inbox because a self-addressed or transitioning message can carry more
 * than one system label. */
export const gmailMessageDirection = (labels: readonly string[]): MailMessageDirection => {
  if (labels.includes('DRAFT')) return 'draft';
  if (labels.includes('SENT')) return 'outbound';
  if (labels.includes('INBOX')) return 'inbound';
  return 'unknown';
};

const base64UrlDecode = (s: string): Buffer => {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
  return Buffer.from(padded, 'base64');
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

export interface GmailMessagePayload {
  id: string;
  threadId: string;
  labelIds?: string[];
  raw?: string; // base64url-encoded RFC-822
  internalDate?: string; // epoch ms as string
}

interface GmailMessagePartBody {
  attachmentId?: string;
  data?: string;
  size?: number;
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
}

interface GmailMessageFullPayload extends GmailMessagePayload {
  payload?: GmailMessagePart;
}

interface GmailMessageMetadataPayload extends GmailMessagePayload {
  payload?: GmailMessagePart;
  sizeEstimate?: number;
}

interface GmailAttachmentPayload {
  attachmentId?: string;
  data?: string;
  size?: number;
}

export const canonicalizeGmail = async (
  msg: GmailMessagePayload,
): Promise<CanonicalMessage> => {
  if (!msg.raw) {
    throw new Error(`gmail message ${msg.id} missing raw body`);
  }
  const rfc822 = base64UrlDecode(msg.raw);
  const parsed = await simpleParser(rfc822);
  const labels = msg.labelIds ?? [];
  const internalDate = msg.internalDate ? Number(msg.internalDate) : 0;
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
    : Number.isFinite(internalDate) && internalDate > 0
      ? internalDate
      : Date.now();
  return {
    source_id: msg.id,
    rfc_message_id: parsed.messageId ?? undefined,
    ...(isMailReconciliationId(reconciliationId)
      ? { reconciliation_id: reconciliationId }
      : {}),
    from: parsed.from ? firstAddress(parsed.from) : '',
    to: addressToStringList(parsed.to),
    cc: addressToStringList(parsed.cc),
    subject: parsed.subject ?? '',
    thread_id: msg.threadId ?? '',
    folder_or_label: pickFolder(labels),
    direction: gmailMessageDirection(labels),
    is_read: !labels.includes('UNREAD'),
    has_attachments: hasAttachments(parsed) || attachments.length > 0,
    received_at: receivedAt,
    body_text: bodyTextFor(parsed),
    body_html: typeof parsed.html === 'string' ? parsed.html : undefined,
    labels,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
};

// ────────────────────────────────────────────────────────────────
// API helpers
// ────────────────────────────────────────────────────────────────

interface GmailFetchOptions {
  accessToken: string;
  fetcher: HttpFetcher;
}

/** Perform a GET against the Gmail API with automatic 401 handling.
 *  On 401 the caller is expected to refresh the access token and
 *  retry — we surface it via a distinct return shape so callers can
 *  retry with `force: true`. */
const gmailGet = async <T>(
  url: string,
  opts: GmailFetchOptions,
): Promise<{ ok: true; data: T } | { ok: false; status: number; text: string }> => {
  const res = await opts.fetcher(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, text };
  }
  const data = (await res.json()) as T;
  return { ok: true, data };
};

interface GmailProfile { historyId: string; emailAddress: string; }
interface GmailMessageRef { id: string; threadId: string; }
interface GmailMessageList {
  messages?: GmailMessageRef[];
  nextPageToken?: unknown;
  resultSizeEstimate?: number;
}
interface GmailHistoryResponse {
  history?: Array<{
    id: string;
    messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }>;
    messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
    labelsAdded?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
    labelsRemoved?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
  }>;
  historyId?: string;
  nextPageToken?: unknown;
}

// ────────────────────────────────────────────────────────────────
// D-127 P1.3 — outbound send helpers (RFC 5322 + base64url)
// ────────────────────────────────────────────────────────────────

/** Format a unix-ms timestamp as an RFC 5322 Date header value.
 *  `toUTCString()` produces "Mon, 01 Jan 2024 10:00:00 GMT"; RFC 5322
 *  requires a numeric zone offset, so we swap `GMT` for `+0000`. */
const formatRfc5322Date = (ms: number): string =>
  new Date(ms).toUTCString().replace(/GMT$/, '+0000');

/** Generate a unique multipart MIME boundary. Random suffix avoids
 *  any chance of collision with body content; the `recued_` prefix
 *  makes the messages identifiable on the wire when debugging. */
const newMimeBoundary = (rand: () => number = Math.random): string =>
  `recued_${Date.now().toString(36)}_${rand().toString(36).slice(2, 10)}`;

/** D-172 P2 — chunk a base64 string into 76-char lines per RFC 2045
 *  §6.8 (`Content-Transfer-Encoding: base64` lines SHOULD be ≤76
 *  chars). Some strict MTAs reject one giant unbroken line. */
const wrapBase64 = (b64: string): string =>
  (b64.match(/.{1,76}/g) ?? []).join('\r\n');

/** D-172 P2 — render the message body as a single MIME part (the
 *  inner part when attachments wrap it in multipart/mixed): a bare
 *  text/plain part, or a nested multipart/alternative when `body_html`
 *  is present. Returns the `Content-Type` line(s) to emit + the part
 *  body so callers can place it either at top level (no attachments) or
 *  as the lead part of a multipart/mixed (with attachments). */
const renderGmailBodyPart = (
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

/** Construct an RFC 5322 message from `OutgoingMessage`. Single-part
 *  text/plain when `body_html` is omitted; multipart/alternative
 *  containing both text and HTML when supplied.
 *
 *  D-172 P2 — when `attachments` are present, the whole thing is
 *  wrapped in a `multipart/mixed` container: the body (text or
 *  multipart/alternative) is the first part, each attachment follows
 *  as a base64-encoded part with `Content-Disposition: attachment`.
 *
 *  Headers use CRLF per RFC; the API's `raw` field accepts either
 *  CR/LF style but CRLF is the spec'd canonical form. */
export const buildGmailRfc5322 = (
  msg: OutgoingMessage,
  sentAt: number,
  rand: () => number = Math.random,
): string => {
  const headers: string[] = [];
  headers.push('MIME-Version: 1.0');
  headers.push(`Date: ${formatRfc5322Date(sentAt)}`);
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
    // RFC 5322 §3.6.4 — References is space-separated msg-id list.
    headers.push(`References: ${msg.references.join(' ')}`);
  }

  const part = renderGmailBodyPart(msg, rand);
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

/** RFC 4648 §5 base64url. Gmail's `raw` field is documented as
 *  "URL-safe base64". Strips trailing `=` padding per the same spec
 *  (Gmail accepts padded or unpadded). */
const base64UrlEncode = (s: string): string =>
  Buffer.from(s, 'utf-8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

// ────────────────────────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────────────────────────

export const createGmailProvider = (
  opts: CreateGmailProviderOptions,
): MailProvider => {
  const fetcher = opts.fetcher ?? defaultHttpFetcher;
  const nowOf = (): number => opts.now?.() ?? Date.now();

  let stopped = false;
  let pollStop: ProviderPollStop | null = null;
  let lastSuccessfulSyncAt = 0;
  let errorCount24h = 0;
  let pendingQueueSize = 0;
  let accessToken = '';

  const historyIdKey = (): string =>
    `${keyPrefix('gmail', opts.config().account_slug)}.history_id`;

  const markError = (msg: string, err: unknown): void => {
    errorCount24h++;
    opts.log?.('warn', msg, { err: err instanceof Error ? err.message : String(err) });
  };

  // Per-attempt outcome reporting. A thrown error out of a scan / tick is almost
  // always an `OAuthError` from the token refresh, so classify on its status —
  // where 400 means `invalid_grant`, i.e. auth (see `classifyOAuthStatus`).
  const outcomes = createMailSyncOutcomeReporter({
    now: nowOf,
    classifyError: (err): MailSyncFailureKind =>
      err instanceof OAuthError
        ? classifyOAuthFailure(err.status, err.oauth_error)
        : 'transient',
  });

  /** Record a swallowed read failure so the enclosing attempt reports it. The
   *  `getWithRetry` shape returns `null` and the callers early-return, so
   *  without this a 403 on the history endpoint looks exactly like a clean
   *  no-op tick. */
  const noteReadFailure = (status: number, msg: string, body: unknown): void => {
    // The BODY is threaded in, not just the status: a 403 is quota far more often
    // than it is a scope problem, and only the body's `reason` tells them apart.
    outcomes.noteFailure(
      classifyMailApiStatus(status, typeof body === 'string' ? body : undefined),
    );
    markError(msg, body);
  };

  const ensureToken = async (force: boolean): Promise<string> => {
    if (accessToken && !force) return accessToken;
    accessToken = await getAccessToken({
      provider: 'gmail',
      slug: opts.config().account_slug,
      providerConfig: requireProviderConfig(opts.providerConfig),
      accountStore: opts.accountStore,
      fetcher,
      now: opts.now,
      force,
    });
    return accessToken;
  };

  /** Shared read helper.
   *
   *  ⚠ `treat404AsAbsent` exists because 404 means two OPPOSITE things on this
   *  API. On a message-detail read it is a deleted message — routine, not a
   *  failure. On `users.history.list` it means the `startHistoryId` has aged out
   *  of Gmail's history window and a FULL SYNC is required
   *  (developers.google.com/workspace/gmail/api/guides/sync). Treating the
   *  latter as absent made the tick return normally and report SUCCESS forever
   *  while no mail was ever ingested again — the stale watermark is never
   *  advanced, so every subsequent tick 404s identically. Callers that cannot
   *  survive a silent 404 pass `false`. */
  const getWithRetry = async <T>(
    url: string,
    {
      treat404AsAbsent = true,
      onFailureStatus,
    }: {
      treat404AsAbsent?: boolean;
      /** Observe the failing status. A per-call CLOSURE rather than shared
       *  provider state, so overlapping ticks cannot read each other's status. */
      onFailureStatus?: (status: number) => void;
    } = {},
  ): Promise<T | null> => {
    const first = await gmailGet<T>(url, { accessToken: await ensureToken(false), fetcher });
    if (first.ok) return first.data;
    if (first.status === 401) {
      const second = await gmailGet<T>(url, {
        accessToken: await ensureToken(true),
        fetcher,
      });
      if (second.ok) return second.data;
      if (second.status === 404 && treat404AsAbsent) return null;
      onFailureStatus?.(second.status);
      noteReadFailure(second.status, `gmail ${url} → ${second.status}`, second.text);
      return null;
    }
    if (first.status === 404 && treat404AsAbsent) return null;
    onFailureStatus?.(first.status);
    noteReadFailure(first.status, `gmail ${url} → ${first.status}`, first.text);
    return null;
  };

  /** Reconciliation cannot collapse transport/auth failures into an empty
   * result, so it uses a strict sibling of the sync helper. */
  const getReconciliationSource = async <T>(url: string): Promise<T> => {
    const first = await gmailGet<T>(url, { accessToken: await ensureToken(false), fetcher });
    if (first.ok) return first.data;
    if (first.status === 401) {
      const second = await gmailGet<T>(url, {
        accessToken: await ensureToken(true),
        fetcher,
      });
      if (second.ok) return second.data;
      throw new Error(`gmail reconciliation source read failed (${second.status})`);
    }
    throw new Error(`gmail reconciliation source read failed (${first.status})`);
  };

  const fetchMessageRaw = async (id: string): Promise<GmailMessagePayload | null> => {
    let failureStatus: number | undefined;
    const message = await getWithRetry<GmailMessagePayload>(
      `${GMAIL_API_BASE}/messages/${id}?format=raw`,
      { onFailureStatus: (status) => { failureStatus = status; } },
    );
    if (message === null && failureStatus !== undefined) {
      throw new Error(`gmail message ${id} read failed (${failureStatus})`);
    }
    return message;
  };

  const fetchMessageFull = async (id: string): Promise<GmailMessageFullPayload | null> => {
    return getWithRetry<GmailMessageFullPayload>(
      `${GMAIL_API_BASE}/messages/${id}?format=full`,
    );
  };

  const fetchAttachmentPayload = async (
    messageId: string,
    attachmentId: string,
  ): Promise<GmailAttachmentPayload | null> => {
    return getWithRetry<GmailAttachmentPayload>(
      `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  };

  const attachmentBytesFetcher = (
    messageId: string,
    body: GmailMessagePartBody | undefined,
  ): (() => Promise<Buffer>) => {
    const inlineData = body?.data;
    const attachmentId = body?.attachmentId;
    return async () => {
      if (inlineData) return base64UrlDecode(inlineData);
      if (!attachmentId) {
        throw new Error(`gmail attachment on ${messageId} missing attachmentId`);
      }
      const payload = await fetchAttachmentPayload(messageId, attachmentId);
      if (!payload?.data) {
        throw new Error(`gmail attachment ${attachmentId} on ${messageId} missing data`);
      }
      return base64UrlDecode(payload.data);
    };
  };

  const collectGmailAttachmentParts = (
    messageId: string,
    part: GmailMessagePart | undefined,
    path = '0',
    out: InboundMailAttachmentPart[] = [],
  ): InboundMailAttachmentPart[] => {
    if (!part) return out;
    const filename = part.filename ?? '';
    const body = part.body;
    if (filename.length > 0 && (body?.attachmentId || body?.data)) {
      const sourcePartId = body.attachmentId ?? part.partId ?? path;
      const size = typeof body.size === 'number' && Number.isFinite(body.size)
        ? body.size
        : body.data
          ? base64UrlDecode(body.data).length
          : 0;
      out.push({
        filename: sanitizeMailAttachmentFilename(filename, `attachment-${out.length + 1}`),
        mime_type: normalizeMailAttachmentMimeType(part.mimeType),
        size,
        source_part_id: sourcePartId,
        fetchBytes: attachmentBytesFetcher(messageId, body),
      });
    }
    for (const [idx, child] of (part.parts ?? []).entries()) {
      collectGmailAttachmentParts(messageId, child, `${path}.${idx}`, out);
    }
    return out;
  };

  const hydrateGmailAttachments = async (
    canonical: CanonicalMessage,
  ): Promise<CanonicalMessage> => {
    if (!canonical.has_attachments) return canonical;
    const full = await fetchMessageFull(canonical.source_id);
    if (!full) {
      throw new Error(`gmail message ${canonical.source_id} missing full payload for attachments`);
    }
    const fullParts = collectGmailAttachmentParts(canonical.source_id, full.payload);
    if (fullParts.length > 0) {
      return { ...canonical, attachments: fullParts, has_attachments: true };
    }
    return canonical;
  };

  const applyLabelFilter = (labels: string[] | undefined): boolean => {
    const filter = opts.config().label_filter ?? [];
    if (filter.length === 0) return true;
    if (!labels) return false;
    return labels.some((l) => filter.includes(l));
  };

  const fetchAndEmit = async (
    id: string,
    kind: ProviderSyncEventKind,
    cb: ProviderSyncCallback,
  ): Promise<boolean> => {
    pendingQueueSize++;
    try {
      if (kind === 'deleted') {
        await cb({ kind: 'deleted', source_id: id });
        lastSuccessfulSyncAt = nowOf();
        return true;
      }
      const raw = await fetchMessageRaw(id);
      // A message that disappeared between history.list and messages.get is
      // already in the desired absent state. It needs no callback and is safe
      // to acknowledge; non-404 read failures throw from fetchMessageRaw.
      if (!raw) return true;
      if (!applyLabelFilter(raw.labelIds)) return true;
      const canonical = await hydrateGmailAttachments(await canonicalizeGmail(raw));
      await cb({ kind, source_id: canonical.source_id, message: canonical });
      lastSuccessfulSyncAt = nowOf();
      return true;
    } catch (err) {
      // The history cursor is the retry journal. Report the attempt as failed
      // and tell the caller not to advance it; resolving here used to turn a
      // transient detail/attachment/collection failure into permanent loss.
      outcomes.noteFailure('transient');
      markError(`gmail ingest failed id=${id}`, err);
      return false;
    } finally {
      pendingQueueSize = Math.max(0, pendingQueueSize - 1);
    }
  };

  const writeHistoryWatermark = async (newId: string): Promise<void> => {
    await opts.accountStore.set(historyIdKey(), newId);
  };

  const readHistoryWatermark = async (): Promise<string | null> => {
    return opts.accountStore.get(historyIdKey());
  };

  // ── initial scan ────────────────────────────────────────────
  const runInitialScan = async (scanOpts: InitialScanOptions): Promise<void> => {
    // Capture historyId before listing — ensures we don't miss
    // deliveries that arrive between list + sync start. Gmail ordering
    // guarantees `history?startHistoryId=profile.historyId` returns
    // everything after the profile fetch.
    // Preserve the first pre-scan watermark across a failed backfill retry.
    // Replacing it with "now" on every attempt loses changes (especially
    // deletions) that happened after the first scan began.
    if ((await readHistoryWatermark()) === null) {
      const profile = await getWithRetry<GmailProfile>(`${GMAIL_API_BASE}/profile`, {
        treat404AsAbsent: false,
      });
      if (!profile || typeof profile.historyId !== 'string' || profile.historyId.length === 0) {
        throw new Error('gmail initial scan could not establish a history watermark');
      }
      await writeHistoryWatermark(profile.historyId);
    }

    let pageToken: string | undefined;
    let aborted = false;
    const failures: unknown[] = [];
    const q = `newer_than:${scanOpts.backfill_days}d`;
    const pagination = new ProviderPaginationGuard('gmail initial scan', {
      trustedBaseUrl: GMAIL_API_BASE,
    });
    do {
      const url = new URL(`${GMAIL_API_BASE}/messages`);
      url.searchParams.set('q', q);
      url.searchParams.set('maxResults', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const list = await getWithRetry<GmailMessageList>(pagination.claim(url.toString()), {
        treat404AsAbsent: false,
      });
      if (!list) {
        throw new Error('gmail initial scan could not fetch a complete message page');
      }
      const ids = (list.messages ?? []).map((m) => m.id);
      for (const id of ids) {
        try {
          const raw = await fetchMessageRaw(id);
          if (!raw) continue;
          if (!applyLabelFilter(raw.labelIds)) continue;
          const canonical = await hydrateGmailAttachments(await canonicalizeGmail(raw));
          const cont = await scanOpts.onMessage(canonical);
          lastSuccessfulSyncAt = nowOf();
          if (!cont) { aborted = true; break; }
        } catch (err) {
          markError(`gmail canonicalize failed id=${id}`, err);
          failures.push(err);
        }
      }
      if (aborted) break;
      pageToken = readProviderStringContinuation(
        list.nextPageToken,
        'gmail initial scan',
      );
    } while (pageToken);
    if (!aborted && failures.length > 0) {
      throw new AggregateError(failures, 'gmail initial scan was incomplete');
    }
  };

  // ── incremental poll ────────────────────────────────────────
  const runHistoryTick = async (cb: ProviderSyncCallback): Promise<void> => {
    const watermark = await readHistoryWatermark();
    if (!watermark) {
      // No watermark → either first run skipped (scan error) or the
      // account store lost state. Re-seed from the profile.
      const profile = await getWithRetry<GmailProfile>(`${GMAIL_API_BASE}/profile`);
      if (profile) await writeHistoryWatermark(profile.historyId);
      return;
    }
    let pageToken: string | undefined;
    let latestId = watermark;
    let deliveryFailed = false;
    // Set when the history endpoint rejects our cursor as aged-out. Per-attempt
    // local, so a concurrent tick cannot clear or observe it.
    let cursorAgedOut = false;
    const pagination = new ProviderPaginationGuard('gmail history', {
      trustedBaseUrl: GMAIL_API_BASE,
    });
    do {
      const url = new URL(`${GMAIL_API_BASE}/history`);
      url.searchParams.set('startHistoryId', watermark);
      url.searchParams.append('historyTypes', 'messageAdded');
      url.searchParams.append('historyTypes', 'messageDeleted');
      url.searchParams.append('historyTypes', 'labelAdded');
      url.searchParams.append('historyTypes', 'labelRemoved');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      // `treat404AsAbsent: false` — a 404 here is an aged-out `startHistoryId`,
      // not an absent record, and it is PERMANENT until the watermark is
      // rebuilt. It must report a failed attempt (see the recovery below).
      const page = await getWithRetry<GmailHistoryResponse>(pagination.claim(url.toString()), {
        treat404AsAbsent: false,
        onFailureStatus: (status) => { if (status === 404) cursorAgedOut = true; },
      });
      if (!page) {
        if (cursorAgedOut) {
          // A profile-only reseed makes the mailbox look healthy again while
          // silently discarding every current message changed during the gap.
          // Capture the replacement boundary first, replay a bounded full list
          // through the same durable callback, and overwrite the invalid cursor
          // only after that replay is acknowledged. If any step fails, retain
          // the old cursor so the next tick retries this recovery path.
          markError('gmail history cursor aged out — running recovery scan', {
            startHistoryId: watermark,
          });
          try {
            const profile = await getWithRetry<GmailProfile>(
              `${GMAIL_API_BASE}/profile`,
              { treat404AsAbsent: false },
            );
            if (
              !profile
              || typeof profile.historyId !== 'string'
              || profile.historyId.length === 0
            ) {
              throw new Error('gmail recovery could not establish a replacement watermark');
            }
            await runInitialScan({
              backfill_days: opts.config().backfill_days,
              onMessage: async (message) => {
                await cb({
                  kind: 'updated',
                  source_id: message.source_id,
                  message,
                });
                return true;
              },
            });
            await writeHistoryWatermark(profile.historyId);
          } catch (err) {
            outcomes.noteFailure(
              err instanceof OAuthError
                ? classifyOAuthFailure(err.status, err.oauth_error)
                : 'transient',
            );
            markError('gmail history recovery scan failed', err);
          }
        }
        return;
      }
      for (const entry of page.history ?? []) {
        for (const add of entry.messagesAdded ?? []) {
          if (!(await fetchAndEmit(add.message.id, 'created', cb))) deliveryFailed = true;
        }
        for (const del of entry.messagesDeleted ?? []) {
          if (!(await fetchAndEmit(del.message.id, 'deleted', cb))) deliveryFailed = true;
        }
        for (const la of entry.labelsAdded ?? []) {
          if (la.labelIds.includes(DELETED_LABEL)) {
            if (!(await fetchAndEmit(la.message.id, 'deleted', cb))) deliveryFailed = true;
          } else {
            if (!(await fetchAndEmit(la.message.id, 'updated', cb))) deliveryFailed = true;
          }
        }
        for (const lr of entry.labelsRemoved ?? []) {
          if (!(await fetchAndEmit(lr.message.id, 'updated', cb))) deliveryFailed = true;
        }
        if (entry.id && Number(entry.id) > Number(latestId)) latestId = entry.id;
      }
      pageToken = readProviderStringContinuation(
        page.nextPageToken,
        'gmail history',
      );
      if (page.historyId && Number(page.historyId) > Number(latestId)) {
        latestId = page.historyId;
      }
    } while (pageToken);
    // Keep the old historyId if any callback failed. Gmail will replay the
    // drained history range on the next scheduled tick; successful callbacks
    // are idempotent collection upserts/deletes, while the failed item gets
    // another chance. A poison item remains visible as a failed outcome rather
    // than being silently skipped.
    if (deliveryFailed) return;
    if (latestId !== watermark) await writeHistoryWatermark(latestId);
    lastSuccessfulSyncAt = nowOf();
  };

  const defaultScheduler: ProviderPollScheduler = (cb, intervalMs) =>
    startDrainingInterval({
      tick: cb,
      intervalMs,
      onError: (err) => markError('gmail poll tick failed', err),
    });

  // ── outbound send (D-127 P1.3) ──────────────────────────────
  //
  // Status mapping mirrors P1.2 § severity classification:
  //   401 / 403  → MAIL_SEND_AUTH_FAILED   (recoverable: re-enroll)
  //   4xx other → MAIL_SEND_RECIPIENT_INVALID (typo / rejected addr)
  //   5xx        → MAIL_SEND_NETWORK_FAILED (transient)
  //
  // Token refresh runs once on the initial 401 (matches `getWithRetry`
  // for read paths); a second 401 after refresh indicates the user
  // revoked or downgraded scopes, so we surface AUTH_FAILED upstream.
  const sendImpl = async (msg: OutgoingMessage): Promise<SentMessageMeta> => {
    const sentAt = nowOf();
    const rfc822 = buildGmailRfc5322(msg, sentAt);
    const raw = base64UrlEncode(rfc822);
    const url = `${GMAIL_API_BASE}/messages/send`;

    const post = async (token: string) => fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });

    let res = await post(await ensureToken(false));
    if (res.status === 401) {
      res = await post(await ensureToken(true));
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const detail = { kind: 'gmail' as const, slug: opts.slug, status: res.status };
      if (res.status === 401 || res.status === 403) {
        markError(`gmail send auth ${res.status}`, text);
        throw new IngredientError(
          'MAIL_SEND_AUTH_FAILED',
          `Gmail rejected the send (${res.status}): ${text.slice(0, 200)}`,
          detail,
        );
      }
      if (res.status >= 400 && res.status < 500) {
        throw new IngredientError(
          'MAIL_SEND_RECIPIENT_INVALID',
          `Gmail rejected a recipient (${res.status}): ${text.slice(0, 200)}`,
          detail,
        );
      }
      markError(`gmail send transient ${res.status}`, text);
      throw new IngredientError(
        'MAIL_SEND_NETWORK_FAILED',
        `Gmail send failed transiently (${res.status}): ${text.slice(0, 200)}`,
        detail,
      );
    }

    const data = (await res.json()) as { id?: string; threadId?: string };
    if (!data || typeof data.id !== 'string' || data.id.length === 0) {
      throw new IngredientError(
        'MAIL_SEND_NETWORK_FAILED',
        'Gmail send returned a malformed response (missing id)',
        { kind: 'gmail', slug: opts.slug, status: res.status },
      );
    }
    lastSuccessfulSyncAt = nowOf();
    return {
      // Spec § 1.3 — Gmail's server-assigned id doubles as the
      // Message-Id surface for the warehouse: the next inbound
      // history tick indexes the Sent record under the same id.
      source_id: data.id,
      message_id: data.id,
      sent_at: sentAt,
      thread_id: data.threadId,
    };
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

  const gmailMetadataReconciliationHeaderValues = (
    message: GmailMessageMetadataPayload,
  ): string[] => (message.payload?.headers ?? [])
    .filter((header) => header.name?.toLowerCase()
      === MAIL_RECONCILIATION_ID_HEADER.toLowerCase())
    .map((header) => header.value ?? '');

  const gmailReconciliationCandidate = async (
    msg: GmailMessagePayload,
  ): Promise<MailSentReconciliationCandidate> => {
    if (!msg.raw) throw new Error(`gmail message ${msg.id} missing raw body`);
    if (!(msg.labelIds ?? []).includes('SENT')) {
      throw new Error(`gmail message ${msg.id} left Sent during reconciliation`);
    }
    const maxEncodedSourceBytes = 4 * Math.ceil(
      MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES / 3,
    ) + 4;
    if (Buffer.byteLength(msg.raw, 'ascii') > maxEncodedSourceBytes) {
      throw new Error(`gmail message ${msg.id} exceeds the reconciliation source cap`);
    }
    const source = base64UrlDecode(msg.raw);
    if (source.length > MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES) {
      throw new Error(`gmail message ${msg.id} exceeds the reconciliation source cap`);
    }
    const parsed = await simpleParser(source);
    const sentAt = msg.internalDate ? Number(msg.internalDate) : parsed.date?.getTime();
    if (!Number.isSafeInteger(sentAt) || (sentAt as number) < 0) {
      throw new Error(`gmail message ${msg.id} missing a safe provider timestamp`);
    }
    return {
      source_id: msg.id,
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
    let pageToken: string | undefined;
    const pagination = new ProviderPaginationGuard('gmail sent reconciliation', {
      trustedBaseUrl: GMAIL_API_BASE,
    });
    try {
      do {
        const remaining = MAIL_SENT_RECONCILIATION_MAX_SCAN - candidates.length;
        if (remaining <= 0) {
          return evaluateMailSentReconciliationCandidates(query, candidates, false);
        }
        const url = new URL(`${GMAIL_API_BASE}/messages`);
        // Search one slightly wider provider window, then enforce millisecond
        // bounds against each fetched source message in the shared verifier.
        const afterSeconds = Math.max(0, Math.floor(query.sent_after / 1_000) - 1);
        const beforeSeconds = Math.ceil(query.sent_before / 1_000) + 1;
        url.searchParams.set('q', `after:${afterSeconds} before:${beforeSeconds}`);
        url.searchParams.append('labelIds', 'SENT');
        url.searchParams.set('maxResults', String(Math.min(50, remaining)));
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const page = await getReconciliationSource<GmailMessageList>(
          pagination.claim(url.toString()),
        );
        for (const ref of page.messages ?? []) {
          if (candidates.length >= MAIL_SENT_RECONCILIATION_MAX_SCAN) {
            return evaluateMailSentReconciliationCandidates(query, candidates, false);
          }
          const metadataUrl = new URL(
            `${GMAIL_API_BASE}/messages/${encodeURIComponent(ref.id)}`,
          );
          metadataUrl.searchParams.set('format', 'metadata');
          for (const header of [
            MAIL_RECONCILIATION_ID_HEADER,
            'Message-ID',
            'To',
            'Subject',
          ]) {
            metadataUrl.searchParams.append('metadataHeaders', header);
          }
          const metadata = await getReconciliationSource<GmailMessageMetadataPayload>(
            metadataUrl.toString(),
          );
          const headerValues = gmailMetadataReconciliationHeaderValues(metadata);
          if (!headerValues.some((value) => value.trim() === query.reconciliation_id)) {
            candidates.push({
              source_id: metadata.id,
              reconciliation_header_values: headerValues,
              to: [],
              cc: [],
              bcc: [],
              subject: '',
              sent_at: 0,
              attachments: [],
              attachment_set_complete: false,
            });
            continue;
          }
          if (
            !Number.isSafeInteger(metadata.sizeEstimate)
            || metadata.sizeEstimate! <= 0
            || metadata.sizeEstimate! > MAIL_SENT_RECONCILIATION_MAX_SOURCE_BYTES
          ) {
            candidates.push({
              source_id: metadata.id,
              reconciliation_header_values: headerValues,
              to: [],
              cc: [],
              bcc: [],
              subject: '',
              sent_at: 0,
              attachments: [],
              attachment_set_complete: false,
            });
            continue;
          }
          const raw = await getReconciliationSource<GmailMessagePayload>(
            `${GMAIL_API_BASE}/messages/${encodeURIComponent(ref.id)}?format=raw`,
          );
          candidates.push(await gmailReconciliationCandidate(raw));
        }
        pageToken = readProviderStringContinuation(
          page.nextPageToken,
          'gmail sent reconciliation',
        );
        if (pageToken && candidates.length >= MAIL_SENT_RECONCILIATION_MAX_SCAN) {
          return evaluateMailSentReconciliationCandidates(query, candidates, false);
        }
      } while (pageToken);
      lastSuccessfulSyncAt = nowOf();
      return evaluateMailSentReconciliationCandidates(query, candidates, true);
    } catch (err) {
      markError('gmail sent reconciliation lookup failed', err);
      return {
        status: 'unavailable',
        reason: 'provider_error',
        scanned_candidates: candidates.length,
      };
    }
  };

  // sendCapable lockstep with `send`: derive once at construction
  // from the user's granted-scope list. Re-enrollment with new
  // scopes recreates the provider — config() is read once here so
  // a later mutation can't desync the field from the method.
  // Tolerant match — a provider need not echo a scope in the form it was
  // requested, and an exact miss makes send silently unavailable (see
  // `grantedScopesInclude`).
  const sendCapable = grantedScopesInclude(
    opts.config().granted_scopes ?? [],
    GMAIL_SEND_SCOPE,
  );
  const accountEmail = opts.config().account_email ?? '';

  return {
    kind: 'gmail',
    slug: opts.slug,
    sendCapable,
    accountEmail,

    async connect() {
      try {
        await ensureToken(false);
      } catch (err) {
        if (err instanceof OAuthError) markError('gmail connect token refresh failed', err);
        throw err;
      }
    },

    async initialScan(scanOpts) {
      await outcomes.run('initial_scan', () => runInitialScan(scanOpts));
    },

    async startSync(cb) {
      const scheduler = opts.scheduler ?? defaultScheduler;
      const intervalMs = Math.max(1, opts.config().poll_seconds) * 1000;
      // Every tick is wrapped, not just the first — the scheduled ones are
      // precisely the attempts whose failures used to vanish into `markError`.
      const tick = (): Promise<void> => outcomes.run('poll', () => runHistoryTick(cb));
      // Run an immediate tick so testers don't need to wait for the
      // first interval.
      await tick();
      pollStop = scheduler(tick, intervalMs);
      return async () => {
        const stop = pollStop;
        pollStop = null;
        await stop?.();
      };
    },

    async close() {
      stopped = true;
      const stop = pollStop;
      pollStop = null;
      await stop?.();
    },

    health(): ProviderHealth {
      return {
        last_successful_sync_at: lastSuccessfulSyncAt,
        error_count_24h: errorCount24h,
        pending_queue_size: pendingQueueSize,
      };
    },

    onSyncOutcome(listener: MailSyncOutcomeListener) {
      return outcomes.subscribe(listener);
    },

    lookupSentByReconciliationId,

    ...(sendCapable ? { send: sendImpl } : {}),
  };
};

// ────────────────────────────────────────────────────────────────
// Shipped OAuth client config
// ────────────────────────────────────────────────────────────────

/** Gmail's token endpoint — a PROTOCOL constant, not a credential.
 *
 *  This used to be `GMAIL_OAUTH_CONFIG`, an `OAuthProviderConfig` whose
 *  `clientId` / `clientSecret` were read from `RECUED_GMAIL_CLIENT_ID` /
 *  `_SECRET`. Those two env vars were DELETED (2026-07-28) — a plaintext
 *  process-env copy of the secret that also bypassed the vault lock. The
 *  client id + secret now come ONLY from the encrypted `OAuthAppConfigStore`
 *  (issuer `google`, entered in Settings → Accounts); the token URL is all the
 *  binary still ships, because the stored-credential exchange needs somewhere
 *  to POST. */
export const GMAIL_TOKEN_URL = GOOGLE_TOKEN_URL;
