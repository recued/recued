/** D-201 Slice 9AD — neutral timestamped JSON/form single-event composition.
 *
 * A trusted profile id selects the already code-backed timestamped HMAC,
 * bounded JSON/form decoding, wrapped-JSON classification, flat-form and JSON
 * normalization, challenge projection, delivery deduplication, and event
 * projection engines. This composer fixes content routing, execution order,
 * failure mapping, handshake admission, and trusted-clock gating without a
 * vendor id, vendor-specific header/field name, signature grammar, key
 * namespace, or payload shape.
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
  webhookTimestampedHmacDeliveryProfilePreset,
  type WebhookTimestampedHmacDeliveryProfilePreset,
} from './webhook-delivery-engine-presets.js';
import { createWebhookFlatFormEventNormalizer } from './webhook-flat-form-event-normalizer.js';
import { createWebhookFormUrlencodedDecoder } from './webhook-form-urlencoded-decoder.js';
import { createWebhookFormWrappedJsonDecoder } from './webhook-form-wrapped-json-decoder.js';
import {
  createWebhookJsonChallengeProjector,
  type WebhookJsonChallengeClassification,
  type WebhookJsonChallengeProjection,
} from './webhook-json-challenge-projector.js';
import {
  createWebhookJsonEventNormalizer,
  type WebhookNormalizedJsonEvent,
} from './webhook-json-event-normalizer.js';
import { createWebhookJsonObjectDecoder } from './webhook-json-object-decoder.js';
import { createWebhookNormalizedDeliveryDeduplicator } from './webhook-normalized-delivery-deduplicator.js';
import { createWebhookNormalizedSingleEventProjector } from './webhook-normalized-event-projector.js';
import type {
  RawWebhookRequest,
  WebhookHandshakeResult,
  WebhookIngressProfileAdapter,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
} from './webhook-profile-runtime.js';
import { WebhookProfileDependencyUnavailableError } from './webhook-profile-runtime.js';
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

type CompleteTimestampedJsonFormSingleEventPreset =
  WebhookTimestampedHmacDeliveryProfilePreset & Readonly<{
    decoder: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['decoder']
    >;
    form_decoder: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['form_decoder']
    >;
    form_json_envelope: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['form_json_envelope']
    >;
    flat_form_event_normalizer: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset[
        'flat_form_event_normalizer'
      ]
    >;
    handshake: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['handshake']
    >;
    event_projector: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['event_projector']
    >;
    delivery_deduplicator: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['delivery_deduplicator']
    >;
    event_normalizer: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['event_normalizer']
    >;
    environment_admission: null;
    test_envelope: null;
    admission_method_label: string;
    runtime_error_label: string;
  }>;

const timestampedJsonFormSingleEventPreset = (
  profileId: WebhookProfileId,
): CompleteTimestampedJsonFormSingleEventPreset => {
  const descriptor = webhookProfile(profileId);
  const preset = webhookTimestampedHmacDeliveryProfilePreset(profileId);
  if (descriptor === null
    || descriptor.mechanism_kind !== 'timestamped_hmac'
    || descriptor.transport_assurance !== 'authenticated'
    || descriptor.decoder_kind !== 'json'
    || descriptor.max_events_per_delivery !== 1
    || descriptor.handshakes.length !== 1
    || preset === null
    || preset.decoder === null
    || preset.form_decoder === null
    || preset.form_json_envelope === null
    || preset.flat_form_event_normalizer === null
    || preset.handshake === null
    || preset.event_projector === null
    || preset.delivery_deduplicator === null
    || preset.event_normalizer === null
    || preset.environment_admission !== null
    || preset.test_envelope !== null
    || preset.admission_method_label === null
    || preset.runtime_error_label === null) {
    throw new Error(
      `webhook timestamped JSON/form single-event profile '${profileId}' is unavailable`,
    );
  }
  return preset as CompleteTimestampedJsonFormSingleEventPreset;
};

export const createTimestampedJsonFormSingleEventWebhookCredentialShapeValidator = (
  profileId: WebhookProfileId,
): ((credentials: Readonly<Record<string, string>>) => boolean) => {
  const mechanism = createWebhookTimestampedHmacMechanism(
    timestampedJsonFormSingleEventPreset(profileId).mechanism,
  );
  return Object.freeze((
    credentials: Readonly<Record<string, string>>,
  ): boolean => mechanism.validateCredentialShape(credentials));
};

type RoutedContentType =
  | 'application/json'
  | 'application/x-www-form-urlencoded';

const requestContentType = (
  request: RawWebhookRequest,
): RoutedContentType | null => {
  const values = request.headers.get('content-type');
  if (values?.length !== 1 || typeof values[0] !== 'string') return null;
  const normalized = values[0].split(';', 1)[0]!.trim().toLowerCase();
  return normalized === 'application/json'
    || normalized === 'application/x-www-form-urlencoded'
    ? normalized
    : null;
};

interface TimestampedJsonFormSingleEventRuntime {
  readonly adapter: WebhookIngressProfileAdapter;
  classifyHandshake(
    request: RawWebhookRequest,
  ): WebhookJsonChallengeClassification | null;
  projectHandshake(
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
    projection: WebhookJsonChallengeProjection,
  ): WebhookHandshakeResult | null;
  readonly runtime_error_label: string;
}

const createTimestampedJsonFormSingleEventRuntime = (
  profileId: WebhookProfileId,
): TimestampedJsonFormSingleEventRuntime => {
  const preset = timestampedJsonFormSingleEventPreset(profileId);
  const mechanism = createWebhookTimestampedHmacMechanism(preset.mechanism);
  const jsonDecoder = createWebhookJsonObjectDecoder(preset.decoder);
  const formDecoder = createWebhookFormUrlencodedDecoder(preset.form_decoder);
  const formJsonEnvelope = createWebhookFormWrappedJsonDecoder(
    preset.form_json_envelope,
  );
  const flatFormEventNormalizer = createWebhookFlatFormEventNormalizer(
    preset.flat_form_event_normalizer,
  );
  const challengeProjector = createWebhookJsonChallengeProjector(
    preset.handshake.projector,
  );
  const eventNormalizer = createWebhookJsonEventNormalizer(
    preset.event_normalizer,
  );
  const deduplicator = createWebhookNormalizedDeliveryDeduplicator(
    preset.delivery_deduplicator,
  );
  const projector = createWebhookNormalizedSingleEventProjector(
    preset.event_projector,
  );

  const decodeJson = (rawBody: Buffer): WebhookNormalizedJsonEvent | null => {
    const envelope = jsonDecoder.decode(rawBody);
    return envelope === null ? null : eventNormalizer.normalize(envelope);
  };

  const decodeForm = (rawBody: Buffer): WebhookNormalizedJsonEvent | null => {
    const fields = formDecoder.decode(rawBody);
    if (fields === null) return null;
    const wrapped = formJsonEnvelope.classify(fields, jsonDecoder);
    if (wrapped.kind === 'matched_invalid') return null;
    return wrapped.kind === 'matched'
      ? eventNormalizer.normalize(wrapped.envelope)
      : flatFormEventNormalizer.normalize(fields);
  };

  const classifyHandshake = (
    request: RawWebhookRequest,
  ): WebhookJsonChallengeClassification | null => {
    if (requestContentType(request) !== 'application/json') return null;
    const decoded = decodeJson(request.raw_body);
    return decoded === null ? null : challengeProjector.classify(decoded.payload);
  };

  const projectHandshake = (
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
    projection: WebhookJsonChallengeProjection,
  ): WebhookHandshakeResult | null => {
    const authentication = mechanism.authenticate(request, context);
    if (!authentication.ok) {
      if (authentication.reason === 'configuration_failed') {
        throw new Error(
          `${preset.runtime_error_label} profile credentials are unavailable`,
        );
      }
      return null;
    }
    return {
      ...projection,
      admission: {
        transport_assurance: 'authenticated',
        credential_version: authentication.credential_version,
        freshness_checked: true,
        method_label: preset.admission_method_label,
      },
    };
  };

  const adapter: WebhookIngressProfileAdapter = Object.freeze({
    profile_id: preset.profile_id,
    success_response: SUCCESS_RESPONSE,
    async handleHandshake(
      request: RawWebhookRequest,
      context: WebhookProfileRuntimeContext,
    ) {
      const classified = classifyHandshake(request);
      return classified?.kind === 'matched'
        ? projectHandshake(request, context, classified.projection)
        : null;
    },
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
      const contentType = requestContentType(request);
      const normalized = contentType === 'application/json'
        ? decodeJson(request.raw_body)
        : contentType === 'application/x-www-form-urlencoded'
          ? decodeForm(request.raw_body)
          : null;
      if (normalized === null
        || challengeProjector.classify(normalized.payload).kind
          !== 'not_matched') {
        return structuralFailure();
      }
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
          decoded_content_type: 'application/json',
          events: [event],
          response: SUCCESS_RESPONSE,
          admission: {
            transport_assurance: 'authenticated',
            credential_version: authentication.credential_version,
            freshness_checked: true,
            method_label: preset.admission_method_label,
          },
        },
      };
    },
  });

  return Object.freeze({
    adapter,
    classifyHandshake,
    projectHandshake,
    runtime_error_label: preset.runtime_error_label,
  });
};

/** Pure adapter for protocol fixtures. Production composition must use the
 * clock-gated wrapper below so caller-controlled wall time is never freshness
 * authority.
 */
export const createTimestampedJsonFormSingleEventWebhookProfileAdapter = (
  profileId: WebhookProfileId,
): WebhookIngressProfileAdapter =>
  createTimestampedJsonFormSingleEventRuntime(profileId).adapter;

export const createClockGatedTimestampedJsonFormSingleEventWebhookProfileAdapter = (
  profileId: WebhookProfileId,
  authority: WebhookClockHealthAuthority,
): WebhookIngressProfileAdapter => {
  const runtime = createTimestampedJsonFormSingleEventRuntime(profileId);
  return Object.freeze({
    profile_id: runtime.adapter.profile_id,
    success_response: runtime.adapter.success_response,
    async handleHandshake(
      request: RawWebhookRequest,
      context: WebhookProfileRuntimeContext,
    ) {
      const classified = runtime.classifyHandshake(request);
      if (classified === null || classified.kind === 'not_matched') return null;
      const now = await readTrustedWebhookClockNow(authority);
      if (now === null) {
        throw new WebhookProfileDependencyUnavailableError(
          `${runtime.runtime_error_label} trusted clock is unavailable`,
        );
      }
      return classified.kind === 'matched'
        ? runtime.projectHandshake(request, {
            ...context,
            now: () => now,
          }, classified.projection)
        : null;
    },
    async verifyAndDecode(
      request: RawWebhookRequest,
      context: WebhookProfileRuntimeContext,
    ) {
      const now = await readTrustedWebhookClockNow(authority);
      if (now === null) return dependencyFailure();
      return runtime.adapter.verifyAndDecode(request, {
        ...context,
        now: () => now,
      });
    },
  });
};
