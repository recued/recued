/** D-201 Slice 9BA — closed decimal-colon ASCII-token parser.
 *
 * Trusted preset data selects only decimal-prefix and ASCII-suffix ceilings.
 * Runtime values must be primitive strings with exactly one colon, a nonempty
 * decimal prefix, and a nonempty suffix made from ASCII letters, digits,
 * underscore, or dash. Leading zeroes remain valid decimal text. There is no
 * regex input, callback, coercion, field name, profile id, vendor branch,
 * credential source, or outbound authority in preset data.
 */

export interface WebhookDecimalColonAsciiTokenParserPreset {
  readonly kind: 'decimal_colon_ascii_token.v1';
  readonly max_digits: number;
  readonly max_suffix_characters: number;
}

export interface WebhookDecimalColonAsciiTokenParser {
  readonly preset: WebhookDecimalColonAsciiTokenParserPreset;
  parse(value: unknown): string | null;
}

const MAX_DECIMAL_DIGITS = 128;
const MAX_TOKEN_CHARACTERS = 65_536;
const PRESET_KEYS = new Set([
  'kind',
  'max_digits',
  'max_suffix_characters',
]);
const NON_DECIMAL_RE = /[^0-9]/;
const NON_ASCII_TOKEN_SUFFIX_RE = /[^A-Za-z0-9_-]/;

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

export const createWebhookDecimalColonAsciiTokenParser = (
  input: WebhookDecimalColonAsciiTokenParserPreset,
): WebhookDecimalColonAsciiTokenParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'decimal_colon_ascii_token.v1'
    || !Number.isSafeInteger(fields.max_digits)
    || (fields.max_digits as number) < 1
    || (fields.max_digits as number) > MAX_DECIMAL_DIGITS
    || !Number.isSafeInteger(fields.max_suffix_characters)
    || (fields.max_suffix_characters as number) < 1
    || (fields.max_suffix_characters as number) > MAX_TOKEN_CHARACTERS
    || (fields.max_digits as number)
      + 1
      + (fields.max_suffix_characters as number) > MAX_TOKEN_CHARACTERS) {
    throw new Error(
      'webhook decimal-colon ASCII-token parser: invalid trusted preset',
    );
  }
  const preset: WebhookDecimalColonAsciiTokenParserPreset = Object.freeze({
    kind: fields.kind,
    max_digits: fields.max_digits as number,
    max_suffix_characters: fields.max_suffix_characters as number,
  });
  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      if (typeof value !== 'string'
        || value.length > preset.max_digits + 1 + preset.max_suffix_characters) {
        return null;
      }
      const separator = value.indexOf(':');
      if (separator < 1
        || separator > preset.max_digits
        || separator !== value.lastIndexOf(':')) {
        return null;
      }
      const suffixLength = value.length - separator - 1;
      if (suffixLength < 1 || suffixLength > preset.max_suffix_characters) {
        return null;
      }
      return !NON_DECIMAL_RE.test(value.slice(0, separator))
        && !NON_ASCII_TOKEN_SUFFIX_RE.test(value.slice(separator + 1))
        ? value
        : null;
    },
  });
};
