/** D-201 Slice 9AX — closed bounded HTTPS URL parser.
 *
 * Trusted preset data selects only a UTF-8 byte ceiling and an exact nonempty
 * port allowlist. Runtime values must be primitive strings which WHATWG URL
 * parsing accepts as absolute HTTPS and whose parsed username, password,
 * search, and hash values are empty. The original primitive string is returned
 * so the parser does not silently canonicalize provider or owner authority.
 * This deliberately retains legacy acceptance of raw empty delimiters and
 * surrounding URL whitespace. There is no host/path template, callback,
 * coercion, profile id, vendor branch, outbound request, or DNS/network access.
 */

export interface WebhookBoundedHttpsUrlParserPreset {
  readonly kind: 'bounded_https_url.v1';
  readonly max_bytes: number;
  readonly allowed_ports: readonly number[];
}

export interface WebhookBoundedHttpsUrlParser {
  readonly preset: WebhookBoundedHttpsUrlParserPreset;
  parse(value: unknown): string | null;
}

const MAX_URL_BYTES = 65_536;
const MAX_ALLOWED_PORTS = 32;
const PRESET_KEYS = new Set(['kind', 'max_bytes', 'allowed_ports']);
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

const copyAllowedPorts = (value: unknown): readonly number[] | null => {
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
      || lengthDescriptor.value > MAX_ALLOWED_PORTS) {
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
        || descriptor.value > 65_535
        || copied.includes(descriptor.value)) {
        return null;
      }
      copied.push(descriptor.value);
    }
    return Object.freeze(copied);
  } catch {
    return null;
  }
};

export const createWebhookBoundedHttpsUrlParser = (
  input: WebhookBoundedHttpsUrlParserPreset,
): WebhookBoundedHttpsUrlParser => {
  const fields = exactDataValues(input);
  const allowedPorts = fields === null
    ? null
    : copyAllowedPorts(fields.allowed_ports);
  if (fields === null
    || fields.kind !== 'bounded_https_url.v1'
    || !Number.isSafeInteger(fields.max_bytes)
    || (fields.max_bytes as number) < 1
    || (fields.max_bytes as number) > MAX_URL_BYTES
    || allowedPorts === null) {
    throw new Error('webhook bounded HTTPS URL parser: invalid trusted preset');
  }
  const preset: WebhookBoundedHttpsUrlParserPreset = Object.freeze({
    kind: fields.kind,
    max_bytes: fields.max_bytes as number,
    allowed_ports: allowedPorts,
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
        if (parsed.protocol !== 'https:'
          || parsed.username.length > 0
          || parsed.password.length > 0
          || parsed.search.length > 0
          || parsed.hash.length > 0) {
          return null;
        }
        const port = parsed.port === '' ? 443 : Number(parsed.port);
        return Number.isSafeInteger(port)
          && preset.allowed_ports.includes(port)
          ? value
          : null;
      } catch {
        return null;
      }
    },
  });
};
