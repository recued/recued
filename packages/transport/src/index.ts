/** @recued/transport — D-160 P0 shared Slack / Telegram raw transport.
 *
 *  The raw vendor send + inbound-parse plumbing — pure HTTP, no Recued-
 *  domain coupling. `@recued/messenger` (D-160) composes it; D-158's
 *  `slack` / `telegram` notification channels will ride the same package
 *  (one transport, one Slack integration — D-160 N.7).
 *
 *  Required follow-up: the pre-existing `connection.notification`
 *  Slack/Telegram send path in
 *  `packages/ingredients/src/connection-notification.ts` is a second
 *  live outbound implementation. D-160 N.7 / TR-9 ("integrate once")
 *  require it to be folded onto this package — a REQUIRED follow-up,
 *  not optional cleanup. The natural moment is D-158 P2, whose `slack` /
 *  `telegram` notification channels are the other `transport` consumer.
 *  P0 deliberately does not refactor that live code (the spec frames P0
 *  as standalone new leaf blocks).
 *
 *  Spec: docs/d-160-spec.md.
 */

export type {
  Transport,
  InteractiveTransport,
  TransportVendor,
  OutboundMessage,
  TransportSendResult,
  TransportError,
  TransportErrorKind,
  ParsedInbound,
  MediaRef,
  FetchedMedia,
  OutboundPrompt,
  OutboundPromptOption,
  ParsedInboundChoice,
  ClosePrompt,
} from './types.js';
export { createSlackTransport, type SlackTransportOptions } from './slack.js';
// D-192 M1b — Slack `users.info` profile-email leaf (the per-vendor adapter
// behind the messenger declaration's `platform_id_source: 'profile_email'`).
export { fetchSlackUserEmail, type FetchSlackUserEmailOptions } from './slack-users.js';
export {
  createTelegramTransport,
  type TelegramTransportOptions,
} from './telegram.js';
// D-192 CORE #6 make-live — the third chat transport. The address codec is
// exported because the BACKEND's recipient-resolver leaf composes the address
// (from `config_json`) that this transport decodes; one definition, so the two
// halves cannot drift into disagreeing about the format and silently failing the
// binding gate.
export {
  createWhatsAppTransport,
  encodeWhatsAppAddress,
  decodeWhatsAppAddress,
  normalizeWaId,
  whatsAppMessageId,
  WHATSAPP_GRAPH_VERSION,
  WHATSAPP_MAX_BUTTONS,
  WHATSAPP_BUTTON_LABEL_MAX,
  WHATSAPP_BUTTON_ID_MAX,
  WHATSAPP_BODY_MAX,
  type WhatsAppTransportOptions,
} from './whatsapp.js';

// D-192 — the fourth chat transport. A NOTIFY + APPROVE channel: Discord's
// Interactions webhook carries button presses but no plain user messages (those live
// on the Gateway, a persistent WS — `socket` ingress, unimplemented), so
// `parseInbound` returns null by design and the messenger turn never fires.
export {
  createDiscordTransport,
  discordInteractionId,
  DISCORD_API_VERSION,
  DISCORD_MAX_BUTTONS,
  DISCORD_BUTTONS_PER_ROW,
  DISCORD_MAX_ACTION_ROWS,
  DISCORD_CUSTOM_ID_MAX,
  DISCORD_BUTTON_LABEL_MAX,
  DISCORD_INTERACTION_PING,
  DISCORD_INTERACTION_MESSAGE_COMPONENT,
  type DiscordTransportOptions,
} from './discord.js';
