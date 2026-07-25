/** D-201 Slices 8V + 8X + 9AS — closed flat-form slash-command event normalizer.
 *
 * A trusted preset selects the form fields that carry one slash command, one
 * stable event id, and one resource id, plus the event-type field injected into
 * the preserved payload. Code owns the command grammar, normalized output
 * shape, own-data inspection, and hard caps. Profiles cannot provide a regex,
 * callback, coercion, path, schema, or arbitrary projection. A bounded trusted
 * omission list may withhold authority-bearing vendor fields from the decoded
 * payload without weakening authentication or structural admission.
 */

import type {
  WebhookNormalizedJsonEvent,
} from './webhook-json-event-normalizer.js';
import {
  createWebhookAsciiEventTypeParser,
} from './webhook-ascii-event-type-parser.js';

export interface WebhookFlatFormEventNormalizerPreset {
  readonly kind: 'flat_form_slash_command_event.v1';
  readonly event_type: string;
  readonly payload_event_type_field: string;
  readonly command_field: string;
  readonly event_id_field: string;
  readonly event_id_max_bytes: number;
  readonly resource_id_field: string;
  readonly resource_id_max_bytes: number;
  readonly reserved_fields: readonly string[];
  readonly payload_omitted_fields: readonly string[];
}

export interface WebhookFlatFormEventNormalizer {
  readonly preset: WebhookFlatFormEventNormalizerPreset;
  normalize(fields: unknown): WebhookNormalizedJsonEvent | null;
}

const MAX_FIELD_BYTES = 128;
const MAX_PROVIDER_ID_BYTES = 512;
const MAX_FIELD_LIST_ENTRIES = 64;
const FORM_FIELD_RE = /^[A-Za-z0-9_.-]+$/;
const SLASH_COMMAND_RE = /^\/[!#$%&'*+\-.0-9A-Z_a-z]{1,255}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const PROTOTYPE_SENSITIVE_FIELDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const PRESET_KEYS = new Set([
  'kind',
  'event_type',
  'payload_event_type_field',
  'command_field',
  'event_id_field',
  'event_id_max_bytes',
  'resource_id_field',
  'resource_id_max_bytes',
  'reserved_fields',
  'payload_omitted_fields',
]);
const EVENT_TYPE_PARSER = createWebhookAsciiEventTypeParser({
  kind: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
  max_bytes: 128,
});

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
  && FORM_FIELD_RE.test(value)
  && !PROTOTYPE_SENSITIVE_FIELDS.has(value);

const validLimit = (value: unknown): value is number =>
  Number.isSafeInteger(value)
  && (value as number) >= 1
  && (value as number) <= MAX_PROVIDER_ID_BYTES;

const boundedNonBlankString = (
  value: unknown,
  maxBytes: number,
): value is string => typeof value === 'string'
  && value.length > 0
  && value.trim() === value
  && !CONTROL_CHARACTER_RE.test(value)
  && Buffer.byteLength(value, 'utf8') <= maxBytes;

const exactFieldList = (
  value: unknown,
  minimumLength: 0 | 1,
): readonly string[] | null => {
  if (!Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimumLength
    || value.length > MAX_FIELD_LIST_ENTRIES) {
    return null;
  }
  const expectedKeys = new Set([
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    'length',
  ]);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.size
    || ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined
    || lengthDescriptor.enumerable
    || !('value' in lengthDescriptor)
    || lengthDescriptor.value !== value.length) {
    return null;
  }
  const fields: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
      || !validField(descriptor.value)) {
      return null;
    }
    fields.push(descriptor.value);
  }
  return new Set(fields).size === fields.length ? fields : null;
};

const freezeFieldList = (value: readonly string[]): readonly string[] => {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > MAX_FIELD_LIST_ENTRIES) {
    throw new Error('webhook flat-form event normalizer: invalid trusted preset');
  }
  const copied: string[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
      || !validField(descriptor.value)) {
      throw new Error('webhook flat-form event normalizer: invalid trusted preset');
    }
    copied.push(descriptor.value);
  }
  return Object.freeze(copied);
};

const validatePreset = (value: WebhookFlatFormEventNormalizerPreset): void => {
  if (!exactDataRecord(value, PRESET_KEYS)) {
    throw new Error('webhook flat-form event normalizer: invalid trusted preset');
  }
  const reservedFields = exactFieldList(value.reserved_fields, 1);
  const payloadOmittedFields = exactFieldList(
    value.payload_omitted_fields,
    0,
  );
  const inputFields = [
    value.command_field,
    value.event_id_field,
    value.resource_id_field,
  ];
  if (value.kind !== 'flat_form_slash_command_event.v1'
    || EVENT_TYPE_PARSER.parse(value.event_type) === null
    || !validField(value.payload_event_type_field)
    || inputFields.some((field) => !validField(field))
    || new Set([value.payload_event_type_field, ...inputFields]).size !== 4
    || !validLimit(value.event_id_max_bytes)
    || !validLimit(value.resource_id_max_bytes)
    || reservedFields === null
    || payloadOmittedFields === null
    || !reservedFields.includes(value.payload_event_type_field)
    || inputFields.some((field) => reservedFields.includes(field))
    || payloadOmittedFields.some((field) =>
      field === value.payload_event_type_field
      || inputFields.includes(field)
      || reservedFields.includes(field))) {
    throw new Error('webhook flat-form event normalizer: invalid trusted preset');
  }
};

const exactStringEntries = (
  value: unknown,
): readonly (readonly [string, string])[] | null => {
  if (!isPlainRecord(value)) return null;
  const entries: Array<readonly [string, string]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !validField(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
      || typeof descriptor.value !== 'string') {
      return null;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
};

export const createWebhookFlatFormEventNormalizer = (
  input: WebhookFlatFormEventNormalizerPreset,
): WebhookFlatFormEventNormalizer => {
  validatePreset(input);
  const reserved_fields = freezeFieldList(input.reserved_fields);
  const payload_omitted_fields = freezeFieldList(
    input.payload_omitted_fields,
  );
  const preset = Object.freeze({
    ...input,
    reserved_fields,
    payload_omitted_fields,
  });
  const omittedPayloadFields = new Set(preset.payload_omitted_fields);

  return Object.freeze({
    preset,
    normalize(fields: unknown): WebhookNormalizedJsonEvent | null {
      try {
        const entries = exactStringEntries(fields);
        if (entries === null) return null;
        const values = new Map(entries);
        if (preset.reserved_fields.some((field) => values.has(field))) return null;
        const command = values.get(preset.command_field);
        const eventId = values.get(preset.event_id_field);
        const resourceId = values.get(preset.resource_id_field);
        if (command === undefined
          || !SLASH_COMMAND_RE.test(command)
          || !boundedNonBlankString(eventId, preset.event_id_max_bytes)
          || !boundedNonBlankString(resourceId, preset.resource_id_max_bytes)) {
          return null;
        }
        const payload = Object.create(null) as Record<string, unknown>;
        for (const [key, value] of entries) {
          if (!omittedPayloadFields.has(key)) payload[key] = value;
        }
        payload[preset.payload_event_type_field] = preset.event_type;
        Object.freeze(payload);
        return Object.freeze({
          event_type: preset.event_type,
          event_id: eventId,
          resource_id: resourceId,
          occurred_at: null,
          challenge: null,
          payload,
        });
      } catch {
        return null;
      }
    },
  });
};
