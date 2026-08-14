/** D-148 P6 — MCP port handler: bearer + 60/min rate + JSON-RPC dispatch. */

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createRateLimiter, type RateLimiter } from '../ports/common/rate-limit.js';
import {
  createMcpPortHandler,
  MCP_MAX_CONCURRENT_VERIFICATIONS,
  MCP_MAX_IN_FLIGHT_GLOBAL,
  MCP_MAX_IN_FLIGHT_PER_TOKEN,
} from '../ports/mcp/handler.js';

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: string | null = null;
  destroyed = false;
  writableEnded = false;
  setHeader(key: string, value: string): void { this.headers[key.toLowerCase()] = value; }
  getHeader(key: string): string | undefined { return this.headers[key.toLowerCase()]; }
  flushHeaders(): void {}
  write(body: string): boolean {
    this.body = `${this.body ?? ''}${body}`;
    return true;
  }
  once(): this { return this; }
  end(body?: string): void {
    if (body !== undefined) this.body = `${this.body ?? ''}${body}`;
    else if (this.body === null) this.body = '';
    this.writableEnded = true;
  }
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

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
};

describe('createMcpPortHandler', () => {
  const buildHandler = (overrides: { capacity?: number } = {}) => {
    let t = 0;
    const limiter = createRateLimiter({
      capacity: overrides.capacity ?? 60,
      refill_window_ms: 60_000,
      now: () => t,
    });
    const dispatch = async (envelope: unknown): Promise<unknown> => {
      const msg = envelope as { id?: number; method?: string };
      if (typeof msg.id === 'undefined') return null; // notification
      if (msg.method === 'missing/method') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Method not found' },
        };
      }
      return { jsonrpc: '2.0', id: msg.id, result: { ok: true, method: msg.method } };
    };
    const handler = createMcpPortHandler({
      verifier: (tok) => tok === 'mcp-1',
      limiter,
      dispatch,
      // Isolate the per-TOKEN tests from the (tighter) per-IP default burst:
      // these fixtures fire >20 calls from one socket-less 'unknown' IP to
      // exercise the per-token quota, so give them a generous per-IP budget.
      per_ip_limiter: createRateLimiter({ capacity: 100_000, refill_window_ms: 60_000, now: () => t }),
    });
    return { handler, advance: (ms: number) => { t += ms; } };
  };

  it('returns 200 + JSON-RPC response on a valid call', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        headers: { authorization: 'Bearer mcp-1' },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    const body = json(res) as { jsonrpc: string; id: number; result: { method: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result.method).toBe('tools/list');
  });

  it('accepts a matching modern protocol header and request metadata', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
        headers: {
          authorization: 'Bearer mcp-1',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/list',
        },
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
  });

  it('returns HTTP 404 with -32601 for an unknown modern method', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 22,
          method: 'missing/method',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
        headers: {
          authorization: 'Bearer mcp-1',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'missing/method',
        },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
    expect((json(res) as { error: { code: number } }).error.code).toBe(-32601);
  });

  it('rejects a mismatched browser Origin before dispatch', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        headers: {
          authorization: 'Bearer mcp-1',
          host: 'mcp.example.test',
          origin: 'https://attacker.example',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(403);
  });

  it('returns HTTP 400 when modern metadata has no matching protocol header', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
        headers: { authorization: 'Bearer mcp-1' },
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(400);
    expect((json(res) as { error: { code: number } }).error.code).toBe(-32020);
  });

  it('returns HTTP 400 with supported versions for an unknown revision', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2099-01-01',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
        headers: {
          authorization: 'Bearer mcp-1',
          'mcp-protocol-version': '2099-01-01',
        },
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(400);
    expect((json(res) as { error: { code: number; data: { supported: string[] } } }).error)
      .toMatchObject({
        code: -32022,
        data: { supported: ['2026-07-28', '2024-11-05'] },
      });
  });

  it('returns HTTP 400 when modern method routing headers are missing', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
        headers: {
          authorization: 'Bearer mcp-1',
          'mcp-protocol-version': '2026-07-28',
        },
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(400);
    expect((json(res) as { error: { code: number } }).error.code).toBe(-32020);
  });

  it('validates the modern Mcp-Name header against tools/call params', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'search',
            arguments: {},
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
        headers: {
          authorization: 'Bearer mcp-1',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'wrong-tool',
        },
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(400);
    expect((json(res) as { error: { code: number } }).error.code).toBe(-32020);
  });

  it('decodes a base64-sentinel Mcp-Name before comparing it to the body', async () => {
    // The spec requires servers to DECODE an encoded `Mcp-Name` before
    // comparing it to the body value. Comparing our own re-encoded form
    // instead rejects any conforming client whose encoding choice differs
    // from ours — the value below is plain ASCII, so Recued would not encode
    // it, but a client is free to.
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'get_weather',
            arguments: {},
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
        headers: {
          authorization: 'Bearer mcp-1',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': '=?base64?Z2V0X3dlYXRoZXI=?=',
        },
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
  });

  it('still rejects an encoded Mcp-Name that decodes to the wrong tool', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: {
            name: 'get_weather',
            arguments: {},
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
        headers: {
          authorization: 'Bearer mcp-1',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          // base64 of 'delete_everything'
          'mcp-name': '=?base64?ZGVsZXRlX2V2ZXJ5dGhpbmc=?=',
        },
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(400);
    expect((json(res) as { error: { code: number } }).error.code).toBe(-32020);
  });

  it('400s a modern request missing the required clientCapabilities', async () => {
    // `clientCapabilities` is REQUIRED per request; the spec is explicit that
    // on HTTP the malformed-request status MUST be 400. This returned 200
    // beside the -32602 body, which a dual-era client never inspects — it only
    // reads bodies on a 4xx.
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/list',
          params: {
            _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
          },
        }),
        headers: {
          authorization: 'Bearer mcp-1',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/list',
        },
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(400);
    expect((json(res) as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('400s a protocol error the DISPATCHER raised, not just ones it caught', async () => {
    // A legacy-shaped request (no header, no _meta) skips this door's own
    // validation entirely, so an UnsupportedProtocolVersionError from the
    // dispatcher used to ride out on a 200. The HTTP status for a
    // protocol-defined error is the transport's obligation either way.
    let t = 0;
    const handler = createMcpPortHandler({
      verifier: (tok) => tok === 'mcp-1',
      limiter: createRateLimiter({ capacity: 60, refill_window_ms: 60_000, now: () => t }),
      per_ip_limiter: createRateLimiter({ capacity: 1000, refill_window_ms: 60_000, now: () => t }),
      dispatch: async (envelope) => ({
        jsonrpc: '2.0',
        id: (envelope as { id?: number }).id,
        error: {
          code: -32022,
          message: 'server/discover requires modern MCP request metadata.',
          data: { supported: ['2026-07-28', '2024-11-05'] },
        },
      }),
    });
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'server/discover' }),
        headers: { authorization: 'Bearer mcp-1' },
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(400);
    expect((json(res) as { error: { code: number } }).error.code).toBe(-32022);
  });

  it('returns 202 on accepted JSON-RPC notifications (no id)', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({ jsonrpc: '2.0', method: 'cancel' }),
        headers: { authorization: 'Bearer mcp-1' },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(202);
  });

  it('returns 401 when bearer is missing', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({ body: '{}' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when bearer is invalid', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({ body: '{}', headers: { authorization: 'Bearer wrong' } }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
  });

  it('opens the legacy 2024 HTTP+SSE endpoint on GET', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({ method: 'GET', headers: { authorization: 'Bearer mcp-1' } }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toMatch(/^event: endpoint\ndata: \/mcp\?sessionId=/);
  });

  it('delivers legacy POST responses on the authenticated SSE session', async () => {
    const { handler } = buildHandler();
    const stream = new FakeRes();
    await handler(
      buildReq({ method: 'GET', headers: { authorization: 'Bearer mcp-1' } }),
      stream as unknown as ServerResponse,
    );
    const endpoint = /data: ([^\n]+)/.exec(stream.body ?? '')?.[1];
    expect(endpoint).toBeTruthy();

    const post = new FakeRes();
    await handler(
      buildReq({
        url: endpoint,
        headers: { authorization: 'Bearer mcp-1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize' }),
      }),
      post as unknown as ServerResponse,
    );
    expect(post.statusCode).toBe(202);
    expect(stream.body).toContain('event: message');
    expect(stream.body).toContain('"id":9');
  });

  it('returns 405 on unsupported methods', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({ method: 'PATCH', headers: { authorization: 'Bearer mcp-1' } }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(405);
  });

  it('returns 200 on /health without auth', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({ url: '/health', method: 'GET' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 on invalid JSON', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        body: 'not-json',
        headers: { authorization: 'Bearer mcp-1' },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
    expect((json(res) as { error: { code: string } }).error.code).toBe('invalid_json');
  });

  // Codex P2 #1 fold — unknown subpaths under the role's prefix
  // (`/mcp/typo`, `/mcp/foo/bar`) reach the handler via the path
  // router's prefix match. They MUST 404 BEFORE auth so probes
  // can't fingerprint the role surface via 401/405 leakage.
  it.each([
    ['POST /mcp/typo', 'POST', '/mcp/typo'],
    ['GET /mcp/typo', 'GET', '/mcp/typo'],
    ['POST /mcp/foo/bar', 'POST', '/mcp/foo/bar'],
    ['POST /mcp/catalog (no GET, valid bearer)', 'POST', '/mcp/catalog'],
  ])('returns 404 on unknown subpath BEFORE auth: %s', async (_label, method, url) => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({
        method,
        url,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        headers: { authorization: 'Bearer mcp-1' },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body ?? 'null') as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('rejects unknown subpath without bearer (no fingerprint via 401)', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({ method: 'POST', url: '/mcp/typo', body: '{}' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
  });

  // SSRF/DoS hardening — the cli/client-token verifier runs a full Argon2id
  // hash on EVERY attempt (constant-time discipline), so a token-unknown
  // flood would force unbounded CPU/RAM work. The per-IP pre-auth throttle
  // sits BEFORE the verifier and caps that. Mutation-verify: once the per-IP
  // budget is spent, further requests 429 WITHOUT the verifier running.
  it('per-IP throttle 429s BEFORE the verifier runs (bounds the Argon2id flood)', async () => {
    let t = 0;
    let verifierCalls = 0;
    const perIp = createRateLimiter({ capacity: 2, refill_window_ms: 60_000, now: () => t });
    const handler = createMcpPortHandler({
      verifier: () => { verifierCalls += 1; return false; }, // every bearer "unknown"
      limiter: createRateLimiter({ capacity: 60, refill_window_ms: 60_000, now: () => t }),
      dispatch: async () => null,
      per_ip_limiter: perIp,
    });
    const fire = async (): Promise<number> => {
      const res = new FakeRes();
      await handler(
        buildReq({ body: '{}', headers: { authorization: 'Bearer unknown-flood' } }),
        res as unknown as ServerResponse,
      );
      return res.statusCode;
    };
    // capacity 2 → first two reach the verifier (401 invalid); third is
    // refused at the IP gate (429) and never touches the verifier.
    expect(await fire()).toBe(401);
    expect(await fire()).toBe(401);
    expect(await fire()).toBe(429);
    expect(verifierCalls).toBe(2);
  });

  it('bounds concurrent memory-hard bearer verifications across source IPs', async () => {
    const gates = [deferred<boolean>(), deferred<boolean>()];
    let verifierCalls = 0;
    const handler = createMcpPortHandler({
      verifier: () => gates[verifierCalls++]!.promise,
      limiter: createRateLimiter({ capacity: 100, refill_window_ms: 60_000 }),
      per_ip_limiter: createRateLimiter({ capacity: 100, refill_window_ms: 60_000 }),
      dispatch: async () => null,
      max_concurrent_verifications: 2,
    });
    const fire = (token: string) => {
      const res = new FakeRes();
      const pending = handler(
        buildReq({ body: '{}', headers: { authorization: `Bearer ${token}` } }),
        res as unknown as ServerResponse,
      );
      return { pending, res };
    };

    const first = fire('one');
    const second = fire('two');
    await flush();
    const refused = fire('three');
    await refused.pending;
    expect(refused.res.statusCode).toBe(503);
    expect((json(refused.res) as { error: { code: string } }).error.code)
      .toBe('mcp_overloaded');
    expect(verifierCalls).toBe(2);

    gates[0].resolve(false);
    gates[1].resolve(false);
    await Promise.all([first.pending, second.pending]);
  });

  it('bounds retained dispatches globally and per bearer, then releases slots', async () => {
    const dispatchGates = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
    let dispatchCalls = 0;
    const handler = createMcpPortHandler({
      verifier: () => true,
      limiter: createRateLimiter({ capacity: 100, refill_window_ms: 60_000 }),
      per_ip_limiter: createRateLimiter({ capacity: 100, refill_window_ms: 60_000 }),
      dispatch: () => dispatchGates[dispatchCalls++]!.promise,
      max_in_flight_global: 2,
      max_in_flight_per_token: 1,
    });
    const fire = (token: string, id: number) => {
      const res = new FakeRes();
      const pending = handler(
        buildReq({
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call' }),
          headers: { authorization: `Bearer ${token}` },
        }),
        res as unknown as ServerResponse,
      );
      return { pending, res };
    };

    const first = fire('token-a', 1);
    await flush();
    const sameToken = fire('token-a', 2);
    await sameToken.pending;
    expect(sameToken.res.statusCode).toBe(503);

    const second = fire('token-b', 3);
    await flush();
    const globalOverflow = fire('token-c', 4);
    await globalOverflow.pending;
    expect(globalOverflow.res.statusCode).toBe(503);
    expect(dispatchCalls).toBe(2);

    dispatchGates[0].resolve({ jsonrpc: '2.0', id: 1, result: {} });
    await first.pending;
    const admittedAfterRelease = fire('token-c', 5);
    await flush();
    expect(dispatchCalls).toBe(3);
    dispatchGates[1].resolve({ jsonrpc: '2.0', id: 3, result: {} });
    dispatchGates[2].resolve({ jsonrpc: '2.0', id: 5, result: {} });
    await Promise.all([second.pending, admittedAfterRelease.pending]);
    expect(admittedAfterRelease.res.statusCode).toBe(200);
  });

  it('enforces a verified bearer authored tier below the transport ceiling', async () => {
    const dispatchGates = [deferred<unknown>(), deferred<unknown>()];
    let dispatchCalls = 0;
    const resolvedTokens: string[] = [];
    const handler = createMcpPortHandler({
      verifier: () => true,
      limiter: createRateLimiter({ capacity: 100, refill_window_ms: 60_000 }),
      per_ip_limiter: createRateLimiter({ capacity: 100, refill_window_ms: 60_000 }),
      dispatch: () => dispatchGates[dispatchCalls++]!.promise,
      max_in_flight_per_token: 10,
      resolve_concurrency_limit: (token) => {
        resolvedTokens.push(token);
        return 1;
      },
    });
    const fire = (id: number) => {
      const res = new FakeRes();
      const pending = handler(
        buildReq({
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call' }),
          headers: { authorization: 'Bearer tiered-token' },
        }),
        res as unknown as ServerResponse,
      );
      return { pending, res };
    };

    const first = fire(1);
    await flush();
    const overflow = fire(2);
    await flush();
    // Settle both possible dispatch branches before asserting so reverting the
    // authored-tier guard produces a prompt red, not an orphaned hung promise.
    dispatchGates[0].resolve({ jsonrpc: '2.0', id: 1, result: {} });
    dispatchGates[1].resolve({ jsonrpc: '2.0', id: 2, result: {} });
    await Promise.all([first.pending, overflow.pending]);
    expect(overflow.res.statusCode).toBe(503);
    expect(dispatchCalls).toBe(1);

    const afterRelease = fire(3);
    await afterRelease.pending;
    expect(dispatchCalls).toBe(2);
    expect(afterRelease.res.statusCode).toBe(200);
    expect(resolvedTokens).toEqual([
      'tiered-token',
      'tiered-token',
      'tiered-token',
    ]);
  });

  it('publishes conservative default concurrency ceilings', () => {
    expect(MCP_MAX_CONCURRENT_VERIFICATIONS).toBe(8);
    expect(MCP_MAX_IN_FLIGHT_GLOBAL).toBe(64);
    expect(MCP_MAX_IN_FLIGHT_PER_TOKEN).toBe(16);
  });

  it('keys the per-token limiter on a hash, never the plaintext bearer', async () => {
    const seenKeys: string[] = [];
    const recordingLimiter: RateLimiter = {
      consume: (key) => { seenKeys.push(key); return { allowed: true, remaining: 59, reset_at: 0 }; },
      reset: () => {},
      clear: () => {},
    };
    const handler = createMcpPortHandler({
      verifier: (tok) => tok === 'mcp-secret-bearer',
      limiter: recordingLimiter,
      dispatch: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    });
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        headers: { authorization: 'Bearer mcp-secret-bearer' },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    // The per-token limiter key must not retain the plaintext bearer.
    expect(seenKeys.some((k) => k.includes('mcp-secret-bearer'))).toBe(false);
    expect(seenKeys.some((k) => k.startsWith('mcp:'))).toBe(true);
  });

  it('emits 429 after 60 calls inside the window', async () => {
    const { handler } = buildHandler({ capacity: 60 });
    for (let i = 0; i < 60; i += 1) {
      const res = new FakeRes();
      await handler(
        buildReq({
          body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' }),
          headers: { authorization: 'Bearer mcp-1' },
        }),
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(200);
    }
    const res = new FakeRes();
    await handler(
      buildReq({
        body: JSON.stringify({ jsonrpc: '2.0', id: 61, method: 'tools/list' }),
        headers: { authorization: 'Bearer mcp-1' },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(429);
    expect(res.getHeader('retry-after')).toBeDefined();
  });
});
