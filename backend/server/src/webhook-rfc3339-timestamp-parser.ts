/** D-201 Slice 9G — closed strict RFC3339 occurrence-time parser.
 *
 * Trusted preset data may only lower the code-backed input byte bound. The
 * accepted calendar, offset, fractional-second, and Unix-millisecond semantics
 * are fixed here; there is no format string, locale, callback, coercion, or
 * profile/vendor branch.
 */

export interface WebhookRfc3339TimestampParserPreset {
  readonly kind: 'strict_rfc3339_milliseconds.v1';
  readonly max_bytes: number;
}

export interface WebhookRfc3339TimestampParser {
  readonly preset: WebhookRfc3339TimestampParserPreset;
  parse(value: unknown): number | null;
}

const HARD_MAX_BYTES = 64;
const MIN_RFC3339_BYTES = 20;
const PRESET_KEYS = new Set(['kind', 'max_bytes']);
const RFC3339_RE =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|([+-])([0-9]{2}):([0-9]{2}))$/;

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

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

export const createWebhookRfc3339TimestampParser = (
  input: WebhookRfc3339TimestampParserPreset,
): WebhookRfc3339TimestampParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'strict_rfc3339_milliseconds.v1'
    || !Number.isSafeInteger(fields.max_bytes)
    || (fields.max_bytes as number) < MIN_RFC3339_BYTES
    || (fields.max_bytes as number) > HARD_MAX_BYTES) {
    throw new Error('webhook RFC3339 timestamp parser: invalid trusted preset');
  }
  const preset: WebhookRfc3339TimestampParserPreset = Object.freeze({
    kind: fields.kind,
    max_bytes: fields.max_bytes as number,
  });

  return Object.freeze({
    preset,
    parse(value: unknown): number | null {
      if (typeof value !== 'string'
        || Buffer.byteLength(value, 'utf8') > preset.max_bytes) {
        return null;
      }
      const match = RFC3339_RE.exec(value);
      if (match === null) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const hour = Number(match[4]);
      const minute = Number(match[5]);
      const second = Number(match[6]);
      const fraction = match[7] ?? '';
      const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
      const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
      if (year < 1970
        || month < 1
        || month > 12
        || hour > 23
        || minute > 59
        || second > 59
        || offsetHour > 23
        || offsetMinute > 59) {
        return null;
      }
      const daysInMonth = [
        31,
        isLeapYear(year) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
      ][month - 1]!;
      if (day < 1 || day > daysInMonth) return null;
      const milliseconds = Number(`${fraction}000`.slice(0, 3));
      const localEpoch = Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        second,
        milliseconds,
      );
      const offset = (offsetHour * 60 + offsetMinute) * 60_000;
      const epoch = match[9] === '+'
        ? localEpoch - offset
        : match[9] === '-'
          ? localEpoch + offset
          : localEpoch;
      return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
    },
  });
};
