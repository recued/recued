/** D-201 Slice 9AV — closed fixed-length ASCII-token parser.
 *
 * Trusted preset data selects only one exact character count. Runtime values
 * must be primitive strings made from ASCII letters, digits, underscore, or
 * dash. Because the accepted alphabet is ASCII, character and UTF-8 byte
 * lengths are identical. There is no regex input, callback, coercion, field
 * name, profile id, vendor branch, credential source, or outbound authority.
 */

export interface WebhookFixedLengthAsciiTokenParserPreset {
  readonly kind: 'fixed_length_ascii_token.v1';
  readonly characters: number;
}

export interface WebhookFixedLengthAsciiTokenParser {
  readonly preset: WebhookFixedLengthAsciiTokenParserPreset;
  parse(value: unknown): string | null;
}

const MAX_TOKEN_CHARACTERS = 65_536;
const PRESET_KEYS = new Set(['kind', 'characters']);
const ASCII_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

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

export const createWebhookFixedLengthAsciiTokenParser = (
  input: WebhookFixedLengthAsciiTokenParserPreset,
): WebhookFixedLengthAsciiTokenParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'fixed_length_ascii_token.v1'
    || !Number.isSafeInteger(fields.characters)
    || (fields.characters as number) < 1
    || (fields.characters as number) > MAX_TOKEN_CHARACTERS) {
    throw new Error('webhook fixed-length ASCII-token parser: invalid trusted preset');
  }
  const preset: WebhookFixedLengthAsciiTokenParserPreset = Object.freeze({
    kind: fields.kind,
    characters: fields.characters as number,
  });
  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      return typeof value === 'string'
        && value.length === preset.characters
        && ASCII_TOKEN_RE.test(value)
        ? value
        : null;
    },
  });
};
