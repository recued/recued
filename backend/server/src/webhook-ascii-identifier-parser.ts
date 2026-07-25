/** D-201 Slice 9AR — closed ASCII identifier parser.
 *
 * Trusted preset data selects only a byte ceiling. Runtime values must be
 * primitive strings beginning with an ASCII letter and continuing with ASCII
 * letters, digits, or underscore. Because the accepted alphabet is ASCII,
 * character length and UTF-8 byte length are identical. There is no regex
 * input, callback, coercion, field name, profile id, or vendor branch.
 */

export interface WebhookAsciiIdentifierParserPreset {
  readonly kind: 'ascii_identifier.v1';
  readonly max_bytes: number;
}

export interface WebhookAsciiIdentifierParser {
  readonly preset: WebhookAsciiIdentifierParserPreset;
  parse(value: unknown): string | null;
}

const MAX_IDENTIFIER_BYTES = 128;
const PRESET_KEYS = new Set(['kind', 'max_bytes']);
const ASCII_IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

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

export const createWebhookAsciiIdentifierParser = (
  input: WebhookAsciiIdentifierParserPreset,
): WebhookAsciiIdentifierParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'ascii_identifier.v1'
    || !Number.isSafeInteger(fields.max_bytes)
    || (fields.max_bytes as number) < 1
    || (fields.max_bytes as number) > MAX_IDENTIFIER_BYTES) {
    throw new Error('webhook ASCII identifier parser: invalid trusted preset');
  }
  const preset: WebhookAsciiIdentifierParserPreset = Object.freeze({
    kind: fields.kind,
    max_bytes: fields.max_bytes as number,
  });
  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      return typeof value === 'string'
        && value.length <= preset.max_bytes
        && ASCII_IDENTIFIER_RE.test(value)
        ? value
        : null;
    },
  });
};
