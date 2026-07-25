/** D-201 Slice 9BC — closed printable-ASCII token prefix-set parser.
 *
 * Trusted preset data selects a bounded set of literal printable-ASCII
 * prefixes and one total byte ceiling. Runtime values must be nonempty
 * primitive strings made only from printable non-space ASCII and begin with at
 * least one selected prefix. A suffix is deliberately not required. There is
 * no regex input, callback, coercion, field name, profile id, vendor branch,
 * credential kind, auth transport, or outbound authority in preset data.
 */

export interface WebhookPrefixSetPrintableAsciiTokenParserPreset {
  readonly kind: 'prefix_set_printable_ascii_token.v1';
  readonly max_bytes: number;
  readonly prefixes: readonly string[];
}

export interface WebhookPrefixSetPrintableAsciiTokenParser {
  readonly preset: WebhookPrefixSetPrintableAsciiTokenParserPreset;
  parse(value: unknown): string | null;
}

const MAX_PREFIXES = 32;
const MAX_PREFIX_BYTES = 64;
const MAX_TOKEN_BYTES = 65_536;
const PRESET_KEYS = new Set(['kind', 'max_bytes', 'prefixes']);
const ARRAY_INDEX_RE = /^(0|[1-9][0-9]*)$/;
const PRINTABLE_ASCII_PREFIX_RE = /^[\x21-\x7e]+$/;
const PRINTABLE_ASCII_TOKEN_RE = /^[\x21-\x7e]+$/;

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

const copyPrefixes = (
  value: unknown,
  maxBytes: number,
): readonly string[] | null => {
  try {
    if (!Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype) {
      return null;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined
      || !('value' in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 1
      || lengthDescriptor.value > MAX_PREFIXES) {
      return null;
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1
      || keys.some((key) => key !== 'length'
        && (typeof key !== 'string'
          || !ARRAY_INDEX_RE.test(key)
          || Number(key) >= length))) {
      return null;
    }
    const prefixes: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
        || typeof descriptor.value !== 'string'
        || descriptor.value.length > MAX_PREFIX_BYTES
        || descriptor.value.length > maxBytes
        || !PRINTABLE_ASCII_PREFIX_RE.test(descriptor.value)
        || prefixes.includes(descriptor.value)) {
        return null;
      }
      prefixes.push(descriptor.value);
    }
    return Object.freeze(prefixes);
  } catch {
    return null;
  }
};

export const createWebhookPrefixSetPrintableAsciiTokenParser = (
  input: WebhookPrefixSetPrintableAsciiTokenParserPreset,
): WebhookPrefixSetPrintableAsciiTokenParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'prefix_set_printable_ascii_token.v1'
    || !Number.isSafeInteger(fields.max_bytes)
    || (fields.max_bytes as number) < 1
    || (fields.max_bytes as number) > MAX_TOKEN_BYTES) {
    throw new Error(
      'webhook printable-ASCII token prefix-set parser: invalid trusted preset',
    );
  }
  const prefixes = copyPrefixes(fields.prefixes, fields.max_bytes as number);
  if (prefixes === null) {
    throw new Error(
      'webhook printable-ASCII token prefix-set parser: invalid trusted preset',
    );
  }
  const preset: WebhookPrefixSetPrintableAsciiTokenParserPreset = Object.freeze({
    kind: fields.kind,
    max_bytes: fields.max_bytes as number,
    prefixes,
  });
  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      return typeof value === 'string'
        && value.length <= preset.max_bytes
        && PRINTABLE_ASCII_TOKEN_RE.test(value)
        && preset.prefixes.some((prefix) => value.startsWith(prefix))
        ? value
        : null;
    },
  });
};
