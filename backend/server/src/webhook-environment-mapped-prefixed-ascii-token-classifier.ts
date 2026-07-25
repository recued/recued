/** D-201 Slice 9BB — closed environment-mapped prefixed ASCII-token classifier.
 *
 * Trusted preset data selects a bounded, prefix-free list of literal ASCII
 * prefixes, maps each to test or live, and selects one total byte ceiling.
 * Runtime values delegate to the existing closed prefixed ASCII-token parser.
 * There is no regex input, callback, coercion, field name, profile id, vendor
 * branch, credential source, auth transport, or outbound authority in preset
 * data.
 */

import {
  createWebhookPrefixedAsciiTokenParser,
  type WebhookPrefixedAsciiTokenParser,
} from './webhook-prefixed-ascii-token-parser.js';

export type WebhookMappedTokenEnvironment = 'test' | 'live';

export interface WebhookEnvironmentMappedTokenPrefix {
  readonly prefix: string;
  readonly environment: WebhookMappedTokenEnvironment;
}

export interface WebhookEnvironmentMappedPrefixedAsciiTokenClassifierPreset {
  readonly kind: 'environment_mapped_prefixed_ascii_token.v1';
  readonly max_bytes: number;
  readonly mappings: readonly WebhookEnvironmentMappedTokenPrefix[];
}

export interface WebhookEnvironmentMappedAsciiToken {
  readonly value: string;
  readonly environment: WebhookMappedTokenEnvironment;
}

export interface WebhookEnvironmentMappedPrefixedAsciiTokenClassifier {
  readonly preset: WebhookEnvironmentMappedPrefixedAsciiTokenClassifierPreset;
  classify(value: unknown): WebhookEnvironmentMappedAsciiToken | null;
}

const MAX_MAPPINGS = 32;
const MAX_TOKEN_BYTES = 65_536;
const PRESET_KEYS = new Set(['kind', 'max_bytes', 'mappings']);
const MAPPING_KEYS = new Set(['prefix', 'environment']);
const ARRAY_INDEX_RE = /^(0|[1-9][0-9]*)$/;

const exactDataValues = (
  value: unknown,
  keys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    const ownKeys = Reflect.ownKeys(value);
    if ((prototype !== Object.prototype && prototype !== null)
      || ownKeys.length !== keys.size
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

interface CompiledMapping {
  readonly environment: WebhookMappedTokenEnvironment;
  readonly parser: WebhookPrefixedAsciiTokenParser;
}

const copyMappings = (
  value: unknown,
  maxBytes: number,
): {
  readonly mappings: readonly WebhookEnvironmentMappedTokenPrefix[];
  readonly compiled: readonly CompiledMapping[];
} | null => {
  try {
    if (!Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype) {
      return null;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined
      || !('value' in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 1
      || lengthDescriptor.value > MAX_MAPPINGS) {
      return null;
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1
      || keys.some((key) => key !== 'length'
        && (typeof key !== 'string'
          || !ARRAY_INDEX_RE.test(key)
          || Number(key) >= length))) {
      return null;
    }
    const mappings: WebhookEnvironmentMappedTokenPrefix[] = [];
    const compiled: CompiledMapping[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)) {
        return null;
      }
      const fields = exactDataValues(descriptor.value, MAPPING_KEYS);
      if (fields === null
        || typeof fields.prefix !== 'string'
        || (fields.environment !== 'test' && fields.environment !== 'live')) {
        return null;
      }
      const parser = createWebhookPrefixedAsciiTokenParser({
        kind: 'prefixed_ascii_token.v1',
        prefix: fields.prefix,
        max_bytes: maxBytes,
      });
      if (mappings.some((mapping) =>
        mapping.prefix.startsWith(parser.preset.prefix)
        || parser.preset.prefix.startsWith(mapping.prefix))) {
        return null;
      }
      mappings.push(Object.freeze({
        prefix: parser.preset.prefix,
        environment: fields.environment,
      }));
      compiled.push(Object.freeze({
        environment: fields.environment,
        parser,
      }));
    }
    return Object.freeze({
      mappings: Object.freeze(mappings),
      compiled: Object.freeze(compiled),
    });
  } catch {
    return null;
  }
};

export const createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier = (
  input: WebhookEnvironmentMappedPrefixedAsciiTokenClassifierPreset,
): WebhookEnvironmentMappedPrefixedAsciiTokenClassifier => {
  const fields = exactDataValues(input, PRESET_KEYS);
  if (fields === null
    || fields.kind !== 'environment_mapped_prefixed_ascii_token.v1'
    || !Number.isSafeInteger(fields.max_bytes)
    || (fields.max_bytes as number) < 1
    || (fields.max_bytes as number) > MAX_TOKEN_BYTES) {
    throw new Error(
      'webhook environment-mapped prefixed ASCII-token classifier: invalid trusted preset',
    );
  }
  const copied = copyMappings(fields.mappings, fields.max_bytes as number);
  if (copied === null) {
    throw new Error(
      'webhook environment-mapped prefixed ASCII-token classifier: invalid trusted preset',
    );
  }
  const preset: WebhookEnvironmentMappedPrefixedAsciiTokenClassifierPreset =
    Object.freeze({
      kind: fields.kind,
      max_bytes: fields.max_bytes as number,
      mappings: copied.mappings,
    });
  return Object.freeze({
    preset,
    classify(value: unknown): WebhookEnvironmentMappedAsciiToken | null {
      for (const mapping of copied.compiled) {
        const parsed = mapping.parser.parse(value);
        if (parsed !== null) {
          return Object.freeze({
            value: parsed,
            environment: mapping.environment,
          });
        }
      }
      return null;
    },
  });
};
