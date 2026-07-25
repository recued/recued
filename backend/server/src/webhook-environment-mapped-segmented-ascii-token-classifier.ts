/** D-201 Slice 9BD — closed environment-mapped segmented ASCII classifier.
 *
 * Trusted preset data selects a bounded, prefix-free environment mapping, one
 * literal separator, and one through eight fixed ASCII segment grammars.
 * Runtime values must be primitive strings matching one complete mapped shape.
 * There is no regex input, callback, coercion, field name, profile id, vendor
 * branch, credential source, auth transport, origin, or outbound authority in
 * preset data.
 */

import type {
  WebhookEnvironmentMappedAsciiToken,
  WebhookEnvironmentMappedTokenPrefix,
} from './webhook-environment-mapped-prefixed-ascii-token-classifier.js';

export type WebhookSegmentedAsciiAlphabet =
  | 'lowercase_alphanumeric'
  | 'ascii_alphanumeric';

export interface WebhookSegmentedAsciiTokenSegment {
  readonly length: number;
  readonly alphabet: WebhookSegmentedAsciiAlphabet;
}

export interface WebhookEnvironmentMappedSegmentedAsciiTokenClassifierPreset {
  readonly kind: 'environment_mapped_segmented_ascii_token.v1';
  readonly separator: '_' | '-';
  readonly segments: readonly WebhookSegmentedAsciiTokenSegment[];
  readonly mappings: readonly WebhookEnvironmentMappedTokenPrefix[];
}

export interface WebhookEnvironmentMappedSegmentedAsciiTokenClassifier {
  readonly preset: WebhookEnvironmentMappedSegmentedAsciiTokenClassifierPreset;
  classify(value: unknown): WebhookEnvironmentMappedAsciiToken | null;
}

const MAX_MAPPINGS = 32;
const MAX_PREFIX_BYTES = 64;
const MAX_SEGMENTS = 8;
const MAX_SEGMENT_BYTES = 128;
const MAX_TOKEN_BYTES = 65_536;
const PRESET_KEYS = new Set(['kind', 'separator', 'segments', 'mappings']);
const SEGMENT_KEYS = new Set(['length', 'alphabet']);
const MAPPING_KEYS = new Set(['prefix', 'environment']);
const ARRAY_INDEX_RE = /^(0|[1-9][0-9]*)$/;
const ASCII_PREFIX_RE = /^[A-Za-z0-9_-]+$/;
const LOWERCASE_ALPHANUMERIC_RE = /^[a-z0-9]+$/;
const ASCII_ALPHANUMERIC_RE = /^[A-Za-z0-9]+$/;

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

const denseOwnDataValues = (
  value: unknown,
  maxLength: number,
): readonly unknown[] | null => {
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
      || lengthDescriptor.value > maxLength) {
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
    const copied: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)) {
        return null;
      }
      copied.push(descriptor.value);
    }
    return copied;
  } catch {
    return null;
  }
};

const copySegments = (
  value: unknown,
): readonly WebhookSegmentedAsciiTokenSegment[] | null => {
  const entries = denseOwnDataValues(value, MAX_SEGMENTS);
  if (entries === null) return null;
  const segments: WebhookSegmentedAsciiTokenSegment[] = [];
  for (const entry of entries) {
    const fields = exactDataValues(entry, SEGMENT_KEYS);
    if (fields === null
      || !Number.isSafeInteger(fields.length)
      || (fields.length as number) < 1
      || (fields.length as number) > MAX_SEGMENT_BYTES
      || (fields.alphabet !== 'lowercase_alphanumeric'
        && fields.alphabet !== 'ascii_alphanumeric')) {
      return null;
    }
    segments.push(Object.freeze({
      length: fields.length as number,
      alphabet: fields.alphabet,
    }));
  }
  return Object.freeze(segments);
};

interface CompiledMapping {
  readonly prefix: string;
  readonly environment: 'test' | 'live';
  readonly tokenLength: number;
}

const copyMappings = (
  value: unknown,
  segments: readonly WebhookSegmentedAsciiTokenSegment[],
  separator: '_' | '-',
): {
  readonly mappings: readonly WebhookEnvironmentMappedTokenPrefix[];
  readonly compiled: readonly CompiledMapping[];
} | null => {
  const entries = denseOwnDataValues(value, MAX_MAPPINGS);
  if (entries === null) return null;
  const mappings: WebhookEnvironmentMappedTokenPrefix[] = [];
  const compiled: CompiledMapping[] = [];
  const segmentBytes = segments.reduce(
    (total, segment) => total + segment.length,
    0,
  ) + ((segments.length - 1) * separator.length);
  for (const entry of entries) {
    const fields = exactDataValues(entry, MAPPING_KEYS);
    if (fields === null
      || typeof fields.prefix !== 'string'
      || fields.prefix.length > MAX_PREFIX_BYTES
      || !ASCII_PREFIX_RE.test(fields.prefix)
      || (fields.environment !== 'test' && fields.environment !== 'live')
      || mappings.some((mapping) =>
        mapping.prefix.startsWith(fields.prefix as string)
        || (fields.prefix as string).startsWith(mapping.prefix))) {
      return null;
    }
    const tokenLength = fields.prefix.length + segmentBytes;
    if (tokenLength > MAX_TOKEN_BYTES) return null;
    const mapping = Object.freeze({
      prefix: fields.prefix,
      environment: fields.environment,
    });
    mappings.push(mapping);
    compiled.push(Object.freeze({ ...mapping, tokenLength }));
  }
  return Object.freeze({
    mappings: Object.freeze(mappings),
    compiled: Object.freeze(compiled),
  });
};

const segmentMatches = (
  value: string,
  segment: WebhookSegmentedAsciiTokenSegment,
): boolean => value.length === segment.length
  && (segment.alphabet === 'lowercase_alphanumeric'
    ? LOWERCASE_ALPHANUMERIC_RE.test(value)
    : ASCII_ALPHANUMERIC_RE.test(value));

export const createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier = (
  input: WebhookEnvironmentMappedSegmentedAsciiTokenClassifierPreset,
): WebhookEnvironmentMappedSegmentedAsciiTokenClassifier => {
  const fields = exactDataValues(input, PRESET_KEYS);
  const segments = fields === null ? null : copySegments(fields.segments);
  if (fields === null
    || fields.kind !== 'environment_mapped_segmented_ascii_token.v1'
    || (fields.separator !== '_' && fields.separator !== '-')
    || segments === null) {
    throw new Error(
      'webhook environment-mapped segmented ASCII-token classifier: invalid trusted preset',
    );
  }
  const copied = copyMappings(fields.mappings, segments, fields.separator);
  if (copied === null) {
    throw new Error(
      'webhook environment-mapped segmented ASCII-token classifier: invalid trusted preset',
    );
  }
  const preset: WebhookEnvironmentMappedSegmentedAsciiTokenClassifierPreset =
    Object.freeze({
      kind: fields.kind,
      separator: fields.separator,
      segments,
      mappings: copied.mappings,
    });
  return Object.freeze({
    preset,
    classify(value: unknown): WebhookEnvironmentMappedAsciiToken | null {
      if (typeof value !== 'string') return null;
      for (const mapping of copied.compiled) {
        if (value.length !== mapping.tokenLength
          || !value.startsWith(mapping.prefix)) {
          continue;
        }
        const values = value.slice(mapping.prefix.length).split(preset.separator);
        if (values.length === preset.segments.length
          && values.every((entry, index) =>
            segmentMatches(entry, preset.segments[index]!))) {
          return Object.freeze({
            value,
            environment: mapping.environment,
          });
        }
      }
      return null;
    },
  });
};
