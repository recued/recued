/** D-201 Slices 9Z + 9AR — closed JSON single-member event normalizer.
 *
 * This engine admits the common envelope pattern containing one positive
 * numeric identity field and exactly one object-valued event member whose key
 * is the event type. Trusted preset data selects only the identity field and
 * hard-capped numeric/type bounds. It exposes no JSONPath, callback, coercion,
 * profile id, vendor branch, deduplication, or durable projection.
 */

import {
  createWebhookAsciiIdentifierParser,
} from './webhook-ascii-identifier-parser.js';

export interface WebhookJsonSingleMemberEventNormalizerPreset {
  readonly kind: 'json_single_member_event.v1';
  readonly event_id_field: string;
  readonly event_id_grammar: 'positive_safe_integer.v1';
  readonly event_id_max_value: number;
  readonly event_type_grammar: 'ascii_identifier.v1';
  readonly event_type_max_bytes: number;
}

export interface WebhookNormalizedJsonSingleMemberEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly occurred_at: null;
  readonly resource_id: null;
  readonly payload: Record<string, unknown>;
}

export interface WebhookJsonSingleMemberEventNormalizer {
  readonly preset: WebhookJsonSingleMemberEventNormalizerPreset;
  normalize(envelope: unknown): WebhookNormalizedJsonSingleMemberEvent | null;
}

const MAX_FIELD_BYTES = 128;
const MAX_EVENT_TYPE_BYTES = 128;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const PROTOTYPE_SENSITIVE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const PRESET_KEYS = new Set([
  'kind',
  'event_id_field',
  'event_id_grammar',
  'event_id_max_value',
  'event_type_grammar',
  'event_type_max_bytes',
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactDataValues = (
  value: unknown,
  keys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null => {
  try {
    if (!isPlainRecord(value)) return null;
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

const exactDataEntries = (
  value: unknown,
  expectedCount: number,
): readonly (readonly [string, unknown])[] | null => {
  try {
    if (!isPlainRecord(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedCount
      || ownKeys.some((key) => typeof key !== 'string')) {
      return null;
    }
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of ownKeys) {
      if (typeof key !== 'string') return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)) {
        return null;
      }
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return null;
  }
};

const validField = (value: unknown): value is string =>
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= MAX_FIELD_BYTES
  && FIELD_RE.test(value)
  && !PROTOTYPE_SENSITIVE_KEYS.has(value);

const validPositiveSafeInteger = (
  value: unknown,
  maximum: number,
): value is number => Number.isSafeInteger(value)
  && (value as number) >= 1
  && (value as number) <= maximum;

export const createWebhookJsonSingleMemberEventNormalizer = (
  input: WebhookJsonSingleMemberEventNormalizerPreset,
): WebhookJsonSingleMemberEventNormalizer => {
  const fields = exactDataValues(input, PRESET_KEYS);
  if (fields === null
    || fields.kind !== 'json_single_member_event.v1'
    || !validField(fields.event_id_field)
    || fields.event_id_grammar !== 'positive_safe_integer.v1'
    || !validPositiveSafeInteger(
      fields.event_id_max_value,
      Number.MAX_SAFE_INTEGER,
    )
    || fields.event_type_grammar !== 'ascii_identifier.v1'
    || !Number.isSafeInteger(fields.event_type_max_bytes)
    || (fields.event_type_max_bytes as number) < 1
    || (fields.event_type_max_bytes as number) > MAX_EVENT_TYPE_BYTES) {
    throw new Error(
      'webhook JSON single-member event normalizer: invalid trusted preset',
    );
  }
  const preset: WebhookJsonSingleMemberEventNormalizerPreset = Object.freeze({
    kind: fields.kind,
    event_id_field: fields.event_id_field,
    event_id_grammar: fields.event_id_grammar,
    event_id_max_value: fields.event_id_max_value as number,
    event_type_grammar: fields.event_type_grammar,
    event_type_max_bytes: fields.event_type_max_bytes as number,
  });
  const eventTypeParser = createWebhookAsciiIdentifierParser({
    kind: preset.event_type_grammar,
    max_bytes: preset.event_type_max_bytes,
  });

  return Object.freeze({
    preset,
    normalize(
      envelope: unknown,
    ): WebhookNormalizedJsonSingleMemberEvent | null {
      try {
        const entries = exactDataEntries(envelope, 2);
        if (entries === null) return null;
        const eventIdEntry = entries.find(([key]) =>
          key === preset.event_id_field);
        if (eventIdEntry === undefined) return null;
        const eventId = eventIdEntry[1];
        if (!validPositiveSafeInteger(eventId, preset.event_id_max_value)) {
          return null;
        }
        const eventEntry = entries.find(([key]) =>
          key !== preset.event_id_field);
        const eventType = eventEntry === undefined
          ? null
          : eventTypeParser.parse(eventEntry[0]);
        if (eventEntry === undefined
          || PROTOTYPE_SENSITIVE_KEYS.has(eventEntry[0])
          || eventType === null
          || !isPlainRecord(eventEntry[1])) {
          return null;
        }
        return Object.freeze({
          event_id: String(eventId),
          event_type: eventType,
          occurred_at: null,
          resource_id: null,
          payload: envelope as Record<string, unknown>,
        });
      } catch {
        return null;
      }
    },
  });
};
