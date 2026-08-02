import { CONNECTION_API_TIMEOUT_MS } from '@recued/contracts';
import {
  DEFAULT_RESPONSE_BODY_MAX_BYTES,
  discardResponseBody,
  fetchOriginPinned,
  readBoundedResponseText,
} from '@recued/ingredients';

export interface BoundedHttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type BoundedHttpFetcher = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<BoundedHttpResponse>;

export interface BoundedOriginHttpFetcherOptions {
  /** Resolved lazily from globalThis when omitted, preserving test/runtime injection. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Same-origin redirects are useful for provider reads. Credentialed control
   * writes with a canonical endpoint can refuse every redirect instead. */
  readonly redirectPolicy?: 'same-origin' | 'error';
}

/**
 * Narrow server fetcher for JSON/text provider APIs.
 *
 * Every call pins redirects to the authored endpoint origin, keeps one deadline
 * through headers and body streaming, eagerly reads under a hard byte ceiling,
 * and releases the native Response before returning a replayable narrow body.
 * Eager consumption also protects callers that inspect only `ok`/`status` and
 * would otherwise leave an error body and socket unread.
 */
export const makeBoundedOriginHttpFetcher = (
  options: BoundedOriginHttpFetcherOptions = {},
): BoundedHttpFetcher => {
  const timeoutMs = options.timeoutMs ?? CONNECTION_API_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_RESPONSE_BODY_MAX_BYTES;
  const redirectPolicy = options.redirectPolicy ?? 'same-origin';
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('bounded HTTP fetch timeout must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new TypeError('bounded HTTP response limit must be a positive safe integer');
  }

  return async (url, init) => {
    const origin = new URL(url).origin;
    const controller = new AbortController();
    const callerSignal = init?.signal;
    const abortFromCaller = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      const requestInit: RequestInit = {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
        signal: controller.signal,
      };
      response = redirectPolicy === 'error'
        ? await (options.fetchImpl ?? globalThis.fetch)(url, {
            ...requestInit,
            redirect: 'error',
          })
        : await fetchOriginPinned(
            options.fetchImpl ?? globalThis.fetch,
            url,
            requestInit,
            origin,
          );
      const { text } = await readBoundedResponseText(response, maxResponseBytes);
      return Object.freeze({
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: response.headers,
        async json(): Promise<unknown> {
          return JSON.parse(text) as unknown;
        },
        async text(): Promise<string> {
          return text;
        },
      });
    } finally {
      if (response !== undefined) discardResponseBody(response);
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  };
};

/**
 * `fetch`-shaped adapter for provider clients that consume status, headers,
 * json(), and text(). Request objects and non-string bodies fail closed because
 * replaying either safely across manual redirects requires buffering semantics
 * these JSON/XML control clients do not need.
 */
export const makeBoundedOriginApiFetch = (
  options: BoundedOriginHttpFetcherOptions = {},
): typeof fetch => {
  const bounded = makeBoundedOriginHttpFetcher(options);
  return (async (input, init) => {
    if (typeof input !== 'string' && !(input instanceof URL)) {
      throw new TypeError('bounded provider fetch requires a URL input');
    }
    if (init?.body !== undefined && typeof init.body !== 'string') {
      throw new TypeError('bounded provider fetch supports only string request bodies');
    }
    let headers: Record<string, string> | undefined;
    if (init?.headers !== undefined) {
      const copied: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        copied[name] = value;
      });
      headers = copied;
    }
    const response = await bounded(String(input), {
      ...(init?.method !== undefined ? { method: init.method } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      ...(init?.signal != null ? { signal: init.signal } : {}),
    });
    return response as unknown as Response;
  }) as typeof fetch;
};
