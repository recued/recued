/** D-201 Slice 9O — neutral timestamped-HMAC JSON single-notification composition.
 *
 * A trusted profile id selects the already code-backed authentication, bounded
 * decoding, notification normalization, paired-id deduplication, event
 * projection, and clock-gating engines. This wrapper fixes their execution
 * order and failure mapping without containing a vendor id, header/field name,
 * signature grammar, event grammar, key namespace, or provider envelope shape.
 */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  readTrustedWebhookClockNow,
  type WebhookClockHealthAuthority,
} from './webhook-clock-health.js';
import {
  webhookJsonSingleNotificationProfilePreset,
  webhookPairedProviderIdProfilePreset,
  webhookRfc3339TimestampProfilePreset,
  webhookTimestampedHmacDeliveryProfilePreset,
  type WebhookJsonSingleNotificationProfilePreset,
  type WebhookPairedProviderIdProfilePreset,
  type WebhookRfc3339TimestampProfilePreset,
  type WebhookTimestampedHmacDeliveryProfilePreset,
} from './webhook-delivery-engine-presets.js';
import { createWebhookDotSegmentEventTypeParser } from './webhook-dot-segment-event-type-parser.js';
import { createWebhookFixedPrefixProviderIdParser } from './webhook-fixed-prefix-provider-id-parser.js';
import { createWebhookJsonObjectDecoder } from './webhook-json-object-decoder.js';
import { createWebhookJsonObjectProviderIdExtractor } from './webhook-json-object-provider-id-extractor.js';
import { createWebhookJsonRequiredObjectExtractor } from './webhook-json-required-object-extractor.js';
import { createWebhookJsonSingleNotificationNormalizer } from './webhook-json-single-notification-normalizer.js';
import { createWebhookNormalizedDeliveryDeduplicator } from './webhook-normalized-delivery-deduplicator.js';
import { createWebhookNormalizedSingleEventProjector } from './webhook-normalized-event-projector.js';
import type {
  RawWebhookRequest,
  WebhookIngressProfileAdapter,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
} from './webhook-profile-runtime.js';
import { createWebhookRfc3339TimestampParser } from './webhook-rfc3339-timestamp-parser.js';
import {
  webhookDotSegmentEventTypeProfilePreset,
  webhookJsonObjectProviderIdProfilePreset,
  webhookJsonRequiredObjectProfilePreset,
  type WebhookDotSegmentEventTypeProfilePreset,
  type WebhookJsonObjectProviderIdProfilePreset,
  type WebhookJsonRequiredObjectProfilePreset,
} from './webhook-shared-profile-parser-presets.js';
import { createWebhookTimestampedHmacMechanism } from './webhook-timestamped-hmac-engine.js';

const SUCCESS_RESPONSE = Object.freeze({ status: 200 } as const);

const authenticationFailure = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'reject',
    code: 'authentication_failed',
    response: { status: 401 },
  },
});

const structuralFailure = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'reject',
    code: 'structural_admission_failed',
    response: { status: 400 },
  },
});

const configurationFailure = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'retry',
    code: 'profile_internal_error',
    response: { status: 503 },
  },
});

const dependencyFailure = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'retry',
    code: 'profile_dependency_unavailable',
    response: { status: 503 },
  },
});

type TimestampedJsonSingleNotificationPreset = Readonly<{
  profile_id: WebhookProfileId;
  delivery: WebhookTimestampedHmacDeliveryProfilePreset & Readonly<{
    decoder: NonNullable<WebhookTimestampedHmacDeliveryProfilePreset['decoder']>;
    form_decoder: null;
    form_json_envelope: null;
    flat_form_event_normalizer: null;
    handshake: null;
    event_projector: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['event_projector']
    >;
    delivery_deduplicator: Extract<
      NonNullable<WebhookTimestampedHmacDeliveryProfilePreset['delivery_deduplicator']>,
      { kind: 'normalized_paired_ids_sha256.v1' }
    >;
    event_normalizer: null;
    environment_admission: null;
    test_envelope: null;
    admission_method_label: string;
  }>;
  timestamp: WebhookRfc3339TimestampProfilePreset;
  provider_ids: WebhookPairedProviderIdProfilePreset;
  event_type: WebhookDotSegmentEventTypeProfilePreset;
  resource_id: WebhookJsonObjectProviderIdProfilePreset;
  data_object: WebhookJsonRequiredObjectProfilePreset;
  notification: WebhookJsonSingleNotificationProfilePreset;
  supported_environments: readonly string[];
}>;

const timestampedJsonSingleNotificationPreset = (
  profileId: WebhookProfileId,
): TimestampedJsonSingleNotificationPreset => {
  const descriptor = webhookProfile(profileId);
  const delivery = webhookTimestampedHmacDeliveryProfilePreset(profileId);
  const timestamp = webhookRfc3339TimestampProfilePreset(profileId);
  const providerIds = webhookPairedProviderIdProfilePreset(profileId);
  const eventType = webhookDotSegmentEventTypeProfilePreset(profileId);
  const resourceId = webhookJsonObjectProviderIdProfilePreset(profileId);
  const dataObject = webhookJsonRequiredObjectProfilePreset(profileId);
  const notification = webhookJsonSingleNotificationProfilePreset(profileId);
  if (descriptor === null
    || descriptor.decoder_kind !== 'json'
    || descriptor.max_events_per_delivery !== 1
    || delivery === null
    || delivery.decoder === null
    || delivery.form_decoder !== null
    || delivery.form_json_envelope !== null
    || delivery.flat_form_event_normalizer !== null
    || delivery.handshake !== null
    || delivery.event_projector === null
    || delivery.event_projector.occurred_at_unit !== 'unix_milliseconds.v1'
    || delivery.delivery_deduplicator?.kind
      !== 'normalized_paired_ids_sha256.v1'
    || delivery.event_normalizer !== null
    || delivery.environment_admission !== null
    || delivery.test_envelope !== null
    || delivery.admission_method_label === null
    || timestamp === null
    || providerIds === null
    || eventType === null
    || resourceId === null
    || dataObject === null
    || notification === null) {
    throw new Error(
      `webhook timestamped JSON single-notification profile '${profileId}' is unavailable`,
    );
  }
  return Object.freeze({
    profile_id: profileId,
    delivery,
    timestamp,
    provider_ids: providerIds,
    event_type: eventType,
    resource_id: resourceId,
    data_object: dataObject,
    notification,
    supported_environments: Object.freeze([
      ...descriptor.supported_environments,
    ]),
  }) as TimestampedJsonSingleNotificationPreset;
};

export const createTimestampedJsonSingleNotificationWebhookCredentialShapeValidator = (
  profileId: WebhookProfileId,
): ((credentials: Readonly<Record<string, string>>) => boolean) => {
  const mechanism = createWebhookTimestampedHmacMechanism(
    timestampedJsonSingleNotificationPreset(profileId).delivery.mechanism,
  );
  return Object.freeze((
    credentials: Readonly<Record<string, string>>,
  ): boolean => mechanism.validateCredentialShape(credentials));
};

/** Pure adapter for protocol fixtures. Production composition must use the
 * clock-gated wrapper below so caller-controlled wall time is never freshness
 * authority.
 */
export const createTimestampedJsonSingleNotificationWebhookProfileAdapter = (
  profileId: WebhookProfileId,
): WebhookIngressProfileAdapter => {
  const preset = timestampedJsonSingleNotificationPreset(profileId);
  const mechanism = createWebhookTimestampedHmacMechanism(
    preset.delivery.mechanism,
  );
  const decoder = createWebhookJsonObjectDecoder(preset.delivery.decoder);
  const timestampParser = createWebhookRfc3339TimestampParser(
    preset.timestamp.parser,
  );
  const eventIdParser = createWebhookFixedPrefixProviderIdParser(
    preset.provider_ids.event_id,
  );
  const deliveryIdParser = createWebhookFixedPrefixProviderIdParser(
    preset.provider_ids.delivery_id,
  );
  const eventTypeParser = createWebhookDotSegmentEventTypeParser(
    preset.event_type.parser,
  );
  const resourceIdExtractor = createWebhookJsonObjectProviderIdExtractor(
    preset.resource_id.extractor,
  );
  const dataObjectExtractor = createWebhookJsonRequiredObjectExtractor(
    preset.data_object.extractor,
  );
  const normalizer = createWebhookJsonSingleNotificationNormalizer(
    preset.notification.normalizer,
    {
      decoder,
      event_id_parser: eventIdParser,
      delivery_id_parser: deliveryIdParser,
      event_type_parser: eventTypeParser,
      occurred_at_parser: timestampParser,
      data_object_extractor: dataObjectExtractor,
      resource_id_extractor: resourceIdExtractor,
    },
  );
  const deduplicator = createWebhookNormalizedDeliveryDeduplicator(
    preset.delivery.delivery_deduplicator,
  );
  const projector = createWebhookNormalizedSingleEventProjector(
    preset.delivery.event_projector,
  );

  return Object.freeze({
    profile_id: preset.profile_id,
    success_response: SUCCESS_RESPONSE,
    async verifyAndDecode(
      request: RawWebhookRequest,
      context: WebhookProfileRuntimeContext,
    ): Promise<WebhookProfileResult> {
      if (!mechanism.hasValidConfiguration(context)
        || !preset.supported_environments.includes(context.environment)) {
        return configurationFailure();
      }
      const authenticated = mechanism.authenticate(request, context);
      if (!authenticated.ok) {
        return authenticated.reason === 'configuration_failed'
          ? configurationFailure()
          : authenticationFailure();
      }
      const normalized = normalizer.normalize(request.raw_body);
      if (normalized === null) return structuralFailure();
      const deduplication = deduplicator.deduplicate(
        normalized,
        authenticated.timestamp_literal,
        request.raw_body,
      );
      if (deduplication === null) return structuralFailure();
      const event = projector.project(
        normalized,
        deduplication.event_dedup_key,
      );
      if (event === null) return structuralFailure();
      return {
        ok: true,
        delivery: {
          delivery_dedup_key: deduplication.delivery_dedup_key,
          decoded_content_type: 'application/json',
          events: [event],
          response: SUCCESS_RESPONSE,
          admission: {
            transport_assurance: 'authenticated',
            credential_version: authenticated.credential_version,
            freshness_checked: true,
            method_label: preset.delivery.admission_method_label,
          },
        },
      };
    },
  });
};

export const createClockGatedTimestampedJsonSingleNotificationWebhookProfileAdapter = (
  profileId: WebhookProfileId,
  authority: WebhookClockHealthAuthority,
): WebhookIngressProfileAdapter => {
  const adapter = createTimestampedJsonSingleNotificationWebhookProfileAdapter(
    profileId,
  );
  return Object.freeze({
    profile_id: adapter.profile_id,
    success_response: adapter.success_response,
    async verifyAndDecode(
      request: RawWebhookRequest,
      context: WebhookProfileRuntimeContext,
    ) {
      const now = await readTrustedWebhookClockNow(authority);
      if (now === null) return dependencyFailure();
      return adapter.verifyAndDecode(request, {
        ...context,
        now: () => now,
      });
    },
  });
};
