/** Phase D (D-106) — Microsoft Graph REST provider (Commit 15).
 *
 *  Implements `MailProvider` against the Graph REST API directly —
 *  rejects the `@microsoft/microsoft-graph-client` SDK per spec for
 *  the same dep-bloat reason Gmail skips `googleapis`.
 *
 *  Endpoints used:
 *    POST https://login.microsoftonline.com/common/oauth2/v2.0/token
 *    GET  /me/messages?$filter=receivedDateTime ge <since>&$top=50
 *         (initial scan; paginated via `@odata.nextLink`)
 *    GET  /me/mailFolders/{folder}/messages/delta
 *         (delta queries; each tick follows `@odata.nextLink` until
 *          `@odata.deltaLink` appears, then saves it as the next-tick
 *          watermark.)
 *    POST /me/messages                           — create draft (D-127 P1.4)
 *    POST /me/messages/{id}/send                  — send draft (D-127 P1.4)
 *
 *  Canonicalization is done against Graph's JSON shape directly —
 *  unlike IMAP/Gmail there's no convenient RFC-822 to reuse
 *  `mailparser` on. Body is provided as either `text` or `html`;
 *  we keep the text form verbatim for FTS and strip HTML when only
 *  HTML exists (same cheap fallback as IMAP/Gmail).
 *
 *  OAuth uses the same shared `oauth.ts` helper (only `token_url`
 *  and client credentials differ); refresh tokens live under
 *  `account.graph.{slug}.*`.
 *
 *  D-127 P1.4 — outbound send. Provider opts in by setting
 *  `config.granted_scopes` to the list returned at OAuth completion;
 *  `sendCapable` flips true iff the list contains `Mail.Send`.
 *  `send` uses Graph's drafts → send chain (`POST /me/messages`
 *  followed by `POST /me/messages/{id}/send`) so the canonical
 *  `internetMessageId` and `conversationId` come back synchronously
 *  for follow-up threading; the alternative `me/sendMail` endpoint
 *  returns 202 with no id and is rejected by spec § P1.4. Status
 *  mapping mirrors gmail: 401 / 403 → MAIL_SEND_AUTH_FAILED,
 *  4xx other → MAIL_SEND_RECIPIENT_INVALID, 5xx →
 *  MAIL_SEND_NETWORK_FAILED; Graph's 400 for a header it will not take,
 *  and its 413 for a request over 4 MB, → MAIL_SEND_MESSAGE_REFUSED.
 *  Attachments go one per request (`createGraphDraft`). Sent records
 *  appear under Sent Items on the next inbound delta.
 *
 *  A REPLY's draft is Outlook's own: `POST /me/messages/{id}/createReply`
 *  on the email it answers, found in this mailbox by its Message-ID, so
 *  Exchange writes In-Reply-To / References. Graph refuses those two on a
 *  message it creates (only `x-` headers; live, 2026-10-15). A reply whose
 *  email is not in this mailbox goes as a new message, unthreaded.
 */

import {
  isMailReconciliationId,
  MAIL_RECONCILIATION_ID_HEADER,
  MailAdapterError,
  MICROSOFT_TOKEN_URL,
  MAIL_SENT_BY_MESSAGE_ID_MAX_MATCHES,
  MAIL_SENT_REPLIES_MAX_MATCHES,
  type MailSentByMessageIdMatch,
  type MailSentByMessageIdQuery,
  type MailSentByMessageIdResult,
  type MailSentRepliesQuery,
  type MailSentRepliesResult,
  type MailSentReplyMatch,
} from '@recued/contracts';
import { IngredientError } from '@recued/ingredients';
import { looksLikeIcs } from '@recued/transforms';
import { simpleParser } from 'mailparser';
import {
  assertProviderPageUrl,
  ProviderPaginationGuard,
  readProviderStringContinuation,
} from '../../provider-pagination-guard.js';
import {
  classifyMailApiStatus,
  classifyOAuthFailure,
  createMailSyncOutcomeReporter,
  assertMailSentReconciliationQuery,
  evaluateMailSentReconciliationCandidates,
  MAIL_AUTOMATIC_REPLY_HEADERS,
  MAIL_SENT_RECONCILIATION_MAX_SCAN,
  mailAttachmentPartFromBytes,
  mailHeaderMap,
  mailSentReconciliationAttachmentPartFromBytes,
  normalizeMailAttachmentMimeType,
  sanitizeMailAttachmentFilename,
  type CanonicalMessage,
  type InitialScanOptions,
  type InboundMailAttachmentPart,
  type MailMessageDirection,
  type MailMoveDestination,
  type MailMutationResult,
  type MailProvider,
  type MailSyncFailureKind,
  type MailSyncOutcomeListener,
  type MailSentAttachmentReconciliationQuery,
  type MailSentReconciliationCandidate,
  type MailSentReconciliationQuery,
  type MailSentReconciliationResult,
  type OutgoingMessage,
  type ProviderHealth,
  type ProviderSyncCallback,
  type SavedDraftMeta,
  type SentMessageMeta,
  normalizeRfcMessageId,
  mailContentId,
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
import { oauthAuthorizationHeaders } from './oauth.js';
import {
  startDrainingInterval,
  type ProviderPollScheduler,
  type ProviderPollStop,
} from '../draining-interval.js';
import { CollectionStoppedError, throwIfStopped } from '../stop-signal.js';

// ────────────────────────────────────────────────────────────────
// Graph-specific config + constants
// ────────────────────────────────────────────────────────────────

export interface GraphProviderConfig {
  account_slug: string;
  backfill_days: number;
  poll_seconds: number;
  /** Folder IDs to sync. Empty = `["inbox"]` (the well-known ID).
   *  Each folder tracks its own delta link. */
  folder_filter?: string[];
  /** D-127 P1.4 — OAuth scopes the user actually granted at consent.
   *  Drives `sendCapable`: outbound is enabled only when this list
   *  contains the Graph send scope, regardless of what was requested.
   *  P4.2 wires the scope persistence end-to-end; until then callers
   *  leave this undefined and the provider stays read-only. */
  granted_scopes?: string[];
  /** D-127 P1.6 — canonical account email surfaced via
   *  `MailProvider.accountEmail`. Captured at OAuth completion from
   *  the graph `me` resource (`userPrincipalName`). P4.2 wires the
   *  populate path; until then the provider exposes empty string
   *  and the rpc-layer self-loop guard is a no-op. */
  account_email?: string;
}

export interface CreateGraphProviderOptions {
  slug: string;
  config: () => GraphProviderConfig;
  accountStore: OAuthAccountStore;
  providerConfig: OAuthProviderConfigSource;
  fetcher?: HttpFetcher;
  /** D-322: broker-owned OAuth; no local access token or 401 replay. */
  managedFetcher?: HttpFetcher;
  /** Owner's feature choices for managed accounts; vendor permissions still govern each call. */
  managedSendEnabled?: boolean;
  managedMutationEnabled?: boolean;
  nativeSendEnabled?: boolean;
  nativeMutationEnabled?: boolean;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  scheduler?: ProviderPollScheduler;
}

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
/** D-318 — MAPI's `PidTagInReplyToId`, as Graph names an extended property.
 *  ⛔ A Sent Items message's `internetMessageHeaders` holds only the `x-`
 *  headers set when it was made, never `In-Reply-To`: measured on Outlook.com
 *  (2026-10-15), an answer made with `createReply` listed
 *  `x-recued-reconciliation-id` and `X-Auto-Response-Suppress` alone, and this
 *  property held its In-Reply-To. */
export const GRAPH_IN_REPLY_TO_PROPERTY = 'String 0x1042';

/** A Sent item as `lookupSentReplies` reads it: with Exchange's In-Reply-To. */
type GraphSentReplyPayload = GraphMessagePayload & {
  singleValueExtendedProperties?: Array<{ id?: string; value?: string }>;
};
/** Graph returns internetMessageHeaders only when explicitly selected. Keep
 * every field consumed by canonicalizeGraph in this one projection so adding
 * the reconciliation header does not silently drop the legacy message body or
 * envelope fields. */
export const GRAPH_MESSAGE_SELECT = [
  'subject',
  'internetMessageId',
  'internetMessageHeaders',
  'from',
  'toRecipients',
  'ccRecipients',
  'conversationId',
  'parentFolderId',
  'isRead',
  // D-239 — `flag` must be in the projection or `canonicalizeGraph` reads
  // `undefined` and every synced message reports itself unflagged, silently
  // reverting whatever `mail-flag` just wrote. A `$select` that omits a field
  // the canonicalizer reads is indistinguishable from a message that genuinely
  // lacks it: Graph returns 200 either way.
  'flag',
  'hasAttachments',
  'receivedDateTime',
  'body',
].join(',');

/** D-127 P1.4 — Graph permission string that toggles outbound send.
 *  `sendCapable` flips true iff the user's granted-scope list contains
 *  this exact value. Documented at
 *  https://learn.microsoft.com/en-us/graph/permissions-reference#mail-permissions. */
export const GRAPH_SEND_SCOPE = 'Mail.Send';

/** D-239 — Graph permission that toggles message-state MUTATION.
 *  `Mail.ReadWrite` covers PATCH `isRead` / `flag`, `POST /move`, and
 *  `DELETE`; `Mail.Read` alone permits none of them. Separate from
 *  `Mail.Send` — Microsoft grants the two independently. */
export const GRAPH_MODIFY_SCOPE = 'Mail.ReadWrite';

// ────────────────────────────────────────────────────────────────
// Graph message shape + canonicalizer
// ────────────────────────────────────────────────────────────────

interface GraphEmailAddress { emailAddress?: { address?: string; name?: string } }
interface GraphRecipient { emailAddress?: { address?: string; name?: string } }

export interface GraphMessagePayload {
  id: string;
  /** Present on `@removed` entries only — absent on regular entries. */
  '@removed'?: { reason: string };
  /** The message's own type when it is a kind of message — an annotation
   *  Graph returns whatever `$select` asks for. A meeting email is
   *  `#microsoft.graph.eventMessage`, or its `…Request` / `…Response`. */
  '@odata.type'?: string;
  subject?: string;
  /** RFC 5322 Message-ID. Included in the provider's explicit projection. */
  internetMessageId?: string;
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
  from?: GraphEmailAddress;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  conversationId?: string;
  parentFolderId?: string;
  isRead?: boolean;
  /** D-239 — Graph models the flag as a nested resource with a three-state
   *  status (`notFlagged` / `flagged` / `complete`), not a boolean. Only
   *  `flagged` is "flagged" for our purposes: `complete` is a follow-up the
   *  user has already finished, which reads as done, not as pending. */
  flag?: { flagStatus?: 'notFlagged' | 'flagged' | 'complete' };
  hasAttachments?: boolean;
  receivedDateTime?: string;
  sentDateTime?: string;
  body?: { contentType?: 'text' | 'html'; content?: string };
}

interface GraphAttachmentPayload {
  id?: string;
  '@odata.type'?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
  /** D-318 step 4 — what the HTML body names as `cid:…`. */
  contentId?: string;
}

const addressList = (recipients: GraphRecipient[] | undefined): string[] => {
  if (!recipients) return [];
  const out: string[] = [];
  for (const r of recipients) {
    const addr = r.emailAddress?.address;
    if (addr) out.push(addr);
  }
  return out;
};

/** A tag ends before the next `<`: `[^>]` retried from every `<` of a broken
 *  email to its end: 500 KB of them took nine seconds. */
const stripHtml = (html: string): string =>
  html.replace(/<[^<>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const extractBodyText = (body: GraphMessagePayload['body']): { text: string; html?: string } => {
  if (!body || !body.content) return { text: '' };
  if (body.contentType === 'html') {
    return { text: stripHtml(body.content), html: body.content };
  }
  return { text: body.content };
};

/** Microsoft Graph returns an opaque `parentFolderId` on messages, but the
 * collection loop still knows the well-known folder selector it queried. Keep
 * that transport evidence separate from localized display names. */
export const graphMessageDirectionForFolder = (folder: string): MailMessageDirection => {
  switch (folder.trim().toLowerCase()) {
    case 'inbox': return 'inbound';
    case 'sentitems':
    case 'outbox': return 'outbound';
    case 'drafts': return 'draft';
    default: return 'unknown';
  }
};

export const canonicalizeGraph = (
  msg: GraphMessagePayload,
  attachments: InboundMailAttachmentPart[] = [],
  direction: MailMessageDirection = graphMessageDirectionForFolder(msg.parentFolderId ?? ''),
): CanonicalMessage => {
  const from = msg.from?.emailAddress?.address ?? '';
  const to = addressList(msg.toRecipients);
  const cc = addressList(msg.ccRecipients);
  const received = msg.receivedDateTime ? Date.parse(msg.receivedDateTime) : Date.now();
  const body = extractBodyText(msg.body);
  const reconciliationHeaders = (msg.internetMessageHeaders ?? []).filter(
    (header) => header.name?.toLowerCase()
      === MAIL_RECONCILIATION_ID_HEADER.toLowerCase(),
  );
  const reconciliationId = reconciliationHeaders.length === 1
    ? reconciliationHeaders[0]?.value
    : undefined;
  return {
    source_id: msg.id,
    rfc_message_id: msg.internetMessageId ?? undefined,
    ...(isMailReconciliationId(reconciliationId)
      ? { reconciliation_id: reconciliationId }
      : {}),
    from,
    from_name: msg.from?.emailAddress?.name?.trim() ?? '',
    headers: mailHeaderMap(
      (msg.internetMessageHeaders ?? []).flatMap((header): [string, string][] =>
        typeof header.name === 'string' && typeof header.value === 'string'
          ? [[header.name, header.value]]
          : []),
    ),
    to,
    cc,
    subject: msg.subject ?? '',
    thread_id: msg.conversationId ?? '',
    folder_or_label: msg.parentFolderId ?? '',
    direction,
    is_read: msg.isRead ?? false,
    is_flagged: msg.flag?.flagStatus === 'flagged',
    has_attachments: (msg.hasAttachments ?? false) || attachments.length > 0,
    received_at: Number.isFinite(received) ? received : Date.now(),
    // D-318 step 1 — Graph's received time is the provider's own already.
    ...(Number.isFinite(received) ? { provider_received_at: received } : {}),
    body_text: body.text,
    body_html: body.html,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
};

// ────────────────────────────────────────────────────────────────
// D-127 P1.4 — outbound send: Graph Message JSON shape + builder
// ────────────────────────────────────────────────────────────────

/** D-172 P2 — a single Graph `fileAttachment` resource (the inline-
 *  bytes attachment kind). `contentBytes` is base64; Graph's inline
 *  fileAttachment path caps around 3 MB before an upload session is
 *  needed (the over-size guard at `MailCollection.send` keeps us under
 *  that — larger files are dropped + warned at Half A). */
export interface GraphFileAttachment {
  '@odata.type': '#microsoft.graph.fileAttachment';
  name: string;
  contentType: string;
  contentBytes: string;
}

/** Subset of the Graph `Message` resource we POST when creating a
 *  draft. Graph echoes back an enriched version that carries
 *  `id`, `internetMessageId`, and `conversationId`. */
export interface GraphSendMessage {
  subject: string;
  body: { contentType: 'Text' | 'HTML'; content: string };
  toRecipients: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  /** Custom headers only. ⛔ Graph refuses any other on a message it creates:
   *  `400 InvalidInternetMessageHeader`, "The internet message header name
   *  'In-Reply-To' should start with 'x-' or 'X-'." (live, 2026-10-15). A
   *  reply's In-Reply-To / References come from `createReply` instead. */
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  /** D-172 P2 — inline file attachments. Omitted when none. */
  attachments?: GraphFileAttachment[];
}

/** Echo-back shape from `POST /me/messages` (the create-draft step).
 *  Graph populates `id` + `internetMessageId` + `conversationId`
 *  before we issue the second send POST so recipes can thread off
 *  `internetMessageId` as soon as send completes. */
export interface GraphCreatedDraft {
  id?: string;
  internetMessageId?: string;
  conversationId?: string;
}

/** How a draft step's failure is told: the send's taxonomy, or D-264's for a
 *  draft that is only saved — a refusal by its status, and the code for one
 *  that proves nothing about the message. */
interface GraphDraftFailure {
  refused: (status: number, text: string) => never;
  failed: 'MAIL_SEND_NETWORK_FAILED' | 'MAIL_DRAFT_NETWORK_FAILED';
}

const buildGraphRecipients = (addresses: string[]): GraphRecipient[] =>
  addresses.map((address) => ({ emailAddress: { address } }));

/** Compose Graph's `Message` resource from `OutgoingMessage`. HTML
 *  body wins when both `body_html` and `body_text` are supplied —
 *  Graph's body field is a single structure (not multipart), so the
 *  HTML alternative is what recipients see; clients auto-derive a
 *  text fallback. */
export const buildGraphMessage = (msg: OutgoingMessage): GraphSendMessage => {
  const body = msg.body_html
    ? { contentType: 'HTML' as const, content: msg.body_html }
    : { contentType: 'Text' as const, content: msg.body_text };

  const m: GraphSendMessage = {
    subject: msg.subject,
    body,
    toRecipients: buildGraphRecipients(msg.to),
  };
  if (msg.cc && msg.cc.length > 0) m.ccRecipients = buildGraphRecipients(msg.cc);
  if (msg.bcc && msg.bcc.length > 0) m.bccRecipients = buildGraphRecipients(msg.bcc);
  if (msg.reply_to) m.replyTo = [{ emailAddress: { address: msg.reply_to } }];

  // `x-` headers alone: Graph refuses In-Reply-To / References here (a reply's
  // come from `createReply`, `createGraphDraft`).
  const headers: Array<{ name: string; value: string }> = [];
  if (msg.reconciliation_id) {
    headers.push({
      name: MAIL_RECONCILIATION_ID_HEADER,
      value: msg.reconciliation_id,
    });
  }
  // D-318 step 5 — for the same reason, of the automatic-reply marks only
  // Exchange's own goes.
  if (msg.automatic === true) {
    for (const [name, value] of MAIL_AUTOMATIC_REPLY_HEADERS) {
      if (/^x-/i.test(name)) headers.push({ name, value });
    }
  }
  if (headers.length > 0) m.internetMessageHeaders = headers;

  // D-172 P2 — render each resolved attachment as an inline Graph
  // fileAttachment (`contentBytes` is the base64 payload verbatim).
  if (msg.attachments && msg.attachments.length > 0) {
    m.attachments = msg.attachments.map((att) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.filename,
      contentType: att.mime_type,
      contentBytes: att.bytes_b64,
    }));
  }

  return m;
};

// ────────────────────────────────────────────────────────────────
// HTTP helper — same shape as Gmail's, kept in-module so providers
// stay independent of each other.
// ────────────────────────────────────────────────────────────────

interface GraphListResponse<T> {
  value?: T[];
  '@odata.nextLink'?: unknown;
  '@odata.deltaLink'?: unknown;
}

/** `signal`: a sync's stop (`stop-signal.ts`); absent on an rpc read. */
const graphGet = async <T>(
  url: string,
  opts: { accessToken: string | undefined; fetcher: HttpFetcher; signal?: AbortSignal },
): Promise<{ ok: true; data: T } | { ok: false; status: number; text: string }> => {
  const safeUrl = assertProviderPageUrl(url, GRAPH_API_BASE, 'graph mail');
  const res = await opts.fetcher(safeUrl, {
    method: 'GET',
    headers: { ...oauthAuthorizationHeaders(opts.accessToken) },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, text };
  }
  const data = (await res.json()) as T;
  return { ok: true, data };
};

/** Graph's own code for a refusal (`{"error":{"code":…}}`), when its body has one. */
const graphErrorCode = (text: string): string | undefined => {
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
};

/** A GET whose answer is a message's raw MIME (`$value`), not JSON. Read as
 *  text, which is all `HttpFetcher` offers: MIME is 7-bit or UTF-8 on the wire
 *  in practice, and the one part read from it, an invite, is UTF-8 by RFC 5545. */
const graphGetBytes = async (
  url: string,
  opts: { accessToken: string | undefined; fetcher: HttpFetcher },
): Promise<{ ok: true; data: Buffer } | { ok: false; status: number; text: string }> => {
  const safeUrl = assertProviderPageUrl(url, GRAPH_API_BASE, 'graph mail');
  const res = await opts.fetcher(safeUrl, {
    method: 'GET',
    headers: { ...oauthAuthorizationHeaders(opts.accessToken) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, text };
  }
  return { ok: true, data: Buffer.from(await res.text(), 'utf8') };
};

/** D-315 slice 7 — a meeting email. Exchange turns an emailed invite, a guest's
 *  answer or a cancellation into a meeting item, and Graph lists no `.ics`
 *  among its attachments; the message's raw MIME still carries it. */
export const isGraphMeetingMessage = (msg: GraphMessagePayload): boolean =>
  typeof msg['@odata.type'] === 'string'
  && msg['@odata.type'].toLowerCase().startsWith('#microsoft.graph.eventmessage');

/** The invite inside a raw MIME message: the first part that is a calendar,
 *  by its bytes, whatever its type says. */
export const inviteFromMime = async (mime: Buffer): Promise<Buffer | null> => {
  const parsed = await simpleParser(mime);
  for (const attachment of parsed.attachments) {
    const content = Buffer.from(attachment.content);
    if (looksLikeIcs(content)) return content;
  }
  return null;
};

// ────────────────────────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────────────────────────

export const createGraphProvider = (
  opts: CreateGraphProviderOptions,
): MailProvider => {
  const fetcher = opts.managedFetcher ?? opts.fetcher ?? defaultHttpFetcher;
  const nowOf = (): number => opts.now?.() ?? Date.now();

  /** Aborted by `close()`, armed again by `connect()`: the first scan and the
   *  poll `startSync` runs at once go by it, and each scheduled poll by its
   *  loop's own signal. A scan or poll captures the signal when it begins, so
   *  one begun before a close stays stopped across the next connect. */
  let lifecycle = new AbortController();
  let pollStop: ProviderPollStop | null = null;
  let lastSuccessfulSyncAt = 0;
  let errorCount24h = 0;
  let pendingQueueSize = 0;
  let accessToken = '';

  const slug = (): string => opts.config().account_slug;
  const folders = (): string[] => {
    const f = opts.config().folder_filter ?? [];
    return f.length === 0 ? ['inbox'] : f;
  };

  const deltaLinkKey = (folder: string): string =>
    `${keyPrefix('graph', slug())}.delta_link.headers_v1.${folder}`;

  const markError = (msg: string, err: unknown): void => {
    errorCount24h++;
    opts.log?.('warn', msg, { err: err instanceof Error ? err.message : String(err) });
  };

  // Per-attempt outcome reporting — see `MailSyncOutcome` in provider.ts.
  const outcomes = createMailSyncOutcomeReporter({
    now: nowOf,
    classifyError: (err): MailSyncFailureKind =>
      err instanceof OAuthError
        ? classifyOAuthFailure(err.status, err.oauth_error)
        : 'transient',
  });

  /** Record a swallowed read failure so the enclosing attempt reports it —
   *  `getWithRetry` returns `null` and callers early-return, which is
   *  indistinguishable from a clean empty tick without this. */
  const noteReadFailure = (status: number, msg: string, body: unknown): void => {
    // The BODY is threaded in, not just the status: a 403 is quota far more often
    // than it is a scope problem, and only the body's `reason` tells them apart.
    outcomes.noteFailure(
      classifyMailApiStatus(status, typeof body === 'string' ? body : undefined),
    );
    markError(msg, body);
  };

  const ensureToken = async (force: boolean): Promise<string | undefined> => {
    if (opts.managedFetcher) return undefined;
    if (accessToken && !force) return accessToken;
    accessToken = await getAccessToken({
      provider: 'graph',
      slug: slug(),
      providerConfig: requireProviderConfig(opts.providerConfig),
      accountStore: opts.accountStore,
      fetcher,
      now: opts.now,
      force,
    });
    return accessToken;
  };

  const getWithRetry = async <T>(
    url: string,
    {
      treat404AsAbsent = true,
      onFailureStatus,
      signal,
    }: {
      treat404AsAbsent?: boolean;
      onFailureStatus?: (status: number) => void;
      /** A sync's stop: aborts the request, and no new one (nor a token
       *  refresh) starts once it has fired. */
      signal?: AbortSignal;
    } = {},
  ): Promise<T | null> => {
    throwIfStopped(signal);
    const first = await graphGet<T>(url, { accessToken: await ensureToken(false), fetcher, signal });
    if (first.ok) return first.data;
    if (first.status === 401 && !opts.managedFetcher) {
      throwIfStopped(signal);
      const second = await graphGet<T>(url, {
        accessToken: await ensureToken(true),
        fetcher,
        signal,
      });
      if (second.ok) return second.data;
      if (second.status === 404 && treat404AsAbsent) return null;
      onFailureStatus?.(second.status);
      noteReadFailure(second.status, `graph ${url} → ${second.status}`, second.text);
      return null;
    }
    if (first.status === 404 && treat404AsAbsent) return null;
    onFailureStatus?.(first.status);
    noteReadFailure(first.status, `graph ${url} → ${first.status}`, first.text);
    return null;
  };

  /** `getWithRetry` for bytes. Throws on failure: its one caller is an
   *  attachment's fetch, whose failure ingest logs per part. */
  const getBytesWithRetry = async (url: string): Promise<Buffer> => {
    const first = await graphGetBytes(url, { accessToken: await ensureToken(false), fetcher });
    if (first.ok) return first.data;
    const second = first.status === 401 && !opts.managedFetcher
      ? await graphGetBytes(url, { accessToken: await ensureToken(true), fetcher })
      : first;
    if (second.ok) return second.data;
    noteReadFailure(second.status, `graph ${url} → ${second.status}`, second.text);
    throw new Error(`graph ${url} → ${second.status}`);
  };

  /** D-315 slice 7 — a meeting email's invite, read from its raw MIME only
   *  when ingest stores it: one more call per meeting email, none for the
   *  rest. A meeting item whose MIME carries no calendar fails as a part
   *  that could not be fetched — logged, and the email's other parts kept. */
  const meetingInvitePart = (messageId: string): InboundMailAttachmentPart => ({
    filename: 'invite.ics',
    mime_type: 'text/calendar',
    size: 0,
    source_part_id: 'meeting-invite',
    disposition: 'attachment',
    async fetchBytes() {
      const mime = await getBytesWithRetry(`${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}/$value`);
      const invite = await inviteFromMime(mime);
      if (invite === null) throw new Error(`graph meeting message ${messageId} carries no invite`);
      return invite;
    },
  });

  /** Source-truth reconciliation must distinguish provider failure from a
   * complete empty result, unlike best-effort background sync. */
  const getReconciliationSource = async <T>(url: string): Promise<T> => {
    const first = await graphGet<T>(url, { accessToken: await ensureToken(false), fetcher });
    if (first.ok) return first.data;
    if (first.status === 401 && !opts.managedFetcher) {
      const second = await graphGet<T>(url, {
        accessToken: await ensureToken(true),
        fetcher,
      });
      if (second.ok) return second.data;
      throw new Error(`graph reconciliation source read failed (${second.status})`);
    }
    throw new Error(`graph reconciliation source read failed (${first.status})`);
  };

  const decodeGraphContentBytes = (contentBytes: string): Buffer =>
    Buffer.from(contentBytes, 'base64');

  const fetchGraphAttachmentDetail = async (
    messageId: string,
    attachmentId: string,
  ): Promise<GraphAttachmentPayload | null> =>
    getWithRetry<GraphAttachmentPayload>(
      `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );

  /** ⚠ A part's `fetchBytes` is not tied to the sync's stop, unlike the reads
   *  that list a message's parts: its bytes are fetched lazily, by whoever
   *  holds the message, and may be after the sync that read it has ended. The
   *  collection checks its own generation before each part, so a stop leaves
   *  at most the one download in flight. */
  const graphAttachmentPart = (
    messageId: string,
    attachment: GraphAttachmentPayload,
    index: number,
  ): InboundMailAttachmentPart | null => {
    const sourcePartId = attachment.id ?? `part-${index}`;
    const filename = sanitizeMailAttachmentFilename(
      attachment.name ?? '',
      `attachment-${index + 1}`,
    );
    if (typeof attachment.contentBytes === 'string') {
      return mailAttachmentPartFromBytes({
        filename,
        mime_type: attachment.contentType,
        source_part_id: sourcePartId,
        disposition: attachment.isInline === true ? 'inline' : 'attachment',
        content_id: attachment.contentId,
        bytes: decodeGraphContentBytes(attachment.contentBytes),
      });
    }
    if (!attachment.id) return null;
    const contentId = mailContentId(attachment.contentId);
    return {
      filename,
      mime_type: normalizeMailAttachmentMimeType(attachment.contentType),
      size: typeof attachment.size === 'number' && Number.isFinite(attachment.size)
        ? attachment.size
        : 0,
      source_part_id: sourcePartId,
      disposition: attachment.isInline === true ? 'inline' : 'attachment',
      ...(contentId !== undefined ? { content_id: contentId } : {}),
      async fetchBytes() {
        const detail = await fetchGraphAttachmentDetail(messageId, attachment.id!);
        if (typeof detail?.contentBytes !== 'string') {
          throw new Error(`graph attachment ${attachment.id} on ${messageId} missing contentBytes`);
        }
        return decodeGraphContentBytes(detail.contentBytes);
      },
    };
  };

  /** D-315 §4.4, §7.4 — the direction of a message read again on its own.
   *  Graph names a message's folder by an opaque id; live sync knows the
   *  folder it reads, and a message read alone says nothing else. So the
   *  well-known folders' ids are asked for once and kept, and a message in one
   *  of them has that folder's direction, as live sync gives it: the Sent copy
   *  a backfill reads again stays sent, and is left out as it was at ingest.
   *  A lookup that failed is asked again next time. */
  let wellKnownFolders: Map<string, MailMessageDirection> | null = null;
  const directionOfFolder = async (folderId: string): Promise<MailMessageDirection> => {
    if (folderId.length === 0) return 'unknown';
    if (wellKnownFolders === null) {
      const found = new Map<string, MailMessageDirection>();
      let complete = true;
      for (const name of ['inbox', 'sentitems', 'outbox', 'drafts'] as const) {
        const folder = await getWithRetry<{ id?: string }>(`${GRAPH_API_BASE}/me/mailFolders/${name}?$select=id`);
        if (folder !== null && typeof folder.id === 'string') found.set(folder.id, graphMessageDirectionForFolder(name));
        else complete = false;
      }
      if (!complete) return found.get(folderId) ?? 'unknown';
      wellKnownFolders = found;
    }
    return wellKnownFolders.get(folderId) ?? 'unknown';
  };

  /** D-315 §4.4 — one message read again, whole, its attachments listed.
   *  Graph gives a moved message a new id, so a 404 is `null`; any other
   *  failure throws. Its direction comes from its folder (above). */
  const fetchMessage = async (id: string): Promise<CanonicalMessage | null> => {
    let failureStatus: number | undefined;
    const msg = await getWithRetry<GraphMessagePayload>(
      `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(id)}`
        + `?$select=${encodeURIComponent(GRAPH_MESSAGE_SELECT)}`,
      { onFailureStatus: (status) => { failureStatus = status; } },
    );
    if (msg === null) {
      if (failureStatus !== undefined) throw new Error(`graph message ${id} read failed (${failureStatus})`);
      return null;
    }
    return canonicalizeGraph(msg, await fetchGraphAttachmentParts(msg), await directionOfFolder(msg.parentFolderId ?? ''));
  };

  const fetchGraphAttachmentParts = async (
    msg: GraphMessagePayload,
    signal?: AbortSignal,
  ): Promise<InboundMailAttachmentPart[]> => {
    const parts = msg.hasAttachments ? await listGraphAttachmentParts(msg, signal) : [];
    const carriesInvite = parts.some((p) => p.mime_type === 'text/calendar' || /\.ics$/i.test(p.filename));
    if (isGraphMeetingMessage(msg) && !carriesInvite) parts.push(meetingInvitePart(msg.id));
    return parts;
  };

  const listGraphAttachmentParts = async (
    msg: GraphMessagePayload,
    signal?: AbortSignal,
  ): Promise<InboundMailAttachmentPart[]> => {
    const parts: InboundMailAttachmentPart[] = [];
    let url: string | undefined =
      `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(msg.id)}/attachments`;
    const pagination = new ProviderPaginationGuard('graph mail attachment', {
      trustedBaseUrl: GRAPH_API_BASE,
    });
    while (url) {
      const page: GraphListResponse<GraphAttachmentPayload> | null =
        await getWithRetry(pagination.claim(url), { signal });
      if (!page) {
        throw new Error(`graph attachments fetch failed id=${msg.id}`);
      }
      for (const attachment of page.value ?? []) {
        const part = graphAttachmentPart(msg.id, attachment, parts.length);
        if (part) parts.push(part);
        else {
          markError(`graph attachment unsupported id=${msg.id}`, {
            attachment_id: attachment.id,
            type: attachment['@odata.type'],
          });
        }
      }
      url = readProviderStringContinuation(
        page['@odata.nextLink'],
        'graph mail attachment',
      );
    }
    return parts;
  };

  // ── initial scan ────────────────────────────────────────────
  /** `signal` stops the scan between pages and messages by THROWING: a
   *  normal return tells the collection the backfill is complete. */
  const runInitialScan = async (scanOpts: InitialScanOptions, signal: AbortSignal): Promise<void> => {
    const since = new Date(nowOf() - scanOpts.backfill_days * 86400_000).toISOString();
    const failures: unknown[] = [];
    let aborted = false;
    for (const folder of folders()) {
      if (aborted) break;
      let url: string | undefined =
        `${GRAPH_API_BASE}/me/mailFolders/${folder}/messages`
        + `?$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`
        + '&$top=50'
        + `&$select=${encodeURIComponent(GRAPH_MESSAGE_SELECT)}`;
      const pagination = new ProviderPaginationGuard('graph mail initial scan', {
        trustedBaseUrl: GRAPH_API_BASE,
      });
      while (url && !aborted) {
        const page: GraphListResponse<GraphMessagePayload> | null =
          await getWithRetry(pagination.claim(url), { signal });
        if (!page) {
          throw new Error(`graph initial scan could not fetch folder '${folder}'`);
        }
        const messages = page.value ?? [];
        if (!Array.isArray(messages)) throw new Error('graph initial scan returned an invalid message list');
        scanOpts.onAccessVerified?.();
        for (const msg of messages) {
          if (msg['@removed']) continue;
          // Outside the per-message catch, which would count a stop as one
          // failed message and read on.
          throwIfStopped(signal);
          try {
            const canonical = canonicalizeGraph(
              msg,
              await fetchGraphAttachmentParts(msg, signal),
              graphMessageDirectionForFolder(folder),
            );
            const cont = await scanOpts.onMessage(canonical);
            lastSuccessfulSyncAt = nowOf();
            if (!cont) { aborted = true; break; }
          } catch (err) {
            if (signal.aborted) throw new CollectionStoppedError();
            markError(`graph canonicalize failed id=${msg.id}`, err);
            failures.push(err);
          }
        }
        url = readProviderStringContinuation(
          page['@odata.nextLink'],
          'graph mail initial scan',
        );
      }
    }
    if (!aborted && failures.length > 0) {
      throw new AggregateError(failures, 'graph initial scan was incomplete');
    }
  };

  // ── delta sync ──────────────────────────────────────────────
  const emitDeltaMessage = async (
    folder: string,
    msg: GraphMessagePayload,
    cb: ProviderSyncCallback,
    signal: AbortSignal,
  ): Promise<boolean> => {
    pendingQueueSize++;
    try {
      if (msg['@removed']) {
        await cb({ kind: 'deleted', source_id: msg.id });
      } else {
        const canonical = canonicalizeGraph(
          msg,
          await fetchGraphAttachmentParts(msg, signal),
          graphMessageDirectionForFolder(folder),
        );
        await cb({
          kind: 'updated',
          source_id: canonical.source_id,
          message: canonical,
        });
      }
      lastSuccessfulSyncAt = nowOf();
      return true;
    } catch (err) {
      // Not acknowledged, so the delta link stays; a stop is no failure.
      if (signal.aborted) return false;
      outcomes.noteFailure('transient');
      markError(`graph delta apply failed id=${msg.id}`, err);
      return false;
    } finally {
      pendingQueueSize = Math.max(0, pendingQueueSize - 1);
    }
  };

  /** ⛔ Walks the folder's WHOLE change feed, page after page: `signal` stops
   *  it between pages and messages by throwing, so a stopped walk stores no
   *  delta link and the next start walks again from the start. */
  const seedDeltaLink = async (
    folder: string,
    signal: AbortSignal,
    recoveryCallback?: ProviderSyncCallback,
    onAccessVerified?: () => void,
  ): Promise<string> => {
    // Graph returns a deltaLink even for an empty delta. Seeding is a
    // full current-state walk with no filters. The initial-scan path may
    // discard these values because its list walk follows immediately. Cursor
    // expiry passes a callback so the replacement baseline is replayed before
    // it is committed instead of silently skipping the gap.
    let url: string | undefined =
      `${GRAPH_API_BASE}/me/mailFolders/${folder}/messages/delta`
      + `?$select=${encodeURIComponent(GRAPH_MESSAGE_SELECT)}`;
    let terminalDeltaLink: string | undefined;
    let deliveryFailed = false;
    const pagination = new ProviderPaginationGuard('graph mail delta seed', {
      trustedBaseUrl: GRAPH_API_BASE,
    });
    while (url) {
      const page: GraphListResponse<GraphMessagePayload> | null =
        await getWithRetry(pagination.claim(url), { signal });
      if (!page) {
        throw new Error(`graph delta seed could not fetch folder '${folder}'`);
      }
      const messages = page.value ?? [];
      if (!Array.isArray(messages)) throw new Error('graph delta seed returned an invalid message list');
      onAccessVerified?.();
      if (recoveryCallback) {
        for (const msg of messages) {
          throwIfStopped(signal);
          if (!(await emitDeltaMessage(folder, msg, recoveryCallback, signal))) {
            deliveryFailed = true;
          }
        }
      }
      const rawDeltaLink = readProviderStringContinuation(
        page['@odata.deltaLink'],
        'graph mail delta watermark',
      );
      if (rawDeltaLink !== undefined) {
        const deltaLink = assertProviderPageUrl(
          rawDeltaLink,
          GRAPH_API_BASE,
          'graph mail delta watermark',
        );
        terminalDeltaLink = deltaLink;
      }
      url = readProviderStringContinuation(
        page['@odata.nextLink'],
        'graph mail delta seed',
      );
    }
    if (deliveryFailed) {
      throw new Error(`graph delta recovery was not acknowledged for folder '${folder}'`);
    }
    if (terminalDeltaLink === undefined) {
      throw new Error(`graph delta seed for folder '${folder}' returned no watermark`);
    }
    throwIfStopped(signal);
    await opts.accountStore.set(deltaLinkKey(folder), terminalDeltaLink);
    return terminalDeltaLink;
  };

  /** A stopped poll throws before it stores the folder's new delta link, so
   *  the next poll replays the range from the old one. */
  const runDeltaTick = async (
    folder: string,
    cb: ProviderSyncCallback,
    signal: AbortSignal,
  ): Promise<void> => {
    let link = await opts.accountStore.get(deltaLinkKey(folder));
    if (!link) {
      link = await seedDeltaLink(folder, signal);
      return; // First seed — no changes to emit yet.
    }
    let url: string | undefined = link;
    let cursorInvalid = false;
    let deliveryFailed = false;
    let terminalDeltaLink: string | undefined;
    const pagination = new ProviderPaginationGuard('graph mail delta', {
      trustedBaseUrl: GRAPH_API_BASE,
    });
    while (url) {
      const page: GraphListResponse<GraphMessagePayload> | null =
        await getWithRetry(pagination.claim(url), {
          // A not-found here is not an absent message: it is the stored delta
          // state URL being rejected. Keep it observable and recoverable.
          treat404AsAbsent: false,
          onFailureStatus: (status) => {
            if (status === 404 || status === 410) cursorInvalid = true;
          },
          signal,
        });
      if (!page) {
        if (cursorInvalid) {
          // Keep the rejected cursor until the replacement full-state walk has
          // been acknowledged. If recovery fails, the next scheduled tick hits
          // this path again instead of mistaking an absent cursor for a clean
          // first-run seed and discarding every returned value.
          markError(`graph delta cursor expired folder=${folder} — running recovery sync`, {
            status: 'invalid_delta_state',
          });
          try {
            // Found by this walk, not as it arrived (D-318 §4.8, P22).
            await seedDeltaLink(folder, signal, (event) => cb({ ...event, recovered: true }));
          } catch (err) {
            // A stop leaves the rejected cursor for the next poll to recover.
            if (signal.aborted) throw err;
            outcomes.noteFailure('transient');
            markError(`graph delta recovery failed folder=${folder}`, err);
          }
        }
        return;
      }
      for (const msg of page.value ?? []) {
        throwIfStopped(signal);
        if (!(await emitDeltaMessage(folder, msg, cb, signal))) deliveryFailed = true;
      }
      const rawDeltaLink = readProviderStringContinuation(
        page['@odata.deltaLink'],
        'graph mail delta watermark',
      );
      if (rawDeltaLink !== undefined) {
        const deltaLink = assertProviderPageUrl(
          rawDeltaLink,
          GRAPH_API_BASE,
          'graph mail delta watermark',
        );
        terminalDeltaLink = deltaLink;
      }
      url = readProviderStringContinuation(
        page['@odata.nextLink'],
        'graph mail delta',
      );
    }
    // Persist only after the whole drained range has been acknowledged. Holding
    // the prior deltaLink causes Graph to replay successful idempotent events
    // alongside the failed one on the next scheduled tick.
    if (!deliveryFailed && terminalDeltaLink !== undefined) {
      throwIfStopped(signal);
      await opts.accountStore.set(deltaLinkKey(folder), terminalDeltaLink);
    }
  };

  const defaultScheduler: ProviderPollScheduler = (cb, intervalMs) =>
    startDrainingInterval({
      tick: cb,
      intervalMs,
      onError: (err) => markError('graph poll tick failed', err),
    });

  // ── outbound send (D-127 P1.4) ──────────────────────────────
  //
  // Two-step drafts → send chain. Spec § P1.4 picks this over the
  // one-shot `me/sendMail` because the latter returns 202 with no
  // body — recipes that thread off the canonical Message-Id need it
  // back synchronously. Status mapping mirrors gmail (P1.3) and
  // P1.2's severity classification:
  //   401 / 403 → MAIL_SEND_AUTH_FAILED   (recoverable: re-enroll)
  //   400 InvalidInternetMessageHeader, 413 → MAIL_SEND_MESSAGE_REFUSED
  //   429        → MAIL_SEND_NETWORK_FAILED (throttled: nothing sent)
  //   4xx other → MAIL_SEND_RECIPIENT_INVALID
  //   5xx        → MAIL_SEND_NETWORK_FAILED
  const throwSendError = (status: number, text: string): never => {
    const detail = {
      kind: 'graph' as const,
      slug: opts.slug,
      status,
      // A 4xx is Graph REFUSING the request: nothing was sent, so the send
      // claim may start afresh. A 5xx proves nothing either way.
      ...(status >= 400 && status < 500 ? { not_sent: true } : {}),
    };
    if (status === 401 || status === 403) {
      markError(`graph send auth ${status}`, text);
      throw new IngredientError(
        'MAIL_SEND_AUTH_FAILED',
        `Graph rejected the send (${status}): ${text.slice(0, 200)}`,
        detail,
      );
    }
    // The message itself, not who it is to: sent again, it is refused again.
    // Reported as a recipient, the owner was told to check addresses that were
    // right, and each D-318 answer was to be retried for a day (live, 2026-10-15).
    // Too large: Graph's write cap (413, "Request entity too large"). The
    // message, not a recipient: sent again, it is refused again.
    if (status === 413 || (status === 400 && graphErrorCode(text) === 'InvalidInternetMessageHeader')) {
      throw new IngredientError(
        'MAIL_SEND_MESSAGE_REFUSED',
        `Graph refused the message (${status}): ${text.slice(0, 200)}`,
        detail,
      );
    }
    // Throttled, not refused: nothing went, and the same message goes later.
    // Read as a recipient, it told the owner to check addresses that were
    // right (the draft taxonomy already said so, D-264).
    if (status === 429) {
      markError(`graph send throttled ${status}`, text);
      throw new IngredientError(
        'MAIL_SEND_NETWORK_FAILED',
        `Graph throttled the send (${status}): ${text.slice(0, 200)}`,
        detail,
      );
    }
    if (status >= 400 && status < 500) {
      throw new IngredientError(
        'MAIL_SEND_RECIPIENT_INVALID',
        `Graph rejected a recipient (${status}): ${text.slice(0, 200)}`,
        detail,
      );
    }
    markError(`graph send transient ${status}`, text);
    throw new IngredientError(
      'MAIL_SEND_NETWORK_FAILED',
      `Graph send failed transiently (${status}): ${text.slice(0, 200)}`,
      detail,
    );
  };

  /** POST with a one-shot 401-retry that mirrors `getWithRetry`'s
   *  contract for read paths. The retry only fires once: if the
   *  refreshed token also gets 401 the user has revoked or
   *  downgraded scopes and we surface AUTH_FAILED upstream. */
  const postWithRetry = async (
    url: string,
    body?: string,
  ): ReturnType<HttpFetcher> => {
    const post = async (token: string | undefined) => fetcher(url, {
      method: 'POST',
      headers: {
        ...oauthAuthorizationHeaders(token),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    let res = await post(await ensureToken(false));
    if (res.status === 401 && !opts.managedFetcher) {
      res = await post(await ensureToken(true));
    }
    return res;
  };

  /** A reply's email in this mailbox, by its Message-ID: `createReply` acts on
   *  it. `null` when the mailbox does not hold it. A failed read throws, so a
   *  reply never goes unthreaded because the lookup failed. */
  const findReplyOriginal = async (
    inReplyTo: string,
    failure: GraphDraftFailure,
  ): Promise<string | null> => {
    const id = normalizeRfcMessageId(inReplyTo);
    if (id === undefined) return null;
    const filter = `internetMessageId eq '<${id.replace(/'/g, "''")}>'`;
    const url = `${GRAPH_API_BASE}/me/messages?$filter=${encodeURIComponent(filter)}`
      + '&$top=5&$select=id,internetMessageId';
    const read = async (refresh: boolean) =>
      graphGet<GraphListResponse<{ id?: string; internetMessageId?: string }>>(
        url, { accessToken: await ensureToken(refresh), fetcher });
    let res = await read(false);
    if (!res.ok && res.status === 401 && !opts.managedFetcher) res = await read(true);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return failure.refused(res.status, res.text);
      throw new IngredientError(
        failure.failed,
        `Graph could not look up the email this replies to (${res.status}): ${res.text.slice(0, 200)}`,
        { kind: 'graph', slug: opts.slug, status: res.status },
      );
    }
    const hit = (res.data.value ?? []).find((message) => typeof message.id === 'string'
      && message.id.length > 0 && normalizeRfcMessageId(message.internetMessageId) === id);
    return hit?.id ?? null;
  };

  /** The draft a message is sent from (`send`, which then posts `/send`) or
   *  saved as (D-264's `saveDraft`, which stops here). One body, so the two
   *  paths cannot drift in how a message becomes a Graph resource.
   *
   *  A reply to an email this mailbox holds is Outlook's own reply
   *  (`createReply`), which writes the In-Reply-To / References that Graph
   *  refuses as headers. Anything else is a new draft (`POST /me/messages`).
   *
   *  ⛔ The draft is made without its files, and each file is added on its own
   *  after, for a new message as for a reply: a draft left without them is
   *  deleted, and the failure told. Graph caps every write request at 4 MB,
   *  base64 included ("Use the Microsoft Graph API"), so files inline in one
   *  new message were one request: two 2 MB files came to over 4 MB, and Graph
   *  answers 413. Its documented way is one file per request, each under 3 MB
   *  ("Attach large files to Outlook messages": "attach the files
   *  individually"). A file over that needs an upload session, which this does
   *  not make: with `MAIL_SEND_ATTACHMENT_MAX_BYTES` at 3 MiB, only a file
   *  within about 150 KB of the cap can be refused (413, the message refused). */
  const createGraphDraft = async (
    msg: OutgoingMessage,
    failure: GraphDraftFailure,
  ): Promise<GraphCreatedDraft & { id: string }> => {
    const original = msg.in_reply_to ? await findReplyOriginal(msg.in_reply_to, failure) : null;
    const { attachments, ...withoutFiles } = buildGraphMessage(msg);
    const createRes = original === null
      ? await postWithRetry(`${GRAPH_API_BASE}/me/messages`, JSON.stringify(withoutFiles))
      : await postWithRetry(
        `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(original)}/createReply`,
        JSON.stringify({ message: withoutFiles }),
      );
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      failure.refused(createRes.status, text);
    }
    const draft = (await createRes.json()) as GraphCreatedDraft;
    if (!draft || typeof draft.id !== 'string' || draft.id.length === 0) {
      throw new IngredientError(
        failure.failed,
        `Graph ${original === null ? 'create-draft' : 'createReply'} returned a malformed response (missing id)`,
        { kind: 'graph', slug: opts.slug, status: createRes.status },
      );
    }
    const draftUrl = `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(draft.id)}`;
    for (const attachment of attachments ?? []) {
      const added = await postWithRetry(`${draftUrl}/attachments`, JSON.stringify(attachment));
      if (added.ok) continue;
      const text = await added.text().catch(() => '');
      await deleteWithRetry(draftUrl).catch(() => undefined);
      failure.refused(added.status, text);
    }
    return draft as GraphCreatedDraft & { id: string };
  };

  /** D-264 — park the message as a Graph draft and stop.
   *
   *  A `prior` is superseded with `PATCH /me/messages/{id}`, which keeps the
   *  SAME resource id. That matters beyond tidiness: the id the caller stored
   *  stays valid, so a third export supersedes the second rather than
   *  accumulating. A PATCH that fails falls back to creating a new draft and
   *  says so in `warnings` + `replaced: false` — the owner has two copies and
   *  is told, rather than losing the edit. */
  /** D-264 — the DRAFT taxonomy. Reusing `throwSendError` classified a 429 on a
   *  draft save as `MAIL_SEND_RECIPIENT_INVALID`, so a throttled save reached the
   *  owner as "check the addresses for typos" — about a message that was never
   *  sent and whose recipients were fine. */
  const throwDraftError = (status: number, text: string): never => {
    const detail = { kind: 'graph' as const, slug: opts.slug, status };
    if (status === 401 || status === 403) {
      markError(`graph draft auth ${status}`, text);
      throw new IngredientError('MAIL_DRAFT_AUTH_FAILED',
        `Graph rejected the draft save (${status}): ${text.slice(0, 200)}`, detail);
    }
    if (status >= 400 && status < 500 && status !== 429) {
      throw new IngredientError('MAIL_DRAFT_WRITE_FAILED',
        `Graph rejected the draft (${status}): ${text.slice(0, 200)}`, detail);
    }
    markError(`graph draft transient ${status}`, text);
    throw new IngredientError('MAIL_DRAFT_NETWORK_FAILED',
      `Graph draft save failed transiently (${status}): ${text.slice(0, 200)}`, detail);
  };

  const saveDraftImpl = async (
    msg: OutgoingMessage,
    prior?: { source_id: string },
  ): Promise<SavedDraftMeta> => {
    const savedAt = nowOf();
    /** The create step, with the DRAFT taxonomy rather than the send one. */
    const createDraftOnly = (): Promise<GraphCreatedDraft & { id: string }> =>
      createGraphDraft(msg, { refused: throwDraftError, failed: 'MAIL_DRAFT_NETWORK_FAILED' });
    if (prior) {
      // ⛔ PATCH IS A MERGE, SO ABSENT MEANS UNCHANGED, NOT CLEARED.
      // `buildGraphMessage` omits empty `cc` / `bcc` / `replyTo` — correct for a
      // CREATE, and a disclosure bug on an UPDATE: remove a Bcc recipient in
      // Recued, re-export, and Graph keeps the OLD Bcc while taking the new
      // body. Sending that mailbox copy would deliver edited content to someone
      // the owner had removed, with `replaced: true` reported. So the update
      // sends the empty arrays explicitly.
      const built = buildGraphMessage(msg);
      const patchBody = {
        ...built,
        ccRecipients: built.ccRecipients ?? [],
        bccRecipients: built.bccRecipients ?? [],
        replyTo: built.replyTo ?? [],
      };
      const patchRes = await patchWithRetry(
        `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(prior.source_id)}`,
        JSON.stringify(patchBody),
      );
      if (patchRes.ok) {
        lastSuccessfulSyncAt = nowOf();
        return { source_id: prior.source_id, saved_at: savedAt, replaced: true };
      }
      const text = await patchRes.text().catch(() => '');
      // 401/403 is a grant problem and will fail the create too — surface it
      // rather than burning a second call to produce the same error.
      if (patchRes.status === 401 || patchRes.status === 403) {
        throwDraftError(patchRes.status, text);
      }
      const draft = await createDraftOnly();
      lastSuccessfulSyncAt = nowOf();
      return {
        source_id: draft.id, saved_at: savedAt, replaced: false,
        warnings: [{ code: 'MAIL_DRAFT_PRIOR_NOT_REMOVED',
          message: `the earlier draft ${prior.source_id} could not be updated `
            + `(${patchRes.status}); a new draft was saved instead` }],
      };
    }
    const draft = await createDraftOnly();
    lastSuccessfulSyncAt = nowOf();
    return { source_id: draft.id, saved_at: savedAt, replaced: false };
  };

  const sendImpl = async (msg: OutgoingMessage): Promise<SentMessageMeta> => {
    const sentAt = nowOf();
    // Step 1 only makes a DRAFT. Whatever goes wrong here — a refusal, a 5xx, a
    // dropped connection — nothing has been sent, so the send claim may start
    // afresh (`not_sent`).
    let draft: GraphCreatedDraft & { id: string };
    try {
      draft = await createGraphDraft(msg, { refused: throwSendError, failed: 'MAIL_SEND_NETWORK_FAILED' });
    } catch (err) {
      if (err instanceof IngredientError) {
        err.details = { ...err.details, not_sent: true };
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new IngredientError(
        'MAIL_SEND_NETWORK_FAILED',
        `Graph send could not start: ${message.slice(0, 200)}`,
        { kind: 'graph', slug: opts.slug, not_sent: true },
      );
    }

    // Step 2 — send the draft. 202 Accepted with empty body on success.
    const draftUrl = `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(draft.id)}`;
    const sendRes = await postWithRetry(`${draftUrl}/send`);
    if (!sendRes.ok) {
      const text = await sendRes.text().catch(() => '');
      // ⛔ A refusal (4xx) sent nothing and left step 1's draft in the
      // mailbox's Drafts, and each try made another: four refused answers left
      // four drafts in the owner's Outlook (live, 2026-10-15, an account whose
      // sending Microsoft had suspended). It goes. A 5xx proves nothing either
      // way, so that draft stays: it may be the message on its way.
      if (sendRes.status >= 400 && sendRes.status < 500) {
        await deleteWithRetry(draftUrl).catch(() => undefined);
      }
      throwSendError(sendRes.status, text);
    }

    lastSuccessfulSyncAt = nowOf();
    return {
      // Graph splits the two ids: `id` is the server-assigned
      // resource id (drives the Sent Items lookup); `internetMessageId`
      // is the RFC 5322 Message-Id header recipients see.
      source_id: draft.id,
      message_id: draft.internetMessageId ?? draft.id,
      sent_at: sentAt,
      thread_id: draft.conversationId,
    };
  };

  const GRAPH_RECONCILIATION_SELECT = [
    'id',
    'subject',
    'internetMessageId',
    'internetMessageHeaders',
    'toRecipients',
    'ccRecipients',
    'bccRecipients',
    'hasAttachments',
    'sentDateTime',
  ].join(',');

  const graphReconciliationAttachments = async (
    messageId: string,
    hasAttachments: boolean,
    query: MailSentAttachmentReconciliationQuery,
  ): Promise<{ parts: InboundMailAttachmentPart[]; complete: boolean }> => {
    if (!hasAttachments) return { parts: [], complete: true };
    const metadata: GraphAttachmentPayload[] = [];
    let complete = true;
    const firstUrl = new URL(
      `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments`,
    );
    firstUrl.searchParams.set('$select', 'id,name,contentType,size,isInline');
    let url: string | undefined = firstUrl.toString();
    const pagination = new ProviderPaginationGuard('graph mail reconciliation attachment', {
      trustedBaseUrl: GRAPH_API_BASE,
    });
    while (url) {
      const page: GraphListResponse<GraphAttachmentPayload> =
        await getReconciliationSource<GraphListResponse<GraphAttachmentPayload>>(
          pagination.claim(url),
        );
      for (const attachment of page.value ?? []) {
        if (metadata.length >= 10) {
          complete = false;
          break;
        }
        if (!attachment['@odata.type']?.endsWith('fileAttachment')) {
          complete = false;
          continue;
        }
        metadata.push(attachment);
      }
      if (!complete) break;
      url = readProviderStringContinuation(
        page['@odata.nextLink'],
        'graph mail reconciliation attachment',
      );
    }
    if (!complete) return { parts: [], complete: false };
    if (metadata.length !== 1) {
      return {
        parts: metadata.map((attachment, index) => ({
          filename: attachment.name ?? '',
          mime_type: normalizeMailAttachmentMimeType(attachment.contentType),
          size: typeof attachment.size === 'number' ? attachment.size : -1,
          source_part_id: attachment.id ?? `part-${index}`,
          disposition: attachment.isInline === true ? 'inline' : 'attachment',
          async fetchBytes() { throw new Error('attachment set is not exact'); },
        })),
        complete: true,
      };
    }

    const attachment = metadata[0]!;
    const filename = attachment.name ?? '';
    const mimeType = normalizeMailAttachmentMimeType(attachment.contentType);
    if (
      !attachment.id
      || attachment.size !== query.attachment_size_bytes
      || attachment.isInline === true
      || filename !== query.attachment_filename
      || mimeType !== normalizeMailAttachmentMimeType(query.attachment_mime_type)
    ) {
      return {
        parts: [{
          filename,
          mime_type: mimeType,
          size: typeof attachment.size === 'number' ? attachment.size : -1,
          source_part_id: attachment.id ?? 'part-0',
          disposition: attachment.isInline === true ? 'inline' : 'attachment',
          async fetchBytes() { throw new Error('attachment metadata does not match'); },
        }],
        complete: true,
      };
    }
    const detail = await getReconciliationSource<GraphAttachmentPayload>(
      `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`,
    );
    if (typeof detail.contentBytes !== 'string') {
      return { parts: [], complete: false };
    }
    const maxEncodedAttachmentBytes = 4 * Math.ceil(
      query.attachment_size_bytes / 3,
    ) + 4;
    if (Buffer.byteLength(detail.contentBytes, 'ascii') > maxEncodedAttachmentBytes) {
      return { parts: [], complete: false };
    }
    const detailBytes = decodeGraphContentBytes(detail.contentBytes);
    if (
      detail.isInline === true
      || (detail.size !== undefined && detail.size !== query.attachment_size_bytes)
      || detailBytes.length > query.attachment_size_bytes
    ) {
      return { parts: [], complete: false };
    }
    return {
      parts: [mailSentReconciliationAttachmentPartFromBytes({
        filename: detail.name ?? attachment.name ?? '',
        mime_type: detail.contentType ?? attachment.contentType,
        source_part_id: detail.id ?? attachment.id,
        disposition: 'attachment',
        bytes: detailBytes,
      })],
      complete: true,
    };
  };

  const graphReconciliationCandidate = async (
    message: GraphMessagePayload,
    query: MailSentReconciliationQuery,
  ): Promise<MailSentReconciliationCandidate> => {
    const sentAt = message.sentDateTime ? Date.parse(message.sentDateTime) : Number.NaN;
    if (!Number.isSafeInteger(sentAt) || sentAt < 0) {
      throw new Error(`graph message ${message.id} missing a safe sentDateTime`);
    }
    const reconciliationHeaderValues = (message.internetMessageHeaders ?? [])
      .filter((header) => header.name?.toLowerCase()
        === MAIL_RECONCILIATION_ID_HEADER.toLowerCase())
      .map((header) => header.value ?? '');
    const identityBearing = reconciliationHeaderValues.some(
      (value) => value.trim() === query.reconciliation_id,
    );
    const attachments = query.proof_kind === 'attachment'
      && identityBearing
      && reconciliationHeaderValues.length === 1
      ? await graphReconciliationAttachments(
          message.id,
          message.hasAttachments === true,
          query,
        )
      : { parts: [], complete: true };
    return {
      source_id: message.id,
      rfc_message_id: message.internetMessageId,
      reconciliation_header_values: reconciliationHeaderValues,
      to: addressList(message.toRecipients),
      cc: addressList(message.ccRecipients),
      bcc: addressList(message.bccRecipients),
      subject: message.subject ?? '',
      sent_at: sentAt,
      attachments: attachments.parts,
      attachment_set_complete: attachments.complete,
    };
  };

  /** D-318 step 2 — proof (a): the messages in this account's Sent Items that
   *  carry one Message-ID. Graph stores `internetMessageId` with its angle
   *  brackets; the folder is Graph's own record that the account sent it, and
   *  each hit's id is compared exactly. */
  const lookupSentByMessageId = async (
    query: MailSentByMessageIdQuery,
  ): Promise<MailSentByMessageIdResult> => {
    try {
      const filter = `internetMessageId eq '<${query.rfc_message_id.replace(/'/g, "''")}>'`;
      const url = `${GRAPH_API_BASE}/me/mailFolders/sentitems/messages`
        + `?$filter=${encodeURIComponent(filter)}`
        + `&$top=${MAIL_SENT_BY_MESSAGE_ID_MAX_MATCHES}`
        + '&$select=internetMessageId,toRecipients,subject,sentDateTime';
      const page = await getReconciliationSource<GraphListResponse<GraphMessagePayload>>(url);
      const matches: MailSentByMessageIdMatch[] = [];
      for (const message of (page.value ?? []).slice(0, MAIL_SENT_BY_MESSAGE_ID_MAX_MATCHES)) {
        if (normalizeRfcMessageId(message.internetMessageId) !== query.rfc_message_id) continue;
        const sentAt = message.sentDateTime ? Date.parse(message.sentDateTime) : Number.NaN;
        matches.push({
          to: addressList(message.toRecipients),
          subject: message.subject ?? '',
          sent_at: Number.isFinite(sentAt) ? sentAt : 0,
        });
      }
      return matches.length > 0 ? { status: 'found', matches } : { status: 'not_found' };
    } catch (err) {
      markError('graph sent lookup by message id failed', err);
      return { status: 'unavailable', reason: 'provider_error' };
    }
  };

  /** D-318 — the replies this account SENT to one Message-ID: has the chat
   *  mailbox answered this request? An answer is Outlook's own reply
   *  (`createReply`), in the request's conversation: the request, found by its
   *  Message-ID, names the conversation and when it arrived, and the Sent Items
   *  in it whose In-Reply-To is exactly that id are the replies.
   *
   *  ⛔ Every answer in a conversation is in that conversation's Sent Items, so
   *  a long one holds more than a page of them: read from the request's
   *  arrival, oldest first, its own answer is among the first (an unordered
   *  page could leave it out, and the request would be run again). Graph orders
   *  only by a property the filter names first.
   *
   *  ⛔ A Sent item's In-Reply-To is Exchange's own property, not one of its
   *  headers (`GRAPH_IN_REPLY_TO_PROPERTY`): read from the headers, every answer
   *  went unrecognised, and a restored server ran its request again (live,
   *  2026-10-15). */
  const lookupSentReplies = async (
    query: MailSentRepliesQuery,
  ): Promise<MailSentRepliesResult> => {
    try {
      const filter = `internetMessageId eq '<${query.rfc_message_id.replace(/'/g, "''")}>'`;
      const page = await getReconciliationSource<GraphListResponse<GraphMessagePayload>>(
        `${GRAPH_API_BASE}/me/messages?$filter=${encodeURIComponent(filter)}`
        + '&$top=5&$select=internetMessageId,conversationId,receivedDateTime',
      );
      const arrivals = new Map<string, number>();
      for (const message of page.value ?? []) {
        if (normalizeRfcMessageId(message.internetMessageId) !== query.rfc_message_id) continue;
        if (typeof message.conversationId !== 'string' || message.conversationId.length === 0) continue;
        const received = message.receivedDateTime ? Date.parse(message.receivedDateTime) : Number.NaN;
        const arrived = Number.isFinite(received) ? received : 0;
        arrivals.set(message.conversationId, Math.min(arrivals.get(message.conversationId) ?? arrived, arrived));
      }
      const matches: MailSentReplyMatch[] = [];
      for (const [conversationId, arrived] of [...arrivals].slice(0, 2)) {
        const sentFilter = `sentDateTime ge ${new Date(arrived).toISOString()}`
          + ` and conversationId eq '${conversationId.replace(/'/g, "''")}'`;
        const sent = await getReconciliationSource<GraphListResponse<GraphSentReplyPayload>>(
          `${GRAPH_API_BASE}/me/mailFolders/sentitems/messages?$filter=${encodeURIComponent(sentFilter)}`
          + `&$orderby=${encodeURIComponent('sentDateTime asc')}`
          + `&$top=${MAIL_SENT_REPLIES_MAX_MATCHES}&$select=internetMessageHeaders,sentDateTime`
          + `&$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${GRAPH_IN_REPLY_TO_PROPERTY}')`)}`,
        );
        for (const message of sent.value ?? []) {
          if (matches.length >= MAIL_SENT_REPLIES_MAX_MATCHES) break;
          const headerOf = (name: string): string | undefined => (message.internetMessageHeaders ?? [])
            .find((header) => header.name?.toLowerCase() === name)?.value;
          const inReplyTo = (message.singleValueExtendedProperties ?? [])
            .find((property) => property.id?.toLowerCase() === GRAPH_IN_REPLY_TO_PROPERTY.toLowerCase())?.value
            ?? headerOf('in-reply-to');
          if (normalizeRfcMessageId(inReplyTo) !== query.rfc_message_id) continue;
          const sentAt = message.sentDateTime ? Date.parse(message.sentDateTime) : Number.NaN;
          matches.push({
            reconciliation_id: headerOf(MAIL_RECONCILIATION_ID_HEADER)?.trim() || null,
            sent_at: Number.isFinite(sentAt) ? sentAt : 0,
          });
        }
      }
      return matches.length > 0 ? { status: 'found', matches } : { status: 'not_found' };
    } catch (err) {
      markError('graph sent replies lookup failed', err);
      return { status: 'unavailable', reason: 'provider_error' };
    }
  };

  const lookupSentByReconciliationId = async (
    query: MailSentReconciliationQuery,
  ): Promise<MailSentReconciliationResult> => {
    assertMailSentReconciliationQuery(query);
    const candidates: MailSentReconciliationCandidate[] = [];
    try {
      const filter = `sentDateTime ge ${new Date(query.sent_after).toISOString()}`
        + ` and sentDateTime lt ${new Date(query.sent_before).toISOString()}`;
      let url: string | undefined =
        `${GRAPH_API_BASE}/me/mailFolders/sentitems/messages`
        + `?$filter=${encodeURIComponent(filter)}`
        + '&$top=50&$select=id';
      const pagination = new ProviderPaginationGuard('graph mail reconciliation', {
        trustedBaseUrl: GRAPH_API_BASE,
      });
      while (url) {
        const page: GraphListResponse<GraphMessagePayload> =
          await getReconciliationSource<GraphListResponse<GraphMessagePayload>>(
            pagination.claim(url),
          );
        for (const ref of page.value ?? []) {
          if (candidates.length >= MAIL_SENT_RECONCILIATION_MAX_SCAN) {
            return evaluateMailSentReconciliationCandidates(query, candidates, false);
          }
          if (typeof ref.id !== 'string' || ref.id.length === 0) {
            throw new Error('graph Sent listing returned a message without an id');
          }
          const detailUrl = new URL(
            `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(ref.id)}`,
          );
          detailUrl.searchParams.set('$select', GRAPH_RECONCILIATION_SELECT);
          const detail = await getReconciliationSource<GraphMessagePayload>(detailUrl.toString());
          candidates.push(await graphReconciliationCandidate(detail, query));
        }
        url = readProviderStringContinuation(
          page['@odata.nextLink'],
          'graph mail reconciliation',
        );
        if (url && candidates.length >= MAIL_SENT_RECONCILIATION_MAX_SCAN) {
          return evaluateMailSentReconciliationCandidates(query, candidates, false);
        }
      }
      lastSuccessfulSyncAt = nowOf();
      return evaluateMailSentReconciliationCandidates(query, candidates, true);
    } catch (err) {
      markError('graph sent reconciliation lookup failed', err);
      return {
        status: 'unavailable',
        reason: 'provider_error',
        scanned_candidates: candidates.length,
      };
    }
  };

  // ── D-239 write-back ────────────────────────────────────────────
  //
  // Graph splits the four verbs across three HTTP shapes: PATCH for the
  // two state bits, POST /move for relocation, DELETE for removal. All
  // three echo or imply a verified outcome, which is what the collection
  // needs before it touches the warehouse.

  const throwGraphMutationError = (
    status: number,
    text: string,
    verb: string,
  ): never => {
    const detail = `graph ${verb} (${status}): ${text.slice(0, 200)}`;
    if (status === 401) {
      markError(`graph ${verb} auth ${status}`, text);
      throw new MailAdapterError('auth_expired', detail);
    }
    if (status === 403) {
      markError(`graph ${verb} forbidden ${status}`, text);
      throw new MailAdapterError('permission_denied', detail);
    }
    if (status === 404) {
      // Graph returns 404 for both "no such message" and "no such
      // destination folder". The verb is the only thing that tells them
      // apart, and it is the discriminator recipe authors branch on.
      throw new MailAdapterError(
        verb === 'move' ? 'folder_not_found' : 'message_not_found',
        detail,
      );
    }
    if (status === 429) throw new MailAdapterError('quota_exceeded', detail);
    if (status >= 400 && status < 500) {
      throw new MailAdapterError('folder_not_found', detail);
    }
    markError(`graph ${verb} transient ${status}`, text);
    // ⛔ OUTCOME UNKNOWN — never write the warehouse on this.
    throw new MailAdapterError(
      'io_error',
      `${detail} — outcome unknown, the change may have been applied`,
    );
  };

  /** PATCH with the same one-shot 401-refresh contract `postWithRetry`
   *  and `getWithRetry` use. */
  const patchWithRetry = async (
    url: string,
    body: string,
  ): ReturnType<HttpFetcher> => {
    const patch = async (token: string | undefined) => fetcher(url, {
      method: 'PATCH',
      headers: {
        ...oauthAuthorizationHeaders(token),
        'Content-Type': 'application/json',
      },
      body,
    });
    let res = await patch(await ensureToken(false));
    if (res.status === 401 && !opts.managedFetcher) res = await patch(await ensureToken(true));
    return res;
  };

  const deleteWithRetry = async (url: string): ReturnType<HttpFetcher> => {
    const del = async (token: string | undefined) => fetcher(url, {
      method: 'DELETE',
      headers: { ...oauthAuthorizationHeaders(token) },
    });
    let res = await del(await ensureToken(false));
    if (res.status === 401 && !opts.managedFetcher) res = await del(await ensureToken(true));
    return res;
  };

  const messageUrl = (id: string): string =>
    `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(id)}`;

  /** Read the mutation response body as a Graph message and fold it into
   *  the shared result shape. Graph's PATCH and POST /move both return the
   *  updated resource, so the reflected state is the provider's own answer.
   *
   *  ⚠ The response comes back in Graph's DEFAULT projection, not our
   *  `$select`, so `flag` / `isRead` / `parentFolderId` are present but
   *  everything else may not be — which is fine, because this shape reads
   *  only those three. */
  const mutationResultFrom = (
    data: GraphMessagePayload | null,
    fallbackId: string,
    verb: string,
  ): MailMutationResult => {
    if (!data || typeof data.id !== 'string' || data.id.length === 0) {
      // A 2xx whose body we cannot read leaves us with no verified state.
      // The change almost certainly landed — but "almost certainly" is
      // exactly what `io_error` exists to express, and the next delta tick
      // settles it against the provider rather than against a guess.
      throw new MailAdapterError(
        'io_error',
        `graph ${verb} returned a malformed response for '${fallbackId}' — outcome unknown`,
      );
    }
    return {
      // ⚠ NOT `fallbackId`. `POST /move` mints a NEW resource id — the
      // message is a different Graph object in its new folder — so echoing
      // the input here would leave the warehouse keyed to an id that no
      // longer resolves, and every later mutation on that row would 404.
      source_id: data.id,
      is_read: data.isRead ?? false,
      is_flagged: data.flag?.flagStatus === 'flagged',
      folder_or_label: data.parentFolderId ?? '',
    };
  };

  const runGraphMutation = async (
    verb: string,
    fallbackId: string,
    call: () => ReturnType<HttpFetcher>,
  ): Promise<GraphMessagePayload | null> => {
    let res: Awaited<ReturnType<HttpFetcher>>;
    try {
      res = await call();
    } catch (err) {
      markError(`graph ${verb} transport failure`, err);
      throw new MailAdapterError(
        'io_error',
        `graph ${verb} could not reach the provider for '${fallbackId}' — outcome unknown`,
        err,
      );
    }
    if (!res.ok) {
      throwGraphMutationError(res.status, await res.text().catch(() => ''), verb);
    }
    lastSuccessfulSyncAt = nowOf();
    return (await res.json().catch(() => null)) as GraphMessagePayload | null;
  };

  const markImpl = async (args: {
    source_id: string;
    read: boolean;
  }): Promise<MailMutationResult> => mutationResultFrom(
    await runGraphMutation('mark', args.source_id, () =>
      patchWithRetry(messageUrl(args.source_id), JSON.stringify({ isRead: args.read }))),
    args.source_id,
    'mark',
  );

  const flagImpl = async (args: {
    source_id: string;
    flagged: boolean;
  }): Promise<MailMutationResult> => mutationResultFrom(
    await runGraphMutation('flag', args.source_id, () =>
      patchWithRetry(
        messageUrl(args.source_id),
        // Clearing sets `notFlagged`, never `complete`: "complete" is a
        // follow-up the user finished, and asserting that on their behalf
        // would put a claim in their mailbox they never made.
        JSON.stringify({
          flag: { flagStatus: args.flagged ? 'flagged' : 'notFlagged' },
        }),
      )),
    args.source_id,
    'flag',
  );

  const moveImpl = async (args: {
    source_id: string;
    destination: MailMoveDestination;
  }): Promise<MailMutationResult> => {
    const folder = args.destination.folder;
    if (!folder) {
      // Label sets are Gmail's model. Graph has folders; refusing is
      // honest, translating would be invention.
      throw new MailAdapterError(
        'folder_not_found',
        'graph move requires a destination folder — Gmail label sets have no Graph equivalent',
      );
    }
    return mutationResultFrom(
      await runGraphMutation('move', args.source_id, () =>
        postWithRetry(
          `${messageUrl(args.source_id)}/move`,
          JSON.stringify({ destinationId: folder }),
        )),
      args.source_id,
      'move',
    );
  };

  const deleteImpl = async (args: { source_id: string }): Promise<void> => {
    // Graph's DELETE on a message files it to Deleted Items rather than
    // purging it — the same reversible gesture Outlook's own delete
    // performs. (A true purge requires deleting from Deleted Items again.)
    let res: Awaited<ReturnType<HttpFetcher>>;
    try {
      res = await deleteWithRetry(messageUrl(args.source_id));
    } catch (err) {
      markError('graph delete transport failure', err);
      throw new MailAdapterError(
        'io_error',
        `graph delete could not reach the provider for '${args.source_id}' — outcome unknown`,
        err,
      );
    }
    if (!res.ok) {
      throwGraphMutationError(res.status, await res.text().catch(() => ''), 'delete');
    }
    lastSuccessfulSyncAt = nowOf();
  };

  // Derive capability and method together at construction. Direct accounts
  // use granted scopes; managed accounts require an explicit owner switch,
  // with vendor permission still enforced on the actual request.
  // Tolerant match — Microsoft may return `https://graph.microsoft.com/Mail.Send`
  // for a `Mail.Send` request, and an exact miss makes send silently unavailable
  // (see `grantedScopesInclude`).
  // ⛔ BOTH SCOPES, because the send is a draft and then `/send`: the draft is
  // Graph's "create message", which needs `Mail.ReadWrite`. `Mail.Send` alone
  // reported sendCapable while every send was refused 403 (2026-10-15).
  const sendCapable = opts.nativeSendEnabled !== false && (opts.managedFetcher ? opts.managedSendEnabled === true : (
    grantedScopesInclude(opts.config().granted_scopes ?? [], GRAPH_SEND_SCOPE)
    && grantedScopesInclude(opts.config().granted_scopes ?? [], GRAPH_MODIFY_SCOPE)
  ));
  const accountEmail = opts.config().account_email ?? '';
  // D-239 — same lockstep + tolerant-match discipline as `sendCapable`.
  const mutationCapable = opts.nativeMutationEnabled !== false && (opts.managedFetcher ? opts.managedMutationEnabled === true : grantedScopesInclude(
    opts.config().granted_scopes ?? [],
    GRAPH_MODIFY_SCOPE,
  ));

  return {
    kind: 'graph',
    slug: opts.slug,
    // Each folder's delta link persists in the account store, and an expired
    // one is seeded again from a listing (the 404/410 path).
    resumesFromCursor: true,
    sendCapable,
    mutationCapable,
    // D-264 — creating a draft needs the same grant mutation does
    // (`GRAPH_MODIFY_SCOPE`), so the VALUE coincides here. Kept as its own field
    // because the QUESTIONS differ: a later change to what counts as
    // mutation must not silently redefine what counts as draftable.
    draftCapable: mutationCapable,
    ...(mutationCapable ? { saveDraft: saveDraftImpl } : {}),
    accountEmail,
    fetchMessage,

    async connect() {
      // `sync.stop()` closes the provider and a later `sync.start()` reuses it
      // (the vault lock edge): a new connection gets a new signal.
      if (lifecycle.signal.aborted) lifecycle = new AbortController();
      try {
        await ensureToken(false);
      } catch (err) {
        if (err instanceof OAuthError) markError('graph connect token refresh failed', err);
        throw err;
      }
    },

    async initialScan(scanOpts) {
      const signal = lifecycle.signal;
      await outcomes.run('initial_scan', async () => {
        // Establish every folder's watermark BEFORE the list walk. Messages
        // arriving during a long backfill are then replayed by the first delta
        // tick. Seeding afterwards makes those arrivals part of the new baseline
        // and loses them permanently.
        for (const folder of folders()) {
          // Preserve the original pre-scan boundary across a failed backfill
          // retry. Re-seeding at "now" would discard changes that happened
          // after the first attempt began.
          if ((await opts.accountStore.get(deltaLinkKey(folder))) === null) {
            await seedDeltaLink(folder, signal, undefined, scanOpts.onAccessVerified);
          }
        }
        await runInitialScan(scanOpts, signal);
      });
    },

    async startSync(cb) {
      const scheduler = opts.scheduler ?? defaultScheduler;
      const intervalMs = Math.max(1, opts.config().poll_seconds) * 1000;
      // ONE outcome per sweep, not per folder: a tick is the unit the user
      // experiences ("did my mail update"), and a per-folder outcome would let a
      // healthy inbox mask a broken archive folder in the same attempt.
      // A scheduled poll gets its loop's signal; a test scheduler calls it bare.
      const session = lifecycle.signal;
      const tick = (signal?: AbortSignal): Promise<void> =>
        outcomes.run('poll', async () => {
          for (const folder of folders()) {
            await runDeltaTick(folder, cb, signal ?? session);
          }
        });
      // Fire an initial tick so tests + healthchecks don't wait on
      // the first interval.
      await tick(session);
      // Closed during that first poll: start no loop that nothing would stop.
      if (session.aborted) throw new CollectionStoppedError();
      pollStop = scheduler(tick, intervalMs);
      return async () => {
        const stop = pollStop;
        pollStop = null;
        await stop?.();
      };
    },

    async close() {
      // Close admission and abort the scan, seed walk or poll in flight; the
      // poll loop's stop then waits for its pass at most `STOP_GRACE_MS`.
      lifecycle.abort(new CollectionStoppedError('the graph mail provider was closed'));
      const stop = pollStop;
      pollStop = null;
      await stop?.();
    },

    onSyncOutcome(listener: MailSyncOutcomeListener) {
      return outcomes.subscribe(listener);
    },

    health(): ProviderHealth {
      return {
        last_successful_sync_at: lastSuccessfulSyncAt,
        error_count_24h: errorCount24h,
        pending_queue_size: pendingQueueSize,
      };
    },

    lookupSentByReconciliationId,
    lookupSentByMessageId,
    lookupSentReplies,

    ...(sendCapable ? { send: sendImpl } : {}),
    // D-239 — attached as a group, in lockstep with `mutationCapable`.
    ...(mutationCapable
      ? {
          markMessage: markImpl,
          flagMessage: flagImpl,
          moveMessage: moveImpl,
          deleteMessage: deleteImpl,
        }
      : {}),
  };
};

// ────────────────────────────────────────────────────────────────
// Shipped OAuth client config
// ────────────────────────────────────────────────────────────────

/** Graph mail's token endpoint — a PROTOCOL constant, not a credential.
 *
 *  This used to be `GRAPH_OAUTH_CONFIG`, an `OAuthProviderConfig` whose
 *  `clientId` / `clientSecret` were read from `RECUED_GRAPH_CLIENT_ID` /
 *  `_SECRET`. Those two env vars were DELETED (2026-07-28) — and with them the
 *  "generic name for a non-generic slot" problem: one global env pair per
 *  issuer, while the encrypted store models credentials per issuer properly.
 *  Credentials now come ONLY from `OAuthAppConfigStore` under issuer
 *  `microsoft`. */
export const GRAPH_TOKEN_URL = MICROSOFT_TOKEN_URL;
