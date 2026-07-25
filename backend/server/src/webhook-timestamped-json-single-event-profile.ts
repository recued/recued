/** D-201 Slice 9D — neutral timestamped-HMAC JSON single-event composition.
 *
 * A trusted profile preset selects the already code-backed authentication,
 * JSON decoding, event normalization, environment admission, deduplication,
 * projection, and test-envelope engines. This wrapper fixes their execution
 * order, failure mapping, empty acknowledgement, and trusted-clock boundary.
 * It contains no vendor id, header/field name, signature grammar, fixture
 * shape, dedup namespace, or provider event semantics.
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
import { createWebhookJsonEnvironmentAdmission } from './webhook-json-environment-admission.js';
import { createWebhookJsonEventNormalizer } from './webhook-json-event-normalizer.js';
import { createWebhookJsonObjectDecoder } from './webhook-json-object-decoder.js';
import { createWebhookJsonSingleEventTestEnvelopeBuilder } from './webhook-json-single-event-test-envelope.js';
import { createWebhookNormalizedDeliveryDeduplicator } from './webhook-normalized-delivery-deduplicator.js';
import { createWebhookNormalizedSingleEventProjector } from './webhook-normalized-event-projector.js';
import type {
  RawWebhookRequest,
  WebhookIngressProfileAdapter,
  WebhookProfileResult,
  WebhookProfileRuntimeContext,
  WebhookProfileTestDeliveryInput,
  WebhookProfileTestDeliveryRequest,
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

const unsupportedDelivery = (): WebhookProfileResult => ({
  ok: false,
  failure: {
    disposition: 'reject',
    code: 'unsupported_delivery',
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

type TimestampedJsonSingleEventPreset =
  WebhookTimestampedHmacDeliveryProfilePreset & Readonly<{
    decoder: NonNullable<WebhookTimestampedHmacDeliveryProfilePreset['decoder']>;
    form_decoder: null;
    form_json_envelope: null;
    flat_form_event_normalizer: null;
    handshake: null;
    event_projector: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['event_projector']
    >;
    delivery_deduplicator: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['delivery_deduplicator']
    >;
    event_normalizer: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['event_normalizer']
    >;
    environment_admission: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['environment_admission']
    >;
    test_envelope: NonNullable<
      WebhookTimestampedHmacDeliveryProfilePreset['test_envelope']
    >;
    admission_method_label: string;
    runtime_error_label: string;
  }>;

const timestampedJsonSingleEventPreset = (
  profileId: WebhookProfileId,
): TimestampedJsonSingleEventPreset => {
  const preset = webhookTimestampedHmacDeliveryProfilePreset(profileId);
  if (preset === null
    || preset.decoder === null
    || preset.form_decoder !== null
    || preset.form_json_envelope !== null
    || preset.flat_form_event_normalizer !== null
    || preset.handshake !== null
    || preset.event_projector === null
    || preset.delivery_deduplicator === null
    || preset.event_normalizer === null
    || preset.environment_admission === null
    || preset.test_envelope === null
    || preset.admission_method_label === null
    || preset.runtime_error_label === null
    || (preset.environment_admission.false_environment !== 'test'
      && preset.environment_admission.true_environment !== 'test')) {
    throw new Error(
      `webhook timestamped JSON single-event profile '${profileId}' is unavailable`,
    );
  }
  return preset as TimestampedJsonSingleEventPreset;
};

export const createTimestampedJsonSingleEventWebhookCredentialShapeValidator = (
  profileId: WebhookProfileId,
): ((credentials: Readonly<Record<string, string>>) => boolean) => {
  const mechanism = createWebhookTimestampedHmacMechanism(
    timestampedJsonSingleEventPreset(profileId).mechanism,
  );
  return Object.freeze((
    credentials: Readonly<Record<string, string>>,
  ): boolean => mechanism.validateCredentialShape(credentials));
};

/** Pure adapter for protocol fixtures. Production composition must use the
 * clock-gated wrapper below so caller-controlled wall time is never freshness
 * authority.
 */
export const createTimestampedJsonSingleEventWebhookProfileAdapter = (
  profileId: WebhookProfileId,
): WebhookIngressProfileAdapter => {
  const preset = timestampedJsonSingleEventPreset(profileId);
  const mechanism = createWebhookTimestampedHmacMechanism(preset.mechanism);
  const decoder = createWebhookJsonObjectDecoder(preset.decoder);
  const normalizer = createWebhookJsonEventNormalizer(preset.event_normalizer);
  const environmentAdmission = createWebhookJsonEnvironmentAdmission(
    preset.environment_admission,
  );
  const deduplicator = createWebhookNormalizedDeliveryDeduplicator(
    preset.delivery_deduplicator,
  );
  const projector = createWebhookNormalizedSingleEventProjector(
    preset.event_projector,
  );
  const testEnvelope = createWebhookJsonSingleEventTestEnvelopeBuilder(
    preset.test_envelope,
    preset.decoder,
    preset.event_normalizer,
    preset.environment_admission,
  );
  const supportedEnvironments = Object.freeze([
    preset.environment_admission.false_environment,
    preset.environment_admission.true_environment,
  ]);
  const runtimeError = (message: string): Error =>
    new Error(`${preset.runtime_error_label} ${message}`);

  const buildTestDelivery = (
    input: WebhookProfileTestDeliveryInput,
    context: WebhookProfileRuntimeContext,
  ): WebhookProfileTestDeliveryRequest => {
    if (!mechanism.hasValidConfiguration(context)
      || context.environment !== 'test') {
      throw runtimeError('test configuration is unavailable');
    }
    if (!testEnvelope.hasValidNonce(input.nonce)) {
      throw runtimeError('test delivery nonce is invalid');
    }
    let nowMilliseconds: number;
    try {
      nowMilliseconds = context.now();
    } catch {
      throw runtimeError('trusted clock is unavailable');
    }
    if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 1_000) {
      throw runtimeError('trusted clock is unavailable');
    }
    const timestamp = String(Math.floor(nowMilliseconds / 1_000));
    const built = testEnvelope.build({
      nonce: input.nonce,
      event_type: input.selected_event_types[0],
      occurred_at: Number(timestamp),
      environment: context.environment,
    });
    if (!built.ok) {
      if (built.reason === 'invalid_nonce') {
        throw runtimeError('test delivery nonce is invalid');
      }
      throw runtimeError('selected test event is invalid');
    }
    const rawBody = built.raw_body;
    const signature = mechanism.sign(
      rawBody,
      { ...context, now: () => nowMilliseconds },
      'newest',
    );
    if (signature === null || signature.timestamp_literal !== timestamp) {
      rawBody.fill(0);
      throw runtimeError('test configuration is unavailable');
    }
    const headers = Object.create(null) as Record<string, string>;
    headers[signature.header_name] = signature.header_value;
    return { raw_body: rawBody, headers };
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
        || !supportedEnvironments.includes(context.environment)) {
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
      const normalized = normalizer.normalize(envelope);
      if (normalized === null
        || normalized.event_id === null
        || normalized.occurred_at === null) {
        return structuralFailure();
      }
      const environment = environmentAdmission.classify(
        envelope,
        context.environment,
      );
      if (environment.kind === 'invalid') return structuralFailure();
      if (environment.kind === 'environment_mismatch') {
        return unsupportedDelivery();
      }
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
            method_label: preset.admission_method_label,
          },
        },
      };
    },
  });
};

export const createClockGatedTimestampedJsonSingleEventWebhookProfileAdapter = (
  profileId: WebhookProfileId,
  authority: WebhookClockHealthAuthority,
): WebhookIngressProfileAdapter => {
  const runtimeErrorLabel = timestampedJsonSingleEventPreset(
    profileId,
  ).runtime_error_label;
  const adapter = createTimestampedJsonSingleEventWebhookProfileAdapter(profileId);
  return Object.freeze({
    profile_id: adapter.profile_id,
    success_response: adapter.success_response,
    async buildTestDelivery(
      input: WebhookProfileTestDeliveryInput,
      context: WebhookProfileRuntimeContext,
    ) {
      const now = await readTrustedWebhookClockNow(authority);
      if (now === null) {
        throw new Error(
          `${runtimeErrorLabel} trusted clock is unavailable`,
        );
      }
      return adapter.buildTestDelivery!(input, {
        ...context,
        now: () => now,
      });
    },
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
