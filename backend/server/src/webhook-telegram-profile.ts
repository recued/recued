/** D-201 Slices 7E + 9X-9AC — Telegram profile compatibility surface.
 *
 * Telegram is trusted preset data over the neutral static-header JSON
 * single-event composer. These exports retain fixture and policy compatibility;
 * request orchestration, failure mapping, credential validation, deduplication,
 * and durable projection contain no Telegram-specific branch.
 */

import {
  webhookStaticHeaderTokenDeliveryProfilePreset,
} from './webhook-delivery-engine-presets.js';
import type { WebhookIngressProfileAdapter } from './webhook-profile-runtime.js';
import {
  createStaticHeaderJsonSingleEventWebhookCredentialShapeValidator,
  createStaticHeaderJsonSingleEventWebhookProfileAdapter,
} from './webhook-static-header-json-single-event-profile.js';

const TELEGRAM_PROFILE_ID = 'telegram.bot-webhook.v1' as const;

const delivery = webhookStaticHeaderTokenDeliveryProfilePreset(
  TELEGRAM_PROFILE_ID,
);
if (delivery === null
  || delivery.event_normalizer === null
  || delivery.delivery_deduplicator === null
  || delivery.event_projector === null
  || delivery.admission_method_label === null) {
  throw new Error('Telegram composed delivery preset is unavailable');
}

export const TELEGRAM_STATIC_HEADER_TOKEN_MECHANISM_PRESET =
  delivery.mechanism;
export const TELEGRAM_JSON_OBJECT_DECODER_PRESET = delivery.decoder;
export const TELEGRAM_JSON_SINGLE_MEMBER_EVENT_NORMALIZER_PRESET =
  delivery.event_normalizer;
export const TELEGRAM_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET =
  delivery.delivery_deduplicator;
export const TELEGRAM_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET =
  delivery.event_projector;

const credentialShapeValidator =
  createStaticHeaderJsonSingleEventWebhookCredentialShapeValidator(
    TELEGRAM_PROFILE_ID,
  );

/** The generated secret token is the complete delivery credential. Extra,
 * inherited, symbol, accessor, or non-enumerable authority fails closed. */
export const validateTelegramWebhookCredentialShape = (
  credentials: Readonly<Record<string, string>>,
): boolean => credentialShapeValidator(credentials);

const adapter = createStaticHeaderJsonSingleEventWebhookProfileAdapter(
  TELEGRAM_PROFILE_ID,
);

export const createTelegramWebhookProfileAdapter = (
): WebhookIngressProfileAdapter => adapter;
