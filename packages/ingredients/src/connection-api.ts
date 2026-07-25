/** D-125 Phase 4.1 — `connection.api` per-kind handler.
 *
 *  First per-kind handler under the `connection` adapter (P3.1 shell,
 *  P3.2 audit emission, P3.3 gate verification). Implements the
 *  HTTP transport for `kind: 'connection' + connection_kind: 'api'`
 *  ingredients, replacing the P3.1 placeholder that surfaces
 *  `INGREDIENT_ADAPTER_ALL_FAILED` with `kind: 'connection.api'`.
 *
 *  Wire shape (spec § 4.1):
 *
 *    Input — `params` after the shell strips `connection_kind` +
 *    `connection`. Dot-prefix keys decompose into structured wire
 *    pieces; flat keys are reserved for the discriminants and never
 *    reach this handler:
 *      - method: HTTP method ('GET' | 'POST' | 'PUT' | 'PATCH' |
 *        'DELETE' | 'HEAD' | 'OPTIONS'). Required.
 *      - path: appended to `record.config.base_url` via
 *        `new URL(path, base_url)`. Required.
 *      - query.<k>: query string parameters (auth-free).
 *      - header.<k>: request headers (auth-free; Authorization /
 *        custom auth header injected after input validation, so a
 *        recipe author can't accidentally exfiltrate the token via
 *        `{{step.<id>.headers.authorization}}`).
 *      - body.<k>: structured body fields. They default to JSON; when the
 *        binding pins `Content-Type: application/x-www-form-urlencoded`,
 *        scalar fields (and arrays of scalars) are encoded as form entries.
 *      - body_raw: literal string body. Mutually exclusive with
 *        `body.*` — when both appear, `body_raw` wins.
 *      - timeout_ms: per-call timeout override. Clamped via
 *        `resolveTimeoutMs` to [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS].
 *
 *    Output — the response shape per spec § 4.1:
 *      `{ status: number, headers: Record<string, string>,
 *         result: <parsed body> }`.
 *      Body is JSON-parsed when content-type matches
 *      `application/json`; otherwise text.
 *
 *  Auth injection — the only code path that touches the connection's
 *  decrypted token. `decodeAuth(row)` is called once per dispatch
 *  via the dep injection point; the boot site closes over
 *  `decodeAuthFromStorage` from `backend/server/src/connection-handler.ts`
 *  + the `connection` HKDF sub-DEK. Auth never appears in `headers` /
 *  `query` keys at the input layer.
 *
 *  OAuth2 refresh (per spec § 4.1):
 *    - Triggered when `auth.expires_at` is past or within
 *      `OAUTH2_REFRESH_LEAD_MS` (60s default).
 *    - Single-flight per (kind, name) via in-memory `Map<pk, Promise>`
 *      so a second concurrent call awaits the first's result rather
 *      than racing the token endpoint.
 *    - Persists the new `current_access_token` + `expires_at` (and
 *      rotated `refresh_token` if the issuer returned one) via
 *      `persistAuth(row, newAuth)` — boot site re-encodes the auth
 *      ciphertext and upserts via the connection store.
 *    - Two-device sync races collapse via LWW on `updated_at` per
 *      D-100/101 — one of the two refreshes "wins" and the other's
 *      access token is silently superseded; OAuth2 spec permits the
 *      issuer to revoke the older token, so eventual convergence is
 *      the worst-case.
 *
 *  Bytes telemetry (P4.2 — ctx hook). Reports request body size as
 *  `bytes_out` and response Content-Length / measured body length as
 *  `bytes_in` via `ctx.setBytes`. Both populate the audit emission's
 *  `bytes_in`/`bytes_out` fields; an `undefined` ctx (older test
 *  harnesses) silently no-ops. */

import {
  CONNECTION_API_TIMEOUT_MS,
  OAUTH2_REFRESH_LEAD_MS,
  walkPath,
  validateHeaderAuthEntries,
  describeHeaderAuthIssue,
} from '@recued/contracts';
import type {
  ConnectionAuth,
  ConnectionRow,
} from '@recued/contracts';
import type { ConnectionHandlerCtx, ConnectionKindHandler } from './connection.js';
import { IngredientError, type ResolvedCall } from './types.js';
import {
  resolveTimeoutMs,
  isWriteRiskTier,
} from './timeout.js';
import { assertUrlSafe, composeApiUrl, interpolateUrl, UrlRefInvalidError } from './url-template.js';
import { CrossOriginRedirectError, fetchOriginPinned } from './origin-pinned-fetch.js';

const ALLOWED_METHODS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);
const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const own = (obj: Record<string, unknown>, key: string): unknown =>
  hasOwn(obj, key) ? obj[key] : undefined;

export interface ConnectionApiHandlerDeps {
  /** Decrypt at-rest `auth_ciphertext` to a typed `ConnectionAuth`.
   *  Boot site closes over `decodeAuthFromStorage` from
   *  `backend/server/src/connection-handler.ts` + the connection
   *  sub-DEK; tests inject a stub returning a synthetic auth. The
   *  handler calls this once per dispatch — auth is never cached
   *  at the handler level so a re-enrollment between calls is
   *  picked up immediately. */
  decodeAuth: (row: ConnectionRow) => Promise<ConnectionAuth>;

  /** Persist a refreshed OAuth2 auth back to the connection store.
   *  Boot site re-encodes via `encodeAuthForStorage` (the same
   *  `connection` sub-DEK used by enrollment) and upserts the row
   *  with bumped `updated_at`. The cloud sync wire (D-125 P2.2)
   *  carries the new ciphertext to other devices on the next
   *  delta scan; LWW on `updated_at` resolves the two-device race.
   *  Best-effort — refresh persistence failures are logged but
   *  don't block the in-flight call (the new access token is used
   *  for THIS request even if persistence fails). */
  persistAuth: (
    row: ConnectionRow,
    newAuth: ConnectionAuth,
  ) => Promise<void>;

  /** fetch implementation. Defaults to `globalThis.fetch` (Node 18+
   *  has it built-in). Tests inject a stub that returns
   *  pre-canned `Response` objects to assert wire-shape construction
   *  + status classification + body parsing. */
  fetchImpl?: typeof fetch;

  /** Wall-clock source. Defaults to `Date.now`. Tests inject a
   *  deterministic stub to assert OAuth2 expiry-window math. */
  now?: () => number;
}

type RenewableOAuth2Auth = Extract<
  ConnectionAuth,
  { type: 'oauth2_refresh' | 'oauth2_client_credentials' }
>;

const isRenewableOAuth2 = (
  auth: ConnectionAuth,
): auth is RenewableOAuth2Auth =>
  auth.type === 'oauth2_refresh' || auth.type === 'oauth2_client_credentials';

const extractDotPrefix = (
  params: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const skip = prefix.length + 1;
  const dotPrefix = `${prefix}.`;
  for (const [key, val] of Object.entries(params)) {
    if (!key.startsWith(dotPrefix) || val == null) continue;
    const name = key.slice(skip);
    if (PROTOTYPE_SENSITIVE_KEYS.has(name)) continue;
    out[name] = val;
  }
  return out;
};

const appendQueryScalar = (
  searchParams: URLSearchParams,
  key: string,
  value: unknown,
): void => {
  if (
    typeof value !== 'string'
    && typeof value !== 'number'
    && typeof value !== 'boolean'
  ) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: query parameter '${key}' must be a string, number, boolean, or array of those scalars`,
      { field: key },
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: query parameter '${key}' must be finite`,
      { field: key },
    );
  }
  searchParams.append(key, String(value));
};

const JSON_DECIMAL_INTEGER_RE = /^-?(?:0|[1-9][0-9]*)$/;

/** Serialize selected top-level body values from exact decimal strings to raw
 * JSON integer literals. All unselected values retain native JSON.stringify
 * semantics. The mode is intentionally narrow: no nested paths, coercion, or
 * exponent/fraction syntax, and arrays require every item to be exact text. */
const stringifyJsonBodyWithDecimalIntegers = (
  fields: Record<string, unknown>,
  rawSpec: unknown,
): string => {
  let selectors: unknown;
  try {
    selectors = typeof rawSpec === 'string' ? JSON.parse(rawSpec) : undefined;
  } catch {
    selectors = undefined;
  }
  if (!Array.isArray(selectors) || selectors.some((field) => typeof field !== 'string')) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      'connection.api: invalid engine-owned decimal-integer JSON field declaration',
    );
  }
  const scalar = new Set<string>();
  const arrays = new Set<string>();
  for (const selector of selectors as string[]) {
    if (selector.endsWith('[]')) arrays.add(selector.slice(0, -2));
    else scalar.add(selector);
  }
  const exactInteger = (field: string, value: unknown): string => {
    if (typeof value !== 'string' || !JSON_DECIMAL_INTEGER_RE.test(value)) {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.api: JSON integer field '${field}' must be an exact decimal string`,
        { field },
      );
    }
    return value;
  };
  return '{' + Object.entries(fields).map(([field, value]) => {
    let encoded: string;
    if (scalar.has(field)) {
      encoded = exactInteger(field, value);
    } else if (arrays.has(field)) {
      if (!Array.isArray(value)) {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api: JSON integer-array field '${field}' must be an array of exact decimal strings`,
          { field },
        );
      }
      encoded = '[' + value.map((item) => exactInteger(`${field}[]`, item)).join(',') + ']';
    } else {
      encoded = JSON.stringify(value);
    }
    return JSON.stringify(field) + ':' + encoded;
  }).join(',') + '}';
};

const buildBody = (
  params: Record<string, unknown>,
  headers: Headers,
): string | undefined => {
  // body_raw wins when both shapes appear — recipes that need raw
  // bytes (form posts to legacy endpoints, signed payloads with
  // exact-byte hashing) opt out of JSON encoding here.
  if (hasOwn(params, 'body_raw')) {
    const raw = own(params, 'body_raw');
    if (raw == null) return undefined;
    return typeof raw === 'string' ? raw : String(raw);
  }
  const fields = extractDotPrefix(params, 'body');
  if (Object.keys(fields).length === 0) return undefined;
  const contentType = headers.get('Content-Type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  const decimalIntegerSpec = own(params, '__rc_json_decimal_integer_fields');
  if (decimalIntegerSpec !== undefined
    && contentType !== undefined
    && contentType !== 'application/json') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      'connection.api: exact decimal-integer request serialization requires application/json',
      { content_type: contentType },
    );
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams();
    const appendScalar = (key: string, value: unknown): void => {
      if (typeof value !== 'string'
        && typeof value !== 'number'
        && typeof value !== 'boolean') {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api: form body field '${key}' must be a string, number, boolean, or array of those scalars`,
          { field: key, content_type: contentType },
        );
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api: form body field '${key}' must be finite`,
          { field: key, content_type: contentType },
        );
      }
      form.append(key, String(value));
    };
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) {
        for (const item of value) appendScalar(key, item);
      } else {
        appendScalar(key, value);
      }
    }
    return form.toString();
  }
  if (!hasContentTypeHeader(headers)) {
    headers.set('Content-Type', 'application/json');
  }
  if (decimalIntegerSpec !== undefined) {
    return stringifyJsonBodyWithDecimalIntegers(
      fields,
      decimalIntegerSpec,
    );
  }
  return JSON.stringify(fields);
};

const hasContentTypeHeader = (headers: Headers): boolean =>
  // `Headers.has()` is case-insensitive per HTTP spec — both
  // `Content-Type` and `content-type` resolve to the same slot.
  headers.has('Content-Type');

const authTypeOf = (auth: ConnectionAuth): string => {
  const raw = (auth as { type?: unknown }).type;
  return typeof raw === 'string' ? raw : String(raw);
};

const requireAuthString = (
  auth: ConnectionAuth,
  field: string,
): string => {
  const value = (auth as unknown as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: auth.${field} is required for auth.type='${authTypeOf(auth)}'`,
      { auth_type: authTypeOf(auth), field },
    );
  }
  return value;
};

const requireAuthNameString = (
  auth: ConnectionAuth,
  field: string,
): string => {
  const value = requireAuthString(auth, field);
  if (PROTOTYPE_SENSITIVE_KEYS.has(value)) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: auth.${field} cannot be a reserved object key`,
      { auth_type: authTypeOf(auth), field },
    );
  }
  return value;
};

const injectAuth = (
  auth: ConnectionAuth,
  headers: Headers,
  url: URL,
): void => {
  switch (auth.type) {
    case 'none':
      return;
    case 'bearer':
      headers.set('Authorization', `Bearer ${requireAuthString(auth, 'token')}`);
      return;
    case 'basic': {
      // btoa is global in Node 18+ and every browser. ASCII-only
      // by spec; non-ASCII passwords would already break the
      // RFC 7617 base64 contract before reaching this layer.
      const b64 = btoa(
        `${requireAuthString(auth, 'username')}:${requireAuthString(auth, 'password')}`,
      );
      headers.set('Authorization', `Basic ${b64}`);
      return;
    }
    case 'header': {
      const res = validateHeaderAuthEntries(auth.headers);
      if (!res.ok) {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api: auth.headers ${describeHeaderAuthIssue(res.issue)}`,
          { auth_type: 'header' },
        );
      }
      for (const h of res.entries) headers.set(h.header_name, h.value);
      return;
    }
    case 'query':
      url.searchParams.set(requireAuthNameString(auth, 'param_name'), requireAuthString(auth, 'value'));
      return;
    case 'oauth2_refresh':
    case 'oauth2_client_credentials':
      if (
        typeof auth.current_access_token !== 'string' ||
        auth.current_access_token.trim() === ''
      ) {
        throw new IngredientError(
          'OAUTH_EXPIRED',
          'OAuth2 access token has not been acquired yet — refresh flow did not run or failed silently',
          { auth_type: auth.type },
        );
      }
      headers.set('Authorization', `Bearer ${auth.current_access_token}`);
      return;
  }
  throw new IngredientError(
    'INGREDIENT_OUTPUT_VALIDATION_FAILED',
    `connection.api: unsupported auth.type '${authTypeOf(auth)}'`,
    { auth_type: authTypeOf(auth) },
  );
};

/** Map an HTTP response to the right error code per spec § 4.1
 *  + the existing executeHTTP convention (D-040). For write-tier
 *  calls, 5xx becomes `ACTION_DELIVERY_UNCERTAIN` because the
 *  server may have committed before the ack failed; the user must
 *  verify in-system before retrying. */
const classifyHttpError = (
  response: Response,
  slug: string,
  isWrite: boolean,
): void => {
  if (response.ok) return;
  const status = response.status;
  if (status === 401 || status === 403) {
    throw new IngredientError(
      'OAUTH_EXPIRED',
      `${slug} returned ${status} ${response.statusText}`,
      { status },
    );
  }
  if (status === 404) {
    throw new IngredientError(
      'API_NOT_FOUND',
      `${slug} returned 404 ${response.statusText}`,
      { status },
    );
  }
  if (status === 429) {
    throw new IngredientError(
      'API_RATE_LIMITED',
      `${slug} rate limited (429)`,
      { status },
    );
  }
  if (status >= 500) {
    if (isWrite) {
      throw new IngredientError(
        'ACTION_DELIVERY_UNCERTAIN',
        `Write to ${slug} returned ${status} ${response.statusText} — server error after request dispatch, outcome cannot be confirmed, please verify state in the target system before retrying`,
        { status, cause: 'server_5xx' },
      );
    }
    throw new IngredientError(
      'NETWORK_ERROR',
      `${slug} server error: ${status} ${response.statusText}`,
      { status },
    );
  }
  throw new IngredientError(
    'NETWORK_ERROR',
    `${slug} returned ${status} ${response.statusText}`,
    { status },
  );
};

/** Quote only plain JSON integer literals that JavaScript cannot represent
 * exactly. This is deliberately a lexical pass followed by the native parser:
 * strings (including escaped quotes and digits) are copied byte-for-byte,
 * fractions/exponents keep number semantics, and malformed JSON still fails in
 * `JSON.parse`. The transformed unsafe integer becomes its exact decimal text. */
const stringifyUnsafeJsonIntegers = (json: string): string => {
  let out = '';
  let index = 0;
  while (index < json.length) {
    const char = json[index]!;
    if (char === '"') {
      const start = index++;
      while (index < json.length) {
        if (json[index] === '\\') {
          index += 2;
          continue;
        }
        if (json[index++] === '"') break;
      }
      out += json.slice(start, index);
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const start = index;
      if (json[index] === '-') index += 1;
      if (json[index] === '0') {
        index += 1;
      } else {
        while (index < json.length && json[index]! >= '0' && json[index]! <= '9') index += 1;
      }
      let integerLiteral = true;
      if (json[index] === '.') {
        integerLiteral = false;
        index += 1;
        while (index < json.length && json[index]! >= '0' && json[index]! <= '9') index += 1;
      }
      if (json[index] === 'e' || json[index] === 'E') {
        integerLiteral = false;
        index += 1;
        if (json[index] === '+' || json[index] === '-') index += 1;
        while (index < json.length && json[index]! >= '0' && json[index]! <= '9') index += 1;
      }
      const token = json.slice(start, index);
      if (integerLiteral) {
        try {
          const value = BigInt(token);
          if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
            out += JSON.stringify(token);
            continue;
          }
        } catch {
          // The native JSON parser below owns malformed-token classification.
        }
      }
      out += token;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
};

const parseResponseBody = async (
  response: Response,
  slug: string,
  stringifyUnsafeIntegers: boolean,
): Promise<unknown> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      if (!stringifyUnsafeIntegers) return await response.json();
      return JSON.parse(stringifyUnsafeJsonIntegers(await response.text())) as unknown;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new IngredientError(
        'NETWORK_ERROR',
        `${slug} returned malformed JSON`,
      );
    }
  }
  return response.text();
};

const responseHeadersToObject = (
  headers: Headers,
): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key] = value; });
  return out;
};

/** SMB-finance slice 3 (storage-gdrive `file.download`) — ceiling on a
 *  captured response body. A downloaded document is small; a runaway / wrong
 *  endpoint must fail loud rather than buffer an unbounded body into memory.
 *  Mirrors the CLI `output_capture` 64 MiB cap. */
const RESPONSE_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

/** Portable Uint8Array → base64 (the codebase avoids Node `Buffer` for
 *  portability — `btoa` is global in Node 18+ and every browser). Chunked
 *  `fromCharCode` so a large body never blows the argument-spread stack. */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

/** Pull a display filename from a `Content-Disposition` header. Prefers the
 *  RFC 5987 `filename*=UTF-8''…` form (percent-decoded), then the plain
 *  `filename="…"` / `filename=…` form. Returns `null` when absent/unparseable
 *  — the caller falls back to the binding's filename source. */
const filenameFromContentDisposition = (header: string | null): string | null => {
  if (!header) return null;
  const ext = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(header);
  if (ext && ext[1]) {
    try {
      return decodeURIComponent(ext[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  if (plain && plain[1]) return plain[1].trim();
  return null;
};

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

/** Read `record.config_json.base_url` — the per-record API root.
 *  Throws `INGREDIENT_OUTPUT_VALIDATION_FAILED` when missing or
 *  malformed; the connection should never have been enrolled
 *  without a base_url, but a corrupted row would otherwise surface
 *  a confusing URL parse error instead of an actionable diagnostic. */
const readBaseUrl = (row: ConnectionRow): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json);
  } catch {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: malformed config_json for connection '${row.name}'`,
      { name: row.name },
    );
  }
  const config = parsed as Record<string, unknown> | null;
  const base = config?.base_url;
  if (typeof base !== 'string' || base.trim() === '') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.api: connection '${row.name}' has no base_url in config (re-enroll in Settings → Connections)`,
      { name: row.name },
    );
  }
  return base;
};

interface OAuth2TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/** Exchange an OAuth2 client id + secret for a short-lived bearer token.
 *  This is adapter-internal credential bootstrap: recipe operations can never
 *  invoke the token endpoint or observe the client secret. The request uses
 *  the standard form-encoded client-credentials grant, supported by Airbyte's
 *  public token endpoint as well as conventional OAuth issuers. */
export const exchangeOAuth2ClientCredentials = async (
  auth: Extract<ConnectionAuth, { type: 'oauth2_client_credentials' }>,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<ConnectionAuth> => {
  const clientId = requireAuthString(auth, 'client_id');
  const clientSecret = requireAuthString(auth, 'client_secret');
  const tokenEndpoint = requireAuthString(auth, 'token_endpoint');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const tokenAuthStyle = auth.token_auth_style ?? 'body';
  if (tokenAuthStyle === 'basic') {
    headers.Authorization =
      `Basic ${bytesToBase64(new TextEncoder().encode(`${clientId}:${clientSecret}`))}`;
  } else {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  }
  if (auth.scope !== undefined) {
    const scope = auth.scope.trim();
    if (scope.length === 0) {
      throw new IngredientError(
        'TOKEN_REFRESH_FAILED',
        'OAuth2 client-credentials exchange: auth.scope must be non-empty when present',
      );
    }
    body.set('scope', scope);
  }

  let tokenOrigin: string;
  try {
    tokenOrigin = new URL(tokenEndpoint).origin;
  } catch {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 client-credentials exchange: malformed token_endpoint '${tokenEndpoint}'`,
      { token_endpoint: tokenEndpoint },
    );
  }

  let resp: Response;
  try {
    resp = await fetchOriginPinned(fetchImpl, tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    }, tokenOrigin);
  } catch (e) {
    if (e instanceof CrossOriginRedirectError) {
      throw new IngredientError(
        'TOKEN_REFRESH_FAILED',
        `OAuth2 client-credentials exchange refused: ${e.message} — credentials not sent to the redirect target`,
        { token_endpoint: tokenEndpoint, cause: 'cross_origin_redirect' },
      );
    }
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 client-credentials exchange failed: ${(e as Error).message}`,
      { token_endpoint: tokenEndpoint, cause: 'network' },
    );
  }
  if (!resp.ok) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 client-credentials exchange returned ${resp.status} ${resp.statusText}`,
      { status: resp.status },
    );
  }

  let data: OAuth2TokenResponse;
  try {
    data = await resp.json() as OAuth2TokenResponse;
  } catch (e) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 client-credentials exchange returned malformed JSON: ${(e as Error).message}`,
    );
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      'OAuth2 client-credentials exchange returned a non-object token response',
    );
  }
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      'OAuth2 client-credentials exchange response missing access_token',
    );
  }
  if (data.token_type !== undefined
    && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 client-credentials exchange returned unsupported token_type '${data.token_type}'`,
    );
  }
  const expiresIn = data.expires_in;
  const hasUsableExpiry = typeof expiresIn === 'number'
    && Number.isFinite(expiresIn)
    && expiresIn > 0;
  return {
    type: 'oauth2_client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    token_endpoint: tokenEndpoint,
    ...(auth.token_auth_style !== undefined ? { token_auth_style: auth.token_auth_style } : {}),
    ...(auth.scope !== undefined ? { scope: auth.scope } : {}),
    current_access_token: data.access_token,
    ...(hasUsableExpiry ? { expires_at: now() + expiresIn * 1_000 } : {}),
  };
};

/** Exchange a refresh token for a fresh access token via the
 *  enrolled `token_endpoint`. POST form-urlencoded per OAuth2 RFC
 *  6749 § 6. Failures map to `TOKEN_REFRESH_FAILED` so the user
 *  surface points to "reconnect the account" rather than the
 *  generic NETWORK_ERROR.
 *
 *  Exported for D-129 P2 — the housekeeping reconciliation harness
 *  reuses the exact same refresh dance from outside the api handler
 *  so re-implementing the OAuth2 grant flow in two places stays
 *  avoided. The harness builds its own persist callback (the
 *  connection-store upsert with re-encoded `auth_ciphertext`). */
export const refreshOAuth2 = async (
  auth: Extract<ConnectionAuth, { type: 'oauth2_refresh' }>,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<ConnectionAuth> => {
  const refreshToken = requireAuthString(auth, 'refresh_token');
  const clientId = requireAuthString(auth, 'client_id');
  const tokenEndpoint = requireAuthString(auth, 'token_endpoint');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const tokenAuthStyle = auth.token_auth_style ?? 'body';
  if (auth.client_secret && tokenAuthStyle === 'basic') {
    headers.Authorization =
      `Basic ${bytesToBase64(new TextEncoder().encode(`${clientId}:${auth.client_secret}`))}`;
  } else {
    body.set('client_id', clientId);
    if (auth.client_secret) {
      body.set('client_secret', auth.client_secret);
    }
  }

  // SSRF: pin redirects to the token endpoint's own origin. A
  // 307/308 from a compromised / open-redirect token endpoint would
  // otherwise re-POST the refresh_token + client_secret to an attacker
  // host (method + body preserved on 307/308). Same-origin redirects
  // re-send to the same trusted origin only; cross-origin is refused
  // before the secret leaves the box.
  let tokenOrigin: string;
  try {
    tokenOrigin = new URL(tokenEndpoint).origin;
  } catch {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 refresh: malformed token_endpoint '${tokenEndpoint}'`,
      { token_endpoint: tokenEndpoint },
    );
  }
  let resp: Response;
  try {
    resp = await fetchOriginPinned(fetchImpl, tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    }, tokenOrigin);
  } catch (e) {
    if (e instanceof CrossOriginRedirectError) {
      throw new IngredientError(
        'TOKEN_REFRESH_FAILED',
        `OAuth2 refresh refused: ${e.message} — credentials not sent to the redirect target`,
        { token_endpoint: tokenEndpoint, cause: 'cross_origin_redirect' },
      );
    }
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 refresh failed: ${(e as Error).message}`,
      { token_endpoint: tokenEndpoint, cause: 'network' },
    );
  }
  if (!resp.ok) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 refresh returned ${resp.status} ${resp.statusText}`,
      { status: resp.status },
    );
  }
  let data: OAuth2TokenResponse;
  try {
    data = await resp.json() as OAuth2TokenResponse;
  } catch (e) {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 refresh returned malformed JSON: ${(e as Error).message}`,
    );
  }
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new IngredientError(
      'TOKEN_REFRESH_FAILED',
      `OAuth2 refresh response missing access_token`,
    );
  }
  const next: ConnectionAuth = {
    type: 'oauth2_refresh',
    refresh_token:
      typeof data.refresh_token === 'string' && data.refresh_token !== ''
        ? data.refresh_token
        : refreshToken,
    client_id: clientId,
    ...(auth.client_secret !== undefined ? { client_secret: auth.client_secret } : {}),
    token_endpoint: tokenEndpoint,
    ...(auth.token_auth_style !== undefined ? { token_auth_style: auth.token_auth_style } : {}),
    current_access_token: data.access_token,
    ...(typeof data.expires_in === 'number'
      ? { expires_at: now() + data.expires_in * 1_000 }
      : {}),
  };
  return next;
};

/** Deps for the shared OAuth2 refresh gate — a subset of `ConnectionApiHandlerDeps`.
 *  The `connection.mcp` handler supplies the same shape so both kinds share ONE
 *  refresh implementation (single source for the single-flight + lead-time +
 *  best-effort-persist semantics). */
export interface EnsureFreshAuthDeps {
  /** Persist a refreshed OAuth2 auth back to the connection store. Best-effort:
   *  a failure is swallowed — the fresh token is still used for the current call;
   *  the next call sees the un-persisted state and refreshes again (wasteful but
   *  safe). */
  persistAuth: (row: ConnectionRow, newAuth: ConnectionAuth) => Promise<void>;
  /** fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Wall-clock source. Defaults to `Date.now`. */
  now?: () => number;
}

/** Build the "refresh the OAuth2 access token if it's missing or within the
 *  lead window" gate shared by the `connection.api` + `connection.mcp` handlers.
 *  Non-oauth2 auth passes through untouched. Both refresh-token and
 *  client-credentials grants use this same gate. A per-`row.pk` single-flight map
 *  (one per gate instance) collapses concurrent calls touching the same
 *  connection onto one in-flight refresh; the map clears on settle so a
 *  later-expired token re-enters the path. The rotated token is persisted
 *  best-effort.
 *
 *  One gate instance per handler instance, so the single-flight only collapses
 *  refreshes WITHIN that instance. Multiple instances in the SAME process (the
 *  executor handler + the watch poll-source handler each build their own) hold
 *  separate maps, so a concurrent refresh of the same connection across
 *  instances can double-refresh and last-writer-wins on the store upsert — the
 *  same pre-existing behavior as the api handler. Tolerable because each refresh
 *  yields a usable token and a stale write self-heals on the next call; a
 *  process-wide gate or a versioned/CAS upsert would tighten it (follow-up).
 *  Across processes (server vs extension) refreshes are independent by design;
 *  LWW on `updated_at` + OAuth2-issuer revocation resolve that cross-runtime
 *  race. */
export const createEnsureFreshAuth = (
  deps: EnsureFreshAuthDeps,
): ((row: ConnectionRow, auth: ConnectionAuth) => Promise<ConnectionAuth>) => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? (() => Date.now());
  const refreshFlight = new Map<string, Promise<ConnectionAuth>>();

  return async (row: ConnectionRow, auth: ConnectionAuth): Promise<ConnectionAuth> => {
    if (!isRenewableOAuth2(auth)) return auth;
    const expiresAt = auth.expires_at;
    const haveAccessToken = typeof auth.current_access_token === 'string'
      && auth.current_access_token !== '';
    const fresh = haveAccessToken
      && typeof expiresAt === 'number'
      && expiresAt - OAUTH2_REFRESH_LEAD_MS > now();
    if (fresh) return auth;

    const existing = refreshFlight.get(row.pk);
    if (existing) return existing;

    const flight = (async () => {
      try {
        const next = auth.type === 'oauth2_refresh'
          ? await refreshOAuth2(auth, fetchImpl, now)
          : await exchangeOAuth2ClientCredentials(auth, fetchImpl, now);
        // Persist the rotated token (still within the single-flight, before the
        // map clears in `finally`). Best-effort: a failure is swallowed so it
        // never fails the current call — we already hold the fresh token; the
        // next call just re-refreshes from the un-persisted state.
        try {
          await deps.persistAuth(row, next);
        } catch {
          // Best-effort — the new access token is still used for this
          // request. The next call will see the un-persisted state and
          // refresh again, which is wasteful but safe.
        }
        return next;
      } finally {
        refreshFlight.delete(row.pk);
      }
    })();
    refreshFlight.set(row.pk, flight);
    return flight;
  };
};

/** Build the api handler bound to per-runtime deps. The returned
 *  `ConnectionKindHandler` is registered at the boot site:
 *
 *    createConnectionAdapter({
 *      store,
 *      handlers: { api: createConnectionApiHandler({ decodeAuth, persistAuth }) },
 *      ...
 *    })
 *
 *  The single-flight refresh map is closed over the factory call
 *  — one map per handler instance, scoped to one runtime. Servers
 *  + extensions get separate maps; that's correct: each runtime
 *  refreshes independently, with LWW + OAuth2-issuer revocation
 *  resolving cross-runtime races. */
export const createConnectionApiHandler = (
  deps: ConnectionApiHandlerDeps,
): ConnectionKindHandler => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? (() => Date.now());

  // Per-row single-flight OAuth2 refresh gate (shared with connection.mcp).
  const ensureFreshAuth = createEnsureFreshAuth({
    persistAuth: deps.persistAuth,
    fetchImpl,
    now,
  });

  return async (
    record: ConnectionRow,
    params: Record<string, unknown>,
    call: ResolvedCall,
    ctx?: ConnectionHandlerCtx,
  ): Promise<unknown> => {
    // ────────────── input validation ──────────────
    const rawMethod = own(params, 'method');
    if (typeof rawMethod !== 'string' || rawMethod === '') {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.api: 'method' is required (got ${typeof rawMethod})`,
        { slug: call.slug, name: record.name },
      );
    }
    const method = rawMethod.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.api: 'method' must be one of GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS (got '${rawMethod}')`,
        { slug: call.slug, name: record.name, method: rawMethod },
      );
    }
    const rawPath = own(params, 'path');
    if (typeof rawPath !== 'string' || rawPath === '') {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.api: 'path' is required (got ${typeof rawPath})`,
        { slug: call.slug, name: record.name },
      );
    }

    const baseUrl = readBaseUrl(record);

    // ────────────── path param interpolation (D-112 parity) ──────────────
    // The engine's namespace resolver (`resolveDeep`) resolves only
    // namespace refs (`{{config.*}}`, `{{step.*}}`, …) before dispatch —
    // a bare `{{deal_id}}` / `{{contact_id}}` is NOT a namespace, so it
    // survives to here as a literal in `path`. Connection-api wrappers
    // declare such path params as flat input fields (`deal_id: null` +
    // `path: '/crm/v3/objects/deals/{{deal_id}}'`), exactly like the HTTP
    // adapter does; mirror its D-112 pass so the id lands in the URL.
    // `interpolateUrl` applies position-aware encoding + rejects raw `/`
    // injection; `assertUrlSafe` catches a `..` segment a ref value could
    // smuggle in (encodeURIComponent leaves `.` untouched). Run on the raw
    // path BEFORE `new URL`, which would normalise `..`/`.` away. A missing
    // param leaves its `{{ref}}` marker in place (HTTP-adapter parity) —
    // recipe validation requires the wrapper's `null` inputs, so a live
    // call always supplies them.
    let resolvedPath: string;
    try {
      resolvedPath = interpolateUrl(rawPath, (ref) => own(params, ref));
      assertUrlSafe(resolvedPath);
    } catch (e) {
      if (e instanceof UrlRefInvalidError) {
        throw new IngredientError(
          'URL_REF_INVALID',
          `connection.api (${call.slug}): ${e.message}`,
          { slug: call.slug, name: record.name, ref: e.ref },
        );
      }
      throw e;
    }

    // ────────────── URL construction ──────────────
    // D-192 #8h — `composeApiUrl` preserves the base_url's path prefix for a leading-slash
    // op path (OpenAPI server+path concatenation); a bare `new URL(path, base)` would REPLACE
    // it, dropping a versioned base segment (`.../v1.0` + `/me/…` → `.../me/…`). Absolute /
    // protocol-relative paths fall through unchanged so the cross-origin guard below still
    // refuses them; an already-rooted continuation cursor (Graph `@odata.nextLink`) is not
    // doubled. `assertUrlSafe(resolvedPath)` (above) still guards `..`/`.` traversal.
    let url: URL;
    try {
      url = composeApiUrl(baseUrl, resolvedPath);
    } catch (e) {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.api: cannot resolve path '${resolvedPath}' against base_url '${baseUrl}': ${(e as Error).message}`,
        { slug: call.slug, name: record.name },
      );
    }
    // Cross-origin guard (Codex review HIGH). A path that resolves to a
    // DIFFERENT origin than base_url — absolute `scheme://host`,
    // protocol-relative `//host`, or a backslash trick `new URL` normalizes —
    // would send the request WITH the connection's auth to an attacker host.
    // connection.api binds to the connection's own base_url; refuse any
    // cross-origin resolution at the wire boundary (publish-time validation is
    // the first gate; this is the runtime backstop for hand-built bindings).
    let baseOrigin = '';
    try {
      baseOrigin = new URL(baseUrl).origin;
    } catch { /* readBaseUrl already validated base_url parses */ }
    if (url.origin !== baseOrigin) {
      throw new IngredientError(
        'URL_REF_INVALID',
        `connection.api (${call.slug}): resolved path '${resolvedPath}' changes the origin to `
          + `'${url.origin}' (base_url origin '${baseOrigin}') — cross-origin dispatch refused`,
        { slug: call.slug, name: record.name },
      );
    }
    const queryParams = extractDotPrefix(params, 'query');
    for (const [k, v] of Object.entries(queryParams)) {
      if (Array.isArray(v)) {
        for (const item of v) appendQueryScalar(url.searchParams, k, item);
      } else {
        appendQueryScalar(url.searchParams, k, v);
      }
    }

    // ────────────── headers + body ──────────────
    const headerInputs = extractDotPrefix(params, 'header');
    const headers = new Headers();
    for (const [k, v] of Object.entries(headerInputs)) {
      headers.set(k, String(v));
    }
    const body = method === 'GET' || method === 'HEAD'
      ? undefined
      : buildBody(params, headers);

    // ────────────── auth (decrypt + maybe refresh + inject) ──────────────
    const auth = await deps.decodeAuth(record);
    const liveAuth = await ensureFreshAuth(record, auth);
    injectAuth(liveAuth, headers, url);

    // ────────────── fetch with timeout ──────────────
    const timeoutMs = resolveTimeoutMs(
      own(params, 'timeout_ms') ?? CONNECTION_API_TIMEOUT_MS,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const isWrite = isWriteRiskTier(call.risk_tier);
    let response: Response;
    try {
      // SSRF: follow redirects manually, pinned to base_url's origin.
      // The cross-origin guard above only covers the INITIAL url; without
      // this a 3xx to an internal / metadata host would be followed
      // (carrying non-stripped custom auth headers) and its body returned
      // to the recipe. Same-origin redirects still work.
      response = await fetchOriginPinned(fetchImpl, url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
      }, baseOrigin);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof IngredientError) throw e;
      if (e instanceof CrossOriginRedirectError) {
        throw new IngredientError(
          'URL_REF_INVALID',
          `connection.api (${call.slug}): ${e.message} — cross-origin redirect refused`,
          { slug: call.slug, name: record.name },
        );
      }
      const isAbort = (e as Error).name === 'AbortError';
      if (isWrite) {
        throw new IngredientError(
          'ACTION_DELIVERY_UNCERTAIN',
          `Write via connection '${record.name}' ${isAbort ? `timed out after ${timeoutMs}ms` : `failed: ${(e as Error).message}`} — outcome cannot be confirmed, please verify state in the target system before retrying`,
          {
            slug: call.slug,
            name: record.name,
            risk_tier: call.risk_tier,
            cause: isAbort ? 'timeout' : 'network',
          },
        );
      }
      if (isAbort) {
        throw new IngredientError(
          'STEP_TIMEOUT',
          `connection.api call to '${record.name}' timed out after ${timeoutMs}ms`,
          { slug: call.slug, name: record.name },
        );
      }
      throw new IngredientError(
        'NETWORK_ERROR',
        `connection.api call to '${record.name}' failed: ${(e as Error).message}`,
        { slug: call.slug, name: record.name },
      );
    }
    clearTimeout(timer);

    // ────────────── status classification + body parse ──────────────
    classifyHttpError(response, call.slug, isWrite);

    // SMB-finance slice 3 — response_capture (storage-gdrive `file.download`):
    // read the raw response BODY rather than JSON/text-parsing it, and return
    // base64 bytes + detected mime + filename. The gateway ingests these into
    // the CAS and returns a `file_ref` with the bytes STRIPPED — the bytes
    // transit server memory only, never an op-step value or the audit. Driven
    // by the engine-set `__rc_*` wire keys (see `buildApiDispatchInput`); a
    // recipe arg can never set them (the gateway strips the `__rc_` prefix).
    if (own(params, '__rc_capture') === '1') {
      // Size cap: the `Content-Length` pre-check rejects an oversized download
      // before buffering (the common path — the user's own Drive always sends
      // it). The post-`arrayBuffer` check below is the backstop for a server
      // that omits/understates Content-Length: it buffers up to the response
      // size, then fails — a bounded transient spike, not a leak. (A future
      // hardening could stream `response.body` and abort mid-read — Codex
      // review MEDIUM; deferred to avoid a streaming-read fetch-mock change.)
      const declaredLen = response.headers.get('content-length');
      if (declaredLen !== null && Number(declaredLen) > RESPONSE_CAPTURE_MAX_BYTES) {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api (${call.slug}): response is ${declaredLen} bytes, over the ${RESPONSE_CAPTURE_MAX_BYTES}-byte download cap`,
          { slug: call.slug, name: record.name },
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > RESPONSE_CAPTURE_MAX_BYTES) {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.api (${call.slug}): response is ${bytes.byteLength} bytes, over the ${RESPONSE_CAPTURE_MAX_BYTES}-byte download cap`,
          { slug: call.slug, name: record.name },
        );
      }
      const ctHeader = response.headers.get('content-type') ?? '';
      const detectedMime = ctHeader.split(';')[0].trim();
      const fallbackMime = String(own(params, '__rc_mime') ?? '');
      const mime_type = detectedMime || fallbackMime || 'application/octet-stream';
      const argFilename = String(own(params, '__rc_filename') ?? '');
      const filename =
        argFilename
        || filenameFromContentDisposition(response.headers.get('content-disposition'))
        || 'download';
      ctx?.setBytes(bytes.byteLength, body !== undefined ? new TextEncoder().encode(body).byteLength : 0);
      return {
        status: response.status,
        headers: responseHeadersToObject(response.headers),
        bytes_b64: bytesToBase64(bytes),
        mime_type,
        filename,
      };
    }

    // P4.2 — surface bytes_out (request body length) before body parse.
    // bytes_in lands after parseResponseBody so we know the actual
    // content length even when the server omitted the response header.
    const bytesOut = body !== undefined ? new TextEncoder().encode(body).byteLength : 0;
    const result = await parseResponseBody(
      response,
      call.slug,
      own(params, '__rc_json_unsafe_integers') === 'string',
    );
    const declaredLen = response.headers.get('content-length');
    const bytesIn = declaredLen !== null && Number.isFinite(Number(declaredLen))
      ? Number(declaredLen)
      : (typeof result === 'string'
          ? new TextEncoder().encode(result).byteLength
          : new TextEncoder().encode(JSON.stringify(result ?? null)).byteLength);
    ctx?.setBytes(bytesIn, bytesOut);

    // ────────────── shape + output mapping ──────────────
    // Spec § 4.1: response shape `{ status, headers, result }`.
    // Wrappers may declare `output` mappings (e.g.
    // `{"result.id": "ticket_id"}`) — apply mapOutput when set so
    // downstream `{{step.<id>.<field>}}` refs hit the wrapper's
    // declared keys rather than the raw `{status, headers, result}`.
    // Empty `output` (test fixtures) → return raw shape.
    const data = {
      status: response.status,
      headers: responseHeadersToObject(response.headers),
      result,
    };
    if (Object.keys(call.output).length === 0) {
      return data;
    }
    return mapOutput(data, call.output, call.fallback);
  };
};
