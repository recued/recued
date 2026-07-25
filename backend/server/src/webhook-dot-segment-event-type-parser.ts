/** D-201 Slice 9I — closed lowercase dot-segment event-type parser.
 *
 * Trusted preset data selects only an exact segment count and a per-segment
 * character ceiling. Each segment must begin with a lowercase ASCII letter and
 * continue with lowercase ASCII letters, digits, or underscores. There is no
 * regex input, callback, coercion, field name, profile id, or vendor branch.
 */

export interface WebhookDotSegmentEventTypeParserPreset {
  readonly kind: 'lowercase_dot_segment_event_type.v1';
  readonly segment_count: number;
  readonly max_segment_characters: number;
}

export interface WebhookDotSegmentEventTypeParser {
  readonly preset: WebhookDotSegmentEventTypeParserPreset;
  parse(value: unknown): string | null;
}

const MAX_EVENT_TYPE_CHARACTERS = 128;
const MAX_SEGMENT_COUNT = 16;
const PRESET_KEYS = new Set([
  'kind',
  'segment_count',
  'max_segment_characters',
]);
const LOWERCASE_ASCII_LETTER_RE = /[a-z]/;
const INVALID_SEGMENT_CHARACTER_RE = /[^a-z0-9_]/;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactDataValues = (
  value: unknown,
): Readonly<Record<string, unknown>> | null => {
  try {
    if (!isPlainRecord(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== PRESET_KEYS.size
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

export const createWebhookDotSegmentEventTypeParser = (
  input: WebhookDotSegmentEventTypeParserPreset,
): WebhookDotSegmentEventTypeParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'lowercase_dot_segment_event_type.v1'
    || !Number.isSafeInteger(fields.segment_count)
    || (fields.segment_count as number) < 1
    || (fields.segment_count as number) > MAX_SEGMENT_COUNT
    || !Number.isSafeInteger(fields.max_segment_characters)
    || (fields.max_segment_characters as number) < 1
    || ((fields.segment_count as number)
      * (fields.max_segment_characters as number)
      + (fields.segment_count as number) - 1) > MAX_EVENT_TYPE_CHARACTERS) {
    throw new Error(
      'webhook dot-segment event-type parser: invalid trusted preset',
    );
  }
  const preset: WebhookDotSegmentEventTypeParserPreset = Object.freeze({
    kind: fields.kind,
    segment_count: fields.segment_count as number,
    max_segment_characters: fields.max_segment_characters as number,
  });
  const maximumLength = preset.segment_count
    * preset.max_segment_characters
    + preset.segment_count - 1;

  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      if (typeof value !== 'string'
        || value.length < preset.segment_count * 2 - 1
        || value.length > maximumLength) {
        return null;
      }
      const segments = value.split('.');
      if (segments.length !== preset.segment_count) return null;
      for (const segment of segments) {
        if (segment.length < 1
          || segment.length > preset.max_segment_characters
          || !LOWERCASE_ASCII_LETTER_RE.test(segment[0]!)
          || INVALID_SEGMENT_CHARACTER_RE.test(segment)) {
          return null;
        }
      }
      return value;
    },
  });
};
