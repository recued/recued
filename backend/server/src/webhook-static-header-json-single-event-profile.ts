/** D-201 Slice 9AC — neutral static-header JSON single-event composition.
 *
 * A trusted profile id selects the already code-backed static token,
 * bounded-JSON, single-member normalization, delivery deduplication, and
 * normalized projection engines. This composer fixes their execution order,
 * failure mapping, empty acknowledgement, and admission evidence without
 * containing a vendor id, header/field name, token grammar, key namespace, or
 * payload shape.
 */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  webhookStaticHeaderTokenDeliveryProfilePreset,
  type WebhookStaticHeaderTokenDeliveryProfilePreset,
} from './webhook-delivery-engine-presets.js';
import { createWebhookJsonObjectDecoder } from './webhook-json-object-decoder.js';
import { createWebhookJsonSingleMemberEventNormalizer } from './webhook-json-single-member-event-normalizer.js';
import { createWebhookNormalizedDeliveryDeduplicator } from './webhook-normalized-delivery-deduplicator.js';
import { createWebhookNormalizedSingleEventProjector } from './webhook-normalized-event-projector.js';
import type {
  RawWebhookRequest,
  WebhookIngressProfileAdapter,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
} from './webhook-profile-runtime.js';
import { createWebhookStaticHeaderTokenMechanism } from './webhook-static-header-token-engine.js';

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

type CompleteStaticHeaderJsonSingleEventDelivery =
  WebhookStaticHeaderTokenDeliveryProfilePreset & Readonly<{
    event_normalizer: NonNullable<
      WebhookStaticHeaderTokenDeliveryProfilePreset['event_normalizer']
    >;
    delivery_deduplicator: NonNullable<
      WebhookStaticHeaderTokenDeliveryProfilePreset['delivery_deduplicator']
    >;
    event_projector: NonNullable<
      WebhookStaticHeaderTokenDeliveryProfilePreset['event_projector']
    >;
    admission_method_label: string;
  }>;

interface StaticHeaderJsonSingleEventPreset {
  readonly profile_id: WebhookProfileId;
  readonly delivery: CompleteStaticHeaderJsonSingleEventDelivery;
  readonly supported_environments: readonly string[];
}

const staticHeaderJsonSingleEventPreset = (
  profileId: WebhookProfileId,
): StaticHeaderJsonSingleEventPreset => {
  const descriptor = webhookProfile(profileId);
  const delivery = webhookStaticHeaderTokenDeliveryProfilePreset(profileId);
  if (descriptor === null
    || descriptor.mechanism_kind !== 'static_header_token'
    || descriptor.transport_assurance !== 'authenticated'
    || descriptor.decoder_kind !== 'json'
    || descriptor.max_events_per_delivery !== 1
    || descriptor.handshakes.length !== 0
    || delivery === null
    || delivery.event_normalizer === null
    || delivery.delivery_deduplicator === null
    || delivery.event_projector === null
    || delivery.admission_method_label === null) {
    throw new Error(
      `webhook static-header JSON single-event profile '${profileId}' is unavailable`,
    );
  }
  return Object.freeze({
    profile_id: profileId,
    delivery: delivery as CompleteStaticHeaderJsonSingleEventDelivery,
    supported_environments: Object.freeze([
      ...descriptor.supported_environments,
    ]),
  });
};

export const createStaticHeaderJsonSingleEventWebhookCredentialShapeValidator = (
  profileId: WebhookProfileId,
): ((credentials: Readonly<Record<string, string>>) => boolean) => {
  const mechanism = createWebhookStaticHeaderTokenMechanism(
    staticHeaderJsonSingleEventPreset(profileId).delivery.mechanism,
  );
  return Object.freeze((
    credentials: Readonly<Record<string, string>>,
  ): boolean => mechanism.validateCredentialShape(credentials));
};

export const createStaticHeaderJsonSingleEventWebhookProfileAdapter = (
  profileId: WebhookProfileId,
): WebhookIngressProfileAdapter => {
  const preset = staticHeaderJsonSingleEventPreset(profileId);
  const mechanism = createWebhookStaticHeaderTokenMechanism(
    preset.delivery.mechanism,
  );
  const decoder = createWebhookJsonObjectDecoder(preset.delivery.decoder);
  const eventNormalizer = createWebhookJsonSingleMemberEventNormalizer(
    preset.delivery.event_normalizer,
  );
  const deliveryDeduplicator = createWebhookNormalizedDeliveryDeduplicator(
    preset.delivery.delivery_deduplicator,
  );
  const eventProjector = createWebhookNormalizedSingleEventProjector(
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
      const envelope = decoder.decode(request.raw_body);
      if (envelope === null) return structuralFailure();
      const normalizedEvent = eventNormalizer.normalize(envelope);
      if (normalizedEvent === null) return structuralFailure();
      const deduplication = deliveryDeduplicator.deduplicate(
        normalizedEvent,
        '',
        request.raw_body,
      );
      if (deduplication === null) return structuralFailure();
      const event = eventProjector.project(
        normalizedEvent,
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
            freshness_checked: false,
            method_label: preset.delivery.admission_method_label,
          },
        },
      };
    },
  });
};
