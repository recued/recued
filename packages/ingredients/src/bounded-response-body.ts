/**
 * Hard ceiling for ordinary provider/API response bodies.
 *
 * File downloads use their own explicitly larger capture ceiling. Ordinary
 * JSON/text responses should never be able to make the server buffer an
 * attacker-controlled amount of memory simply by omitting Content-Length.
 */
export const DEFAULT_RESPONSE_BODY_MAX_BYTES = 16 * 1024 * 1024;

/** Raised before parsing when an upstream response exceeds its byte budget. */
export class ResponseBodyTooLargeError extends Error {
  constructor(
    public readonly maxBytes: number,
    public readonly observedBytes?: number,
    public readonly declaredBytes?: number,
  ) {
    const size = declaredBytes !== undefined
      ? `declared ${declaredBytes}`
      : observedBytes !== undefined
        ? `reached ${observedBytes}`
        : `exceeded ${maxBytes}`;
    super(`response body ${size} bytes (limit ${maxBytes})`);
    this.name = 'ResponseBodyTooLargeError';
  }
}

const declaredContentLength = (response: Response): number | undefined => {
  // A few unit harnesses use deliberately tiny Response-shaped doubles. Real
  // fetch Responses always carry Headers; tolerate the doubles without making
  // the production path depend on their post-buffer fallback.
  const headers = (response as Response & { headers?: Headers }).headers;
  if (headers === undefined || typeof headers.get !== 'function') return undefined;
  const raw = headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

/** Release an unread response body without letting cleanup mask its error. */
export const discardResponseBody = (response: Response): void => {
  try {
    if (response.bodyUsed) return;
    const cancelled = response.body?.cancel();
    if (cancelled !== undefined) void cancelled.catch(() => undefined);
  } catch {
    // The primary status/size/parse result remains authoritative.
  }
};

const concatChunks = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const assertWithinLimit = (
  byteLength: number,
  maxBytes: number,
  declaredBytes?: number,
): void => {
  if (byteLength > maxBytes) {
    throw new ResponseBodyTooLargeError(maxBytes, byteLength, declaredBytes);
  }
};

/**
 * Read a fetch Response incrementally and stop once its hard byte ceiling is
 * crossed. Content-Length is only an early rejection: an omitted or dishonest
 * header is still bounded by the stream counter.
 *
 * The text/json fallbacks exist for legacy Response-shaped test doubles. The
 * shipped Node/browser fetch implementations expose `body.getReader()`, which
 * is the path that prevents an oversized body from being buffered first.
 */
export const readBoundedResponseBytes = async (
  response: Response,
  maxBytes = DEFAULT_RESPONSE_BODY_MAX_BYTES,
): Promise<Uint8Array> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('response body limit must be a positive safe integer');
  }

  const declaredBytes = declaredContentLength(response);
  if (declaredBytes !== undefined && declaredBytes > maxBytes) {
    discardResponseBody(response);
    throw new ResponseBodyTooLargeError(maxBytes, undefined, declaredBytes);
  }

  const body = (response as Response & {
    body?: ReadableStream<Uint8Array> | null;
  }).body;
  if (body !== undefined) {
    if (body === null) return new Uint8Array();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
          // Do not await cancellation: a hostile stream must not be able to
          // turn the size rejection itself into another unbounded wait.
          void reader.cancel().catch(() => undefined);
          throw new ResponseBodyTooLargeError(maxBytes, total, declaredBytes);
        }
        chunks.push(next.value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Cancellation/abort already owns stream cleanup.
      }
    }
    return concatChunks(chunks, total);
  }

  const shaped = response as Response & {
    text?: () => Promise<string>;
    json?: () => Promise<unknown>;
  };
  if (typeof shaped.text === 'function') {
    const bytes = new TextEncoder().encode(await shaped.text());
    assertWithinLimit(bytes.byteLength, maxBytes, declaredBytes);
    return bytes;
  }
  if (typeof shaped.json === 'function') {
    const serialized = JSON.stringify(await shaped.json());
    if (serialized === undefined) {
      throw new TypeError('response body did not contain serializable JSON');
    }
    const bytes = new TextEncoder().encode(serialized);
    assertWithinLimit(bytes.byteLength, maxBytes, declaredBytes);
    return bytes;
  }
  throw new TypeError('response body is not readable');
};

export interface BoundedResponseText {
  readonly text: string;
  readonly byteLength: number;
}

export const readBoundedResponseText = async (
  response: Response,
  maxBytes = DEFAULT_RESPONSE_BODY_MAX_BYTES,
): Promise<BoundedResponseText> => {
  const bytes = await readBoundedResponseBytes(response, maxBytes);
  return {
    text: new TextDecoder().decode(bytes),
    byteLength: bytes.byteLength,
  };
};
