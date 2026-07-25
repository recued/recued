/** D-201 Slice 8K — closed bounded JSON-object decoder engine.
 *
 * Profiles may select a trusted preset assembled by server code. The decoder
 * exposes no JSONPath, reviver, schema callback, prototype policy, or owner/
 * pack supplied limit. It accepts one exact UTF-8 JSON object and rejects
 * prototype-sensitive keys, non-finite numbers, and graphs beyond the preset's
 * hard-capped traversal bounds.
 */

export interface WebhookJsonObjectDecoderPreset {
  readonly kind: 'bounded_json_object.v1';
  readonly max_depth: number;
  readonly max_nodes: number;
  readonly max_array_items: number;
  readonly max_object_keys: number;
  readonly max_key_bytes: number;
}

export interface WebhookJsonObjectDecoder {
  readonly preset: WebhookJsonObjectDecoderPreset;
  decode(rawBody: Buffer): Record<string, unknown> | null;
}

const HARD_LIMITS = Object.freeze({
  max_depth: 32,
  max_nodes: 50_000,
  max_array_items: 10_000,
  max_object_keys: 10_000,
  max_key_bytes: 256,
});

export const WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET: WebhookJsonObjectDecoderPreset =
  Object.freeze({
    kind: 'bounded_json_object.v1',
    ...HARD_LIMITS,
  });

const PRESET_KEYS = new Set([
  'kind',
  'max_depth',
  'max_nodes',
  'max_array_items',
  'max_object_keys',
  'max_key_bytes',
]);

const PROTOTYPE_SENSITIVE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

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
  minimum = 1,
): value is number => Number.isSafeInteger(value)
  && (value as number) >= minimum
  && (value as number) <= maximum;

const validatePreset = (value: WebhookJsonObjectDecoderPreset): void => {
  if (!exactDataRecord(value, PRESET_KEYS)
    || value.kind !== 'bounded_json_object.v1'
    || !validLimit(value.max_depth, HARD_LIMITS.max_depth, 0)
    || !validLimit(value.max_nodes, HARD_LIMITS.max_nodes)
    || !validLimit(value.max_array_items, HARD_LIMITS.max_array_items)
    || !validLimit(value.max_object_keys, HARD_LIMITS.max_object_keys)
    || !validLimit(value.max_key_bytes, HARD_LIMITS.max_key_bytes)) {
    throw new Error('webhook JSON-object decoder: invalid trusted preset');
  }
};

const validJsonScalar = (value: unknown): boolean =>
  typeof value !== 'number' || Number.isFinite(value);

export const createWebhookJsonObjectDecoder = (
  input: WebhookJsonObjectDecoderPreset,
): WebhookJsonObjectDecoder => {
  validatePreset(input);
  const preset = Object.freeze({ ...input });

  return Object.freeze({
    preset,
    decode(rawBody: Buffer): Record<string, unknown> | null {
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(rawBody);
      } catch {
        return null;
      }
      if (decoded.charCodeAt(0) === 0xfeff) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(decoded) as unknown;
      } catch {
        return null;
      }
      if (!isPlainRecord(parsed)) return null;

      const stack: Array<{ value: object; depth: number }> = [{
        value: parsed,
        depth: 0,
      }];
      let nodes = 1;
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (nodes > preset.max_nodes || current.depth > preset.max_depth) return null;

        if (Array.isArray(current.value)) {
          if (current.value.length > preset.max_array_items) return null;
          for (const child of current.value) {
            nodes += 1;
            if (nodes > preset.max_nodes || !validJsonScalar(child)) return null;
            if (child !== null && typeof child === 'object') {
              stack.push({ value: child, depth: current.depth + 1 });
            }
          }
          continue;
        }

        if (Object.getPrototypeOf(current.value) !== Object.prototype) return null;
        const keys = Object.keys(current.value);
        if (keys.length > preset.max_object_keys) return null;
        for (const key of keys) {
          if (PROTOTYPE_SENSITIVE_KEYS.has(key)
            || Buffer.byteLength(key, 'utf8') > preset.max_key_bytes) {
            return null;
          }
          nodes += 1;
          if (nodes > preset.max_nodes) return null;
          const child = (current.value as Record<string, unknown>)[key];
          if (!validJsonScalar(child)) return null;
          if (child !== null && typeof child === 'object') {
            stack.push({ value: child, depth: current.depth + 1 });
          }
        }
      }
      return parsed;
    },
  });
};

export const WEBHOOK_JSON_OBJECT_DECODER_V1 = createWebhookJsonObjectDecoder(
  WEBHOOK_JSON_OBJECT_DECODER_V1_PRESET,
);
