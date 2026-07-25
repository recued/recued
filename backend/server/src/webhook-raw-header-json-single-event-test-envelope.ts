/** D-201 Slice 9V — closed raw-header JSON single-event test envelope.
 *
 * Trusted preset data supplies one canonical marker-free JSON object, one
 * fixed nonce grammar and UUID derivation, one structural-evidence literal,
 * and marker field names. Existing decoder, header-metadata, and parser
 * semantics validate the result. There is no profile id, vendor branch,
 * callback, placeholder/template language, clock, signature, or credential
 * behavior here.
 */

import { createHash } from 'node:crypto';
import {
  createWebhookJsonObjectDecoder,
  type WebhookJsonObjectDecoderPreset,
} from './webhook-json-object-decoder.js';
import {
  compileWebhookRawHeaderSingleEventMetadataNormalizerPreset,
  createWebhookRawHeaderSingleEventMetadataNormalizer,
  type WebhookRawHeaderSingleEventMetadataNormalizerDependencies,
  type WebhookRawHeaderSingleEventMetadataNormalizerPreset,
} from './webhook-raw-header-single-event-metadata-normalizer.js';

export interface WebhookRawHeaderJsonSingleEventTestEnvelopePreset {
  readonly kind: 'raw_header_json_single_event_test_envelope.v1';
  readonly nonce_grammar: 'lowercase_hex_64.v1';
  readonly delivery_id_derivation: 'sha256_uuid_v4_variant8.v1';
  readonly delivery_id_domain_separator: string;
  readonly structural_evidence: string;
  readonly base_payload_json: string;
  readonly marker_object_field: string;
  readonly marker_nonce_field: string;
  readonly max_body_bytes: number;
}

export interface WebhookRawHeaderJsonSingleEventTestEnvelopeInput {
  readonly nonce: unknown;
  readonly event_type: unknown;
}

export type WebhookRawHeaderJsonSingleEventTestEnvelopeBuildResult =
  | Readonly<{ ok: false; reason: 'invalid_nonce' | 'invalid_envelope' }>
  | Readonly<{
    ok: true;
    raw_body: Buffer;
    headers: Readonly<Record<string, string>>;
  }>;

export interface WebhookRawHeaderJsonSingleEventTestEnvelopeBuilder {
  readonly preset: WebhookRawHeaderJsonSingleEventTestEnvelopePreset;
  hasValidNonce(nonce: unknown): boolean;
  build(
    input: WebhookRawHeaderJsonSingleEventTestEnvelopeInput,
  ): WebhookRawHeaderJsonSingleEventTestEnvelopeBuildResult;
}

const MAX_DOMAIN_SEPARATOR_BYTES = 128;
const MAX_STRUCTURAL_EVIDENCE_BYTES = 128;
const MAX_BODY_BYTES = 1_048_576;
const MAX_FIELD_BYTES = 128;
const NONCE_RE = /^[0-9a-f]{64}$/;
const DOMAIN_SEPARATOR_RE = /^[a-z][a-z0-9._:-]*:$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const PROTOTYPE_SENSITIVE_FIELDS = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);
const PRESET_KEYS = new Set([
  'kind',
  'nonce_grammar',
  'delivery_id_derivation',
  'delivery_id_domain_separator',
  'structural_evidence',
  'base_payload_json',
  'marker_object_field',
  'marker_nonce_field',
  'max_body_bytes',
]);
const BUILD_INPUT_KEYS = new Set(['nonce', 'event_type']);
const INVALID_NONCE = Object.freeze({
  ok: false,
  reason: 'invalid_nonce',
} as const);
const INVALID_ENVELOPE = Object.freeze({
  ok: false,
  reason: 'invalid_envelope',
} as const);

const exactDataValues = (
  value: unknown,
  keys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    const ownKeys = Reflect.ownKeys(value);
    if ((prototype !== Object.prototype && prototype !== null)
      || ownKeys.length !== keys.size
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

const validField = (value: unknown): value is string =>
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= MAX_FIELD_BYTES
  && FIELD_RE.test(value)
  && !PROTOTYPE_SENSITIVE_FIELDS.has(value);

const boundedLiteral = (
  value: unknown,
  maxBytes: number,
): value is string => typeof value === 'string'
  && value.length > 0
  && value.trim() === value
  && !CONTROL_CHARACTER_RE.test(value)
  && Buffer.byteLength(value, 'utf8') <= maxBytes;

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

const deriveDeliveryId = (domainSeparator: string, nonce: string): string => {
  const digest = createHash('sha256')
    .update(domainSeparator, 'utf8')
    .update(nonce, 'utf8')
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}`
    + `-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}`
    + `-${digest.slice(20, 32)}`;
};

const appendNonceMarker = (
  base: Record<string, unknown>,
  markerObjectField: string,
  markerNonceField: string,
  nonce: string,
): void => {
  const marker = Object.create(null) as Record<string, string>;
  marker[markerNonceField] = nonce;
  base[markerObjectField] = marker;
};

export const compileWebhookRawHeaderJsonSingleEventTestEnvelopePreset = (
  input: WebhookRawHeaderJsonSingleEventTestEnvelopePreset,
  decoderInput: WebhookJsonObjectDecoderPreset,
): WebhookRawHeaderJsonSingleEventTestEnvelopePreset => {
  const fields = exactDataValues(input, PRESET_KEYS);
  const decoder = createWebhookJsonObjectDecoder(decoderInput);
  if (fields === null
    || fields.kind !== 'raw_header_json_single_event_test_envelope.v1'
    || fields.nonce_grammar !== 'lowercase_hex_64.v1'
    || fields.delivery_id_derivation !== 'sha256_uuid_v4_variant8.v1'
    || !boundedLiteral(
      fields.delivery_id_domain_separator,
      MAX_DOMAIN_SEPARATOR_BYTES,
    )
    || !DOMAIN_SEPARATOR_RE.test(fields.delivery_id_domain_separator as string)
    || !boundedLiteral(
      fields.structural_evidence,
      MAX_STRUCTURAL_EVIDENCE_BYTES,
    )
    || typeof fields.base_payload_json !== 'string'
    || !validField(fields.marker_object_field)
    || !validField(fields.marker_nonce_field)
    || fields.marker_object_field === fields.marker_nonce_field
    || !Number.isSafeInteger(fields.max_body_bytes)
    || (fields.max_body_bytes as number) < 1
    || (fields.max_body_bytes as number) > MAX_BODY_BYTES) {
    throw new Error('webhook raw-header JSON test envelope: invalid trusted preset');
  }
  const basePayloadJson = fields.base_payload_json as string;
  const basePayloadBytes = Buffer.byteLength(basePayloadJson, 'utf8');
  if (basePayloadBytes < 2
    || basePayloadBytes > (fields.max_body_bytes as number)) {
    throw new Error('webhook raw-header JSON test envelope: invalid trusted preset');
  }
  const baseBytes = Buffer.from(basePayloadJson, 'utf8');
  const base = decoder.decode(baseBytes);
  if (base === null
    || JSON.stringify(base) !== basePayloadJson
    || Object.getOwnPropertyDescriptor(
      base,
      fields.marker_object_field as string,
    ) !== undefined) {
    throw new Error('webhook raw-header JSON test envelope: invalid trusted preset');
  }
  appendNonceMarker(
    base,
    fields.marker_object_field as string,
    fields.marker_nonce_field as string,
    '0'.repeat(64),
  );
  const probeBody = Buffer.from(JSON.stringify(base), 'utf8');
  if (probeBody.byteLength > (fields.max_body_bytes as number)
    || decoder.decode(probeBody) === null) {
    throw new Error('webhook raw-header JSON test envelope: invalid trusted preset');
  }
  return Object.freeze({
    kind: fields.kind,
    nonce_grammar: fields.nonce_grammar,
    delivery_id_derivation: fields.delivery_id_derivation,
    delivery_id_domain_separator: fields.delivery_id_domain_separator as string,
    structural_evidence: fields.structural_evidence as string,
    base_payload_json: basePayloadJson,
    marker_object_field: fields.marker_object_field as string,
    marker_nonce_field: fields.marker_nonce_field as string,
    max_body_bytes: fields.max_body_bytes as number,
  });
};

export const createWebhookRawHeaderJsonSingleEventTestEnvelopeBuilder = (
  input: WebhookRawHeaderJsonSingleEventTestEnvelopePreset,
  decoderInput: WebhookJsonObjectDecoderPreset,
  metadataInput: WebhookRawHeaderSingleEventMetadataNormalizerPreset,
  dependencies: WebhookRawHeaderSingleEventMetadataNormalizerDependencies,
): WebhookRawHeaderJsonSingleEventTestEnvelopeBuilder => {
  const preset = compileWebhookRawHeaderJsonSingleEventTestEnvelopePreset(
    input,
    decoderInput,
  );
  const decoder = createWebhookJsonObjectDecoder(decoderInput);
  const metadataPreset =
    compileWebhookRawHeaderSingleEventMetadataNormalizerPreset(metadataInput);
  const metadataNormalizer =
    createWebhookRawHeaderSingleEventMetadataNormalizer(
      metadataPreset,
      dependencies,
    );
  try {
    const probeDeliveryId = deriveDeliveryId(
      preset.delivery_id_domain_separator,
      '0'.repeat(64),
    );
    if (dependencies.delivery_id_parser.parse(probeDeliveryId)
        !== probeDeliveryId
      || dependencies.structural_evidence_parser.parse(
        preset.structural_evidence,
      ) !== preset.structural_evidence) {
      throw new Error('incompatible parser');
    }
  } catch {
    throw new Error('webhook raw-header JSON test envelope: invalid trusted preset');
  }
  const hasValidNonce = (nonce: unknown): nonce is string =>
    typeof nonce === 'string' && NONCE_RE.test(nonce);

  return Object.freeze({
    preset,
    hasValidNonce,
    build(
      buildInput: WebhookRawHeaderJsonSingleEventTestEnvelopeInput,
    ): WebhookRawHeaderJsonSingleEventTestEnvelopeBuildResult {
      const buildFields = exactDataValues(buildInput, BUILD_INPUT_KEYS);
      if (buildFields === null) return INVALID_ENVELOPE;
      if (!hasValidNonce(buildFields.nonce)) return INVALID_NONCE;
      try {
        if (typeof buildFields.event_type !== 'string') {
          return INVALID_ENVELOPE;
        }
        const nonce = buildFields.nonce;
        const deliveryId = deriveDeliveryId(
          preset.delivery_id_domain_separator,
          nonce,
        );
        const rawHeaders = new Map<string, readonly string[]>([
          [metadataPreset.delivery_id_header, [deliveryId]],
          [metadataPreset.event_type_header, [buildFields.event_type]],
          [metadataPreset.structural_evidence_header, [
            preset.structural_evidence,
          ]],
        ]);
        const metadata = metadataNormalizer.normalize(rawHeaders);
        if (metadata === null
          || metadata.delivery_id !== deliveryId
          || metadata.structural_evidence !== preset.structural_evidence) {
          return INVALID_ENVELOPE;
        }
        const base = decoder.decode(Buffer.from(preset.base_payload_json, 'utf8'));
        if (base === null) return INVALID_ENVELOPE;
        appendNonceMarker(
          base,
          preset.marker_object_field,
          preset.marker_nonce_field,
          nonce,
        );
        const rawBody = Buffer.from(JSON.stringify(base), 'utf8');
        if (rawBody.byteLength > preset.max_body_bytes) return INVALID_ENVELOPE;
        const decoded = decoder.decode(rawBody);
        const marker = decoded === null
          ? undefined
          : ownDataValue(decoded, preset.marker_object_field);
        if (decoded === null
          || marker === null
          || typeof marker !== 'object'
          || Array.isArray(marker)
          || ownDataValue(
            marker as Readonly<Record<string, unknown>>,
            preset.marker_nonce_field,
          ) !== nonce) {
          return INVALID_ENVELOPE;
        }
        const headers = Object.create(null) as Record<string, string>;
        headers[metadataPreset.delivery_id_header] = metadata.delivery_id;
        headers[metadataPreset.event_type_header] = metadata.event_type;
        headers[metadataPreset.structural_evidence_header] =
          metadata.structural_evidence;
        return Object.freeze({
          ok: true,
          raw_body: rawBody,
          headers: Object.freeze(headers),
        });
      } catch {
        return INVALID_ENVELOPE;
      }
    },
  });
};
