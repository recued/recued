/** D-201 Slice 9AT — closed prefixed ASCII-token parser.
 *
 * Trusted preset data selects one bounded ASCII prefix and a total byte
 * ceiling. Runtime values must be primitive strings with a nonempty suffix;
 * both prefix and suffix use only ASCII letters, digits, underscore, or dash.
 * Because the accepted alphabet is ASCII, character and UTF-8 byte ceilings
 * are identical. There is no regex input, callback, coercion, field name,
 * profile id, vendor branch, or outbound authority.
 */

export interface WebhookPrefixedAsciiTokenParserPreset {
  readonly kind: 'prefixed_ascii_token.v1';
  readonly prefix: string;
  readonly max_bytes: number;
}

export interface WebhookPrefixedAsciiTokenParser {
  readonly preset: WebhookPrefixedAsciiTokenParserPreset;
  parse(value: unknown): string | null;
}

const MAX_TOKEN_BYTES = 65_536;
const PRESET_KEYS = new Set(['kind', 'prefix', 'max_bytes']);
const ASCII_PREFIX_RE = /^[A-Za-z0-9_-]{1,64}$/;
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

export const createWebhookPrefixedAsciiTokenParser = (
  input: WebhookPrefixedAsciiTokenParserPreset,
): WebhookPrefixedAsciiTokenParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'prefixed_ascii_token.v1'
    || typeof fields.prefix !== 'string'
    || !ASCII_PREFIX_RE.test(fields.prefix)
    || !Number.isSafeInteger(fields.max_bytes)
    || (fields.max_bytes as number) < 1
    || (fields.max_bytes as number) > MAX_TOKEN_BYTES
    || fields.prefix.length >= (fields.max_bytes as number)) {
    throw new Error('webhook prefixed ASCII-token parser: invalid trusted preset');
  }
  const preset: WebhookPrefixedAsciiTokenParserPreset = Object.freeze({
    kind: fields.kind,
    prefix: fields.prefix,
    max_bytes: fields.max_bytes as number,
  });
  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      if (typeof value !== 'string'
        || value.length > preset.max_bytes
        || !value.startsWith(preset.prefix)) {
        return null;
      }
      return ASCII_TOKEN_RE.test(value.slice(preset.prefix.length))
        ? value
        : null;
    },
  });
};
