/** D-201 Slice 9AF — neutral bounded registration JSON-response reader.
 *
 * This closed engine owns response-stream byte bounds, completion cleanup,
 * fatal UTF-8 decoding, and JSON parsing for managed-registration adapters.
 * Trusted preset data supplies only a hard-capped byte limit and a bounded
 * diagnostic label. There is no profile id, vendor branch, response schema,
 * callback supplied by an owner/pack, or provider request authority.
 */

import {
  WebhookRegistrationAdapterError,
} from './webhook-registration-runtime.js';

export interface WebhookRegistrationJsonResponseReaderPreset {
  readonly kind: 'bounded_json_response.v1';
  readonly max_bytes: number;
  readonly error_label: string;
}

export interface WebhookRegistrationPendingResponse {
  readonly response: Response;
  /** Trusted request-driver cleanup, normally the hard-timeout release. */
  finish(): void;
}

export interface WebhookRegistrationJsonResponseReader {
  readonly preset: WebhookRegistrationJsonResponseReaderPreset;
  readText(pending: WebhookRegistrationPendingResponse): Promise<string>;
  readJson(pending: WebhookRegistrationPendingResponse): Promise<unknown>;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_LABEL_CHARACTERS = 128;
const PRESET_KEYS = new Set(['kind', 'max_bytes', 'error_label']);

const exactOwnDataRecord = (
  value: unknown,
  keys: ReadonlySet<string>,
): value is Record<string, unknown> => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.size
      && ownKeys.every((key) => {
        if (typeof key !== 'string' || !keys.has(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined
          && descriptor.enumerable
          && 'value' in descriptor;
      });
  } catch {
    return false;
  }
};

const ownDataValue = (
  value: Record<string, unknown>,
  key: string,
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
    ? descriptor.value
    : undefined;
};

export const createWebhookRegistrationJsonResponseReader = (
  presetInput: WebhookRegistrationJsonResponseReaderPreset,
): WebhookRegistrationJsonResponseReader => {
  if (!exactOwnDataRecord(presetInput, PRESET_KEYS)) {
    throw new Error(
      'webhook registration JSON-response reader: invalid trusted preset',
    );
  }
  const kind = ownDataValue(presetInput, 'kind');
  const maxBytes = ownDataValue(presetInput, 'max_bytes');
  const errorLabel = ownDataValue(presetInput, 'error_label');
  if (kind !== 'bounded_json_response.v1'
    || !Number.isSafeInteger(maxBytes)
    || (maxBytes as number) < 1
    || (maxBytes as number) > MAX_RESPONSE_BYTES
    || typeof errorLabel !== 'string'
    || errorLabel.length < 1
    || errorLabel.length > MAX_ERROR_LABEL_CHARACTERS
    || !/^[\x20-\x7e]+$/.test(errorLabel)) {
    throw new Error(
      'webhook registration JSON-response reader: invalid trusted preset',
    );
  }
  const preset: WebhookRegistrationJsonResponseReaderPreset = Object.freeze({
    kind,
    max_bytes: maxBytes as number,
    error_label: errorLabel,
  });

  const readText = async (
    pending: WebhookRegistrationPendingResponse,
  ): Promise<string> => {
    const body = pending.response.body;
    if (body === null) {
      pending.finish();
      return '';
    }
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = body.getReader();
    } catch {
      pending.finish();
      throw new WebhookRegistrationAdapterError(
        'upstream_unavailable',
        `${preset.error_label} response did not complete`,
      );
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > preset.max_bytes) {
          void reader.cancel().catch(() => undefined);
          throw new WebhookRegistrationAdapterError(
            'upstream_response_too_large',
            `${preset.error_label} response exceeded the size limit`,
          );
        }
        chunks.push(next.value);
      }
    } catch (error) {
      if (error instanceof WebhookRegistrationAdapterError) throw error;
      throw new WebhookRegistrationAdapterError(
        'upstream_unavailable',
        `${preset.error_label} response did not complete`,
      );
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Timeout cleanup and the normalized read result remain authoritative.
      }
      pending.finish();
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    try {
      return new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        `${preset.error_label} returned invalid UTF-8`,
      );
    }
  };

  return Object.freeze({
    preset,
    readText,
    async readJson(
      pending: WebhookRegistrationPendingResponse,
    ): Promise<unknown> {
      const text = await readText(pending);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new WebhookRegistrationAdapterError(
          'upstream_response_invalid',
          `${preset.error_label} returned malformed JSON`,
        );
      }
    },
  });
};
