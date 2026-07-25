/** D-201 Slice 9J — closed optional JSON-object provider-id extractor.
 *
 * Trusted preset data selects one own-data field and a byte ceiling. Runtime
 * values must be nonblank, trimmed, control-free UTF-8 strings. Missing,
 * nullable, malformed, accessor-backed, or inherited fields are treated as an
 * absent optional id. There is no JSONPath, callback, coercion, profile id, or
 * vendor branch.
 */

export interface WebhookJsonObjectProviderIdExtractorPreset {
  readonly kind: 'optional_json_object_provider_id.v1';
  readonly field: string;
  readonly grammar: 'control_free_trimmed_utf8.v1';
  readonly max_bytes: number;
}

export interface WebhookJsonObjectProviderIdExtractor {
  readonly preset: WebhookJsonObjectProviderIdExtractorPreset;
  extract(value: unknown): string | null;
}

const MAX_FIELD_CHARACTERS = 128;
const MAX_PROVIDER_ID_BYTES = 512;
const PRESET_KEYS = new Set(['kind', 'field', 'grammar', 'max_bytes']);
const ASCII_LETTER_RE = /[A-Za-z]/;
const INVALID_FIELD_CHARACTER_RE = /[^A-Za-z0-9_]/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;

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

export const createWebhookJsonObjectProviderIdExtractor = (
  input: WebhookJsonObjectProviderIdExtractorPreset,
): WebhookJsonObjectProviderIdExtractor => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'optional_json_object_provider_id.v1'
    || typeof fields.field !== 'string'
    || fields.field.length < 1
    || fields.field.length > MAX_FIELD_CHARACTERS
    || !ASCII_LETTER_RE.test(fields.field[0]!)
    || INVALID_FIELD_CHARACTER_RE.test(fields.field)
    || fields.grammar !== 'control_free_trimmed_utf8.v1'
    || !Number.isSafeInteger(fields.max_bytes)
    || (fields.max_bytes as number) < 1
    || (fields.max_bytes as number) > MAX_PROVIDER_ID_BYTES) {
    throw new Error(
      'webhook JSON-object provider-id extractor: invalid trusted preset',
    );
  }
  const preset: WebhookJsonObjectProviderIdExtractorPreset = Object.freeze({
    kind: fields.kind,
    field: fields.field,
    grammar: fields.grammar,
    max_bytes: fields.max_bytes as number,
  });

  return Object.freeze({
    preset,
    extract(value: unknown): string | null {
      try {
        if (!isPlainRecord(value)) return null;
        const descriptor = Object.getOwnPropertyDescriptor(value, preset.field);
        if (descriptor === undefined
          || !descriptor.enumerable
          || !('value' in descriptor)) {
          return null;
        }
        const candidate = descriptor.value;
        if (typeof candidate !== 'string'
          || candidate.length < 1
          || candidate.length > preset.max_bytes
          || Buffer.byteLength(candidate, 'utf8') > preset.max_bytes
          || candidate.trim() !== candidate
          || CONTROL_CHARACTER_RE.test(candidate)) {
          return null;
        }
        return candidate;
      } catch {
        return null;
      }
    },
  });
};
