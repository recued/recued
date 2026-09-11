/** D-160 P0 + D-158 P2 — the Telegram raw transport.
 *
 *  Outbound: `sendMessage` with a BYO `<bot_id>:<secret>` token — a
 *  plain message (`send`) or an interactive prompt with an inline
 *  keyboard (`sendPrompt`). `closePrompt` strips a prompt's keyboard via
 *  `editMessageText`.
 *  Inbound:  parses an already-verified Telegram bot `update` payload
 *            into a user message (`parseInbound`), or a `callback_query`
 *            update into an option selection (`parseInboundChoice`). The
 *            D-148 P9 webhook port has already verified the
 *            `X-Telegram-Bot-Api-Secret-Token` header.
 *
 *  Spec: D-160 § A.5; D-158 § P2 / A.4.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeChoice, encodeChoice } from './callback.js';
import { fitText } from './fit-text.js';
import {
  DEFAULT_TIMEOUT_MS,
  classifyHttpError,
  downloadToFile,
  postJson,
  type HttpPostOutcome,
} from './http.js';
import type {
  ClosePrompt,
  FetchedMedia,
  InteractiveTransport,
  MediaRef,
  OutboundMessage,
  OutboundPrompt,
  ParsedInbound,
  ParsedInboundChoice,
  TransportSendResult,
} from './types.js';

/** Telegram caps `callback_data` at 64 bytes. An encoded option payload
 *  over the cap cannot be sent — `sendPrompt` refuses it up front with
 *  an `invalid_request` rather than letting the vendor reject it. */
const CALLBACK_DATA_MAX_BYTES = 64;

export interface TelegramTransportOptions {
  /** Inject for testing; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout; defaults to `DEFAULT_TIMEOUT_MS`. For media
   *  downloads this is the IDLE timeout (no-progress abort). */
  timeoutMs?: number;
  /** Directory media downloads stream into before CAS ingest. Defaults to the
   *  OS temp dir; the backend wiring passes a server-local scratch dir. */
  downloadDir?: string;
}

/** Telegram's hard cap on `sendMessage` / `editMessageText` text: 4096
 *  characters. Over it the API 400s and the whole send is lost — and since
 *  the notification block catches a channel's failure, silently (see
 *  `fit-text.ts`). A D-177 batch ask with a wide `args_preview` can reach
 *  ~4KB, so this is reachable, not theoretical. */
const TELEGRAM_TEXT_LIMIT = 4096;

/** What we actually trim to. The margin exists because Telegram counts
 *  "after entities parsing" and we count UTF-16 units: the two agree for
 *  ordinary text, and the gap is cheap insurance against the cases where
 *  they might not (astral-plane characters in an arg value). Losing ~96
 *  characters of detail costs the reader nothing; losing the whole
 *  notification costs them the decision. */
const TELEGRAM_TEXT_BUDGET = TELEGRAM_TEXT_LIMIT - 96;

/** Fit any outbound Telegram text to the budget. Applied at every send
 *  site, not just the composed ones — `closePrompt` re-sends the message
 *  body through `editMessageText`, which is capped identically. */
const fitTelegram = (text: string): string =>
  fitText(text, TELEGRAM_TEXT_BUDGET, 'Telegram');

/** Compose the Telegram message body. A title prefixes `text` (Telegram
 *  has no inline bold in plain mode, so it sits on its own lines);
 *  `link_url` (plain messages only) is appended below.
 *
 *  Trimmed AFTER composition, so the budget covers what actually goes on
 *  the wire — and because the trim keeps both ends, the title survives at
 *  the head and the link at the tail. */
const rawTelegramText = (msg: {
  text: string;
  title?: string;
  link_url?: string;
}): string => {
  const head = msg.title ? `${msg.title}\n\n` : '';
  const tail = msg.link_url ? `\n${msg.link_url}` : '';
  return `${head}${msg.text}${tail}`;
};
const composeTelegramText = (msg: Parameters<typeof rawTelegramText>[0]): string => fitTelegram(rawTelegramText(msg));
/** A material approval review may never rely on the ordinary middle trim.
 * Reuse the exact composer/budget the live send path uses. */
export const telegramMessageFits = (msg: Parameters<typeof rawTelegramText>[0]): boolean =>
  composeTelegramText(msg) === rawTelegramText(msg);

interface TelegramEnvelope {
  ok?: boolean;
  description?: string;
  result?: { message_id?: number };
}

interface TelegramGetFileEnvelope {
  ok?: boolean;
  description?: string;
  result?: { file_path?: string };
}

/** Resolve a Telegram Bot API round-trip to a discriminated send
 *  result. Shared by `send` / `sendPrompt` / `closePrompt` — every Bot
 *  API method returns the same `{ ok, description, result }` envelope. */
const handleTelegramOutcome = (
  outcome: HttpPostOutcome,
): TransportSendResult => {
  if (!outcome.ok) {
    const kind =
      outcome.kind === 'http_error'
        ? classifyHttpError(outcome.status)
        : outcome.kind;
    return { ok: false, error: { kind, detail: `Telegram: ${outcome.detail}` } };
  }
  // Telegram always returns an `ok` boolean on a 200. Require an
  // explicit `ok === true` — a missing / non-true flag is a malformed
  // envelope, not a silent success.
  const env = (outcome.json ?? {}) as TelegramEnvelope;
  if (env.ok !== true) {
    return {
      ok: false,
      error: {
        kind: 'vendor_error',
        detail: `Telegram: ${env.description ?? 'unknown_error'}`,
      },
    };
  }
  const id = env.result?.message_id;
  return typeof id === 'number'
    ? { ok: true, vendor_message_id: String(id) }
    : { ok: true };
};

const numericSize = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
};

const sanitizeFilename = (name: string | undefined, fallback: string): string => {
  const base = name?.split(/[\\/]/).filter(Boolean).pop();
  const safe = base
    ?.replace(/[^A-Za-z0-9._+-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 128);
  return safe && safe.length > 0 ? safe : fallback;
};

const filenameFromPath = (path: string): string | undefined => {
  const segment = path.split('/').filter(Boolean).pop();
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const unpackMimeType = (contentType: string | undefined, fallback: string): string =>
  contentType?.split(';', 1)[0]?.trim() || fallback || 'application/octet-stream';

const fileId = (media: Record<string, unknown>): string | undefined =>
  typeof media.file_id === 'string' && media.file_id.length > 0
    ? media.file_id
    : undefined;

const telegramMediaRef = (
  type: string,
  media: Record<string, unknown>,
  fallbackMime: string,
): MediaRef | null => {
  const remote_id = fileId(media);
  if (remote_id === undefined) return null;
  return {
    type,
    mime:
      typeof media.mime_type === 'string' && media.mime_type.length > 0
        ? media.mime_type
        : fallbackMime,
    size: numericSize(media.file_size),
    remote_id,
  };
};

const photoArea = (photo: Record<string, unknown>): number => {
  const width = typeof photo.width === 'number' ? photo.width : 0;
  const height = typeof photo.height === 'number' ? photo.height : 0;
  return width * height;
};

const extractTelegramMedia = (m: Record<string, unknown>): MediaRef[] => {
  const media: MediaRef[] = [];
  if (Array.isArray(m.photo) && m.photo.length > 0) {
    let best: Record<string, unknown> | undefined;
    for (const item of m.photo) {
      if (item === null || typeof item !== 'object') continue;
      const photo = item as Record<string, unknown>;
      if (
        best === undefined
        || numericSize(photo.file_size) > numericSize(best.file_size)
        || (
          numericSize(photo.file_size) === numericSize(best.file_size)
          && photoArea(photo) > photoArea(best)
        )
      ) {
        best = photo;
      }
    }
    if (best !== undefined) {
      const ref = telegramMediaRef('photo', best, 'image/jpeg');
      if (ref !== null) media.push(ref);
    }
  }
  const document = m.document;
  if (document !== null && typeof document === 'object') {
    const ref = telegramMediaRef(
      'document',
      document as Record<string, unknown>,
      'application/octet-stream',
    );
    if (ref !== null) media.push(ref);
  }
  const voice = m.voice;
  if (voice !== null && typeof voice === 'object') {
    const ref = telegramMediaRef('voice', voice as Record<string, unknown>, 'audio/ogg');
    if (ref !== null) media.push(ref);
  }
  const audio = m.audio;
  if (audio !== null && typeof audio === 'object') {
    const ref = telegramMediaRef('audio', audio as Record<string, unknown>, 'audio/mpeg');
    if (ref !== null) media.push(ref);
  }
  return media;
};

export const createTelegramTransport = (
  options: TelegramTransportOptions = {},
): InteractiveTransport => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const downloadDir = options.downloadDir ?? tmpdir();

  /** POST a JSON body to a Bot API method — the token rides the URL. */
  const post = (
    method: string,
    payload: unknown,
    token: string,
  ): Promise<HttpPostOutcome> =>
    postJson(`https://api.telegram.org/bot${token}/${method}`, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      timeoutMs,
      fetchImpl,
    });

  const send = async (message: OutboundMessage): Promise<TransportSendResult> => {
    const outcome = await post(
      'sendMessage',
      { chat_id: message.recipient, text: composeTelegramText(message) },
      message.token,
    );
    return handleTelegramOutcome(outcome);
  };

  const sendPrompt = async (
    prompt: OutboundPrompt,
  ): Promise<TransportSendResult> => {
    // One option per inline-keyboard row — a vertical button list.
    // `callback_data` round-trips the correlation id + option id and
    // must fit Telegram's 64-byte cap; refuse a too-long payload up
    // front rather than let the vendor reject the whole send.
    const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const opt of prompt.options) {
      const callback_data = encodeChoice(prompt.correlation_id, opt.id);
      if (new TextEncoder().encode(callback_data).length > CALLBACK_DATA_MAX_BYTES) {
        return {
          ok: false,
          error: {
            kind: 'invalid_request',
            detail:
              `Telegram: callback payload for option "${opt.id}" exceeds `
              + `${CALLBACK_DATA_MAX_BYTES} bytes`,
          },
        };
      }
      inline_keyboard.push([{ text: opt.label, callback_data }]);
    }
    const outcome = await post(
      'sendMessage',
      {
        chat_id: prompt.recipient,
        text: composeTelegramText(prompt),
        reply_markup: { inline_keyboard },
      },
      prompt.token,
    );
    return handleTelegramOutcome(outcome);
  };

  const closePrompt = async (ref: ClosePrompt): Promise<TransportSendResult> => {
    // `editMessageText` with an explicit empty `inline_keyboard`
    // replaces the text AND strips the prompt's buttons. The empty
    // markup is sent explicitly — omitting `reply_markup` is not a
    // reliable way to drop an existing keyboard.
    const outcome = await post(
      'editMessageText',
      {
        chat_id: ref.recipient,
        message_id: Number(ref.vendor_message_id),
        // `editMessageText` is capped exactly like `sendMessage`, and this
        // text does NOT come through `composeTelegramText` — it is the
        // caller's pre-composed close body. An unfitted edit 400s and the
        // answered prompt keeps its live buttons.
        text: fitTelegram(ref.text),
        reply_markup: { inline_keyboard: [] },
      },
      ref.token,
    );
    return handleTelegramOutcome(outcome);
  };

  const fetchMedia = async (ref: MediaRef, token: string): Promise<FetchedMedia> => {
    if (ref.remote_id === undefined) {
      throw new Error('Telegram media reference is missing file_id');
    }
    const info = await post('getFile', { file_id: ref.remote_id }, token);
    if (!info.ok) {
      throw new Error(`Telegram getFile failed: ${info.detail}`);
    }
    const env = (info.json ?? {}) as TelegramGetFileEnvelope;
    if (env.ok !== true || typeof env.result?.file_path !== 'string') {
      throw new Error(`Telegram getFile failed: ${env.description ?? 'missing file_path'}`);
    }
    const filePath = env.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    // Stream to a temp file (never buffer whole in memory); the host is pinned
    // to api.telegram.org and `file_path` is Telegram-generated.
    const destPath = join(downloadDir, `telegram-media-${randomUUID()}`);
    const dl = await downloadToFile(downloadUrl, {
      destPath,
      idleTimeoutMs: timeoutMs,
      fetchImpl,
    });
    if (!dl.ok) {
      throw new Error(`Telegram media download failed: ${dl.detail}`);
    }
    return {
      temp_path: destPath,
      size: dl.size,
      head_bytes: dl.headBytes,
      filename: sanitizeFilename(filenameFromPath(filePath), ref.remote_id),
      mime_type: unpackMimeType(dl.contentType, ref.mime),
    };
  };

  const parseInbound = (payload: unknown): ParsedInbound | null => {
    // Telegram update: { update_id, message: { message_id, text,
    // from: { id, is_bot }, chat: { id }, ... } }. A user turn has
    // text or media and a non-bot `message.from.id`.
    if (payload === null || typeof payload !== 'object') return null;
    const env = payload as Record<string, unknown>;
    const message = env.message;
    if (message === null || typeof message !== 'object') return null;
    const m = message as Record<string, unknown>;
    const from = m.from;
    if (from === null || typeof from !== 'object') return null;
    const f = from as Record<string, unknown>;
    if (f.is_bot === true) return null;
    if (typeof f.id !== 'number' && typeof f.id !== 'string') return null;
    const text =
      typeof m.text === 'string'
        ? m.text
        : typeof m.caption === 'string'
          ? m.caption
          : '';
    const media = extractTelegramMedia(m);
    if (text.length === 0 && media.length === 0) return null;
    const result: ParsedInbound = { from: String(f.id), text };
    if (typeof m.message_id === 'number') {
      result.vendor_message_id = String(m.message_id);
    }
    if (media.length > 0) result.media = media;
    return result;
  };

  const parseInboundChoice = (
    payload: unknown,
  ): ParsedInboundChoice | null => {
    // Telegram update: { update_id, callback_query: { id, data,
    //   from: { id, is_bot }, message: { message_id, ... } } }.
    if (payload === null || typeof payload !== 'object') return null;
    const env = payload as Record<string, unknown>;
    const callbackQuery = env.callback_query;
    if (callbackQuery === null || typeof callbackQuery !== 'object') return null;
    const q = callbackQuery as Record<string, unknown>;
    if (typeof q.data !== 'string') return null;
    const choice = decodeChoice(q.data);
    if (choice === null) return null;
    const from = q.from;
    if (from === null || typeof from !== 'object') return null;
    const f = from as Record<string, unknown>;
    if (f.is_bot === true) return null;
    if (typeof f.id !== 'number' && typeof f.id !== 'string') return null;
    const result: ParsedInboundChoice = {
      correlation_id: choice.correlation_id,
      option_id: choice.option_id,
      from: String(f.id),
    };
    const message = q.message;
    if (message !== null && typeof message === 'object') {
      const mid = (message as Record<string, unknown>).message_id;
      if (typeof mid === 'number') result.vendor_message_id = String(mid);
    }
    return result;
  };

  const parseConversationId = (payload: unknown): string | null => {
    // Telegram message update — the bound conversation is `message.chat.id`
    // (numeric or string; coerced to string).
    if (payload === null || typeof payload !== 'object') return null;
    const env = payload as Record<string, unknown>;
    const message = env.message;
    if (message === null || typeof message !== 'object') return null;
    const chat = (message as Record<string, unknown>).chat;
    if (chat === null || typeof chat !== 'object') return null;
    const id = (chat as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0) return id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    return null;
  };

  const parseCallbackConversationId = (payload: unknown): string | null => {
    // Telegram `callback_query` — the conversation is
    // `callback_query.message.chat.id`.
    if (payload === null || typeof payload !== 'object') return null;
    const env = payload as Record<string, unknown>;
    const cq = env.callback_query;
    if (cq === null || typeof cq !== 'object') return null;
    const message = (cq as Record<string, unknown>).message;
    if (message === null || typeof message !== 'object') return null;
    const chat = (message as Record<string, unknown>).chat;
    if (chat === null || typeof chat !== 'object') return null;
    const id = (chat as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0) return id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    return null;
  };

  return {
    vendor: 'telegram',
    send,
    parseInbound,
    parseConversationId,
    fetchMedia,
    sendPrompt,
    parseInboundChoice,
    parseCallbackConversationId,
    closePrompt,
  };
};
