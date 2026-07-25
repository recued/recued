/** D-201 Slice 9BQ — closed JSON:API-style single-event normalizer.
 *
 * Trusted preset data supplies only fixed header/field names and hard-capped
 * string ceilings. The signed body remains the authority for event type; an
 * unsigned event-name header is accepted only when it occurs exactly once and
 * agrees byte-for-byte with that body value. There is no JSONPath, callback,
 * coercion, profile id, vendor branch, or owner-authored transform.
 */

import type {
  WebhookLowercaseIdentifierEventTypeParser,
} from './webhook-lowercase-identifier-event-type-parser.js';

export interface WebhookJsonApiSingleEventNormalizerPreset {
  readonly kind: 'json_api_single_event.v1';
  readonly event_type_header: string;
  readonly metadata_field: string;
  readonly event_type_field: string;
  readonly data_field: string;
  readonly resource_type_field: string;
  readonly resource_id_field: string;
  readonly max_resource_type_bytes: number;
  readonly max_resource_id_bytes: number;
}

export interface WebhookJsonApiSingleEventNormalizer {
  readonly preset: WebhookJsonApiSingleEventNormalizerPreset;
  normalize(
    headers: ReadonlyMap<string, readonly string[]>,
    envelope: unknown,
  ): Readonly<{
    event_id: null;
    resource_id: string;
    event_type: string;
    occurred_at: null;
    payload: Record<string, unknown>;
  }> | null;
}

const MAX_HEADER_NAME_BYTES = 128;
const MAX_FIELD_NAME_BYTES = 128;
const MAX_RESOURCE_TYPE_BYTES = 128;
const MAX_RESOURCE_ID_BYTES = 512;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const PROTOTYPE_SENSITIVE_FIELDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const PRESET_KEYS = new Set([
  'kind',
  'event_type_header',
  'metadata_field',
  'event_type_field',
  'data_field',
  'resource_type_field',
  'resource_id_field',
  'max_resource_type_bytes',
  'max_resource_id_bytes',
]);
const FORBIDDEN_HEADERS = new Set([
  'connection',
  'content-length',
  'content-type',
  'expect',
  'forwarded',
  'host',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-real-ip',
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactDataRecord = (value: unknown): value is Record<string, unknown> => {
  try {
    if (!isPlainRecord(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== PRESET_KEYS.size
      || keys.some((key) => typeof key !== 'string' || !PRESET_KEYS.has(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined
        && descriptor.enumerable
        && 'value' in descriptor;
    });
  } catch {
    return false;
  }
};

const ownDataValue = (
  value: Record<string, unknown>,
  field: string,
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor !== undefined
    && descriptor.enumerable
    && 'value' in descriptor
    ? descriptor.value
    : undefined;
};

const validHeaderName = (value: unknown): value is string =>
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= MAX_HEADER_NAME_BYTES
  && HEADER_NAME_RE.test(value)
  && !FORBIDDEN_HEADERS.has(value)
  && !value.startsWith('content-')
  && !value.startsWith('x-forwarded-');

const validFieldName = (value: unknown): value is string =>
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= MAX_FIELD_NAME_BYTES
  && FIELD_NAME_RE.test(value)
  && !PROTOTYPE_SENSITIVE_FIELDS.has(value);

const validLimit = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value)
  && (value as number) >= 1
  && (value as number) <= maximum;

const boundedNonBlankString = (
  value: unknown,
  maxBytes: number,
): value is string => typeof value === 'string'
  && value.length > 0
  && value.trim() === value
  && !CONTROL_CHARACTER_RE.test(value)
  && Buffer.byteLength(value, 'utf8') <= maxBytes;

export const createWebhookJsonApiSingleEventNormalizer = (
  input: WebhookJsonApiSingleEventNormalizerPreset,
  eventTypeParser: WebhookLowercaseIdentifierEventTypeParser,
): WebhookJsonApiSingleEventNormalizer => {
  if (!exactDataRecord(input)
    || input.kind !== 'json_api_single_event.v1'
    || !validHeaderName(input.event_type_header)
    || !validFieldName(input.metadata_field)
    || !validFieldName(input.event_type_field)
    || !validFieldName(input.data_field)
    || !validFieldName(input.resource_type_field)
    || !validFieldName(input.resource_id_field)
    || input.metadata_field === input.data_field
    || input.resource_type_field === input.resource_id_field
    || !validLimit(input.max_resource_type_bytes, MAX_RESOURCE_TYPE_BYTES)
    || !validLimit(input.max_resource_id_bytes, MAX_RESOURCE_ID_BYTES)) {
    throw new Error(
      'webhook JSON:API single-event normalizer: invalid trusted preset',
    );
  }
  const preset = Object.freeze({ ...input });

  return Object.freeze({
    preset,
    normalize(
      headers: ReadonlyMap<string, readonly string[]>,
      envelope: unknown,
    ) {
      try {
        if (!isPlainRecord(envelope)) return null;
        const headerValues = headers.get(preset.event_type_header);
        if (headerValues === undefined
          || headerValues.length !== 1
          || typeof headerValues[0] !== 'string') {
          return null;
        }
        const metadata = ownDataValue(envelope, preset.metadata_field);
        const data = ownDataValue(envelope, preset.data_field);
        if (!isPlainRecord(metadata) || !isPlainRecord(data)) return null;
        const eventType = eventTypeParser.parse(ownDataValue(
          metadata,
          preset.event_type_field,
        ));
        if (eventType === null || headerValues[0] !== eventType) return null;
        const resourceType = ownDataValue(data, preset.resource_type_field);
        const resourceId = ownDataValue(data, preset.resource_id_field);
        if (!boundedNonBlankString(
          resourceType,
          preset.max_resource_type_bytes,
        ) || !boundedNonBlankString(resourceId, preset.max_resource_id_bytes)) {
          return null;
        }
        return Object.freeze({
          event_id: null,
          resource_id: resourceId,
          event_type: eventType,
          occurred_at: null,
          payload: envelope,
        });
      } catch {
        return null;
      }
    },
  });
};
