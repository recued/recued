/** D-201 Slice 8X — neutral form-only timestamped single-event adapter.
 *
 * Trusted preset data selects the already code-backed timestamped-HMAC,
 * form decoder, flat-event normalizer, projector, and deduplicator engines.
 * This wrapper owns their fixed authentication-before-decode order, failure
 * mapping, empty 200 acknowledgement, admission label, and clock gating. It
 * contains no vendor id, header name, field name, signature grammar, or
 * payload-redaction choice.
 */

import type { WebhookProfileId } from '@recued/contracts';
import {
  readTrustedWebhookClockNow,
  type WebhookClockHealthAuthority,
} from './webhook-clock-health.js';
import {
  webhookTimestampedHmacDeliveryProfilePreset,
  type WebhookTimestampedHmacDeliveryProfilePreset,
} from './webhook-delivery-engine-presets.js';
import { createWebhookFlatFormEventNormalizer } from './webhook-flat-form-event-normalizer.js';
import { createWebhookFormUrlencodedDecoder } from './webhook-form-urlencoded-decoder.js';
import { createWebhookNormalizedDeliveryDeduplicator } from './webhook-normalized-delivery-deduplicator.js';
import { createWebhookNormalizedSingleEventProjector } from './webhook-normalized-event-projector.js';
import type {
  RawWebhookRequest,
  WebhookIngressProfileAdapter,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
} from './webhook-profile-runtime.js';
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

type FormOnlyPreset = WebhookTimestampedHmacDeliveryProfilePreset & Readonly<{
  decoder: null;
  form_decoder: NonNullable<
    WebhookTimestampedHmacDeliveryProfilePreset['form_decoder']
  >;
  form_json_envelope: null;
  flat_form_event_normalizer: NonNullable<
    WebhookTimestampedHmacDeliveryProfilePreset['flat_form_event_normalizer']
  >;
  handshake: null;
  event_projector: NonNullable<
    WebhookTimestampedHmacDeliveryProfilePreset['event_projector']
  >;
  delivery_deduplicator: NonNullable<
    WebhookTimestampedHmacDeliveryProfilePreset['delivery_deduplicator']
  >;
  event_normalizer: null;
  test_envelope: null;
}>;

const formOnlyPreset = (profileId: WebhookProfileId): FormOnlyPreset => {
  const preset = webhookTimestampedHmacDeliveryProfilePreset(profileId);
  if (preset === null
    || preset.decoder !== null
    || preset.form_decoder === null
    || preset.form_json_envelope !== null
    || preset.flat_form_event_normalizer === null
    || preset.handshake !== null
    || preset.event_projector === null
    || preset.delivery_deduplicator === null
    || preset.event_normalizer !== null
    || preset.test_envelope !== null) {
    throw new Error(
      `webhook timestamped form profile '${profileId}' is unavailable`,
    );
  }
  return preset as FormOnlyPreset;
};

export const createTimestampedFormWebhookCredentialShapeValidator = (
  profileId: WebhookProfileId,
): ((credentials: Readonly<Record<string, string>>) => boolean) => {
  const mechanism = createWebhookTimestampedHmacMechanism(
    formOnlyPreset(profileId).mechanism,
  );
  return Object.freeze((
    credentials: Readonly<Record<string, string>>,
  ): boolean => mechanism.validateCredentialShape(credentials));
};

const exactContentType = (request: RawWebhookRequest): boolean => {
  const values = request.headers.get('content-type');
  if (values?.length !== 1 || typeof values[0] !== 'string') return false;
  return values[0].split(';', 1)[0]!.trim().toLowerCase()
    === 'application/x-www-form-urlencoded';
};

/** Pure adapter for protocol fixtures. Production composition must use the
 * clock-gated wrapper below so caller-controlled wall time is never freshness
 * authority.
 */
export const createTimestampedFormWebhookProfileAdapter = (
  profileId: WebhookProfileId,
): WebhookIngressProfileAdapter => {
  const preset = formOnlyPreset(profileId);
  const mechanism = createWebhookTimestampedHmacMechanism(preset.mechanism);
  const decoder = createWebhookFormUrlencodedDecoder(preset.form_decoder);
  const normalizer = createWebhookFlatFormEventNormalizer(
    preset.flat_form_event_normalizer,
  );
  const projector = createWebhookNormalizedSingleEventProjector(
    preset.event_projector,
  );
  const deduplicator = createWebhookNormalizedDeliveryDeduplicator(
    preset.delivery_deduplicator,
  );

  return Object.freeze({
    profile_id: preset.profile_id,
    success_response: SUCCESS_RESPONSE,
    async verifyAndDecode(
      request: RawWebhookRequest,
      context: WebhookProfileRuntimeContext,
    ): Promise<WebhookProfileResult> {
      const authentication = mechanism.authenticate(request, context);
      if (!authentication.ok) {
        return authentication.reason === 'configuration_failed'
          ? configurationFailure()
          : authenticationFailure();
      }
      if (!exactContentType(request)) return structuralFailure();
      const fields = decoder.decode(request.raw_body);
      const normalized = normalizer.normalize(fields);
      if (normalized === null) return structuralFailure();
      const deduplication = deduplicator.deduplicate(
        normalized,
        authentication.timestamp_literal,
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
          decoded_content_type: 'application/x-www-form-urlencoded',
          events: [event],
          response: SUCCESS_RESPONSE,
          admission: {
            transport_assurance: 'authenticated',
            credential_version: authentication.credential_version,
            freshness_checked: true,
            method_label: 'timestamped-hmac-sha256',
          },
        },
      };
    },
  });
};

export const createClockGatedTimestampedFormWebhookProfileAdapter = (
  profileId: WebhookProfileId,
  authority: WebhookClockHealthAuthority,
): WebhookIngressProfileAdapter => {
  const adapter = createTimestampedFormWebhookProfileAdapter(profileId);
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
