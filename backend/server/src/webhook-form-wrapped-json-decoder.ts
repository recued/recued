/** D-201 Slice 8U — exclusive form-wrapped JSON decoder.
 *
 * A trusted preset selects one bounded form field. When that field is present,
 * the decoded form must contain exactly that field and its string value must be
 * admitted by the injected bounded JSON-object decoder. Absent selection is a
 * distinct non-match so a caller may try a separately typed flat-form family.
 * The engine exposes no callback, path, reviver, schema, coercion, or vendor
 * branch.
 */

import type {
  WebhookJsonObjectDecoder,
} from './webhook-json-object-decoder.js';

export interface WebhookFormWrappedJsonDecoderPreset {
  readonly kind: 'exclusive_form_json_field.v1';
  readonly json_field: string;
}

export type WebhookFormWrappedJsonClassification =
  | Readonly<{ kind: 'not_matched' }>
  | Readonly<{ kind: 'matched_invalid' }>
  | Readonly<{
    kind: 'matched';
    envelope: Record<string, unknown>;
  }>;

export interface WebhookFormWrappedJsonDecoder {
  readonly preset: WebhookFormWrappedJsonDecoderPreset;
  classify(
    fields: unknown,
    jsonDecoder: WebhookJsonObjectDecoder,
  ): WebhookFormWrappedJsonClassification;
}

const MAX_FIELD_BYTES = 128;
const FORM_FIELD_RE = /^[A-Za-z0-9_.-]+$/;
const PROTOTYPE_SENSITIVE_FIELDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const PRESET_KEYS = new Set(['kind', 'json_field']);
const NOT_MATCHED = Object.freeze({ kind: 'not_matched' } as const);
const MATCHED_INVALID = Object.freeze({ kind: 'matched_invalid' } as const);

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

const validatePreset = (value: WebhookFormWrappedJsonDecoderPreset): void => {
  if (!exactDataRecord(value, PRESET_KEYS)
    || value.kind !== 'exclusive_form_json_field.v1'
    || !validField(value.json_field)) {
    throw new Error('webhook form-wrapped JSON decoder: invalid trusted preset');
  }
};

const exactStringRecord = (
  value: unknown,
): { record: Record<string, unknown>; keys: readonly string[] } | null => {
  if (!isPlainRecord(value)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) return null;
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
      || typeof descriptor.value !== 'string') {
      return null;
    }
  }
  return {
    record: value,
    keys: ownKeys as string[],
  };
};

export const createWebhookFormWrappedJsonDecoder = (
  input: WebhookFormWrappedJsonDecoderPreset,
): WebhookFormWrappedJsonDecoder => {
  validatePreset(input);
  const preset = Object.freeze({ ...input });

  return Object.freeze({
    preset,
    classify(
      fields: unknown,
      jsonDecoder: WebhookJsonObjectDecoder,
    ): WebhookFormWrappedJsonClassification {
      try {
        const inspected = exactStringRecord(fields);
        if (inspected === null) return MATCHED_INVALID;
        const selected = Object.getOwnPropertyDescriptor(
          inspected.record,
          preset.json_field,
        );
        if (selected === undefined) {
          const prototype = Object.getPrototypeOf(inspected.record);
          return prototype !== null
            && Object.getOwnPropertyDescriptor(
              prototype,
              preset.json_field,
            ) !== undefined
            ? MATCHED_INVALID
            : NOT_MATCHED;
        }
        if (inspected.keys.length !== 1
          || !selected.enumerable
          || !('value' in selected)
          || typeof selected.value !== 'string') {
          return MATCHED_INVALID;
        }
        const envelope = jsonDecoder.decode(Buffer.from(selected.value, 'utf8'));
        return envelope === null
          ? MATCHED_INVALID
          : Object.freeze({ kind: 'matched', envelope });
      } catch {
        return MATCHED_INVALID;
      }
    },
  });
};
