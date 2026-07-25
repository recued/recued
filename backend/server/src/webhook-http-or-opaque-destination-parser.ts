/** D-201 Slice 9AZ — closed typed HTTP-or-opaque destination parser.
 *
 * Trusted preset data supplies only two distinct provider discriminator labels
 * and one UTF-16 code-unit ceiling. Runtime destinations are primitive,
 * nonempty, ASCII-control-free strings. The HTTP discriminator additionally
 * requires WHATWG parsing as HTTP(S) with empty username/password fields; the
 * opaque discriminator preserves the original string without claiming that it
 * is an email address or any other semantic subtype. There is no regex, scheme
 * selector, URL template, callback, coercion, profile id, vendor branch,
 * outbound request, or DNS/network access in preset data.
 */

export interface WebhookHttpOrOpaqueDestinationParserPreset {
  readonly kind: 'http_or_opaque_destination.v1';
  readonly max_characters: number;
  readonly http_url_discriminator: string;
  readonly opaque_discriminator: string;
}

export interface WebhookHttpOrOpaqueDestinationParser {
  readonly preset: WebhookHttpOrOpaqueDestinationParserPreset;
  parse(discriminator: unknown, value: unknown): string | null;
}

const MAX_DESTINATION_CHARACTERS = 65_536;
const PRESET_KEYS = new Set([
  'kind',
  'max_characters',
  'http_url_discriminator',
  'opaque_discriminator',
]);
const DISCRIMINATOR_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ASCII_CONTROL_RE = /[\u0000-\u001f\u007f]/;

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

const validDiscriminator = (value: unknown): value is string =>
  typeof value === 'string' && DISCRIMINATOR_RE.test(value);

export const createWebhookHttpOrOpaqueDestinationParser = (
  input: WebhookHttpOrOpaqueDestinationParserPreset,
): WebhookHttpOrOpaqueDestinationParser => {
  const fields = exactDataValues(input);
  if (fields === null
    || fields.kind !== 'http_or_opaque_destination.v1'
    || !Number.isSafeInteger(fields.max_characters)
    || (fields.max_characters as number) < 1
    || (fields.max_characters as number) > MAX_DESTINATION_CHARACTERS
    || !validDiscriminator(fields.http_url_discriminator)
    || !validDiscriminator(fields.opaque_discriminator)
    || fields.http_url_discriminator === fields.opaque_discriminator) {
    throw new Error(
      'webhook HTTP-or-opaque destination parser: invalid trusted preset',
    );
  }
  const preset: WebhookHttpOrOpaqueDestinationParserPreset = Object.freeze({
    kind: fields.kind,
    max_characters: fields.max_characters as number,
    http_url_discriminator: fields.http_url_discriminator,
    opaque_discriminator: fields.opaque_discriminator,
  });
  return Object.freeze({
    preset,
    parse(discriminator: unknown, value: unknown): string | null {
      if ((discriminator !== preset.http_url_discriminator
          && discriminator !== preset.opaque_discriminator)
        || typeof value !== 'string'
        || value.length === 0
        || value.length > preset.max_characters
        || ASCII_CONTROL_RE.test(value)) {
        return null;
      }
      if (discriminator === preset.opaque_discriminator) return value;
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
