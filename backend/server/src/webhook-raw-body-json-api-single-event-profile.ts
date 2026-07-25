/** D-201 Slice 9BQ — neutral raw-HMAC JSON:API single-event composition.
 *
 * A trusted profile id selects closed mechanism, decoder, parser, envelope,
 * deduplication, and projection presets. This composer fixes execution order
 * and failure mapping without containing a vendor id, field/header spelling,
 * digest presentation, event grammar, namespace, or payload transform.
 */

import type { WebhookProfileId } from '@recued/contracts';
import { createWebhookJsonApiSingleEventNormalizer } from './webhook-json-api-single-event-normalizer.js';
import { createWebhookJsonObjectDecoder } from './webhook-json-object-decoder.js';
import {
  webhookJsonApiSingleEventProfilePreset,
} from './webhook-json-api-single-event-profile-presets.js';
import { createWebhookLowercaseIdentifierEventTypeParser } from './webhook-lowercase-identifier-event-type-parser.js';
import { createWebhookNormalizedSingleEventProjector } from './webhook-normalized-event-projector.js';
import { createWebhookRawBodyHmacMechanism } from './webhook-raw-body-hmac-engine.js';
import { createWebhookReceivedAtBodyDeduplicator } from './webhook-received-at-body-deduplicator.js';
import type {
  RawWebhookRequest,
  WebhookIngressProfileAdapter,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
} from './webhook-profile-runtime.js';

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

const requiredPreset = (profileId: WebhookProfileId) => {
  const preset = webhookJsonApiSingleEventProfilePreset(profileId);
  if (preset === null) {
    throw new Error(
      `webhook raw-HMAC JSON:API single-event profile '${profileId}' is unavailable`,
    );
  }
  return preset;
};

export const createRawBodyJsonApiSingleEventWebhookCredentialShapeValidator = (
  profileId: WebhookProfileId,
): ((credentials: Readonly<Record<string, string>>) => boolean) => {
  const mechanism = createWebhookRawBodyHmacMechanism(
    requiredPreset(profileId).delivery.mechanism,
  );
  return Object.freeze((
    credentials: Readonly<Record<string, string>>,
  ): boolean => mechanism.validateCredentialShape(credentials));
};

export const createRawBodyJsonApiSingleEventWebhookProfileAdapter = (
  profileId: WebhookProfileId,
): WebhookIngressProfileAdapter => {
  const preset = requiredPreset(profileId);
  const mechanism = createWebhookRawBodyHmacMechanism(
    preset.delivery.mechanism,
  );
  const decoder = createWebhookJsonObjectDecoder(preset.delivery.decoder);
  const eventTypeParser = createWebhookLowercaseIdentifierEventTypeParser(
    preset.event_type_parser,
  );
  const eventNormalizer = createWebhookJsonApiSingleEventNormalizer(
    preset.event_normalizer,
    eventTypeParser,
  );
  const deliveryDeduplicator = createWebhookReceivedAtBodyDeduplicator(
    preset.delivery_deduplicator,
  );
  const eventProjector = createWebhookNormalizedSingleEventProjector(
    preset.event_projector,
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
      const normalized = eventNormalizer.normalize(request.headers, envelope);
      if (normalized === null) return structuralFailure();
      const deduplication = deliveryDeduplicator.deduplicate(
        request.received_at,
        request.raw_body,
      );
      if (deduplication === null) return structuralFailure();
      const event = eventProjector.project(
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
            freshness_checked: false,
            method_label: preset.admission_method_label,
          },
        },
      };
    },
  });
};
