/** D-201 Slice 9Q — closed lowercase identifier event-type parser.
 *
 * Trusted preset data selects only a total character ceiling. A value must
 * begin with a lowercase ASCII letter and continue with lowercase ASCII
 * letters, digits, or underscores. There is no regex input, callback,
 * coercion, field/header name, profile id, or vendor branch.
 */

export interface WebhookLowercaseIdentifierEventTypeParserPreset {
  readonly kind: 'lowercase_identifier_event_type.v1';
  readonly max_characters: number;
}

export interface WebhookLowercaseIdentifierEventTypeParser {
  readonly preset: WebhookLowercaseIdentifierEventTypeParserPreset;
  parse(value: unknown): string | null;
}

const MAX_EVENT_TYPE_CHARACTERS = 128;
const PRESET_KEYS = new Set(['kind', 'max_characters']);
const LOWERCASE_IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

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

export const createWebhookLowercaseIdentifierEventTypeParser = (
  input: WebhookLowercaseIdentifierEventTypeParserPreset,
): WebhookLowercaseIdentifierEventTypeParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'lowercase_identifier_event_type.v1'
    || !Number.isSafeInteger(fields.max_characters)
    || (fields.max_characters as number) < 1
    || (fields.max_characters as number) > MAX_EVENT_TYPE_CHARACTERS) {
    throw new Error(
      'webhook lowercase identifier event-type parser: invalid trusted preset',
    );
  }
  const preset: WebhookLowercaseIdentifierEventTypeParserPreset = Object.freeze({
    kind: fields.kind,
    max_characters: fields.max_characters as number,
  });
  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      return typeof value === 'string'
        && value.length <= preset.max_characters
        && LOWERCASE_IDENTIFIER_RE.test(value)
        ? value
        : null;
    },
  });
};
