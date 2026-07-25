/** D-148 P6 — WS port handler: bearer + rate-limit + upgrade dispatch. */

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRateLimiter } from '../ports/common/rate-limit.js';
import { createWsPortHandler } from '../ports/ws/handler.js';

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: string | null = null;
  setHeader(key: string, value: string): void { this.headers[key.toLowerCase()] = value; }
  getHeader(key: string): string | undefined { return this.headers[key.toLowerCase()]; }
  end(body?: string): void { this.body = body ?? ''; }
}

const buildReq = (
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
): IncomingMessage =>
  ({ url, method, headers } as unknown as IncomingMessage);

const json = (res: FakeRes): unknown => JSON.parse(res.body ?? 'null');

describe('createWsPortHandler', () => {
  const buildHandler = (overrides: { verifier?: (t: string) => boolean; capacity?: number } = {}) => {
    let t = 0;
    const limiter = createRateLimiter({
      capacity: overrides.capacity ?? 100,
      refill_window_ms: 1000,
      now: () => t,
    });
    const upgraded: number[] = [];
    const handler = createWsPortHandler({
      verifier: overrides.verifier ?? ((tok) => tok === 'realm-1'),
      limiter,
      upgrade: async () => { upgraded.push(1); },
    });
    return { handler, upgraded, advance: (ms: number) => { t += ms; } };
  };

  it('returns 200 ok on /health without auth', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(buildReq('/health'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ status: 'ok' });
  });

  it('returns 401 when bearer header is missing', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(buildReq('/ws'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
    expect((json(res) as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('returns 401 when bearer token is invalid', async () => {
    const { handler } = buildHandler({ verifier: () => false });
    const res = new FakeRes();
    await handler(buildReq('/ws', { authorization: 'Bearer bad' }), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
  });

  it('dispatches to upgrade callback on valid bearer', async () => {
    const { handler, upgraded } = buildHandler();
    const res = new FakeRes();
    await handler(buildReq('/ws', { authorization: 'Bearer realm-1' }), res as unknown as ServerResponse);
    expect(upgraded).toHaveLength(1);
  });

  it('also accepts ?token=<x> for legacy clients', async () => {
    const { handler, upgraded } = buildHandler();
    const res = new FakeRes();
    await handler(buildReq('/ws?token=realm-1'), res as unknown as ServerResponse);
    expect(upgraded).toHaveLength(1);
  });

  it('returns 401 on a bad ?token=<x>', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(buildReq('/ws?token=bad'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
  });

  it('emits 429 + Retry-After header when over rate', async () => {
    const { handler } = buildHandler({ capacity: 2 });
    const res1 = new FakeRes();
    await handler(buildReq('/ws', { authorization: 'Bearer realm-1' }), res1 as unknown as ServerResponse);
    const res2 = new FakeRes();
    await handler(buildReq('/ws', { authorization: 'Bearer realm-1' }), res2 as unknown as ServerResponse);
    const res3 = new FakeRes();
    await handler(buildReq('/ws', { authorization: 'Bearer realm-1' }), res3 as unknown as ServerResponse);
    expect(res3.statusCode).toBe(429);
    expect(res3.getHeader('retry-after')).toBeDefined();
  });

  it('isolates rate-limit per token (different tokens unaffected)', async () => {
    const { handler } = buildHandler({
      verifier: () => true,
      capacity: 1,
    });
    const res1 = new FakeRes();
    await handler(buildReq('/ws', { authorization: 'Bearer t1' }), res1 as unknown as ServerResponse);
    const res2 = new FakeRes();
    // Same token — over budget
    await handler(buildReq('/ws', { authorization: 'Bearer t1' }), res2 as unknown as ServerResponse);
    expect(res2.statusCode).toBe(429);
    const res3 = new FakeRes();
    await handler(buildReq('/ws', { authorization: 'Bearer t2' }), res3 as unknown as ServerResponse);
    expect(res3.statusCode).not.toBe(429);
  });
});
