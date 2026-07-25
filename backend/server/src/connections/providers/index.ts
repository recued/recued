/** Connection vendor providers for the shared inbound webhook port.
 *
 *  These providers plug per-vendor signature verification + dispatch
 *  into the D-148 P6 webhook port via the
 *  `WebhookVendorDescriptor` shape. The provider here is the inbound
 *  transport gate; vendor-specific business convergence stays behind its
 *  injected dispatcher. */

export {
  createSlackVendorDescriptor,
  SLACK_REPLAY_WINDOW_SECONDS,
  type SlackInboundEvent,
  type SlackProviderDeps,
  type SlackConnectionLookup,
} from './slack-provider.js';

export {
  createTelegramVendorDescriptor,
  setTelegramWebhook,
  TELEGRAM_SECRET_HEADER,
  type TelegramInboundUpdate,
  type TelegramProviderDeps,
  type TelegramConnectionLookup,
  type TelegramSetWebhookArgs,
  type TelegramSetWebhookResult,
} from './telegram-provider.js';

export {
  createStripeVendorDescriptor,
  STRIPE_SIGNATURE_HEADER,
  STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  type StripeInboundEvent,
  type StripeProviderDeps,
  type StripeConnectionLookup,
} from './stripe-provider.js';

// D-192 CORE #6 make-live — WhatsApp (Meta Cloud API).
export {
  createWhatsAppVendorDescriptor,
  type WhatsAppInboundEvent,
  type WhatsAppProviderDeps,
  type WhatsAppConnectionLookup,
} from './whatsapp-provider.js';
export {
  answerWhatsAppChallenge,
  isValidWhatsAppAppSecret,
  isValidWhatsAppVerifyToken,
  verifyWhatsAppSignature,
  WHATSAPP_SIGNATURE_HEADER,
  type WhatsAppChallengeResult,
} from './whatsapp-webhook-protocol.js';

// D-192 — Discord (Interactions webhook, Ed25519).
export {
  createDiscordVendorDescriptor,
  type DiscordInboundEvent,
  type DiscordProviderDeps,
  type DiscordConnectionLookup,
} from './discord-provider.js';
export {
  isValidDiscordPublicKey,
  verifyDiscordSignature,
  DISCORD_SIGNATURE_HEADER,
  DISCORD_TIMESTAMP_HEADER,
  DISCORD_PONG_BODY,
  DISCORD_DEFERRED_ACK_BODY,
} from './discord-webhook-protocol.js';
