/** D-201 Slices 7D + 8N-8V + 9AD — Slack profile compatibility surface.
 *
 * Slack is trusted preset data over the neutral timestamped JSON/form
 * single-event composer. These exports retain fixture and policy compatibility;
 * request routing, handshake orchestration, failure mapping, clock gating,
 * credential validation, deduplication, and durable projection contain no
 * Slack-specific branch.
 */

import type { WebhookClockHealthAuthority } from './webhook-clock-health.js';
import {
  webhookTimestampedHmacDeliveryProfilePreset,
} from './webhook-delivery-engine-presets.js';
import type { WebhookIngressProfileAdapter } from './webhook-profile-runtime.js';
import {
  createClockGatedTimestampedJsonFormSingleEventWebhookProfileAdapter,
  createTimestampedJsonFormSingleEventWebhookCredentialShapeValidator,
  createTimestampedJsonFormSingleEventWebhookProfileAdapter,
} from './webhook-timestamped-json-form-single-event-profile.js';

const SLACK_PROFILE_ID = 'slack.request.v0' as const;

const delivery = webhookTimestampedHmacDeliveryProfilePreset(
  SLACK_PROFILE_ID,
);
if (delivery === null
  || delivery.decoder === null
  || delivery.form_decoder === null
  || delivery.form_json_envelope === null
  || delivery.flat_form_event_normalizer === null
  || delivery.handshake === null
  || delivery.event_projector === null
  || delivery.delivery_deduplicator === null
  || delivery.event_normalizer === null
  || delivery.admission_method_label === null
  || delivery.runtime_error_label === null) {
  throw new Error('Slack composed delivery preset is unavailable');
}

export const SLACK_TIMESTAMPED_HMAC_MECHANISM_PRESET = delivery.mechanism;
export const SLACK_JSON_OBJECT_DECODER_PRESET = delivery.decoder;
export const SLACK_FORM_URLENCODED_DECODER_PRESET = delivery.form_decoder;
export const SLACK_FORM_WRAPPED_JSON_DECODER_PRESET =
  delivery.form_json_envelope;
export const SLACK_FLAT_FORM_EVENT_NORMALIZER_PRESET =
  delivery.flat_form_event_normalizer;
export const SLACK_JSON_CHALLENGE_PROJECTOR_PRESET =
  delivery.handshake.projector;
export const SLACK_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET =
  delivery.event_projector;
export const SLACK_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET =
  delivery.delivery_deduplicator;
export const SLACK_JSON_EVENT_NORMALIZER_PRESET = delivery.event_normalizer;

const credentialShapeValidator =
  createTimestampedJsonFormSingleEventWebhookCredentialShapeValidator(
    SLACK_PROFILE_ID,
  );

/** The signing secret is the entire delivery credential. Hidden, inherited,
 * accessor-backed, or ignored authority fails closed. */
export const validateSlackWebhookCredentialShape = (
  credentials: Readonly<Record<string, string>>,
): boolean => credentialShapeValidator(credentials);

const adapter = createTimestampedJsonFormSingleEventWebhookProfileAdapter(
  SLACK_PROFILE_ID,
);

/** Pure adapter for protocol fixtures. Production uses the clock-gated neutral
 * composer so caller-controlled wall time cannot become replay authority. */
export const createSlackWebhookProfileAdapter = (
): WebhookIngressProfileAdapter => adapter;

export const createClockGatedSlackWebhookProfileAdapter = (
  authority: WebhookClockHealthAuthority,
): WebhookIngressProfileAdapter =>
  createClockGatedTimestampedJsonFormSingleEventWebhookProfileAdapter(
    SLACK_PROFILE_ID,
    authority,
  );
