/** D-201 Slice 9H — closed fixed-prefix provider-id parser.
 *
 * Trusted preset data selects only a bounded literal prefix and suffix length.
 * Runtime ids must be primitive strings whose suffix is lowercase ASCII
 * alphanumeric. There is no regex input, callback, coercion, field name,
 * profile id, or vendor branch.
 */

export interface WebhookFixedPrefixProviderIdParserPreset {
  readonly kind: 'fixed_prefix_lowercase_alphanumeric_id.v1';
  readonly prefix: string;
  readonly suffix_length: number;
}

export interface WebhookFixedPrefixProviderIdParser {
  readonly preset: WebhookFixedPrefixProviderIdParserPreset;
  parse(value: unknown): string | null;
}

const MAX_PREFIX_LENGTH = 64;
const MAX_SUFFIX_LENGTH = 128;
const PRESET_KEYS = new Set(['kind', 'prefix', 'suffix_length']);
const LOWERCASE_ASCII_LETTER_RE = /[a-z]/;
const INVALID_PREFIX_CHARACTER_RE = /[^a-z0-9_:-]/;
const INVALID_SUFFIX_CHARACTER_RE = /[^a-z0-9]/;

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

export const createWebhookFixedPrefixProviderIdParser = (
  input: WebhookFixedPrefixProviderIdParserPreset,
): WebhookFixedPrefixProviderIdParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'fixed_prefix_lowercase_alphanumeric_id.v1'
    || typeof fields.prefix !== 'string'
    || fields.prefix.length < 1
    || fields.prefix.length > MAX_PREFIX_LENGTH
    || !LOWERCASE_ASCII_LETTER_RE.test(fields.prefix[0]!)
    || INVALID_PREFIX_CHARACTER_RE.test(fields.prefix)
    || !Number.isSafeInteger(fields.suffix_length)
    || (fields.suffix_length as number) < 1
    || (fields.suffix_length as number) > MAX_SUFFIX_LENGTH) {
    throw new Error(
      'webhook fixed-prefix provider-id parser: invalid trusted preset',
    );
  }
  const preset: WebhookFixedPrefixProviderIdParserPreset = Object.freeze({
    kind: fields.kind,
    prefix: fields.prefix,
    suffix_length: fields.suffix_length as number,
  });

  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      if (typeof value !== 'string'
        || value.length !== preset.prefix.length + preset.suffix_length
        || !value.startsWith(preset.prefix)) {
        return null;
      }
      return INVALID_SUFFIX_CHARACTER_RE.test(
        value.slice(preset.prefix.length),
      ) ? null : value;
    },
  });
};
