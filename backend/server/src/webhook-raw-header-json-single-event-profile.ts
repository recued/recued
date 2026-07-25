/** D-201 Slice 9W — neutral raw-header JSON single-event composition.
 *
 * A trusted profile id selects the already code-backed raw-body HMAC,
 * raw-header metadata, bounded JSON, delivery deduplication, event
 * normalization/projection, parser, and test-envelope engines. This composer
 * fixes their execution order and failure mapping without containing a vendor
 * id, header/field name, signature grammar, key namespace, or payload shape.
 */

import {
  webhookProfile,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  webhookRawBodyHmacDeliveryProfilePreset,
  type WebhookRawBodyHmacDeliveryProfilePreset,
} from './webhook-delivery-engine-presets.js';
import { createWebhookCanonicalUuidParser } from './webhook-canonical-uuid-parser.js';
import { createWebhookJsonObjectDecoder } from './webhook-json-object-decoder.js';
import { createWebhookLowercaseIdentifierEventTypeParser } from './webhook-lowercase-identifier-event-type-parser.js';
import { createWebhookMetadataPayloadSingleEventNormalizer } from './webhook-metadata-payload-single-event-normalizer.js';
import { createWebhookNormalizedDeliveryDeduplicator } from './webhook-normalized-delivery-deduplicator.js';
import { createWebhookNormalizedSingleEventProjector } from './webhook-normalized-event-projector.js';
import { createWebhookPositiveDecimalIdentifierParser } from './webhook-positive-decimal-identifier-parser.js';
import { createWebhookRawBodyHmacMechanism } from './webhook-raw-body-hmac-engine.js';
import { createWebhookRawHeaderJsonSingleEventTestEnvelopeBuilder } from './webhook-raw-header-json-single-event-test-envelope.js';
import { createWebhookRawHeaderSingleEventMetadataNormalizer } from './webhook-raw-header-single-event-metadata-normalizer.js';
import type {
  RawWebhookRequest,
  WebhookIngressProfileAdapter,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
  WebhookProfileTestDeliveryInput,
  WebhookProfileTestDeliveryRequest,
} from './webhook-profile-runtime.js';
import {
  webhookCanonicalUuidProfilePreset,
  webhookLowercaseIdentifierEventTypeProfilePreset,
  webhookPositiveDecimalStructuralEvidenceProfilePreset,
  type WebhookCanonicalUuidProfilePreset,
  type WebhookLowercaseIdentifierEventTypeProfilePreset,
  type WebhookPositiveDecimalStructuralEvidenceProfilePreset,
} from './webhook-shared-profile-parser-presets.js';

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

type CompleteRawHeaderJsonSingleEventDelivery =
  WebhookRawBodyHmacDeliveryProfilePreset & Readonly<{
    raw_header_metadata: NonNullable<
      WebhookRawBodyHmacDeliveryProfilePreset['raw_header_metadata']
    >;
    delivery_deduplicator: NonNullable<
      WebhookRawBodyHmacDeliveryProfilePreset['delivery_deduplicator']
    >;
    metadata_payload_event_normalizer: NonNullable<
      WebhookRawBodyHmacDeliveryProfilePreset[
        'metadata_payload_event_normalizer'
      ]
    >;
    event_projector: NonNullable<
      WebhookRawBodyHmacDeliveryProfilePreset['event_projector']
    >;
    test_envelope: NonNullable<
      WebhookRawBodyHmacDeliveryProfilePreset['test_envelope']
    >;
    admission_method_label: string;
    runtime_error_label: string;
    test_signing_credential: 'oldest' | 'newest';
  }>;

interface RawHeaderJsonSingleEventPreset {
  readonly profile_id: WebhookProfileId;
  readonly delivery: CompleteRawHeaderJsonSingleEventDelivery;
  readonly delivery_id: WebhookCanonicalUuidProfilePreset;
  readonly event_type: WebhookLowercaseIdentifierEventTypeProfilePreset;
  readonly structural_evidence:
    WebhookPositiveDecimalStructuralEvidenceProfilePreset;
  readonly supported_environments: readonly string[];
}

const rawHeaderJsonSingleEventPreset = (
  profileId: WebhookProfileId,
): RawHeaderJsonSingleEventPreset => {
  const descriptor = webhookProfile(profileId);
  const delivery = webhookRawBodyHmacDeliveryProfilePreset(profileId);
  const deliveryId = webhookCanonicalUuidProfilePreset(profileId);
  const eventType = webhookLowercaseIdentifierEventTypeProfilePreset(profileId);
  const structuralEvidence =
    webhookPositiveDecimalStructuralEvidenceProfilePreset(profileId);
  if (descriptor === null
    || descriptor.mechanism_kind !== 'raw_body_hmac'
    || descriptor.transport_assurance !== 'authenticated'
    || descriptor.decoder_kind !== 'json'
    || descriptor.max_events_per_delivery !== 1
    || descriptor.handshakes.length !== 0
    || !descriptor.supported_environments.includes('test')
    || delivery === null
    || delivery.raw_header_metadata === null
    || delivery.delivery_deduplicator === null
    || delivery.metadata_payload_event_normalizer === null
    || delivery.event_projector === null
    || delivery.test_envelope === null
    || delivery.admission_method_label === null
    || delivery.runtime_error_label === null
    || delivery.test_signing_credential === null
    || deliveryId === null
    || eventType === null
    || structuralEvidence === null) {
    throw new Error(
      `webhook raw-header JSON single-event profile '${profileId}' is unavailable`,
    );
  }
  return Object.freeze({
    profile_id: profileId,
    delivery: delivery as CompleteRawHeaderJsonSingleEventDelivery,
    delivery_id: deliveryId,
    event_type: eventType,
    structural_evidence: structuralEvidence,
    supported_environments: Object.freeze([
      ...descriptor.supported_environments,
    ]),
  });
};

export const createRawHeaderJsonSingleEventWebhookCredentialShapeValidator = (
  profileId: WebhookProfileId,
): ((credentials: Readonly<Record<string, string>>) => boolean) => {
  const mechanism = createWebhookRawBodyHmacMechanism(
    rawHeaderJsonSingleEventPreset(profileId).delivery.mechanism,
  );
  return Object.freeze((
    credentials: Readonly<Record<string, string>>,
  ): boolean => mechanism.validateCredentialShape(credentials));
};

export const createRawHeaderJsonSingleEventWebhookProfileAdapter = (
  profileId: WebhookProfileId,
): WebhookIngressProfileAdapter => {
  const preset = rawHeaderJsonSingleEventPreset(profileId);
  const mechanism = createWebhookRawBodyHmacMechanism(
    preset.delivery.mechanism,
  );
  const decoder = createWebhookJsonObjectDecoder(preset.delivery.decoder);
  const deliveryIdParser = createWebhookCanonicalUuidParser(
    preset.delivery_id.parser,
  );
  const eventTypeParser = createWebhookLowercaseIdentifierEventTypeParser(
    preset.event_type.parser,
  );
  const structuralEvidenceParser = createWebhookPositiveDecimalIdentifierParser(
    preset.structural_evidence.parser,
  );
  const parserDependencies = Object.freeze({
    delivery_id_parser: deliveryIdParser,
    event_type_parser: eventTypeParser,
    structural_evidence_parser: structuralEvidenceParser,
  });
  const metadataNormalizer =
    createWebhookRawHeaderSingleEventMetadataNormalizer(
      preset.delivery.raw_header_metadata,
      parserDependencies,
    );
  const deduplicator = createWebhookNormalizedDeliveryDeduplicator(
    preset.delivery.delivery_deduplicator,
  );
  const eventNormalizer = createWebhookMetadataPayloadSingleEventNormalizer(
    preset.delivery.metadata_payload_event_normalizer,
  );
  const projector = createWebhookNormalizedSingleEventProjector(
    preset.delivery.event_projector,
  );
  const testEnvelope =
    createWebhookRawHeaderJsonSingleEventTestEnvelopeBuilder(
      preset.delivery.test_envelope,
      preset.delivery.decoder,
      preset.delivery.raw_header_metadata,
      parserDependencies,
    );
  const runtimeError = (message: string): Error =>
    new Error(`${preset.delivery.runtime_error_label} ${message}`);

  const buildTestDelivery = (
    input: WebhookProfileTestDeliveryInput,
    context: WebhookProfileRuntimeContext,
  ): WebhookProfileTestDeliveryRequest => {
    if (!mechanism.hasValidConfiguration(context)
      || context.environment !== 'test') {
      throw runtimeError('test configuration is unavailable');
    }
    const built = testEnvelope.build({
      nonce: input.nonce,
      event_type: input.selected_event_types[0],
    });
    if (!built.ok) {
      throw runtimeError(built.reason === 'invalid_nonce'
        ? 'test delivery nonce is invalid'
        : 'selected test event is invalid');
    }
    const signature = mechanism.sign(
      built.raw_body,
      context,
      preset.delivery.test_signing_credential,
    );
    if (signature === null) {
      built.raw_body.fill(0);
      throw runtimeError('test configuration is unavailable');
    }
    const headers = Object.create(null) as Record<string, string>;
    headers[signature.header_name] = signature.header_value;
    for (const [name, value] of Object.entries(built.headers)) {
      headers[name] = value;
    }
    return { raw_body: built.raw_body, headers };
  };

  return Object.freeze({
    profile_id: preset.profile_id,
    success_response: SUCCESS_RESPONSE,
    buildTestDelivery,
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
      const metadata = metadataNormalizer.normalize(request.headers);
      if (metadata === null) return structuralFailure();
      const payload = decoder.decode(request.raw_body);
      if (payload === null) return structuralFailure();
      const deduplication = deduplicator.deduplicate(
        metadata,
        '',
        request.raw_body,
      );
      if (deduplication === null) return structuralFailure();
      const normalizedEvent = eventNormalizer.normalize(metadata, payload);
      if (normalizedEvent === null) return structuralFailure();
      const event = projector.project(
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
