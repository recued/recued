/** D-125 Phase 4.1 — connection.api per-kind handler tests.
 *
 *  Pins the wire-construction + auth-injection + OAuth2-refresh
 *  contract for `kind: 'connection' + connection_kind: 'api'`
 *  ingredients (spec § 4.1):
 *
 *    1. Input validation: method required + uppercase normalization
 *       + allowed-set; path required + non-empty.
 *    2. URL construction: `new URL(path, base_url)` semantics with
 *       relative + absolute path forms; query.<k> appended via
 *       searchParams; trailing-slash + absolute-path edge cases.
 *    3. Headers: header.<k> input copied verbatim, never overrides
 *       the auth header; auth header set after input header copy.
 *    4. Body: body.<k> structured fields → JSON; body_raw literal
 *       string; body_raw wins on collision; GET / HEAD strip body
 *       even if present in input.
 *    5. Auth injection — all 5 ConnectionAuth variants:
 *       - none (no header / no query)
 *       - bearer (Authorization: Bearer)
 *       - basic (Authorization: Basic b64)
 *       - header (custom header)
 *       - query (search param)
 *       - oauth2_refresh (Authorization: Bearer current_access_token)
 *    6. OAuth2 refresh:
 *       - past expires_at triggers refresh
 *       - expires_at within OAUTH2_REFRESH_LEAD_MS triggers refresh
 *       - fresh expires_at skips refresh
 *       - missing current_access_token triggers refresh
 *       - single-flight: 2 concurrent calls = 1 token endpoint hit
 *       - persistAuth invoked with new auth shape
 *       - new access_token used for the in-flight request
 *       - refresh response without access_token → TOKEN_REFRESH_FAILED
 *       - token endpoint network error → TOKEN_REFRESH_FAILED
 *       - 4xx/5xx token endpoint → TOKEN_REFRESH_FAILED
 *       - persistAuth failure does not break the dispatch
 *    7. Status classification (mirrors executeHTTP D-040):
 *       200 → ok, 401/403 → OAUTH_EXPIRED, 404 → API_NOT_FOUND,
 *       429 → API_RATE_LIMITED, 5xx (read) → NETWORK_ERROR,
 *       5xx (write) → ACTION_DELIVERY_UNCERTAIN.
 *    8. Network error / timeout: read → NETWORK_ERROR / STEP_TIMEOUT,
 *       write → ACTION_DELIVERY_UNCERTAIN regardless of cause.
 *    9. Response shape: `{ status, headers, result }` raw when
 *       call.output is empty; mapOutput when set.
 *   10. Config validation: missing / malformed base_url →
 *       INGREDIENT_OUTPUT_VALIDATION_FAILED with actionable message.
 *   11. Auth-key isolation: the user-supplied input never sees
 *       the auth header / query — `header.authorization` from the
 *       recipe input is overridden by the bearer auth at injection
 *       time (auth wins). */

import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_API_TIMEOUT_MS,
  OAUTH2_REFRESH_LEAD_MS,
  PIPEDRIVE_OAUTH_TOKEN_URL,
} from '@recued/contracts';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import { createConnectionApiHandler } from '../connection-api.js';
import type { ConnectionApiHandlerDeps } from '../connection-api.js';
import { IngredientError, type ResolvedCall } from '../types.js';
import { DEFAULT_RESPONSE_BODY_MAX_BYTES } from '../bounded-response-body.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

const mkRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: `${overrides.kind ?? 'api'}:${overrides.name ?? 'hubspot'}`,
  kind: overrides.kind ?? 'api',
  name: overrides.name ?? 'hubspot',
  display_name: overrides.display_name ?? 'HubSpot',
  config_json: overrides.config_json ?? '{"base_url":"https://api.hubapi.com"}',
  auth_ciphertext: overrides.auth_ciphertext ?? 'opaque-blob',
  enrolled_at: overrides.enrolled_at ?? 1_700_000_000_000,
  updated_at: overrides.updated_at ?? 1_700_000_000_000,
  ...(overrides.subtype !== undefined ? { subtype: overrides.subtype } : {}),
  ...(overrides.publisher_id !== undefined ? { publisher_id: overrides.publisher_id } : {}),
  ...(overrides.last_used_at !== undefined ? { last_used_at: overrides.last_used_at } : {}),
  ...(overrides.health_json !== undefined ? { health_json: overrides.health_json } : {}),
});

const mkCall = (overrides: Partial<ResolvedCall> = {}): ResolvedCall => ({
  slug: overrides.slug ?? 'connection',
  risk_tier: overrides.risk_tier ?? 'read',
  input: overrides.input ?? {},
  output: overrides.output ?? {},
  ...(overrides.fallback ? { fallback: overrides.fallback } : {}),
});

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const captureFetch = (
  responder: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => { headers[k] = v; });
    }
    const captured: FetchCall = {
      url: typeof input === 'string' ? input : input.toString(),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: init?.body == null ? undefined : String(init.body),
    };
    calls.push(captured);
    return responder(captured);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
};

const okJson = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const okText = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', ...headers },
  });

const mkDeps = (
  authOrRow: ConnectionAuth | ((row: ConnectionRow) => ConnectionAuth),
  responder: (call: FetchCall) => Response | Promise<Response>,
  extra: Partial<ConnectionApiHandlerDeps> = {},
): {
  deps: ConnectionApiHandlerDeps;
  calls: FetchCall[];
  persisted: Array<{
    row: ConnectionRow;
    auth: ConnectionAuth;
    configPatch?: { base_url: string };
  }>;
} => {
  const { fetch: fetchImpl, calls } = captureFetch(responder);
  const persisted: Array<{
    row: ConnectionRow;
    auth: ConnectionAuth;
    configPatch?: { base_url: string };
  }> = [];
  const decodeAuth = typeof authOrRow === 'function'
    ? async (row: ConnectionRow) => authOrRow(row)
    : async () => authOrRow;
  const deps: ConnectionApiHandlerDeps = {
    decodeAuth,
    persistAuth: async (row, auth, configPatch) => {
      persisted.push({ row, auth, ...(configPatch !== undefined ? { configPatch } : {}) });
    },
    fetchImpl,
    ...extra,
  };
  return { deps, calls, persisted };
};

// ────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────

describe('connection.api handler — input validation', () => {
  it('throws IOVF when method is missing', async () => {
    const { deps } = mkDeps({ type: 'none' }, () => okJson({ ok: true }));
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('rejects inherited method and path fields as missing input', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({ ok: true }));
    const handler = createConnectionApiHandler(deps);
    const params = Object.create({ method: 'GET', path: '/x' }) as Record<string, unknown>;

    await expect(handler(mkRow(), params, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it('throws IOVF when method is non-string', async () => {
    const { deps } = mkDeps({ type: 'none' }, () => okJson({ ok: true }));
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 42, path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF on disallowed method', async () => {
    const { deps } = mkDeps({ type: 'none' }, () => okJson({ ok: true }));
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'CONNECT', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('refuses a protocol-relative `//host` path that would swap the origin (Codex HIGH)', async () => {
    // base_url is api.hubapi.com; `//evil.example/x` resolves there — refuse
    // BEFORE auth injection / fetch.
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({ ok: true }));
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '//evil.example/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'URL_REF_INVALID' });
    expect(calls).toHaveLength(0);
  });

  it('refuses an absolute cross-origin path', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({ ok: true }));
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: 'https://evil.example/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'URL_REF_INVALID' });
    expect(calls).toHaveLength(0);
  });

  it('uppercases lowercase methods', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'get', path: '/x' }, mkCall());
    expect(calls[0]?.method).toBe('GET');
  });

  it('throws IOVF when path is missing', async () => {
    const { deps } = mkDeps({ type: 'none' }, () => okJson({ ok: true }));
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF on empty path', async () => {
    const { deps } = mkDeps({ type: 'none' }, () => okJson({ ok: true }));
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF when base_url is missing from config', async () => {
    const { deps } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    const row = mkRow({ config_json: '{}' });
    await expect(handler(row, { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF when config_json is malformed', async () => {
    const { deps } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    const row = mkRow({ config_json: '{not json' });
    await expect(handler(row, { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });
});

// ────────────────────────────────────────────────────────────────
// URL + query construction
// ────────────────────────────────────────────────────────────────

describe('connection.api handler — URL + query', () => {
  it('D-192 #8h — PRESERVES the base_url path prefix for a leading-slash op path', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow({ config_json: '{"base_url":"https://api.example.com/v1"}' }),
      { method: 'GET', path: '/things' },
      mkCall(),
    );
    // #8h fix — OpenAPI server+path CONCATENATION: the `/v1` base prefix is preserved
    // (`composeApiUrl` prepends it). Before the fix a bare `new URL('/things', base)` REPLACED
    // the base path per the WHATWG absolute-path rule, dropping `/v1` and 404ing every request.
    expect(calls[0]?.url).toBe('https://api.example.com/v1/things');
  });

  it('appends relative path when base ends with slash', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow({ config_json: '{"base_url":"https://api.example.com/v1/"}' }),
      { method: 'GET', path: 'things/42' },
      mkCall(),
    );
    expect(calls[0]?.url).toBe('https://api.example.com/v1/things/42');
  });

  it('D-192 #8h — does NOT double an already-rooted continuation path (Graph @odata.nextLink)', async () => {
    // A vendor-returned pagination cursor (Graph `@odata.nextLink`, resolved to a same-origin
    // path) ALREADY carries the base prefix, so `composeApiUrl` must leave it alone — prepending
    // would produce `/v1/v1/items` and 404 the follow request.
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow({ config_json: '{"base_url":"https://api.example.com/v1"}' }),
      { method: 'GET', path: '/v1/items?skiptoken=abc' },
      mkCall(),
    );
    expect(calls[0]?.url).toBe('https://api.example.com/v1/items?skiptoken=abc');
  });

  it('D-192 #8h — an origin-only base is unchanged (no path prefix to preserve)', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow({ config_json: '{"base_url":"https://api.example.com"}' }),
      { method: 'GET', path: '/things' },
      mkCall(),
    );
    expect(calls[0]?.url).toBe('https://api.example.com/things');
  });

  it('appends query.<k> params via searchParams', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      {
        method: 'GET',
        path: '/things',
        'query.limit': '10',
        'query.cursor': 'abc&def',
      },
      mkCall(),
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('cursor')).toBe('abc&def');
  });

  it('appends query arrays as repeated parameters instead of comma-joining them', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      {
        method: 'GET',
        path: '/expenses',
        'query.expand[]': ['receipts', 'user', 'budget', 'merchant'],
      },
      mkCall(),
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.getAll('expand[]')).toEqual([
      'receipts',
      'user',
      'budget',
      'merchant',
    ]);
  });

  it('skips null / undefined query.<k> values', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      {
        method: 'GET',
        path: '/x',
        'query.a': 'present',
        'query.b': null,
        'query.c': undefined,
      },
      mkCall(),
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('a')).toBe('present');
    expect(url.searchParams.has('b')).toBe(false);
    expect(url.searchParams.has('c')).toBe(false);
  });

  it('drops prototype-sensitive query.<k> names', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      {
        method: 'GET',
        path: '/x',
        'query.safe': 'kept',
        'query.__proto__': 'drop-proto',
        'query.constructor': 'drop-constructor',
        'query.prototype': 'drop-prototype',
      },
      mkCall(),
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('safe')).toBe('kept');
    expect(url.searchParams.has('__proto__')).toBe(false);
    expect(url.searchParams.has('constructor')).toBe(false);
    expect(url.searchParams.has('prototype')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Headers + body
// ────────────────────────────────────────────────────────────────

describe('connection.api handler — headers + body', () => {
  it('copies header.<k> into request headers', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      {
        method: 'GET',
        path: '/x',
        'header.X-Custom': 'value',
        'header.X-Trace-Id': 'abc-123',
      },
      mkCall(),
    );
    expect(calls[0]?.headers['x-custom']).toBe('value');
    expect(calls[0]?.headers['x-trace-id']).toBe('abc-123');
  });

  it('builds JSON body from body.<k> fields with Content-Type default', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      {
        method: 'POST',
        path: '/x',
        'body.subject': 'hello',
        'body.priority': 1,
      },
      mkCall({ risk_tier: 'write' }),
    );
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ subject: 'hello', priority: 1 });
  });

  it('form-encodes structured body fields when the binding pins that content type', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      {
        method: 'POST',
        path: '/v1/checkout/sessions',
        'header.Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'header.Idempotency-Key': 'd200:sub-1',
        'body.mode': 'payment',
        'body.line_items[0][quantity]': 1,
        'body.metadata[recued_workflow_key]': 'recued-core/paid-document-fulfillment:sub-1',
        'body.payment_method_types[]': ['card', 'link'],
      },
      mkCall({ risk_tier: 'write' }),
    );

    expect(calls[0]?.headers['content-type'])
      .toBe('application/x-www-form-urlencoded; charset=utf-8');
    expect(calls[0]?.headers['idempotency-key']).toBe('d200:sub-1');
    const form = new URLSearchParams(calls[0]?.body ?? '');
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][quantity]')).toBe('1');
    expect(form.get('metadata[recued_workflow_key]'))
      .toBe('recued-core/paid-document-fulfillment:sub-1');
    expect(form.getAll('payment_method_types[]')).toEqual(['card', 'link']);
  });

  it('fails closed instead of stringifying nested objects into a form body', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);

    await expect(handler(
      mkRow(),
      {
        method: 'POST',
        path: '/v1/checkout/sessions',
        'header.Content-Type': 'application/x-www-form-urlencoded',
        'body.metadata': { workflow: 'sub-1' },
      },
      mkCall({ risk_tier: 'write' }),
    )).rejects.toThrow("form body field 'metadata' must be a string, number, boolean");
    expect(calls).toHaveLength(0);
  });

  it('drops prototype-sensitive header.<k> and body.<k> names', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      {
        method: 'POST',
        path: '/x',
        'header.X-Safe': 'kept',
        'header.__proto__': 'drop-proto',
        'header.constructor': 'drop-constructor',
        'header.prototype': 'drop-prototype',
        'body.safe': 'kept',
        'body.__proto__': { polluted: true },
        'body.constructor': 'drop-constructor',
        'body.prototype': 'drop-prototype',
      },
      mkCall({ risk_tier: 'write' }),
    );
    expect(calls[0]?.headers['x-safe']).toBe('kept');
    expect(Object.prototype.hasOwnProperty.call(calls[0]?.headers, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(calls[0]?.headers, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(calls[0]?.headers, 'prototype')).toBe(false);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ safe: 'kept' });
  });

  it('uses body_raw verbatim when present', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      {
        method: 'POST',
        path: '/x',
        body_raw: 'a=1&b=2',
        'header.Content-Type': 'application/x-www-form-urlencoded',
      },
      mkCall({ risk_tier: 'write' }),
    );
    expect(calls[0]?.body).toBe('a=1&b=2');
    expect(calls[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('body_raw wins over body.<k> when both present', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      {
        method: 'POST',
        path: '/x',
        body_raw: 'raw-wins',
        'body.subject': 'json-loses',
      },
      mkCall({ risk_tier: 'write' }),
    );
    expect(calls[0]?.body).toBe('raw-wins');
  });

  it('ignores inherited body_raw when building the request body', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    const params = Object.assign(
      Object.create({ body_raw: 'proto-raw' }),
      {
        method: 'POST',
        path: '/x',
        'body.subject': 'json-wins',
      },
    ) as Record<string, unknown>;

    await handler(mkRow(), params, mkCall({ risk_tier: 'write' }));

    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ subject: 'json-wins' });
  });

  it('GET strips body even when body.<k> is present', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      { method: 'GET', path: '/x', 'body.x': 'should-not-send' },
      mkCall(),
    );
    expect(calls[0]?.body).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Auth injection
// ────────────────────────────────────────────────────────────────

describe('connection.api handler — auth injection', () => {
  it('fails closed for an unsupported auth.type before dispatch', async () => {
    const { deps, calls } = mkDeps(
      { type: 'cookie', value: 'sid=1' } as unknown as ConnectionAuth,
      () => okJson({}),
    );
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it('fails closed for prototype-sensitive auth header/query names before dispatch', async () => {
    for (const auth of [
      { type: 'header', headers: [{ header_name: '__proto__', value: 'secret' }] },
      { type: 'query', param_name: 'constructor', value: 'secret' },
    ] as unknown as ConnectionAuth[]) {
      const { deps, calls } = mkDeps(auth, () => okJson({}));
      const handler = createConnectionApiHandler(deps);
      await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
        .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
      expect(calls).toHaveLength(0);
    }
  });

  it('fails closed for incomplete bearer auth before dispatch', async () => {
    const { deps, calls } = mkDeps(
      { type: 'bearer' } as unknown as ConnectionAuth,
      () => okJson({}),
    );
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it('type=none: no Authorization header', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('type=bearer: Authorization: Bearer <token>', async () => {
    const { deps, calls } = mkDeps(
      { type: 'bearer', token: 'sk-test-12345' },
      () => okJson({}),
    );
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test-12345');
  });

  it('type=basic: Authorization: Basic <b64(user:pass)>', async () => {
    const { deps, calls } = mkDeps(
      { type: 'basic', username: 'alice', password: 'secret' },
      () => okJson({}),
    );
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(calls[0]?.headers.authorization).toBe(`Basic ${btoa('alice:secret')}`);
  });

  it('type=header: custom header set', async () => {
    const { deps, calls } = mkDeps(
      { type: 'header', headers: [{ header_name: 'X-API-Key', value: 'k-12345' }] },
      () => okJson({}),
    );
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(calls[0]?.headers['x-api-key']).toBe('k-12345');
  });

  it('type=header: MULTIPLE headers all set (Plaid PLAID-CLIENT-ID + PLAID-SECRET)', async () => {
    const { deps, calls } = mkDeps(
      {
        type: 'header',
        headers: [
          { header_name: 'PLAID-CLIENT-ID', value: 'cid-123' },
          { header_name: 'PLAID-SECRET', value: 'sec-456' },
        ],
      },
      () => okJson({}),
    );
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(calls[0]?.headers['plaid-client-id']).toBe('cid-123');
    expect(calls[0]?.headers['plaid-secret']).toBe('sec-456');
  });

  it('type=header: an EMPTY headers array fails closed before dispatch', async () => {
    const { deps, calls } = mkDeps(
      { type: 'header', headers: [] } as unknown as ConnectionAuth,
      () => okJson({}),
    );
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it('type=query: param appended to URL', async () => {
    const { deps, calls } = mkDeps(
      { type: 'query', param_name: 'api_key', value: 'k-12345' },
      () => okJson({}),
    );
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      { method: 'GET', path: '/x', 'query.user_id': '42' },
      mkCall(),
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('api_key')).toBe('k-12345');
    expect(url.searchParams.get('user_id')).toBe('42');
  });

  it('type=oauth2_refresh: uses current_access_token', async () => {
    const { deps, calls } = mkDeps(
      {
        type: 'oauth2_refresh',
        refresh_token: 'rt-x',
        client_id: 'c',
        token_endpoint: 'https://oauth/token',
        current_access_token: 'live-access-token',
        expires_at: Date.now() + 3600_000, // fresh
      },
      () => okJson({}),
    );
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(calls[0]?.headers.authorization).toBe('Bearer live-access-token');
  });

  it('auth injection wins over recipe-supplied header.authorization', async () => {
    const { deps, calls } = mkDeps(
      { type: 'bearer', token: 'real-token' },
      () => okJson({}),
    );
    const handler = createConnectionApiHandler(deps);
    await handler(
      mkRow(),
      {
        method: 'GET',
        path: '/x',
        'header.Authorization': 'Bearer fake-from-recipe',
      },
      mkCall(),
    );
    expect(calls[0]?.headers.authorization).toBe('Bearer real-token');
  });
});

// ────────────────────────────────────────────────────────────────
// OAuth2 refresh
// ────────────────────────────────────────────────────────────────

describe('connection.api handler — OAuth2 refresh', () => {
  const refreshableAuth = (overrides: Partial<Extract<ConnectionAuth, { type: 'oauth2_refresh' }>> = {}): ConnectionAuth => ({
    type: 'oauth2_refresh',
    refresh_token: overrides.refresh_token ?? 'rt-original',
    client_id: overrides.client_id ?? 'client-id',
    ...(overrides.client_secret !== undefined ? { client_secret: overrides.client_secret } : {}),
    token_endpoint: overrides.token_endpoint ?? 'https://oauth.example/token',
    ...(overrides.token_auth_style !== undefined ? { token_auth_style: overrides.token_auth_style } : {}),
    ...(overrides.current_access_token !== undefined ? { current_access_token: overrides.current_access_token } : {}),
    ...(overrides.expires_at !== undefined ? { expires_at: overrides.expires_at } : {}),
  });

  it('fails closed for malformed refresh credentials before token POST', async () => {
    const auth = {
      type: 'oauth2_refresh',
      client_id: 'client-id',
      token_endpoint: 'https://oauth.example/token',
    } as unknown as ConnectionAuth;
    const { deps, calls } = mkDeps(auth, () => okJson({ access_token: 'new-token' }));
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it('refuses an unsafe stored token endpoint before sending refresh credentials', async () => {
    const auth = refreshableAuth({
      token_endpoint: 'https://owner:REFRESH-ENDPOINT-PASSWORD@oauth.example/token',
      current_access_token: 'expired-token',
      expires_at: 0,
    });
    const { deps, calls } = mkDeps(auth, () => okJson({ access_token: 'new-token' }));
    const handler = createConnectionApiHandler(deps);

    let rejected: unknown;
    try {
      await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'TOKEN_REFRESH_FAILED',
      details: { cause: 'unsafe_token_endpoint' },
    });
    expect(`${String(rejected)} ${JSON.stringify(rejected)}`)
      .not.toContain('REFRESH-ENDPOINT-PASSWORD');
    expect(calls).toHaveLength(0);
  });

  it('refreshes when expires_at is in the past', async () => {
    const fixedNow = 1_700_000_000_000;
    const auth = refreshableAuth({
      current_access_token: 'old-token',
      expires_at: fixedNow - 1000,
    });
    let tokenEndpointHits = 0;
    const responder = (call: FetchCall): Response => {
      if (call.url === 'https://oauth.example/token') {
        tokenEndpointHits++;
        return okJson({ access_token: 'new-token', expires_in: 3600 });
      }
      return okJson({ ok: true });
    };
    const { deps, calls, persisted } = mkDeps(auth, responder, {
      now: () => fixedNow,
    });
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());

    expect(tokenEndpointHits).toBe(1);
    const apiCall = calls.find((c) => c.url.includes('/x'));
    expect(apiCall?.headers.authorization).toBe('Bearer new-token');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.auth).toMatchObject({
      type: 'oauth2_refresh',
      current_access_token: 'new-token',
      expires_at: fixedNow + 3600 * 1000,
    });
  });

  it('uses and atomically persists a valid provider runtime-base change on refresh', async () => {
    const fixedNow = 1_700_000_000_000;
    const auth = refreshableAuth({
      token_endpoint: PIPEDRIVE_OAUTH_TOKEN_URL,
      current_access_token: 'old-token',
      expires_at: 0,
    });
    const row = mkRow({
      name: 'pipedrive',
      config_json: JSON.stringify({
        vendor: 'pipedrive',
        base_url: 'https://old-company.pipedrive.com',
      }),
    });
    const { deps, calls, persisted } = mkDeps(auth, (call) => {
      if (call.url === PIPEDRIVE_OAUTH_TOKEN_URL) {
        return okJson({
          access_token: 'new-token',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          api_domain: 'https://new-company.pipedrive.com/',
        });
      }
      return okJson({ ok: true });
    }, { now: () => fixedNow });

    await createConnectionApiHandler(deps)(
      row,
      { method: 'GET', path: '/api/v2/deals', 'query.limit': 10 },
      mkCall(),
    );

    expect(calls[1]?.url).toBe('https://new-company.pipedrive.com/api/v2/deals?limit=10');
    expect(calls[1]?.headers.authorization).toBe('Bearer new-token');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      auth: {
        current_access_token: 'new-token',
        refresh_token: 'rotated-refresh',
      },
      configPatch: { base_url: 'https://new-company.pipedrive.com' },
    });
  });

  it('persists a rotated credential but ignores an unsafe refresh runtime base', async () => {
    const issue = vi.fn();
    const auth = refreshableAuth({
      token_endpoint: PIPEDRIVE_OAUTH_TOKEN_URL,
      current_access_token: 'old-token',
      expires_at: 0,
    });
    const row = mkRow({
      name: 'pipedrive',
      config_json: JSON.stringify({
        vendor: 'pipedrive',
        base_url: 'https://known-company.pipedrive.com',
      }),
    });
    const { deps, calls, persisted } = mkDeps(auth, (call) => {
      if (call.url === PIPEDRIVE_OAUTH_TOKEN_URL) {
        return okJson({
          access_token: 'new-token',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          api_domain: 'https://attacker.example',
        });
      }
      return okJson({ ok: true });
    }, { onRuntimeBaseIssue: issue });

    await createConnectionApiHandler(deps)(
      row,
      { method: 'GET', path: '/api/v2/deals' },
      mkCall(),
    );

    expect(calls[1]?.url).toBe('https://known-company.pipedrive.com/api/v2/deals');
    expect(calls.some((call) => call.url.startsWith('https://attacker.example'))).toBe(false);
    expect(persisted[0]?.auth).toMatchObject({ refresh_token: 'rotated-refresh' });
    expect(persisted[0]?.configPatch).toBeUndefined();
    expect(issue).toHaveBeenCalledWith(row, expect.objectContaining({ status: 'invalid' }));
  });

  it('bounds the credential endpoint response before parsing it', async () => {
    const auth = refreshableAuth({ current_access_token: 'expired', expires_at: 0 });
    const { deps, calls } = mkDeps(auth, (call) =>
      call.url === 'https://oauth.example/token'
        ? okJson({ access_token: 'ignored' }, 200, {
            'content-length': String(1024 * 1024 + 1),
          })
        : okJson({ ok: true }),
    );
    const handler = createConnectionApiHandler(deps);

    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'TOKEN_REFRESH_FAILED' });
    expect(calls).toHaveLength(1);
  });

  it('uses HTTP Basic client auth when oauth2_refresh token_auth_style=basic', async () => {
    const fixedNow = 1_700_000_000_000;
    const auth = refreshableAuth({
      client_id: 'client-id',
      client_secret: 'client-secret',
      current_access_token: 'old-token',
      expires_at: fixedNow - 1000,
      token_auth_style: 'basic',
    });
    const { deps, calls, persisted } = mkDeps(
      auth,
      (call) => call.url === 'https://oauth.example/token'
        ? okJson({ access_token: 'new-token', expires_in: 3600 })
        : okJson({ ok: true }),
      { now: () => fixedNow },
    );
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());

    const refreshBody = new URLSearchParams(calls[0]?.body ?? '');
    expect(calls[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('client-id:client-secret', 'utf8').toString('base64')}`,
    );
    expect(refreshBody.has('client_id')).toBe(false);
    expect(refreshBody.has('client_secret')).toBe(false);
    expect(persisted[0]?.auth).toMatchObject({ token_auth_style: 'basic' });
  });

  it('refreshes when expires_at is within OAUTH2_REFRESH_LEAD_MS', async () => {
    const fixedNow = 1_700_000_000_000;
    const auth = refreshableAuth({
      current_access_token: 'old-token',
      // 30s left — less than the 60s lead — must refresh
      expires_at: fixedNow + (OAUTH2_REFRESH_LEAD_MS / 2),
    });
    let tokenHits = 0;
    const { deps } = mkDeps(auth, (call) => {
      if (call.url.startsWith('https://oauth.example/token')) {
        tokenHits++;
        return okJson({ access_token: 'rotated-token' });
      }
      return okJson({});
    }, { now: () => fixedNow });
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(tokenHits).toBe(1);
  });

  it('skips refresh when the access token is fresh', async () => {
    const fixedNow = 1_700_000_000_000;
    const auth = refreshableAuth({
      current_access_token: 'still-fresh',
      expires_at: fixedNow + 3600_000, // 1 hour left
    });
    let tokenHits = 0;
    const { deps, calls } = mkDeps(auth, (call) => {
      if (call.url.startsWith('https://oauth.example/token')) {
        tokenHits++;
      }
      return okJson({});
    }, { now: () => fixedNow });
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(tokenHits).toBe(0);
    expect(calls[0]?.headers.authorization).toBe('Bearer still-fresh');
  });

  it('refreshes when current_access_token is missing', async () => {
    // Fresh OAuth2 enrollment — refresh_token only, no access_token yet.
    const auth = refreshableAuth({ expires_at: undefined });
    let tokenHits = 0;
    const { deps } = mkDeps(auth, (call) => {
      if (call.url.startsWith('https://oauth.example/token')) {
        tokenHits++;
        return okJson({ access_token: 'first-access', expires_in: 3600 });
      }
      return okJson({});
    });
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(tokenHits).toBe(1);
  });

  it('single-flight: 2 concurrent calls share 1 refresh', async () => {
    const fixedNow = 1_700_000_000_000;
    const auth = refreshableAuth({
      current_access_token: 'old',
      expires_at: fixedNow - 1000, // expired
    });
    let tokenHits = 0;
    let releaseToken: ((value: Response) => void) | undefined;
    const tokenPromise = new Promise<Response>((resolve) => { releaseToken = resolve; });
    const { deps } = mkDeps(auth, (call) => {
      if (call.url.startsWith('https://oauth.example/token')) {
        tokenHits++;
        return tokenPromise;
      }
      return okJson({});
    }, { now: () => fixedNow });
    const handler = createConnectionApiHandler(deps);

    const call1 = handler(mkRow(), { method: 'GET', path: '/a' }, mkCall());
    const call2 = handler(mkRow(), { method: 'GET', path: '/b' }, mkCall());
    // Yield enough microtasks for both to enter their refresh path.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    releaseToken!(okJson({ access_token: 'shared-new', expires_in: 3600 }));
    await Promise.all([call1, call2]);

    // Single token endpoint call shared across two API calls.
    expect(tokenHits).toBe(1);
  });

  it('refresh response missing access_token → TOKEN_REFRESH_FAILED', async () => {
    const auth = refreshableAuth({ current_access_token: 'old', expires_at: 0 });
    const { deps } = mkDeps(auth, (call) => {
      if (call.url.startsWith('https://oauth.example/token')) {
        return okJson({ token_type: 'Bearer' /* missing access_token */ });
      }
      return okJson({});
    });
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'TOKEN_REFRESH_FAILED' });
  });

  it('refresh endpoint returning 4xx → TOKEN_REFRESH_FAILED', async () => {
    const auth = refreshableAuth({ current_access_token: 'old', expires_at: 0 });
    const { deps } = mkDeps(auth, (call) => {
      if (call.url.startsWith('https://oauth.example/token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return okJson({});
    });
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'TOKEN_REFRESH_FAILED' });
  });

  it('persistAuth failure does not break the in-flight call', async () => {
    const auth = refreshableAuth({ current_access_token: 'old', expires_at: 0 });
    const { deps: baseDeps, calls } = mkDeps(auth, (call) => {
      if (call.url.startsWith('https://oauth.example/token')) {
        return okJson({ access_token: 'new', expires_in: 3600 });
      }
      return okJson({ ok: true });
    });
    const deps: ConnectionApiHandlerDeps = {
      ...baseDeps,
      persistAuth: async () => { throw new Error('disk full'); },
    };
    const handler = createConnectionApiHandler(deps);
    const result = await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    // The in-flight call still uses the new token despite persistAuth failure.
    const apiCall = calls.find((c) => c.url.includes('/x'));
    expect(apiCall?.headers.authorization).toBe('Bearer new');
    expect(result).toBeDefined();
  });

  it('persistAuth carries refreshed refresh_token when issuer rotates it', async () => {
    const auth = refreshableAuth({ current_access_token: 'old', expires_at: 0 });
    const { deps, persisted } = mkDeps(auth, (call) => {
      if (call.url.startsWith('https://oauth.example/token')) {
        return okJson({ access_token: 'new-a', refresh_token: 'rotated-r', expires_in: 3600 });
      }
      return okJson({});
    });
    const handler = createConnectionApiHandler(deps);
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(persisted[0]?.auth).toMatchObject({
      refresh_token: 'rotated-r',
      current_access_token: 'new-a',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Status classification
// ────────────────────────────────────────────────────────────────

describe('connection.api handler — status classification', () => {
  it('releases an unread non-success response body', async () => {
    const cancel = vi.fn();
    const { deps } = mkDeps({ type: 'none' }, () =>
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        status: 503,
        statusText: 'Unavailable',
      }),
    );
    const handler = createConnectionApiHandler(deps);

    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('200 → success', async () => {
    const { deps } = mkDeps({ type: 'none' }, () => okJson({ id: 42 }));
    const handler = createConnectionApiHandler(deps);
    const result = await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(result).toMatchObject({ status: 200, result: { id: 42 } });
  });

  it('401 → OAUTH_EXPIRED', async () => {
    const { deps } = mkDeps({ type: 'bearer', token: 't' }, () =>
      new Response('{}', { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } }),
    );
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
  });

  it('403 → OAUTH_EXPIRED', async () => {
    const { deps } = mkDeps({ type: 'bearer', token: 't' }, () =>
      new Response('{}', { status: 403, statusText: 'Forbidden', headers: { 'content-type': 'application/json' } }),
    );
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
  });

  it('404 → API_NOT_FOUND', async () => {
    const { deps } = mkDeps({ type: 'none' }, () =>
      new Response('{}', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } }),
    );
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'API_NOT_FOUND' });
  });

  it('429 → API_RATE_LIMITED', async () => {
    const { deps } = mkDeps({ type: 'none' }, () =>
      new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
    );
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'API_RATE_LIMITED' });
  });

  it('500 (read tier) → NETWORK_ERROR', async () => {
    const { deps } = mkDeps({ type: 'none' }, () =>
      new Response('{}', { status: 500, statusText: 'Internal Error', headers: { 'content-type': 'application/json' } }),
    );
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('500 (write tier) → ACTION_DELIVERY_UNCERTAIN', async () => {
    const { deps } = mkDeps({ type: 'none' }, () =>
      new Response('{}', { status: 503, statusText: 'Unavailable', headers: { 'content-type': 'application/json' } }),
    );
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'POST', path: '/x' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });
});

// ────────────────────────────────────────────────────────────────
// Network errors + timeout
// ────────────────────────────────────────────────────────────────

describe('connection.api handler — network errors + timeout', () => {
  it('network error (read) → NETWORK_ERROR', async () => {
    const { deps: baseDeps } = mkDeps({ type: 'none' }, () => okJson({}));
    const deps: ConnectionApiHandlerDeps = {
      ...baseDeps,
      fetchImpl: async () => { throw new TypeError('connection refused'); },
    };
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('network error (write) → ACTION_DELIVERY_UNCERTAIN', async () => {
    const { deps: baseDeps } = mkDeps({ type: 'none' }, () => okJson({}));
    const deps: ConnectionApiHandlerDeps = {
      ...baseDeps,
      fetchImpl: async () => { throw new TypeError('TLS handshake failed'); },
    };
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'POST', path: '/x' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('honors per-call timeout_ms override', async () => {
    // Simulate slow upstream — fetch never resolves within timeout.
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          (err as Error & { name: string }).name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;
    const handler = createConnectionApiHandler({
      decodeAuth: async () => ({ type: 'none' }),
      persistAuth: async () => {},
      fetchImpl,
    });
    const start = Date.now();
    await expect(
      handler(
        mkRow(),
        { method: 'GET', path: '/slow', timeout_ms: 100 },
        mkCall({ risk_tier: 'read' }),
      ),
    ).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

// ────────────────────────────────────────────────────────────────
// Response shape + output mapping
// ────────────────────────────────────────────────────────────────

describe('connection.api handler — response shape', () => {
  it('rejects an oversized response before buffering it', async () => {
    const { deps } = mkDeps({ type: 'none' }, () => okJson({}, 200, {
      'content-length': String(DEFAULT_RESPONSE_BODY_MAX_BYTES + 1),
    }));
    const handler = createConnectionApiHandler(deps);

    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('classifies an oversized write acknowledgement as delivery-uncertain', async () => {
    const { deps } = mkDeps({ type: 'none' }, () => okJson({}, 200, {
      'content-length': String(DEFAULT_RESPONSE_BODY_MAX_BYTES + 1),
    }));
    const handler = createConnectionApiHandler(deps);

    await expect(handler(
      mkRow(),
      { method: 'POST', path: '/x' },
      mkCall({ risk_tier: 'write' }),
    )).rejects.toMatchObject({
      code: 'ACTION_DELIVERY_UNCERTAIN',
      details: { cause: 'response_too_large' },
    });
  });

  it('keeps the request timeout active while the response body streams', async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = (): void => {
            const error = new Error('body aborted');
            error.name = 'AbortError';
            controller.error(error);
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        },
      });
      return new Response(stream, { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const handler = createConnectionApiHandler({
      decodeAuth: async () => ({ type: 'none' }),
      persistAuth: async () => {},
      fetchImpl,
    });

    await expect(handler(
      mkRow(),
      { method: 'GET', path: '/slow-body', timeout_ms: 100 },
      mkCall(),
    )).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('returns { status, headers, result } when call.output is empty', async () => {
    const { deps } = mkDeps({ type: 'none' }, () =>
      okJson({ id: 'abc', name: 'Acme' }, 200, { 'x-trace': 'tx-1' }),
    );
    const handler = createConnectionApiHandler(deps);
    const result = await handler(
      mkRow(),
      { method: 'GET', path: '/x' },
      mkCall(),
    );
    expect(result).toMatchObject({
      status: 200,
      result: { id: 'abc', name: 'Acme' },
    });
    expect((result as { headers: Record<string, string> }).headers['x-trace']).toBe('tx-1');
  });

  it('parses text response when content-type is not JSON', async () => {
    const { deps } = mkDeps({ type: 'none' }, () => okText('plain body'));
    const handler = createConnectionApiHandler(deps);
    const result = await handler(
      mkRow(),
      { method: 'GET', path: '/x' },
      mkCall(),
    );
    expect((result as { result: unknown }).result).toBe('plain body');
  });

  it('applies mapOutput when call.output is non-empty', async () => {
    const { deps } = mkDeps({ type: 'none' }, () =>
      okJson({ id: 'abc', properties: { name: 'Acme' } }),
    );
    const handler = createConnectionApiHandler(deps);
    const result = await handler(
      mkRow(),
      { method: 'GET', path: '/x' },
      mkCall({
        output: {
          'result.id': 'company_id',
          'result.properties.name': 'company_name',
          'status': 'http_status',
        },
      }),
    );
    expect(result).toEqual({
      company_id: 'abc',
      company_name: 'Acme',
      http_status: 200,
    });
  });

  it('drops prototype-sensitive output field names', async () => {
    const { deps } = mkDeps({ type: 'none' }, () =>
      okJson({ id: 'abc', payload: { polluted: true }, shadow: 'bad' }),
    );
    const handler = createConnectionApiHandler(deps);
    const result = await handler(
      mkRow(),
      { method: 'GET', path: '/x' },
      mkCall({
        output: {
          'result.id': 'company_id',
          'result.payload': '__proto__',
          'result.shadow': 'constructor',
        },
        fallback: {
          'result.shadow': 'prototype',
        },
      }),
    ) as Record<string, unknown>;
    expect(result.company_id).toBe('abc');
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
  });

  it('honors fallback paths in mapOutput', async () => {
    const { deps } = mkDeps({ type: 'none' }, () =>
      okJson({ id: 'abc' /* no .name */ }),
    );
    const handler = createConnectionApiHandler(deps);
    const result = await handler(
      mkRow(),
      { method: 'GET', path: '/x' },
      mkCall({
        output: { 'result.name': 'name' },
        fallback: { 'result.id': 'name' },
      }),
    );
    expect(result).toEqual({ name: 'abc' });
  });
});

// ────────────────────────────────────────────────────────────────
// Defaults + crosscut
// ────────────────────────────────────────────────────────────────

describe('connection.api handler — defaults', () => {
  it('uses CONNECTION_API_TIMEOUT_MS by default', async () => {
    // We can't directly observe the timeout value but we can pin it
    // to the constant via a behavioral test: timeout_ms unset =>
    // succeeds within the default window for an immediate response.
    expect(CONNECTION_API_TIMEOUT_MS).toBe(30_000);
    const { deps } = mkDeps({ type: 'none' }, () => okJson({}));
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .resolves.toBeDefined();
  });

  it('decodeAuth invoked exactly once per dispatch', async () => {
    const decode = vi.fn(async () => ({ type: 'none' as const }));
    const { fetch: fetchImpl } = captureFetch(() => okJson({}));
    const handler = createConnectionApiHandler({
      decodeAuth: decode,
      persistAuth: async () => {},
      fetchImpl,
    });
    await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall());
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('P4.2 — calls ctx.setBytes with measured payload sizes', async () => {
    const responseBody = JSON.stringify({ id: 'abc', name: 'Acme' });
    const { deps } = mkDeps(
      { type: 'none' },
      () => new Response(responseBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const handler = createConnectionApiHandler(deps);
    const setBytes = vi.fn();
    await handler(
      mkRow(),
      {
        method: 'POST',
        path: '/x',
        'body.subject': 'hi',
      },
      mkCall({ risk_tier: 'write' }),
      { setBytes },
    );
    expect(setBytes).toHaveBeenCalledTimes(1);
    const [bytesIn, bytesOut] = setBytes.mock.calls[0]!;
    expect(bytesOut).toBeGreaterThan(0); // request body present
    expect(bytesIn).toBeGreaterThan(0); // response has bytes
  });

  it('IngredientError thrown when oauth2_refresh has no current token after refresh skip', async () => {
    // Edge case: somehow the refresh path returned an auth without
    // current_access_token (corrupted persist or test injection).
    // The injector throws OAUTH_EXPIRED so the user surface is
    // actionable rather than a silent malformed Authorization header.
    const handler = createConnectionApiHandler({
      decodeAuth: async () => ({
        type: 'oauth2_refresh',
        refresh_token: 'rt',
        client_id: 'c',
        token_endpoint: 'https://oauth/token',
        // current_access_token missing AND expires_at fresh →
        // ensureFreshAuth still triggers refresh, but in production
        // a corrupted persist could land here. Force the path by
        // having the refresh return a no-op auth:
        current_access_token: '',
        expires_at: Date.now() + 3600_000,
      }),
      persistAuth: async () => {},
      fetchImpl: (async () => okJson({})) as unknown as typeof fetch,
    });
    // Empty current_access_token + fresh expires_at means
    // ensureFreshAuth returns early (haveAccessToken is false →
    // refresh path). Stubbed fetch returns {} for token endpoint
    // → TOKEN_REFRESH_FAILED (no access_token in response).
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toBeInstanceOf(IngredientError);
  });
});

// ────────────────────────────────────────────────────────────────
// SSRF — redirect origin pinning (the cross-origin guard extends to
// redirects: a 3xx to a different origin is refused before it is issued)
// ────────────────────────────────────────────────────────────────

describe('connection.api handler — SSRF redirect origin pinning', () => {
  it('refuses a cross-origin redirect (→ metadata host) with URL_REF_INVALID, never contacting it', async () => {
    const { deps, calls } = mkDeps(
      { type: 'header', headers: [{ header_name: 'X-Api-Key', value: 'secret-key' }] },
      () => new Response('', {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    const handler = createConnectionApiHandler(deps);
    await expect(handler(mkRow(), { method: 'GET', path: '/v1/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'URL_REF_INVALID' });
    // Only the initial same-origin request was made; the custom auth
    // header never rode along to the metadata host.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.hubapi.com/v1/x');
  });

  it('follows a same-origin redirect and returns the final body', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, (call) =>
      call.url.endsWith('/old')
        ? new Response('', { status: 302, headers: { location: 'https://api.hubapi.com/new' } })
        : okJson({ ok: true }),
    );
    const handler = createConnectionApiHandler(deps);
    const res = await handler(mkRow(), { method: 'GET', path: '/old' }, mkCall()) as { result: unknown };
    expect(res.result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('refuses a cross-origin redirect from the OAuth2 token endpoint (no secret leak)', async () => {
    // expired token → refresh path; token endpoint 307-redirects cross-origin.
    const handler = createConnectionApiHandler({
      decodeAuth: async (): Promise<ConnectionAuth> => ({
        type: 'oauth2_refresh',
        refresh_token: 'rt-secret',
        client_id: 'cid',
        client_secret: 'cs-secret',
        token_endpoint: 'https://auth.example.com/token',
        current_access_token: 'stale',
        expires_at: 0,
      }),
      persistAuth: async () => {},
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('https://auth.example.com/token')) {
          return new Response('', { status: 307, headers: { location: 'http://attacker.example.net/token' } });
        }
        return okJson({ ok: true });
      }) as unknown as typeof fetch,
    });
    await expect(handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()))
      .rejects.toMatchObject({ code: 'TOKEN_REFRESH_FAILED' });
  });
});

// ────────────────────────────────────────────────────────────────
// Response decoding — JSON media types (RFC 6839 structured suffixes)
// ────────────────────────────────────────────────────────────────

describe('connection.api handler — a +json response is JSON, not text', () => {
  const dispatch = async (contentType: string, body: string): Promise<unknown> => {
    const { deps } = mkDeps({ type: 'none' }, () => new Response(body, {
      status: 200,
      headers: { 'content-type': contentType },
    }));
    const handler = createConnectionApiHandler(deps);
    const out = await handler(mkRow(), { method: 'GET', path: '/x' }, mkCall()) as { result: unknown };
    return out.result;
  };

  it('parses application/vnd.api+json — what every JSON:API vendor answers', async () => {
    // ⛔ Before this, the body arrived as a STRING and every `result.data.…`
    // read in a Lemon Squeezy / Klaviyo / Outreach / Rootly / Snyk recipe was
    // undefined. Found by the semi-live Lemon Squeezy drive (2026-09-04).
    const result = await dispatch('application/vnd.api+json', '{"data":{"type":"orders","id":"9001"}}');
    expect(result).toEqual({ data: { type: 'orders', id: '9001' } });
  });

  it('parses application/problem+json and a parameterised application/json', async () => {
    expect(await dispatch('application/problem+json', '{"title":"Not Found"}')).toEqual({ title: 'Not Found' });
    expect(await dispatch('application/json; charset=utf-8', '{"ok":true}')).toEqual({ ok: true });
    expect(await dispatch('text/json', '[1,2]')).toEqual([1, 2]);
  });

  it('still hands non-JSON media types through as text', async () => {
    expect(await dispatch('text/plain', '{"looks":"like json"}')).toBe('{"looks":"like json"}');
    expect(await dispatch('application/jsonp', 'cb({})')).toBe('cb({})');
    expect(await dispatch('application/xml', '<a/>')).toBe('<a/>');
  });

  it('a +json body that is not valid JSON is a malformed-JSON failure, as for application/json', async () => {
    await expect(dispatch('application/vnd.api+json', '{not json')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      details: { response_body_failure: 'malformed_json' },
    });
  });
});
