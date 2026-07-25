/** D-201 Slice 9AJ — closed managed-registration idempotency-key parser.
 *
 * Trusted preset data selects only a total character ceiling. Keys remain
 * primitive ASCII text drawn from the fixed alphanumeric, dot, underscore,
 * colon, and dash alphabet. There is no regex input, callback, coercion,
 * provider field/header name, or outbound request authority.
 */

export interface WebhookRegistrationIdempotencyKeyParserPreset {
  readonly kind: 'ascii_registration_idempotency_key.v1';
  readonly max_characters: number;
}

export interface WebhookRegistrationIdempotencyKeyParser {
  readonly preset: WebhookRegistrationIdempotencyKeyParserPreset;
  parse(value: unknown): string | null;
}

const MAX_IDEMPOTENCY_KEY_CHARACTERS = 255;
const PRESET_KEYS = new Set(['kind', 'max_characters']);
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]+$/;

const exactOwnDataRecord = (
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

export const createWebhookRegistrationIdempotencyKeyParser = (
  input: WebhookRegistrationIdempotencyKeyParserPreset,
): WebhookRegistrationIdempotencyKeyParser => {
  const fields = exactOwnDataRecord(input);
  if (fields === null
    || fields.kind !== 'ascii_registration_idempotency_key.v1'
    || !Number.isSafeInteger(fields.max_characters)
    || (fields.max_characters as number) < 1
    || (fields.max_characters as number) > MAX_IDEMPOTENCY_KEY_CHARACTERS) {
    throw new Error(
      'webhook registration idempotency-key parser: invalid trusted preset',
    );
  }
  const preset: WebhookRegistrationIdempotencyKeyParserPreset = Object.freeze({
    kind: fields.kind,
    max_characters: fields.max_characters as number,
  });
  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      return typeof value === 'string'
        && value.length <= preset.max_characters
        && IDEMPOTENCY_KEY_RE.test(value)
        ? value
        : null;
    },
  });
};
