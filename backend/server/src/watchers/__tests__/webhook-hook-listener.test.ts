/** D-115 Phase 6C — /hook/{recipe_id}/{slug} HTTP listener tests. */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createHookListener } from '../webhook-hook-listener.js';
import {
  createWebhookWatcherQueue,
  type WebhookWatcherQueue,
} from '../webhook-watcher.js';

/** Minimal fake IncomingMessage for unit tests — captures headers
 *  + socket fields. The body is NOT emitted automatically; the
 *  helper returns both the emitter and a `send()` trigger so the
 *  test schedules emits AFTER it registers handlers. Avoids
 *  microtask-queue races when multiple requests are in flight. */
const mkReq = (init: {
  method?: string;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  socketRemoteAddress?: string;
}): IncomingMessage & { send: () => void } => {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  (emitter as unknown as { method: string }).method = init.method ?? 'POST';
  (emitter as unknown as { headers: Record<string, string | string[]> }).headers =
    init.headers ?? {};
  (emitter as unknown as { socket: { remoteAddress?: string } }).socket = {
    remoteAddress: init.socketRemoteAddress,
  };
  const send = () => {
    let body: Buffer;
    if (Buffer.isBuffer(init.body)) {
      body = init.body;
    } else {
      body = Buffer.from((init.body as string | undefined) ?? '', 'utf8');
    }
    if (body.length > 0) (emitter as unknown as EventEmitter).emit('data', body);
    (emitter as unknown as EventEmitter).emit('end');
  };
  return Object.assign(emitter, { send });
};

/** Convenience: invoke the listener and flush the body on next tick. */
const invokeListener = async (
  listener: (req: IncomingMessage, res: ServerResponse, recipeId: string, slug: string) => Promise<void>,
  req: IncomingMessage & { send: () => void },
  res: ServerResponse,
  recipeId: string,
  slug: string,
): Promise<void> => {
  const p = listener(req, res, recipeId, slug);
  queueMicrotask(req.send);
  await p;
};

const mkRes = () => {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
    },
  } as unknown as ServerResponse;
  return {
    res,
    read: () => ({ status: res.statusCode, headers, body: chunks.join('') }),
  };
};

const mkDeps = (
  overrides: Partial<{
    publicReachable: () => boolean;
    queue: WebhookWatcherQueue;
    now: () => number;
    deliveryId: () => string;
    maxBodyBytes: number;
  }> = {},
) => {
  const queue = overrides.queue ?? createWebhookWatcherQueue({ now: () => 1000 });
  return {
    queue,
    publicReachable: overrides.publicReachable ?? (() => true),
    now: overrides.now ?? (() => 1000),
    deliveryId: overrides.deliveryId ?? (() => 'fixed-id'),
    maxBodyBytes: overrides.maxBodyBytes,
  };
};

describe('createHookListener — accept', () => {
  it('202 on valid POST + enqueues request', async () => {
    const deps = mkDeps();
    const listener = createHookListener(deps);
    const { res, read } = mkRes();
    const req = mkReq({
      body: '{"hello":"world"}',
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8' },
    });
    await invokeListener(listener, req, res, 'r1', 's1');
    const out = read();
    expect(out.status).toBe(202);
    expect(JSON.parse(out.body)).toEqual({ ok: true, delivery_id: 'fixed-id' });
    const drained = deps.queue.drain('r1', 's1');
    expect(drained).toHaveLength(1);
    expect(drained[0].body).toBe('{"hello":"world"}');
    expect(drained[0].headers['content-type']).toBe('application/json');
    expect(drained[0].headers['user-agent']).toBe('curl/8');
    expect(drained[0].received_at).toBe(1000);
  });
  it('captures source_ip from socket.remoteAddress', async () => {
    const deps = mkDeps();
    const listener = createHookListener(deps);
    const { res } = mkRes();
    const req = mkReq({ body: 'x', socketRemoteAddress: '198.51.100.7' });
    await invokeListener(listener, req, res, 'r1', 's1');
    const drained = deps.queue.drain('r1', 's1');
    expect(drained[0].source_ip).toBe('198.51.100.7');
  });
  it('strips Authorization / Cookie headers', async () => {
    const deps = mkDeps();
    const listener = createHookListener(deps);
    const { res } = mkRes();
    const req = mkReq({
      body: 'x',
      headers: {
        authorization: 'Bearer shhh',
        cookie: 'session=abc',
        'x-github-event': 'push',
      },
    });
    await invokeListener(listener, req, res, 'r1', 's1');
    const drained = deps.queue.drain('r1', 's1');
    expect(drained[0].headers.authorization).toBeUndefined();
    expect(drained[0].headers.cookie).toBeUndefined();
    expect(drained[0].headers['x-github-event']).toBe('push');
  });
});

describe('createHookListener — gating', () => {
  it('503 WEBHOOK_UNAVAILABLE when public_reachable=false', async () => {
    const deps = mkDeps({ publicReachable: () => false });
    const listener = createHookListener(deps);
    const { res, read } = mkRes();
    const req = mkReq({ body: 'x' });
    await invokeListener(listener, req, res, 'r1', 's1');
    const out = read();
    expect(out.status).toBe(503);
    const body = JSON.parse(out.body);
    expect(body.error.code).toBe('WEBHOOK_UNAVAILABLE');
    expect(deps.queue.size('r1', 's1')).toBe(0);
  });
});

describe('createHookListener — body cap', () => {
  it('413 when body exceeds maxBodyBytes', async () => {
    const deps = mkDeps({ maxBodyBytes: 10 });
    const listener = createHookListener(deps);
    const { res, read } = mkRes();
    const req = mkReq({ body: 'x'.repeat(100) });
    await invokeListener(listener, req, res, 'r1', 's1');
    const out = read();
    expect(out.status).toBe(413);
    expect(JSON.parse(out.body).error.code).toBe('payload_too_large');
    expect(deps.queue.size('r1', 's1')).toBe(0);
  });
});

describe('createHookListener — multi-recipe routing', () => {
  it('segregates enqueues by (recipe_id, slug)', async () => {
    const deps = mkDeps();
    const listener = createHookListener(deps);
    const req1 = mkReq({ body: 'a' });
    const req2 = mkReq({ body: 'b' });
    const req3 = mkReq({ body: 'c' });
    const resA = mkRes(); const resB = mkRes(); const resC = mkRes();
    await invokeListener(listener, req1, resA.res, 'recipe-1', 'slug-x');
    await invokeListener(listener, req2, resB.res, 'recipe-1', 'slug-y');
    await invokeListener(listener, req3, resC.res, 'recipe-2', 'slug-x');
    expect(deps.queue.drain('recipe-1', 'slug-x').map((r) => r.body)).toEqual(['a']);
    expect(deps.queue.drain('recipe-1', 'slug-y').map((r) => r.body)).toEqual(['b']);
    expect(deps.queue.drain('recipe-2', 'slug-x').map((r) => r.body)).toEqual(['c']);
  });
});

// Real HTTP round-trip — kicks the listener with a live Node server
// to catch any IncomingMessage API mismatch the stub wouldn't see.
describe('createHookListener — live HTTP', () => {
  it('round-trips POST → 202 + enqueue', async () => {
    const deps = mkDeps();
    const listener = createHookListener(deps);

    const server = createServer((req, res) => {
      void listener(req, res, 'r1', 's1');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/hook/r1/s1',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
      });
      r.on('error', reject);
      r.write('{"live":true}');
      r.end();
    });

    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ ok: true, delivery_id: 'fixed-id' });
    const drained = deps.queue.drain('r1', 's1');
    expect(drained).toHaveLength(1);
    expect(drained[0].body).toBe('{"live":true}');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
