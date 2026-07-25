/** D-201 Slice 9AP — closed bounded fixed-prefix provider-id parser.
 *
 * Trusted preset data selects only a bounded literal prefix and suffix-length
 * range. Runtime ids must be primitive strings whose suffix is ASCII
 * alphanumeric. There is no regex input, callback, coercion, field name,
 * profile id, or vendor branch.
 */

export interface WebhookBoundedPrefixProviderIdParserPreset {
  readonly kind: 'fixed_prefix_ascii_alphanumeric_id.v1';
  readonly prefix: string;
  readonly min_suffix_length: number;
  readonly max_suffix_length: number;
}

export interface WebhookBoundedPrefixProviderIdParser {
  readonly preset: WebhookBoundedPrefixProviderIdParserPreset;
  parse(value: unknown): string | null;
}

const MAX_PREFIX_LENGTH = 64;
const MAX_PROVIDER_ID_LENGTH = 255;
const PRESET_KEYS = new Set([
  'kind',
  'prefix',
  'min_suffix_length',
  'max_suffix_length',
]);
const LOWERCASE_ASCII_LETTER_RE = /[a-z]/;
const INVALID_PREFIX_CHARACTER_RE = /[^a-z0-9_:-]/;
const INVALID_SUFFIX_CHARACTER_RE = /[^A-Za-z0-9]/;

const exactDataValues = (
  value: unknown,
): Readonly<Record<string, unknown>> | null => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== PRESET_KEYS.size
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

export const createWebhookBoundedPrefixProviderIdParser = (
  input: WebhookBoundedPrefixProviderIdParserPreset,
): WebhookBoundedPrefixProviderIdParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'fixed_prefix_ascii_alphanumeric_id.v1'
    || typeof fields.prefix !== 'string'
    || fields.prefix.length < 1
    || fields.prefix.length > MAX_PREFIX_LENGTH
    || !LOWERCASE_ASCII_LETTER_RE.test(fields.prefix[0]!)
    || INVALID_PREFIX_CHARACTER_RE.test(fields.prefix)
    || !Number.isSafeInteger(fields.min_suffix_length)
    || !Number.isSafeInteger(fields.max_suffix_length)
    || (fields.min_suffix_length as number) < 1
    || (fields.max_suffix_length as number)
      < (fields.min_suffix_length as number)
    || fields.prefix.length + (fields.max_suffix_length as number)
      > MAX_PROVIDER_ID_LENGTH) {
    throw new Error(
      'webhook bounded-prefix provider-id parser: invalid trusted preset',
    );
  }
  const preset: WebhookBoundedPrefixProviderIdParserPreset = Object.freeze({
    kind: fields.kind,
    prefix: fields.prefix,
    min_suffix_length: fields.min_suffix_length as number,
    max_suffix_length: fields.max_suffix_length as number,
  });

  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      if (typeof value !== 'string' || !value.startsWith(preset.prefix)) {
        return null;
      }
      const suffix = value.slice(preset.prefix.length);
      return suffix.length >= preset.min_suffix_length
        && suffix.length <= preset.max_suffix_length
        && !INVALID_SUFFIX_CHARACTER_RE.test(suffix)
        ? value
        : null;
    },
  });
};
