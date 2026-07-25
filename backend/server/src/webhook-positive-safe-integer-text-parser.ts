/** D-201 Slice 9BG — closed positive-safe-integer text parser.
 *
 * Trusted preset data selects only a positive safe-integer ceiling. Runtime
 * values must be primitive canonical decimal text beginning with 1..9. The
 * parser distinguishes invalid text shape from a well-shaped value outside the
 * selected range so callers can preserve established error contracts. It
 * exposes no regex, callback, coercion, field name, profile id, vendor branch,
 * credential source, or storage authority through preset data.
 */

export interface WebhookPositiveSafeIntegerTextParserPreset {
  readonly kind: 'positive_safe_integer_text.v1';
  readonly max_value: number;
}

export interface WebhookParsedPositiveSafeIntegerText {
  readonly ok: true;
  readonly text: string;
  readonly value: number;
}

export type WebhookPositiveSafeIntegerTextParseResult =
  | WebhookParsedPositiveSafeIntegerText
  | Readonly<{
      ok: false;
      reason: 'invalid_shape' | 'out_of_range';
    }>;

export interface WebhookPositiveSafeIntegerTextParser {
  readonly preset: WebhookPositiveSafeIntegerTextParserPreset;
  parse(value: unknown): WebhookPositiveSafeIntegerTextParseResult;
}

const POSITIVE_DECIMAL_TEXT_RE = /^[1-9][0-9]*$/;
const PRESET_KEYS = new Set(['kind', 'max_value']);
const INVALID_SHAPE = Object.freeze({
  ok: false as const,
  reason: 'invalid_shape' as const,
});
const OUT_OF_RANGE = Object.freeze({
  ok: false as const,
  reason: 'out_of_range' as const,
});

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

export const createWebhookPositiveSafeIntegerTextParser = (
  input: WebhookPositiveSafeIntegerTextParserPreset,
): WebhookPositiveSafeIntegerTextParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'positive_safe_integer_text.v1'
    || !Number.isSafeInteger(fields.max_value)
    || (fields.max_value as number) < 1) {
    throw new Error(
      'webhook positive-safe-integer text parser: invalid trusted preset',
    );
  }
  const preset: WebhookPositiveSafeIntegerTextParserPreset = Object.freeze({
    kind: fields.kind,
    max_value: fields.max_value as number,
  });
  return Object.freeze({
    preset,
    parse(value: unknown): WebhookPositiveSafeIntegerTextParseResult {
      if (typeof value !== 'string' || !POSITIVE_DECIMAL_TEXT_RE.test(value)) {
        return INVALID_SHAPE;
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)
        || parsed < 1
        || parsed > preset.max_value) {
        return OUT_OF_RANGE;
      }
      return Object.freeze({ ok: true, text: value, value: parsed });
    },
  });
};
