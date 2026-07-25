/** D-201 Slice 9BQ — Lemon Squeezy profile compatibility surface.
 *
 * Lemon Squeezy is trusted preset data over the neutral raw-HMAC JSON:API
 * single-event composer. This file contains no request orchestration or
 * vendor-specific runtime branch.
 */

import {
  webhookJsonApiSingleEventProfilePreset,
} from './webhook-json-api-single-event-profile-presets.js';
import {
  createRawBodyJsonApiSingleEventWebhookCredentialShapeValidator,
  createRawBodyJsonApiSingleEventWebhookProfileAdapter,
} from './webhook-raw-body-json-api-single-event-profile.js';
import type { WebhookIngressProfileAdapter } from './webhook-profile-runtime.js';

const PROFILE_ID = 'lemonsqueezy.webhook.v1' as const;
const preset = webhookJsonApiSingleEventProfilePreset(PROFILE_ID);
if (preset === null) {
  throw new Error('Lemon Squeezy composed delivery preset is unavailable');
}

export const LEMONSQUEEZY_WEBHOOK_RAW_BODY_HMAC_MECHANISM_PRESET =
  preset.delivery.mechanism;
export const LEMONSQUEEZY_EVENT_TYPE_PARSER_PRESET = preset.event_type_parser;
export const LEMONSQUEEZY_JSON_API_EVENT_NORMALIZER_PRESET =
  preset.event_normalizer;
export const LEMONSQUEEZY_RECEIVED_AT_BODY_DEDUPLICATOR_PRESET =
  preset.delivery_deduplicator;
export const LEMONSQUEEZY_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET =
  preset.event_projector;

const credentialShapeValidator =
  createRawBodyJsonApiSingleEventWebhookCredentialShapeValidator(PROFILE_ID);

export const validateLemonSqueezyWebhookCredentialShape = (
  credentials: Readonly<Record<string, string>>,
): boolean => credentialShapeValidator(credentials);

const adapter = createRawBodyJsonApiSingleEventWebhookProfileAdapter(
  PROFILE_ID,
);

export const createLemonSqueezyWebhookProfileAdapter = (
): WebhookIngressProfileAdapter => adapter;
