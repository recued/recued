/** D-201 Slices 7A + 7C + 8L + 8Y-9D — Stripe classic-event profile.
 *
 * Stripe is now trusted preset data over the neutral timestamped-HMAC JSON
 * single-event composer. These exports retain the fixture and compatibility
 * surface used by policy and protocol-parity tests; request orchestration,
 * failure mapping, test construction, and clock gating contain no Stripe case.
 */

import type { WebhookClockHealthAuthority } from './webhook-clock-health.js';
import { webhookTimestampedHmacDeliveryProfilePreset } from './webhook-delivery-engine-presets.js';
import type { WebhookIngressProfileAdapter } from './webhook-profile-runtime.js';
import {
  createClockGatedTimestampedJsonSingleEventWebhookProfileAdapter,
  createTimestampedJsonSingleEventWebhookCredentialShapeValidator,
  createTimestampedJsonSingleEventWebhookProfileAdapter,
} from './webhook-timestamped-json-single-event-profile.js';

const STRIPE_PROFILE_ID = 'stripe.event.v1' as const;

const stripeDeliveryEnginePreset = webhookTimestampedHmacDeliveryProfilePreset(
  STRIPE_PROFILE_ID,
);
if (stripeDeliveryEnginePreset === null) {
  throw new Error('Stripe timestamped HMAC delivery preset is unavailable');
}
if (stripeDeliveryEnginePreset.decoder === null) {
  throw new Error('Stripe JSON delivery preset is unavailable');
}
if (stripeDeliveryEnginePreset.event_normalizer === null) {
  throw new Error('Stripe JSON event normalizer preset is unavailable');
}
if (stripeDeliveryEnginePreset.environment_admission === null) {
  throw new Error('Stripe JSON environment admission preset is unavailable');
}
if (stripeDeliveryEnginePreset.test_envelope === null) {
  throw new Error('Stripe JSON test envelope preset is unavailable');
}
if (stripeDeliveryEnginePreset.event_projector === null) {
  throw new Error('Stripe normalized event projector preset is unavailable');
}
if (stripeDeliveryEnginePreset.delivery_deduplicator === null) {
  throw new Error('Stripe delivery deduplicator preset is unavailable');
}

export const STRIPE_TIMESTAMPED_HMAC_MECHANISM_PRESET =
  stripeDeliveryEnginePreset.mechanism;
export const STRIPE_JSON_OBJECT_DECODER_PRESET =
  stripeDeliveryEnginePreset.decoder;
export const STRIPE_JSON_EVENT_NORMALIZER_PRESET =
  stripeDeliveryEnginePreset.event_normalizer;
export const STRIPE_JSON_ENVIRONMENT_ADMISSION_PRESET =
  stripeDeliveryEnginePreset.environment_admission;
export const STRIPE_NORMALIZED_SINGLE_EVENT_PROJECTOR_PRESET =
  stripeDeliveryEnginePreset.event_projector;
export const STRIPE_NORMALIZED_DELIVERY_DEDUPLICATOR_PRESET =
  stripeDeliveryEnginePreset.delivery_deduplicator;
export const STRIPE_JSON_SINGLE_EVENT_TEST_ENVELOPE_PRESET =
  stripeDeliveryEnginePreset.test_envelope;

const stripeCredentialShapeValidator =
  createTimestampedJsonSingleEventWebhookCredentialShapeValidator(
    STRIPE_PROFILE_ID,
  );

/** The endpoint secret is the whole Stripe delivery credential. Reject extra,
 * hidden, inherited, or accessor fields so config cannot carry ignored
 * authority beside the value the selected mechanism actually verifies.
 */
export const validateStripeWebhookCredentialShape = (
  credentials: Readonly<Record<string, string>>,
): boolean => stripeCredentialShapeValidator(credentials);

const stripeProfileAdapter =
  createTimestampedJsonSingleEventWebhookProfileAdapter(STRIPE_PROFILE_ID);

/** Pure adapter for profile fixtures. Production uses the clock-gated neutral
 * composer below so caller-controlled wall time cannot become freshness
 * authority.
 */
export const createStripeWebhookProfileAdapter = (
): WebhookIngressProfileAdapter => stripeProfileAdapter;

export const createClockGatedStripeWebhookProfileAdapter = (
  authority: WebhookClockHealthAuthority,
): WebhookIngressProfileAdapter =>
  createClockGatedTimestampedJsonSingleEventWebhookProfileAdapter(
    STRIPE_PROFILE_ID,
    authority,
  );
