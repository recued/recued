/** D-201 Slice 9BQ — closed receipt-window/body delivery identity engine.
 *
 * This engine makes the deliberately weaker identity family executable for
 * profiles whose providers expose no stable delivery id. Trusted presets may
 * choose only a fixed namespace, bounded window, and bounded body ceiling.
 */

import { createHash } from 'node:crypto';

export interface WebhookReceivedAtBodyDeduplicatorPreset {
  readonly kind: 'received_at_body_sha256_window.v1';
  readonly key_prefix: string;
  readonly window_ms: number;
  readonly max_body_bytes: number;
}

export interface WebhookReceivedAtBodyDeduplicator {
  readonly preset: WebhookReceivedAtBodyDeduplicatorPreset;
  deduplicate(
    receivedAt: number,
    rawBody: Buffer,
  ): Readonly<{
    delivery_dedup_key: string;
    event_dedup_key: string;
  }> | null;
}

const MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_KEY_PREFIX_BYTES = 128;
const KEY_PREFIX_RE = /^[a-z][a-z0-9._:-]*:$/;
const PRESET_KEYS = new Set([
  'kind',
  'key_prefix',
  'window_ms',
  'max_body_bytes',
]);

const exactDataRecord = (value: unknown): value is Record<string, unknown> => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== PRESET_KEYS.size
      || keys.some((key) => typeof key !== 'string' || !PRESET_KEYS.has(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined
        && descriptor.enumerable
        && 'value' in descriptor;
    });
  } catch {
    return false;
  }
};

export const createWebhookReceivedAtBodyDeduplicator = (
  input: WebhookReceivedAtBodyDeduplicatorPreset,
): WebhookReceivedAtBodyDeduplicator => {
  if (!exactDataRecord(input)
    || input.kind !== 'received_at_body_sha256_window.v1'
    || typeof input.key_prefix !== 'string'
    || Buffer.byteLength(input.key_prefix, 'utf8') > MAX_KEY_PREFIX_BYTES
    || !KEY_PREFIX_RE.test(input.key_prefix)
    || !Number.isSafeInteger(input.window_ms)
    || input.window_ms < 1
    || input.window_ms > MAX_WINDOW_MS
    || !Number.isSafeInteger(input.max_body_bytes)
    || input.max_body_bytes < 1
    || input.max_body_bytes > MAX_BODY_BYTES) {
    throw new Error(
      'webhook received-at/body deduplicator: invalid trusted preset',
    );
  }
  const preset = Object.freeze({ ...input });

  return Object.freeze({
    preset,
    deduplicate(receivedAt: number, rawBody: Buffer) {
      try {
        if (!Number.isSafeInteger(receivedAt)
          || receivedAt < 0
          || !Buffer.isBuffer(rawBody)
          || rawBody.byteLength > preset.max_body_bytes) {
          return null;
        }
        const bucket = Math.floor(receivedAt / preset.window_ms);
        const digest = createHash('sha256').update(rawBody).digest('hex');
        const deliveryDedupKey = `${preset.key_prefix}w${bucket}:${digest}`;
        return Object.freeze({
          delivery_dedup_key: deliveryDedupKey,
          event_dedup_key: `${deliveryDedupKey}:0`,
        });
      } catch {
        return null;
      }
    },
  });
};
