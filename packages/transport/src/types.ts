/** D-160 P0 — `@recued/transport` shared shapes.
 *
 *  The transport layer is the raw Slack / Telegram send + inbound-parse
 *  plumbing — pure HTTP, zero Recued-domain coupling (it imports
 *  nothing). It is composed by `@recued/messenger` (D-160) and, later,
 *  by D-158's `slack` / `telegram` notification channels: one transport
 *  package, one Slack integration (D-160 N.7 / TR-9).
 *
 *  The vendor credential is a BYO token the caller hands in already
 *  decrypted — the transport never touches the connection store or any
 *  crypto, and ships no app-registration / setup wizard (D-160 I-10).
 *
 *  Inbound *verification* (Slack HMAC, Telegram secret-token) is NOT
 *  here — it is the server-resident D-148 P9 webhook port's concern.
 *  The transport only parses an already-verified payload (`parseInbound`).
 *
 *  Spec: docs/d-160-spec.md § N.5 / N.7 / A.5.
 */

import type { Buffer } from 'node:buffer';

/** A chat-transport vendor slug — the raw transport layer's vendor ref.
 *
 *  D-192 CORE #6: widened from the closed `'slack' | 'telegram'` union to
 *  the open slug so a new transport (Discord / Teams / …) is a
 *  `MESSENGER_VENDOR_DECLARATIONS` entry + a thin `Transport` leaf, never
 *  an edit to shared composers. The slug IS the transport ref; membership
 *  is validated at RUNTIME against the messenger-vendor registry
 *  (`listMessengerVendors()` / `isDeclaredMessengerVendor()` in
 *  `@recued/contracts`), which replaces the compile-time `switch`
 *  exhaustiveness the closed union used to give. This package stays
 *  domain-coupling-free (it imports nothing) — the registry validation
 *  lives at the composition layer, not here.
 *
 *  `email` remains excluded — it is not raw HTTP send/poll plumbing (it
 *  rides the mail collection + D-158's discrete `email` channel), and is
 *  not a declared messenger transport. */
export type TransportVendor = string;

/** One message to send to a vendor surface. */
export interface OutboundMessage {
  /** Vendor-surface recipient — a Slack channel id (`C…`) / `@channel`,
   *  or a Telegram numeric `chat_id` / `@channelname`. */
  recipient: string;
  /** The message body. */
  text: string;
  /** BYO bearer credential, already decrypted by the caller — a Slack
   *  `xoxb-…` bot token or a Telegram `<bot_id>:<secret>` token. */
  token: string;
  /** Optional heading rendered inline above `text`. */
  title?: string;
  /** Optional deep link appended on its own line below `text`. */
  link_url?: string;
}

/** Closed taxonomy of a send failure. `vendor_error` is a well-formed
 *  HTTP 200 carrying the vendor's own `ok: false` envelope;
 *  `invalid_request` is a request the transport refuses to send before
 *  any network call — e.g. an interactive-prompt callback payload over
 *  the vendor's size limit (D-158 P2). */
export type TransportErrorKind =
  | 'timeout'
  | 'network'
  | 'auth'
  | 'rate_limited'
  | 'server_error'
  | 'vendor_error'
  | 'invalid_request';

export interface TransportError {
  kind: TransportErrorKind;
  detail: string;
}

/** Discriminated send outcome — a failure is `{ ok: false }`, never a
 *  thrown exception. */
export type TransportSendResult =
  | { ok: true; vendor_message_id?: string }
  | { ok: false; error: TransportError };

/** One media object referenced by an inbound vendor payload. */
export interface MediaRef {
  /** Vendor media kind (`photo`, `voice`, `file`, ...). */
  type: string;
  /** Vendor-declared MIME type, or a conservative fallback. */
  mime: string;
  /** Vendor-declared byte size when available. */
  size: number;
  /** Direct download URL when the vendor payload carries one. */
  remote_url?: string;
  /** Vendor file id for surfaces that require a second API lookup. */
  remote_id?: string;
}

/** One inbound media reference fetched to a TEMP FILE (never buffered whole
 *  in memory — D-172 streaming ingest). The consumer hands `temp_path` to
 *  `BlobStore.putFile` (also streaming) and then deletes it; the CALLER owns
 *  the temp file's lifecycle. `head_bytes` is the file's leading bytes for
 *  server-side magic-byte detection (the stored mime is detected, not the
 *  vendor-reported `mime_type`, which is kept only as the detection fallback). */
export interface FetchedMedia {
  /** Path to the downloaded temp file. Caller deletes after consuming. */
  temp_path: string;
  /** Total bytes downloaded. */
  size: number;
  /** Leading bytes captured for magic-byte detection. */
  head_bytes: Buffer;
  filename: string;
  /** Vendor/HTTP-reported MIME — the magic-byte fallback, NOT the stored value. */
  mime_type: string;
}

/** A user message extracted from an inbound vendor payload. */
export interface ParsedInbound {
  /** Sender identifier on the vendor surface. */
  from: string;
  /** The message text. */
  text: string;
  /** Vendor message id when the payload carries one. */
  vendor_message_id?: string;
  /** Media references carried by the same inbound vendor payload. */
  media?: MediaRef[];
}

// ── Interactive prompts (D-158 P2) ──────────────────────────────────

/** One selectable option on an interactive prompt. */
export interface OutboundPromptOption {
  /** Stable option id — round-tripped through the vendor callback and
   *  echoed back verbatim on selection. */
  id: string;
  /** The button label shown to the user. */
  label: string;
}

/** An interactive prompt — a message rendered with selectable option
 *  buttons (a Slack `actions` block, a Telegram inline keyboard). The
 *  `correlation_id` is embedded in every option's vendor callback
 *  payload and echoed back verbatim on the inbound press, so the caller
 *  can match a choice to whatever it sent. The transport is vocabulary-
 *  neutral — it never interprets `correlation_id`. */
export interface OutboundPrompt {
  /** Vendor-surface recipient — see `OutboundMessage.recipient`. */
  recipient: string;
  /** The prompt body. */
  text: string;
  /** BYO bearer credential, already decrypted — see `OutboundMessage`. */
  token: string;
  /** Optional heading rendered above `text`. */
  title?: string;
  /** Caller-opaque match token, round-tripped through the vendor
   *  callback. MUST NOT contain the `|` byte (the callback-payload
   *  field separator). */
  correlation_id: string;
  /** The selectable options, in render order. At least one. */
  options: readonly OutboundPromptOption[];
}

/** An inbound option selection — a button press on an `OutboundPrompt`.
 *  `parseInboundChoice` decodes one from an already-verified vendor
 *  callback payload. */
export interface ParsedInboundChoice {
  /** The `OutboundPrompt.correlation_id` this press answers. */
  correlation_id: string;
  /** The chosen `OutboundPromptOption.id`. */
  option_id: string;
  /** Sender identifier on the vendor surface. */
  from: string;
  /** Vendor message id of the prompt the press answers, when present. */
  vendor_message_id?: string;
}

/** A reference to a sent interactive prompt — the input to
 *  `closePrompt`, which strips the prompt's option buttons. */
export interface ClosePrompt {
  /** Vendor-surface recipient the prompt was sent to. */
  recipient: string;
  /** BYO bearer credential, already decrypted. */
  token: string;
  /** The `vendor_message_id` `sendPrompt` returned for this prompt. */
  vendor_message_id: string;
  /** The text to leave on the message once its buttons are removed. */
  text: string;
}

/** The raw vendor transport — send one message, parse one inbound
 *  payload. Composed by `@recued/messenger` (D-160). D-158's notification
 *  channels need the interactive superset — `InteractiveTransport`. */
export interface Transport {
  readonly vendor: TransportVendor;
  /** Send one message. Resolves with a discriminated result — a vendor
   *  / network / auth failure is `{ ok: false }`, never a throw. */
  send(message: OutboundMessage): Promise<TransportSendResult>;
  /** Parse an already-verified inbound payload into a user message.
   *  Returns `null` for any payload that is not a user message —
   *  control events, bot echoes, non-message updates. */
  parseInbound(payload: unknown): ParsedInbound | null;
  /** Extract the bound-conversation id from an already-verified inbound
   *  MESSAGE payload — the per-vendor shape (Slack `event.channel`,
   *  Telegram `message.chat.id`). Null when the payload carries none (the
   *  binding gate then refuses, fail-closed). D-192 CORE #6: the
   *  conversation-shape leaf lives on the transport, not a `switch(vendor)`
   *  in a shared composer. */
  parseConversationId(payload: unknown): string | null;
  /** Fetch one parsed media reference with the same bot token used by
   *  the outbound transport. */
  fetchMedia?(ref: MediaRef, token: string): Promise<FetchedMedia>;
}

/** A `Transport` that also sends + resolves interactive prompts and
 *  decodes button presses (D-158 P2). `createSlackTransport` /
 *  `createTelegramTransport` return this superset; a consumer that only
 *  sends plain messages (D-160's `messenger`) narrows to `Transport`,
 *  so extending the transport with interactivity left `messenger`
 *  untouched. */
export interface InteractiveTransport extends Transport {
  /** Send an interactive prompt — a message with selectable option
   *  buttons. The reply (a button press) arrives as a vendor callback
   *  payload `parseInboundChoice` decodes. Same discriminated-result
   *  contract as `send`. */
  sendPrompt(prompt: OutboundPrompt): Promise<TransportSendResult>;
  /** Decode an already-verified inbound vendor payload into an option
   *  selection. Returns `null` for any payload that is not a button
   *  press on a prompt this layer rendered. */
  parseInboundChoice(payload: unknown): ParsedInboundChoice | null;
  /** Extract the bound-conversation id from an already-verified inbound
   *  CALLBACK (button-press) payload — a DIFFERENT per-vendor shape than a
   *  message (Slack `container.channel_id` / `channel.id`, Telegram
   *  `callback_query.message.chat.id`). Null when absent (fail-closed).
   *  D-192 CORE #6 — moved off the live-control composer's `switch(vendor)`. */
  parseCallbackConversationId(payload: unknown): string | null;
  /** Resolve a sent interactive prompt — remove its option buttons so a
   *  stale prompt cannot be pressed after the question is answered, and
   *  leave `ClosePrompt.text` as the message body. */
  closePrompt(ref: ClosePrompt): Promise<TransportSendResult>;
}
