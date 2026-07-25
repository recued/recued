/** D-201 Slice 9R — closed positive-decimal identifier parser.
 *
 * Trusted preset data selects only a digit ceiling. A value must be primitive
 * decimal text beginning with 1..9 and continuing with zero or more digits.
 * There is no numeric coercion, integer conversion, regex input, callback,
 * field/header name, profile id, or vendor branch.
 */

export interface WebhookPositiveDecimalIdentifierParserPreset {
  readonly kind: 'positive_decimal_identifier.v1';
  readonly max_digits: number;
}

export interface WebhookPositiveDecimalIdentifierParser {
  readonly preset: WebhookPositiveDecimalIdentifierParserPreset;
  parse(value: unknown): string | null;
}

const MAX_IDENTIFIER_DIGITS = 128;
const PRESET_KEYS = new Set(['kind', 'max_digits']);
const POSITIVE_DECIMAL_RE = /^[1-9][0-9]*$/;

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

export const createWebhookPositiveDecimalIdentifierParser = (
  input: WebhookPositiveDecimalIdentifierParserPreset,
): WebhookPositiveDecimalIdentifierParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'positive_decimal_identifier.v1'
    || !Number.isSafeInteger(fields.max_digits)
    || (fields.max_digits as number) < 1
    || (fields.max_digits as number) > MAX_IDENTIFIER_DIGITS) {
    throw new Error(
      'webhook positive-decimal identifier parser: invalid trusted preset',
    );
  }
  const preset: WebhookPositiveDecimalIdentifierParserPreset = Object.freeze({
    kind: fields.kind,
    max_digits: fields.max_digits as number,
  });
  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      return typeof value === 'string'
        && value.length <= preset.max_digits
        && POSITIVE_DECIMAL_RE.test(value)
        ? value
        : null;
    },
  });
};
