/** Provider envelopes are normally kilobytes. Keep enough headroom for large
 *  contracted outputs and embedding vectors without allowing an upstream body
 *  to grow process memory without bound. */
export const LLM_PROVIDER_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;

export class LLMProviderResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`LLM provider response exceeded ${maxBytes} bytes`);
    this.name = 'LLMProviderResponseTooLargeError';
  }
}

const discardResponseBody = (response: Response): void => {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Best-effort connection release only.
  }
};

/** Incremental UTF-8 reader shared by chat, embeddings, and transcription. */
export const readBoundedProviderText = async (
  response: Response,
  maxBytes = LLM_PROVIDER_RESPONSE_MAX_BYTES,
): Promise<string> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('LLM provider response limit must be a positive safe integer');
  }

  const shaped = response as Response & {
    body?: ReadableStream<Uint8Array> | null;
    headers?: Headers;
    text?: () => Promise<string>;
    json?: () => Promise<unknown>;
  };
  const declaredRaw = typeof shaped.headers?.get === 'function'
    ? shaped.headers.get('content-length')
    : null;
  const declared = declaredRaw === null ? null : Number(declaredRaw);
  if (declared !== null && Number.isSafeInteger(declared) && declared > maxBytes) {
    discardResponseBody(response);
    throw new LLMProviderResponseTooLargeError(maxBytes);
  }

  // Preserve the injectable fetch seam's minimal Response-like test doubles.
  if (shaped.body === undefined) {
    let text: string;
    if (typeof shaped.text === 'function') {
      text = await shaped.text();
    } else if (typeof shaped.json === 'function') {
      const serialized = JSON.stringify(await shaped.json());
      if (serialized === undefined) {
        throw new TypeError('LLM provider response JSON is not serializable');
      }
      text = serialized;
    } else {
      throw new TypeError('LLM provider response body is not readable');
    }
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new LLMProviderResponseTooLargeError(maxBytes);
    }
    return text;
  }

  if (shaped.body === null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new LLMProviderResponseTooLargeError(maxBytes);
    }
    return text;
  }

  const reader = shaped.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LLMProviderResponseTooLargeError(maxBytes);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return parts.join('');
};

export const readBoundedProviderJson = async (
  response: Response,
  maxBytes = LLM_PROVIDER_RESPONSE_MAX_BYTES,
): Promise<unknown> =>
  JSON.parse(await readBoundedProviderText(response, maxBytes)) as unknown;
