/** D-201 Slice 9A — closed JSON boolean environment admission.
 *
 * A trusted preset maps one required top-level boolean data field to two
 * portable webhook environments. The engine distinguishes a structurally
 * invalid selection from a valid delivery for another environment. It exposes
 * no JSONPath, coercion, callback, vendor branch, or profile dispatch.
 */

import type { WebhookEnvironment } from '@recued/contracts';

export interface WebhookJsonEnvironmentAdmissionPreset {
  readonly kind: 'json_boolean_environment_map.v1';
  readonly boolean_field: string;
  readonly false_environment: WebhookEnvironment;
  readonly true_environment: WebhookEnvironment;
}

export type WebhookJsonEnvironmentAdmissionClassification =
  | Readonly<{ kind: 'matched' }>
  | Readonly<{ kind: 'environment_mismatch' }>
  | Readonly<{ kind: 'invalid' }>;

export interface WebhookJsonEnvironmentAdmission {
  readonly preset: WebhookJsonEnvironmentAdmissionPreset;
  classify(
    envelope: unknown,
    expectedEnvironment: WebhookEnvironment,
  ): WebhookJsonEnvironmentAdmissionClassification;
}

const MAX_FIELD_BYTES = 128;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ENVIRONMENTS = new Set<WebhookEnvironment>(['test', 'live', 'custom']);
const PRESET_KEYS = new Set([
  'kind',
  'boolean_field',
  'false_environment',
  'true_environment',
]);
const MATCHED = Object.freeze({ kind: 'matched' } as const);
const ENVIRONMENT_MISMATCH = Object.freeze({
  kind: 'environment_mismatch',
} as const);
const INVALID = Object.freeze({ kind: 'invalid' } as const);

const validField = (value: unknown): value is string =>
  typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= MAX_FIELD_BYTES
  && FIELD_RE.test(value);

const validEnvironment = (value: unknown): value is WebhookEnvironment =>
  typeof value === 'string'
  && ENVIRONMENTS.has(value as WebhookEnvironment);

const exactDataValues = (
  value: unknown,
  keys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.size
      || ownKeys.some((key) => typeof key !== 'string' || !keys.has(key))) {
      return null;
    }
    const fields = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys) {
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

export const createWebhookJsonEnvironmentAdmission = (
  input: WebhookJsonEnvironmentAdmissionPreset,
): WebhookJsonEnvironmentAdmission => {
  const fields = exactDataValues(input, PRESET_KEYS);
  if (fields === null
    || fields.kind !== 'json_boolean_environment_map.v1'
    || !validField(fields.boolean_field)
    || !validEnvironment(fields.false_environment)
    || !validEnvironment(fields.true_environment)
    || fields.false_environment === fields.true_environment) {
    throw new Error('webhook JSON environment admission: invalid trusted preset');
  }
  const preset: WebhookJsonEnvironmentAdmissionPreset = Object.freeze({
    kind: fields.kind,
    boolean_field: fields.boolean_field,
    false_environment: fields.false_environment,
    true_environment: fields.true_environment,
  });

  return Object.freeze({
    preset,
    classify(
      envelope: unknown,
      expectedEnvironment: WebhookEnvironment,
    ): WebhookJsonEnvironmentAdmissionClassification {
      try {
        if (!validEnvironment(expectedEnvironment)
          || envelope === null
          || typeof envelope !== 'object'
          || Array.isArray(envelope)) {
          return INVALID;
        }
        const prototype = Object.getPrototypeOf(envelope);
        if (prototype !== Object.prototype && prototype !== null) return INVALID;
        const selected = Object.getOwnPropertyDescriptor(
          envelope,
          preset.boolean_field,
        );
        if (selected === undefined
          || !selected.enumerable
          || !('value' in selected)
          || typeof selected.value !== 'boolean') {
          return INVALID;
        }
        const observedEnvironment = selected.value
          ? preset.true_environment
          : preset.false_environment;
        return observedEnvironment === expectedEnvironment
          ? MATCHED
          : ENVIRONMENT_MISMATCH;
      } catch {
        return INVALID;
      }
    },
  });
};
