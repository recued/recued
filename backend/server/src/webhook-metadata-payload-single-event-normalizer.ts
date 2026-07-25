/** D-201 Slice 9U — metadata-plus-payload single-event normalization.
 *
 * This closed pattern promotes one parsed delivery identity to the event
 * identity, preserves one parsed event type and decoded object payload, and
 * fixes resource identity and occurrence time as absent. Unprojected metadata
 * is ignored. There is no profile id, vendor branch, field mapping, callback,
 * coercion, payload transform, deduplication, or durable projection here.
 */

export interface WebhookMetadataPayloadSingleEventNormalizerPreset {
  readonly kind: 'metadata_payload_single_event.v1';
}

export interface WebhookNormalizedMetadataPayloadSingleEvent {
  readonly delivery_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly occurred_at: null;
  readonly resource_id: null;
  readonly payload: Record<string, unknown>;
}

export interface WebhookMetadataPayloadSingleEventNormalizer {
  readonly preset: WebhookMetadataPayloadSingleEventNormalizerPreset;
  normalize(
    metadata: unknown,
    payload: unknown,
  ): WebhookNormalizedMetadataPayloadSingleEvent | null;
}

const PRESET_KEYS = new Set(['kind']);
const MAX_PROVIDER_ID_BYTES = 512;
const MAX_EVENT_TYPE_BYTES = 128;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const MISSING = Symbol('missing metadata field');

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactDataKind = (value: unknown): unknown => {
  try {
    if (!isPlainRecord(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== PRESET_KEYS.size
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

const ownDataValue = (
  record: Record<string, unknown>,
  field: string,
): unknown | typeof MISSING => {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  return descriptor !== undefined
    && descriptor.enumerable
    && 'value' in descriptor
    ? descriptor.value
    : MISSING;
};

const boundedNonBlankString = (
  value: unknown,
  maxBytes: number,
): value is string => typeof value === 'string'
  && value.length > 0
  && value.trim() === value
  && !CONTROL_CHARACTER_RE.test(value)
  && Buffer.byteLength(value, 'utf8') <= maxBytes;

export const createWebhookMetadataPayloadSingleEventNormalizer = (
  input: WebhookMetadataPayloadSingleEventNormalizerPreset,
): WebhookMetadataPayloadSingleEventNormalizer => {
  if (exactDataKind(input) !== 'metadata_payload_single_event.v1') {
    throw new Error(
      'webhook metadata-payload single-event normalizer: invalid trusted preset',
    );
  }
  const preset: WebhookMetadataPayloadSingleEventNormalizerPreset =
    Object.freeze({ kind: 'metadata_payload_single_event.v1' });
  return Object.freeze({
    preset,
    normalize(
      metadata: unknown,
      payload: unknown,
    ): WebhookNormalizedMetadataPayloadSingleEvent | null {
      try {
        if (!isPlainRecord(metadata) || !isPlainRecord(payload)) return null;
        const deliveryId = ownDataValue(metadata, 'delivery_id');
        const eventType = ownDataValue(metadata, 'event_type');
        if (!boundedNonBlankString(deliveryId, MAX_PROVIDER_ID_BYTES)
          || !boundedNonBlankString(eventType, MAX_EVENT_TYPE_BYTES)) {
          return null;
        }
        return Object.freeze({
          delivery_id: deliveryId,
          event_id: deliveryId,
          event_type: eventType,
          occurred_at: null,
          resource_id: null,
          payload,
        });
      } catch {
        return null;
      }
    },
  });
};
