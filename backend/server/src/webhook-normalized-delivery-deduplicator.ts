/** D-201 Slices 8R + 9N + 9T — closed normalized delivery deduplication engine.
 *
 * A trusted preset selects one required stable id, one stable-id/fallback
 * strategy, or two independently stable delivery/event ids. SHA-256, UTF-8,
 * lowercase hex, fallback material, key bounds, and any single-event suffix
 * are code-fixed.
 */

import { createHash } from 'node:crypto';

export interface WebhookNormalizedIdOrTimestampBodyDeduplicatorPreset {
  readonly kind: 'normalized_id_or_timestamp_body_sha256.v1';
  readonly stable_id_field: string;
  readonly stable_id_prefix: string;
  readonly fallback_prefix: string;
  readonly max_body_bytes: number;
}

export interface WebhookNormalizedPairedIdDeduplicatorPreset {
  readonly kind: 'normalized_paired_ids_sha256.v1';
  readonly delivery_id_field: string;
  readonly event_id_field: string;
  readonly delivery_id_prefix: string;
  readonly event_id_prefix: string;
}

export interface WebhookNormalizedRequiredSingleIdDeduplicatorPreset {
  readonly kind: 'normalized_required_single_id_sha256.v1';
  readonly stable_id_field: string;
  readonly stable_id_prefix: string;
}

export type WebhookNormalizedDeliveryDeduplicatorPreset =
  | WebhookNormalizedIdOrTimestampBodyDeduplicatorPreset
  | WebhookNormalizedRequiredSingleIdDeduplicatorPreset
  | WebhookNormalizedPairedIdDeduplicatorPreset;

export interface WebhookDeliveryDeduplication {
  readonly delivery_dedup_key: string;
  readonly event_dedup_key: string;
}

export interface WebhookNormalizedDeliveryDeduplicator {
  readonly preset: WebhookNormalizedDeliveryDeduplicatorPreset;
  deduplicate(
    normalized: unknown,
    authenticatedTimestampLiteral: string,
    rawBody: Buffer,
  ): WebhookDeliveryDeduplication | null;
}

const MAX_FIELD_BYTES = 128;
const MAX_PREFIX_BYTES = 128;
const MAX_STABLE_ID_BYTES = 512;
const MAX_TIMESTAMP_BYTES = 128;
const MAX_BODY_BYTES = 1_048_576;
const MAX_DEDUP_KEY_BYTES = 256;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const PREFIX_RE = /^[a-z][a-z0-9._:-]*:$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const ID_OR_FALLBACK_PRESET_KEYS = new Set([
  'kind',
  'stable_id_field',
  'stable_id_prefix',
  'fallback_prefix',
  'max_body_bytes',
]);
const PAIRED_ID_PRESET_KEYS = new Set([
  'kind',
  'delivery_id_field',
  'event_id_field',
  'delivery_id_prefix',
  'event_id_prefix',
]);
const REQUIRED_SINGLE_ID_PRESET_KEYS = new Set([
  'kind',
  'stable_id_field',
  'stable_id_prefix',
]);
const MISSING = Symbol('missing normalized stable id');

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

const boundedLiteral = (value: unknown, maxBytes: number): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.trim() === value
  && !CONTROL_CHARACTER_RE.test(value)
  && Buffer.byteLength(value, 'utf8') <= maxBytes;

const validField = (value: unknown): value is string =>
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= MAX_FIELD_BYTES
  && FIELD_RE.test(value);

const validPrefix = (value: unknown): value is string =>
  boundedLiteral(value, MAX_PREFIX_BYTES)
  && PREFIX_RE.test(value)
  && Buffer.byteLength(`${value}${'0'.repeat(64)}:0`, 'utf8')
    <= MAX_DEDUP_KEY_BYTES;

const validatePreset = (
  value: WebhookNormalizedDeliveryDeduplicatorPreset,
): void => {
  if (exactDataRecord(value, ID_OR_FALLBACK_PRESET_KEYS)) {
    if (value.kind === 'normalized_id_or_timestamp_body_sha256.v1'
      && validField(value.stable_id_field)
      && validPrefix(value.stable_id_prefix)
      && validPrefix(value.fallback_prefix)
      && value.stable_id_prefix !== value.fallback_prefix
      && Number.isSafeInteger(value.max_body_bytes)
      && value.max_body_bytes >= 1
      && value.max_body_bytes <= MAX_BODY_BYTES) {
      return;
    }
  } else if (exactDataRecord(value, REQUIRED_SINGLE_ID_PRESET_KEYS)) {
    if (value.kind === 'normalized_required_single_id_sha256.v1'
      && validField(value.stable_id_field)
      && validPrefix(value.stable_id_prefix)) {
      return;
    }
  } else if (exactDataRecord(value, PAIRED_ID_PRESET_KEYS)) {
    if (value.kind === 'normalized_paired_ids_sha256.v1'
      && validField(value.delivery_id_field)
      && validField(value.event_id_field)
      && value.delivery_id_field !== value.event_id_field
      && validPrefix(value.delivery_id_prefix)
      && validPrefix(value.event_id_prefix)
      && value.delivery_id_prefix !== value.event_id_prefix) {
      return;
    }
  }
  throw new Error(
    'webhook normalized delivery deduplicator: invalid trusted preset',
  );
};

const ownStableId = (
  normalized: Record<string, unknown>,
  field: string,
): string | null | typeof MISSING => {
  const descriptor = Object.getOwnPropertyDescriptor(normalized, field);
  if (descriptor === undefined
    || !descriptor.enumerable
    || !('value' in descriptor)) {
    return MISSING;
  }
  return descriptor.value === null
    ? null
    : boundedLiteral(descriptor.value, MAX_STABLE_ID_BYTES)
      ? descriptor.value
      : MISSING;
};

const digestStableId = (stableId: string): string =>
  createHash('sha256').update(stableId, 'utf8').digest('hex');

const digestTimestampAndBody = (
  timestamp: string,
  rawBody: Buffer,
): string => createHash('sha256')
  .update(timestamp, 'utf8')
  .update('\0', 'utf8')
  .update(rawBody)
  .digest('hex');

export const createWebhookNormalizedDeliveryDeduplicator = (
  input: WebhookNormalizedDeliveryDeduplicatorPreset,
): WebhookNormalizedDeliveryDeduplicator => {
  validatePreset(input);
  const preset = Object.freeze({ ...input });

  return Object.freeze({
    preset,
    deduplicate(
      normalized: unknown,
      authenticatedTimestampLiteral: string,
      rawBody: Buffer,
    ): WebhookDeliveryDeduplication | null {
      try {
        if (!isPlainRecord(normalized)) return null;
        if (preset.kind === 'normalized_paired_ids_sha256.v1') {
          const deliveryId = ownStableId(
            normalized,
            preset.delivery_id_field,
          );
          const eventId = ownStableId(normalized, preset.event_id_field);
          if (deliveryId === MISSING
            || deliveryId === null
            || eventId === MISSING
            || eventId === null) {
            return null;
          }
          const deliveryDedupKey =
            `${preset.delivery_id_prefix}${digestStableId(deliveryId)}`;
          const eventDedupKey =
            `${preset.event_id_prefix}${digestStableId(eventId)}`;
          if (Buffer.byteLength(deliveryDedupKey, 'utf8')
              > MAX_DEDUP_KEY_BYTES
            || Buffer.byteLength(eventDedupKey, 'utf8')
              > MAX_DEDUP_KEY_BYTES) {
            return null;
          }
          return Object.freeze({
            delivery_dedup_key: deliveryDedupKey,
            event_dedup_key: eventDedupKey,
          });
        }
        if (preset.kind === 'normalized_required_single_id_sha256.v1') {
          const stableId = ownStableId(normalized, preset.stable_id_field);
          if (stableId === MISSING || stableId === null) return null;
          const deliveryDedupKey =
            `${preset.stable_id_prefix}${digestStableId(stableId)}`;
          const eventDedupKey = `${deliveryDedupKey}:0`;
          if (Buffer.byteLength(eventDedupKey, 'utf8') > MAX_DEDUP_KEY_BYTES) {
            return null;
          }
          return Object.freeze({
            delivery_dedup_key: deliveryDedupKey,
            event_dedup_key: eventDedupKey,
          });
        }
        const stableId = ownStableId(normalized, preset.stable_id_field);
        if (stableId === MISSING) return null;
        let prefix: string;
        let digest: string;
        if (stableId !== null) {
          prefix = preset.stable_id_prefix;
          digest = digestStableId(stableId);
        } else {
          if (!boundedLiteral(
            authenticatedTimestampLiteral,
            MAX_TIMESTAMP_BYTES,
          ) || !Buffer.isBuffer(rawBody)
            || rawBody.byteLength > preset.max_body_bytes) {
            return null;
          }
          prefix = preset.fallback_prefix;
          digest = digestTimestampAndBody(
            authenticatedTimestampLiteral,
            rawBody,
          );
        }
        const deliveryDedupKey = `${prefix}${digest}`;
        const eventDedupKey = `${deliveryDedupKey}:0`;
        if (Buffer.byteLength(eventDedupKey, 'utf8') > MAX_DEDUP_KEY_BYTES) {
          return null;
        }
        return Object.freeze({
          delivery_dedup_key: deliveryDedupKey,
          event_dedup_key: eventDedupKey,
        });
      } catch {
        return null;
      }
    },
  });
};
