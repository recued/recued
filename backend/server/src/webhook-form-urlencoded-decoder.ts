/** D-201 Slice 8O — closed bounded form-urlencoded decoder engine.
 *
 * Trusted presets may only lower code-fixed byte, field, key, and value caps
 * and select the one admitted key grammar. Percent decoding, duplicate and
 * prototype-sensitive key rejection, fatal UTF-8, plus handling, and the
 * null-prototype output shape are not profile- or owner-supplied behavior.
 */

export interface WebhookFormUrlencodedDecoderPreset {
  readonly kind: 'bounded_form_urlencoded.v1';
  readonly max_body_bytes: number;
  readonly max_fields: number;
  readonly max_key_bytes: number;
  readonly max_value_bytes: number;
  readonly key_grammar: 'ascii_alphanumeric_dot_dash_underscore.v1';
}

export interface WebhookFormUrlencodedDecoder {
  readonly preset: WebhookFormUrlencodedDecoderPreset;
  decode(rawBody: Buffer): Readonly<Record<string, string>> | null;
}

const HARD_LIMITS = Object.freeze({
  max_body_bytes: 1_048_576,
  max_fields: 64,
  max_key_bytes: 128,
  max_value_bytes: 262_144,
});

export const WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET:
  WebhookFormUrlencodedDecoderPreset = Object.freeze({
    kind: 'bounded_form_urlencoded.v1',
    ...HARD_LIMITS,
    key_grammar: 'ascii_alphanumeric_dot_dash_underscore.v1',
  });

const PRESET_KEYS = new Set([
  'kind',
  'max_body_bytes',
  'max_fields',
  'max_key_bytes',
  'max_value_bytes',
  'key_grammar',
]);
const PROTOTYPE_SENSITIVE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const ASCII_FORM_KEY_RE = /^[A-Za-z0-9_.-]+$/;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactDataRecord = (value: unknown, keys: ReadonlySet<string>): boolean => {
  if (!isPlainRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.size
    || ownKeys.some((key) => typeof key !== 'string' || !keys.has(key))) {
    return false;
  }
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.enumerable
      && 'value' in descriptor;
  });
};

const validLimit = (
  value: unknown,
  maximum: number,
): value is number => Number.isSafeInteger(value)
  && (value as number) >= 1
  && (value as number) <= maximum;

const validatePreset = (value: WebhookFormUrlencodedDecoderPreset): void => {
  if (!exactDataRecord(value, PRESET_KEYS)
    || value.kind !== 'bounded_form_urlencoded.v1'
    || !validLimit(value.max_body_bytes, HARD_LIMITS.max_body_bytes)
    || !validLimit(value.max_fields, HARD_LIMITS.max_fields)
    || !validLimit(value.max_key_bytes, HARD_LIMITS.max_key_bytes)
    || !validLimit(value.max_value_bytes, HARD_LIMITS.max_value_bytes)
    || value.key_grammar !== 'ascii_alphanumeric_dot_dash_underscore.v1') {
    throw new Error('webhook form-urlencoded decoder: invalid trusted preset');
  }
};

const strictFormComponent = (raw: string): string | null => {
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '%') continue;
    if (index + 2 >= raw.length
      || !/^[0-9A-Fa-f]{2}$/.test(raw.slice(index + 1, index + 3))) {
      return null;
    }
    index += 2;
  }
  try {
    return decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {
    return null;
  }
};

export const createWebhookFormUrlencodedDecoder = (
  input: WebhookFormUrlencodedDecoderPreset,
): WebhookFormUrlencodedDecoder => {
  validatePreset(input);
  const preset = Object.freeze({ ...input });

  return Object.freeze({
    preset,
    decode(rawBody: Buffer): Readonly<Record<string, string>> | null {
      if (rawBody.byteLength === 0
        || rawBody.byteLength > preset.max_body_bytes) {
        return null;
      }
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(rawBody);
      } catch {
        return null;
      }
      if (decoded.length === 0 || decoded.charCodeAt(0) === 0xfeff) return null;

      let fieldCount = 1;
      for (let index = 0; index < decoded.length; index += 1) {
        if (decoded[index] !== '&') continue;
        fieldCount += 1;
        if (fieldCount > preset.max_fields) return null;
      }

      const fields = Object.create(null) as Record<string, string>;
      for (const part of decoded.split('&')) {
        const separator = part.indexOf('=');
        if (separator <= 0) return null;
        const key = strictFormComponent(part.slice(0, separator));
        const value = strictFormComponent(part.slice(separator + 1));
        if (key === null
          || value === null
          || Buffer.byteLength(key, 'utf8') > preset.max_key_bytes
          || Buffer.byteLength(value, 'utf8') > preset.max_value_bytes
          || !ASCII_FORM_KEY_RE.test(key)
          || PROTOTYPE_SENSITIVE_KEYS.has(key)
          || Object.prototype.hasOwnProperty.call(fields, key)) {
          return null;
        }
        fields[key] = value;
      }
      return Object.freeze(fields);
    },
  });
};

export const WEBHOOK_FORM_URLENCODED_DECODER_V1 =
  createWebhookFormUrlencodedDecoder(
    WEBHOOK_FORM_URLENCODED_DECODER_V1_PRESET,
  );
