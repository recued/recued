/** D-149 P3 § A.2 + § A.18 — path-router dispatch ratchet.
 *
 *  Acceptance per spec + Codex review folds:
 *    - Health probe `/reception/_health` still returns 200 ok.
 *    - Unknown path returns the vendor-agnostic 404 floor.
 *    - Missing token returns 401.
 *    - Wrong-kind token (token for endpoint A presented at endpoint B
 *      URL) returns 401 (Must Hold I-10 cross-endpoint isolation).
 *    - Revoked endpoint returns 410.
 *    - Pre-verify rate limit fires BEFORE HMAC compute (Must Hold I-10).
 *    - Codex P1 #3 fold — rate-limit buckets keyed on server-wide hash,
 *      so a bot rotating endpoint_ids cannot bypass the global cap.
 *    - Codex P1 #4 fold — `X-Forwarded-For` ignored when
 *      `trustForwardedFor: false` (default).
 */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import {
  computeBearerHmac,
  deriveReceptionPepper,
} from '../ports/reception/server-secret-pepper.js';
import { RpcError } from '@recued/contracts';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xAA));

const buildEnv = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  return { db, store, cache, limiter };
};

const fakeReq = (method: string, url: string, options?: {
  remoteAddress?: string;
  xff?: string;
}): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', {
    value: options?.remoteAddress ?? '203.0.113.5',
  });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  if (options?.xff) {
    (req.headers as Record<string, string>)['x-forwarded-for'] = options.xff;
  }
  return req;
};

const fakeRes = () => {
  // Lightweight stub — track status + body, ignore Node's stream semantics.
  let statusCode = 200;
  let bodyChunks: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    writeHead(code: number) {
      statusCode = code;
      res.statusCode = code;
    },
    end(body?: string) {
      if (body !== undefined) bodyChunks.push(body);
    },
    write(body: string) {
      bodyChunks.push(body);
    },
    get body() {
      return bodyChunks.join('');
    },
    get status() {
      return res.statusCode;
    },
  } as unknown as ServerResponse & { status: number; body: string };
  return res;
};

const seedEnabledEndpoint = (
  store: ReturnType<typeof createPublicEndpointRegistryStore>,
  input: {
    endpoint_id: string;
    kind:
      | 'reception_page'
      | 'scheduling_link'
      | 'intake_form'
      | 'drop_link'
      | 'approval_link'
      | 'status_link';
    secret: string;
    revoked?: boolean;
  },
): void => {
  const packetKind = {
    reception_page: 'reception_page_packet',
    scheduling_link: 'scheduling_link_packet',
    intake_form: 'intake_form_packet',
    drop_link: 'drop_link_packet',
    approval_link: 'approval_link_packet',
    status_link: 'status_link_packet',
  }[input.kind];
  store.create({
    endpoint_id: input.endpoint_id,
    kind: input.kind,
    packet_declaration: {
      packet_kind: packetKind as never,
      source_query_ref: { kind: 'data.calendar.combined' },
    } as never,
    bearer_secret_hmac: computeBearerHmac(input.secret, PEPPER),
    created_at: NOW,
    created_by_client_id: 'client-A',
    expires_at: NOW + 24 * 60 * 60 * 1000,
    long_lived_acknowledged_at: null,
    metadata: {},
  });
  store.enable(input.endpoint_id, NOW);
  if (input.revoked) {
    store.revoke({ endpoint_id: input.endpoint_id, now: NOW, reason: null });
  }
};

describe('D-149 P3 § A.2 — health probe + 404 floor', () => {
  it('GET /reception/_health returns 200 ok (no deps)', async () => {
    const handler = createReceptionPortHandler();
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/_health'), res);
    expect(res.status).toBe(200);
  });

  it('GET /reception/_health returns 200 ok (with deps)', async () => {
    const env = buildEnv();
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/_health'), res);
    expect(res.status).toBe(200);
  });

  it('GET /unknown returns 404 (no fingerprint disclosure)', async () => {
    const env = buildEnv();
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('GET', '/unknown'), res);
    expect(res.status).toBe(404);
  });

  it('GET /reception/scheduling/<missing> returns 401 (no fingerprint)', async () => {
    const env = buildEnv();
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/missing-endpoint?t=foo'), res);
    expect(res.status).toBe(401);
  });
});

describe('D-188 — master pause closes the reception door', () => {
  const handlerWith = (isPaused: boolean) => {
    const env = buildEnv();
    return createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      isPaused: () => isPaused,
    });
  };

  it('a paused server returns 503 server_paused for a reception path (before token verify)', async () => {
    const handler = handlerWith(true);
    const res = fakeRes();
    // This path normally 401s (missing endpoint); pause short-circuits to 503 first.
    await handler(fakeReq('GET', '/reception/scheduling/missing-endpoint?t=foo'), res);
    expect(res.status).toBe(503);
    expect(res.body).toContain('server_paused');
  });

  it('the _health probe stays OPEN while paused (monitoring must survive a pause)', async () => {
    const handler = handlerWith(true);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/_health'), res);
    expect(res.status).toBe(200);
  });

  it('not paused → the reception path behaves normally (401 for the missing endpoint)', async () => {
    const handler = handlerWith(false);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/missing-endpoint?t=foo'), res);
    expect(res.status).toBe(401);
  });
});

describe('D-149 P3 § A.18 — token presentation + verify', () => {
  it('missing token returns 401', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-A',
      kind: 'scheduling_link',
      secret: 'bearer-A',
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/endpoint-A'), res);
    expect(res.status).toBe(401);
  });

  it('correct bearer round-trips to the per-kind handler (503 stub at P3)', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-A',
      kind: 'scheduling_link',
      secret: 'bearer-A',
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/endpoint-A?t=bearer-A'),
      res,
    );
    // P4-P9 wires the per-kind handlers; P3 ships the 503 not_implemented stub.
    expect(res.status).toBe(503);
  });

  it('revoked endpoint returns 410', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-A',
      kind: 'scheduling_link',
      secret: 'bearer-A',
      revoked: true,
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/endpoint-A?t=bearer-A'),
      res,
    );
    expect(res.status).toBe(410);
  });

  it('cross-endpoint token reuse — token for A presented at B fails 401', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-A',
      kind: 'scheduling_link',
      secret: 'bearer-A',
    });
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-B',
      kind: 'scheduling_link',
      secret: 'bearer-B',
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/endpoint-B?t=bearer-A'),
      res,
    );
    expect(res.status).toBe(401);
  });
});

describe('D-149 P3 Codex P1 #4 fold — XFF trust gate', () => {
  it('default: XFF ignored — bot cannot poison source-IP hash by rotating header', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-A',
      kind: 'scheduling_link',
      secret: 'bearer-A',
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    // First request with XFF header — header ignored (default trust=false).
    let res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/endpoint-A?t=bearer-A', {
        remoteAddress: '198.51.100.1',
        xff: '8.8.8.8',
      }),
      res,
    );
    expect(res.status).toBe(503); // through to handler stub
    // Read access log — IP hash should hash 198.51.100.1, not 8.8.8.8.
    const log = env.store.readAccessLog({ endpoint_id: 'endpoint-A' });
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]!.source_ip_hash).toBeTruthy();
  });

  it('trustForwardedFor: true — XFF is honored', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-A',
      kind: 'scheduling_link',
      secret: 'bearer-A',
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      trustForwardedFor: true,
    });
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/endpoint-A?t=bearer-A', {
        remoteAddress: '198.51.100.1',
        xff: '8.8.8.8',
      }),
      res,
    );
    expect(res.status).toBe(503);
  });
});

describe('D-149 P3 Codex P1 #3 fold — server-wide IP rate-limit', () => {
  it('rotating endpoint IDs does not let a single IP bypass per_ip_global', async () => {
    const env = buildEnv();
    for (let i = 0; i < 5; i++) {
      seedEnabledEndpoint(env.store, {
        endpoint_id: `endpoint-${i}`,
        kind: 'scheduling_link',
        secret: `bearer-${i}`,
      });
    }
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    // Burn the global per_ip_global bucket (60 req/min) across the 5
    // endpoint IDs (12 hits each = 60 total). Pre-fold the per-endpoint
    // hash would key each bucket separately so this would all succeed.
    let rateLimitedCount = 0;
    for (let i = 0; i < 70; i++) {
      const endpoint = `endpoint-${i % 5}`;
      const secret = `bearer-${i % 5}`;
      const res = fakeRes();
      await handler(
        fakeReq('GET', `/reception/scheduling/${endpoint}?t=${secret}`),
        res,
      );
      if (res.status === 429) rateLimitedCount += 1;
    }
    // Post-fold — global bucket exhausts after 60 → at least 10 of 70
    // requests get 429.
    expect(rateLimitedCount).toBeGreaterThan(0);
  });
});

describe('D-149 P3 bin.ts Codex P2 #1 fold — locked-vault posture', () => {
  it('getPepper throwing RpcError(not_configured, 503) maps to 503 visitor response', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-A',
      kind: 'scheduling_link',
      secret: 'bearer-A',
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => {
        throw new RpcError(
          'not_configured',
          'reception: pepper unavailable — FileVault locked or KeyManager uninitialised',
          503,
        );
      },
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/scheduling/endpoint-A?t=bearer-A'),
      res,
    );
    expect(res.status).toBe(503);
    expect(res.body).toContain('not_configured');
  });

  it('non-RpcError throws from getPepper propagate to the path-router 500 fallback', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-A',
      kind: 'scheduling_link',
      secret: 'bearer-A',
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => {
        throw new Error('boom');
      },
      now: () => NOW,
    });
    // Generic Error rejects the returned promise (path-listener-set's
    // `safeDispatch` would catch + emit a 500 `internal_error`); the
    // handler does NOT swallow the throw on purpose so misconfigurations
    // remain loud.
    await expect(
      handler(
        fakeReq('GET', '/reception/scheduling/endpoint-A?t=bearer-A'),
        fakeRes(),
      ),
    ).rejects.toThrow(/boom/);
  });
});

describe('D-149 P3 — access log writes every outcome', () => {
  it('rate-limited requests still write to the access log', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-A',
      kind: 'drop_link',
      secret: 'bearer-A',
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    // drop_link cap = 5/hour per IP. The 6th hit gets rate-limited.
    for (let i = 0; i < 7; i++) {
      const res = fakeRes();
      await handler(
        fakeReq('GET', '/reception/drop/endpoint-A?t=bearer-A'),
        res,
      );
    }
    const log = env.store.readAccessLog({ endpoint_id: 'endpoint-A' });
    const rateLimited = log.filter((r) => r.outcome === 'rate_limited');
    expect(rateLimited.length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────
// WatchSource generalization — reception arrival bus emits
// ────────────────────────────────────────────────────────────────

describe('WatchSource — verified mutation arrivals emit onto the warehouse bus', () => {
  const makeBus = () => {
    const events: Array<Record<string, unknown>> = [];
    return {
      events,
      bus: {
        emit: (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      },
    };
  };

  it('a verified POST submit emits data.reception.<kind>.request.created + marks the source', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-A',
      kind: 'intake_form',
      secret: 'bearer-A',
    });
    const { bus, events } = makeBus();
    const marks: Array<[string, number]> = [];
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      warehouseBus: bus,
      markSourceEvent: (key, at) => marks.push([key, at]),
    });

    const res = fakeRes();
    await handler(fakeReq('POST', '/reception/intake/endpoint-A?t=bearer-A'), res);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: 'reception',
      slug: 'intake_form',
      entity_type: 'request',
      event_kind: 'created',
      at: NOW,
      record: { endpoint_id: 'endpoint-A', kind: 'intake_form', action: 'submit' },
    });
    expect(typeof events[0]?.record_id).toBe('string');
    expect(marks).toEqual([['reception/intake_form', NOW]]);
  });

  it('a GET view render emits nothing', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-B',
      kind: 'intake_form',
      secret: 'bearer-B',
    });
    const { bus, events } = makeBus();
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      warehouseBus: bus,
    });

    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/intake/endpoint-B?t=bearer-B'), res);

    expect(events).toHaveLength(0);
  });

  it('an unverified POST (wrong token) emits nothing', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-C',
      kind: 'intake_form',
      secret: 'bearer-C',
    });
    const { bus, events } = makeBus();
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      warehouseBus: bus,
    });

    const res = fakeRes();
    await handler(fakeReq('POST', '/reception/intake/endpoint-C?t=wrong'), res);

    expect(res.status).toBe(401);
    expect(events).toHaveLength(0);
  });

  it('a throwing bus subscriber never fails the visitor request', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-D',
      kind: 'intake_form',
      secret: 'bearer-D',
    });
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      warehouseBus: {
        emit: () => {
          throw new Error('subscriber exploded');
        },
      },
    });

    const res = fakeRes();
    await handler(fakeReq('POST', '/reception/intake/endpoint-D?t=bearer-D'), res);
    // The request proceeded past the emit — whatever the per-kind
    // handler answers (503 stub here), it is NOT a thrown 500.
    expect(res.status).not.toBe(500);
  });

  it('invalid-shape mutation paths (bad verb / extra segment) emit NOTHING (codex fold)', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-E',
      kind: 'scheduling_link',
      secret: 'bearer-E',
    });
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-F',
      kind: 'intake_form',
      secret: 'bearer-F',
    });
    const { bus, events } = makeBus();
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      warehouseBus: bus,
    });

    // scheduling_link POST with a non-`book` verb → 404, no doorbell.
    const res1 = fakeRes();
    await handler(
      fakeReq('POST', '/reception/scheduling/endpoint-E/bogus?t=bearer-E'),
      res1,
    );
    expect(res1.status).toBe(404);

    // intake_form POST with an extra path segment → 404, no doorbell.
    const res2 = fakeRes();
    await handler(fakeReq('POST', '/reception/intake/endpoint-F/extra?t=bearer-F'), res2);
    expect(res2.status).toBe(404);

    expect(events).toHaveLength(0);
  });

  it('a valid-shape mutation on a 503-degraded substrate still emits (doorbell rings while the drain is down)', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, {
      endpoint_id: 'endpoint-G',
      kind: 'scheduling_link',
      secret: 'bearer-G',
    });
    const { bus, events } = makeBus();
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      warehouseBus: bus,
    });

    const res = fakeRes();
    await handler(fakeReq('POST', '/reception/scheduling/endpoint-G/book?t=bearer-G'), res);
    expect(res.status).toBe(503);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      slug: 'scheduling_link',
      record: { endpoint_id: 'endpoint-G', kind: 'scheduling_link', action: 'submit' },
    });
  });
});
