/** D-201 Slice 8P — closed JSON challenge classifier and echo projector.
 *
 * A trusted preset names one top-level discriminator, challenge, and response
 * field. Classification distinguishes unrelated traffic from malformed traffic
 * that matched the handshake discriminator, so a broken challenge cannot fall
 * through as an ordinary delivery. Status, content type, readiness semantics,
 * JSON encoding, field access, and challenge safety are code-fixed.
 */

export interface WebhookJsonChallengeProjectorPreset {
  readonly kind: 'json_challenge_echo.v1';
  readonly discriminator_field: string;
  readonly discriminator_value: string;
  readonly challenge_field: string;
  readonly response_field: string;
  readonly max_challenge_bytes: number;
}

export interface WebhookJsonChallengeProjection {
  readonly response: Readonly<{
    status: 200;
    content_type: 'application/json';
    body: string;
  }>;
  readonly readiness_proven: true;
}

export type WebhookJsonChallengeClassification =
  | Readonly<{ kind: 'not_matched' }>
  | Readonly<{ kind: 'matched_invalid' }>
  | Readonly<{
      kind: 'matched';
      projection: WebhookJsonChallengeProjection;
    }>;

export interface WebhookJsonChallengeProjector {
  readonly preset: WebhookJsonChallengeProjectorPreset;
  classify(envelope: unknown): WebhookJsonChallengeClassification;
}

const MAX_FIELD_BYTES = 128;
const MAX_DISCRIMINATOR_VALUE_BYTES = 128;
const MAX_CHALLENGE_BYTES = 65_536;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const PRESET_KEYS = new Set([
  'kind',
  'discriminator_field',
  'discriminator_value',
  'challenge_field',
  'response_field',
  'max_challenge_bytes',
]);

const NOT_MATCHED = Object.freeze({ kind: 'not_matched' } as const);
const MATCHED_INVALID = Object.freeze({ kind: 'matched_invalid' } as const);

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

const validField = (value: unknown): value is string =>
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= MAX_FIELD_BYTES
  && FIELD_RE.test(value);

const boundedLiteral = (value: unknown, maxBytes: number): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.trim() === value
  && !CONTROL_CHARACTER_RE.test(value)
  && Buffer.byteLength(value, 'utf8') <= maxBytes;

const validatePreset = (value: WebhookJsonChallengeProjectorPreset): void => {
  if (!exactDataRecord(value, PRESET_KEYS)
    || value.kind !== 'json_challenge_echo.v1'
    || !validField(value.discriminator_field)
    || !boundedLiteral(
      value.discriminator_value,
      MAX_DISCRIMINATOR_VALUE_BYTES,
    )
    || !validField(value.challenge_field)
    || value.challenge_field === value.discriminator_field
    || !validField(value.response_field)
    || !Number.isSafeInteger(value.max_challenge_bytes)
    || value.max_challenge_bytes < 1
    || value.max_challenge_bytes > MAX_CHALLENGE_BYTES) {
    throw new Error('webhook JSON challenge projector: invalid trusted preset');
  }
};

export const createWebhookJsonChallengeProjector = (
  input: WebhookJsonChallengeProjectorPreset,
): WebhookJsonChallengeProjector => {
  validatePreset(input);
  const preset = Object.freeze({ ...input });

  return Object.freeze({
    preset,
    classify(envelope: unknown): WebhookJsonChallengeClassification {
      try {
        if (!isPlainRecord(envelope)) return MATCHED_INVALID;
        const discriminator = Object.getOwnPropertyDescriptor(
          envelope,
          preset.discriminator_field,
        );
        if (discriminator === undefined) return NOT_MATCHED;
        if (!discriminator.enumerable || !('value' in discriminator)) {
          return MATCHED_INVALID;
        }
        if (discriminator.value !== preset.discriminator_value) {
          return NOT_MATCHED;
        }
        const challenge = Object.getOwnPropertyDescriptor(
          envelope,
          preset.challenge_field,
        );
        if (challenge === undefined
          || !challenge.enumerable
          || !('value' in challenge)
          || !boundedLiteral(challenge.value, preset.max_challenge_bytes)) {
          return MATCHED_INVALID;
        }
        const responsePayload = Object.create(null) as Record<string, string>;
        responsePayload[preset.response_field] = challenge.value;
        const projection: WebhookJsonChallengeProjection = Object.freeze({
          response: Object.freeze({
            status: 200,
            content_type: 'application/json',
            body: JSON.stringify(responsePayload),
          }),
          readiness_proven: true,
        });
        return Object.freeze({ kind: 'matched', projection });
      } catch {
        return MATCHED_INVALID;
      }
    },
  });
};
