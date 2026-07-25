/** D-201 Slice 9K — closed required JSON object-field extractor.
 *
 * Trusted preset data selects one own-data field. Runtime input and the
 * selected value must both be plain JSON-style records; missing, nullable,
 * inherited, accessor-backed, array, and scalar values fail closed. There is
 * no JSONPath, callback, coercion, profile id, or vendor branch.
 */

export interface WebhookJsonRequiredObjectExtractorPreset {
  readonly kind: 'required_json_object_field.v1';
  readonly field: string;
}

export interface WebhookJsonRequiredObjectExtractor {
  readonly preset: WebhookJsonRequiredObjectExtractorPreset;
  extract(value: unknown): Record<string, unknown> | null;
}

const MAX_FIELD_CHARACTERS = 128;
const PRESET_KEYS = new Set(['kind', 'field']);
const ASCII_LETTER_RE = /[A-Za-z]/;
const INVALID_FIELD_CHARACTER_RE = /[^A-Za-z0-9_]/;

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

export const createWebhookJsonRequiredObjectExtractor = (
  input: WebhookJsonRequiredObjectExtractorPreset,
): WebhookJsonRequiredObjectExtractor => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'required_json_object_field.v1'
    || typeof fields.field !== 'string'
    || fields.field.length < 1
    || fields.field.length > MAX_FIELD_CHARACTERS
    || !ASCII_LETTER_RE.test(fields.field[0]!)
    || INVALID_FIELD_CHARACTER_RE.test(fields.field)) {
    throw new Error(
      'webhook required JSON-object extractor: invalid trusted preset',
    );
  }
  const preset: WebhookJsonRequiredObjectExtractorPreset = Object.freeze({
    kind: fields.kind,
    field: fields.field,
  });

  return Object.freeze({
    preset,
    extract(value: unknown): Record<string, unknown> | null {
      try {
        if (!isPlainRecord(value)) return null;
        const descriptor = Object.getOwnPropertyDescriptor(value, preset.field);
        return descriptor !== undefined
          && descriptor.enumerable
          && 'value' in descriptor
          && isPlainRecord(descriptor.value)
          ? descriptor.value
          : null;
      } catch {
        return null;
      }
    },
  });
};
