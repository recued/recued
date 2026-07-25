/** D-201 Slice 9BE — closed bounded-prefixed ASCII identifier parser.
 *
 * Trusted preset data selects one literal ASCII prefix and a bounded suffix
 * character range. Runtime values must be primitive strings whose complete
 * prefix and suffix use only ASCII letters, digits, underscore, or dash.
 * Because the accepted alphabet is ASCII, character and UTF-8 byte lengths are
 * identical. There is no regex input, callback, coercion, field name, profile
 * id, vendor branch, credential source, or outbound authority in preset data.
 */

export interface WebhookBoundedPrefixedAsciiIdentifierParserPreset {
  readonly kind: 'bounded_prefixed_ascii_identifier.v1';
  readonly prefix: string;
  readonly min_suffix_characters: number;
  readonly max_suffix_characters: number;
}

export interface WebhookBoundedPrefixedAsciiIdentifierParser {
  readonly preset: WebhookBoundedPrefixedAsciiIdentifierParserPreset;
  parse(value: unknown): string | null;
}

const MAX_PREFIX_CHARACTERS = 64;
const MAX_IDENTIFIER_CHARACTERS = 65_536;
const PRESET_KEYS = new Set([
  'kind',
  'prefix',
  'min_suffix_characters',
  'max_suffix_characters',
]);
const ASCII_PREFIX_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ASCII_SUFFIX_RE = /^[A-Za-z0-9_-]+$/;

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

export const createWebhookBoundedPrefixedAsciiIdentifierParser = (
  input: WebhookBoundedPrefixedAsciiIdentifierParserPreset,
): WebhookBoundedPrefixedAsciiIdentifierParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'bounded_prefixed_ascii_identifier.v1'
    || typeof fields.prefix !== 'string'
    || fields.prefix.length < 1
    || fields.prefix.length > MAX_PREFIX_CHARACTERS
    || !ASCII_PREFIX_RE.test(fields.prefix)
    || !Number.isSafeInteger(fields.min_suffix_characters)
    || !Number.isSafeInteger(fields.max_suffix_characters)
    || (fields.min_suffix_characters as number) < 1
    || (fields.max_suffix_characters as number)
      < (fields.min_suffix_characters as number)
    || fields.prefix.length + (fields.max_suffix_characters as number)
      > MAX_IDENTIFIER_CHARACTERS) {
    throw new Error(
      'webhook bounded-prefixed ASCII identifier parser: invalid trusted preset',
    );
  }
  const preset: WebhookBoundedPrefixedAsciiIdentifierParserPreset =
    Object.freeze({
      kind: fields.kind,
      prefix: fields.prefix,
      min_suffix_characters: fields.min_suffix_characters as number,
      max_suffix_characters: fields.max_suffix_characters as number,
    });
  const minCharacters = preset.prefix.length + preset.min_suffix_characters;
  const maxCharacters = preset.prefix.length + preset.max_suffix_characters;

  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      if (typeof value !== 'string'
        || value.length < minCharacters
        || value.length > maxCharacters
        || !value.startsWith(preset.prefix)) {
        return null;
      }
      return ASCII_SUFFIX_RE.test(value.slice(preset.prefix.length))
        ? value
        : null;
    },
  });
};
