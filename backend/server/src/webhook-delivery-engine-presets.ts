/** D-201 Slices 8K-9H + 9L + 9S-9AD + 9AT-9AW + 9BQ — trusted delivery-engine profile preset data.
 *
 * This is the intentional profile/vendor boundary. Generic mechanism, decoder,
 * normalizer, projector, and composition engines contain no profile ids; they
 * consume one deeply frozen preset selected here. Vendor compatibility wrappers
 * retain only preset selection and any family-specific behavior not yet moved
 * into a closed composition.
 */

import {
  webhookProfile,
  webhookProfileAcceptsEventType,
  type WebhookProfileFieldSource,
  type WebhookProfileId,
} from '@recued/contracts';
import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_HOOK_ID_HEADER,
  GITHUB_SIGNATURE_HEADER,
} from './connections/providers/github-webhook-protocol.js';
import { PADDLE_SIGNATURE_HEADER } from './connections/providers/paddle-webhook-protocol.js';
import { TELEGRAM_SECRET_HEADER } from './connections/providers/telegram-webhook-protocol.js';
import {
  SLACK_REQUEST_TIMESTAMP_HEADER,
  SLACK_SIGNATURE_HEADER,
} from './connections/providers/slack-webhook-protocol.js';
import { STRIPE_SIGNATURE_HEADER } from './connections/providers/stripe-webhook-protocol.js';
import {
  createWebhookFixedPrefixProviderIdParser,
  type WebhookFixedPrefixProviderIdParserPreset,
} from './webhook-fixed-prefix-provider-id-parser.js';
import {
  createWebhookFormUrlencodedDecoder,
  WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET,
  type WebhookFormUrlencodedDecoderPreset,
} from './webhook-form-urlencoded-decoder.js';
import {
  createWebhookFormWrappedJsonDecoder,
  type WebhookFormWrappedJsonDecoderPreset,
} from './webhook-form-wrapped-json-decoder.js';
import {
  createWebhookFlatFormEventNormalizer,
  type WebhookFlatFormEventNormalizerPreset,
} from './webhook-flat-form-event-normalizer.js';
import {
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
  type WebhookJsonObjectDecoderPreset,
} from './webhook-json-object-decoder.js';
import {
  createWebhookJsonSingleMemberEventNormalizer,
  type WebhookJsonSingleMemberEventNormalizerPreset,
} from './webhook-json-single-member-event-normalizer.js';
import {
  createWebhookJsonSingleEventTestEnvelopeBuilder,
  type WebhookJsonSingleEventTestEnvelopePreset,
} from './webhook-json-single-event-test-envelope.js';
import {
  compileWebhookJsonSingleNotificationNormalizerPreset,
  type WebhookJsonSingleNotificationNormalizerPreset,
} from './webhook-json-single-notification-normalizer.js';
import {
  createWebhookJsonEventNormalizer,
  type WebhookJsonEventNormalizerPreset,
} from './webhook-json-event-normalizer.js';
import {
  createWebhookJsonEnvironmentAdmission,
  type WebhookJsonEnvironmentAdmissionPreset,
} from './webhook-json-environment-admission.js';
import {
  createWebhookJsonChallengeProjector,
  type WebhookJsonChallengeProjectorPreset,
} from './webhook-json-challenge-projector.js';
import {
  createWebhookNormalizedSingleEventProjector,
  type WebhookNormalizedSingleEventProjectorPreset,
} from './webhook-normalized-event-projector.js';
import {
  createWebhookNormalizedDeliveryDeduplicator,
  type WebhookNormalizedDeliveryDeduplicatorPreset,
} from './webhook-normalized-delivery-deduplicator.js';
import {
  createWebhookMetadataPayloadSingleEventNormalizer,
  type WebhookMetadataPayloadSingleEventNormalizerPreset,
} from './webhook-metadata-payload-single-event-normalizer.js';
import {
  createWebhookRawBodyHmacMechanism,
  type WebhookRawBodyHmacMechanismPreset,
} from './webhook-raw-body-hmac-engine.js';
import {
  compileWebhookRawHeaderJsonSingleEventTestEnvelopePreset,
  type WebhookRawHeaderJsonSingleEventTestEnvelopePreset,
} from './webhook-raw-header-json-single-event-test-envelope.js';
import {
  createWebhookRfc3339TimestampParser,
  type WebhookRfc3339TimestampParserPreset,
} from './webhook-rfc3339-timestamp-parser.js';
import {
  compileWebhookRawHeaderSingleEventMetadataNormalizerPreset,
  type WebhookRawHeaderSingleEventMetadataNormalizerPreset,
} from './webhook-raw-header-single-event-metadata-normalizer.js';
import {
  createWebhookTimestampedHmacMechanism,
  type WebhookTimestampedHmacMechanismPreset,
} from './webhook-timestamped-hmac-engine.js';
import {
  createWebhookStaticHeaderTokenMechanism,
  type WebhookStaticHeaderTokenMechanismPreset,
} from './webhook-static-header-token-engine.js';
import {
  webhookBoundedAsciiCredentialProfilePreset,
  webhookFixedLengthAsciiCredentialProfilePreset,
  webhookPrefixedAsciiCredentialProfilePreset,
  webhookSegmentedAsciiCredentialProfilePreset,
} from './webhook-shared-profile-parser-presets.js';

export interface WebhookStaticHeaderTokenDeliveryProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly mechanism: WebhookStaticHeaderTokenMechanismPreset;
  readonly decoder: WebhookJsonObjectDecoderPreset;
  readonly event_normalizer:
    WebhookJsonSingleMemberEventNormalizerPreset | null;
  readonly delivery_deduplicator:
    WebhookNormalizedDeliveryDeduplicatorPreset | null;
  readonly event_projector: WebhookNormalizedSingleEventProjectorPreset | null;
  readonly admission_method_label: string | null;
}

const staticHeaderTokenPreset = (
  profile_id: WebhookProfileId,
  mechanismInput: WebhookStaticHeaderTokenMechanismPreset,
  eventNormalizerInput:
    WebhookJsonSingleMemberEventNormalizerPreset | null = null,
  deliveryDeduplicatorInput:
    WebhookNormalizedDeliveryDeduplicatorPreset | null = null,
  eventProjectorInput:
    WebhookNormalizedSingleEventProjectorPreset | null = null,
  admissionMethodLabelInput: string | null = null,
): WebhookStaticHeaderTokenDeliveryProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const mechanism = createWebhookStaticHeaderTokenMechanism(
    mechanismInput,
  ).preset;
  const decoder = WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET;
  const event_normalizer = eventNormalizerInput === null
    ? null
    : createWebhookJsonSingleMemberEventNormalizer(eventNormalizerInput).preset;
  const delivery_deduplicator = deliveryDeduplicatorInput === null
    ? null
    : createWebhookNormalizedDeliveryDeduplicator(
        deliveryDeduplicatorInput,
      ).preset;
  const event_projector = eventProjectorInput === null
    ? null
    : createWebhookNormalizedSingleEventProjector(eventProjectorInput).preset;
  const mechanismFields = [mechanism.token_field];
  const headerField = mechanism.token_header.kind === 'credential_field'
    ? mechanism.token_header.field
    : null;
  if (headerField !== null) mechanismFields.push(headerField);
  const descriptorFields = descriptor?.fields.map((field) => field.key) ?? [];
  const tokenDescriptor = descriptor?.fields.find(
    (field) => field.key === mechanism.token_field,
  );
  const headerDescriptor = headerField === null
    ? undefined
    : descriptor?.fields.find((field) => field.key === headerField);
  const deliveryDeduplicatorValid = delivery_deduplicator === null
    || (event_normalizer !== null
      && delivery_deduplicator.kind
        === 'normalized_required_single_id_sha256.v1'
      && delivery_deduplicator.stable_id_field === 'event_id');
  const eventProjectorValid = event_projector === null
    || (event_normalizer !== null
      && delivery_deduplicator !== null
      && event_projector.provider_event_id_field === 'event_id'
      && event_projector.provider_resource_id_field === 'resource_id'
      && event_projector.provider_event_type_field === 'event_type'
      && event_projector.provider_occurred_at_field === 'occurred_at'
      && event_projector.decoded_payload_field === 'payload'
      && event_projector.occurred_at_unit === 'unix_milliseconds.v1');
  const admissionMethodLabelValid = admissionMethodLabelInput === null
    || /^[a-z][a-z0-9._-]{0,127}$/.test(admissionMethodLabelInput);
  const composedPolicyValid = event_normalizer === null
    ? delivery_deduplicator === null
      && event_projector === null
      && admissionMethodLabelInput === null
    : delivery_deduplicator !== null
      && event_projector !== null
      && admissionMethodLabelInput !== null;
  if (descriptor === null
    || descriptor.mechanism_kind !== 'static_header_token'
    || descriptor.transport_assurance !== 'authenticated'
    || descriptor.decoder_kind !== 'json'
    || descriptor.fields.some((field) => !field.required)
    || (event_normalizer !== null
      && descriptor.max_events_per_delivery !== 1)
    || !deliveryDeduplicatorValid
    || !eventProjectorValid
    || !admissionMethodLabelValid
    || !composedPolicyValid
    || tokenDescriptor?.kind !== 'secret'
    || (headerField !== null && headerDescriptor?.kind !== 'text')
    || [...mechanismFields].sort().join('\0')
      !== [...descriptorFields].sort().join('\0')) {
    throw new Error(
      `webhook static header-token preset '${profile_id}' does not match its descriptor`,
    );
  }
  const value = Object.freeze({
    profile_id,
    mechanism,
    decoder,
    event_normalizer,
    delivery_deduplicator,
    event_projector,
    admission_method_label: admissionMethodLabelInput,
  });
  JSON.stringify(value);
  return value;
};

const telegramBoundedAsciiCredentialPreset =
  webhookBoundedAsciiCredentialProfilePreset('telegram.bot-webhook.v1');
if (telegramBoundedAsciiCredentialPreset === null) {
  throw new Error('Telegram delivery credential preset is unavailable');
}

const STATIC_HEADER_TOKEN_PRESET_LIST = [
  staticHeaderTokenPreset('generic.static-header-token.v1', {
    kind: 'static_header_token.v1',
    token_field: 'header_token',
    token_shape: 'trimmed_printable_ascii_8192.v1',
    token_header: { kind: 'credential_field', field: 'header_name' },
    matching_credential: 'first',
  }),
  staticHeaderTokenPreset('telegram.bot-webhook.v1', {
    kind: 'static_header_token.v1',
    token_field: telegramBoundedAsciiCredentialPreset.credential_field,
    token_shape: telegramBoundedAsciiCredentialPreset.parser,
    token_header: { kind: 'fixed', name: TELEGRAM_SECRET_HEADER },
    matching_credential: 'newest',
  }, {
    kind: 'json_single_member_event.v1',
    event_id_field: 'update_id',
    event_id_grammar: 'positive_safe_integer.v1',
    event_id_max_value: 0x7fffffff,
    event_type_grammar: 'ascii_identifier.v1',
    event_type_max_bytes: 128,
  }, {
    kind: 'normalized_required_single_id_sha256.v1',
    stable_id_field: 'event_id',
    stable_id_prefix: 'telegram:update:',
  }, {
    kind: 'normalized_single_event.v1',
    provider_event_id_field: 'event_id',
    provider_resource_id_field: 'resource_id',
    provider_event_type_field: 'event_type',
    provider_occurred_at_field: 'occurred_at',
    decoded_payload_field: 'payload',
    occurred_at_unit: 'unix_milliseconds.v1',
  }, 'telegram-secret-token'),
] as const;

const mutableStaticHeaderTokenPresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookStaticHeaderTokenDeliveryProfilePreset | undefined
>;
for (const value of STATIC_HEADER_TOKEN_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableStaticHeaderTokenPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook static header-token preset '${value.profile_id}'`,
    );
  }
  mutableStaticHeaderTokenPresets[value.profile_id] = value;
}

export const WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookStaticHeaderTokenDeliveryProfilePreset>>
> = Object.freeze(mutableStaticHeaderTokenPresets);

export const webhookStaticHeaderTokenDeliveryProfilePreset = (
  profileId: WebhookProfileId,
): WebhookStaticHeaderTokenDeliveryProfilePreset | null =>
  WEBHOOK_STATIC_HEADER_TOKEN_DELIVERY_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookRawBodyHmacDeliveryProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly mechanism: WebhookRawBodyHmacMechanismPreset;
  readonly decoder: WebhookJsonObjectDecoderPreset;
  readonly raw_header_metadata:
    WebhookRawHeaderSingleEventMetadataNormalizerPreset | null;
  readonly delivery_deduplicator:
    WebhookNormalizedDeliveryDeduplicatorPreset | null;
  readonly metadata_payload_event_normalizer:
    WebhookMetadataPayloadSingleEventNormalizerPreset | null;
  readonly event_projector: WebhookNormalizedSingleEventProjectorPreset | null;
  readonly test_envelope:
    WebhookRawHeaderJsonSingleEventTestEnvelopePreset | null;
  readonly admission_method_label: string | null;
  readonly runtime_error_label: string | null;
  readonly test_signing_credential: 'oldest' | 'newest' | null;
}

export interface WebhookTimestampedHmacDeliveryProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly mechanism: WebhookTimestampedHmacMechanismPreset;
  readonly decoder: WebhookJsonObjectDecoderPreset | null;
  readonly form_decoder: WebhookFormUrlencodedDecoderPreset | null;
  readonly form_json_envelope: WebhookFormWrappedJsonDecoderPreset | null;
  readonly flat_form_event_normalizer:
    WebhookFlatFormEventNormalizerPreset | null;
  readonly handshake: WebhookJsonChallengeHandshakeProfilePreset | null;
  readonly event_projector: WebhookNormalizedSingleEventProjectorPreset | null;
  readonly delivery_deduplicator:
    WebhookNormalizedDeliveryDeduplicatorPreset | null;
  readonly event_normalizer: WebhookJsonEventNormalizerPreset | null;
  readonly environment_admission:
    WebhookJsonEnvironmentAdmissionPreset | null;
  readonly test_envelope: WebhookJsonSingleEventTestEnvelopePreset | null;
  readonly admission_method_label: string | null;
  readonly runtime_error_label: string | null;
  readonly credential_sources: Readonly<Record<string, WebhookProfileFieldSource>>;
}

export interface WebhookJsonChallengeHandshakeProfilePreset {
  readonly portable_kind: string;
  readonly projector: WebhookJsonChallengeProjectorPreset;
}

const preset = (
  profile_id: WebhookProfileId,
  mechanismInput: WebhookRawBodyHmacMechanismPreset,
  rawHeaderMetadataInput:
    WebhookRawHeaderSingleEventMetadataNormalizerPreset | null = null,
  deliveryDeduplicatorInput:
    WebhookNormalizedDeliveryDeduplicatorPreset | null = null,
  metadataPayloadEventNormalizerInput:
    WebhookMetadataPayloadSingleEventNormalizerPreset | null = null,
  eventProjectorInput:
    WebhookNormalizedSingleEventProjectorPreset | null = null,
  testEnvelopeInput:
    WebhookRawHeaderJsonSingleEventTestEnvelopePreset | null = null,
  admissionMethodLabelInput: string | null = null,
  runtimeErrorLabelInput: string | null = null,
  testSigningCredentialInput: 'oldest' | 'newest' | null = null,
): WebhookRawBodyHmacDeliveryProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const mechanism = createWebhookRawBodyHmacMechanism(mechanismInput).preset;
  const decoder = WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET;
  const raw_header_metadata = rawHeaderMetadataInput === null
    ? null
    : compileWebhookRawHeaderSingleEventMetadataNormalizerPreset(
        rawHeaderMetadataInput,
      );
  const delivery_deduplicator = deliveryDeduplicatorInput === null
    ? null
    : createWebhookNormalizedDeliveryDeduplicator(
        deliveryDeduplicatorInput,
      ).preset;
  const metadata_payload_event_normalizer =
    metadataPayloadEventNormalizerInput === null
      ? null
      : createWebhookMetadataPayloadSingleEventNormalizer(
          metadataPayloadEventNormalizerInput,
        ).preset;
  const event_projector = eventProjectorInput === null
    ? null
    : createWebhookNormalizedSingleEventProjector(eventProjectorInput).preset;
  const test_envelope = testEnvelopeInput === null
    ? null
    : compileWebhookRawHeaderJsonSingleEventTestEnvelopePreset(
        testEnvelopeInput,
        decoder,
      );
  const mechanismFields = [mechanism.secret_field];
  const headerField = mechanism.signature_header.kind === 'credential_field'
    ? mechanism.signature_header.field
    : null;
  if (headerField !== null) mechanismFields.push(headerField);
  const descriptorFields = descriptor?.fields.map((field) => field.key) ?? [];
  const secretDescriptor = descriptor?.fields.find(
    (field) => field.key === mechanism.secret_field,
  );
  const headerDescriptor = headerField !== null
    ? descriptor?.fields.find((field) => field.key === headerField)
    : undefined;
  const metadataHeaderNames = raw_header_metadata === null
    ? []
    : [
        raw_header_metadata.delivery_id_header,
        raw_header_metadata.event_type_header,
        raw_header_metadata.structural_evidence_header,
      ];
  const rawHeaderMetadataValid = raw_header_metadata === null
    || (descriptor?.max_events_per_delivery === 1
      && mechanism.signature_header.kind === 'fixed'
      && !metadataHeaderNames.includes(mechanism.signature_header.name));
  const deliveryDeduplicatorValid = delivery_deduplicator === null
    || (raw_header_metadata !== null
      && delivery_deduplicator.kind
        === 'normalized_required_single_id_sha256.v1'
      && delivery_deduplicator.stable_id_field === 'delivery_id');
  const eventProjectionValid = metadata_payload_event_normalizer === null
    ? event_projector === null
    : event_projector !== null
      && raw_header_metadata !== null
      && delivery_deduplicator !== null
      && event_projector.provider_event_id_field === 'event_id'
      && event_projector.provider_resource_id_field === 'resource_id'
      && event_projector.provider_event_type_field === 'event_type'
      && event_projector.provider_occurred_at_field === 'occurred_at'
      && event_projector.decoded_payload_field === 'payload'
      && event_projector.occurred_at_unit === 'unix_milliseconds.v1';
  const testEnvelopeValid = test_envelope === null
    || (raw_header_metadata !== null
      && delivery_deduplicator !== null
      && metadata_payload_event_normalizer !== null
      && event_projector !== null
      && test_envelope.max_body_bytes === descriptor?.max_body_bytes);
  const admissionMethodLabelValid = admissionMethodLabelInput === null
    || /^[a-z][a-z0-9._-]{0,127}$/.test(admissionMethodLabelInput);
  const runtimeErrorLabelValid = runtimeErrorLabelInput === null
    || /^[A-Za-z][A-Za-z0-9 -]{0,63}$/.test(runtimeErrorLabelInput);
  const testSigningCredentialValid = testSigningCredentialInput === null
    || testSigningCredentialInput === 'oldest'
    || testSigningCredentialInput === 'newest';
  const composedPolicyValid = raw_header_metadata === null
    ? admissionMethodLabelInput === null
      && runtimeErrorLabelInput === null
      && testSigningCredentialInput === null
    : admissionMethodLabelInput !== null
      && runtimeErrorLabelInput !== null
      && (test_envelope === null
        ? testSigningCredentialInput === null
        : testSigningCredentialInput !== null);
  if (!descriptor
    || descriptor.mechanism_kind !== 'raw_body_hmac'
    || descriptor.decoder_kind !== 'json'
    || descriptor.fields.some((field) => !field.required)
    || secretDescriptor?.kind !== 'secret'
    || (headerField !== null && headerDescriptor?.kind !== 'text')
    || !rawHeaderMetadataValid
    || !deliveryDeduplicatorValid
    || !eventProjectionValid
    || !testEnvelopeValid
    || !admissionMethodLabelValid
    || !runtimeErrorLabelValid
    || !testSigningCredentialValid
    || !composedPolicyValid
    || [...mechanismFields].sort().join('\0') !== [...descriptorFields].sort().join('\0')) {
    throw new Error(
      `webhook delivery-engine preset '${profile_id}' does not match its descriptor`,
    );
  }
  const value = Object.freeze({
    profile_id,
    mechanism,
    decoder,
    raw_header_metadata,
    delivery_deduplicator,
    metadata_payload_event_normalizer,
    event_projector,
    test_envelope,
    admission_method_label: admissionMethodLabelInput,
    runtime_error_label: runtimeErrorLabelInput,
    test_signing_credential: testSigningCredentialInput,
  });
  // These records are trusted data, not an executable adapter smuggled into a
  // profile. Keep that property boot-checked as the registry grows.
  JSON.stringify(value);
  return value;
};

const githubFixedLengthAsciiCredentialPreset =
  webhookFixedLengthAsciiCredentialProfilePreset('github.webhook.v1');
if (githubFixedLengthAsciiCredentialPreset === null) {
  throw new Error('GitHub delivery credential preset is unavailable');
}

const RAW_BODY_HMAC_PRESET_LIST = [
  preset('cal.webhook.v1', {
    kind: 'raw_body_hmac_sha256.v1',
    secret_field: 'signing_secret',
    secret_shape: 'nonempty_utf8_65536',
    signature_header: {
      kind: 'fixed',
      name: 'x-cal-signature-256',
    },
    signature_format: 'lowerhex.v1',
    matching_credential: 'newest',
  }),
  preset('generic.raw-body-hmac-sha256.v1', {
    kind: 'raw_body_hmac_sha256.v1',
    secret_field: 'signing_secret',
    secret_shape: 'nonempty_utf8_65536',
    signature_header: {
      kind: 'credential_field',
      field: 'signature_header',
    },
    signature_format: 'sha256_equals_lowerhex.v1',
    matching_credential: 'first',
  }),
  preset('github.webhook.v1', {
    kind: 'raw_body_hmac_sha256.v1',
    secret_field: githubFixedLengthAsciiCredentialPreset.credential_field,
    secret_shape: githubFixedLengthAsciiCredentialPreset.parser,
    signature_header: {
      kind: 'fixed',
      name: GITHUB_SIGNATURE_HEADER,
    },
    signature_format: 'sha256_equals_lowerhex.v1',
    matching_credential: 'newest',
  }, {
    kind: 'raw_header_single_event_metadata.v1',
    delivery_id_header: GITHUB_DELIVERY_HEADER,
    event_type_header: GITHUB_EVENT_HEADER,
    structural_evidence_header: GITHUB_HOOK_ID_HEADER,
  }, {
    kind: 'normalized_required_single_id_sha256.v1',
    stable_id_field: 'delivery_id',
    stable_id_prefix: 'github:delivery:',
  }, {
    kind: 'metadata_payload_single_event.v1',
  }, {
    kind: 'normalized_single_event.v1',
    provider_event_id_field: 'event_id',
    provider_resource_id_field: 'resource_id',
    provider_event_type_field: 'event_type',
    provider_occurred_at_field: 'occurred_at',
    decoded_payload_field: 'payload',
    occurred_at_unit: 'unix_milliseconds.v1',
  }, {
    kind: 'raw_header_json_single_event_test_envelope.v1',
    nonce_grammar: 'lowercase_hex_64.v1',
    delivery_id_derivation: 'sha256_uuid_v4_variant8.v1',
    delivery_id_domain_separator: 'recued:github:test-delivery:',
    structural_evidence: '1',
    base_payload_json:
      '{"action":"recued_test_delivery","hook":{"id":1,"type":"Repository","active":true},'
      + '"repository":{"id":1,"full_name":"recued/test-delivery"},'
      + '"sender":{"id":1,"login":"recued-test-delivery","type":"Bot"}}',
    marker_object_field: 'recued_test_delivery',
    marker_nonce_field: 'nonce',
    max_body_bytes: 1_048_576,
  }, 'github-hmac-sha256', 'GitHub webhook', 'oldest'),
  preset('lemonsqueezy.webhook.v1', {
    kind: 'raw_body_hmac_sha256.v1',
    secret_field: 'signing_secret',
    secret_shape: 'nonempty_utf8_65536',
    signature_header: {
      kind: 'fixed',
      name: 'x-signature',
    },
    signature_format: 'lowerhex.v1',
    matching_credential: 'newest',
  }),
] as const;

const mutable = Object.create(null) as Record<
  WebhookProfileId,
  WebhookRawBodyHmacDeliveryProfilePreset | undefined
>;
for (const value of RAW_BODY_HMAC_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(mutable, value.profile_id)) {
    throw new Error(`duplicate webhook delivery-engine preset '${value.profile_id}'`);
  }
  mutable[value.profile_id] = value;
}

export const WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookRawBodyHmacDeliveryProfilePreset>>
> = Object.freeze(mutable);

export const webhookRawBodyHmacDeliveryProfilePreset = (
  profileId: WebhookProfileId,
): WebhookRawBodyHmacDeliveryProfilePreset | null =>
  WEBHOOK_RAW_BODY_HMAC_DELIVERY_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookRfc3339TimestampProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly parser: WebhookRfc3339TimestampParserPreset;
}

const rfc3339TimestampPreset = (
  profile_id: WebhookProfileId,
  parserInput: WebhookRfc3339TimestampParserPreset,
): WebhookRfc3339TimestampProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor?.decoder_kind !== 'json') {
    throw new Error(
      `webhook RFC3339 timestamp preset '${profile_id}' requires a JSON profile`,
    );
  }
  const value = Object.freeze({
    profile_id,
    parser: createWebhookRfc3339TimestampParser(parserInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const RFC3339_TIMESTAMP_PRESET_LIST = [
  rfc3339TimestampPreset('paddle.notification.v1', {
    kind: 'strict_rfc3339_milliseconds.v1',
    max_bytes: 64,
  }),
] as const;

const mutableRfc3339TimestampPresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookRfc3339TimestampProfilePreset | undefined
>;
for (const value of RFC3339_TIMESTAMP_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableRfc3339TimestampPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook RFC3339 timestamp preset '${value.profile_id}'`,
    );
  }
  mutableRfc3339TimestampPresets[value.profile_id] = value;
}

export const WEBHOOK_RFC3339_TIMESTAMP_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookRfc3339TimestampProfilePreset>>
> = Object.freeze(mutableRfc3339TimestampPresets);

export const webhookRfc3339TimestampProfilePreset = (
  profileId: WebhookProfileId,
): WebhookRfc3339TimestampProfilePreset | null =>
  WEBHOOK_RFC3339_TIMESTAMP_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookPairedProviderIdProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly event_id: WebhookFixedPrefixProviderIdParserPreset;
  readonly delivery_id: WebhookFixedPrefixProviderIdParserPreset;
}

const pairedProviderIdPreset = (
  profile_id: WebhookProfileId,
  eventIdInput: WebhookFixedPrefixProviderIdParserPreset,
  deliveryIdInput: WebhookFixedPrefixProviderIdParserPreset,
): WebhookPairedProviderIdProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor?.decoder_kind !== 'json'
    || descriptor.max_events_per_delivery !== 1) {
    throw new Error(
      `webhook paired provider-id preset '${profile_id}' requires a single-event JSON profile`,
    );
  }
  const value = Object.freeze({
    profile_id,
    event_id: createWebhookFixedPrefixProviderIdParser(eventIdInput).preset,
    delivery_id: createWebhookFixedPrefixProviderIdParser(deliveryIdInput).preset,
  });
  JSON.stringify(value);
  return value;
};

const PAIRED_PROVIDER_ID_PRESET_LIST = [
  pairedProviderIdPreset('paddle.notification.v1', {
    kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
    prefix: 'evt_',
    suffix_length: 26,
  }, {
    kind: 'fixed_prefix_lowercase_alphanumeric_id.v1',
    prefix: 'ntf_',
    suffix_length: 26,
  }),
] as const;

const mutablePairedProviderIdPresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookPairedProviderIdProfilePreset | undefined
>;
for (const value of PAIRED_PROVIDER_ID_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutablePairedProviderIdPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook paired provider-id preset '${value.profile_id}'`,
    );
  }
  mutablePairedProviderIdPresets[value.profile_id] = value;
}

export const WEBHOOK_PAIRED_PROVIDER_ID_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookPairedProviderIdProfilePreset>>
> = Object.freeze(mutablePairedProviderIdPresets);

export const webhookPairedProviderIdProfilePreset = (
  profileId: WebhookProfileId,
): WebhookPairedProviderIdProfilePreset | null =>
  WEBHOOK_PAIRED_PROVIDER_ID_PROFILE_PRESETS[profileId] ?? null;

export interface WebhookJsonSingleNotificationProfilePreset {
  readonly profile_id: WebhookProfileId;
  readonly normalizer: WebhookJsonSingleNotificationNormalizerPreset;
}

const jsonSingleNotificationPreset = (
  profile_id: WebhookProfileId,
  normalizerInput: WebhookJsonSingleNotificationNormalizerPreset,
): WebhookJsonSingleNotificationProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  if (descriptor?.decoder_kind !== 'json'
    || descriptor.max_events_per_delivery !== 1) {
    throw new Error(
      `webhook JSON single-notification preset '${profile_id}' requires a single-event JSON profile`,
    );
  }
  const value = Object.freeze({
    profile_id,
    normalizer: compileWebhookJsonSingleNotificationNormalizerPreset(
      normalizerInput,
    ),
  });
  JSON.stringify(value);
  return value;
};

const JSON_SINGLE_NOTIFICATION_PRESET_LIST = [
  jsonSingleNotificationPreset('paddle.notification.v1', {
    kind: 'json_single_notification_fields.v1',
    event_id_field: 'event_id',
    delivery_id_field: 'notification_id',
    event_type_field: 'event_type',
    occurred_at_field: 'occurred_at',
  }),
] as const;

const mutableJsonSingleNotificationPresets = Object.create(null) as Record<
  WebhookProfileId,
  WebhookJsonSingleNotificationProfilePreset | undefined
>;
for (const value of JSON_SINGLE_NOTIFICATION_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(
    mutableJsonSingleNotificationPresets,
    value.profile_id,
  )) {
    throw new Error(
      `duplicate webhook JSON single-notification preset '${value.profile_id}'`,
    );
  }
  mutableJsonSingleNotificationPresets[value.profile_id] = value;
}

export const WEBHOOK_JSON_SINGLE_NOTIFICATION_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookJsonSingleNotificationProfilePreset>>
> = Object.freeze(mutableJsonSingleNotificationPresets);

export const webhookJsonSingleNotificationProfilePreset = (
  profileId: WebhookProfileId,
): WebhookJsonSingleNotificationProfilePreset | null =>
  WEBHOOK_JSON_SINGLE_NOTIFICATION_PROFILE_PRESETS[profileId] ?? null;

const freezeJsonChallengeHandshake = (
  input: WebhookJsonChallengeHandshakeProfilePreset | null,
): WebhookJsonChallengeHandshakeProfilePreset | null => {
  if (input === null) return null;
  try {
    const prototype = Object.getPrototypeOf(input);
    const keys = Reflect.ownKeys(input);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 2
      || !keys.includes('portable_kind')
      || !keys.includes('projector')) {
      throw new Error('invalid handshake record');
    }
    const portableKind = Object.getOwnPropertyDescriptor(input, 'portable_kind');
    const projectorInput = Object.getOwnPropertyDescriptor(input, 'projector');
    if (portableKind === undefined
      || !portableKind.enumerable
      || !('value' in portableKind)
      || typeof portableKind.value !== 'string'
      || !/^[a-z][a-z0-9_]{0,127}$/.test(portableKind.value)
      || projectorInput === undefined
      || !projectorInput.enumerable
      || !('value' in projectorInput)) {
      throw new Error('invalid handshake fields');
    }
    const projector = createWebhookJsonChallengeProjector(
      projectorInput.value as WebhookJsonChallengeProjectorPreset,
    ).preset;
    return Object.freeze({
      portable_kind: portableKind.value,
      projector,
    });
  } catch {
    throw new Error('webhook JSON challenge handshake: invalid trusted preset');
  }
};

const timestampedPreset = (
  profile_id: WebhookProfileId,
  mechanismInput: WebhookTimestampedHmacMechanismPreset,
  credentialSourcesInput: Readonly<Record<string, WebhookProfileFieldSource>>,
  formDecoderInput: WebhookFormUrlencodedDecoderPreset | null = null,
  handshakeInput: WebhookJsonChallengeHandshakeProfilePreset | null = null,
  eventProjectorInput: WebhookNormalizedSingleEventProjectorPreset | null = null,
  deliveryDeduplicatorInput:
    WebhookNormalizedDeliveryDeduplicatorPreset | null = null,
  eventNormalizerInput: WebhookJsonEventNormalizerPreset | null = null,
  formJsonEnvelopeInput: WebhookFormWrappedJsonDecoderPreset | null = null,
  flatFormEventNormalizerInput:
    WebhookFlatFormEventNormalizerPreset | null = null,
  environmentAdmissionInput:
    WebhookJsonEnvironmentAdmissionPreset | null = null,
  testEnvelopeInput:
    WebhookJsonSingleEventTestEnvelopePreset | null = null,
  admissionMethodLabelInput: string | null = null,
  runtimeErrorLabelInput: string | null = null,
): WebhookTimestampedHmacDeliveryProfilePreset => {
  const descriptor = webhookProfile(profile_id);
  const mechanism = createWebhookTimestampedHmacMechanism(mechanismInput).preset;
  const decoder = descriptor?.decoder_kind === 'json'
    ? WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET
    : null;
  const form_decoder = formDecoderInput === null
    ? null
    : createWebhookFormUrlencodedDecoder(formDecoderInput).preset;
  const form_json_envelope = formJsonEnvelopeInput === null
    ? null
    : createWebhookFormWrappedJsonDecoder(formJsonEnvelopeInput).preset;
  const flat_form_event_normalizer = flatFormEventNormalizerInput === null
    ? null
    : createWebhookFlatFormEventNormalizer(
        flatFormEventNormalizerInput,
      ).preset;
  const handshake = freezeJsonChallengeHandshake(handshakeInput);
  const event_projector = eventProjectorInput === null
    ? null
    : createWebhookNormalizedSingleEventProjector(eventProjectorInput).preset;
  const delivery_deduplicator = deliveryDeduplicatorInput === null
    ? null
    : createWebhookNormalizedDeliveryDeduplicator(
        deliveryDeduplicatorInput,
      ).preset;
  const event_normalizer = eventNormalizerInput === null
    ? null
    : createWebhookJsonEventNormalizer(eventNormalizerInput).preset;
  const environment_admission = environmentAdmissionInput === null
    ? null
    : createWebhookJsonEnvironmentAdmission(environmentAdmissionInput).preset;
  const test_envelope = testEnvelopeInput === null
    || decoder === null
    || event_normalizer === null
    || environment_admission === null
    ? null
    : createWebhookJsonSingleEventTestEnvelopeBuilder(
        testEnvelopeInput,
        decoder,
        event_normalizer,
        environment_admission,
      ).preset;
  const decoderContentTypes = [
    ...(decoder === null ? [] : ['application/json']),
    ...(form_decoder === null ? [] : ['application/x-www-form-urlencoded']),
  ];
  const descriptorContentTypes = descriptor?.allowed_content_types ?? [];
  const decoderContentTypesValid =
    descriptorContentTypes.length === decoderContentTypes.length
    && decoderContentTypes.every((contentType) =>
      descriptorContentTypes.includes(contentType));
  const handshakeKinds = handshake === null ? [] : [handshake.portable_kind];
  const descriptorHandshakes = descriptor?.handshakes ?? [];
  const handshakesValid = descriptorHandshakes.length === handshakeKinds.length
    && handshakeKinds.every((kind) => descriptorHandshakes.includes(kind));
  const formJsonEnvelopeValid = form_json_envelope === null
    || (decoder !== null
      && form_decoder !== null
      && Buffer.byteLength(form_json_envelope.json_field, 'utf8')
        <= form_decoder.max_key_bytes);
  const descriptorEventTypes = descriptor === null
    ? []
    : descriptor.event_types.kind === 'closed'
      ? descriptor.event_types.values
      : descriptor.event_types.known_values;
  const normalizedEventProjectorFieldsValid = event_projector !== null
    && event_projector.provider_event_id_field === 'event_id'
    && event_projector.provider_resource_id_field === 'resource_id'
    && event_projector.provider_event_type_field === 'event_type'
    && event_projector.provider_occurred_at_field === 'occurred_at'
    && event_projector.decoded_payload_field === 'payload';
  const eventNormalizerValid = event_normalizer === null
    || (decoder !== null
      && event_projector !== null
      && normalizedEventProjectorFieldsValid
      && ((event_normalizer.occurred_at_unit === 'unix_seconds.v1'
        && event_projector.occurred_at_unit
          === 'unix_seconds_to_milliseconds.v1')
        || (event_normalizer.occurred_at_unit === 'unix_milliseconds.v1'
          && event_projector.occurred_at_unit === 'unix_milliseconds.v1'))
      && (handshake === null
        || (event_normalizer.event_type_field
            === handshake.projector.discriminator_field
          && event_normalizer.challenge_field
            === handshake.projector.challenge_field
          && event_normalizer.challenge_max_bytes
            === handshake.projector.max_challenge_bytes))
      && (event_normalizer.conditional_object_requirement === null
        || descriptorEventTypes.includes(
          event_normalizer.conditional_object_requirement.when_event_type,
        )));
  const flatFormFields = flat_form_event_normalizer === null
    ? []
    : [
        flat_form_event_normalizer.payload_event_type_field,
        flat_form_event_normalizer.command_field,
        flat_form_event_normalizer.event_id_field,
        flat_form_event_normalizer.resource_id_field,
        ...flat_form_event_normalizer.reserved_fields,
        ...flat_form_event_normalizer.payload_omitted_fields,
      ];
  const flatFormEventNormalizerValid = flat_form_event_normalizer === null
    || (form_decoder !== null
      && normalizedEventProjectorFieldsValid
      && form_decoder.max_fields >= 3
      && flatFormFields.every((field) =>
        Buffer.byteLength(field, 'utf8') <= form_decoder.max_key_bytes)
      && flat_form_event_normalizer.event_id_max_bytes
        <= form_decoder.max_value_bytes
      && flat_form_event_normalizer.resource_id_max_bytes
        <= form_decoder.max_value_bytes
      && descriptor !== null
      && webhookProfileAcceptsEventType(
        descriptor,
        flat_form_event_normalizer.event_type,
      )
      && (form_json_envelope === null
        || ![
          flat_form_event_normalizer.command_field,
          flat_form_event_normalizer.event_id_field,
          flat_form_event_normalizer.resource_id_field,
        ].includes(form_json_envelope.json_field)));
  const mechanismFields = [mechanism.secret_field];
  const headerField = mechanism.signature_header.kind === 'credential_field'
    ? mechanism.signature_header.field
    : null;
  if (headerField !== null) mechanismFields.push(headerField);
  const descriptorFields = descriptor?.fields.map((field) => field.key) ?? [];
  const secretDescriptor = descriptor?.fields.find(
    (field) => field.key === mechanism.secret_field,
  );
  const headerDescriptor = headerField === null
    ? undefined
    : descriptor?.fields.find((field) => field.key === headerField);
  const credentialSourceEntries: Array<[string, WebhookProfileFieldSource]> = [];
  let credentialSourcesValid = false;
  try {
    const prototype = Object.getPrototypeOf(credentialSourcesInput);
    const keys = Reflect.ownKeys(credentialSourcesInput);
    if (descriptor
      && (prototype === Object.prototype || prototype === null)
      && keys.length === mechanismFields.length) {
      credentialSourcesValid = keys.every((key) => {
        if (typeof key !== 'string' || !mechanismFields.includes(key)) return false;
        const own = Object.getOwnPropertyDescriptor(credentialSourcesInput, key);
        const descriptorField = descriptor.fields.find((field) => field.key === key);
        if (own === undefined
          || !own.enumerable
          || !('value' in own)
          || descriptorField === undefined
          || own.value !== descriptorField.source) {
          return false;
        }
        credentialSourceEntries.push([key, own.value as WebhookProfileFieldSource]);
        return true;
      });
    }
  } catch {
    credentialSourcesValid = false;
  }
  const decoderKindValid = descriptor?.decoder_kind === 'json'
    ? decoder !== null
    : descriptor?.decoder_kind === 'form_urlencoded'
      ? decoder === null && form_decoder !== null
      : false;
  const jsonSurfacesValid = decoder !== null
    || (handshake === null
      && form_json_envelope === null
      && event_normalizer === null
      && environment_admission === null
      && test_envelope === null);
  const testEnvelopeValid = testEnvelopeInput === null
    || test_envelope !== null;
  const admissionMethodLabelValid = admissionMethodLabelInput === null
    || /^[a-z][a-z0-9._-]{0,127}$/.test(admissionMethodLabelInput);
  const runtimeErrorLabelValid = runtimeErrorLabelInput === null
    || /^[A-Za-z][A-Za-z0-9 -]{0,63}$/.test(runtimeErrorLabelInput);
  const mappedEnvironments = environment_admission === null
    ? []
    : [
        environment_admission.false_environment,
        environment_admission.true_environment,
      ];
  const environmentAdmissionValid = environment_admission === null
    || (decoder !== null
      && descriptor !== null
      && descriptor.supported_environments.length === mappedEnvironments.length
      && descriptor.supported_environments.every((environment) =>
        mappedEnvironments.includes(environment)));
  const deliveryDeduplicatorValid = delivery_deduplicator === null
    || (event_projector !== null
      && (delivery_deduplicator.kind
          === 'normalized_id_or_timestamp_body_sha256.v1'
        ? delivery_deduplicator.stable_id_field
            === event_projector.provider_event_id_field
          && delivery_deduplicator.max_body_bytes === descriptor?.max_body_bytes
        : delivery_deduplicator.kind === 'normalized_paired_ids_sha256.v1'
          && webhookJsonSingleNotificationProfilePreset(profile_id) !== null
          && delivery_deduplicator.delivery_id_field === 'delivery_id'
          && delivery_deduplicator.event_id_field
            === event_projector.provider_event_id_field));
  if (!descriptor
    || descriptor.mechanism_kind !== 'timestamped_hmac'
    || !decoderKindValid
    || !decoderContentTypesValid
    || !jsonSurfacesValid
    || !handshakesValid
    || !formJsonEnvelopeValid
    || !eventNormalizerValid
    || !environmentAdmissionValid
    || !testEnvelopeValid
    || !admissionMethodLabelValid
    || !runtimeErrorLabelValid
    || !flatFormEventNormalizerValid
    || (event_projector !== null
      && (descriptor.max_events_per_delivery !== 1
        || !normalizedEventProjectorFieldsValid))
    || !deliveryDeduplicatorValid
    || (form_decoder !== null
      && form_decoder.max_body_bytes !== descriptor.max_body_bytes)
    || descriptor.fields.some((field) => !field.required)
    || secretDescriptor?.kind !== 'secret'
    || (headerField !== null && headerDescriptor?.kind !== 'text')
    || !credentialSourcesValid
    || [...mechanismFields].sort().join('\0') !== [...descriptorFields].sort().join('\0')) {
    throw new Error(
      `webhook timestamped delivery-engine preset '${profile_id}' does not match its descriptor`,
    );
  }
  const credential_sources = Object.freeze(Object.fromEntries(
    credentialSourceEntries,
  )) as Readonly<Record<string, WebhookProfileFieldSource>>;
  const value = Object.freeze({
    profile_id,
    mechanism,
    decoder,
    form_decoder,
    form_json_envelope,
    flat_form_event_normalizer,
    handshake,
    event_projector,
    delivery_deduplicator,
    event_normalizer,
    environment_admission,
    test_envelope,
    admission_method_label: admissionMethodLabelInput,
    runtime_error_label: runtimeErrorLabelInput,
    credential_sources,
  });
  JSON.stringify(value);
  return value;
};

const stripePrefixedAsciiCredentialPreset =
  webhookPrefixedAsciiCredentialProfilePreset('stripe.event.v1');
if (stripePrefixedAsciiCredentialPreset === null) {
  throw new Error('Stripe prefixed ASCII credential preset is unavailable');
}
const paddleSegmentedAsciiCredentialPreset =
  webhookSegmentedAsciiCredentialProfilePreset('paddle.notification.v1');
if (paddleSegmentedAsciiCredentialPreset === null) {
  throw new Error('Paddle segmented ASCII credential preset is unavailable');
}

const TIMESTAMPED_HMAC_PRESET_LIST = [
  timestampedPreset('generic.timestamped-raw-body-hmac-sha256.v1', {
    kind: 'timestamped_hmac_sha256.v1',
    secret_field: 'signing_secret',
    secret_shape: {
      kind: 'nonempty_utf8.v1',
      max_bytes: 65_536,
    },
    signature_header: {
      kind: 'credential_field',
      field: 'signature_header',
    },
    timestamp_source: { kind: 'signature_envelope' },
    signature_envelope: 'strict_ordered_comma_t_v1_lowerhex.v1',
    signed_payload: 'timestamp_dot_raw_body.v1',
    replay_window_seconds: 300,
    admission_order: 'clock_then_signature',
    matching_credential: 'first',
  }, {
    signature_header: 'owner',
    signing_secret: 'owner',
  }),
  timestampedPreset('stripe.event.v1', {
    kind: 'timestamped_hmac_sha256.v1',
    secret_field: stripePrefixedAsciiCredentialPreset.credential_field,
    secret_shape: stripePrefixedAsciiCredentialPreset.parser,
    signature_header: {
      kind: 'fixed',
      name: STRIPE_SIGNATURE_HEADER,
    },
    timestamp_source: { kind: 'signature_envelope' },
    signature_envelope: 'extensible_comma_t_v1_hex.v1',
    signed_payload: 'timestamp_dot_raw_body.v1',
    replay_window_seconds: 300,
    admission_order: 'signature_then_clock',
    matching_credential: 'newest',
  }, {
    endpoint_secret: 'vendor_generated',
  }, null, null, {
    kind: 'normalized_single_event.v1',
    provider_event_id_field: 'event_id',
    provider_resource_id_field: 'resource_id',
    provider_event_type_field: 'event_type',
    provider_occurred_at_field: 'occurred_at',
    decoded_payload_field: 'payload',
    occurred_at_unit: 'unix_seconds_to_milliseconds.v1',
  }, {
    kind: 'normalized_id_or_timestamp_body_sha256.v1',
    stable_id_field: 'event_id',
    stable_id_prefix: 'stripe:event:',
    fallback_prefix: 'stripe:request:',
    max_body_bytes: 1_048_576,
  }, {
    kind: 'json_single_event_fields.v1',
    event_type_field: 'type',
    event_type_grammar: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
    event_type_max_bytes: 128,
    event_id_field: 'id',
    event_id_max_bytes: 512,
    event_id_required: true,
    provider_id_grammar: 'trimmed_utf8.v1',
    resource_id_field: null,
    resource_fallback_object_field: 'data',
    resource_fallback_nested_object_field: 'object',
    resource_fallback_id_field: 'id',
    resource_id_max_bytes: 512,
    resource_id_required: false,
    invalid_resource_id_disposition: 'treat_as_absent.v1',
    occurred_at_field: 'created',
    occurred_at_unit: 'unix_seconds.v1',
    occurred_at_required: true,
    challenge_field: null,
    challenge_max_bytes: null,
    conditional_object_requirement: null,
    exact_string_requirement: {
      field: 'object',
      value: 'event',
    },
  }, null, null, {
    kind: 'json_boolean_environment_map.v1',
    boolean_field: 'livemode',
    false_environment: 'test',
    true_environment: 'live',
  }, {
    kind: 'json_single_event_test_envelope.v1',
    nonce_grammar: 'lowercase_hex_64.v1',
    event_id_prefix: 'evt_recued_test_',
    resource_id_prefix: 'recued_test_',
    marker_object_field: 'recued_test_delivery',
    marker_nonce_field: 'nonce',
  }, 'stripe-signature-v1', 'Stripe webhook'),
  timestampedPreset('paddle.notification.v1', {
    kind: 'timestamped_hmac_sha256.v1',
    secret_field: paddleSegmentedAsciiCredentialPreset.credential_field,
    secret_shape: paddleSegmentedAsciiCredentialPreset.parser,
    signature_header: {
      kind: 'fixed',
      name: PADDLE_SIGNATURE_HEADER,
    },
    timestamp_source: { kind: 'signature_envelope' },
    signature_envelope: 'strict_semicolon_ts_h1_lowerhex.v1',
    signed_payload: 'timestamp_colon_raw_body.v1',
    replay_window_seconds: 5,
    admission_order: 'signature_then_clock',
    matching_credential: 'newest',
  }, {
    endpoint_secret_key: 'vendor_generated',
  }, null, null, {
    kind: 'normalized_single_event.v1',
    provider_event_id_field: 'event_id',
    provider_resource_id_field: 'resource_id',
    provider_event_type_field: 'event_type',
    provider_occurred_at_field: 'occurred_at',
    decoded_payload_field: 'payload',
    occurred_at_unit: 'unix_milliseconds.v1',
  }, {
    kind: 'normalized_paired_ids_sha256.v1',
    delivery_id_field: 'delivery_id',
    event_id_field: 'event_id',
    delivery_id_prefix: 'paddle:notification:',
    event_id_prefix: 'paddle:event:',
  }, null, null, null, null, null, 'paddle-hmac-sha256'),
  timestampedPreset('slack.request.v0', {
    kind: 'timestamped_hmac_sha256.v1',
    secret_field: 'signing_secret',
    secret_shape: {
      kind: 'nonempty_utf8.v1',
      max_bytes: 4_096,
    },
    signature_header: {
      kind: 'fixed',
      name: SLACK_SIGNATURE_HEADER,
    },
    timestamp_source: {
      kind: 'fixed_header',
      name: SLACK_REQUEST_TIMESTAMP_HEADER,
    },
    signature_envelope: 'separate_decimal_timestamp_v0_lowerhex.v1',
    signed_payload: 'v0_colon_timestamp_colon_raw_body.v1',
    replay_window_seconds: 300,
    admission_order: 'signature_then_clock',
    matching_credential: 'newest',
  }, {
    signing_secret: 'vendor_generated',
  }, WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET, {
    portable_kind: 'slack_url_verification',
    projector: {
      kind: 'json_challenge_echo.v1',
      discriminator_field: 'type',
      discriminator_value: 'url_verification',
      challenge_field: 'challenge',
      response_field: 'challenge',
      max_challenge_bytes: 4_096,
    },
  }, {
    kind: 'normalized_single_event.v1',
    provider_event_id_field: 'event_id',
    provider_resource_id_field: 'resource_id',
    provider_event_type_field: 'event_type',
    provider_occurred_at_field: 'occurred_at',
    decoded_payload_field: 'payload',
    occurred_at_unit: 'unix_seconds_to_milliseconds.v1',
  }, {
    kind: 'normalized_id_or_timestamp_body_sha256.v1',
    stable_id_field: 'event_id',
    stable_id_prefix: 'slack:event:',
    fallback_prefix: 'slack:request:',
    max_body_bytes: 1_048_576,
  }, {
    kind: 'json_single_event_fields.v1',
    event_type_field: 'type',
    event_type_grammar: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
    event_type_max_bytes: 128,
    event_id_field: 'event_id',
    event_id_max_bytes: 512,
    event_id_required: false,
    provider_id_grammar: 'control_free_trimmed_utf8.v1',
    resource_id_field: 'team_id',
    resource_fallback_object_field: 'team',
    resource_fallback_nested_object_field: null,
    resource_fallback_id_field: 'id',
    resource_id_max_bytes: 512,
    resource_id_required: false,
    invalid_resource_id_disposition: 'reject.v1',
    occurred_at_field: 'event_time',
    occurred_at_unit: 'unix_seconds.v1',
    occurred_at_required: false,
    challenge_field: 'challenge',
    challenge_max_bytes: 4_096,
    conditional_object_requirement: {
      when_event_type: 'event_callback',
      required_object_field: 'event',
    },
    exact_string_requirement: null,
  }, {
    kind: 'exclusive_form_json_field.v1',
    json_field: 'payload',
  }, {
    kind: 'flat_form_slash_command_event.v1',
    event_type: 'slash_command',
    payload_event_type_field: 'type',
    command_field: 'command',
    event_id_field: 'trigger_id',
    event_id_max_bytes: 512,
    resource_id_field: 'team_id',
    resource_id_max_bytes: 512,
    reserved_fields: ['type', 'event_id', 'event_time', 'challenge'],
    payload_omitted_fields: [],
  }, null, null, 'slack-signature-v0', 'Slack webhook'),
  timestampedPreset('slack.slash-command.v1', {
    kind: 'timestamped_hmac_sha256.v1',
    secret_field: 'signing_secret',
    secret_shape: {
      kind: 'nonempty_utf8.v1',
      max_bytes: 4_096,
    },
    signature_header: {
      kind: 'fixed',
      name: SLACK_SIGNATURE_HEADER,
    },
    timestamp_source: {
      kind: 'fixed_header',
      name: SLACK_REQUEST_TIMESTAMP_HEADER,
    },
    signature_envelope: 'separate_decimal_timestamp_v0_lowerhex.v1',
    signed_payload: 'v0_colon_timestamp_colon_raw_body.v1',
    replay_window_seconds: 300,
    admission_order: 'signature_then_clock',
    matching_credential: 'newest',
  }, {
    signing_secret: 'vendor_generated',
  }, WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET, null, {
    kind: 'normalized_single_event.v1',
    provider_event_id_field: 'event_id',
    provider_resource_id_field: 'resource_id',
    provider_event_type_field: 'event_type',
    provider_occurred_at_field: 'occurred_at',
    decoded_payload_field: 'payload',
    occurred_at_unit: 'unix_seconds_to_milliseconds.v1',
  }, {
    kind: 'normalized_id_or_timestamp_body_sha256.v1',
    stable_id_field: 'event_id',
    stable_id_prefix: 'slack:slash-command:',
    fallback_prefix: 'slack:slash-request:',
    max_body_bytes: 1_048_576,
  }, null, null, {
    kind: 'flat_form_slash_command_event.v1',
    event_type: 'slash_command',
    payload_event_type_field: 'type',
    command_field: 'command',
    event_id_field: 'trigger_id',
    event_id_max_bytes: 512,
    resource_id_field: 'team_id',
    resource_id_max_bytes: 512,
    reserved_fields: [
      'type',
      'event_id',
      'event_time',
      'challenge',
      'ssl_check',
    ],
    payload_omitted_fields: ['response_url', 'token'],
  }),
  // SPIKE — Recued-to-Recued peer exchange. Every other entry in this list
  // accommodates a wire format someone else chose; this one declares ours, so
  // the fields below are the peer envelope rather than a mapping onto it:
  //     { v: "1", kind, action_ref, ts, data }
  // `action_ref` is deliberately BOTH the correlation handle the requester
  // holds and the dedup identity — the consumer's create-or-reuse on run_id
  // then makes an at-least-once retry re-enter the same business run instead
  // of replying twice.
  timestampedPreset('recued-peer.exchange.v1', {
    kind: 'timestamped_hmac_sha256.v1',
    secret_field: 'signing_secret',
    secret_shape: { kind: 'nonempty_utf8.v1', max_bytes: 65_536 },
    // Fixed, not a credential field: both ends are ours, so there is no vendor
    // header grammar to accommodate and no reason to let an owner mistype one.
    signature_header: { kind: 'fixed', name: 'x-recued-signature' },
    timestamp_source: { kind: 'signature_envelope' },
    signature_envelope: 'strict_ordered_comma_t_v1_lowerhex.v1',
    signed_payload: 'timestamp_dot_raw_body.v1',
    replay_window_seconds: 300,
    // Clock first: a stale delivery is rejected before the HMAC is computed.
    admission_order: 'clock_then_signature',
    // `newest` so a rotation can overlap two live secrets (the substrate allows
    // MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS = 2) without a delivery gap.
    matching_credential: 'newest',
  }, {
    signing_secret: 'recued_generated',
  }, null, null, {
    kind: 'normalized_single_event.v1',
    provider_event_id_field: 'event_id',
    provider_resource_id_field: 'resource_id',
    provider_event_type_field: 'event_type',
    provider_occurred_at_field: 'occurred_at',
    decoded_payload_field: 'payload',
    occurred_at_unit: 'unix_seconds_to_milliseconds.v1',
  }, {
    kind: 'normalized_id_or_timestamp_body_sha256.v1',
    stable_id_field: 'event_id',
    stable_id_prefix: 'recued:peer:',
    fallback_prefix: 'recued:peer-body:',
    max_body_bytes: 1_048_576,
  }, {
    kind: 'json_single_event_fields.v1',
    // `kind` is the trigger routing key — the reason this profile exists rather
    // than reusing the generic timestamped one, whose event type is the single
    // literal 'delivery'.
    event_type_field: 'kind',
    event_type_grammar: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
    event_type_max_bytes: 128,
    event_id_field: 'action_ref',
    event_id_max_bytes: 512,
    // Required, unlike every vendor profile here: we control the sender, so a
    // delivery with no correlation handle is malformed rather than tolerated.
    event_id_required: true,
    provider_id_grammar: 'control_free_trimmed_utf8.v1',
    resource_id_field: null,
    // The test-envelope composer requires a resource fallback path, and that
    // requirement is right: an exchange is always ABOUT something. So the peer
    // envelope's `data` carries the subject's id (`data.id` — the booking, the
    // request), which is what a timeline entry and an audit row both want to
    // point at anyway.
    resource_fallback_object_field: 'data',
    resource_fallback_nested_object_field: null,
    resource_fallback_id_field: 'id',
    resource_id_max_bytes: 512,
    resource_id_required: false,
    invalid_resource_id_disposition: 'treat_as_absent.v1',
    occurred_at_field: 'ts',
    occurred_at_unit: 'unix_seconds.v1',
    occurred_at_required: true,
    challenge_field: null,
    challenge_max_bytes: null,
    conditional_object_requirement: null,
    // Protocol version pinned at ADMISSION: a v2 envelope is refused by the
    // ingress rather than reaching a recipe that would read v1 field names.
    exact_string_requirement: { field: 'v', value: '1' },
  }, null, null, {
    // The composer requires an environment map, and a peer protocol turns out
    // to WANT one: enrolment should be provable without a test delivery landing
    // as a real booking. So `live` is part of the peer envelope, not a vendor
    // concession.
    kind: 'json_boolean_environment_map.v1',
    boolean_field: 'live',
    false_environment: 'test',
    true_environment: 'live',
  }, {
    // Likewise the test envelope: "send a test delivery to prove the peer link"
    // is exactly the gesture two owners need at enrolment, before either trusts
    // the other with a real exchange.
    kind: 'json_single_event_test_envelope.v1',
    nonce_grammar: 'lowercase_hex_64.v1',
    event_id_prefix: 'ref_recued_test_',
    resource_id_prefix: 'recued_test_',
    marker_object_field: 'recued_test_delivery',
    marker_nonce_field: 'nonce',
  }, 'recued-peer-signature-v1', 'Recued peer webhook'),
] as const;

const mutableTimestamped = Object.create(null) as Record<
  WebhookProfileId,
  WebhookTimestampedHmacDeliveryProfilePreset | undefined
>;
for (const value of TIMESTAMPED_HMAC_PRESET_LIST) {
  if (Object.prototype.hasOwnProperty.call(mutableTimestamped, value.profile_id)) {
    throw new Error(
      `duplicate webhook timestamped delivery-engine preset '${value.profile_id}'`,
    );
  }
  mutableTimestamped[value.profile_id] = value;
}

export const WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS: Readonly<
  Partial<Record<WebhookProfileId, WebhookTimestampedHmacDeliveryProfilePreset>>
> = Object.freeze(mutableTimestamped);

export const webhookTimestampedHmacDeliveryProfilePreset = (
  profileId: WebhookProfileId,
): WebhookTimestampedHmacDeliveryProfilePreset | null =>
  WEBHOOK_TIMESTAMPED_HMAC_DELIVERY_PROFILE_PRESETS[profileId] ?? null;
