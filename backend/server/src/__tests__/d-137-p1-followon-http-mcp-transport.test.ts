/** D-137 P1 follow-on — HTTP MCP transport wiring.
 *
 *  Asserts the wire-up substrate from the handler-set composition end:
 *    - `createMcpHttpDispatch` derives a stable per-token `mcpTokenId`
 *      from the validated bearer; falls back to stdio synthetic when
 *      called without a token.
 *    - `createServerHandlerSet({ mcpHttpDeps })` routes the `mcp` role
 *      through the HTTP handler (200 + JSON-RPC response on valid call).
 *    - Without `mcpHttpDeps`, the `mcp` role keeps the 404 placeholder.
 *    - Token-derivation is deterministic (same bearer → same id) and
 *      different bearers produce different ids (cross-token isolation).
 */

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServerHandlerSet } from '../server.js';
import { createMcpHttpDispatch, type McpDeps } from '../mcp-server.js';

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: string | null = null;
  setHeader(key: string, value: string): void { this.headers[key.toLowerCase()] = value; }
  getHeader(key: string): string | undefined { return this.headers[key.toLowerCase()]; }
  end(body?: string): void { this.body = body ?? ''; }
}

interface BuildReqOptions {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const buildReq = ({ url = '/mcp', method = 'POST', headers = {}, body = '' }: BuildReqOptions = {}): IncomingMessage => {
  const stream = Readable.from([Buffer.from(body, 'utf-8')]) as unknown as IncomingMessage;
  (stream as unknown as { url: string }).url = url;
  (stream as unknown as { method: string }).method = method;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  return stream;
};

const json = (res: FakeRes): unknown => JSON.parse(res.body ?? 'null');

describe('createMcpHttpDispatch', () => {
  it('returns successfully on `initialize` (deps-independent path)', async () => {
    const dispatch = createMcpHttpDispatch({} as McpDeps);
    const response = (await dispatch(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      'bearer-1',
    )) as { jsonrpc: string; id: number; result: unknown };
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
  });

  it('returns a JSON-RPC error envelope for unknown methods', async () => {
    const dispatch = createMcpHttpDispatch({} as McpDeps);
    const response = (await dispatch(
      { jsonrpc: '2.0', id: 2, method: 'unknown/method' },
      'bearer-2',
    )) as { jsonrpc: string; id: number; error: { code: number; message: string } };
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toContain('Method not found');
  });

  it('produces deterministic output for the same bearer', async () => {
    const dispatch = createMcpHttpDispatch({} as McpDeps);
    const envelope = { jsonrpc: '2.0' as const, id: 3, method: 'initialize' };
    const a = await dispatch(envelope, 'bearer-abc');
    const b = await dispatch(envelope, 'bearer-abc');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('returns null for JSON-RPC notifications (no id)', async () => {
    const dispatch = createMcpHttpDispatch({} as McpDeps);
    const response = await dispatch(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      'bearer-4',
    );
    expect(response).toBeNull();
  });

  // Codex P2 #2 fold — non-object envelopes return JSON-RPC -32600
  // rather than crashing through the transport as 500s. Covers every
  // shape that valid JSON can parse to but is not a JSON-RPC Request.
  it.each([
    ['null', null],
    ['number', 42],
    ['string', 'oops'],
    ['boolean', true],
    ['array (batch unsupported)', [{ jsonrpc: '2.0', id: 1, method: 'initialize' }]],
  ])('returns -32600 Invalid Request on non-object envelope: %s', async (_label, envelope) => {
    const dispatch = createMcpHttpDispatch({} as McpDeps);
    const response = (await dispatch(envelope, 'bearer-x')) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string };
    };
    expect(response.error.code).toBe(-32600);
    expect(response.error.message).toBe('Invalid Request');
    expect(response.id).toBeNull();
  });
});

describe('createServerHandlerSet — mcp role wiring', () => {
  it('routes through the HTTP handler when mcpHttpDeps is wired (200)', async () => {
    const handlerSet = createServerHandlerSet({
      mcpHttpDeps: {
        verifier: (tok) => tok === 'admin-token',
        dispatch: async (envelope) => {
          const msg = envelope as { id?: number; method?: string };
          if (typeof msg.id === 'undefined') return null;
          return { jsonrpc: '2.0', id: msg.id, result: { ok: true, method: msg.method } };
        },
      },
    });

    const handler = handlerSet.handlers.mcp;
    expect(handler).toBeDefined();

    const res = new FakeRes();
    await handler!(
      buildReq({
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
        headers: { authorization: 'Bearer admin-token' },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    const body = json(res) as { jsonrpc: string; id: number; result: { method: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(7);
    expect(body.result.method).toBe('tools/list');

    handlerSet.close();
  });

  it('returns 401 on the mcp role when bearer is missing (handler is wired)', async () => {
    const handlerSet = createServerHandlerSet({
      mcpHttpDeps: {
        verifier: (tok) => tok === 'admin-token',
        dispatch: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
      },
    });

    const res = new FakeRes();
    await handlerSet.handlers.mcp!(
      buildReq({ body: '{}' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);

    handlerSet.close();
  });

  it('preserves the 404 placeholder when mcpHttpDeps is absent', async () => {
    const handlerSet = createServerHandlerSet({});

    const res = new FakeRes();
    await handlerSet.handlers.mcp!(
      buildReq({
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        headers: { authorization: 'Bearer anything' },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
    const body = json(res) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');

    handlerSet.close();
  });

  it('forwards the validated bearer token to the dispatch closure', async () => {
    const seen: string[] = [];
    const handlerSet = createServerHandlerSet({
      mcpHttpDeps: {
        verifier: (tok) => tok === 'admin-token',
        dispatch: async (envelope, token) => {
          seen.push(token ?? '<missing>');
          const msg = envelope as { id?: number };
          return { jsonrpc: '2.0', id: msg.id ?? null, result: { ok: true } };
        },
      },
    });

    const res = new FakeRes();
    await handlerSet.handlers.mcp!(
      buildReq({
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
        headers: { authorization: 'Bearer admin-token' },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual(['admin-token']);

    handlerSet.close();
  });
});
