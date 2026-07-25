/** D-201 Slice 9C — closed JSON single-event test-envelope builder.
 *
 * Trusted preset data supplies only bounded identity prefixes, one fixed nonce
 * grammar, and marker field names. Existing decoder, event-normalizer, and
 * environment-admission presets supply the wire field meaning. Object shape,
 * nesting, field order, JSON encoding, validation, and failure reasons are
 * code-fixed; there is no template language, JSONPath, callback, or vendor
 * branch.
 */

import type { WebhookEnvironment } from '@recued/contracts';
import {
  createWebhookJsonEnvironmentAdmission,
  type WebhookJsonEnvironmentAdmissionPreset,
} from './webhook-json-environment-admission.js';
import {
  createWebhookJsonEventNormalizer,
  type WebhookJsonEventNormalizerPreset,
} from './webhook-json-event-normalizer.js';
import {
  createWebhookJsonObjectDecoder,
  type WebhookJsonObjectDecoderPreset,
} from './webhook-json-object-decoder.js';

export interface WebhookJsonSingleEventTestEnvelopePreset {
  readonly kind: 'json_single_event_test_envelope.v1';
  readonly nonce_grammar: 'lowercase_hex_64.v1';
  readonly event_id_prefix: string;
  readonly resource_id_prefix: string;
  readonly marker_object_field: string;
  readonly marker_nonce_field: string;
}

export interface WebhookJsonSingleEventTestEnvelopeInput {
  readonly nonce: unknown;
  readonly event_type: unknown;
  readonly occurred_at: unknown;
  readonly environment: WebhookEnvironment;
}

export type WebhookJsonSingleEventTestEnvelopeBuildResult =
  | Readonly<{ ok: false; reason: 'invalid_nonce' | 'invalid_envelope' }>
  | Readonly<{ ok: true; raw_body: Buffer }>;

export interface WebhookJsonSingleEventTestEnvelopeBuilder {
  readonly preset: WebhookJsonSingleEventTestEnvelopePreset;
  hasValidNonce(nonce: unknown): boolean;
  build(
    input: WebhookJsonSingleEventTestEnvelopeInput,
  ): WebhookJsonSingleEventTestEnvelopeBuildResult;
}

const MAX_FIELD_BYTES = 128;
const MAX_PREFIX_BYTES = 128;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NONCE_RE = /^[0-9a-f]{64}$/;
const PROTOTYPE_SENSITIVE_FIELDS = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);
const PRESET_KEYS = new Set([
  'kind',
  'nonce_grammar',
  'event_id_prefix',
  'resource_id_prefix',
  'marker_object_field',
  'marker_nonce_field',
]);
const BUILD_INPUT_KEYS = new Set([
  'nonce',
  'event_type',
  'occurred_at',
  'environment',
]);
const INVALID_NONCE = Object.freeze({
  ok: false,
  reason: 'invalid_nonce',
} as const);
const INVALID_ENVELOPE = Object.freeze({
  ok: false,
  reason: 'invalid_envelope',
} as const);

const validField = (value: unknown): value is string =>
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= MAX_FIELD_BYTES
  && FIELD_RE.test(value)
  && !PROTOTYPE_SENSITIVE_FIELDS.has(value);

const validPrefix = (value: unknown): value is string =>
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= MAX_PREFIX_BYTES
  && PREFIX_RE.test(value);

const exactDataValues = (
  value: unknown,
  keys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.size
      || ownKeys.some((key) => typeof key !== 'string' || !keys.has(key))) {
      return null;
    }
    const fields = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys) {
      if (typeof key !== 'string') return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)) {
        return null;
      }
      fields[key] = descriptor.value;
    }
    return fields;
  } catch {
    return null;
  }
};

const ownDataValue = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  return descriptor !== undefined
    && descriptor.enumerable
    && 'value' in descriptor
    ? descriptor.value
    : undefined;
};

export const createWebhookJsonSingleEventTestEnvelopeBuilder = (
  input: WebhookJsonSingleEventTestEnvelopePreset,
  decoderInput: WebhookJsonObjectDecoderPreset,
  normalizerInput: WebhookJsonEventNormalizerPreset,
  environmentInput: WebhookJsonEnvironmentAdmissionPreset,
): WebhookJsonSingleEventTestEnvelopeBuilder => {
  const fields = exactDataValues(input, PRESET_KEYS);
  const decoder = createWebhookJsonObjectDecoder(decoderInput);
  const normalizer = createWebhookJsonEventNormalizer(normalizerInput);
  const environmentAdmission = createWebhookJsonEnvironmentAdmission(
    environmentInput,
  );
  const normalizerPreset = normalizer.preset;
  const environmentPreset = environmentAdmission.preset;
  const exactString = normalizerPreset.exact_string_requirement;
  const fallbackObjectField = normalizerPreset.resource_fallback_object_field;
  const fallbackNestedObjectField =
    normalizerPreset.resource_fallback_nested_object_field;
  const fallbackIdField = normalizerPreset.resource_fallback_id_field;
  if (fields === null
    || fields.kind !== 'json_single_event_test_envelope.v1'
    || fields.nonce_grammar !== 'lowercase_hex_64.v1'
    || !validPrefix(fields.event_id_prefix)
    || !validPrefix(fields.resource_id_prefix)
    || !validField(fields.marker_object_field)
    || !validField(fields.marker_nonce_field)
    || !normalizerPreset.event_id_required
    || !normalizerPreset.occurred_at_required
    || normalizerPreset.resource_id_field !== null
    || fallbackObjectField === null
    || fallbackIdField === null
    || exactString === null
    || normalizerPreset.challenge_field !== null
    || normalizerPreset.conditional_object_requirement !== null
    || Buffer.byteLength(`${fields.event_id_prefix}${'0'.repeat(64)}`, 'utf8')
      > normalizerPreset.event_id_max_bytes
    || Buffer.byteLength(
      `${fields.resource_id_prefix}${'0'.repeat(64)}`,
      'utf8',
    ) > normalizerPreset.resource_id_max_bytes) {
    throw new Error('webhook JSON test envelope: invalid trusted preset');
  }
  const topLevelFields = [
    normalizerPreset.event_id_field,
    exactString.field,
    normalizerPreset.event_type_field,
    normalizerPreset.occurred_at_field,
    environmentPreset.boolean_field,
    fallbackObjectField,
    fields.marker_object_field,
  ];
  const nestedFields = [
    fallbackNestedObjectField,
    fallbackIdField,
    fields.marker_nonce_field,
  ].filter((field): field is string => field !== null);
  if (topLevelFields.some((field) => !validField(field))
    || nestedFields.some((field) => !validField(field))
    || new Set(topLevelFields).size !== topLevelFields.length) {
    throw new Error('webhook JSON test envelope: invalid trusted preset');
  }
  const preset: WebhookJsonSingleEventTestEnvelopePreset = Object.freeze({
    kind: fields.kind,
    nonce_grammar: fields.nonce_grammar,
    event_id_prefix: fields.event_id_prefix,
    resource_id_prefix: fields.resource_id_prefix,
    marker_object_field: fields.marker_object_field,
    marker_nonce_field: fields.marker_nonce_field,
  });
  const hasValidNonce = (nonce: unknown): nonce is string =>
    typeof nonce === 'string' && NONCE_RE.test(nonce);

  return Object.freeze({
    preset,
    hasValidNonce,
    build(
      buildInput: WebhookJsonSingleEventTestEnvelopeInput,
    ): WebhookJsonSingleEventTestEnvelopeBuildResult {
      const buildFields = exactDataValues(buildInput, BUILD_INPUT_KEYS);
      if (buildFields === null) return INVALID_ENVELOPE;
      if (!hasValidNonce(buildFields.nonce)) {
        return INVALID_NONCE;
      }
      try {
        const eventType = buildFields.event_type;
        const occurredAt = buildFields.occurred_at;
        const environment = buildFields.environment;
        if (typeof eventType !== 'string'
          || !Number.isSafeInteger(occurredAt)
          || (occurredAt as number) < 0
          || (normalizerPreset.occurred_at_unit === 'unix_seconds.v1'
            && (occurredAt as number)
              > Math.floor(Number.MAX_SAFE_INTEGER / 1_000))) {
          return INVALID_ENVELOPE;
        }
        const environmentValue = environment
          === environmentPreset.false_environment
          ? false
          : environment === environmentPreset.true_environment
            ? true
            : null;
        if (environmentValue === null) return INVALID_ENVELOPE;
        const nonce = buildFields.nonce;
        const eventId = `${preset.event_id_prefix}${nonce}`;
        const resourceId = `${preset.resource_id_prefix}${nonce}`;
        const envelope = Object.create(null) as Record<string, unknown>;
        envelope[normalizerPreset.event_id_field] = eventId;
        envelope[exactString.field] = exactString.value;
        envelope[normalizerPreset.event_type_field] = eventType;
        envelope[normalizerPreset.occurred_at_field] = occurredAt;
        envelope[environmentPreset.boolean_field] = environmentValue;

        const resourceContainer = Object.create(null) as Record<string, unknown>;
        if (fallbackNestedObjectField === null) {
          resourceContainer[fallbackIdField] = resourceId;
        } else {
          const nestedResource = Object.create(null) as Record<string, unknown>;
          nestedResource[fallbackIdField] = resourceId;
          resourceContainer[fallbackNestedObjectField] = nestedResource;
        }
        envelope[fallbackObjectField] = resourceContainer;
        const marker = Object.create(null) as Record<string, string>;
        marker[preset.marker_nonce_field] = nonce;
        envelope[preset.marker_object_field] = marker;

        const rawBody = Buffer.from(JSON.stringify(envelope), 'utf8');
        const decoded = decoder.decode(rawBody);
        if (decoded === null) return INVALID_ENVELOPE;
        const normalized = normalizer.normalize(decoded);
        if (normalized === null
          || normalized.event_id !== eventId
          || normalized.resource_id !== resourceId
          || normalized.event_type !== eventType
          || normalized.occurred_at !== occurredAt
          || environmentAdmission.classify(
            decoded,
            environment as WebhookEnvironment,
          ).kind !== 'matched') {
          return INVALID_ENVELOPE;
        }
        const decodedMarker = ownDataValue(decoded, preset.marker_object_field);
        if (decodedMarker === null
          || typeof decodedMarker !== 'object'
          || Array.isArray(decodedMarker)
          || ownDataValue(
            decodedMarker as Readonly<Record<string, unknown>>,
            preset.marker_nonce_field,
          ) !== nonce) {
          return INVALID_ENVELOPE;
        }
        return Object.freeze({ ok: true, raw_body: rawBody });
      } catch {
        return INVALID_ENVELOPE;
      }
    },
  });
};
