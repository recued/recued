/** D-192 CORE #6 make-live — the WhatsApp Cloud API raw transport.
 *
 *  Outbound: `POST /{PHONE_NUMBER_ID}/messages` on the Graph API with a BYO
 *            bearer access token — a plain message (`send`) or an interactive
 *            prompt with reply buttons (`sendPrompt`).
 *  Inbound:  parses an already-verified Meta webhook envelope into a user
 *            message (`parseInbound`) or a button press (`parseInboundChoice`).
 *            The D-148 P9 webhook port has already done the
 *            `X-Hub-Signature-256` HMAC verification over the raw bytes.
 *
 *  THREE things make WhatsApp different from Slack / Telegram. Each is a real
 *  vendor fact, and each is contained HERE rather than leaking into a shared
 *  composer:
 *
 *  1. **The send URL is account-scoped.** Slack's URL is fixed and Telegram's
 *     carries the token, so `OutboundMessage { recipient, text, token }` was
 *     always enough. WhatsApp needs the BUSINESS phone-number id (it is the URL
 *     path) *and* the USER's `wa_id` (it is the body's `to`). Rather than widen
 *     the shared transport contract for one vendor, the conversation ADDRESS is
 *     the pair — which is what a WhatsApp conversation genuinely is. See
 *     `encodeWhatsAppAddress`.
 *
 *  2. **There is no message-edit or delete API.** `closePrompt` therefore cannot
 *     strip a delivered prompt's buttons. It returns `invalid_request`, which is
 *     safe by construction: `closeAsk` discards the result and never throws, and
 *     a stale press is already a no-op (the block's first-answer-wins dedup) —
 *     the same property the restart path relies on. WhatsApp also disables a
 *     reply button client-side for whoever taps it. We do NOT paper over this by
 *     posting a follow-up "resolved" message: `closePrompt` means *edit that
 *     message*, a new message is a different act, and WhatsApp bills per message.
 *
 *  3. **Hard vendor caps on interactive prompts** — 3 buttons, a 20-char label, a
 *     1024-char body, a 256-char button id. All are refused UP FRONT with
 *     `invalid_request` rather than letting Meta reject the whole send (the
 *     Telegram `callback_data` precedent). A label is never silently truncated:
 *     these prompts are approvals, and a clipped label can change what the user
 *     thinks they are agreeing to.
 *
 *  Spec: docs/d-160-spec.md § A.5; docs/d-158-spec.md § P2 / A.4.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeChoice, encodeChoice } from './callback.js';
import {
  DEFAULT_TIMEOUT_MS,
  classifyHttpError,
  downloadToFile,
  getJson,
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

/** Pinned Graph API version. Meta versions are supported ~2 years; pinning keeps
 *  a silent server-side upgrade from changing payload shapes under us. */
export const WHATSAPP_GRAPH_VERSION = 'v22.0';
const GRAPH_BASE = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}`;

/** Meta's documented caps on an interactive reply-buttons message. */
export const WHATSAPP_MAX_BUTTONS = 3;
export const WHATSAPP_BUTTON_LABEL_MAX = 20;
export const WHATSAPP_BUTTON_ID_MAX = 256;
export const WHATSAPP_BODY_MAX = 1024;

/** The address separator. Both halves are digit strings (a Graph phone-number id
 *  and an E.164 `wa_id` without `+`), so `/` cannot occur inside either — the
 *  split is unambiguous by construction, not by convention. */
const ADDRESS_SEPARATOR = '/';

/** A WhatsApp conversation address — the BUSINESS phone-number id (which is the
 *  send URL's path segment) joined to the USER's `wa_id` (which is the body's
 *  `to`). One opaque string, because every shared seam that handles a recipient
 *  treats it as opaque: the credential resolver returns one, the binding gate
 *  compares one by string equality, and the session id is keyed on one.
 *
 *  This is the whole reason WhatsApp needs no widening of `OutboundMessage`. The
 *  encode side is the backend's recipient-resolver leaf (from `config_json`); the
 *  decode side is this transport. Both call THESE functions, so the two halves
 *  cannot drift into disagreeing about the format — which would silently break
 *  the binding gate (a mismatch refuses the turn, fail-closed but invisible). */
export const encodeWhatsAppAddress = (
  phone_number_id: string,
  wa_id: string,
): string => `${phone_number_id}${ADDRESS_SEPARATOR}${wa_id}`;

export const decodeWhatsAppAddress = (
  address: string,
): { phone_number_id: string; wa_id: string } | null => {
  const at = address.indexOf(ADDRESS_SEPARATOR);
  if (at <= 0 || at >= address.length - 1) return null;
  return {
    phone_number_id: address.slice(0, at),
    wa_id: address.slice(at + 1),
  };
};

/** Normalize a phone number to the `wa_id` form Meta uses on the wire: digits
 *  only, no `+`, no spaces, no punctuation. The owner types a human phone number
 *  into the enroll card; the webhook's `messages[].from` is always bare digits.
 *  Both sides run through this, so `+1 (650) 555-1234` and `16505551234` bind to
 *  the SAME conversation instead of failing the gate for a cosmetic reason. */
export const normalizeWaId = (value: string): string => value.replace(/[^0-9]/g, '');

export interface WhatsAppTransportOptions {
  /** Inject for testing; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout; defaults to `DEFAULT_TIMEOUT_MS`. For media downloads
   *  this is the IDLE timeout (no-progress abort). */
  timeoutMs?: number;
  /** Directory media downloads stream into before CAS ingest. Defaults to the OS
   *  temp dir; the backend wiring passes a server-local scratch dir. */
  downloadDir?: string;
}

/** Compose the message body. WhatsApp text is plain (no inline markup that is
 *  safe to assume), so a title sits on its own lines and `link_url` is appended
 *  below — WhatsApp auto-links a bare URL. */
const composeWhatsAppText = (msg: {
  text: string;
  title?: string;
  link_url?: string;
}): string => {
  const head = msg.title ? `*${msg.title}*\n\n` : '';
  const tail = msg.link_url ? `\n${msg.link_url}` : '';
  return `${head}${msg.text}${tail}`;
};

interface WhatsAppSendEnvelope {
  messages?: Array<{ id?: string }>;
}

/** Graph's error envelope — `{ error: { message, type, code } }`. Unlike Slack /
 *  Telegram (which answer 200 + `ok:false`), Graph signals failure with the HTTP
 *  status, so a 2xx here IS success and the only work is lifting a useful detail
 *  off a non-2xx. */
interface WhatsAppErrorEnvelope {
  error?: { message?: string; type?: string; code?: number };
}

const describeGraphError = (json: unknown): string => {
  const env = (json ?? {}) as WhatsAppErrorEnvelope;
  const message = env.error?.message;
  const code = env.error?.code;
  if (typeof message === 'string' && message.length > 0) {
    return typeof code === 'number' ? `${message} (code ${code})` : message;
  }
  return 'unknown_error';
};

/** Resolve a Graph round-trip to a discriminated send result. */
const handleWhatsAppOutcome = (outcome: HttpPostOutcome): TransportSendResult => {
  if (!outcome.ok) {
    const kind =
      outcome.kind === 'http_error'
        ? classifyHttpError(outcome.status)
        : outcome.kind;
    // On an `http_error` the body carries Graph's error envelope — surface its
    // message rather than a bare status, since Meta's codes are the only way to
    // tell "outside the 24-hour window" from "bad token" from "bad number".
    const detail =
      outcome.kind === 'http_error'
        ? `${describeGraphError(outcome.json)} [http ${outcome.status}]`
        : outcome.detail;
    return { ok: false, error: { kind, detail: `WhatsApp: ${detail}` } };
  }
  const env = (outcome.json ?? {}) as WhatsAppSendEnvelope;
  const id = env.messages?.[0]?.id;
  return typeof id === 'string' && id.length > 0
    ? { ok: true, vendor_message_id: id }
    : { ok: true };
};

const numericSize = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
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

const unpackMimeType = (contentType: string | undefined, fallback: string): string =>
  contentType?.split(';', 1)[0]?.trim() || fallback || 'application/octet-stream';

/** The media-bearing message kinds. Each carries `{ id, mime_type, sha256 }`;
 *  `document` adds `filename`, and every one of them is fetched by the same
 *  two-step media flow, so the kind is only a label. */
const WHATSAPP_MEDIA_KINDS = ['image', 'document', 'audio', 'video', 'sticker'] as const;

const extractWhatsAppMedia = (message: Record<string, unknown>): MediaRef[] => {
  const media: MediaRef[] = [];
  for (const kind of WHATSAPP_MEDIA_KINDS) {
    const node = message[kind];
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
    const m = node as Record<string, unknown>;
    const remote_id = typeof m.id === 'string' && m.id.length > 0 ? m.id : undefined;
    if (remote_id === undefined) continue;
    media.push({
      type: kind,
      mime:
        typeof m.mime_type === 'string' && m.mime_type.length > 0
          ? m.mime_type
          : 'application/octet-stream',
      size: numericSize(m.file_size),
      remote_id,
    });
  }
  return media;
};

/** Walk to the first `messages[]` entry in a Meta webhook envelope.
 *
 *  Shape: `{ object, entry: [ { id, changes: [ { value: { metadata, contacts,
 *  messages | statuses }, field } ] } ] }`. A delivery can batch several entries
 *  / changes / messages; the transport contract is one `ParsedInbound` per
 *  payload, so we take the FIRST message. That is honest for the interactive
 *  paths (a button press is its own delivery) and for the conversational path in
 *  practice (Meta delivers a user's message as its own call), and it is the same
 *  first-object posture Slack takes on `actions[0]`.
 *
 *  Deliveries carrying only `statuses` (sent / delivered / read receipts) have no
 *  `messages` array at all and correctly parse to `null` — they are not user
 *  turns, and treating a read receipt as one would loop the agent. */
const firstMessage = (payload: unknown): Record<string, unknown> | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const entries = (payload as Record<string, unknown>).entry;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const changes = (entry as Record<string, unknown>).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (change === null || typeof change !== 'object') continue;
      const value = (change as Record<string, unknown>).value;
      if (value === null || typeof value !== 'object') continue;
      const messages = (value as Record<string, unknown>).messages;
      if (!Array.isArray(messages) || messages.length === 0) continue;
      const message = messages[0];
      if (message === null || typeof message !== 'object') continue;
      return message as Record<string, unknown>;
    }
  }
  return null;
};

/** The `value.metadata.phone_number_id` of the change carrying the first message
 *  — the BUSINESS number the user wrote to, and half the conversation address. */
const firstPhoneNumberId = (payload: unknown): string | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const entries = (payload as Record<string, unknown>).entry;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const changes = (entry as Record<string, unknown>).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (change === null || typeof change !== 'object') continue;
      const value = (change as Record<string, unknown>).value;
      if (value === null || typeof value !== 'object') continue;
      const messages = (value as Record<string, unknown>).messages;
      if (!Array.isArray(messages) || messages.length === 0) continue;
      const metadata = (value as Record<string, unknown>).metadata;
      if (metadata === null || typeof metadata !== 'object') continue;
      const pnid = (metadata as Record<string, unknown>).phone_number_id;
      return typeof pnid === 'string' && pnid.length > 0 ? pnid : null;
    }
  }
  return null;
};

/** The message id of the first message — what the provider leaf re-surfaces under
 *  the declared flat `ingress.id_field`, since the registry's `id_field` is a key
 *  name and this one is nested. Exported so the backend leaf and this transport
 *  agree on where the id lives. */
export const whatsAppMessageId = (payload: unknown): string | null => {
  const message = firstMessage(payload);
  if (message === null) return null;
  const id = message.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

/** The bound-conversation address for a payload — the pair, composed. Shared by
 *  `parseConversationId` and `parseCallbackConversationId`, because WhatsApp (as
 *  opposed to Slack / Telegram) uses the SAME envelope for a message and a button
 *  press: a press arrives as a `messages[]` entry of type `interactive`. That
 *  identity is the vendor's, not a shortcut. */
const conversationAddress = (payload: unknown): string | null => {
  const message = firstMessage(payload);
  if (message === null) return null;
  const from = message.from;
  if (typeof from !== 'string' || from.length === 0) return null;
  const phone_number_id = firstPhoneNumberId(payload);
  if (phone_number_id === null) return null;
  return encodeWhatsAppAddress(phone_number_id, normalizeWaId(from));
};

export const createWhatsAppTransport = (
  options: WhatsAppTransportOptions = {},
): InteractiveTransport => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const downloadDir = options.downloadDir ?? tmpdir();

  /** POST a message body to the account-scoped messages endpoint. The recipient
   *  ADDRESS carries both halves; a malformed one is refused before any network
   *  call, since sending to the wrong business number is not a recoverable error. */
  const postMessage = async (
    address: string,
    token: string,
    message: (wa_id: string) => Record<string, unknown>,
  ): Promise<TransportSendResult> => {
    const parts = decodeWhatsAppAddress(address);
    if (parts === null) {
      return {
        ok: false,
        error: {
          kind: 'invalid_request',
          detail:
            `WhatsApp: recipient '${address}' is not a '<phone_number_id>`
            + `${ADDRESS_SEPARATOR}<wa_id>' address`,
        },
      };
    }
    const outcome = await postJson(
      `${GRAPH_BASE}/${encodeURIComponent(parts.phone_number_id)}/messages`,
      {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: parts.wa_id,
          ...message(parts.wa_id),
        }),
        timeoutMs,
        fetchImpl,
      },
    );
    return handleWhatsAppOutcome(outcome);
  };

  const send = (message: OutboundMessage): Promise<TransportSendResult> =>
    postMessage(message.recipient, message.token, () => ({
      type: 'text',
      // `preview_url` lets WhatsApp render a link card for `link_url`.
      text: { preview_url: true, body: composeWhatsAppText(message) },
    }));

  const sendPrompt = async (prompt: OutboundPrompt): Promise<TransportSendResult> => {
    // Refuse every cap violation UP FRONT rather than let Meta reject the send.
    // A refusal is safe: `deliverAsk` surfaces it, and live-control's
    // `renderActiveList` degrades to a plain text list on `{ok:false}`.
    if (prompt.options.length === 0 || prompt.options.length > WHATSAPP_MAX_BUTTONS) {
      return {
        ok: false,
        error: {
          kind: 'invalid_request',
          detail:
            `WhatsApp: ${prompt.options.length} options — reply buttons cap at `
            + `${WHATSAPP_MAX_BUTTONS} (a list message would carry up to 10; not wired)`,
        },
      };
    }
    const body = composeWhatsAppText(prompt);
    if (body.length > WHATSAPP_BODY_MAX) {
      return {
        ok: false,
        error: {
          kind: 'invalid_request',
          detail: `WhatsApp: prompt body is ${body.length} chars, cap ${WHATSAPP_BODY_MAX}`,
        },
      };
    }
    const buttons: Array<{ type: 'reply'; reply: { id: string; title: string } }> = [];
    for (const opt of prompt.options) {
      // NEVER truncate a label: these are approvals, and a clipped label can
      // change what the owner believes they are agreeing to.
      if (opt.label.length > WHATSAPP_BUTTON_LABEL_MAX) {
        return {
          ok: false,
          error: {
            kind: 'invalid_request',
            detail:
              `WhatsApp: option "${opt.id}" label is ${opt.label.length} chars, cap `
              + `${WHATSAPP_BUTTON_LABEL_MAX} — shorten it rather than have it truncated`,
          },
        };
      }
      const id = encodeChoice(prompt.correlation_id, opt.id);
      if (id.length > WHATSAPP_BUTTON_ID_MAX) {
        return {
          ok: false,
          error: {
            kind: 'invalid_request',
            detail:
              `WhatsApp: callback payload for option "${opt.id}" is ${id.length} chars, `
              + `cap ${WHATSAPP_BUTTON_ID_MAX}`,
          },
        };
      }
      buttons.push({ type: 'reply', reply: { id, title: opt.label } });
    }
    return postMessage(prompt.recipient, prompt.token, () => ({
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons },
      },
    }));
  };

  const closePrompt = async (ref: ClosePrompt): Promise<TransportSendResult> => {
    // WhatsApp has NO message-edit or delete API — a sent prompt's buttons cannot
    // be stripped. Say so honestly rather than lie with `{ok:true}` or paper over
    // it with a follow-up message (a new message is a different act, and Meta
    // bills for it). This is SAFE, not a silent drop: `closeAsk` discards the
    // result and never throws (`notification/channels/remote.ts`), a stale press
    // is a no-op under the block's first-answer-wins dedup, and WhatsApp itself
    // disables a reply button for the user who taps it.
    void ref;
    return Promise.resolve({
      ok: false,
      error: {
        kind: 'invalid_request',
        detail:
          'WhatsApp: no message-edit API — a delivered prompt keeps its buttons. '
          + 'A stale press is a no-op (first-answer-wins).',
      },
    });
  };

  const fetchMedia = async (ref: MediaRef, token: string): Promise<FetchedMedia> => {
    if (ref.remote_id === undefined) {
      throw new Error('WhatsApp media reference is missing a media id');
    }
    // Two steps, both bearer-authenticated: resolve the media id to a URL, then
    // stream that URL. The URL expires in 5 minutes and is NOT public — it needs
    // the same token on the download, which `downloadToFile` carries.
    const info = await getJson(`${GRAPH_BASE}/${encodeURIComponent(ref.remote_id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs,
      fetchImpl,
    });
    if (!info.ok) {
      throw new Error(
        `WhatsApp media lookup failed: ${
          info.kind === 'http_error' ? describeGraphError(info.json) : info.detail
        }`,
      );
    }
    const meta = (info.json ?? {}) as {
      url?: string;
      mime_type?: string;
      file_size?: number;
    };
    if (typeof meta.url !== 'string' || meta.url.length === 0) {
      throw new Error('WhatsApp media lookup returned no url');
    }
    const destPath = join(downloadDir, `whatsapp-media-${randomUUID()}`);
    const dl = await downloadToFile(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
      destPath,
      idleTimeoutMs: timeoutMs,
      fetchImpl,
    });
    if (!dl.ok) {
      throw new Error(`WhatsApp media download failed: ${dl.detail}`);
    }
    return {
      temp_path: destPath,
      size: dl.size,
      head_bytes: dl.headBytes,
      filename: sanitizeFilename(undefined, ref.remote_id),
      mime_type: unpackMimeType(dl.contentType, meta.mime_type ?? ref.mime),
    };
  };

  const parseInbound = (payload: unknown): ParsedInbound | null => {
    const message = firstMessage(payload);
    if (message === null) return null;
    const from = message.from;
    if (typeof from !== 'string' || from.length === 0) return null;
    // A button press is NOT a user turn — it is an option selection, and
    // `parseInboundChoice` owns it. Returning it here too would double-classify
    // the press (the inbound dispatcher tries the reply path first, then falls
    // through to the message path).
    if (message.type === 'interactive') return null;
    const text =
      typeof (message.text as Record<string, unknown> | undefined)?.body === 'string'
        ? ((message.text as Record<string, unknown>).body as string)
        : typeof (message.caption as unknown) === 'string'
          ? (message.caption as string)
          : '';
    const media = extractWhatsAppMedia(message);
    if (text.length === 0 && media.length === 0) return null;
    const result: ParsedInbound = { from: normalizeWaId(from), text };
    if (typeof message.id === 'string') result.vendor_message_id = message.id;
    if (media.length > 0) result.media = media;
    return result;
  };

  const parseInboundChoice = (payload: unknown): ParsedInboundChoice | null => {
    const message = firstMessage(payload);
    if (message === null) return null;
    if (message.type !== 'interactive') return null;
    const interactive = message.interactive;
    if (interactive === null || typeof interactive !== 'object') return null;
    const node = interactive as Record<string, unknown>;
    // `button_reply` is a reply-button tap; `list_reply` is a list-row tap. Only
    // the first is rendered today, but both round-trip the id we set, so decoding
    // either keeps a future list-message `sendPrompt` working with no edit here.
    const reply = node.button_reply ?? node.list_reply;
    if (reply === null || typeof reply !== 'object') return null;
    const id = (reply as Record<string, unknown>).id;
    if (typeof id !== 'string') return null;
    const choice = decodeChoice(id);
    if (choice === null) return null;
    const from = message.from;
    if (typeof from !== 'string' || from.length === 0) return null;
    const result: ParsedInboundChoice = {
      correlation_id: choice.correlation_id,
      option_id: choice.option_id,
      from: normalizeWaId(from),
    };
    // The prompt the press answers — WhatsApp echoes it as `context.id`.
    const context = message.context;
    if (context !== null && typeof context === 'object') {
      const ctxId = (context as Record<string, unknown>).id;
      if (typeof ctxId === 'string' && ctxId.length > 0) {
        result.vendor_message_id = ctxId;
      }
    }
    return result;
  };

  return {
    vendor: 'whatsapp',
    send,
    parseInbound,
    parseConversationId: conversationAddress,
    fetchMedia,
    sendPrompt,
    parseInboundChoice,
    // WhatsApp delivers a press in the SAME envelope shape as a message, so the
    // two extractors are genuinely the same function — not a shortcut.
    parseCallbackConversationId: conversationAddress,
    closePrompt,
  };
};
