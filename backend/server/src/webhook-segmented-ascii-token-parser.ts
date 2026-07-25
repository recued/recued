/** D-201 Slice 9AU — closed segmented ASCII-token parser.
 *
 * Trusted preset data selects one bounded ASCII prefix, underscore or dash as
 * a separator, and one through eight exact alphanumeric segment lengths.
 * Runtime values must be primitive strings matching that fixed shape. Because
 * the accepted alphabet is ASCII, character and UTF-8 byte lengths are
 * identical. There is no regex input, callback, coercion, field name, profile
 * id, vendor branch, or outbound authority.
 */

export interface WebhookSegmentedAsciiTokenParserPreset {
  readonly kind: 'segmented_ascii_token.v1';
  readonly prefix: string;
  readonly separator: '_' | '-';
  readonly segment_lengths: readonly number[];
}

export interface WebhookSegmentedAsciiTokenParser {
  readonly preset: WebhookSegmentedAsciiTokenParserPreset;
  parse(value: unknown): string | null;
}

const MAX_TOKEN_BYTES = 65_536;
const MAX_SEGMENTS = 8;
const MAX_SEGMENT_LENGTH = 128;
const PRESET_KEYS = new Set([
  'kind',
  'prefix',
  'separator',
  'segment_lengths',
]);
const ASCII_PREFIX_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ASCII_ALPHANUMERIC_RE = /^[A-Za-z0-9]+$/;
const ARRAY_INDEX_RE = /^(0|[1-9][0-9]*)$/;

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

const copySegmentLengths = (value: unknown): readonly number[] | null => {
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
      || lengthDescriptor.value > MAX_SEGMENTS) {
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
    const copied: number[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
        || !Number.isSafeInteger(descriptor.value)
        || descriptor.value < 1
        || descriptor.value > MAX_SEGMENT_LENGTH) {
        return null;
      }
      copied.push(descriptor.value);
    }
    return Object.freeze(copied);
  } catch {
    return null;
  }
};

export const createWebhookSegmentedAsciiTokenParser = (
  input: WebhookSegmentedAsciiTokenParserPreset,
): WebhookSegmentedAsciiTokenParser => {
  const fields = exactDataValues(input);
  const segmentLengths = fields === null
    ? null
    : copySegmentLengths(fields.segment_lengths);
  if (fields === null
    || fields.kind !== 'segmented_ascii_token.v1'
    || typeof fields.prefix !== 'string'
    || !ASCII_PREFIX_RE.test(fields.prefix)
    || (fields.separator !== '_' && fields.separator !== '-')
    || segmentLengths === null) {
    throw new Error('webhook segmented ASCII-token parser: invalid trusted preset');
  }
  const tokenLength = fields.prefix.length
    + segmentLengths.reduce((total, length) => total + length, 0)
    + ((segmentLengths.length - 1) * fields.separator.length);
  if (tokenLength > MAX_TOKEN_BYTES) {
    throw new Error('webhook segmented ASCII-token parser: invalid trusted preset');
  }
  const preset: WebhookSegmentedAsciiTokenParserPreset = Object.freeze({
    kind: fields.kind,
    prefix: fields.prefix,
    separator: fields.separator,
    segment_lengths: segmentLengths,
  });
  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      if (typeof value !== 'string'
        || value.length !== tokenLength
        || !value.startsWith(preset.prefix)) {
        return null;
      }
      const segments = value.slice(preset.prefix.length)
        .split(preset.separator);
      return segments.length === preset.segment_lengths.length
        && segments.every((segment, index) =>
          segment.length === preset.segment_lengths[index]
          && ASCII_ALPHANUMERIC_RE.test(segment))
        ? value
        : null;
    },
  });
};
