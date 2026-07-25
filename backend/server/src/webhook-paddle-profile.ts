/** D-201 Slices 8G + 8M + 9F-9O — Paddle compatibility profile surface.
 *
 * Paddle is trusted preset data over the neutral timestamped-HMAC JSON
 * single-notification composer. These exports retain protocol-fixture and
 * policy compatibility; request orchestration, failure mapping, and clock
 * gating contain no Paddle branch.
 */

import type { WebhookClockHealthAuthority } from './webhook-clock-health.js';
import {
  webhookJsonSingleNotificationProfilePreset,
  webhookPairedProviderIdProfilePreset,
  webhookRfc3339TimestampProfilePreset,
  webhookTimestampedHmacDeliveryProfilePreset,
} from './webhook-delivery-engine-presets.js';
import type { WebhookIngressProfileAdapter } from './webhook-profile-runtime.js';
import {
  webhookDotSegmentEventTypeProfilePreset,
  webhookJsonObjectProviderIdProfilePreset,
  webhookJsonRequiredObjectProfilePreset,
} from './webhook-shared-profile-parser-presets.js';
import {
  createClockGatedTimestampedJsonSingleNotificationWebhookProfileAdapter,
  createTimestampedJsonSingleNotificationWebhookCredentialShapeValidator,
  createTimestampedJsonSingleNotificationWebhookProfileAdapter,
} from './webhook-timestamped-json-single-notification-profile.js';

const PADDLE_PROFILE_ID = 'paddle.notification.v1' as const;

const paddleDeliveryEnginePreset = webhookTimestampedHmacDeliveryProfilePreset(
  PADDLE_PROFILE_ID,
);
if (paddleDeliveryEnginePreset === null
  || paddleDeliveryEnginePreset.decoder === null
  || paddleDeliveryEnginePreset.event_projector === null
  || paddleDeliveryEnginePreset.delivery_deduplicator?.kind
    !== 'normalized_paired_ids_sha256.v1') {
  throw new Error('Paddle timestamped delivery preset is unavailable');
}
const paddleTimestampParserPreset = webhookRfc3339TimestampProfilePreset(
  PADDLE_PROFILE_ID,
);
if (paddleTimestampParserPreset === null) {
  throw new Error('Paddle RFC3339 timestamp preset is unavailable');
}
const paddleProviderIdPreset = webhookPairedProviderIdProfilePreset(
  PADDLE_PROFILE_ID,
);
if (paddleProviderIdPreset === null) {
  throw new Error('Paddle paired provider-id preset is unavailable');
}
const paddleEventTypePreset = webhookDotSegmentEventTypeProfilePreset(
  PADDLE_PROFILE_ID,
);
if (paddleEventTypePreset === null) {
  throw new Error('Paddle dot-segment event-type preset is unavailable');
}
const paddleResourceIdPreset = webhookJsonObjectProviderIdProfilePreset(
  PADDLE_PROFILE_ID,
);
if (paddleResourceIdPreset === null) {
  throw new Error('Paddle JSON-object provider-id preset is unavailable');
}
const paddleDataObjectPreset = webhookJsonRequiredObjectProfilePreset(
  PADDLE_PROFILE_ID,
);
if (paddleDataObjectPreset === null) {
  throw new Error('Paddle required JSON-object preset is unavailable');
}
const paddleNotificationPreset = webhookJsonSingleNotificationProfilePreset(
  PADDLE_PROFILE_ID,
);
if (paddleNotificationPreset === null) {
  throw new Error('Paddle JSON single-notification preset is unavailable');
}

export const PADDLE_TIMESTAMPED_HMAC_MECHANISM_PRESET =
  paddleDeliveryEnginePreset.mechanism;
export const PADDLE_JSON_OBJECT_DECODER_PRESET =
  paddleDeliveryEnginePreset.decoder;
export const PADDLE_RFC3339_TIMESTAMP_PARSER_PRESET =
  paddleTimestampParserPreset.parser;
export const PADDLE_EVENT_ID_PARSER_PRESET = paddleProviderIdPreset.event_id;
export const PADDLE_DELIVERY_ID_PARSER_PRESET =
  paddleProviderIdPreset.delivery_id;
export const PADDLE_EVENT_TYPE_PARSER_PRESET = paddleEventTypePreset.parser;
export const PADDLE_RESOURCE_ID_EXTRACTOR_PRESET =
  paddleResourceIdPreset.extractor;
export const PADDLE_DATA_OBJECT_EXTRACTOR_PRESET =
  paddleDataObjectPreset.extractor;
export const PADDLE_JSON_SINGLE_NOTIFICATION_NORMALIZER_PRESET =
  paddleNotificationPreset.normalizer;
export const PADDLE_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET =
  paddleDeliveryEnginePreset.event_projector;
export const PADDLE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET =
  paddleDeliveryEnginePreset.delivery_deduplicator;

const paddleCredentialShapeValidator =
  createTimestampedJsonSingleNotificationWebhookCredentialShapeValidator(
    PADDLE_PROFILE_ID,
  );

/** The provider-generated destination secret is the complete credential.
 * Extra, hidden, inherited, accessor-backed, or malformed fields fail closed.
 */
export const validatePaddleWebhookCredentialShape = (
  credentials: Readonly<Record<string, string>>,
): boolean => paddleCredentialShapeValidator(credentials);

const paddleProfileAdapter =
  createTimestampedJsonSingleNotificationWebhookProfileAdapter(
    PADDLE_PROFILE_ID,
  );

/** Pure adapter for protocol fixtures. Production uses the clock-gated neutral
 * composer so caller-controlled wall time cannot become freshness authority.
 */
export const createPaddleWebhookProfileAdapter = (
): WebhookIngressProfileAdapter => paddleProfileAdapter;

export const createClockGatedPaddleWebhookProfileAdapter = (
  authority: WebhookClockHealthAuthority,
): WebhookIngressProfileAdapter =>
  createClockGatedTimestampedJsonSingleNotificationWebhookProfileAdapter(
    PADDLE_PROFILE_ID,
    authority,
  );
