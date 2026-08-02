import {
  discardResponseBody,
  readBoundedResponseText,
} from '@recued/ingredients';

import type { FileFetch, FileFetchResponse } from './index.js';

export const FILE_SOURCE_API_TIMEOUT_MS = 30_000;
export const FILE_SOURCE_API_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_SAME_ORIGIN_REDIRECTS = 5;

export interface FileSourceApiResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface FileSourceApiRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FileSourceApiFetchOptions {
  /** Box event cursors exceed Number.MAX_SAFE_INTEGER and must remain raw text. */
  responseMode?: 'json' | 'text';
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

const bodyOfTestDouble = async (
  response: FileFetchResponse,
  mode: 'json' | 'text',
  maxBytes: number,
): Promise<{ text: string; jsonValue?: unknown }> => {
  if (mode === 'json' && response.ok) {
    const jsonValue = await response.json();
    const text = JSON.stringify(jsonValue);
    if (text === undefined) throw new TypeError('file-source API returned non-serializable JSON');
    if (byteLength(text) > maxBytes) {
      throw new Error(`file-source API response exceeded ${maxBytes}-byte limit`);
    }
    return { text, jsonValue };
  }
  const text = await response.text();
  if (byteLength(text) > maxBytes) {
    throw new Error(`file-source API response exceeded ${maxBytes}-byte limit`);
  }
  return { text };
};

/**
 * Bounded JSON/text request for authenticated file-provider control APIs.
 *
 * A single deadline spans redirects, headers, and body consumption. Redirects
 * remain on the authored origin so a provider/open redirect cannot forward a
 * bearer token. Native responses stream under a byte ceiling; body-less narrow
 * test doubles retain their existing json/text seams with a post-read cap.
 */
export const fetchFileSourceApi = async (
  fetchImpl: FileFetch,
  url: string,
  init: FileSourceApiRequestInit,
  options: FileSourceApiFetchOptions = {},
): Promise<FileSourceApiResponse> => {
  const timeoutMs = options.timeoutMs ?? FILE_SOURCE_API_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? FILE_SOURCE_API_RESPONSE_MAX_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('file-source API timeout must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('file-source API response limit must be a positive safe integer');
  }

  const pinnedOrigin = new URL(url).origin;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: FileFetchResponse | undefined;
  try {
    let currentUrl = url;
    let currentInit = init;
    for (let hop = 0; ; hop += 1) {
      response = await fetchImpl(currentUrl, {
        ...currentInit,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get('location');
      if (location === null || location === '') break;
      if (hop >= MAX_SAME_ORIGIN_REDIRECTS) {
        throw new Error(`file-source API exceeded ${MAX_SAME_ORIGIN_REDIRECTS} redirects`);
      }
      const next = new URL(location, currentUrl);
      if (next.origin !== pinnedOrigin) {
        throw new Error(
          `file-source API redirect refused '${pinnedOrigin}' → '${next.origin}'`,
        );
      }
      const redirectStatus = response.status;
      discardResponseBody(response as Response);
      response = undefined;
      currentUrl = next.toString();
      if (redirectStatus === 303) {
        currentInit = { ...currentInit, method: 'GET', body: undefined };
      }
    }

    const mode = options.responseMode ?? 'json';
    let body: { text: string; jsonValue?: unknown };
    if (response.body !== undefined) {
      const bounded = await readBoundedResponseText(response as Response, maxBytes);
      body = { text: bounded.text };
    } else {
      body = await bodyOfTestDouble(response, mode, maxBytes);
    }
    const text = body.text;
    return Object.freeze({
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      async text(): Promise<string> {
        return text;
      },
      async json(): Promise<unknown> {
        return Object.hasOwn(body, 'jsonValue')
          ? body.jsonValue
          : JSON.parse(text) as unknown;
      },
    });
  } finally {
    if (response !== undefined) discardResponseBody(response as Response);
    clearTimeout(timer);
  }
};
