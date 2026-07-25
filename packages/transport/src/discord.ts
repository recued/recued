/** D-192 — the Discord raw transport.
 *
 *  Outbound: `POST /channels/{id}/messages` with a BYO bot token — a plain message
 *            (`send`) or an interactive prompt with message components
 *            (`sendPrompt`). `closePrompt` strips a prompt's buttons by PATCHing
 *            the message, exactly as Slack does with `chat.update`.
 *  Inbound:  decodes an already-verified INTERACTION payload into a button press
 *            (`parseInboundChoice`). The D-148 P9 webhook port has already done the
 *            Ed25519 verification.
 *
 *  ⚠ **`parseInbound` ALWAYS returns null, and that is the honest shape of this
 *  vendor, not a stub.** Discord's Interactions endpoint delivers button presses and
 *  slash commands — it does NOT deliver plain user messages. Those exist only on the
 *  Gateway, a persistent WebSocket (`MESSENGER_INGRESS_MODES.socket`, declared and
 *  unimplemented). So Discord ships as a **notify + approve** channel: Recued can
 *  message you and you can press its buttons, but you cannot talk back in free text.
 *
 *  The nice part is that this needs no special case anywhere. The messenger turn and
 *  the commitment funnel both gate on `parseInbound`, so returning null simply means
 *  they never fire — no shared-code branch, no capability flag, no pretending. What a
 *  vendor CANNOT do is expressed by the same seam that says what it CAN.
 *
 *  Two smaller differences from Slack, both leaf-local:
 *   - `Authorization: Bot <token>`, not `Bearer` — Discord reads `Bearer` as an
 *     OAuth2 user token and 401s a valid bot token sent that way.
 *   - The reply to an interaction is the HTTP RESPONSE to the webhook, not a
 *     separate API call, so there is no post-press ack leaf (Telegram needs one).
 *     That lives in the provider; the transport only decodes.
 */

import { decodeChoice, encodeChoice } from './callback.js';
import {
  DEFAULT_TIMEOUT_MS,
  classifyHttpError,
  patchJson,
  postJson,
  type HttpPostOutcome,
} from './http.js';
import type {
  ClosePrompt,
  InteractiveTransport,
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
    return { ok: false, error: { kind, detail: `Discord: ${detail}` } };
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
    const outcome = await postJson(
      `${API_BASE}/channels/${encodeURIComponent(message.recipient)}/messages`,
      {
        headers: headers(message.token),
        body: JSON.stringify({ content: composeDiscordText(message) }),
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
          content: composeDiscordText(prompt),
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
        body: JSON.stringify({ content: ref.text, components: [] }),
        timeoutMs,
        fetchImpl,
      },
    );
    return handleDiscordOutcome(outcome);
  };

  /** ⚠ ALWAYS null — see the file header. Discord's Interactions endpoint carries no
   *  plain user messages; those live on the Gateway (`socket` ingress,
   *  unimplemented). The messenger turn and the commitment funnel both gate on this,
   *  so they correctly never fire, and Discord is a notify + approve channel. This is
   *  the vendor's honest shape expressed through the ordinary seam — not a stub to be
   *  "finished" without first building the Gateway. */
  const parseInbound = (_payload: unknown): ParsedInbound | null => null;

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

  return {
    vendor: 'discord',
    send,
    parseInbound,
    // Both extractors read the same flat `channel_id`: an interaction is the ONLY
    // inbound shape this vendor has, so a "message" and a "callback" are the same
    // envelope. That identity is Discord's, not a shortcut.
    parseConversationId: interactionChannelId,
    parseCallbackConversationId: interactionChannelId,
    sendPrompt,
    parseInboundChoice,
    closePrompt,
  };
};
