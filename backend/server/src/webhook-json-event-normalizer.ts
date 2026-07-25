/** D-201 Slices 8S-8T + 8Z + 9AS — closed JSON single-event field normalizer.
 *
 * A trusted preset maps bounded fields from one decoded JSON object into a
 * code-fixed normalized event record. The engine supports only top-level own
 * data fields, one optional resource fallback with at most two object segments,
 * one exact top-level string requirement, required id/time selections, one
 * closed provider-id grammar/disposition, one closed event-type grammar, two
 * timestamp units, and one optional conditional object requirement. It exposes
 * no JSONPath, arbitrary schema, callback, coercion, conditional callback, or
 * vendor-specific branch.
 */

import {
  createWebhookAsciiEventTypeParser,
  type WebhookAsciiEventTypeParser,
} from './webhook-ascii-event-type-parser.js';

export interface WebhookJsonConditionalObjectRequirementPreset {
  readonly when_event_type: string;
  readonly required_object_field: string;
}

export interface WebhookJsonExactStringRequirementPreset {
  readonly field: string;
  readonly value: string;
}

export interface WebhookJsonEventNormalizerPreset {
  readonly kind: 'json_single_event_fields.v1';
  readonly event_type_field: string;
  readonly event_type_grammar:
    'ascii_alphanumeric_dot_colon_slash_dash.v1';
  readonly event_type_max_bytes: number;
  readonly event_id_field: string;
  readonly event_id_max_bytes: number;
  readonly event_id_required: boolean;
  readonly provider_id_grammar:
    | 'trimmed_utf8.v1'
    | 'control_free_trimmed_utf8.v1';
  readonly resource_id_field: string | null;
  readonly resource_fallback_object_field: string | null;
  readonly resource_fallback_nested_object_field: string | null;
  readonly resource_fallback_id_field: string | null;
  readonly resource_id_max_bytes: number;
  readonly resource_id_required: boolean;
  readonly invalid_resource_id_disposition:
    | 'reject.v1'
    | 'treat_as_absent.v1';
  readonly occurred_at_field: string;
  readonly occurred_at_unit: 'unix_seconds.v1' | 'unix_milliseconds.v1';
  readonly occurred_at_required: boolean;
  readonly challenge_field: string | null;
  readonly challenge_max_bytes: number | null;
  readonly conditional_object_requirement:
    WebhookJsonConditionalObjectRequirementPreset | null;
  readonly exact_string_requirement:
    WebhookJsonExactStringRequirementPreset | null;
}

export interface WebhookNormalizedJsonEvent {
  readonly event_type: string;
  readonly event_id: string | null;
  readonly resource_id: string | null;
  readonly occurred_at: number | null;
  readonly challenge: string | null;
  readonly payload: Record<string, unknown>;
}

export interface WebhookJsonEventNormalizer {
  readonly preset: WebhookJsonEventNormalizerPreset;
  normalize(envelope: unknown): WebhookNormalizedJsonEvent | null;
}

const MAX_FIELD_BYTES = 128;
const MAX_EVENT_TYPE_BYTES = 128;
const MAX_PROVIDER_ID_BYTES = 512;
const MAX_CHALLENGE_BYTES = 65_536;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const PRESET_KEYS = new Set([
  'kind',
  'event_type_field',
  'event_type_grammar',
  'event_type_max_bytes',
  'event_id_field',
  'event_id_max_bytes',
  'event_id_required',
  'provider_id_grammar',
  'resource_id_field',
  'resource_fallback_object_field',
  'resource_fallback_nested_object_field',
  'resource_fallback_id_field',
  'resource_id_max_bytes',
  'resource_id_required',
  'invalid_resource_id_disposition',
  'occurred_at_field',
  'occurred_at_unit',
  'occurred_at_required',
  'challenge_field',
  'challenge_max_bytes',
  'conditional_object_requirement',
  'exact_string_requirement',
]);
const CONDITIONAL_OBJECT_KEYS = new Set([
  'when_event_type',
  'required_object_field',
]);
const EXACT_STRING_REQUIREMENT_KEYS = new Set([
  'field',
  'value',
]);
const ABSENT = Symbol('absent JSON event field');
const INVALID = Symbol('invalid JSON event field');
const UNSAFE = Symbol('unsafe JSON event field');

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

const validLimit = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value)
  && (value as number) >= 1
  && (value as number) <= maximum;

const boundedNonBlankString = (
  value: unknown,
  maxBytes: number,
): value is string => typeof value === 'string'
  && value.length > 0
  && value.trim() === value
  && !CONTROL_CHARACTER_RE.test(value)
  && Buffer.byteLength(value, 'utf8') <= maxBytes;

const boundedProviderId = (
  value: unknown,
  maxBytes: number,
  grammar: WebhookJsonEventNormalizerPreset['provider_id_grammar'],
): value is string => typeof value === 'string'
  && value.length > 0
  && value.trim() === value
  && Buffer.byteLength(value, 'utf8') <= maxBytes
  && (grammar === 'trimmed_utf8.v1'
    || !CONTROL_CHARACTER_RE.test(value));

const validatePreset = (
  value: WebhookJsonEventNormalizerPreset,
): WebhookAsciiEventTypeParser => {
  if (!exactDataRecord(value, PRESET_KEYS)
    || value.kind !== 'json_single_event_fields.v1'
    || value.event_type_grammar
      !== 'ascii_alphanumeric_dot_colon_slash_dash.v1'
    || !validLimit(value.event_type_max_bytes, MAX_EVENT_TYPE_BYTES)
    || !validLimit(value.event_id_max_bytes, MAX_PROVIDER_ID_BYTES)
    || !validLimit(value.resource_id_max_bytes, MAX_PROVIDER_ID_BYTES)
    || typeof value.event_id_required !== 'boolean'
    || typeof value.resource_id_required !== 'boolean'
    || typeof value.occurred_at_required !== 'boolean'
    || (value.provider_id_grammar !== 'trimmed_utf8.v1'
      && value.provider_id_grammar !== 'control_free_trimmed_utf8.v1')
    || (value.invalid_resource_id_disposition !== 'reject.v1'
      && value.invalid_resource_id_disposition !== 'treat_as_absent.v1')
    || (value.occurred_at_unit !== 'unix_seconds.v1'
      && value.occurred_at_unit !== 'unix_milliseconds.v1')) {
    throw new Error('webhook JSON event normalizer: invalid trusted preset');
  }
  const eventTypeParser = createWebhookAsciiEventTypeParser({
    kind: value.event_type_grammar,
    max_bytes: value.event_type_max_bytes,
  });
  const requiredTopLevelFields = [
    value.event_type_field,
    value.event_id_field,
    value.occurred_at_field,
  ];
  const conditional = value.conditional_object_requirement;
  if (conditional !== null
    && (!exactDataRecord(conditional, CONDITIONAL_OBJECT_KEYS)
      || eventTypeParser.parse(conditional.when_event_type) === null
      || !validField(conditional.required_object_field))) {
    throw new Error('webhook JSON event normalizer: invalid trusted preset');
  }
  const exactString = value.exact_string_requirement;
  if (exactString !== null
    && (!exactDataRecord(
      exactString,
      EXACT_STRING_REQUIREMENT_KEYS,
    )
      || !validField(exactString.field)
      || !boundedNonBlankString(exactString.value, MAX_EVENT_TYPE_BYTES))) {
    throw new Error('webhook JSON event normalizer: invalid trusted preset');
  }
  const optionalTopLevelFields = [
    value.resource_id_field,
    value.resource_fallback_object_field,
    value.challenge_field,
    conditional?.required_object_field ?? null,
    exactString?.field ?? null,
  ].filter((field): field is string => field !== null);
  if (requiredTopLevelFields.some((field) => !validField(field))
    || optionalTopLevelFields.some((field) => !validField(field))
    || new Set([...requiredTopLevelFields, ...optionalTopLevelFields]).size
      !== requiredTopLevelFields.length + optionalTopLevelFields.length
    || ((value.resource_fallback_object_field === null)
      !== (value.resource_fallback_id_field === null))
    || (value.resource_fallback_nested_object_field !== null
      && value.resource_fallback_object_field === null)
    || (value.resource_fallback_nested_object_field !== null
      && !validField(value.resource_fallback_nested_object_field))
    || (value.resource_fallback_id_field !== null
      && !validField(value.resource_fallback_id_field))
    || (value.resource_id_required
      && value.resource_id_field === null
      && value.resource_fallback_object_field === null)
    || ((value.challenge_field === null)
      !== (value.challenge_max_bytes === null))
    || (value.challenge_max_bytes !== null
      && !validLimit(value.challenge_max_bytes, MAX_CHALLENGE_BYTES))) {
    throw new Error('webhook JSON event normalizer: invalid trusted preset');
  }
  return eventTypeParser;
};

const ownDataValue = (
  record: Record<string, unknown>,
  field: string,
): unknown | typeof ABSENT | typeof UNSAFE => {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (descriptor === undefined) return ABSENT;
  return descriptor.enumerable && 'value' in descriptor
    ? descriptor.value
    : UNSAFE;
};

const optionalString = (
  value: unknown | typeof ABSENT | typeof UNSAFE,
  maxBytes: number,
): string | null | typeof INVALID => {
  if (value === ABSENT || value === undefined || value === null) return null;
  return value === UNSAFE || !boundedNonBlankString(value, maxBytes)
    ? INVALID
    : value;
};

const optionalProviderId = (
  value: unknown | typeof ABSENT | typeof UNSAFE,
  maxBytes: number,
  grammar: WebhookJsonEventNormalizerPreset['provider_id_grammar'],
): string | null | typeof INVALID | typeof UNSAFE => {
  if (value === ABSENT || value === undefined || value === null) return null;
  if (value === UNSAFE) return UNSAFE;
  return !boundedProviderId(value, maxBytes, grammar) ? INVALID : value;
};

const optionalOccurredAt = (
  value: unknown | typeof ABSENT | typeof UNSAFE,
  unit: WebhookJsonEventNormalizerPreset['occurred_at_unit'],
): number | null | typeof INVALID => {
  if (value === ABSENT || value === undefined || value === null) return null;
  if (value === UNSAFE
    || !Number.isSafeInteger(value)
    || (value as number) < 0) {
    return INVALID;
  }
  if (unit === 'unix_seconds.v1'
    && (value as number) > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    return INVALID;
  }
  return value as number;
};

const fallbackResourceId = (
  envelope: Record<string, unknown>,
  preset: WebhookJsonEventNormalizerPreset,
): string | null | typeof INVALID | typeof UNSAFE => {
  if (preset.resource_fallback_object_field === null
    || preset.resource_fallback_id_field === null) {
    return null;
  }
  const container = ownDataValue(
    envelope,
    preset.resource_fallback_object_field,
  );
  if (container === UNSAFE) return UNSAFE;
  if (container === ABSENT
    || container === undefined
    || container === null
    || typeof container !== 'object'
    || Array.isArray(container)) {
    return null;
  }
  if (!isPlainRecord(container)) return UNSAFE;
  let resourceContainer = container;
  if (preset.resource_fallback_nested_object_field !== null) {
    const nestedContainer = ownDataValue(
      resourceContainer,
      preset.resource_fallback_nested_object_field,
    );
    if (nestedContainer === UNSAFE) return UNSAFE;
    if (nestedContainer === ABSENT
      || nestedContainer === undefined
      || nestedContainer === null
      || typeof nestedContainer !== 'object'
      || Array.isArray(nestedContainer)) {
      return null;
    }
    if (!isPlainRecord(nestedContainer)) return UNSAFE;
    resourceContainer = nestedContainer;
  }
  return optionalProviderId(
    ownDataValue(resourceContainer, preset.resource_fallback_id_field),
    preset.resource_id_max_bytes,
    preset.provider_id_grammar,
  );
};

export const createWebhookJsonEventNormalizer = (
  input: WebhookJsonEventNormalizerPreset,
): WebhookJsonEventNormalizer => {
  const eventTypeParser = validatePreset(input);
  const conditional_object_requirement =
    input.conditional_object_requirement === null
      ? null
      : Object.freeze({ ...input.conditional_object_requirement });
  const exact_string_requirement = input.exact_string_requirement === null
    ? null
    : Object.freeze({ ...input.exact_string_requirement });
  const preset = Object.freeze({
    ...input,
    conditional_object_requirement,
    exact_string_requirement,
  });

  return Object.freeze({
    preset,
    normalize(envelope: unknown): WebhookNormalizedJsonEvent | null {
      try {
        if (!isPlainRecord(envelope)) return null;
        const exactString = preset.exact_string_requirement;
        if (exactString !== null
          && ownDataValue(envelope, exactString.field) !== exactString.value) {
          return null;
        }
        const eventType = eventTypeParser.parse(
          ownDataValue(envelope, preset.event_type_field),
        );
        if (eventType === null) return null;
        const conditional = preset.conditional_object_requirement;
        if (conditional !== null
          && eventType === conditional.when_event_type) {
          const requiredObject = ownDataValue(
            envelope,
            conditional.required_object_field,
          );
          if (requiredObject === ABSENT
            || requiredObject === UNSAFE
            || !isPlainRecord(requiredObject)) {
            return null;
          }
        }
        const eventId = optionalProviderId(
          ownDataValue(envelope, preset.event_id_field),
          preset.event_id_max_bytes,
          preset.provider_id_grammar,
        );
        const directResourceId = preset.resource_id_field === null
          ? null
          : optionalProviderId(
              ownDataValue(envelope, preset.resource_id_field),
              preset.resource_id_max_bytes,
              preset.provider_id_grammar,
            );
        const nestedResourceId = fallbackResourceId(envelope, preset);
        const occurredAt = optionalOccurredAt(
          ownDataValue(envelope, preset.occurred_at_field),
          preset.occurred_at_unit,
        );
        const challenge = preset.challenge_field === null
          || preset.challenge_max_bytes === null
          ? null
          : optionalString(
              ownDataValue(envelope, preset.challenge_field),
              preset.challenge_max_bytes,
            );
        if (eventId === INVALID
          || eventId === UNSAFE
          || occurredAt === INVALID
          || challenge === INVALID
          || directResourceId === UNSAFE
          || nestedResourceId === UNSAFE
          || (preset.invalid_resource_id_disposition === 'reject.v1'
            && (directResourceId === INVALID
              || nestedResourceId === INVALID))) {
          return null;
        }
        const admittedDirectResourceId = directResourceId === INVALID
          ? null
          : directResourceId;
        const admittedNestedResourceId = nestedResourceId === INVALID
          ? null
          : nestedResourceId;
        if ((preset.event_id_required && eventId === null)
          || (preset.resource_id_required
            && admittedDirectResourceId === null
            && admittedNestedResourceId === null)
          || (preset.occurred_at_required && occurredAt === null)
          || (admittedDirectResourceId !== null
            && admittedNestedResourceId !== null
            && admittedDirectResourceId !== admittedNestedResourceId)) {
          return null;
        }
        return Object.freeze({
          event_type: eventType,
          event_id: eventId,
          resource_id: admittedDirectResourceId ?? admittedNestedResourceId,
          occurred_at: occurredAt,
          challenge,
          payload: envelope,
        });
      } catch {
        return null;
      }
    },
  });
};
