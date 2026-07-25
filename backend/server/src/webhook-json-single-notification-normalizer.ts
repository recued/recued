/** D-201 Slice 9L — closed bounded-JSON single-notification normalizer.
 *
 * Trusted preset data maps four top-level own-data fields into generic logical
 * event and delivery roles. Trusted injected engines own bounded JSON decoding,
 * field grammars, occurrence-time parsing, required object selection, and
 * optional resource extraction. There is no JSONPath, callback in preset data,
 * profile id, vendor branch, dedup strategy, or durable projection here.
 */

import type {
  WebhookDotSegmentEventTypeParser,
} from './webhook-dot-segment-event-type-parser.js';
import type {
  WebhookFixedPrefixProviderIdParser,
} from './webhook-fixed-prefix-provider-id-parser.js';
import type { WebhookJsonObjectDecoder } from './webhook-json-object-decoder.js';
import type {
  WebhookJsonObjectProviderIdExtractor,
} from './webhook-json-object-provider-id-extractor.js';
import type {
  WebhookJsonRequiredObjectExtractor,
} from './webhook-json-required-object-extractor.js';
import type {
  WebhookRfc3339TimestampParser,
} from './webhook-rfc3339-timestamp-parser.js';

export interface WebhookJsonSingleNotificationNormalizerPreset {
  readonly kind: 'json_single_notification_fields.v1';
  readonly event_id_field: string;
  readonly delivery_id_field: string;
  readonly event_type_field: string;
  readonly occurred_at_field: string;
}

export interface WebhookJsonSingleNotificationNormalizerDependencies {
  readonly decoder: WebhookJsonObjectDecoder;
  readonly event_id_parser: WebhookFixedPrefixProviderIdParser;
  readonly delivery_id_parser: WebhookFixedPrefixProviderIdParser;
  readonly event_type_parser: WebhookDotSegmentEventTypeParser;
  readonly occurred_at_parser: WebhookRfc3339TimestampParser;
  readonly data_object_extractor: WebhookJsonRequiredObjectExtractor;
  readonly resource_id_extractor: WebhookJsonObjectProviderIdExtractor;
}

export interface WebhookNormalizedJsonNotification {
  readonly event_id: string;
  readonly delivery_id: string;
  readonly event_type: string;
  readonly occurred_at: number;
  readonly resource_id: string | null;
  readonly payload: Record<string, unknown>;
}

export interface WebhookJsonSingleNotificationNormalizer {
  readonly preset: WebhookJsonSingleNotificationNormalizerPreset;
  normalize(rawBody: Buffer): WebhookNormalizedJsonNotification | null;
}

const MAX_FIELD_CHARACTERS = 128;
const PRESET_KEYS = new Set([
  'kind',
  'event_id_field',
  'delivery_id_field',
  'event_type_field',
  'occurred_at_field',
]);
const ASCII_LETTER_RE = /[A-Za-z]/;
const INVALID_FIELD_CHARACTER_RE = /[^A-Za-z0-9_]/;
const MISSING = Symbol('missing notification field');

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactDataValues = (
  value: unknown,
): Readonly<Record<string, unknown>> | null => {
  try {
    if (!isPlainRecord(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== PRESET_KEYS.size
      || keys.some((key) => typeof key !== 'string' || !PRESET_KEYS.has(key))) {
      return null;
    }
    const fields = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
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
  && value.length >= 1
  && value.length <= MAX_FIELD_CHARACTERS
  && ASCII_LETTER_RE.test(value[0]!)
  && !INVALID_FIELD_CHARACTER_RE.test(value);

export const compileWebhookJsonSingleNotificationNormalizerPreset = (
  input: WebhookJsonSingleNotificationNormalizerPreset,
): WebhookJsonSingleNotificationNormalizerPreset => {
  const fields = exactDataValues(input);
  const mappedFields = fields === null ? [] : [
    fields.event_id_field,
    fields.delivery_id_field,
    fields.event_type_field,
    fields.occurred_at_field,
  ];
  if (fields === null
    || fields.kind !== 'json_single_notification_fields.v1'
    || mappedFields.some((field) => !validField(field))
    || new Set(mappedFields).size !== mappedFields.length) {
    throw new Error(
      'webhook JSON single-notification normalizer: invalid trusted preset',
    );
  }
  return Object.freeze({
    kind: fields.kind,
    event_id_field: fields.event_id_field as string,
    delivery_id_field: fields.delivery_id_field as string,
    event_type_field: fields.event_type_field as string,
    occurred_at_field: fields.occurred_at_field as string,
  });
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

export const createWebhookJsonSingleNotificationNormalizer = (
  input: WebhookJsonSingleNotificationNormalizerPreset,
  dependencies: WebhookJsonSingleNotificationNormalizerDependencies,
): WebhookJsonSingleNotificationNormalizer => {
  const preset = compileWebhookJsonSingleNotificationNormalizerPreset(input);
  if (new Set([
    preset.event_id_field,
    preset.delivery_id_field,
    preset.event_type_field,
    preset.occurred_at_field,
    dependencies.data_object_extractor.preset.field,
  ]).size !== 5) {
    throw new Error(
      'webhook JSON single-notification normalizer: conflicting field dependencies',
    );
  }

  return Object.freeze({
    preset,
    normalize(rawBody: Buffer): WebhookNormalizedJsonNotification | null {
      const envelope = dependencies.decoder.decode(rawBody);
      if (envelope === null) return null;
      const eventId = dependencies.event_id_parser.parse(ownDataValue(
        envelope,
        preset.event_id_field,
      ));
      const deliveryId = dependencies.delivery_id_parser.parse(ownDataValue(
        envelope,
        preset.delivery_id_field,
      ));
      const eventType = dependencies.event_type_parser.parse(ownDataValue(
        envelope,
        preset.event_type_field,
      ));
      const occurredAt = dependencies.occurred_at_parser.parse(ownDataValue(
        envelope,
        preset.occurred_at_field,
      ));
      const data = dependencies.data_object_extractor.extract(envelope);
      if (eventId === null
        || deliveryId === null
        || eventType === null
        || occurredAt === null
        || data === null) {
        return null;
      }
      return Object.freeze({
        event_id: eventId,
        delivery_id: deliveryId,
        event_type: eventType,
        occurred_at: occurredAt,
        resource_id: dependencies.resource_id_extractor.extract(data),
        payload: envelope,
      });
    },
  });
};
