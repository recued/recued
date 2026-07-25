/** D-201 Slice 9AQ — closed prefixed positive-decimal identifier codec.
 *
 * Trusted preset data selects only a bounded literal prefix and digit ceiling.
 * Runtime ids and suffixes must be primitive strings; the positive-decimal
 * grammar remains fixed in the shared closed parser. There is no regex input,
 * callback, coercion, field name, profile id, or vendor branch.
 */

import {
  createWebhookPositiveDecimalIdentifierParser,
} from './webhook-positive-decimal-identifier-parser.js';

export interface WebhookPrefixedPositiveDecimalIdCodecPreset {
  readonly kind: 'fixed_prefix_positive_decimal_id.v1';
  readonly prefix: string;
  readonly max_digits: number;
}

export interface WebhookPrefixedPositiveDecimalIdCodec {
  readonly preset: WebhookPrefixedPositiveDecimalIdCodecPreset;
  parse(value: unknown): string | null;
  format(suffix: unknown): string | null;
}

const MAX_PREFIX_LENGTH = 64;
const PRESET_KEYS = new Set(['kind', 'prefix', 'max_digits']);
const LOWERCASE_ASCII_LETTER_RE = /[a-z]/;
const INVALID_PREFIX_CHARACTER_RE = /[^a-z0-9_:-]/;

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

export const createWebhookPrefixedPositiveDecimalIdCodec = (
  input: WebhookPrefixedPositiveDecimalIdCodecPreset,
): WebhookPrefixedPositiveDecimalIdCodec => {
  const fields = exactDataValues(input);
  const invalidPreset = (): never => {
    throw new Error(
      'webhook prefixed positive-decimal id codec: invalid trusted preset',
    );
  };
  if (fields === null
    || fields.kind !== 'fixed_prefix_positive_decimal_id.v1'
    || typeof fields.prefix !== 'string'
    || fields.prefix.length < 1
    || fields.prefix.length > MAX_PREFIX_LENGTH
    || !LOWERCASE_ASCII_LETTER_RE.test(fields.prefix[0]!)
    || INVALID_PREFIX_CHARACTER_RE.test(fields.prefix)) {
    return invalidPreset();
  }
  let suffixParser: ReturnType<
    typeof createWebhookPositiveDecimalIdentifierParser
  >;
  try {
    suffixParser = createWebhookPositiveDecimalIdentifierParser({
      kind: 'positive_decimal_identifier.v1',
      max_digits: fields.max_digits as number,
    });
  } catch {
    return invalidPreset();
  }
  const preset: WebhookPrefixedPositiveDecimalIdCodecPreset = Object.freeze({
    kind: fields.kind,
    prefix: fields.prefix,
    max_digits: suffixParser.preset.max_digits,
  });

  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      if (typeof value !== 'string' || !value.startsWith(preset.prefix)) {
        return null;
      }
      return suffixParser.parse(value.slice(preset.prefix.length)) === null
        ? null
        : value;
    },
    format(suffix: unknown): string | null {
      const parsed = suffixParser.parse(suffix);
      return parsed === null ? null : `${preset.prefix}${parsed}`;
    },
  });
};
