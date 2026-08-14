/** D-125 Phase 4.2 — connection.mcp per-kind handler tests.
 *
 *  Pins the wire-construction + transport-dispatch + tool-validation
 *  + idle-teardown contract for `kind: 'connection' + connection_kind:
 *  'mcp'` ingredients (spec § 4.2):
 *
 *    1. Input validation: tool required + non-empty string; args
 *       optional but must be an object when present.
 *    2. Transport dispatch: sse → POST JSON-RPC; websocket / stdio →
 *       MCP_TRANSPORT_NOT_IMPLEMENTED.
 *    3. Endpoint validation: missing → IOVF; malformed URL → IOVF.
 *    4. Tool list pre-validation: present cache → MCP_TOOL_NOT_FOUND
 *       on miss; absent cache → skip pre-validation, server response
 *       surfaces.
 *    5. JSON-RPC envelope: tools/call method; result wrapped in
 *       `{ status: 'ok', result, headers: undefined }`; server error
 *       envelope wrapped in `{ status: 'tool_error', result: <error>,
 *       headers: undefined }`; non-JSON / non-2.0 response →
 *       NETWORK_ERROR.
 *    6. Auth injection: bearer / basic / header / query / oauth2_refresh
 *       (fresh token injected directly; missing/stale token → refresh via
 *       token_endpoint + persist + inject; refresh failure →
 *       TOKEN_REFRESH_FAILED — the shared `createEnsureFreshAuth` gate).
 *    7. HTTP status classification: 401/403 → OAUTH_EXPIRED, 429 →
 *       API_RATE_LIMITED, 5xx (read) → NETWORK_ERROR, 5xx (write) →
 *       ACTION_DELIVERY_UNCERTAIN.
 *    8. Network errors + timeout: read → NETWORK_ERROR / STEP_TIMEOUT,
 *       write → ACTION_DELIVERY_UNCERTAIN.
 *    9. Pool semantics: lazy entry creation per record; last_used_at
 *       bumped on success; idle entries reaped on next dispatch.
 *   10. Bytes telemetry: ctx.setBytes called with request envelope
 *       size + response envelope size.
 *   11. Subtype + transport derivation: subtype field on row wins over
 *       config.transport (forward-compat for legacy enrollments).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MCP_CLIENT_IDLE_TIMEOUT_MS,
} from '@recued/contracts';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import {
  createConnectionMcpHandler,
  probeMcpLegacySseTools,
} from '../connection-mcp.js';
import type {
  ConnectionMcpHandlerDeps,
  McpStreamHandle,
  WsClientHandle,
  WsConnect,
  StdioSpawn,
} from '../connection-mcp.js';
import { IngredientError, type ResolvedCall } from '../types.js';
import type { ConnectionHandlerCtx } from '../connection.js';
import { DEFAULT_RESPONSE_BODY_MAX_BYTES } from '../bounded-response-body.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

const mkRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: `${overrides.kind ?? 'mcp'}:${overrides.name ?? 'gh'}`,
  kind: overrides.kind ?? 'mcp',
  name: overrides.name ?? 'gh',
  display_name: overrides.display_name ?? 'GitHub MCP',
  config_json: overrides.config_json
    ?? '{"transport":"sse","endpoint":"https://mcp.example/server"}',
  auth_ciphertext: overrides.auth_ciphertext ?? 'opaque-blob',
  enrolled_at: overrides.enrolled_at ?? 1_700_000_000_000,
  updated_at: overrides.updated_at ?? 1_700_000_000_000,
  subtype: overrides.subtype ?? 'sse',
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

const okJsonRpc = (
  result: unknown,
  reqIdParser: (body: string | undefined) => number = () => 1,
  status = 200,
  headers: Record<string, string> = {},
): ((call: FetchCall) => Response) =>
  (call) => new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: reqIdParser(call.body),
      result,
    }),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  );

const errJsonRpc = (
  errorEnvelope: { code: number; message: string; data?: unknown },
): ((call: FetchCall) => Response) =>
  (_call) => new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: errorEnvelope }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const mkDeps = (
  authOrFn: ConnectionAuth | ((row: ConnectionRow) => ConnectionAuth),
  responder: (call: FetchCall) => Response | Promise<Response>,
  extra: Partial<ConnectionMcpHandlerDeps> = {},
): { deps: ConnectionMcpHandlerDeps; calls: FetchCall[] } => {
  const { fetch: fetchImpl, calls } = captureFetch((call) => {
    let request: { id?: number; method?: string } | undefined;
    try {
      request = call.body === undefined
        ? undefined
        : JSON.parse(call.body) as { id?: number; method?: string };
    } catch {
      // OAuth token exchanges use form encoding, not JSON.
    }
    if (request?.method === 'server/discover') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return responder(call);
  });
  const decodeAuth = typeof authOrFn === 'function'
    ? async (row: ConnectionRow) => authOrFn(row)
    : async () => authOrFn;
  const deps: ConnectionMcpHandlerDeps = {
    decodeAuth,
    fetchImpl,
    ...extra,
  };
  return { deps, calls };
};

const modernNegotiatingFetch = (
  operation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = typeof init?.body === 'string'
    ? JSON.parse(init.body) as { id?: number; method?: string }
    : undefined;
  if (body?.method === 'server/discover') {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return operation(input, init);
}) as typeof fetch;

// ────────────────────────────────────────────────────────────────
// Stream transports — shared mock channel (ws + stdio)
// ────────────────────────────────────────────────────────────────

interface WsFrame { jsonrpc: string; id?: number; method?: string; params?: unknown }

type MockReply =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
  | { drop: true }        // no reply → the request times out
  | { close: true }       // channel closes → in-flight requests reject
  | { errorSocket: true }; // channel fires 'error' with NO following 'close'

interface MockChannel {
  /** Fresh `McpStreamHandle` per call — a real reconnect / respawn (the
   *  prior channel stays dead). */
  makeHandle: () => McpStreamHandle;
  /** Every JSON-RPC frame the handler sent over the channel(s). */
  sent: WsFrame[];
  /** Total handle.close() invocations across all channels (leak check). */
  handleCloses: () => number;
}

/** Shared mock MCP stream channel — auto-answers `initialize`, records
 *  every sent frame, routes op frames through `responder`. Transport-
 *  neutral; the ws + stdio mocks wrap it with their connect / spawn shell. */
const makeMockChannel = (
  responder: (frame: WsFrame) => MockReply,
  opts: {
    discoverError?: { code: number; message: string };
    initError?: { code: number; message: string };
    legacy?: boolean;
  } = {},
): MockChannel => {
  const sent: WsFrame[] = [];
  let handleCloses = 0;
  const makeHandle = (): McpStreamHandle => {
    let messageListener: ((data: string) => void) | undefined;
    let closeListener: ((info: { code?: number; reason?: string }) => void) | undefined;
    let errorListener: ((err: Error) => void) | undefined;
    let closed = false;
    const triggerClose = (info: { code?: number; reason?: string }): void => {
      if (closed) return;
      closed = true;
      closeListener?.(info);
    };
    return {
      send: (data) => {
        const frame = JSON.parse(data) as WsFrame;
        sent.push(frame);
        if (frame.id === undefined) return; // notification (notifications/initialized)
        queueMicrotask(() => {
          if (closed) return;
          const reply: MockReply = frame.method === 'server/discover'
            ? (opts.discoverError
                ? { error: opts.discoverError }
                : opts.legacy
                ? { error: { code: -32601, message: 'Method not found' } }
                : { result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } })
            : frame.method === 'initialize'
            ? (opts.initError
                ? { error: { code: opts.initError.code, message: opts.initError.message } }
                : { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } })
            : responder(frame);
          if ('drop' in reply) return;
          if ('close' in reply) { triggerClose({ code: 1006, reason: 'mock close' }); return; }
          // Fire 'error' WITHOUT a following 'close' — the leak case the
          // session must defend against by closing the handle in `fail`.
          if ('errorSocket' in reply) { errorListener?.(new Error('channel boom')); return; }
          const envelope = 'error' in reply
            ? { jsonrpc: '2.0', id: frame.id, error: reply.error }
            : { jsonrpc: '2.0', id: frame.id, result: reply.result };
          messageListener?.(JSON.stringify(envelope));
        });
      },
      onMessage: (l) => { messageListener = l; },
      onClose: (l) => { closeListener = l; },
      onError: (l) => { errorListener = l; },
      close: () => { closed = true; handleCloses += 1; },
    };
  };
  return { makeHandle, sent, handleCloses: () => handleCloses };
};

/** A promise that only ever rejects (AbortError) when the signal fires —
 *  the connect / spawn hang used to exercise the open-timeout path. */
const hangUntilAbort = (signal?: AbortSignal): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });

// ── ws mock ──

interface MockWs {
  wsConnect: WsConnect;
  /** One entry per handshake — the upgrade url + headers (assert the
   *  bearer rides here, per §920). Length === socket-open count. */
  connects: Array<{ url: string; headers: Record<string, string> }>;
  sent: WsFrame[];
  handleCloses: () => number;
}

const mockWs = (
  responder: (frame: WsFrame) => MockReply,
  opts: {
    failConnect?: Error;
    hangConnect?: boolean;
    initError?: { code: number; message: string };
    discoverError?: { code: number; message: string };
    legacy?: boolean;
  } = {},
): MockWs => {
  const ch = makeMockChannel(responder, opts);
  const connects: Array<{ url: string; headers: Record<string, string> }> = [];
  const wsConnect: WsConnect = (url, connectOpts) => {
    connects.push({ url, headers: connectOpts.headers ?? {} });
    if (opts.failConnect) return Promise.reject(opts.failConnect);
    if (opts.hangConnect) return hangUntilAbort(connectOpts.signal);
    return Promise.resolve(ch.makeHandle());
  };
  return { wsConnect, connects, sent: ch.sent, handleCloses: ch.handleCloses };
};

// ── stdio mock ──

interface MockStdio {
  spawnStdio: StdioSpawn;
  /** One entry per spawn — the launch spec (assert command/args/env).
   *  Length === child-spawn count. */
  spawns: Array<{ command: string; args: string[]; env?: Record<string, string> }>;
  sent: WsFrame[];
  handleCloses: () => number;
}

const mockStdio = (
  responder: (frame: WsFrame) => MockReply,
  opts: {
    failSpawn?: Error;
    hangSpawn?: boolean;
    initError?: { code: number; message: string };
    discoverError?: { code: number; message: string };
    legacy?: boolean;
  } = {},
): MockStdio => {
  const ch = makeMockChannel(responder, opts);
  const spawns: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
  const spawnStdio: StdioSpawn = (spec, spawnOpts) => {
    spawns.push({ command: spec.command, args: spec.args, env: spec.env });
    if (opts.failSpawn) return Promise.reject(opts.failSpawn);
    if (opts.hangSpawn) return hangUntilAbort(spawnOpts.signal);
    return Promise.resolve(ch.makeHandle());
  };
  return { spawnStdio, spawns, sent: ch.sent, handleCloses: ch.handleCloses };
};

const wsRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => mkRow({
  subtype: 'websocket',
  config_json: '{"transport":"websocket","endpoint":"wss://mcp.example/ws"}',
  ...overrides,
});

const stdioRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => mkRow({
  subtype: 'stdio',
  config_json: '{"transport":"stdio","command":"/usr/local/bin/mcp-server","args":["--stdio"]}',
  ...overrides,
});

/** Build mcp deps wired to a mock ws connector. */
const wsDeps = (
  auth: ConnectionAuth,
  responder: (frame: WsFrame) => MockReply,
  opts: Parameters<typeof mockWs>[1] = {},
  extra: Partial<ConnectionMcpHandlerDeps> = {},
): { deps: ConnectionMcpHandlerDeps; ws: MockWs } => {
  const ws = mockWs(responder, opts);
  const deps: ConnectionMcpHandlerDeps = {
    decodeAuth: async () => auth,
    wsConnect: ws.wsConnect,
    ...extra,
  };
  return { deps, ws };
};

/** Build mcp deps wired to a mock stdio spawner. stdio has no auth, so
 *  `decodeAuth` is a never-called stub (the stdio path doesn't decode). */
const stdioDeps = (
  responder: (frame: WsFrame) => MockReply,
  opts: Parameters<typeof mockStdio>[1] = {},
  extra: Partial<ConnectionMcpHandlerDeps> = {},
): { deps: ConnectionMcpHandlerDeps; stdio: MockStdio } => {
  const stdio = mockStdio(responder, opts);
  const deps: ConnectionMcpHandlerDeps = {
    decodeAuth: async () => ({ type: 'none' }),
    spawnStdioMcp: stdio.spawnStdio,
    ...extra,
  };
  return { deps, stdio };
};

const methodsOf = (sent: WsFrame[]): Array<string | undefined> => sent.map((f) => f.method);

// ────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — input validation', () => {
  it('throws IOVF when tool is missing', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), {}, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF when tool is empty', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: '   ' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF when args is non-object', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'list', args: 'string-bad' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF when args is an array', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'list', args: [1, 2] }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('accepts undefined args (defaults to empty object)', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, okJsonRpc({ ok: true }));
    const handler = createConnectionMcpHandler(deps);
    await handler(mkRow(), { tool: 'list' }, mkCall());
    const body = JSON.parse(calls.at(-1)!.body!);
    expect(body.params.arguments).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────
// Transport dispatch
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — transport dispatch', () => {
  it('sse → POST JSON-RPC to endpoint', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, okJsonRpc({ items: [] }));
    const handler = createConnectionMcpHandler(deps);
    await handler(mkRow(), { tool: 'list_repos' }, mkCall());
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://mcp.example/server');
    expect(JSON.parse(calls[0]!.body!).method).toBe('server/discover');
    expect(calls[0]?.headers['mcp-protocol-version']).toBe('2026-07-28');
    expect(calls[0]?.headers['mcp-method']).toBe('server/discover');
    const body = JSON.parse(calls.at(-1)!.body!);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'list_repos',
        arguments: {},
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
    });
    expect(calls.at(-1)?.headers['mcp-protocol-version']).toBe('2026-07-28');
    expect(calls.at(-1)?.headers['mcp-method']).toBe('tools/call');
    expect(calls.at(-1)?.headers['mcp-name']).toBe('list_repos');
    expect(calls.at(-1)?.headers.accept).toBe('application/json, text/event-stream');
  });

  it('mirrors x-mcp-header arguments and reads a response-scoped SSE result', async () => {
    const encoder = new TextEncoder();
    const { fetch: fetchImpl, calls } = captureFetch((call) => {
      const request = JSON.parse(call.body ?? '{}') as { id: number; method: string };
      if (request.method === 'server/discover') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 0.5 },
            })}\n\n`,
          ));
          controller.enqueue(encoder.encode(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0', id: request.id, result: { ok: true },
            })}\n\n`,
          ));
          // Deliberately remain open: the client must stop at the final id.
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const handler = createConnectionMcpHandler({
      decodeAuth: async () => ({ type: 'none' }),
      fetchImpl,
    });
    const row = mkRow({
      health_json: JSON.stringify({
        status: 'ok',
        tools: ['execute_sql'],
        mcp_tool_schemas: {
          execute_sql: {
            type: 'object',
            properties: {
              region: { type: 'string', 'x-mcp-header': 'Region' },
            },
          },
        },
      }),
    });

    await expect(handler(
      row,
      { tool: 'execute_sql', args: { region: 'us-west1' } },
      mkCall(),
    )).resolves.toMatchObject({ status: 'ok', result: { ok: true } });
    expect(calls.at(-1)?.headers['mcp-param-region']).toBe('us-west1');
  });

  it('falls back from HTTP discovery to validated 2024-11-05 initialization', async () => {
    const encoder = new TextEncoder();
    let sseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const { fetch: fetchImpl, calls } = captureFetch((call) => {
      if (call.method === 'GET') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            sseController = controller;
            controller.enqueue(encoder.encode(
              'event: endpoint\ndata: /legacy/messages?sessionId=test\n\n',
            ));
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const request = JSON.parse(call.body ?? '{}') as { id?: number; method?: string };
      if (request.method === 'server/discover') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32601, message: 'Method not found' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (request.method === 'initialize') {
        sseController?.enqueue(encoder.encode(
          `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          result: { protocolVersion: '2024-11-05', capabilities: {} },
          })}\n\n`,
        ));
        return new Response(null, { status: 202 });
      }
      if (request.id !== undefined) {
        sseController?.enqueue(encoder.encode(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0', id: request.id, result: { ok: true },
          })}\n\n`,
        ));
      }
      return new Response(null, { status: 202 });
    });
    const handler = createConnectionMcpHandler({
      decodeAuth: async () => ({ type: 'none' }),
      fetchImpl,
    });

    await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
      .resolves.toMatchObject({ status: 'ok' });

    expect(calls.map((call) => ({
      method: call.method,
      rpc: JSON.parse(call.body ?? '{}').method as string | undefined,
    }))).toEqual([
      { method: 'POST', rpc: 'server/discover' },
      // The handshake-era Streamable HTTP probe. This server answers it with a
      // bodyless 202 (it delivers responses on the SSE stream, which is not
      // open yet), so no legacy version is selected and the fallback continues
      // to the two-endpoint transport below.
      { method: 'POST', rpc: 'initialize' },
      { method: 'GET', rpc: undefined },
      { method: 'POST', rpc: 'initialize' },
      { method: 'POST', rpc: 'notifications/initialized' },
      { method: 'POST', rpc: 'tools/call' },
    ]);
    const legacyCall = JSON.parse(calls.at(-1)!.body!);
    expect(legacyCall.params).toEqual({ name: 'list', arguments: {} });
    expect(calls.at(-1)?.headers['mcp-protocol-version']).toBeUndefined();
  });

  it('reaches a handshake-era Streamable HTTP server and echoes its session', async () => {
    // 2025-03-26 … 2025-11-25: one POST endpoint, an `initialize` handshake,
    // a minted `Mcp-Session-Id`, and 405 on the GET the 2024-11-05 transport
    // opens with. Without a path for this shape the whole era is unreachable.
    const { fetch: fetchImpl, calls } = captureFetch((call) => {
      if (call.method === 'GET') return new Response('nope', { status: 405 });
      const request = JSON.parse(call.body ?? '{}') as { id?: number; method?: string };
      if (request.method === 'server/discover') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32601, message: 'Method not found' },
        }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      if (request.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'SESS-9' },
        });
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'hit' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const handler = createConnectionMcpHandler({
      decodeAuth: async () => ({ type: 'none' }),
      fetchImpl,
    });

    await expect(handler(mkRow(), { tool: 'search' }, mkCall()))
      .resolves.toMatchObject({ status: 'ok' });

    // No GET: the two-endpoint transport is never attempted once the
    // handshake-era probe succeeds.
    expect(calls.map((c) => c.method)).not.toContain('GET');
    const toolCall = calls.at(-1)!;
    expect(JSON.parse(toolCall.body!).method).toBe('tools/call');
    expect(toolCall.headers['mcp-session-id']).toBe('SESS-9');
    // Per-request metadata and mirrored headers are 2026-07-28 constructs and
    // must not appear on a handshake-era request.
    expect(JSON.parse(toolCall.body!).params._meta).toBeUndefined();
    expect(toolCall.headers['mcp-protocol-version']).toBeUndefined();
    expect(toolCall.headers['mcp-method']).toBeUndefined();
  });

  it('refuses a result whose resultType it cannot consume', async () => {
    // MRTR: the server is asking a QUESTION, not returning an answer. Passing
    // it through would hand the recipe `inputRequests` as the tool's output.
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({
      resultType: 'input_required',
      inputRequests: [{ method: 'elicitation/create', params: { message: 'confirm?' } }],
    }, (body) => JSON.parse(body ?? '{}').id as number));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'search' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('falls back rather than failing when the modern probe does not answer', async () => {
    // The spec names a non-response as a fallback trigger. Failing the whole
    // dispatch here would strand every server that black-holes an unknown
    // method instead of refusing it.
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return new Response('nope', { status: 405 });
      const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
      calls.push(request.method ?? '-');
      if (request.method === 'server/discover') {
        // Black-holes the unknown method: the negotiation deadline must abort
        // it, exactly as a real fetch would on an unresponsive endpoint.
        await new Promise<void>((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }
      if (request.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          result: { protocolVersion: '2025-06-18', capabilities: {} },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: { ok: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const handler = createConnectionMcpHandler({
      decodeAuth: async () => ({ type: 'none' }),
      fetchImpl,
    });

    // MIN_TIMEOUT_MS floors the per-call budget at 100ms; the negotiation probe
    // takes the same bound, so the black-holed discover aborts promptly.
    await expect(handler(mkRow(), { tool: 'search', timeout_ms: 100 }, mkCall()))
      .resolves.toMatchObject({ status: 'ok' });
    expect(calls).toEqual(['server/discover', 'initialize', 'notifications/initialized', 'tools/call']);
  });

  it('probes a real 2024 two-endpoint HTTP+SSE tool list', async () => {
    const encoder = new TextEncoder();
    let sseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const { fetch: fetchImpl, calls } = captureFetch((call) => {
      if (call.method === 'GET') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            sseController = controller;
            controller.enqueue(encoder.encode('event: endpoint\ndata: /messages?s=1\n\n'));
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const request = JSON.parse(call.body ?? '{}') as { id?: number; method?: string };
      if (request.id !== undefined) {
        const result = request.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: {} }
          : { tools: [{ name: 'legacy-search', inputSchema: { type: 'object' } }] };
        sseController?.enqueue(encoder.encode(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`,
        ));
      }
      return new Response(null, { status: 202 });
    });

    await expect(probeMcpLegacySseTools(
      fetchImpl,
      'https://mcp.example/server',
      { Authorization: 'Bearer test' },
      1_000,
    )).resolves.toMatchObject({ ok: true, tools: ['legacy-search'] });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'POST', 'POST']);
    expect(calls[1]?.url).toBe('https://mcp.example/messages?s=1');
  });

  it('does not downgrade when HTTP discovery returns a recognized modern error', async () => {
    const { fetch: fetchImpl, calls } = captureFetch((call) => {
      const request = JSON.parse(call.body ?? '{}') as { id?: number };
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        error: {
          code: -32022,
          message: 'Unsupported protocol version',
          data: { supported: ['2099-01-01'], requested: '2026-07-28' },
        },
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    const handler = createConnectionMcpHandler({
      decodeAuth: async () => ({ type: 'none' }),
      fetchImpl,
    });

    await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(calls.map((call) => JSON.parse(call.body ?? '{}').method))
      .toEqual(['server/discover']);
  });

  it('websocket without a ws connector → MCP_TRANSPORT_NOT_IMPLEMENTED', async () => {
    // Graceful degradation: a runtime that supplies no `wsConnect` (the
    // ext / dbless harnesses can't open header-bearing sockets) surfaces
    // NOT_IMPLEMENTED. `mkDeps` omits wsConnect; the real ws path is
    // covered in the dedicated suite below (it injects a mock connector).
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({
      subtype: 'websocket',
      config_json: '{"transport":"websocket","endpoint":"wss://mcp.example/ws"}',
    });
    await expect(handler(row, { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'MCP_TRANSPORT_NOT_IMPLEMENTED' });
  });

  it('stdio without a process spawner → MCP_TRANSPORT_NOT_IMPLEMENTED', async () => {
    // Graceful degradation: a runtime that supplies no `spawnStdioMcp`
    // (the ext / dbless harnesses can't fork processes) surfaces
    // NOT_IMPLEMENTED. `mkDeps` omits the spawner; the real stdio path is
    // covered in its own suite below (it injects a mock spawner).
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({
      subtype: 'stdio',
      config_json: '{"transport":"stdio","command":"/usr/local/bin/mcp-server"}',
    });
    await expect(handler(row, { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'MCP_TRANSPORT_NOT_IMPLEMENTED' });
  });

  it('subtype on row wins over config.transport', async () => {
    // Forward-compat: row's `subtype` is authoritative; if config
    // accidentally diverges, dispatch follows the row.
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({
      subtype: 'sse',
      config_json: '{"transport":"websocket","endpoint":"https://mcp.example/server"}',
    });
    await handler(row, { tool: 'list' }, mkCall());
    // Reaches POST despite config.transport=websocket — sse subtype wins.
  });

  it('falls back to config.transport when subtype is invalid', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({
      subtype: 'unknown-transport',
      config_json: '{"transport":"sse","endpoint":"https://mcp.example/server"}',
    });
    await handler(row, { tool: 'list' }, mkCall());
  });

  it('throws IOVF when transport is missing entirely', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    // Build row literal — `mkRow({ subtype: undefined })` collapses
    // back to the default via `?? 'sse'`. Authoritative literal here.
    const row: ConnectionRow = {
      pk: 'mcp:gh',
      kind: 'mcp',
      name: 'gh',
      display_name: 'GitHub MCP',
      config_json: '{"endpoint":"https://mcp.example/server"}',
      auth_ciphertext: 'opaque',
      enrolled_at: 0,
      updated_at: 0,
      // subtype + transport intentionally absent
    };
    await expect(handler(row, { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });
});

// ────────────────────────────────────────────────────────────────
// Endpoint validation
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — endpoint validation', () => {
  it('throws IOVF when endpoint is missing', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({ config_json: '{"transport":"sse"}' });
    await expect(handler(row, { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF when endpoint is malformed URL', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({ config_json: '{"transport":"sse","endpoint":"not a url"}' });
    await expect(handler(row, { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF when config_json is malformed', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({ config_json: '{not json' });
    await expect(handler(row, { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });
});

// ────────────────────────────────────────────────────────────────
// Tool list pre-validation
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — tool list pre-validation', () => {
  it('passes through when tool is in cached list', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({ ok: true }));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({
      health_json: JSON.stringify({
        status: 'ok',
        last_probed_at: 1_700_000_000_000,
        tools: ['list_repos', 'create_issue'],
      }),
    });
    await expect(handler(row, { tool: 'list_repos' }, mkCall())).resolves.toBeDefined();
  });

  it('throws MCP_TOOL_NOT_FOUND when tool absent from cache', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({
      health_json: JSON.stringify({
        status: 'ok',
        tools: ['list_repos'],
      }),
    });
    await expect(handler(row, { tool: 'create_issue' }, mkCall()))
      .rejects.toMatchObject({ code: 'MCP_TOOL_NOT_FOUND' });
  });

  it('skips pre-validation when cache absent (lets server respond)', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({ ok: true }));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({ health_json: undefined });
    await expect(handler(row, { tool: 'unknown_tool' }, mkCall())).resolves.toBeDefined();
  });

  it('skips pre-validation when health_json is malformed', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({ ok: true }));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({ health_json: '{bad json' });
    await expect(handler(row, { tool: 'unknown_tool' }, mkCall())).resolves.toBeDefined();
  });

  it('skips pre-validation when tools array is empty (probe found nothing)', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({ ok: true }));
    const handler = createConnectionMcpHandler(deps);
    const row = mkRow({
      health_json: JSON.stringify({ status: 'ok', tools: [] }),
    });
    await expect(handler(row, { tool: 'something' }, mkCall())).resolves.toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────
// JSON-RPC envelope
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — JSON-RPC envelope', () => {
  it('rejects an oversized response before buffering it', async () => {
    const { deps } = mkDeps(
      { type: 'none' },
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
        headers: {
          'content-type': 'application/json',
          'content-length': String(DEFAULT_RESPONSE_BODY_MAX_BYTES + 1),
        },
      }),
    );
    const handler = createConnectionMcpHandler(deps);

    await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('does not present a malformed write acknowledgement as safely retryable', async () => {
    const { deps } = mkDeps(
      { type: 'none' },
      () => new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const handler = createConnectionMcpHandler(deps);

    await expect(handler(
      mkRow(),
      { tool: 'create_issue' },
      mkCall({ risk_tier: 'write' }),
    )).rejects.toMatchObject({
      code: 'ACTION_DELIVERY_UNCERTAIN',
      details: { cause: 'malformed_response' },
    });
  });

  it('returns { status: ok, result, headers: undefined } on success', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({ items: [1, 2, 3] }));
    const handler = createConnectionMcpHandler(deps);
    const result = await handler(mkRow(), { tool: 'list_repos' }, mkCall());
    expect(result).toEqual({
      status: 'ok',
      result: { items: [1, 2, 3] },
      headers: undefined,
    });
  });

  it('returns { status: tool_error, result: error, headers: undefined } on JSON-RPC error', async () => {
    const { deps } = mkDeps(
      { type: 'none' },
      errJsonRpc({ code: -32602, message: 'Invalid params', data: { field: 'x' } }),
    );
    const handler = createConnectionMcpHandler(deps);
    const result = await handler(mkRow(), { tool: 'create_issue' }, mkCall());
    expect(result).toEqual({
      status: 'tool_error',
      result: { code: -32602, message: 'Invalid params', data: { field: 'x' } },
      headers: undefined,
    });
  });

  it('maps MCP CallToolResult.isError to tool_error over sse', async () => {
    const toolResult = {
      isError: true,
      content: [{ type: 'text', text: 'participant is inactive' }],
    };
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc(toolResult));
    const handler = createConnectionMcpHandler(deps);

    await expect(handler(mkRow(), { tool: 'list_projects' }, mkCall()))
      .resolves.toEqual({ status: 'tool_error', result: toolResult, headers: undefined });
  });

  it('throws NETWORK_ERROR on malformed JSON', async () => {
    const { deps } = mkDeps(
      { type: 'none' },
      () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('throws NETWORK_ERROR on non-2.0 JSON-RPC version', async () => {
    const { deps } = mkDeps(
      { type: 'none' },
      () => new Response(
        JSON.stringify({ jsonrpc: '1.0', id: 1, result: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('passes args through to the JSON-RPC params.arguments', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    await handler(
      mkRow(),
      { tool: 'create_issue', args: { repo: 'foo/bar', title: 'hi' } },
      mkCall(),
    );
    const body = JSON.parse(calls.at(-1)!.body!);
    expect(body.params).toMatchObject({
      name: 'create_issue',
      arguments: { repo: 'foo/bar', title: 'hi' },
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Resource ops — resources/read + resources/list
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — resource ops', () => {
  it('resource → resources/read JSON-RPC with the uri', async () => {
    const { deps, calls } = mkDeps(
      { type: 'none' },
      okJsonRpc({ contents: [{ uri: 'file:///a.txt', text: 'hello' }] }),
    );
    const handler = createConnectionMcpHandler(deps);
    const result = await handler(
      mkRow(),
      { resource: 'file:///a.txt' },
      mkCall(),
    );
    const body = JSON.parse(calls.at(-1)!.body!);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: 'file:///a.txt' },
    });
    expect(result).toEqual({
      status: 'ok',
      result: { contents: [{ uri: 'file:///a.txt', text: 'hello' }] },
      headers: undefined,
    });
  });

  it('resources_list:true → resources/list JSON-RPC with empty params', async () => {
    const { deps, calls } = mkDeps(
      { type: 'none' },
      okJsonRpc({ resources: [{ uri: 'file:///a.txt' }, { uri: 'file:///b.txt' }] }),
    );
    const handler = createConnectionMcpHandler(deps);
    const result = await handler(mkRow(), { resources_list: true }, mkCall());
    const body = JSON.parse(calls.at(-1)!.body!);
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'resources/list', params: {} });
    expect(result).toMatchObject({
      status: 'ok',
      result: { resources: [{ uri: 'file:///a.txt' }, { uri: 'file:///b.txt' }] },
    });
  });

  it('tool wins when both tool and resource are present (backward-compat)', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    await handler(mkRow(), { tool: 'list', resource: 'file:///a.txt' }, mkCall());
    const body = JSON.parse(calls.at(-1)!.body!);
    expect(body.method).toBe('tools/call');
  });

  it('skips the tool-list health gate for resource reads (no false MCP_TOOL_NOT_FOUND)', async () => {
    // A cached tool list must not block a resource read — the gate is
    // tool-mode only.
    const { deps, calls } = mkDeps({ type: 'none' }, okJsonRpc({ contents: [] }));
    const handler = createConnectionMcpHandler(deps);
    await handler(
      mkRow({ health_json: JSON.stringify({ status: 'ok', tools: ['only_this_tool'] }) }),
      { resource: 'file:///a.txt' },
      mkCall(),
    );
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls.at(-1)!.body!).method).toBe('resources/read');
  });

  it('throws IOVF when resource is an empty string', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { resource: '  ' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF when no operation selector is present', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { resources_list: false }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('maps a resources/read error envelope to tool_error', async () => {
    const { deps } = mkDeps(
      { type: 'none' },
      errJsonRpc({ code: -32002, message: 'Resource not found' }),
    );
    const handler = createConnectionMcpHandler(deps);
    const result = await handler(mkRow(), { resource: 'file:///missing' }, mkCall());
    expect(result).toMatchObject({
      status: 'tool_error',
      result: { code: -32002, message: 'Resource not found' },
    });
  });

  it('a resource read NEVER takes the write-uncertainty path, even at a write tier', async () => {
    // resources/read is a read by spec — a network failure is a plain
    // read failure, never ACTION_DELIVERY_UNCERTAIN, regardless of the
    // dispatched risk tier (codex fold).
    const { deps } = mkDeps({ type: 'none' }, () => {
      throw new Error('socket hangup');
    });
    const handler = createConnectionMcpHandler(deps);
    await expect(
      handler(mkRow(), { resource: 'file:///a.txt' }, mkCall({ risk_tier: 'write' })),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});

// ────────────────────────────────────────────────────────────────
// Auth injection
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — auth injection', () => {
  it('fails closed for an unsupported auth.type before dispatch', async () => {
    const { deps, calls } = mkDeps(
      { type: 'cookie', value: 'sid=1' } as unknown as ConnectionAuth,
      okJsonRpc({}),
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it('fails closed for incomplete bearer auth before dispatch', async () => {
    const { deps, calls } = mkDeps(
      { type: 'bearer' } as unknown as ConnectionAuth,
      okJsonRpc({}),
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it('fails closed for prototype-sensitive auth header/query names before dispatch', async () => {
    for (const auth of [
      { type: 'header', headers: [{ header_name: '__proto__', value: 'secret' }] },
      { type: 'query', param_name: 'constructor', value: 'secret' },
    ] as unknown as ConnectionAuth[]) {
      const { deps, calls } = mkDeps(auth, okJsonRpc({}));
      const handler = createConnectionMcpHandler(deps);
      await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
        .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
      expect(calls).toHaveLength(0);
    }
  });

  it('type=bearer: Authorization: Bearer', async () => {
    const { deps, calls } = mkDeps(
      { type: 'bearer', token: 'mcp-token' },
      okJsonRpc({}),
    );
    const handler = createConnectionMcpHandler(deps);
    await handler(mkRow(), { tool: 'list' }, mkCall());
    expect(calls[0]?.headers.authorization).toBe('Bearer mcp-token');
  });

  it('type=basic: Authorization: Basic b64', async () => {
    const { deps, calls } = mkDeps(
      { type: 'basic', username: 'u', password: 'p' },
      okJsonRpc({}),
    );
    const handler = createConnectionMcpHandler(deps);
    await handler(mkRow(), { tool: 'list' }, mkCall());
    expect(calls[0]?.headers.authorization).toBe(`Basic ${btoa('u:p')}`);
  });

  it('type=header: custom header', async () => {
    const { deps, calls } = mkDeps(
      { type: 'header', headers: [{ header_name: 'X-MCP-Key', value: 'k1' }] },
      okJsonRpc({}),
    );
    const handler = createConnectionMcpHandler(deps);
    await handler(mkRow(), { tool: 'list' }, mkCall());
    expect(calls[0]?.headers['x-mcp-key']).toBe('k1');
  });

  it('type=header: MULTIPLE headers all set on the handshake', async () => {
    const { deps, calls } = mkDeps(
      {
        type: 'header',
        headers: [
          { header_name: 'X-MCP-Key', value: 'k1' },
          { header_name: 'X-MCP-Workspace', value: 'ws-9' },
        ],
      },
      okJsonRpc({}),
    );
    const handler = createConnectionMcpHandler(deps);
    await handler(mkRow(), { tool: 'list' }, mkCall());
    expect(calls[0]?.headers['x-mcp-key']).toBe('k1');
    expect(calls[0]?.headers['x-mcp-workspace']).toBe('ws-9');
  });

  it('type=query: search param appended', async () => {
    const { deps, calls } = mkDeps(
      { type: 'query', param_name: 'api_key', value: 'k1' },
      okJsonRpc({}),
    );
    const handler = createConnectionMcpHandler(deps);
    await handler(mkRow(), { tool: 'list' }, mkCall());
    expect(calls[0]?.url).toContain('api_key=k1');
  });

  it('type=oauth2_refresh with a FRESH access token: injects it directly (no refresh)', async () => {
    const { deps, calls } = mkDeps(
      {
        type: 'oauth2_refresh',
        refresh_token: 'rt',
        client_id: 'c',
        token_endpoint: 'https://oauth/token',
        current_access_token: 'live-token',
        expires_at: 9_999_999_999_999, // far future → provably fresh
      },
      okJsonRpc({}),
    );
    const handler = createConnectionMcpHandler(deps);
    await handler(mkRow(), { tool: 'list' }, mkCall());
    // Fresh → no token-endpoint round-trip; the live token is used as-is.
    expect(calls.some((c) => c.url.includes('oauth/token'))).toBe(false);
    expect(calls.at(-1)?.headers.authorization).toBe('Bearer live-token');
  });

  it('type=oauth2_refresh without an access token: refreshes, injects the new token, persists', async () => {
    const persisted: ConnectionAuth[] = [];
    const { deps, calls } = mkDeps(
      {
        type: 'oauth2_refresh',
        refresh_token: 'rt',
        client_id: 'c',
        token_endpoint: 'https://oauth/token',
      },
      (call) =>
        call.url.includes('oauth/token')
          ? new Response(
              JSON.stringify({ access_token: 'refreshed-tok', expires_in: 3600, refresh_token: 'rt2' }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          : okJsonRpc({})(call),
      { persistAuth: async (_row, newAuth) => { persisted.push(newAuth); } },
    );
    const handler = createConnectionMcpHandler(deps);
    await handler(mkRow(), { tool: 'list' }, mkCall());
    // Refresh happens first, then the MCP call carries the refreshed bearer.
    expect(calls[0]?.url).toContain('oauth/token');
    expect(calls.at(-1)?.headers.authorization).toBe('Bearer refreshed-tok');
    // The rotated auth is written back through persistAuth.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ type: 'oauth2_refresh', current_access_token: 'refreshed-tok' });
  });

  it('uses the refreshed token and reports a non-fatal MCP persistence failure', async () => {
    const persistError = new Error('sqlite is read-only');
    const onPersistFailure = vi.fn();
    const { deps, calls } = mkDeps(
      {
        type: 'oauth2_refresh',
        refresh_token: 'rt',
        client_id: 'c',
        token_endpoint: 'https://oauth/token',
      },
      (call) => call.url.includes('oauth/token')
        ? new Response(JSON.stringify({
            access_token: 'usable-now',
            refresh_token: 'rotated-rt',
            expires_in: 3600,
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        : okJsonRpc({})(call),
      {
        persistAuth: async () => { throw persistError; },
        onPersistFailure,
      },
    );
    const row = mkRow();

    await expect(createConnectionMcpHandler(deps)(
      row,
      { tool: 'list' },
      mkCall(),
    )).resolves.toMatchObject({ status: 'ok' });

    expect(calls.at(-1)?.headers.authorization).toBe('Bearer usable-now');
    expect(onPersistFailure).toHaveBeenCalledOnce();
    expect(onPersistFailure).toHaveBeenCalledWith(row, persistError);
  });

  it('type=oauth2_refresh when the refresh itself fails: TOKEN_REFRESH_FAILED', async () => {
    const { deps } = mkDeps(
      {
        type: 'oauth2_refresh',
        refresh_token: 'rt',
        client_id: 'c',
        token_endpoint: 'https://oauth/token',
      },
      (call) =>
        call.url.includes('oauth/token')
          ? new Response('nope', { status: 400 })
          : okJsonRpc({})(call),
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'TOKEN_REFRESH_FAILED' });
  });
});

// ────────────────────────────────────────────────────────────────
// HTTP status classification
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — HTTP status classification', () => {
  it('releases an unread non-success response body', async () => {
    const cancel = vi.fn();
    const { deps } = mkDeps(
      { type: 'none' },
      () => new Response(new ReadableStream<Uint8Array>({ cancel }), {
        status: 503,
        statusText: 'Unavailable',
      }),
    );
    const handler = createConnectionMcpHandler(deps);

    await expect(handler(mkRow(), { tool: 'list' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('401 → OAUTH_EXPIRED', async () => {
    const { deps } = mkDeps(
      { type: 'bearer', token: 't' },
      () => new Response('{}', { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } }),
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
  });

  it('429 → API_RATE_LIMITED', async () => {
    const { deps } = mkDeps(
      { type: 'none' },
      () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'API_RATE_LIMITED' });
  });

  it('500 (read) → NETWORK_ERROR', async () => {
    const { deps } = mkDeps(
      { type: 'none' },
      () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'list' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('500 (write) → ACTION_DELIVERY_UNCERTAIN', async () => {
    const { deps } = mkDeps(
      { type: 'none' },
      () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'create' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });
});

// ────────────────────────────────────────────────────────────────
// Network errors + timeout
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — network errors + timeout', () => {
  it('network error (read) → NETWORK_ERROR', async () => {
    const fetchImpl = (async () => { throw new TypeError('connection refused'); }) as unknown as typeof fetch;
    const handler = createConnectionMcpHandler({
      decodeAuth: async () => ({ type: 'none' }),
      fetchImpl,
    });
    await expect(handler(mkRow(), { tool: 'list' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('network error (write) → ACTION_DELIVERY_UNCERTAIN', async () => {
    const fetchImpl = modernNegotiatingFetch(async () => {
      throw new TypeError('TLS failure');
    });
    const handler = createConnectionMcpHandler({
      decodeAuth: async () => ({ type: 'none' }),
      fetchImpl,
    });
    await expect(handler(mkRow(), { tool: 'create' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('timeout (read) → STEP_TIMEOUT', async () => {
    const fetchImpl = modernNegotiatingFetch(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          (err as Error & { name: string }).name = 'AbortError';
          reject(err);
        });
      });
    });
    const handler = createConnectionMcpHandler({
      decodeAuth: async () => ({ type: 'none' }),
      fetchImpl,
    });
    const start = Date.now();
    await expect(
      handler(mkRow(), { tool: 'list', timeout_ms: 100 }, mkCall({ risk_tier: 'read' })),
    ).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('keeps the timeout active while the SSE response body streams', async () => {
    const fetchImpl = modernNegotiatingFetch(async (_url: RequestInfo | URL, init?: RequestInit) => {
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
    });
    const handler = createConnectionMcpHandler({
      decodeAuth: async () => ({ type: 'none' }),
      fetchImpl,
    });

    await expect(handler(
      mkRow(),
      { tool: 'list', timeout_ms: 100 },
      mkCall({ risk_tier: 'read' }),
    )).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });
});

// ────────────────────────────────────────────────────────────────
// Pool semantics + idle teardown
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — pool semantics', () => {
  it('reuses one pool entry across calls to the same record', async () => {
    let serverNow = 1_700_000_000_000;
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({ ok: true }), {
      now: () => serverNow,
      idleTimeoutMs: 60_000,
    });
    const handler = createConnectionMcpHandler(deps);

    await handler(mkRow(), { tool: 'list' }, mkCall());
    serverNow += 1000;
    await handler(mkRow(), { tool: 'list' }, mkCall());
    serverNow += 1000;
    await handler(mkRow(), { tool: 'list' }, mkCall());
    // No assertion on internal pool state — behavioral test asserts
    // multiple back-to-back calls succeed without re-initialisation.
    // The spec's pool lifecycle is observable through reaping
    // (separate test below).
  });

  it('reaps idle entries based on idleTimeoutMs', async () => {
    let serverNow = 1_700_000_000_000;
    let fetchHits = 0;
    const { deps } = mkDeps({ type: 'none' }, () => {
      fetchHits++;
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }, {
      now: () => serverNow,
      idleTimeoutMs: 1_000,
    });
    const handler = createConnectionMcpHandler(deps);

    await handler(mkRow(), { tool: 'list' }, mkCall());
    expect(fetchHits).toBe(1);
    // Advance past idle threshold + dispatch again — entry should be
    // reaped + recreated. Behavior remains correct (fetch fires).
    serverNow += 5_000;
    await handler(mkRow(), { tool: 'list' }, mkCall());
    expect(fetchHits).toBe(2);
  });

  it('idleTimeoutMs default is MCP_CLIENT_IDLE_TIMEOUT_MS', async () => {
    expect(MCP_CLIENT_IDLE_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it('separate records get separate pool entries', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, okJsonRpc({}));
    const handler = createConnectionMcpHandler(deps);
    await handler(mkRow({ name: 'gh' }), { tool: 'list' }, mkCall());
    await handler(mkRow({ name: 'linear' }), { tool: 'list' }, mkCall());
    // Both succeed — pool independence verified through the URL not
    // colliding (each row's endpoint is the same in this test, but
    // pk differs so distinct entries are allocated).
    expect(calls).toHaveLength(4);
  });
});

// ────────────────────────────────────────────────────────────────
// Bytes telemetry
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — bytes telemetry', () => {
  it('calls ctx.setBytes with request + response envelope sizes', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({ items: ['a', 'b', 'c'] }));
    const handler = createConnectionMcpHandler(deps);
    const setBytes = vi.fn();
    const ctx: ConnectionHandlerCtx = { setBytes };
    await handler(mkRow(), { tool: 'list' }, mkCall(), ctx);
    expect(setBytes).toHaveBeenCalledTimes(1);
    const [bytesIn, bytesOut] = setBytes.mock.calls[0]!;
    expect(bytesOut).toBeGreaterThan(0);
    expect(bytesIn).toBeGreaterThan(0);
  });

  it('uses content-length header when present', async () => {
    const responseBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
    const { deps } = mkDeps(
      { type: 'none' },
      () => new Response(responseBody, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '999' },
      }),
    );
    const handler = createConnectionMcpHandler(deps);
    const setBytes = vi.fn();
    await handler(mkRow(), { tool: 'list' }, mkCall(), { setBytes });
    expect(setBytes).toHaveBeenCalledWith(999, expect.any(Number));
  });

  it('handler works without ctx (older callers)', async () => {
    const { deps } = mkDeps({ type: 'none' }, okJsonRpc({ ok: true }));
    const handler = createConnectionMcpHandler(deps);
    // No ctx arg — handler must not blow up.
    await expect(handler(mkRow(), { tool: 'list' }, mkCall())).resolves.toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────
// SSRF — redirect origin pinning (pinned to the enrolled endpoint)
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — SSRF redirect origin pinning', () => {
  it('refuses a cross-origin redirect with URL_REF_INVALID, never contacting the target', async () => {
    const { deps, calls } = mkDeps({ type: 'none' }, () =>
      new Response('', {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(mkRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'URL_REF_INVALID' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://mcp.example/server');
  });
});

// ────────────────────────────────────────────────────────────────
// WebSocket transport (D-125 §920) — real path via a mock connector
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — websocket transport', () => {
  it('falls back on a fresh socket to validated 2024-11-05 initialization', async () => {
    const { deps, ws } = wsDeps(
      { type: 'none' },
      () => ({ result: { ok: true } }),
      { legacy: true },
    );
    const handler = createConnectionMcpHandler(deps);

    await expect(handler(wsRow(), { tool: 'list' }, mkCall()))
      .resolves.toMatchObject({ status: 'ok' });

    expect(ws.connects).toHaveLength(2);
    expect(methodsOf(ws.sent)).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(ws.sent.find((frame) => frame.method === 'initialize')?.params)
      .toMatchObject({ protocolVersion: '2024-11-05' });
    expect(ws.sent.find((frame) => frame.method === 'tools/call')?.params)
      .toEqual({ name: 'list', arguments: {} });
  });

  it('does not open a legacy socket after a recognized modern protocol error', async () => {
    const { deps, ws } = wsDeps(
      { type: 'none' },
      () => ({ result: { ok: true } }),
      { discoverError: { code: -32021, message: 'Missing client capability' } },
    );
    const handler = createConnectionMcpHandler(deps);

    await expect(handler(wsRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(ws.connects).toHaveLength(1);
    expect(methodsOf(ws.sent)).toEqual(['server/discover']);
  });

  it('opens a socket, discovers the modern era, dispatches tools/call, returns the ok shape', async () => {
    const { deps, ws } = wsDeps(
      { type: 'bearer', token: 'ws-tok' },
      () => ({ result: { items: [1, 2, 3] } }),
    );
    const handler = createConnectionMcpHandler(deps);
    const result = await handler(wsRow(), { tool: 'list_repos' }, mkCall());
    // One socket opened to the enrolled wss endpoint.
    expect(ws.connects).toHaveLength(1);
    expect(ws.connects[0]!.url).toBe('wss://mcp.example/ws');
    expect(methodsOf(ws.sent)).toEqual(['server/discover', 'tools/call']);
    const toolFrame = ws.sent.find((f) => f.method === 'tools/call')!;
    expect(toolFrame.params).toMatchObject({
      name: 'list_repos',
      arguments: {},
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    });
    expect(result).toEqual({ status: 'ok', result: { items: [1, 2, 3] }, headers: undefined });
  });

  it('injects the bearer in the upgrade handshake header, never as a frame', async () => {
    const { deps, ws } = wsDeps(
      { type: 'bearer', token: 'ws-tok' },
      () => ({ result: {} }),
    );
    const handler = createConnectionMcpHandler(deps);
    await handler(wsRow(), { tool: 'list' }, mkCall());
    expect(ws.connects[0]!.headers.Authorization).toBe('Bearer ws-tok');
    // The token is in the handshake, not smuggled into any JSON-RPC frame.
    expect(JSON.stringify(ws.sent)).not.toContain('ws-tok');
  });

  it('type=query auth rides on the handshake url', async () => {
    const { deps, ws } = wsDeps(
      { type: 'query', param_name: 'api_key', value: 'k1' },
      () => ({ result: {} }),
    );
    const handler = createConnectionMcpHandler(deps);
    await handler(wsRow(), { tool: 'list' }, mkCall());
    expect(ws.connects[0]!.url).toContain('api_key=k1');
  });

  it('resource read over ws → resources/read JSON-RPC', async () => {
    const { deps, ws } = wsDeps(
      { type: 'none' },
      () => ({ result: { contents: [{ uri: 'file:///a.txt', text: 'hi' }] } }),
    );
    const handler = createConnectionMcpHandler(deps);
    const result = await handler(wsRow(), { resource: 'file:///a.txt' }, mkCall());
    const frame = ws.sent.find((f) => f.method === 'resources/read')!;
    expect(frame.params).toMatchObject({ uri: 'file:///a.txt' });
    expect(result).toMatchObject({ status: 'ok', result: { contents: [{ uri: 'file:///a.txt', text: 'hi' }] } });
  });

  it('resources_list over ws → resources/list JSON-RPC', async () => {
    const { deps, ws } = wsDeps(
      { type: 'none' },
      () => ({ result: { resources: [{ uri: 'file:///a' }] } }),
    );
    const handler = createConnectionMcpHandler(deps);
    await handler(wsRow(), { resources_list: true }, mkCall());
    expect(methodsOf(ws.sent)).toContain('resources/list');
  });

  it('maps a JSON-RPC error envelope to tool_error', async () => {
    const { deps } = wsDeps(
      { type: 'none' },
      () => ({ error: { code: -32602, message: 'Invalid params', data: { field: 'x' } } }),
    );
    const handler = createConnectionMcpHandler(deps);
    const result = await handler(wsRow(), { tool: 'create_issue' }, mkCall());
    expect(result).toEqual({
      status: 'tool_error',
      result: { code: -32602, message: 'Invalid params', data: { field: 'x' } },
      headers: undefined,
    });
  });

  it('maps MCP CallToolResult.isError to tool_error over websocket', async () => {
    const toolResult = {
      isError: true,
      content: [{ type: 'text', text: 'participant is inactive' }],
    };
    const { deps } = wsDeps({ type: 'none' }, () => ({ result: toolResult }));
    const handler = createConnectionMcpHandler(deps);

    await expect(handler(wsRow(), { tool: 'list_projects' }, mkCall()))
      .resolves.toEqual({ status: 'tool_error', result: toolResult, headers: undefined });
  });

  it('reuses one socket + one modern discovery across calls to the same record', async () => {
    const { deps, ws } = wsDeps({ type: 'none' }, () => ({ result: { ok: true } }));
    const handler = createConnectionMcpHandler(deps);
    await handler(wsRow(), { tool: 'list' }, mkCall());
    await handler(wsRow(), { tool: 'list' }, mkCall());
    await handler(wsRow(), { tool: 'list' }, mkCall());
    // One open; modern discovery sent exactly once; three tools/call frames.
    expect(ws.connects).toHaveLength(1);
    expect(ws.sent.filter((f) => f.method === 'server/discover')).toHaveLength(1);
    expect(ws.sent.filter((f) => f.method === 'initialize')).toHaveLength(0);
    expect(ws.sent.filter((f) => f.method === 'tools/call')).toHaveLength(3);
  });

  it('calls ctx.setBytes with request + response envelope sizes', async () => {
    const { deps } = wsDeps({ type: 'none' }, () => ({ result: { items: ['a', 'b'] } }));
    const handler = createConnectionMcpHandler(deps);
    const setBytes = vi.fn();
    await handler(wsRow(), { tool: 'list' }, mkCall(), { setBytes });
    expect(setBytes).toHaveBeenCalledTimes(1);
    const [bytesIn, bytesOut] = setBytes.mock.calls[0]!;
    expect(bytesIn).toBeGreaterThan(0);
    expect(bytesOut).toBeGreaterThan(0);
  });

  it('still applies the cached tool-list gate (MCP_TOOL_NOT_FOUND, no socket opened)', async () => {
    const { deps, ws } = wsDeps({ type: 'none' }, () => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    const row = wsRow({ health_json: JSON.stringify({ status: 'ok', tools: ['only_this'] }) });
    await expect(handler(row, { tool: 'missing' }, mkCall()))
      .rejects.toMatchObject({ code: 'MCP_TOOL_NOT_FOUND' });
    // The gate is upstream of the transport branch — no socket opened.
    expect(ws.connects).toHaveLength(0);
  });

  it('request timeout (read) → STEP_TIMEOUT', async () => {
    const { deps } = wsDeps({ type: 'none' }, () => ({ drop: true }));
    const handler = createConnectionMcpHandler(deps);
    const start = Date.now();
    await expect(handler(wsRow(), { tool: 'list', timeout_ms: 100 }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('connect timeout (read) → STEP_TIMEOUT', async () => {
    const { deps } = wsDeps({ type: 'none' }, () => ({ result: {} }), { hangConnect: true });
    const handler = createConnectionMcpHandler(deps);
    const start = Date.now();
    await expect(handler(wsRow(), { tool: 'list', timeout_ms: 100 }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('socket close mid-request (read) → NETWORK_ERROR', async () => {
    const { deps } = wsDeps({ type: 'none' }, () => ({ close: true }));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(wsRow(), { tool: 'list' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('socket close mid-request (write) → ACTION_DELIVERY_UNCERTAIN', async () => {
    const { deps } = wsDeps({ type: 'none' }, () => ({ close: true }));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(wsRow(), { tool: 'create' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('a dead socket is evicted + reopened on the next dispatch', async () => {
    // First call: responder closes the socket → NETWORK_ERROR. Second
    // call: a fresh responder succeeds → the handler must reconnect.
    let firstCall = true;
    const { deps, ws } = wsDeps({ type: 'none' }, () => {
      if (firstCall) { firstCall = false; return { close: true }; }
      return { result: { ok: true } };
    });
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(wsRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const result = await handler(wsRow(), { tool: 'list' }, mkCall());
    expect(result).toMatchObject({ status: 'ok' });
    expect(ws.connects).toHaveLength(2); // reconnected after the dead socket
  });

  it('connect failure (read) → NETWORK_ERROR', async () => {
    const { deps } = wsDeps({ type: 'none' }, () => ({ result: {} }), {
      failConnect: new Error('ECONNREFUSED'),
    });
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(wsRow(), { tool: 'list' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('connect failure (write) → ACTION_DELIVERY_UNCERTAIN', async () => {
    const { deps } = wsDeps({ type: 'none' }, () => ({ result: {} }), {
      failConnect: new Error('ECONNREFUSED'),
    });
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(wsRow(), { tool: 'create' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('initialize handshake failure → NETWORK_ERROR, and the next call reconnects', async () => {
    const { deps, ws } = wsDeps(
      { type: 'none' },
      () => ({ result: { ok: true } }),
      { legacy: true, initError: { code: -32000, message: 'no init' } },
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(wsRow(), { tool: 'list' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    // The failed-handshake socket was never pooled — a retry reconnects.
    await expect(handler(wsRow(), { tool: 'list' }, mkCall())).rejects.toBeDefined();
    expect(ws.connects.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a non-ws:// endpoint with IOVF, opening no socket', async () => {
    const { deps, ws } = wsDeps({ type: 'none' }, () => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    const row = wsRow({ config_json: '{"transport":"websocket","endpoint":"https://mcp.example/ws"}' });
    await expect(handler(row, { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(ws.connects).toHaveLength(0);
  });

  it('separate records get separate sockets', async () => {
    const { deps, ws } = wsDeps({ type: 'none' }, () => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    await handler(wsRow({ name: 'gh' }), { tool: 'list' }, mkCall());
    await handler(wsRow({ name: 'linear' }), { tool: 'list' }, mkCall());
    expect(ws.connects).toHaveLength(2);
  });

  // ── Codex review folds ──

  it('reopens the socket when the enrolled endpoint changes for the same record', async () => {
    // Same pk (name 'gh'), new endpoint (re-enrollment) → must not keep
    // talking to the old host. Closes the reuse-staleness gap.
    const { deps, ws } = wsDeps({ type: 'none' }, () => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    await handler(wsRow(), { tool: 'list' }, mkCall());
    await handler(
      wsRow({ config_json: '{"transport":"websocket","endpoint":"wss://mcp.example/v2"}' }),
      { tool: 'list' },
      mkCall(),
    );
    expect(ws.connects).toHaveLength(2);
    expect(ws.connects[1]!.url).toBe('wss://mcp.example/v2');
    expect(ws.handleCloses()).toBeGreaterThanOrEqual(1); // old socket closed, not leaked
  });

  it('the idle reaper does not tear down a ws session with an in-flight request', async () => {
    // record 'a' hangs a tool call (in-flight); a dispatch to record 'b'
    // runs the lazy reaper with `now` advanced past the idle window. The
    // hanging request must survive to its OWN timeout (STEP_TIMEOUT), not
    // be killed by the reaper closing its socket (which would surface
    // NETWORK_ERROR).
    let serverNow = 1_000_000;
    const { deps } = wsDeps(
      { type: 'none' },
      (frame) => ((frame.params as { name?: string })?.name === 'hang' ? { drop: true } : { result: {} }),
      {},
      { now: () => serverNow, idleTimeoutMs: 100 },
    );
    const handler = createConnectionMcpHandler(deps);
    const slow = handler(wsRow({ name: 'a' }), { tool: 'hang', timeout_ms: 300 }, mkCall({ risk_tier: 'read' }));
    await new Promise((r) => setTimeout(r, 25)); // let 'a' open + initialize + send the hang
    serverNow += 1_000; // advance past the 100ms idle window
    await handler(wsRow({ name: 'b' }), { tool: 'ok' }, mkCall()); // runs the reaper
    await expect(slow).rejects.toMatchObject({ code: 'STEP_TIMEOUT' }); // survived → timed out, not reaped
  });

  it('closes the underlying socket on a post-open error with no close event (no leak)', async () => {
    const { deps, ws } = wsDeps({ type: 'none' }, () => ({ errorSocket: true }));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(wsRow(), { tool: 'list' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(ws.handleCloses()).toBeGreaterThanOrEqual(1);
  });
});

// ────────────────────────────────────────────────────────────────
// stdio transport (D-125 §921) — real path via a mock spawner
// ────────────────────────────────────────────────────────────────

describe('connection.mcp handler — stdio transport', () => {
  it('spawns a child, discovers the modern era, dispatches tools/call, returns the ok shape', async () => {
    const { deps, stdio } = stdioDeps(() => ({ result: { items: [1, 2, 3] } }));
    const handler = createConnectionMcpHandler(deps);
    const result = await handler(stdioRow(), { tool: 'list_repos' }, mkCall());
    // One child spawned with the enrolled command + args.
    expect(stdio.spawns).toHaveLength(1);
    expect(stdio.spawns[0]).toMatchObject({ command: '/usr/local/bin/mcp-server', args: ['--stdio'] });
    expect(methodsOf(stdio.sent)).toEqual(['server/discover', 'tools/call']);
    const toolFrame = stdio.sent.find((f) => f.method === 'tools/call')!;
    expect(toolFrame.params).toMatchObject({
      name: 'list_repos',
      arguments: {},
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    });
    expect(result).toEqual({ status: 'ok', result: { items: [1, 2, 3] }, headers: undefined });
  });

  it('passes config.env + config.args through to the spawn spec', async () => {
    const { deps, stdio } = stdioDeps(() => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    const row = stdioRow({
      config_json: '{"transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/data"],"env":{"API_KEY":"k1"}}',
    });
    await handler(row, { tool: 'list' }, mkCall());
    expect(stdio.spawns[0]).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
      env: { API_KEY: 'k1' },
    });
  });

  it('resource read over stdio → resources/read JSON-RPC', async () => {
    const { deps, stdio } = stdioDeps(() => ({ result: { contents: [{ uri: 'file:///a', text: 'hi' }] } }));
    const handler = createConnectionMcpHandler(deps);
    const result = await handler(stdioRow(), { resource: 'file:///a' }, mkCall());
    const frame = stdio.sent.find((f) => f.method === 'resources/read')!;
    expect(frame.params).toMatchObject({ uri: 'file:///a' });
    expect(result).toMatchObject({ status: 'ok', result: { contents: [{ uri: 'file:///a', text: 'hi' }] } });
  });

  it('maps a JSON-RPC error envelope to tool_error', async () => {
    const { deps } = stdioDeps(() => ({ error: { code: -32602, message: 'bad' } }));
    const handler = createConnectionMcpHandler(deps);
    const result = await handler(stdioRow(), { tool: 'x' }, mkCall());
    expect(result).toEqual({ status: 'tool_error', result: { code: -32602, message: 'bad' }, headers: undefined });
  });

  it('maps MCP CallToolResult.isError to tool_error over stdio', async () => {
    const toolResult = {
      isError: true,
      content: [{ type: 'text', text: 'participant is inactive' }],
    };
    const { deps } = stdioDeps(() => ({ result: toolResult }));
    const handler = createConnectionMcpHandler(deps);

    await expect(handler(stdioRow(), { tool: 'list_projects' }, mkCall()))
      .resolves.toEqual({ status: 'tool_error', result: toolResult, headers: undefined });
  });

  it('reuses one child + one modern discovery across calls to the same record', async () => {
    const { deps, stdio } = stdioDeps(() => ({ result: { ok: true } }));
    const handler = createConnectionMcpHandler(deps);
    await handler(stdioRow(), { tool: 'list' }, mkCall());
    await handler(stdioRow(), { tool: 'list' }, mkCall());
    await handler(stdioRow(), { tool: 'list' }, mkCall());
    expect(stdio.spawns).toHaveLength(1);
    expect(stdio.sent.filter((f) => f.method === 'server/discover')).toHaveLength(1);
    expect(stdio.sent.filter((f) => f.method === 'initialize')).toHaveLength(0);
    expect(stdio.sent.filter((f) => f.method === 'tools/call')).toHaveLength(3);
  });

  it('respawns when the enrolled command changes for the same record', async () => {
    const { deps, stdio } = stdioDeps(() => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    await handler(stdioRow(), { tool: 'list' }, mkCall());
    await handler(
      stdioRow({ config_json: '{"transport":"stdio","command":"/usr/local/bin/mcp-server-v2"}' }),
      { tool: 'list' },
      mkCall(),
    );
    expect(stdio.spawns).toHaveLength(2);
    expect(stdio.spawns[1]!.command).toBe('/usr/local/bin/mcp-server-v2');
    expect(stdio.handleCloses()).toBeGreaterThanOrEqual(1); // old child killed, not leaked
  });

  it('a concurrent re-enrollment opens its own child, not the stale in-flight one', async () => {
    // Two concurrent dispatches to the same record with DIFFERENT commands.
    // The second must spawn its OWN command, never join the first's in-flight
    // spawn (which would hand back a child pointed at the old command).
    const { deps, stdio } = stdioDeps(() => ({ result: { ok: true } }));
    const handler = createConnectionMcpHandler(deps);
    const p1 = handler(stdioRow({ config_json: '{"transport":"stdio","command":"/old"}' }), { tool: 'a' }, mkCall());
    const p2 = handler(stdioRow({ config_json: '{"transport":"stdio","command":"/new"}' }), { tool: 'b' }, mkCall());
    const [, r2] = await Promise.allSettled([p1, p2]);
    // Both commands spawned (no false-join); the latest target wins.
    expect(stdio.spawns.map((s) => s.command).sort()).toEqual(['/new', '/old']);
    expect(r2.status).toBe('fulfilled');
  });

  it('calls ctx.setBytes with request + response envelope sizes', async () => {
    const { deps } = stdioDeps(() => ({ result: { items: ['a'] } }));
    const handler = createConnectionMcpHandler(deps);
    const setBytes = vi.fn();
    await handler(stdioRow(), { tool: 'list' }, mkCall(), { setBytes });
    expect(setBytes).toHaveBeenCalledTimes(1);
    const [bytesIn, bytesOut] = setBytes.mock.calls[0]!;
    expect(bytesIn).toBeGreaterThan(0);
    expect(bytesOut).toBeGreaterThan(0);
  });

  it('request timeout (read) → STEP_TIMEOUT', async () => {
    const { deps } = stdioDeps(() => ({ drop: true }));
    const handler = createConnectionMcpHandler(deps);
    const start = Date.now();
    await expect(handler(stdioRow(), { tool: 'list', timeout_ms: 100 }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('spawn timeout (read) → STEP_TIMEOUT', async () => {
    const { deps } = stdioDeps(() => ({ result: {} }), { hangSpawn: true });
    const handler = createConnectionMcpHandler(deps);
    const start = Date.now();
    await expect(handler(stdioRow(), { tool: 'list', timeout_ms: 100 }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('child exit mid-request (read) → NETWORK_ERROR', async () => {
    const { deps } = stdioDeps(() => ({ close: true }));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(stdioRow(), { tool: 'list' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('child exit mid-request (write) → ACTION_DELIVERY_UNCERTAIN', async () => {
    const { deps } = stdioDeps(() => ({ close: true }));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(stdioRow(), { tool: 'create' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('a dead child is evicted + respawned on the next dispatch', async () => {
    let firstCall = true;
    const { deps, stdio } = stdioDeps(() => {
      if (firstCall) { firstCall = false; return { close: true }; }
      return { result: { ok: true } };
    });
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(stdioRow(), { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const result = await handler(stdioRow(), { tool: 'list' }, mkCall());
    expect(result).toMatchObject({ status: 'ok' });
    expect(stdio.spawns).toHaveLength(2);
  });

  it('spawn failure (read) → NETWORK_ERROR', async () => {
    const { deps } = stdioDeps(() => ({ result: {} }), { failSpawn: new Error('ENOENT') });
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(stdioRow(), { tool: 'list' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('spawn failure (write) → ACTION_DELIVERY_UNCERTAIN', async () => {
    const { deps } = stdioDeps(() => ({ result: {} }), { failSpawn: new Error('EACCES') });
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(stdioRow(), { tool: 'create' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('initialize handshake failure → NETWORK_ERROR, and the next call respawns', async () => {
    const { deps, stdio } = stdioDeps(
      () => ({ result: { ok: true } }),
      { legacy: true, initError: { code: -32000, message: 'no init' } },
    );
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(stdioRow(), { tool: 'list' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(handler(stdioRow(), { tool: 'list' }, mkCall())).rejects.toBeDefined();
    expect(stdio.spawns.length).toBeGreaterThanOrEqual(2);
  });

  it('closes the child on a post-spawn error with no exit event (no leak)', async () => {
    const { deps, stdio } = stdioDeps(() => ({ errorSocket: true }));
    const handler = createConnectionMcpHandler(deps);
    await expect(handler(stdioRow(), { tool: 'list' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(stdio.handleCloses()).toBeGreaterThanOrEqual(1);
  });

  it('separate records get separate children', async () => {
    const { deps, stdio } = stdioDeps(() => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    await handler(stdioRow({ name: 'fs' }), { tool: 'list' }, mkCall());
    await handler(stdioRow({ name: 'git' }), { tool: 'list' }, mkCall());
    expect(stdio.spawns).toHaveLength(2);
  });

  // ── command-shape validation (no socket / spawn on a bad config) ──

  it('throws IOVF when config.command is missing, spawning nothing', async () => {
    const { deps, stdio } = stdioDeps(() => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    const row = stdioRow({ config_json: '{"transport":"stdio"}' });
    await expect(handler(row, { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(stdio.spawns).toHaveLength(0);
  });

  it('throws IOVF for a relative-with-slash command (cwd-dependent)', async () => {
    const { deps, stdio } = stdioDeps(() => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    const row = stdioRow({ config_json: '{"transport":"stdio","command":"./mcp-server"}' });
    await expect(handler(row, { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(stdio.spawns).toHaveLength(0);
  });

  it('allows a bare PATH-resolved command name (npx / uvx)', async () => {
    const { deps, stdio } = stdioDeps(() => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    const row = stdioRow({ config_json: '{"transport":"stdio","command":"npx"}' });
    await expect(handler(row, { tool: 'list' }, mkCall())).resolves.toBeDefined();
    expect(stdio.spawns[0]!.command).toBe('npx');
  });

  it('throws IOVF when config.args is not a string array', async () => {
    const { deps } = stdioDeps(() => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    const row = stdioRow({ config_json: '{"transport":"stdio","command":"/x","args":[1,2]}' });
    await expect(handler(row, { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF when config.env is not a string map', async () => {
    const { deps } = stdioDeps(() => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    const row = stdioRow({ config_json: '{"transport":"stdio","command":"/x","env":{"K":5}}' });
    await expect(handler(row, { tool: 'list' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('strips prototype-pollution keys from config.env before spawn', async () => {
    const { deps, stdio } = stdioDeps(() => ({ result: {} }));
    const handler = createConnectionMcpHandler(deps);
    const row = stdioRow({
      config_json: '{"transport":"stdio","command":"/x","env":{"__proto__":"bad","SAFE":"ok"}}',
    });
    await handler(row, { tool: 'list' }, mkCall());
    expect(stdio.spawns[0]!.env).toEqual({ SAFE: 'ok' });
  });
});
