import { walkPath } from '@recued/contracts';
import { IngredientError, type ResolvedCall } from './types.js';
import { resolveTimeoutMs, isWriteRiskTier } from './timeout.js';
import { assertUrlSafe, interpolateUrl, UrlRefInvalidError } from './url-template.js';
import { CrossOriginRedirectError, fetchOriginPinned } from './origin-pinned-fetch.js';
import {
  discardResponseBody,
  readBoundedResponseText,
  ResponseBodyTooLargeError,
} from './bounded-response-body.js';

const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Execute an HTTP ingredient call.
 *
 *  Input convention (after engine value resolution):
 *  - method:        HTTP method (default GET)
 *  - url:           Full URL with optional {placeholder} path params
 *  - header.{name}: Request headers (null/undefined values are skipped)
 *  - query.{name}:  Query string parameters (null/undefined skipped)
 *  - body:          Request body — object becomes JSON, string sent as-is
 *  - timeout_ms:    Per-call timeout (default 30000, clamped [100, 120000])
 *  - {name}:        Path parameters referenced as {name} in the URL
 *
 *  Output convention:
 *  - manifest.output maps response paths to field names
 *  - manifest.fallback (optional) provides alternative paths if primary fails
 *
 *  Timeout semantics:
 *  - A single AbortController covers the entire call lifecycle: DNS lookup,
 *    TCP connect, TLS handshake, request send, response headers, AND
 *    response body read. If the body stream stalls, the timer fires and
 *    aborts it — we don't leak requests on slow-to-stream servers.
 *  - Out-of-range or non-numeric timeout values are clamped to sane bounds
 *    by `resolveTimeoutMs`; this function never throws on bad timeout input.
 */
/** Pure request construction shared by execution and future-execution review. */
export const describeHttpRequest = (resolved: Pick<ResolvedCall, 'slug' | 'input'>) => {
  const { input, slug } = resolved;
  const method = String(input.method ?? 'GET').toUpperCase();
  const rawUrl = input.url as string | undefined;
  if (!rawUrl) {
    throw new IngredientError('INGREDIENT_NOT_FOUND', `HTTP ingredient ${slug} missing url`);
  }

  let url: string;
  try {
    url = buildUrl(rawUrl, input);
    assertUrlSafe(url);
  } catch (err) {
    if (err instanceof UrlRefInvalidError) {
      throw new IngredientError(
        'URL_REF_INVALID',
        `${slug}: ${err.message}`,
        { ref: err.ref },
      );
    }
    throw err;
  }
  // Resolve the redirect-pin origin BEFORE the dispatch try, so a
  // malformed / relative URL fails as URL_REF_INVALID rather than being
  // misclassified as a write-tier ACTION_DELIVERY_UNCERTAIN (nothing was
  // sent). Normal absolute URLs parse cleanly.
  let requestOrigin: string;
  try {
    requestOrigin = new URL(url).origin;
  } catch {
    throw new IngredientError('URL_REF_INVALID', `${slug}: '${url}' is not an absolute URL`);
  }
  const headers = extractHeaders(input);
  const body = buildBody(input.body, headers);
  const timeoutMs = resolveTimeoutMs(input.timeout_ms);
  return { method, url, requestOrigin, headers, body, timeoutMs };
};

export const executeHTTP = async (resolved: ResolvedCall, beforeRequest?: () => Promise<void>): Promise<unknown> => {
  const { input, output, fallback, slug, risk_tier } = resolved;
  const { method, url, requestOrigin, headers, body, timeoutMs } = describeHttpRequest(resolved);
  const isWrite = isWriteRiskTier(risk_tier);

  await beforeRequest?.();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // SSRF: follow redirects manually, pinned to the recipe-declared
    // URL's own origin. The author's declared target (localhost / LAN
    // included — deliberately allowed) is honored, but a server-driven
    // 3xx cannot pivot the request OFF that origin to an internal /
    // metadata host the recipe never named. Same-origin redirects work.
    const response = await fetchOriginPinned(
      fetch,
      url,
      { method, headers, body, signal: controller.signal },
      requestOrigin,
    );
    classifyHttpError(response, slug, isWrite);
    const data = await parseResponse(response, slug);
    return mapOutput(data, output, fallback);
  } catch (e) {
    if (e instanceof IngredientError) {
      if (isWrite && e.details?.response_body_failure !== undefined) {
        throw new IngredientError(
          'ACTION_DELIVERY_UNCERTAIN',
          `Write to ${slug} returned an unreadable response after request dispatch — outcome cannot be confirmed, please verify state in the target system before retrying`,
          { risk_tier, cause: e.details.response_body_failure },
        );
      }
      throw e;
    }
    if (e instanceof CrossOriginRedirectError) {
      throw new IngredientError(
        'URL_REF_INVALID',
        `${slug}: ${e.message} — cross-origin redirect refused`,
      );
    }
    // Any network-layer error after we entered the try block means the
    // request was dispatched to fetch(). For write-tier ingredients the
    // outcome is now fundamentally ambiguous — we cannot distinguish
    // "request never arrived" from "request arrived and committed but
    // the ack was lost". Surface as ACTION_DELIVERY_UNCERTAIN so the UI
    // can tell the user to verify in their CRM instead of retrying blindly.
    const isAbort = (e as Error).name === 'AbortError';
    if (isWrite) {
      throw new IngredientError(
        'ACTION_DELIVERY_UNCERTAIN',
        `Write to ${slug} ${isAbort ? `timed out after ${timeoutMs}ms` : `failed: ${(e as Error).message}`} — outcome cannot be confirmed, please verify state in the target system before retrying`,
        { risk_tier, cause: isAbort ? 'timeout' : 'network' },
      );
    }
    if (isAbort) {
      throw new IngredientError(
        'STEP_TIMEOUT',
        `HTTP call to ${slug} timed out after ${timeoutMs}ms`,
      );
    }
    throw new IngredientError(
      'NETWORK_ERROR',
      `HTTP call to ${slug} failed: ${(e as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
};

/** Substitute template refs + `{placeholder}` path params, append
 *  the query string. URL-positional encoding (D-112) is applied both
 *  for any residual `{{ref}}` markers in `rawUrl` AND for the
 *  `{name}` single-brace per-call parameters that the manifest input
 *  feeds in.
 *
 *  Order of operations:
 *    1. D-112 template interpolation — any `{{ref}}` still in the
 *       URL (generic ref resolution may have left some if a ref was
 *       absent). Values get position-aware encoding + rejection for
 *       path-segment `/` injections.
 *    2. {name} substitution — the legacy per-call path-param syntax.
 *       Still uses encodeURIComponent (already safe) but also
 *       refuses values containing `/` so the two syntaxes share the
 *       D-112 invariant.
 *    3. Query string assembly — `query.*` input keys become
 *       `?foo=bar&...` with component-encoded names + values. */
const buildUrl = (rawUrl: string, input: Record<string, unknown>): string => {
  const afterTemplate = interpolateUrl(rawUrl, (ref) => input[ref]);

  const substituted = afterTemplate.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    const value = input[name];
    if (value == null) return match;
    const str = String(value);
    if (str.includes('/')) {
      throw new UrlRefInvalidError(
        name,
        `URL_REF_INVALID: path param '${name}' contains '/' — path params must resolve to a single segment`,
      );
    }
    return encodeURIComponent(str);
  });

  const queryParts: string[] = [];
  for (const [key, val] of Object.entries(input)) {
    if (!key.startsWith('query.') || val == null) continue;
    const name = key.slice(6);
    queryParts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(val))}`);
  }

  if (queryParts.length === 0) return substituted;
  const sep = substituted.includes('?') ? '&' : '?';
  return substituted + sep + queryParts.join('&');
};

/** Extract `header.*` input keys, skip null/undefined, default Content-Type for JSON bodies. */
const extractHeaders = (input: Record<string, unknown>): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(input)) {
    if (key.startsWith('header.') && val != null) {
      const name = key.slice(7);
      if (PROTOTYPE_SENSITIVE_KEYS.has(name)) continue;
      headers[name] = String(val);
    }
  }
  return headers;
};

/** Build the request body. Objects become JSON, strings pass through, null = no body. */
const buildBody = (raw: unknown, headers: Record<string, string>): string | undefined => {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw;
  // Auto-add JSON content-type if not set
  const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
  if (!hasContentType) headers['Content-Type'] = 'application/json';
  return JSON.stringify(raw);
};

/** Map HTTP status codes to RecipeErrorCodes. Throws IngredientError for non-2xx.
 *
 *  For write-tier ingredients, 5xx responses are ACTION_DELIVERY_UNCERTAIN
 *  rather than NETWORK_ERROR: a 500 from the server could mean "the write
 *  was rejected before processing" OR "the write was accepted and committed,
 *  then a downstream crash prevented the success ack" — we cannot tell from
 *  the client. 4xx responses (including 401/403/404/429) remain clean errors
 *  because those status codes are explicit server-side rejections before any
 *  state change. */
const classifyHttpError = (response: Response, slug: string, isWrite: boolean): void => {
  if (response.ok) return;

  discardResponseBody(response);

  const status = response.status;
  if (status === 401 || status === 403) {
    throw new IngredientError('OAUTH_EXPIRED', `${slug} returned ${status} ${response.statusText}`);
  }
  if (status === 404) {
    throw new IngredientError('API_NOT_FOUND', `${slug} returned 404 ${response.statusText}`);
  }
  if (status === 429) {
    throw new IngredientError('API_RATE_LIMITED', `${slug} rate limited (429)`);
  }
  if (status >= 500) {
    if (isWrite) {
      throw new IngredientError(
        'ACTION_DELIVERY_UNCERTAIN',
        `Write to ${slug} returned ${status} ${response.statusText} — server error after request dispatch, outcome cannot be confirmed, please verify state in the target system before retrying`,
        { status, risk_tier_bucket: 'write', cause: 'server_5xx' },
      );
    }
    throw new IngredientError('NETWORK_ERROR', `${slug} server error: ${status} ${response.statusText}`);
  }
  throw new IngredientError('NETWORK_ERROR', `${slug} returned ${status} ${response.statusText}`);
};

/** Parse response body as JSON, falling back to text. AbortError from a
 *  timeout must propagate so the outer handler can map it to STEP_TIMEOUT —
 *  do not rewrite it as "malformed JSON". */
const parseResponse = async (response: Response, slug: string): Promise<unknown> => {
  const contentType = response.headers.get('content-type') ?? '';
  let text: string;
  try {
    ({ text } = await readBoundedResponseText(response));
  } catch (e) {
    if (e instanceof ResponseBodyTooLargeError) {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `${slug} response exceeded the ${e.maxBytes}-byte body limit`,
        {
          response_body_failure: 'too_large',
          max_bytes: e.maxBytes,
          ...(e.declaredBytes !== undefined ? { declared_bytes: e.declaredBytes } : {}),
          ...(e.observedBytes !== undefined ? { observed_bytes: e.observedBytes } : {}),
        },
      );
    }
    throw e;
  }
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new IngredientError(
        'NETWORK_ERROR',
        `${slug} returned malformed JSON`,
        { response_body_failure: 'malformed_json' },
      );
    }
  }
  return text;
};

/** Map response paths to output field names. Try fallback paths if primary returns undefined. */
const mapOutput = (
  data: unknown,
  outputMapping: Record<string, string>,
  fallback?: Record<string, string>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [responsePath, fieldName] of Object.entries(outputMapping)) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(fieldName)) continue;
    result[fieldName] = walkPath(data, responsePath);
  }
  if (fallback) {
    for (const [responsePath, fieldName] of Object.entries(fallback)) {
      if (PROTOTYPE_SENSITIVE_KEYS.has(fieldName)) continue;
      if (result[fieldName] === undefined) {
        result[fieldName] = walkPath(data, responsePath);
      }
    }
  }
  return result;
};
