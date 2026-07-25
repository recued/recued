/** D-201 Slice 9P — closed canonical UUID identity parser.
 *
 * The engine accepts one primitive UUID-shaped hexadecimal string, preserves no
 * version/variant semantics, and returns lowercase canonical text. There is no
 * profile id, field/header name, callback, coercion, or vendor branch.
 */

export interface WebhookCanonicalUuidParserPreset {
  readonly kind: 'canonical_uuid_hex.v1';
}

export interface WebhookCanonicalUuidParser {
  readonly preset: WebhookCanonicalUuidParserPreset;
  parse(value: unknown): string | null;
}

const PRESET_KEYS = new Set(['kind']);
const UUID_HEX_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const exactDataKind = (value: unknown): unknown => {
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
    const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
    return descriptor !== undefined
      && descriptor.enumerable
      && 'value' in descriptor
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
};

export const createWebhookCanonicalUuidParser = (
  input: WebhookCanonicalUuidParserPreset,
): WebhookCanonicalUuidParser => {
  if (exactDataKind(input) !== 'canonical_uuid_hex.v1') {
    throw new Error('webhook canonical UUID parser: invalid trusted preset');
  }
  const preset: WebhookCanonicalUuidParserPreset = Object.freeze({
    kind: 'canonical_uuid_hex.v1',
  });
  return Object.freeze({
    preset,
    parse(value: unknown): string | null {
      return typeof value === 'string' && UUID_HEX_RE.test(value)
        ? value.toLowerCase()
        : null;
    },
  });
};
