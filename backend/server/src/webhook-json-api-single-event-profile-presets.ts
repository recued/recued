/** D-201 Slice 9BQ — trusted JSON:API-style single-event profile presets.
 *
 * This is the code-owned profile boundary for a reusable envelope family. It
 * composes existing mechanism/decoder/parser/projector engines with a neutral
 * JSON:API-style normalizer and receipt-window identity. Runtime orchestration
 * contains no profile or vendor branch.
 */

import {
  webhookProfile,
  type WebhookEnvironment,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  webhookRawBodyHmacDeliveryProfilePreset,
  type WebhookRawBodyHmacDeliveryProfilePreset,
} from './webhook-delivery-engine-presets.js';
import {
  createWebhookJsonApiSingleEventNormalizer,
  type WebhookJsonApiSingleEventNormalizerPreset,
} from './webhook-json-api-single-event-normalizer.js';
import {
  createWebhookLowercaseIdentifierEventTypeParser,
  type WebhookLowercaseIdentifierEventTypeParserPreset,
} from './webhook-lowercase-identifier-event-type-parser.js';
import {
  createWebhookNormalizedSingleEventProjector,
  type WebhookNormalizedSingleEventProjectorPreset,
} from './webhook-normalized-event-projector.js';
import {
  createWebhookReceivedAtBodyDeduplicator,
  type WebhookReceivedAtBodyDeduplicatorPreset,
} from './webhook-received-at-body-deduplicator.js';

export interface WebhookJsonApiSingleEventProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly delivery: WebhookRawBodyHmacDeliveryProfilePreset;
  readonly event_type_parser: WebhookLowercaseIdentifierEventTypeParserPreset;
  readonly event_normalizer: WebhookJsonApiSingleEventNormalizerPreset;
  readonly delivery_deduplicator: WebhookReceivedAtBodyDeduplicatorPreset;
  readonly event_projector: WebhookNormalizedSingleEventProjectorPreset;
  readonly admission_method_label: string;
  readonly supported_environments: readonly WebhookEnvironment[];
}

const preset = (
  profile_id: WebhookProfileId,
  eventTypeParserInput: WebhookLowercaseIdentifierEventTypeParserPreset,
  eventNormalizerInput: WebhookJsonApiSingleEventNormalizerPreset,
  deliveryDeduplicatorInput: WebhookReceivedAtBodyDeduplicatorPreset,
  eventProjectorInput: WebhookNormalizedSingleEventProjectorPreset,
  admissionMethodLabel: string,
): WebhookJsonApiSingleEventProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const delivery = webhookRawBodyHmacDeliveryProfilePreset(profile_id);
  const eventTypeParser = createWebhookLowercaseIdentifierEventTypeParser(
    eventTypeParserInput,
  );
  const eventNormalizer = createWebhookJsonApiSingleEventNormalizer(
    eventNormalizerInput,
    eventTypeParser,
  ).preset;
  const deliveryDeduplicator = createWebhookReceivedAtBodyDeduplicator(
    deliveryDeduplicatorInput,
  ).preset;
  const eventProjector = createWebhookNormalizedSingleEventProjector(
    eventProjectorInput,
  ).preset;
  const identity = descriptor?.deduplication.identity;
  const knownEvents = descriptor?.event_types.kind === 'open'
    ? descriptor.event_types.known_values
    : [];
  if (descriptor === null
    || delivery === null
    || descriptor.mechanism_kind !== 'raw_body_hmac'
    || descriptor.transport_assurance !== 'authenticated'
    || descriptor.decoder_kind !== 'json'
    || descriptor.max_events_per_delivery !== 1
    || descriptor.handshakes.length !== 0
    || descriptor.registration_modes.length !== 1
    || descriptor.registration_modes[0] !== 'manual'
    || descriptor.event_types.kind !== 'open'
    || knownEvents.some((value) => eventTypeParser.parse(value) === null)
    || identity?.kind !== 'received_at_body_window'
    || identity.window_ms !== deliveryDeduplicator.window_ms
    || descriptor.max_body_bytes !== deliveryDeduplicator.max_body_bytes
    || delivery.raw_header_metadata !== null
    || delivery.delivery_deduplicator !== null
    || delivery.metadata_payload_event_normalizer !== null
    || delivery.event_projector !== null
    || delivery.test_envelope !== null
    || delivery.admission_method_label !== null
    || delivery.runtime_error_label !== null
    || delivery.test_signing_credential !== null
    || delivery.mechanism.signature_header.kind !== 'fixed'
    || delivery.mechanism.signature_header.name
      === eventNormalizer.event_type_header
    || eventProjector.provider_event_id_field !== 'event_id'
    || eventProjector.provider_resource_id_field !== 'resource_id'
    || eventProjector.provider_event_type_field !== 'event_type'
    || eventProjector.provider_occurred_at_field !== 'occurred_at'
    || eventProjector.decoded_payload_field !== 'payload'
    || eventProjector.occurred_at_unit !== 'unix_milliseconds.v1'
    || !/^[a-z][a-z0-9._-]{0,127}$/.test(admissionMethodLabel)) {
    throw new Error(
      `webhook JSON:API single-event preset '${profile_id}' does not match its descriptor`,
    );
  }
  const value = Object.freeze({
    profile_id,
    delivery,
    event_type_parser: eventTypeParser.preset,
    event_normalizer: eventNormalizer,
    delivery_deduplicator: deliveryDeduplicator,
    event_projector: eventProjector,
    admission_method_label: admissionMethodLabel,
    supported_environments: Object.freeze([
      ...descriptor.supported_environments,
    ]),
  });
  JSON.stringify(value);
  return value;
};

const PRESET_LIST = [
  preset('lemonsqueezy.webhook.v1', {
    kind: 'lowercase_identifier_event_type.v1',
    max_characters: 128,
  }, {
    kind: 'json_api_single_event.v1',
    event_type_header: 'x-event-name',
    metadata_field: 'meta',
    event_type_field: 'event_name',
    data_field: 'data',
    resource_type_field: 'type',
    resource_id_field: 'id',
    max_resource_type_bytes: 128,
    max_resource_id_bytes: 512,
  }, {
    kind: 'received_at_body_sha256_window.v1',
    key_prefix: 'lemonsqueezy:request:',
    window_ms: 5 * 60 * 1_000,
    max_body_bytes: 1_048_576,
  }, {
    kind: 'normalized_single_event.v1',
    provider_event_id_field: 'event_id',
    provider_resource_id_field: 'resource_id',
    provider_event_type_field: 'event_type',
    provider_occurred_at_field: 'occurred_at',
    decoded_payload_field: 'payload',
    occurred_at_unit: 'unix_milliseconds.v1',
  }, 'lemonsqueezy-hmac-sha256'),
] as const;

const mutable = Object.create(null) as Record<
  WebhookProfileId,
  WebhookJsonApiSingleEventProfilePreset | undefined
>;
for (const value of PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(mutable, value.profile_id)) {
    throw new Error(
      `duplicate webhook JSON:API single-event preset '${value.profile_id}'`,
    );
  }
  mutable[value.profile_id] = value;
}

export const WEBHOOK_JSON_API_SINGLE_EVENT_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookJsonApiSingleEventProfilePreset>>
> = Object.freeze(mutable);

export const webhookJsonApiSingleEventProfilePreset = (
  profileId: WebhookProfileId,
): WebhookJsonApiSingleEventProfilePreset | null =>
  WEBHOOK_JSON_API_SINGLE_EVENT_PROFILE_PRESETS[profileId] ?? null;
