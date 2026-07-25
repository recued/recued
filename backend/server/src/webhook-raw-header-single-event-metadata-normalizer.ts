/** D-201 Slice 9S — exact raw-header single-event metadata composition.
 *
 * Trusted preset data maps three distinct lowercase HTTP header names to
 * delivery identity, event type, and unprojected structural evidence. Injected
 * closed parsers own each value grammar. There is no profile id, vendor branch,
 * regex input, callback in preset data, coercion, signature verification,
 * deduplication, or durable projection here.
 */

export interface WebhookRawHeaderSingleEventMetadataNormalizerPreset {
  readonly kind: 'raw_header_single_event_metadata.v1';
  readonly delivery_id_header: string;
  readonly event_type_header: string;
  readonly structural_evidence_header: string;
}

export interface WebhookStringMetadataParser {
  parse(value: unknown): string | null;
}

export interface WebhookRawHeaderSingleEventMetadataNormalizerDependencies {
  readonly delivery_id_parser: WebhookStringMetadataParser;
  readonly event_type_parser: WebhookStringMetadataParser;
  readonly structural_evidence_parser: WebhookStringMetadataParser;
}

export interface WebhookNormalizedRawHeaderSingleEventMetadata {
  readonly delivery_id: string;
  readonly event_type: string;
  readonly structural_evidence: string;
}

export interface WebhookRawHeaderSingleEventMetadataNormalizer {
  readonly preset: WebhookRawHeaderSingleEventMetadataNormalizerPreset;
  normalize(
    headers: ReadonlyMap<string, readonly string[]>,
  ): WebhookNormalizedRawHeaderSingleEventMetadata | null;
}

const MAX_HEADER_NAME_CHARACTERS = 128;
const LOWERCASE_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const PRESET_KEYS = new Set([
  'kind',
  'delivery_id_header',
  'event_type_header',
  'structural_evidence_header',
]);

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

const validHeaderName = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length >= 1
  && value.length <= MAX_HEADER_NAME_CHARACTERS
  && LOWERCASE_HEADER_NAME_RE.test(value);

export const compileWebhookRawHeaderSingleEventMetadataNormalizerPreset = (
  input: WebhookRawHeaderSingleEventMetadataNormalizerPreset,
): WebhookRawHeaderSingleEventMetadataNormalizerPreset => {
  const fields = exactDataValues(input);
  const headerNames = fields === null ? [] : [
    fields.delivery_id_header,
    fields.event_type_header,
    fields.structural_evidence_header,
  ];
  if (fields === null
    || fields.kind !== 'raw_header_single_event_metadata.v1'
    || headerNames.some((name) => !validHeaderName(name))
    || new Set(headerNames).size !== headerNames.length) {
    throw new Error(
      'webhook raw-header single-event metadata normalizer: invalid trusted preset',
    );
  }
  return Object.freeze({
    kind: fields.kind,
    delivery_id_header: fields.delivery_id_header as string,
    event_type_header: fields.event_type_header as string,
    structural_evidence_header: fields.structural_evidence_header as string,
  });
};

const exactHeaderValue = (
  headers: ReadonlyMap<string, readonly string[]>,
  name: string,
): string | null => {
  const values = headers.get(name);
  return values?.length === 1 && typeof values[0] === 'string'
    ? values[0]
    : null;
};

export const createWebhookRawHeaderSingleEventMetadataNormalizer = (
  input: WebhookRawHeaderSingleEventMetadataNormalizerPreset,
  dependencies: WebhookRawHeaderSingleEventMetadataNormalizerDependencies,
): WebhookRawHeaderSingleEventMetadataNormalizer => {
  const preset = compileWebhookRawHeaderSingleEventMetadataNormalizerPreset(
    input,
  );
  return Object.freeze({
    preset,
    normalize(
      headers: ReadonlyMap<string, readonly string[]>,
    ): WebhookNormalizedRawHeaderSingleEventMetadata | null {
      const rawDeliveryId = exactHeaderValue(
        headers,
        preset.delivery_id_header,
      );
      const rawEventType = exactHeaderValue(headers, preset.event_type_header);
      const rawStructuralEvidence = exactHeaderValue(
        headers,
        preset.structural_evidence_header,
      );
      if (rawDeliveryId === null
        || rawEventType === null
        || rawStructuralEvidence === null) {
        return null;
      }
      const deliveryId = dependencies.delivery_id_parser.parse(rawDeliveryId);
      const eventType = dependencies.event_type_parser.parse(rawEventType);
      const structuralEvidence = dependencies.structural_evidence_parser.parse(
        rawStructuralEvidence,
      );
      return deliveryId === null
        || eventType === null
        || structuralEvidence === null
        ? null
        : Object.freeze({
            delivery_id: deliveryId,
            event_type: eventType,
            structural_evidence: structuralEvidence,
          });
    },
  });
};
