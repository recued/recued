/** D-201 Slice 8Q — closed normalized single-event projector.
 *
 * A trusted profile preset maps one already-decoded, already-normalized record
 * into the durable event contract. The engine admits only top-level own-data
 * fields and one closed timestamp-unit conversion; it exposes no JSONPath,
 * callback, payload transform, dedup strategy, or vendor-specific branch.
 */

import type { AcceptedProfileEvent } from './webhook-profile-runtime.js';

export interface WebhookNormalizedSingleEventProjectorPreset {
  readonly kind: 'normalized_single_event.v1';
  readonly provider_event_id_field: string;
  readonly provider_resource_id_field: string;
  readonly provider_event_type_field: string;
  readonly provider_occurred_at_field: string;
  readonly decoded_payload_field: string;
  readonly occurred_at_unit:
    | 'unix_seconds_to_milliseconds.v1'
    | 'unix_milliseconds.v1';
}

export interface WebhookNormalizedSingleEventProjector {
  readonly preset: WebhookNormalizedSingleEventProjectorPreset;
  project(
    normalized: unknown,
    eventDedupKey: string,
  ): Readonly<AcceptedProfileEvent> | null;
}

const MAX_FIELD_BYTES = 128;
const MAX_DEDUP_KEY_BYTES = 256;
const MAX_PROVIDER_ID_BYTES = 512;
const MAX_EVENT_TYPE_BYTES = 128;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const PRESET_KEYS = new Set([
  'kind',
  'provider_event_id_field',
  'provider_resource_id_field',
  'provider_event_type_field',
  'provider_occurred_at_field',
  'decoded_payload_field',
  'occurred_at_unit',
]);
const MISSING = Symbol('missing normalized event field');

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactDataRecord = (value: unknown, keys: ReadonlySet<string>): boolean => {
  if (!isPlainRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.size
    || ownKeys.some((key) => typeof key !== 'string' || !keys.has(key))) {
    return false;
  }
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.enumerable
      && 'value' in descriptor;
  });
};

const validField = (value: unknown): value is string =>
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= MAX_FIELD_BYTES
  && FIELD_RE.test(value);

const boundedNonBlankString = (
  value: unknown,
  maxBytes: number,
): value is string => typeof value === 'string'
  && value.length > 0
  && value.trim() === value
  && !CONTROL_CHARACTER_RE.test(value)
  && Buffer.byteLength(value, 'utf8') <= maxBytes;

const validatePreset = (
  value: WebhookNormalizedSingleEventProjectorPreset,
): void => {
  if (!exactDataRecord(value, PRESET_KEYS)
    || value.kind !== 'normalized_single_event.v1'
    || (value.occurred_at_unit !== 'unix_seconds_to_milliseconds.v1'
      && value.occurred_at_unit !== 'unix_milliseconds.v1')) {
    throw new Error(
      'webhook normalized single-event projector: invalid trusted preset',
    );
  }
  const fields = [
    value.provider_event_id_field,
    value.provider_resource_id_field,
    value.provider_event_type_field,
    value.provider_occurred_at_field,
    value.decoded_payload_field,
  ];
  if (fields.some((field) => !validField(field))
    || new Set(fields).size !== fields.length) {
    throw new Error(
      'webhook normalized single-event projector: invalid trusted preset',
    );
  }
};

const ownDataValue = (
  record: Record<string, unknown>,
  field: string,
): unknown | typeof MISSING => {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  return descriptor !== undefined
    && descriptor.enumerable
    && 'value' in descriptor
    ? descriptor.value
    : MISSING;
};

const nullableProviderId = (value: unknown): string | null | typeof MISSING =>
  value === null
    ? null
    : boundedNonBlankString(value, MAX_PROVIDER_ID_BYTES)
      ? value
      : MISSING;

const normalizeOccurredAt = (
  value: unknown,
  unit: WebhookNormalizedSingleEventProjectorPreset['occurred_at_unit'],
): number | null | typeof MISSING => {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) return MISSING;
  if (unit === 'unix_milliseconds.v1') return value as number;
  if ((value as number) > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    return MISSING;
  }
  return (value as number) * 1_000;
};

export const createWebhookNormalizedSingleEventProjector = (
  input: WebhookNormalizedSingleEventProjectorPreset,
): WebhookNormalizedSingleEventProjector => {
  validatePreset(input);
  const preset = Object.freeze({ ...input });

  return Object.freeze({
    preset,
    project(
      normalized: unknown,
      eventDedupKey: string,
    ): Readonly<AcceptedProfileEvent> | null {
      try {
        if (!isPlainRecord(normalized)
          || !boundedNonBlankString(eventDedupKey, MAX_DEDUP_KEY_BYTES)) {
          return null;
        }
        const providerEventId = nullableProviderId(ownDataValue(
          normalized,
          preset.provider_event_id_field,
        ));
        const providerResourceId = nullableProviderId(ownDataValue(
          normalized,
          preset.provider_resource_id_field,
        ));
        const providerEventType = ownDataValue(
          normalized,
          preset.provider_event_type_field,
        );
        const providerOccurredAt = normalizeOccurredAt(ownDataValue(
          normalized,
          preset.provider_occurred_at_field,
        ), preset.occurred_at_unit);
        const decodedPayload = ownDataValue(
          normalized,
          preset.decoded_payload_field,
        );
        if (providerEventId === MISSING
          || providerResourceId === MISSING
          || !boundedNonBlankString(providerEventType, MAX_EVENT_TYPE_BYTES)
          || providerOccurredAt === MISSING
          || decodedPayload === MISSING
          || !isPlainRecord(decodedPayload)) {
          return null;
        }
        return Object.freeze({
          event_dedup_key: eventDedupKey,
          provider_event_id: providerEventId,
          provider_resource_id: providerResourceId,
          provider_event_type: providerEventType,
          provider_occurred_at: providerOccurredAt,
          decoded_payload: decodedPayload,
        });
      } catch {
        return null;
      }
    },
  });
};
