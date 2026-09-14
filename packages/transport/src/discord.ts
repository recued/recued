/** D-192 — the Discord raw transport.
 *
 *  Outbound: `POST /channels/{id}/messages` with a BYO bot token — a plain message
 *            (`send`) or an interactive prompt with message components
 *            (`sendPrompt`). `closePrompt` strips a prompt's buttons by PATCHing
 *            the message, exactly as Slack does with `chat.update`.
 *  Inbound: decodes Gateway `MESSAGE_CREATE` dispatches into user messages and
 *           already-authenticated INTERACTION payloads into button presses. The
 *           webhook path verifies Ed25519; the Gateway path is authenticated by
 *           the outbound bot session.
 *
 *  Two smaller differences from Slack, both leaf-local:
 *   - `Authorization: Bot <token>`, not `Bearer` — Discord reads `Bearer` as an
 *     OAuth2 user token and 401s a valid bot token sent that way.
 *   - The reply to an interaction is the HTTP RESPONSE to the webhook, not a
 *     separate API call, so there is no post-press ack leaf (Telegram needs one).
 *     That lives in the provider; the transport only decodes.
 */

import { decodeChoice, encodeChoice } from './callback.js';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentFilename, sendDiscordAttachment } from './attachments.js';
import { fitText } from './fit-text.js';
import {
  DEFAULT_TIMEOUT_MS,
  downloadToFile,
  classifyHttpError,
  retryAfterSeconds,
  patchJson,
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

/** Pinned API version — Discord supports several concurrently and deprecates
 *  loudly; pinning keeps payload shapes from moving under us. */
export const DISCORD_API_VERSION = 'v10';
const API_BASE = `https://discord.com/api/${DISCORD_API_VERSION}`;

/** Discord's documented component limits. */
export const DISCORD_BUTTONS_PER_ROW = 5;
export const DISCORD_MAX_ACTION_ROWS = 5;
export const DISCORD_MAX_BUTTONS = DISCORD_BUTTONS_PER_ROW * DISCORD_MAX_ACTION_ROWS;
export const DISCORD_CUSTOM_ID_MAX = 100;

/** Discord's message-content cap. Over it the API rejects the whole send with
 *  a 400, the remote channel throws, and `fanOutAsk` CATCHES it — so the
 *  message is lost silently (see `fit-text.ts`).
 *
 *  ⛔ Discord is a NOTIFY **+ APPROVE** channel, so the thing lost that way is
 *  an approval: the owner never learns a decision is waiting and the run sits
 *  paused on an answer nobody was asked for. Its siblings got `fitText` and
 *  this file did not — the option-count, button-label and custom-id caps below
 *  were all enforced while the BODY, the only part that grows with the held
 *  op's args, was not.
 *
 *  ⚠ TIGHTER THAN SLACK'S 3000 and less than half Telegram's 4096, so Discord
 *  is now the first channel a long approval would have disappeared from: a
 *  D-177 batch ask with a wide `args_preview` reaches ~4KB and clears this by
 *  a factor of two. */
const DISCORD_CONTENT_LIMIT = 2000;

/** What we actually trim to. The margin covers markup Discord counts that we
 *  did not author, the same accounting allowance Slack's budget makes. */
const DISCORD_TEXT_BUDGET = DISCORD_CONTENT_LIMIT - 60;

/** Fit any outbound Discord text to the content budget. Applied at EVERY send
 *  site, not just the composed ones — the close/edit path re-sends a body under
 *  the same cap. */
const fitDiscord = (text: string): string =>
  fitText(text, DISCORD_TEXT_BUDGET, 'Discord');
export const DISCORD_BUTTON_LABEL_MAX = 80;

/** Component type ids (`ACTION_ROW` / `BUTTON`) and the button style we render.
 *  `2` is Secondary — deliberately NOT Primary/Success/Danger: colouring an option
 *  would editorialise an approval Recued has no business editorialising. */
const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_STYLE_SECONDARY = 2;

/** Interaction types we care about. `PING` is Discord's endpoint validation, and
 *  `MESSAGE_COMPONENT` is a button press. Both are handled in the PROVIDER (they
 *  need an HTTP response); the transport only decodes the press. */
export const DISCORD_INTERACTION_PING = 1;
export const DISCORD_INTERACTION_MESSAGE_COMPONENT = 3;

export interface DiscordTransportOptions {
  downloadDir?: string;
  /** Inject for testing; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout; defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Compose the message body. Discord renders markdown, so a title is bolded inline
 *  and `link_url` is appended — Discord auto-embeds a bare URL. */
const composeDiscordText = (msg: {
  text: string;
  title?: string;
  link_url?: string;
}): string => {
  const head = msg.title ? `**${msg.title}**\n` : '';
  const tail = msg.link_url ? `\n${msg.link_url}` : '';
  return `${head}${msg.text}${tail}`;
};

interface DiscordMessageEnvelope {
  id?: string;
}

/** Discord's error envelope — `{ message, code, errors? }` on a non-2xx. Like
 *  Graph (and unlike Slack/Telegram, which answer `200 {ok:false}`) it reports
 *  faults by HTTP STATUS with the detail in the BODY, so lifting the message is the
 *  difference between "50035 Invalid Form Body: label too long" and a bare 400. */
const describeDiscordError = (json: unknown): string => {
  if (json === null || typeof json !== 'object') return 'unknown_error';
  const env = json as { message?: unknown; code?: unknown };
  const message = typeof env.message === 'string' ? env.message : null;
  const code = typeof env.code === 'number' ? env.code : null;
  if (message === null) return 'unknown_error';
  return code === null ? message : `${message} (code ${code})`;
};

const handleDiscordOutcome = (outcome: HttpPostOutcome): TransportSendResult => {
  if (!outcome.ok) {
    const kind =
      outcome.kind === 'http_error'
        ? classifyHttpError(outcome.status)
        : outcome.kind;
    const detail =
      outcome.kind === 'http_error'
        ? `${describeDiscordError(outcome.json)} [http ${outcome.status}]`
        : outcome.detail;
    const retryAfter = outcome.kind === 'http_error' ? Math.max(outcome.retry_after_ms ?? 0,
      retryAfterSeconds((outcome.json as { retry_after?: unknown } | undefined)?.retry_after) ?? 0) : 0;
    return { ok: false, error: { kind, detail: `Discord: ${detail}`,
      ...(retryAfter > 0 ? { retry_after_ms: retryAfter } : {}),
    } };
  }
  const env = (outcome.json ?? {}) as DiscordMessageEnvelope;
  return typeof env.id === 'string' && env.id.length > 0
    ? { ok: true, vendor_message_id: env.id }
    : { ok: true };
};

/** The channel id an interaction happened in. Flat on the envelope — Discord puts it
 *  at the top level for every interaction type, so a press and a (future) command
 *  read the same field. */
const interactionChannelId = (payload: unknown): string | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const id = (payload as Record<string, unknown>).channel_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

const extractDiscordMedia = (env: Record<string, unknown>): MediaRef[] => {
  if (!Array.isArray(env.attachments)) return [];
  const media: MediaRef[] = [];
  for (const candidate of env.attachments) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const attachment = candidate as Record<string, unknown>;
    const url = attachment.url;
    if (typeof url !== 'string' || url.length === 0) continue;
    const mime = typeof attachment.content_type === 'string'
      ? attachment.content_type
      : 'application/octet-stream';
    const size = typeof attachment.size === 'number' && Number.isFinite(attachment.size)
      ? Math.max(0, attachment.size)
      : 0;
    media.push({
      type: mime.split('/', 1)[0] || 'file',
      mime,
      size,
      remote_url: url,
      ...(typeof attachment.filename === 'string' ? { filename: attachment.filename } : {}),
      ...(typeof attachment.id === 'string' ? { remote_id: attachment.id } : {}),
    });
  }
  return media;
};

/** The interaction's own snowflake — unique per interaction, so it is the port's
 *  dedup key AND the declared flat `ingress.id_field`. */
export const discordInteractionId = (payload: unknown): string | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const id = (payload as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

/** The presser. A guild interaction nests the user under `member.user`; a DM puts it
 *  at `user`. Both, in that order — the guild shape is the common one. */
const interactionUserId = (payload: Record<string, unknown>): string | null => {
  const member = payload.member;
  if (member !== null && typeof member === 'object') {
    const user = (member as Record<string, unknown>).user;
    if (user !== null && typeof user === 'object') {
      const id = (user as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  const user = payload.user;
  if (user !== null && typeof user === 'object') {
    const id = (user as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
};

export const createDiscordTransport = (
  options: DiscordTransportOptions = {},
): InteractiveTransport => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers = (token: string): Record<string, string> => ({
    'Content-Type': 'application/json; charset=utf-8',
    // ⚠ `Bot`, not `Bearer` — see the file header.
    Authorization: `Bot ${token}`,
  });

  const send = async (message: OutboundMessage): Promise<TransportSendResult> => {
    const text = composeDiscordText(message);
    if (message.lossless && fitDiscord(text) !== text) return { ok: false,
      error: { kind: 'invalid_request', detail: 'Discord message exceeds the lossless text budget.' } };
    const outcome = await postJson(
      `${API_BASE}/channels/${encodeURIComponent(message.recipient)}/messages`,
      {
        headers: headers(message.token),
        body: JSON.stringify({ content: fitDiscord(text),
          ...(message.lossless ? { allowed_mentions: { parse: [], replied_user: false } } : {}),
          ...(message.delivery_id ? { nonce: message.delivery_id, enforce_nonce: true } : {}),
          ...(message.reply_to_message_id ? { message_reference: {
            message_id: message.reply_to_message_id, fail_if_not_exists: true,
          } } : {}),
        }),
        timeoutMs,
        fetchImpl,
      },
    );
    return handleDiscordOutcome(outcome);
  };

  const sendPrompt = async (prompt: OutboundPrompt): Promise<TransportSendResult> => {
    // Refuse cap violations up front rather than let Discord reject the whole send
    // with a `50035 Invalid Form Body`. Discord's caps are generous enough that none
    // of these should ever fire for a real approval — which is exactly why they must
    // be checked rather than assumed.
    if (prompt.options.length === 0 || prompt.options.length > DISCORD_MAX_BUTTONS) {
      return {
        ok: false,
        error: {
          kind: 'invalid_request',
          detail:
            `Discord: ${prompt.options.length} options — buttons cap at `
            + `${DISCORD_MAX_BUTTONS} (${DISCORD_MAX_ACTION_ROWS} rows of `
            + `${DISCORD_BUTTONS_PER_ROW})`,
        },
      };
    }
    const buttons: Array<{
      type: number;
      style: number;
      label: string;
      custom_id: string;
    }> = [];
    for (const opt of prompt.options) {
      // NEVER truncate a label: these prompts are approvals, and a clipped label can
      // change what the owner believes they are agreeing to.
      if (opt.label.length > DISCORD_BUTTON_LABEL_MAX) {
        return {
          ok: false,
          error: {
            kind: 'invalid_request',
            detail:
              `Discord: option "${opt.id}" label is ${opt.label.length} chars, cap `
              + `${DISCORD_BUTTON_LABEL_MAX} — shorten it rather than have it truncated`,
          },
        };
      }
      const custom_id = encodeChoice(prompt.correlation_id, opt.id);
      if (custom_id.length > DISCORD_CUSTOM_ID_MAX) {
        return {
          ok: false,
          error: {
            kind: 'invalid_request',
            detail:
              `Discord: callback payload for option "${opt.id}" is ${custom_id.length} `
              + `chars, cap ${DISCORD_CUSTOM_ID_MAX}`,
          },
        };
      }
      buttons.push({
        type: COMPONENT_BUTTON,
        style: BUTTON_STYLE_SECONDARY,
        label: opt.label,
        custom_id,
      });
    }
    // Chunk into action rows of 5 — the vendor's layout unit, not a choice of ours.
    const components: Array<{ type: number; components: typeof buttons }> = [];
    for (let i = 0; i < buttons.length; i += DISCORD_BUTTONS_PER_ROW) {
      components.push({
        type: COMPONENT_ACTION_ROW,
        components: buttons.slice(i, i + DISCORD_BUTTONS_PER_ROW),
      });
    }
    const outcome = await postJson(
      `${API_BASE}/channels/${encodeURIComponent(prompt.recipient)}/messages`,
      {
        headers: headers(prompt.token),
        body: JSON.stringify({
          content: fitDiscord(composeDiscordText(prompt)),
          components,
        }),
        timeoutMs,
        fetchImpl,
      },
    );
    return handleDiscordOutcome(outcome);
  };

  const closePrompt = async (ref: ClosePrompt): Promise<TransportSendResult> => {
    // Discord CAN edit — unlike WhatsApp. An explicit empty `components` array
    // strips every button while leaving the text, so a stale prompt cannot be
    // pressed after the question is answered. (Omitting the key would leave the
    // existing components in place; the empty array is what removes them.)
    const outcome = await patchJson(
      `${API_BASE}/channels/${encodeURIComponent(ref.recipient)}`
      + `/messages/${encodeURIComponent(ref.vendor_message_id)}`,
      {
        headers: headers(ref.token),
        body: JSON.stringify({ content: fitDiscord(ref.text), components: [] }),
        timeoutMs,
        fetchImpl,
      },
    );
    return handleDiscordOutcome(outcome);
  };

  const parseInbound = (payload: unknown): ParsedInbound | null => {
    // Gateway MESSAGE_CREATE data is the message object itself. Bot/system
    // messages are not owner turns. Content may be empty when attachments exist.
    if (payload === null || typeof payload !== 'object') return null;
    const env = payload as Record<string, unknown>;
    const author = env.author;
    if (author === null || typeof author !== 'object') return null;
    const a = author as Record<string, unknown>;
    if (a.bot === true || typeof a.id !== 'string' || a.id.length === 0) return null;
    const text = typeof env.content === 'string' ? env.content : '';
    const media = extractDiscordMedia(env);
    if (text.length === 0 && media.length === 0) return null;
    const result: ParsedInbound = { from: a.id, text };
    const reference = env.message_reference as { message_id?: unknown } | undefined;
    if (typeof reference?.message_id === 'string') result.reply_to_message_id = reference.message_id;
    if (typeof env.id === 'string' && env.id.length > 0) {
      result.vendor_message_id = env.id;
    }
    if (media.length > 0) result.media = media;
    return result;
  };

  const parseInboundChoice = (payload: unknown): ParsedInboundChoice | null => {
    // MESSAGE_COMPONENT: { id, type: 3, channel_id, data: { custom_id, component_type },
    //   member: { user: { id } } | user: { id }, message: { id } }.
    if (payload === null || typeof payload !== 'object') return null;
    const env = payload as Record<string, unknown>;
    if (env.type !== DISCORD_INTERACTION_MESSAGE_COMPONENT) return null;
    const data = env.data;
    if (data === null || typeof data !== 'object') return null;
    const custom_id = (data as Record<string, unknown>).custom_id;
    if (typeof custom_id !== 'string') return null;
    const choice = decodeChoice(custom_id);
    if (choice === null) return null;
    const from = interactionUserId(env);
    if (from === null) return null;
    const result: ParsedInboundChoice = {
      correlation_id: choice.correlation_id,
      option_id: choice.option_id,
      from,
    };
    // The prompt the press answers — Discord echoes the whole message back.
    const message = env.message;
    if (message !== null && typeof message === 'object') {
      const mid = (message as Record<string, unknown>).id;
      if (typeof mid === 'string' && mid.length > 0) result.vendor_message_id = mid;
    }
    return result;
  };

  const fetchMedia = async (ref: MediaRef): Promise<FetchedMedia> => {
    const url = new URL(ref.remote_url ?? '');
    if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
      || url.port || url.username || url.password || !url.pathname.startsWith('/attachments/')) {
      throw new Error('Invalid Discord attachment destination.');
    }
    const temp_path = join(options.downloadDir ?? tmpdir(), `discord-${randomUUID()}`);
    const result = await downloadToFile(url.href, { destPath: temp_path, fetchImpl, idleTimeoutMs: timeoutMs, redirect: 'error' });
    if (!result.ok) throw new Error('Discord attachment download failed.');
    return { temp_path, size: result.size, head_bytes: result.headBytes,
      filename: attachmentFilename(ref.filename, ref.remote_id ?? 'attachment'), mime_type: ref.mime,
    };
  };

  return {
    vendor: 'discord',
    send,
    sendAttachment: file => sendDiscordAttachment(file, { fetchImpl, timeoutMs: options.timeoutMs ?? 120_000 }),
    fetchMedia,
    parseInbound,
    // Gateway messages and interaction callbacks both carry flat `channel_id`.
    parseConversationId: interactionChannelId,
    parseCallbackConversationId: interactionChannelId,
    sendPrompt,
    parseInboundChoice,
    closePrompt,
  };
};
