/** D-149 P12 § A.20.5 — IP-block-list enforcement at the path-listener.
 *
 *  Acceptance:
 *    - A banned `(endpoint_id, source_ip_hash)` pair → 403 BEFORE the
 *      per-IP rate-limit consume + before any token verify.
 *    - The blocked request still lands an operational access-log row
 *      tagged `rejection_reason: 'ip_blocked'` (forensics).
 *    - The block is per-endpoint — the same visitor IP at a sibling
 *      endpoint resolves to a different endpoint-scoped hash + is NOT
 *      blocked (§ Must Hold I-9).
 *    - The singleton `/reception/` path enforces the block too.
 *    - When the IP block store is not wired the check is skipped
 *      (fail-open boot-phase posture). */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  type PacketDeclaration,
} from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionIpBlockStore } from '../storage/reception-ip-block-store.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import {
  computeBearerHmac,
  deriveReceptionPepper,
  hashSourceIpEndpointScoped,
} from '../ports/reception/server-secret-pepper.js';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xab));
const VISITOR_IP = '203.0.113.77';

const buildEnv = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const ipBlockStore = createReceptionIpBlockStore(db);
  return { db, store, cache, limiter, ipBlockStore };
};

const fakeReq = (method: string, url: string, remoteAddress = VISITOR_IP): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  return req;
};

const fakeRes = () => {
  let statusCode = 200;
  const bodyChunks: string[] = [];
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
  endpoint_id: string,
  secret: string,
): void => {
  store.create({
    endpoint_id,
    kind: 'scheduling_link',
    packet_declaration: {
      packet_kind: 'scheduling_link_packet',
      source_query_ref: { kind: 'data.calendar.combined' },
    } as PacketDeclaration,
    bearer_secret_hmac: computeBearerHmac(secret, PEPPER),
    created_at: NOW,
    created_by_client_id: 'client-A',
    expires_at: NOW + 24 * 60 * 60 * 1000,
    long_lived_acknowledged_at: null,
    metadata: {},
  });
  store.enable(endpoint_id, NOW);
};

const baseDeps = (env: ReturnType<typeof buildEnv>, withIpBlock = true) => ({
  getStore: () => env.store,
  getCache: () => env.cache,
  getRateLimiter: () => env.limiter,
  getPepper: () => PEPPER,
  now: () => NOW,
  ...(withIpBlock ? { getIpBlockStore: () => env.ipBlockStore } : {}),
});

describe('D-149 P12 § A.20.5 — link-style path IP-block enforcement', () => {
  it('a banned (endpoint, ip-hash) pair returns 403 before token verify', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, 'endpoint-A', 'bearer-A');
    const hash = hashSourceIpEndpointScoped(VISITOR_IP, 'endpoint-A', PEPPER);
    env.ipBlockStore.block({
      endpoint_id: 'endpoint-A',
      source_ip_hash: hash,
      blocked_at: NOW,
      blocked_by_client_id: 'client-A',
      reason: 'brute-force',
    });
    const handler = createReceptionPortHandler(baseDeps(env));
    const res = fakeRes();
    // A wrong token would normally 401 — the block check fires first → 403.
    await handler(fakeReq('GET', '/reception/scheduling/endpoint-A?t=wrong'), res);
    expect(res.status).toBe(403);
  });

  it('the blocked request lands an access-log row tagged ip_blocked', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, 'endpoint-A', 'bearer-A');
    const hash = hashSourceIpEndpointScoped(VISITOR_IP, 'endpoint-A', PEPPER);
    env.ipBlockStore.block({
      endpoint_id: 'endpoint-A',
      source_ip_hash: hash,
      blocked_at: NOW,
      blocked_by_client_id: 'client-A',
      reason: null,
    });
    const handler = createReceptionPortHandler(baseDeps(env));
    await handler(fakeReq('GET', '/reception/scheduling/endpoint-A?t=wrong'), fakeRes());
    const log = env.store.readAccessLog({ endpoint_id: 'endpoint-A' });
    expect(log).toHaveLength(1);
    expect(log[0]!.outcome).toBe('rejected');
    expect(log[0]!.metadata.rejection_reason).toBe('ip_blocked');
  });

  it('the block is per-endpoint — the same IP at a sibling endpoint is not blocked', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, 'endpoint-A', 'bearer-A');
    seedEnabledEndpoint(env.store, 'endpoint-B', 'bearer-B');
    // Ban the visitor only on endpoint-A.
    env.ipBlockStore.block({
      endpoint_id: 'endpoint-A',
      source_ip_hash: hashSourceIpEndpointScoped(VISITOR_IP, 'endpoint-A', PEPPER),
      blocked_at: NOW,
      blocked_by_client_id: 'client-A',
      reason: null,
    });
    const handler = createReceptionPortHandler(baseDeps(env));
    // Same IP, sibling endpoint — endpoint-scoped hash differs → not 403
    // (a wrong token 401s; the point is it is NOT 403).
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/endpoint-B?t=wrong'), res);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(401);
  });

  it('a non-banned visitor proceeds normally (not 403)', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, 'endpoint-A', 'bearer-A');
    const handler = createReceptionPortHandler(baseDeps(env));
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/endpoint-A?t=wrong'), res);
    expect(res.status).not.toBe(403);
  });

  it('fail-open — when the IP block store is not wired the check is skipped', async () => {
    const env = buildEnv();
    seedEnabledEndpoint(env.store, 'endpoint-A', 'bearer-A');
    // Even though we ban the pair in the store, the handler is built
    // WITHOUT getIpBlockStore — so the check never runs.
    env.ipBlockStore.block({
      endpoint_id: 'endpoint-A',
      source_ip_hash: hashSourceIpEndpointScoped(VISITOR_IP, 'endpoint-A', PEPPER),
      blocked_at: NOW,
      blocked_by_client_id: 'client-A',
      reason: null,
    });
    const handler = createReceptionPortHandler(baseDeps(env, false));
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/scheduling/endpoint-A?t=wrong'), res);
    expect(res.status).not.toBe(403);
  });
});

describe('D-149 P12 § A.20.5 — singleton path IP-block enforcement', () => {
  it('a banned IP at the bare /reception/ singleton returns 403', async () => {
    const env = buildEnv();
    const hash = hashSourceIpEndpointScoped(
      VISITOR_IP,
      RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
      PEPPER,
    );
    env.ipBlockStore.block({
      endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
      source_ip_hash: hash,
      blocked_at: NOW,
      blocked_by_client_id: 'client-A',
      reason: null,
    });
    const handler = createReceptionPortHandler(baseDeps(env));
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.status).toBe(403);
    const log = env.store.readAccessLog({
      endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
    });
    expect(log[0]!.metadata.rejection_reason).toBe('ip_blocked');
  });

  it('a non-banned IP at /reception/ is not 403', async () => {
    const env = buildEnv();
    const handler = createReceptionPortHandler(baseDeps(env));
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/'), res);
    expect(res.status).not.toBe(403);
  });
});
