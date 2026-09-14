/** D-160 P0 + D-158 P2 — the Slack raw transport.
 *
 *  Outbound: `chat.postMessage` with a BYO `xoxb-…` bot token — a plain
 *  message (`send`) or an interactive prompt with option buttons
 *  (`sendPrompt`, a Block Kit `actions` block). `closePrompt` strips a
 *  prompt's buttons via `chat.update`.
 *  Inbound:  parses an already-verified Slack Events API `event_callback`
 *            payload into a user message (`parseInbound`), or a Block Kit
 *            `block_actions` payload into an option selection
 *            (`parseInboundChoice`). The D-148 P9 webhook port has
 *            already done the HMAC verification.
 *
 *  Spec: D-160 § A.5; D-158 § P2 / A.4.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeChoice, encodeChoice } from './callback.js';
import { attachmentFilename, sendSlackAttachment } from './attachments.js';
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

const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const SLACK_UPDATE_URL = 'https://slack.com/api/chat.update';
const SLACK_FILES_INFO_URL = 'https://slack.com/api/files.info';

export interface SlackTransportOptions {
  /** Inject for testing; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout; defaults to `DEFAULT_TIMEOUT_MS`. For media
   *  downloads this is the IDLE timeout (no-progress abort), so a large
   *  progressing transfer is never killed. */
  timeoutMs?: number;
  /** Directory media downloads stream into before CAS ingest. Defaults to the
   *  OS temp dir; the backend wiring passes a server-local scratch dir. */
  downloadDir?: string;
}

/** Slack's cap on a Block Kit `section` block's text: 3000 characters.
 *  This — not the far looser 40k on the `text` argument — is the binding
 *  constraint, because every message here carries its body in a section
 *  block. Over it Slack rejects the whole `chat.postMessage` with
 *  `invalid_blocks`, and the notification block catches the failure, so the
 *  send is lost silently (see `fit-text.ts`).
 *
 *  Worth stating plainly: this is TIGHTER than Telegram's 4096, so Slack is
 *  the first channel a long approval ask disappears from — a D-177 batch ask
 *  with a wide `args_preview` reaches ~4KB and clears this cap by a mile. */
const SLACK_SECTION_TEXT_LIMIT = 3000;

/** What we actually trim to. The margin covers Slack counting mrkdwn markup
 *  we did not author (an arg value's own `*`/`_` are characters either way,
 *  but the accounting is theirs, not ours). */
const SLACK_TEXT_BUDGET = SLACK_SECTION_TEXT_LIMIT - 100;

/** Fit any outbound Slack text to the section budget. Applied at every send
 *  site, not just the composed ones — `closePrompt` re-sends the body in a
 *  section block via `chat.update`, under the same cap. */
const fitSlack = (text: string): string =>
  fitText(text, SLACK_TEXT_BUDGET, 'Slack');

/** Escape text so Slack renders it as WHAT IT IS rather than as markup.
 *
 *  Slack is the only channel that interprets a message body: the section
 *  block declares `mrkdwn`, so Slack parses it. Every other surface treats
 *  the same bytes as data — the webclient and the ask-landing page escape
 *  it into HTML, email escapes it, Telegram sends it with no `parse_mode`.
 *  Slack alone was handed message text containing arbitrary agent-authored
 *  argument values and told to read it as markup, which changed what the
 *  owner saw on the surface whose whole job is showing them the truth:
 *
 *    - `to: Dana <dana@northwind.example>` — an ordinary mail-header shape,
 *      no adversary required. Slack consumes the angle brackets and the
 *      recipient renders mangled or auto-linked.
 *    - `<https://evil.example|https://recued.com/invoice>` — displays as a
 *      link reading `recued.com/invoice` that points at `evil.example`. An
 *      agent drafting mail from content it read inbound is exactly how a
 *      value like this arrives.
 *    - `<!channel>` in any argument would ping the whole workspace.
 *
 *  These are Slack's three documented escapes and the ONLY ones it defines
 *  (`&` first, or it would double-escape the `&` in its own replacements).
 *  Applies to CONTENT only — the `*bold*` around the title below is markup
 *  this transport authors deliberately, so it is composed AFTER escaping.
 *
 *  Not covered, by Slack's own design: `*` / `_` / `~` / `` ` `` have no
 *  escape sequence, so a value containing them still renders emphasized
 *  (the characters vanish, the text styles). That is a display divergence,
 *  not a disguise — the remaining fix would be a `plain_text` block, which
 *  costs the bold title. Escaping kills both of the harms above and the
 *  ordinary-value bug; emphasis stays cosmetic. */
const escapeSlackText = (text: string): string =>
  text
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;');

/** Escape a body, then fit it. ORDER IS LOAD-BEARING both ways round:
 *
 *   - Escape BEFORE fit, because escaping EXPANDS (`<` → `&lt;`). Fitting
 *     first would hand the budget a string that then grew back over the
 *     cap — and an over-cap send is the silent drop `fit-text.ts` exists
 *     to prevent.
 *   - The fit's cut can slice through an entity (`&amp;` → `&am`), which
 *     renders as stray text at the boundary. It cannot forge MARKUP: every
 *     `<` and `>` is already gone by then, so there is nothing for a cut to
 *     reintroduce. Cosmetic at worst, and only ever at the cut. */
const slackBody = (text: string): string => fitSlack(escapeSlackText(text));

/** Compose the Slack message body. A title prefixes `text` in bold so
 *  notification-preview clients without Block Kit still see the heading;
 *  `link_url` (plain messages only) is appended on its own line.
 *
 *  Each PART is escaped, then the parts are composed with the markup this
 *  transport authors — the `*` around the title is ours and must survive,
 *  which is exactly why escaping cannot be a single pass over the composed
 *  string. Trimmed last, so the budget covers what actually goes on the
 *  wire; the trim keeps both ends, so the bold title survives at the head
 *  and the link at the tail. */
const composeSlackText = (msg: {
  text: string;
  title?: string;
  link_url?: string;
}): string => {
  const head = msg.title ? `*${escapeSlackText(msg.title)}*\n` : '';
  // The link is escaped too: it is a caller-supplied value like any other,
  // and Slack unescapes entities when it auto-links, so `?a=1&amp;b=2`
  // resolves back to `?a=1&b=2` in the href.
  const tail = msg.link_url ? `\n${escapeSlackText(msg.link_url)}` : '';
  return fitSlack(`${head}${escapeSlackText(msg.text)}${tail}`);
};

interface SlackEnvelope {
  ok?: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

interface SlackFileInfoEnvelope {
  ok?: boolean;
  error?: string;
  file?: {
    id?: string;
    name?: string;
    mimetype?: string;
    size?: number;
    url_private?: string;
    url_private_download?: string;
  };
}

/** Resolve an `https://slack.com/api/*` round-trip to a discriminated
 *  send result. Shared by `send` / `sendPrompt` / `closePrompt` — every
 *  Slack API method returns the same `{ ok, error, ts }` envelope. */
const handleSlackOutcome = (outcome: HttpPostOutcome): TransportSendResult => {
  if (!outcome.ok) {
    const kind =
      outcome.kind === 'http_error'
        ? classifyHttpError(outcome.status)
        : outcome.kind;
    return { ok: false, error: { kind, detail: `Slack: ${outcome.detail}`,
      ...(outcome.kind === 'http_error' && outcome.retry_after_ms !== undefined ? { retry_after_ms: outcome.retry_after_ms } : {}),
    } };
  }
  // Slack always returns an `ok` boolean on a 200. Require an explicit
  // `ok === true` — a missing / non-true flag is a malformed envelope,
  // not a silent success.
  const env = (outcome.json ?? {}) as SlackEnvelope;
  if (env.ok !== true) {
    return {
      ok: false,
      error: { kind: env.error === 'ratelimited' ? 'rate_limited' : 'vendor_error', detail: `Slack: ${env.error ?? 'unknown_error'}` },
    };
  }
  return env.ts !== undefined ? { ok: true, vendor_message_id: env.ts } : { ok: true };
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

const mediaTypeFromMime = (mime: string): string => {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
};

const sanitizeFilename = (name: string | undefined, fallback: string): string => {
  const base = name?.split(/[\\/]/).filter(Boolean).pop();
  const safe = base
    ?.replace(/[^A-Za-z0-9._+-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 128);
  return safe && safe.length > 0 ? safe : fallback;
};

const filenameFromUrl = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).pop();
    return segment !== undefined ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
};

const extractSlackMediaRef = (file: unknown): MediaRef | null => {
  if (file === null || typeof file !== 'object') return null;
  const f = file as Record<string, unknown>;
  const remote_id = typeof f.id === 'string' && f.id.length > 0 ? f.id : undefined;
  const remote_url =
    typeof f.url_private_download === 'string' && f.url_private_download.length > 0
      ? f.url_private_download
      : typeof f.url_private === 'string' && f.url_private.length > 0
        ? f.url_private
        : undefined;
  if (remote_id === undefined && remote_url === undefined) return null;
  const mime =
    typeof f.mimetype === 'string' && f.mimetype.length > 0
      ? f.mimetype
      : 'application/octet-stream';
  const declaredType =
    typeof f.filetype === 'string' && f.filetype.length > 0
      ? f.filetype
      : typeof f.mode === 'string' && f.mode.length > 0
        ? f.mode
        : mediaTypeFromMime(mime);
  const ref: MediaRef = {
    type: declaredType,
    mime,
    size: numericSize(f.size),
  };
  if (remote_id !== undefined) ref.remote_id = remote_id;
  if (remote_url !== undefined) ref.remote_url = remote_url;
  return ref;
};

const extractSlackMedia = (ev: Record<string, unknown>): MediaRef[] => {
  const media: MediaRef[] = [];
  const files = ev.files;
  if (Array.isArray(files)) {
    for (const file of files) {
      const ref = extractSlackMediaRef(file);
      if (ref !== null) media.push(ref);
    }
  }
  const singleFile = extractSlackMediaRef(ev.file);
  if (singleFile !== null) media.push(singleFile);
  return media;
};

const unpackMimeType = (contentType: string | undefined, fallback: string): string =>
  contentType?.split(';', 1)[0]?.trim() || fallback || 'application/octet-stream';

export const createSlackTransport = (
  options: SlackTransportOptions = {},
): InteractiveTransport => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const downloadDir = options.downloadDir ?? tmpdir();

  /** POST a JSON body to a Slack API method with the bot-token header. */
  const post = (url: string, payload: unknown, token: string): Promise<HttpPostOutcome> =>
    postJson(url, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      timeoutMs,
      fetchImpl,
    });

  const send = async (message: OutboundMessage): Promise<TransportSendResult> => {
    const plain = `${message.title ? `${message.title}\n\n` : ''}${message.text}${message.link_url ? `\n${message.link_url}` : ''}`;
    if (message.lossless && plain.length > 2800) return { ok: false,
      error: { kind: 'invalid_request', detail: 'Slack message exceeds the lossless text budget.' } };
    const outcome = await post(
      SLACK_POST_MESSAGE_URL,
      { channel: message.recipient, text: message.lossless ? plain : composeSlackText(message),
        ...(message.thread_id ? { thread_ts: message.thread_id } : {}),
        ...(message.lossless ? { mrkdwn: false, parse: 'none', link_names: false,
          unfurl_links: false, unfurl_media: false,
          blocks: [{ type: 'section', text: { type: 'plain_text', text: plain, emoji: false } }],
        } : {}),
      },
      message.token,
    );
    return handleSlackOutcome(outcome);
  };

  const sendPrompt = async (
    prompt: OutboundPrompt,
  ): Promise<TransportSendResult> => {
    const messageText = composeSlackText(prompt);
    // One button per option; `value` round-trips the correlation id +
    // option id, `action_id` is unique per button within the message.
    // Slack's `value` cap is 2,000 bytes — never a constraint here.
    const elements = prompt.options.map((opt, i) => ({
      type: 'button',
      text: { type: 'plain_text', text: opt.label },
      action_id: `recued_choice_${i}`,
      value: encodeChoice(prompt.correlation_id, opt.id),
    }));
    const outcome = await post(
      SLACK_POST_MESSAGE_URL,
      {
        channel: prompt.recipient,
        // `text` is the notification-preview fallback for the blocks.
        text: messageText,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: messageText } },
          // A stable `block_id` (the correlation id) — Slack best
          // practice; the press is correlated by the button `value`.
          { type: 'actions', block_id: prompt.correlation_id, elements },
        ],
      },
      prompt.token,
    );
    return handleSlackOutcome(outcome);
  };

  const closePrompt = async (ref: ClosePrompt): Promise<TransportSendResult> => {
    // `chat.update` replaces the message blocks — a section with no
    // `actions` block leaves the text but strips every button.
    const closeText = slackBody(ref.text);
    const outcome = await post(
      SLACK_UPDATE_URL,
      {
        channel: ref.recipient,
        ts: ref.vendor_message_id,
        // Escaped + fitted here too: this text does NOT come through
        // `composeSlackText` — it is the caller's pre-composed close body,
        // and it goes back into a `mrkdwn` section under the same 3000 cap.
        // Unfitted, the update is rejected and the answered prompt keeps its
        // live buttons; unescaped, the closed message reads differently from
        // the one the owner just answered.
        text: closeText,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: closeText } }],
      },
      ref.token,
    );
    return handleSlackOutcome(outcome);
  };

  const fetchMedia = async (ref: MediaRef, token: string): Promise<FetchedMedia> => {
    let remoteUrl = ref.remote_url;
    let filename: string | undefined;
    let mime = ref.mime;
    if (ref.remote_id !== undefined) {
      const info = await post(SLACK_FILES_INFO_URL, { file: ref.remote_id }, token);
      if (!info.ok) {
        throw new Error(`Slack files.info failed: ${info.detail}`);
      }
      const env = (info.json ?? {}) as SlackFileInfoEnvelope;
      if (env.ok !== true) {
        throw new Error(`Slack files.info failed: ${env.error ?? 'unknown_error'}`);
      }
      filename = env.file?.name;
      mime = env.file?.mimetype ?? mime;
      remoteUrl = env.file?.url_private_download ?? env.file?.url_private ?? remoteUrl;
    }
    if (remoteUrl === undefined) {
      throw new Error('Slack media reference is missing url_private');
    }
    // Stream the download straight to a temp file — never buffer the whole
    // (potentially large) media in memory. The caller hands `temp_path` to
    // BlobStore.putFile (also streaming) then deletes it.
    const destPath = join(downloadDir, `slack-media-${randomUUID()}`);
    const dl = await downloadToFile(remoteUrl, {
      headers: { Authorization: `Bearer ${token}` },
      destPath,
      idleTimeoutMs: timeoutMs,
      fetchImpl,
    });
    if (!dl.ok) {
      throw new Error(`Slack media download failed: ${dl.detail}`);
    }
    const fallbackName = `${ref.remote_id ?? 'slack-media'}`;
    return {
      temp_path: destPath,
      size: dl.size,
      head_bytes: dl.headBytes,
      filename: filename ? attachmentFilename(filename, fallbackName) : sanitizeFilename(filenameFromUrl(remoteUrl), fallbackName),
      mime_type: unpackMimeType(dl.contentType, mime),
    };
  };

  const parseInbound = (payload: unknown): ParsedInbound | null => {
    // Slack Events API `event_callback`: { type, event: { type, text,
    // user, ts, bot_id?, subtype? } }. A user turn is `event.type ===
    // 'message'` with no `bot_id` and no `subtype` (subtype tags edits,
    // joins, bot posts — none are user turns).
    if (payload === null || typeof payload !== 'object') return null;
    const env = payload as Record<string, unknown>;
    if (env.type !== 'event_callback') return null;
    const event = env.event;
    if (event === null || typeof event !== 'object') return null;
    const ev = event as Record<string, unknown>;
    if (ev.type !== 'message') return null;
    if (typeof ev.bot_id === 'string') return null;
    if (typeof ev.subtype === 'string' && ev.subtype !== 'file_share') return null;
    if (typeof ev.user !== 'string' || ev.user.length === 0) return null;
    const text = typeof ev.text === 'string' ? ev.text : '';
    const media = extractSlackMedia(ev);
    if (text.length === 0 && media.length === 0) return null;
    const result: ParsedInbound = { from: ev.user, text };
    if (typeof ev.thread_ts === 'string') {
      result.thread_id = ev.thread_ts;
      result.reply_to_message_id = ev.thread_ts;
    }
    if (typeof ev.ts === 'string') result.vendor_message_id = ev.ts;
    if (media.length > 0) result.media = media;
    return result;
  };

  const parseInboundChoice = (
    payload: unknown,
  ): ParsedInboundChoice | null => {
    // Slack interactivity `block_actions`: { type: 'block_actions',
    //   user: { id }, actions: [ { type: 'button', value, ... } ],
    //   container?: { message_ts }, message?: { ts } }.
    if (payload === null || typeof payload !== 'object') return null;
    const env = payload as Record<string, unknown>;
    if (env.type !== 'block_actions') return null;
    const actions = env.actions;
    if (!Array.isArray(actions) || actions.length === 0) return null;
    const action = actions[0];
    if (action === null || typeof action !== 'object') return null;
    const value = (action as Record<string, unknown>).value;
    if (typeof value !== 'string') return null;
    const choice = decodeChoice(value);
    if (choice === null) return null;
    const user = env.user;
    if (user === null || typeof user !== 'object') return null;
    const uid = (user as Record<string, unknown>).id;
    if (typeof uid !== 'string' || uid.length === 0) return null;
    const result: ParsedInboundChoice = {
      correlation_id: choice.correlation_id,
      option_id: choice.option_id,
      from: uid,
    };
    // The prompt the press answers — `container.message_ts` is the
    // canonical field; `message.ts` is the fallback.
    const container = env.container;
    if (container !== null && typeof container === 'object') {
      const mts = (container as Record<string, unknown>).message_ts;
      if (typeof mts === 'string') result.vendor_message_id = mts;
    }
    if (result.vendor_message_id === undefined) {
      const message = env.message;
      if (message !== null && typeof message === 'object') {
        const ts = (message as Record<string, unknown>).ts;
        if (typeof ts === 'string') result.vendor_message_id = ts;
      }
    }
    return result;
  };

  const parseConversationId = (payload: unknown): string | null => {
    // Slack Events API `event_callback` — the bound conversation is
    // `event.channel`.
    if (payload === null || typeof payload !== 'object') return null;
    const env = payload as Record<string, unknown>;
    const event = env.event;
    if (event === null || typeof event !== 'object') return null;
    const channel = (event as Record<string, unknown>).channel;
    return typeof channel === 'string' && channel.length > 0 ? channel : null;
  };

  const parseCallbackConversationId = (payload: unknown): string | null => {
    // Slack `block_actions` callback — `container.channel_id` is canonical,
    // `channel.id` the fallback.
    if (payload === null || typeof payload !== 'object') return null;
    const env = payload as Record<string, unknown>;
    const container = env.container;
    if (container !== null && typeof container === 'object') {
      const cid = (container as Record<string, unknown>).channel_id;
      if (typeof cid === 'string' && cid.length > 0) return cid;
    }
    const channel = env.channel;
    if (channel !== null && typeof channel === 'object') {
      const cid = (channel as Record<string, unknown>).id;
      if (typeof cid === 'string' && cid.length > 0) return cid;
    }
    return null;
  };

  return {
    vendor: 'slack',
    send,
    sendAttachment: file => sendSlackAttachment(file, { fetchImpl, timeoutMs: options.timeoutMs ?? 120_000 }),
    parseInbound,
    parseConversationId,
    fetchMedia,
    sendPrompt,
    parseInboundChoice,
    parseCallbackConversationId,
    closePrompt,
  };
};
