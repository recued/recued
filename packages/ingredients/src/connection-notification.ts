/** D-125 Phase 4.3 — `connection.notification` per-kind handler.
 *
 *  Third per-kind handler under the `connection` adapter (after P4.1
 *  api + P4.2 mcp). Implements outbound notification delivery for
 *  `kind: 'connection' + connection_kind: 'notification'` ingredients,
 *  replacing the P3.1 placeholder that surfaces
 *  `INGREDIENT_ADAPTER_ALL_FAILED` with `kind: 'connection.notification'`.
 *
 *  D-127 Phase 3.1 — email subtype graduates from
 *  `NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED` to a real handler façade
 *  over `MailCollection.send`. The handler reads
 *  `record.config.sender_mail_instance` to resolve the underlying
 *  mail account, dispatches via the injected `mailRpc.send` callback
 *  (closes over `handleCollectionMailSend` at the boot site), and
 *  returns the mail-rpc's `message_id` / `sent_at` / `thread_id?` in
 *  the same `NotificationOk` envelope as slack / telegram / in-app.
 *  Sender ≠ to / capability gate / `mail_send` audit row all live in
 *  `MailCollection.send` itself (D-127 P1.6 + P1.7) — this layer is
 *  a thin façade that aligns the email subtype with the rest of the
 *  notification trio.
 *
 *  Wire shape (spec § 4.3):
 *
 *    Input — `params` after the shell strips `connection_kind` +
 *    `connection`:
 *      - text:      message body (required string for slack / telegram
 *                   / in-app; for email subtype, `body` wins and `text`
 *                   is the notification-send fan-out fallback).
 *      - title:     optional heading; surfaces as Slack `text` /
 *                   Telegram bold prefix / in-app banner title /
 *                   email subject fallback.
 *      - link_url:  optional deep-link target. Renamed from `url` per
 *                   D-122 P4.5 to dodge the engine's HTTP routing key.
 *      - recipient: subtype-specific override of the record's default
 *                   destination. Slack: channel name or id. Telegram:
 *                   chat_id. Email: to-address (single recipient
 *                   override; `to[]` from `mail-post` wins). In-app:
 *                   ignored (the bus fan-out is per-pair).
 *      - to:        email-only — explicit recipient list from
 *                   `mail-post` (string or string[]). Wins over
 *                   `recipient` and `config.default_recipient`.
 *      - subject:   email-only primary subject. Falls back to `title`,
 *                   then `'(no subject)'`.
 *      - body:      email-only primary body. Falls back to `text` for
 *                   notification-send fan-out.
 *      - body_format: email-only — `'html'` routes the body through
 *                   `body_html` on the mail rpc (mirrored on
 *                   `body_text` for legacy MUAs).
 *      - timeout_ms: per-call timeout. Clamped via `resolveTimeoutMs`.
 *
 *    Output — uniform across subtypes:
 *      `{ status: 'ok' | 'send_error',
 *         result: <subtype-specific>,
 *         headers: undefined }`
 *      `'send_error'` is the parallel of MCP's `'tool_error'` — the
 *      transport call completed but the vendor reported the message
 *      didn't go out (Slack `ok: false`, Telegram `ok: false`). The
 *      `result.error` field carries the vendor's surfaced reason so
 *      a wrapper recipe (P5's fan-out `notification-send`) can branch
 *      without unwrapping the vendor envelope. Network / auth /
 *      timeout failures throw `IngredientError` (NETWORK_ERROR /
 *      OAUTH_EXPIRED / STEP_TIMEOUT / ACTION_DELIVERY_UNCERTAIN —
 *      same risk-tier-aware classification as the api + mcp handlers).
 *
 *  Subtype dispatch on `record.subtype`:
 *
 *    - `slack`     → POST `chat.postMessage` with bearer auth
 *                    (xoxb-…) and `record.config.channel_id` (default;
 *                    `params.recipient` overrides). Body carries
 *                    `text` (always) + `blocks` derived from `title`
 *                    / `link_url` when present.
 *    - `telegram`  → POST `https://api.telegram.org/bot<token>/sendMessage`
 *                    with `record.auth.token` (bearer-typed) embedded
 *                    in the URL path. Body carries `chat_id` (from
 *                    `record.config.chat_id` or `params.recipient`)
 *                    + `text` (title prefixed when set).
 *    - `email`     → dispatches via the injected `mailRpc.send` callback
 *                    (D-127 P3.1 — the email subtype rides a paired
 *                    server's mail collection `data.mail.<instance>`, NOT
 *                    an in-handler SMTP stack). Throws
 *                    `NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED` ONLY when
 *                    `mailRpc` is unwired (ext-side / dbless harness), with
 *                    a diagnostic pointing at server pairing.
 *    - `in-app`    → broadcast bus emit via the injected `emitInApp`
 *                    callback. No HTTP, no auth, no creds. Throws
 *                    `NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED` ONLY when
 *                    `emitInApp` is unwired (the bus needs the server).
 *
 *  Bytes telemetry — populates `ctx.setBytes(in, out)` on every
 *  successful dispatch:
 *    - HTTP subtypes: request body length + response length (declared
 *      via Content-Length, fall back to JSON-stringify length).
 *    - In-app: 0 in, JSON-stringify body length out — measures the
 *      payload that crossed the bus boundary, not the wire (there
 *      is no wire — broadcast is in-process). The audit row carries
 *      `bytes_in: 0` for in-app, which matches the no-network
 *      semantics. */

import {
  CONNECTION_API_TIMEOUT_MS,
  NOTIFICATION_SUBTYPES,
} from '@recued/contracts';
import type {
  ConnectionAuth,
  ConnectionRow,
  NotificationSubtype,
} from '@recued/contracts';
import type { ConnectionHandlerCtx, ConnectionKindHandler } from './connection.js';
import { IngredientError, type ResolvedCall } from './types.js';
import { resolveTimeoutMs, isWriteRiskTier } from './timeout.js';
import {
  discardResponseBody,
  readBoundedResponseText,
  ResponseBodyTooLargeError,
} from './bounded-response-body.js';

/** D-192 seam 10 — the enrollable notification subtypes come from contracts
 *  (every declared chat transport + `email` + `in-app`), so a newly declared
 *  transport is recognized here with no edit. */
const KNOWN_SUBTYPES: ReadonlySet<NotificationSubtype> = new Set<NotificationSubtype>(
  NOTIFICATION_SUBTYPES,
);

const isNotificationSubtype = (v: unknown): v is NotificationSubtype =>
  typeof v === 'string' && KNOWN_SUBTYPES.has(v as NotificationSubtype);

/** Body shape emitted to the broadcast bus for in-app notifications.
 *  Mirrors the `body` field of the `kind: 'notification'` ServerEvent
 *  variant added in this phase. */
export interface NotificationBusBody {
  text: string;
  title?: string;
  link_url?: string;
}

/** Callback the handler invokes for in-app dispatch. The boot site
 *  closes over `eventBus.emit({ kind: 'notification', subtype: 'in-app',
 *  body, ... })` from `backend/server/src/events/emit-sites.ts`. Tests
 *  inject a recording stub. Optional in deps so dbless / ext-side
 *  harnesses can run the slack / telegram subtypes without wiring a
 *  bus — calls to in-app surface `NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED`
 *  with a precise diagnostic about the missing bus instead of failing
 *  silently. */
export type InAppEmitFn = (body: NotificationBusBody) => void;

/** D-127 P3.1 — input shape forwarded to `MailCollection.send` (or the
 *  ext-side rpc bridge to the paired server's mail collection). Mirrors
 *  the kernel `mailSend` dispatcher input verbatim so the boot site can
 *  reuse the same closure for both kernel mail-send and notification-
 *  email dispatch. The `instance` field carries the mail-collection
 *  slug (`data.mail.<instance>`) — the email handler resolves it from
 *  `record.config.sender_mail_instance`, not the recipe input. */
export interface MailRpcSendInput {
  instance: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body_text: string;
  body_html?: string;
  in_reply_to?: string;
  references?: string[];
  reply_to?: string;
}

/** D-127 P3.1 — return shape from `MailCollection.send`. Structurally
 *  matches `SentMessageMeta` plus the rpc-layer canonical-record fields
 *  (`_id` / `_collection`). The email handler only reads
 *  `message_id` / `sent_at` / `thread_id`; the extra fields ride along
 *  harmlessly via structural typing so the boot site can wire the rpc
 *  result directly without a translation step. */
export interface MailRpcSendResult {
  source_id: string;
  message_id: string;
  sent_at: number;
  thread_id?: string;
  warnings?: Array<{ code: string; message: string }>;
}

/** D-127 P3.1 — minimal mail-rpc surface the email subhandler needs.
 *  Boot site closes over `handleCollectionMailSend({ registry, ... }, ...)`
 *  to inject. Optional in deps so dbless / ext-side harnesses without
 *  a wired mail collection still surface a clean
 *  `NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED` diagnostic instead of
 *  silently dropping the email subtype. */
export interface MailRpcDep {
  send(args: MailRpcSendInput): Promise<MailRpcSendResult>;
}

export interface ConnectionNotificationHandlerDeps {
  /** Decrypt at-rest `auth_ciphertext` to a typed `ConnectionAuth`.
   *  Boot site closes over `decodeAuthFromStorage` from the connection
   *  sub-DEK pipeline. Called once per dispatch — auth is never
   *  cached at the handler level so a re-enrollment between calls
   *  picks up immediately. In-app dispatch never touches this (no
   *  creds), so for pure in-app harnesses tests can pass a stub
   *  that throws — it won't be reached. */
  decodeAuth: (row: ConnectionRow) => Promise<ConnectionAuth>;

  /** In-app broadcast hook. Optional — when undefined, the in-app
   *  subtype throws `NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED`. Server
   *  boot wires this to `emitNotification(eventBus, ...)`; ext-side
   *  harnesses can omit (in-app needs the server bus by design). */
  emitInApp?: InAppEmitFn;

  /** D-127 P3.1 — mail rpc bridge. Optional — when undefined, the
   *  email subtype throws `NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED`
   *  (same shape as the in-app missing-bus diagnostic). Server boot
   *  closes over `handleCollectionMailSend` against the local
   *  collection registry; ext-side harnesses without a paired server
   *  leave it unwired so email dispatch surfaces a precise message
   *  pointing the user at server pairing. */
  mailRpc?: MailRpcDep;

  /** fetch implementation for HTTP subtypes (slack / telegram).
   *  Defaults to `globalThis.fetch`. Tests inject canned responses
   *  to assert wire-shape construction + auth injection + envelope
   *  parsing. */
  fetchImpl?: typeof fetch;

  /** Wall-clock source. Defaults to `Date.now`. Tests inject a
   *  deterministic stub for duration math + future scheduling tests. */
  now?: () => number;
}

interface SlackPostResponse {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
  warning?: string;
}

interface TelegramSendResponse {
  ok: boolean;
  result?: { message_id?: number; chat?: { id?: number | string } };
  description?: string;
  error_code?: number;
}

interface NotificationOk<R> {
  status: 'ok';
  result: R;
  headers: undefined;
}

interface NotificationSendError {
  status: 'send_error';
  result: { vendor: NotificationSubtype; error: string; raw?: unknown };
  headers: undefined;
}

type NotificationResponse<R> = NotificationOk<R> | NotificationSendError;

const readConfig = (row: ConnectionRow): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to throw below — malformed config is a re-enrollment
    // ask, not a recoverable runtime path.
  }
  throw new IngredientError(
    'INGREDIENT_OUTPUT_VALIDATION_FAILED',
    `connection.notification: malformed config_json for connection '${row.name}'`,
    { name: row.name },
  );
};

const requireString = (
  value: unknown,
  field: string,
  row: ConnectionRow,
  hint: string,
): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.notification: ${hint} for connection '${row.name}' — '${field}' missing or empty`,
      { name: row.name, field },
    );
  }
  return value;
};

const getSubtype = (row: ConnectionRow): NotificationSubtype => {
  if (isNotificationSubtype(row.subtype)) return row.subtype;
  // Fall back to `config.subtype` for legacy enrollments where subtype
  // wasn't stamped on the row directly. New enrollments stamp at row
  // creation time (P2.1 enroll handler), so this path is for older rows.
  let parsed: unknown;
  try { parsed = JSON.parse(row.config_json); }
  catch { parsed = null; }
  const fromConfig = (parsed as Record<string, unknown> | null)?.subtype;
  if (isNotificationSubtype(fromConfig)) return fromConfig;
  throw new IngredientError(
    'INGREDIENT_OUTPUT_VALIDATION_FAILED',
    `connection.notification: connection '${row.name}' has no subtype (expected slack / telegram / email / in-app)`,
    { name: row.name },
  );
};

/** Common fetch + classification used by slack + telegram. Both vendors
 *  expose a JSON envelope with an `ok` boolean — HTTP-level errors
 *  throw, vendor-level `ok: false` lands as the structured `send_error`
 *  shape. Write-tier 5xx surfaces `ACTION_DELIVERY_UNCERTAIN` because
 *  Slack / Telegram do commit before the ack; the user must verify
 *  in-app rather than blindly retry. */
const dispatchHttp = async (
  url: URL,
  init: RequestInit,
  args: {
    record: ConnectionRow;
    call: ResolvedCall;
    timeoutMs: number;
    fetchImpl: typeof fetch;
    bodyBytesOut: number;
    ctx?: ConnectionHandlerCtx;
    label: string;
  },
): Promise<{ envelope: unknown; bytesIn: number }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const isWrite = isWriteRiskTier(args.call.risk_tier);
  let response: Response;
  try {
    response = await args.fetchImpl(url.toString(), {
      ...init,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof IngredientError) throw e;
    const isAbort = (e as Error).name === 'AbortError';
    if (isWrite) {
      throw new IngredientError(
        'ACTION_DELIVERY_UNCERTAIN',
        `${args.label} delivery via '${args.record.name}' ${isAbort ? `timed out after ${args.timeoutMs}ms` : `failed: ${(e as Error).message}`} — outcome cannot be confirmed, please verify the recipient before retrying`,
        {
          slug: args.call.slug,
          name: args.record.name,
          cause: isAbort ? 'timeout' : 'network',
        },
      );
    }
    if (isAbort) {
      throw new IngredientError(
        'STEP_TIMEOUT',
        `${args.label} delivery to '${args.record.name}' timed out after ${args.timeoutMs}ms`,
        { slug: args.call.slug, name: args.record.name },
      );
    }
    throw new IngredientError(
      'NETWORK_ERROR',
      `${args.label} delivery to '${args.record.name}' failed: ${(e as Error).message}`,
      { slug: args.call.slug, name: args.record.name },
    );
  }
  const finishResponse = (): void => {
    discardResponseBody(response);
    clearTimeout(timer);
  };

  if (!response.ok) {
    finishResponse();
    if (response.status === 401 || response.status === 403) {
      throw new IngredientError(
        'OAUTH_EXPIRED',
        `${args.label} delivery via '${args.record.name}' returned ${response.status} ${response.statusText}`,
        { status: response.status, name: args.record.name },
      );
    }
    if (response.status === 429) {
      throw new IngredientError(
        'API_RATE_LIMITED',
        `${args.label} delivery via '${args.record.name}' rate limited (429)`,
        { status: response.status, name: args.record.name },
      );
    }
    if (response.status >= 500 && isWrite) {
      throw new IngredientError(
        'ACTION_DELIVERY_UNCERTAIN',
        `${args.label} delivery via '${args.record.name}' returned ${response.status} ${response.statusText} — outcome cannot be confirmed, please verify the recipient before retrying`,
        { status: response.status, name: args.record.name, cause: 'server_5xx' },
      );
    }
    throw new IngredientError(
      'NETWORK_ERROR',
      `${args.label} delivery via '${args.record.name}' returned ${response.status} ${response.statusText}`,
      { status: response.status, name: args.record.name },
    );
  }

  let envelope: unknown;
  let measuredBytes: number;
  try {
    const read = await readBoundedResponseText(response);
    measuredBytes = read.byteLength;
    envelope = JSON.parse(read.text) as unknown;
  } catch (e) {
    finishResponse();
    if (e instanceof ResponseBodyTooLargeError) {
      if (isWrite) {
        throw new IngredientError(
          'ACTION_DELIVERY_UNCERTAIN',
          `${args.label} delivery via '${args.record.name}' returned an oversized response — outcome cannot be confirmed, please verify the recipient before retrying`,
          { name: args.record.name, cause: 'response_too_large', max_bytes: e.maxBytes },
        );
      }
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `${args.label} delivery via '${args.record.name}' returned more than ${e.maxBytes} response bytes`,
        { name: args.record.name, max_bytes: e.maxBytes },
      );
    }
    const isAbort = (e as Error).name === 'AbortError';
    if (isWrite) {
      throw new IngredientError(
        'ACTION_DELIVERY_UNCERTAIN',
        `${args.label} delivery via '${args.record.name}' ${isAbort ? `timed out after ${args.timeoutMs}ms while reading the response` : 'returned an unreadable response'} — outcome cannot be confirmed, please verify the recipient before retrying`,
        { name: args.record.name, cause: isAbort ? 'timeout' : 'malformed_response' },
      );
    }
    if (isAbort) {
      throw new IngredientError(
        'STEP_TIMEOUT',
        `${args.label} delivery to '${args.record.name}' timed out after ${args.timeoutMs}ms while reading the response`,
        { slug: args.call.slug, name: args.record.name },
      );
    }
    throw new IngredientError(
      'NETWORK_ERROR',
      `${args.label} delivery via '${args.record.name}' returned malformed JSON: ${(e as Error).message}`,
      { name: args.record.name },
    );
  }
  finishResponse();

  const declaredLen = response.headers.get('content-length');
  const bytesIn = declaredLen !== null && Number.isFinite(Number(declaredLen))
    ? Number(declaredLen)
    : measuredBytes;
  args.ctx?.setBytes(bytesIn, args.bodyBytesOut);

  return { envelope, bytesIn };
};

/** Build the slack subtype's POST body. Title (when present) prefixes
 *  `text` so legacy / Block Kit fallback clients still see the heading
 *  inline. `link_url` is appended with a separator so a recipient
 *  reading on a notification preview gets the deep-link without
 *  needing Block Kit support. */
const buildSlackBody = (
  channel: string,
  text: string,
  title?: string,
  link_url?: string,
): string => {
  const composed = title
    ? `*${title}*\n${text}${link_url ? `\n${link_url}` : ''}`
    : `${text}${link_url ? `\n${link_url}` : ''}`;
  return JSON.stringify({ channel, text: composed });
};

const sendSlack = async (
  record: ConnectionRow,
  auth: ConnectionAuth,
  params: Record<string, unknown>,
  call: ResolvedCall,
  fetchImpl: typeof fetch,
  ctx?: ConnectionHandlerCtx,
): Promise<NotificationResponse<{ ts?: string; channel?: string }>> => {
  if (auth.type !== 'bearer') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.notification: slack subtype requires bearer auth (got ${auth.type})`,
      { name: record.name, auth_type: auth.type },
    );
  }
  const token = requireString(auth.token, 'token', record, "auth field 'token'");
  const config = readConfig(record);
  const text = requireString(params.text, 'text', record, "input field 'text'");
  const title = typeof params.title === 'string' && params.title.length > 0
    ? params.title
    : undefined;
  const link_url = typeof params.link_url === 'string' && params.link_url.length > 0
    ? params.link_url
    : undefined;
  const recipientOverride = typeof params.recipient === 'string' && params.recipient.length > 0
    ? params.recipient
    : undefined;
  const channel = recipientOverride
    ?? requireString(config.channel_id, 'channel_id', record, "config field 'channel_id'");

  const body = buildSlackBody(channel, text, title, link_url);
  const bodyBytesOut = new TextEncoder().encode(body).byteLength;
  const url = new URL('https://slack.com/api/chat.postMessage');
  const timeoutMs = resolveTimeoutMs(params.timeout_ms ?? CONNECTION_API_TIMEOUT_MS);

  const { envelope } = await dispatchHttp(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${token}`,
    },
    body,
  }, {
    record,
    call,
    timeoutMs,
    fetchImpl,
    bodyBytesOut,
    ctx,
    label: 'Slack',
  });

  const env = envelope as SlackPostResponse;
  if (env && env.ok === false) {
    return {
      status: 'send_error' as const,
      result: {
        vendor: 'slack' as const,
        error: env.error ?? 'unknown_error',
        raw: env,
      },
      headers: undefined,
    };
  }
  return {
    status: 'ok' as const,
    result: {
      ...(env?.ts !== undefined ? { ts: env.ts } : {}),
      ...(env?.channel !== undefined ? { channel: env.channel } : {}),
    },
    headers: undefined,
  };
};

const sendTelegram = async (
  record: ConnectionRow,
  auth: ConnectionAuth,
  params: Record<string, unknown>,
  call: ResolvedCall,
  fetchImpl: typeof fetch,
  ctx?: ConnectionHandlerCtx,
): Promise<NotificationResponse<{ message_id?: number }>> => {
  if (auth.type !== 'bearer') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.notification: telegram subtype requires bearer auth (got ${auth.type})`,
      { name: record.name, auth_type: auth.type },
    );
  }
  const token = requireString(auth.token, 'token', record, "auth field 'token'");
  const config = readConfig(record);
  const text = requireString(params.text, 'text', record, "input field 'text'");
  const title = typeof params.title === 'string' && params.title.length > 0
    ? params.title
    : undefined;
  const link_url = typeof params.link_url === 'string' && params.link_url.length > 0
    ? params.link_url
    : undefined;
  const recipientOverride = typeof params.recipient === 'string' && params.recipient.length > 0
    ? params.recipient
    : (typeof params.recipient === 'number' ? String(params.recipient) : undefined);
  // Telegram chat_id is numeric or a `@channelname` string — accept
  // both shapes from config without coercing here.
  const chatIdRaw = recipientOverride
    ?? config.chat_id
    ?? config.recipient;
  if (chatIdRaw === undefined || chatIdRaw === null || chatIdRaw === '') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.notification: telegram subtype requires 'chat_id' in config or 'recipient' override for connection '${record.name}'`,
      { name: record.name },
    );
  }
  const composed = title
    ? `${title}\n\n${text}${link_url ? `\n${link_url}` : ''}`
    : `${text}${link_url ? `\n${link_url}` : ''}`;
  const body = JSON.stringify({ chat_id: chatIdRaw, text: composed });
  const bodyBytesOut = new TextEncoder().encode(body).byteLength;
  const url = new URL(`https://api.telegram.org/bot${token}/sendMessage`);
  const timeoutMs = resolveTimeoutMs(params.timeout_ms ?? CONNECTION_API_TIMEOUT_MS);

  const { envelope } = await dispatchHttp(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, {
    record,
    call,
    timeoutMs,
    fetchImpl,
    bodyBytesOut,
    ctx,
    label: 'Telegram',
  });

  const env = envelope as TelegramSendResponse;
  if (env && env.ok === false) {
    return {
      status: 'send_error' as const,
      result: {
        vendor: 'telegram' as const,
        error: env.description ?? 'unknown_error',
        raw: env,
      },
      headers: undefined,
    };
  }
  const message_id = env?.result?.message_id;
  return {
    status: 'ok' as const,
    result: {
      ...(typeof message_id === 'number' ? { message_id } : {}),
    },
    headers: undefined,
  };
};

/** Discord's success envelope — a POST to `/channels/{id}/messages` returns the
 *  created message object `{ id, … }`. Discord faults by HTTP STATUS (like Graph,
 *  unlike Slack/Telegram's `200 {ok:false}`), so `dispatchHttp`'s non-2xx throw IS
 *  the error path and a returned envelope is always a success. */
interface DiscordPostResponse {
  id?: string;
}

/** Discord notify send — the recipe `notification-send` / `connection.notification`
 *  arm for the `discord` subtype (Discord declares `roles.notification: true`).
 *  Bespoke like `sendSlack`/`sendTelegram` because the ingredients package is
 *  portable and cannot reach the backend-composed `@recued/transport` adapter; the
 *  content formatting mirrors that adapter's `composeDiscordText` so the notify
 *  block and the recipe path read identically. */
const sendDiscord = async (
  record: ConnectionRow,
  auth: ConnectionAuth,
  params: Record<string, unknown>,
  call: ResolvedCall,
  fetchImpl: typeof fetch,
  ctx?: ConnectionHandlerCtx,
): Promise<NotificationResponse<{ id?: string }>> => {
  if (auth.type !== 'bearer') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.notification: discord subtype requires bearer auth (got ${auth.type})`,
      { name: record.name, auth_type: auth.type },
    );
  }
  const token = requireString(auth.token, 'token', record, "auth field 'token'");
  const config = readConfig(record);
  const text = requireString(params.text, 'text', record, "input field 'text'");
  const title = typeof params.title === 'string' && params.title.length > 0
    ? params.title
    : undefined;
  const link_url = typeof params.link_url === 'string' && params.link_url.length > 0
    ? params.link_url
    : undefined;
  const recipientOverride = typeof params.recipient === 'string' && params.recipient.length > 0
    ? params.recipient
    : (typeof params.recipient === 'number' ? String(params.recipient) : undefined);
  const channel = recipientOverride
    ?? requireString(config.channel_id, 'channel_id', record, "config field 'channel_id'");
  // Discord markdown: a bold title heading, the body, then the deep link on its
  // own line — the exact shape of the transport's `composeDiscordText`.
  const composed = title
    ? `**${title}**\n${text}${link_url ? `\n${link_url}` : ''}`
    : `${text}${link_url ? `\n${link_url}` : ''}`;
  const body = JSON.stringify({ content: composed });
  const bodyBytesOut = new TextEncoder().encode(body).byteLength;
  // `v10` mirrors `DISCORD_API_VERSION` in `@recued/transport`'s discord adapter
  // (kept a literal to avoid a portable-package → transport dependency).
  const url = new URL(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/messages`,
  );
  const timeoutMs = resolveTimeoutMs(params.timeout_ms ?? CONNECTION_API_TIMEOUT_MS);

  const { envelope } = await dispatchHttp(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // ⚠ `Bot`, NOT `Bearer` — Discord reads `Bearer` as an OAuth2 user token and
      // 401s a valid BOT token (the same reason the health probe uses `bot_header`).
      'Authorization': `Bot ${token}`,
    },
    body,
  }, {
    record,
    call,
    timeoutMs,
    fetchImpl,
    bodyBytesOut,
    ctx,
    label: 'Discord',
  });

  const env = envelope as DiscordPostResponse;
  return {
    status: 'ok' as const,
    result: {
      ...(env?.id !== undefined ? { id: env.id } : {}),
    },
    headers: undefined,
  };
};

const sendInApp = (
  record: ConnectionRow,
  params: Record<string, unknown>,
  emit: InAppEmitFn | undefined,
  ctx?: ConnectionHandlerCtx,
): NotificationResponse<undefined> => {
  if (!emit) {
    throw new IngredientError(
      'NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED',
      `connection.notification: in-app subtype requires a broadcast bus, none wired in this runtime (connection '${record.name}')`,
      { name: record.name, subtype: 'in-app' },
    );
  }
  const text = requireString(params.text, 'text', record, "input field 'text'");
  const title = typeof params.title === 'string' && params.title.length > 0
    ? params.title
    : undefined;
  const link_url = typeof params.link_url === 'string' && params.link_url.length > 0
    ? params.link_url
    : undefined;
  const body: NotificationBusBody = {
    text,
    ...(title !== undefined ? { title } : {}),
    ...(link_url !== undefined ? { link_url } : {}),
  };
  // bytes_in is 0 — there's no wire reply; bytes_out measures the
  // payload that crossed the bus boundary. In-process broadcast,
  // not network — the audit row's `bytes_in: 0` reads correctly.
  const bytesOut = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  ctx?.setBytes(0, bytesOut);
  emit(body);
  return {
    status: 'ok' as const,
    result: undefined,
    headers: undefined,
  };
};

/** D-127 P3.1 — pull a string array out of a free-form param value.
 *  Accepts `string[]` directly, a single non-empty string (wrapped),
 *  or `undefined` / empty / non-string (drops to undefined so the
 *  caller can fall through to the next fallback layer). */
const coerceRecipientList = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    const filtered = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return filtered.length > 0 ? filtered : undefined;
  }
  if (typeof value === 'string' && value.length > 0) return [value];
  return undefined;
};

/** D-127 P3.1 — email subhandler. Façade over `MailCollection.send`
 *  via the injected `mailRpc.send` callback. The connection record
 *  carries `config.sender_mail_instance` (the underlying mail
 *  collection slug) and an optional `config.default_recipient`; the
 *  recipe input may supply `to[]` (mail-post wrapper) or `recipient`
 *  (notification-style override) and `body` (mail-post) or `text`
 *  (notification-send fan-out). All sender ≠ to / capability gating
 *  / `mail_send` audit emission lives in `MailCollection.send` itself —
 *  this handler is purely a shape adapter so the email subtype slots
 *  into the same notification trio as slack / telegram / in-app.
 *
 *  Bytes telemetry: bytes_in is 0 (no wire reply at this layer — the
 *  mail rpc is in-process, the actual SMTP / HTTP IO happens inside
 *  the provider and is captured by the separate `mail_send` audit row
 *  from P1.7), bytes_out measures the body payload that crossed the
 *  rpc boundary. Symmetric with the in-app subtype's in-process
 *  semantics. */
const sendEmail = async (
  record: ConnectionRow,
  params: Record<string, unknown>,
  mailRpc: MailRpcDep | undefined,
  ctx?: ConnectionHandlerCtx,
): Promise<NotificationResponse<{ message_id: string; sent_at: number; thread_id?: string }>> => {
  if (!mailRpc) {
    throw new IngredientError(
      'NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED',
      `connection.notification: email subtype requires a mail rpc, none wired in this runtime (connection '${record.name}'). Pair to a server with mail accounts enrolled, or use slack / telegram / in-app.`,
      { name: record.name, subtype: 'email' },
    );
  }
  const config = readConfig(record);
  const senderInstance = config.sender_mail_instance;
  if (typeof senderInstance !== 'string' || senderInstance.length === 0) {
    throw new IngredientError(
      'CONNECTION_NOT_BOUND',
      `connection.notification: email connection '${record.name}' is missing 'sender_mail_instance' in config — re-enroll selecting a send-capable mail account.`,
      { name: record.name, subtype: 'email' },
    );
  }
  // Body resolution — `body` (mail-post wrapper) wins; `text` is the
  // fan-out fallback so the existing notification-send wrapper that
  // passes `text` keeps working when the channel resolves to email.
  const body = typeof params.body === 'string' && params.body.length > 0
    ? params.body
    : (typeof params.text === 'string' ? params.text : '');
  if (body.length === 0) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.notification: email subtype requires 'body' (or 'text') for connection '${record.name}'`,
      { name: record.name, subtype: 'email', field: 'body' },
    );
  }
  // Recipient resolution: explicit `to` (mail-post primary) wins;
  // `recipient` (notification override) next; `config.default_recipient`
  // last. All three coerce to a non-empty string[].
  const explicitTo = coerceRecipientList(params.to);
  const recipientOverride = coerceRecipientList(params.recipient);
  const defaultRecipient = coerceRecipientList(config.default_recipient);
  const to = explicitTo ?? recipientOverride ?? defaultRecipient;
  if (!to) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.notification: email subtype requires 'to' (mail-post) or 'recipient' override or config.default_recipient for connection '${record.name}'`,
      { name: record.name, subtype: 'email', field: 'to' },
    );
  }
  const subject = typeof params.subject === 'string' && params.subject.length > 0
    ? params.subject
    : (typeof params.title === 'string' && params.title.length > 0 ? params.title : '(no subject)');
  const isHtml = params.body_format === 'html';
  const sendArgs: MailRpcSendInput = {
    instance: senderInstance,
    to,
    subject,
    body_text: body,
    ...(isHtml ? { body_html: body } : {}),
  };
  const bytesOut = new TextEncoder().encode(JSON.stringify(sendArgs)).byteLength;
  const result = await mailRpc.send(sendArgs);
  ctx?.setBytes(0, bytesOut);
  return {
    status: 'ok' as const,
    result: {
      message_id: result.message_id,
      sent_at: result.sent_at,
      ...(result.thread_id !== undefined ? { thread_id: result.thread_id } : {}),
    },
    headers: undefined,
  };
};

/** Build the notification handler bound to per-runtime deps. The
 *  returned `ConnectionKindHandler` is registered at the boot site:
 *
 *    createConnectionAdapter({
 *      store,
 *      handlers: {
 *        api: createConnectionApiHandler({...}),
 *        mcp: createConnectionMcpHandler({...}),
 *        notification: createConnectionNotificationHandler({...}),
 *      },
 *      ...
 *    })
 *
 *  The handler is stateless — no client pool (nothing long-lived to
 *  reuse: HTTP is one-shot, in-app is one emit, no SMTP yet). All
 *  per-call state (auth, request body, vendor envelope) lives on the
 *  invocation closure. */
export const createConnectionNotificationHandler = (
  deps: ConnectionNotificationHandlerDeps,
): ConnectionKindHandler => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  // `now` is unused today (no idle-pool teardown like mcp); kept on
  // the deps surface so future per-subtype rate limiters / dedupe
  // windows can use it without re-touching the boot wiring.
  const _now = deps.now ?? (() => Date.now());
  void _now;

  return async (
    record: ConnectionRow,
    params: Record<string, unknown>,
    call: ResolvedCall,
    ctx?: ConnectionHandlerCtx,
  ): Promise<unknown> => {
    const subtype = getSubtype(record);

    // ────────────── input shape (text required at top level) ──────────────
    // Each subtype validates its own field set; the top-level `text`
    // check is just a fast-fail so a recipe authoring mistake doesn't
    // travel all the way through auth decode + URL build before
    // surfacing. D-127 P3.1 — email subtype uses `body` (mail-post) or
    // `text` (notification-send fan-out fallback) and validates inside
    // `sendEmail`, so the shared fast-fail skips email entirely.
    if (subtype !== 'email'
      && (typeof params.text !== 'string' || params.text.trim() === '')) {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.notification: 'text' is required (got ${typeof params.text})`,
        { slug: call.slug, name: record.name, subtype },
      );
    }

    // ────────────── subtype dispatch ──────────────
    switch (subtype) {
      case 'slack': {
        const auth = await deps.decodeAuth(record);
        return sendSlack(record, auth, params, call, fetchImpl, ctx);
      }
      case 'telegram': {
        const auth = await deps.decodeAuth(record);
        return sendTelegram(record, auth, params, call, fetchImpl, ctx);
      }
      case 'discord': {
        const auth = await deps.decodeAuth(record);
        return sendDiscord(record, auth, params, call, fetchImpl, ctx);
      }
      case 'in-app':
        return sendInApp(record, params, deps.emitInApp, ctx);
      case 'email':
        return sendEmail(record, params, deps.mailRpc, ctx);
      default: {
        // Fail-closed. A declared `NotificationSubtype` reaching this switch with
        // no send arm must NEVER fall through to an implicit `undefined` return —
        // that is the D-192 "green-but-mute" class (it enrolls, probes green, and
        // silently drops every send). WhatsApp lands here BY DESIGN: it declares
        // `roles.notification: false` (Meta's 24h window forbids unprompted sends),
        // so it has no notification-delivery arm and says so LOUDLY rather than
        // pretending to deliver. Any future subtype added to `NOTIFICATION_SUBTYPES`
        // without a send path is caught here at runtime and by the
        // `d-192-*-notification-dispatch` completeness test at build.
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.notification: subtype '${subtype}' has no notification-send path — it is not a notification-delivery channel`,
          { slug: call.slug, name: record.name, subtype },
        );
      }
    }
  };
};
