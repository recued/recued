/** D-201 Slice 9AY — closed byte-bounded HTTP(S) URL parser.
 *
 * Trusted preset data selects only one UTF-8 byte ceiling. Runtime values must
 * be primitive strings which WHATWG URL parsing accepts with an `http:` or
 * `https:` protocol and whose parsed username and password are empty. Query,
 * fragment, port, host, and path spelling remain untrusted input data. The
 * original string is returned, including legacy WHATWG normalization edges;
 * there is no scheme selector, host/path template, callback, coercion, profile
 * id, vendor branch, outbound request, or DNS/network access.
 */

export interface WebhookBoundedHttpUrlParserPreset {
  readonly kind: 'bounded_http_url.v1';
  readonly max_bytes: number;
}

export interface WebhookBoundedHttpUrlParser {
  readonly preset: WebhookBoundedHttpUrlParserPreset;
  parse(value: unknown): string | null;
}

const MAX_URL_BYTES = 65_536;
const PRESET_KEYS = new Set(['kind', 'max_bytes']);

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

export const createWebhookBoundedHttpUrlParser = (
  input: WebhookBoundedHttpUrlParserPreset,
): WebhookBoundedHttpUrlParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'bounded_http_url.v1'
    || !Number.isSafeInteger(fields.max_bytes)
    || (fields.max_bytes as number) < 1
    || (fields.max_bytes as number) > MAX_URL_BYTES) {
    throw new Error('webhook bounded HTTP URL parser: invalid trusted preset');
  }
  const preset: WebhookBoundedHttpUrlParserPreset = Object.freeze({
    kind: fields.kind,
    max_bytes: fields.max_bytes as number,
  });
  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      if (typeof value !== 'string'
        || value.length > preset.max_bytes
        || Buffer.byteLength(value, 'utf8') > preset.max_bytes) {
        return null;
      }
      try {
        const parsed = new URL(value);
        return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
          && parsed.username.length === 0
          && parsed.password.length === 0
          ? value
          : null;
      } catch {
        return null;
      }
    },
  });
};
