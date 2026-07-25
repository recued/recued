/** D-149 P4 § A.5.1 — `/reception/_static/<asset>` dispatcher tests.
 *
 *  Covers:
 *    - Bundled assets serve with correct content-type + cache-control.
 *    - Unknown asset returns 404 (closed-list membership gate).
 *    - Path traversal rejected (no `..`).
 *    - Nested paths rejected (no `/` in tail).
 *    - Subtree gating: paths outside `/reception/_static/` not handled
 *      by the static-asset dispatcher. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import { deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import {
  RECEPTION_STATIC_ASSET_KEY_LIST,
  lookupReceptionStaticAsset,
} from '../ports/reception/static-assets.js';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0x55));

const buildEnv = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  return { db, store, cache, limiter };
};

const fakeReq = (method: string, url: string): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.5' });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  return req;
};

const fakeRes = () => {
  let bodyChunks: Array<string | Buffer> = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(body?: string | Buffer) {
      if (body !== undefined) bodyChunks.push(body);
    },
    write(body: string | Buffer) {
      bodyChunks.push(body);
    },
    get body(): Buffer {
      return Buffer.concat(
        bodyChunks.map((c) => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c)),
      );
    },
    get status(): number {
      return res.statusCode;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as ServerResponse & { status: number; body: Buffer };
  return res;
};

describe('D-149 P4 § A.5.1 — lookupReceptionStaticAsset (pure-fn)', () => {
  it('serves style.css', () => {
    const a = lookupReceptionStaticAsset('/reception/_static/style.css');
    expect(a).not.toBeNull();
    expect(a?.content_type).toMatch(/text\/css/);
    expect(a?.bytes.byteLength).toBeGreaterThan(0);
  });

  it('ships the complete responsive visitor design without remote CSS', () => {
    const css = lookupReceptionStaticAsset('/reception/_static/style.css')?.bytes.toString(
      'utf8',
    );
    expect(css).toBeDefined();
    expect(css).toContain('.rcp-button-primary');
    expect(css).toContain('.rcp-status-row');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('.rcp-honeypot');
    expect(css).toContain('left: -10000px !important');
    expect(css).not.toContain('@import');
  });

  it('serves favicon.ico', () => {
    const a = lookupReceptionStaticAsset('/reception/_static/favicon.ico');
    expect(a).not.toBeNull();
    expect(a?.content_type).toBe('image/x-icon');
  });

  it('returns null for unknown asset', () => {
    expect(lookupReceptionStaticAsset('/reception/_static/secrets.txt')).toBeNull();
  });

  it('rejects path traversal', () => {
    expect(lookupReceptionStaticAsset('/reception/_static/../etc/passwd')).toBeNull();
    expect(lookupReceptionStaticAsset('/reception/_static/..%2Fetc%2Fpasswd')).toBeNull();
  });

  it('rejects nested paths (no `/` in tail)', () => {
    expect(lookupReceptionStaticAsset('/reception/_static/avatar/abc123')).toBeNull();
    expect(lookupReceptionStaticAsset('/reception/_static/dir/style.css')).toBeNull();
  });

  it('rejects empty tail', () => {
    expect(lookupReceptionStaticAsset('/reception/_static/')).toBeNull();
  });

  it('rejects paths outside the subtree', () => {
    expect(lookupReceptionStaticAsset('/reception/scheduling/abc')).toBeNull();
    expect(lookupReceptionStaticAsset('/style.css')).toBeNull();
  });

  it('closed-list key inventory is stable + lowercase + no nested separators', () => {
    // The exported list is frozen; copy before sorting to assert
    // membership without mutating the substrate snapshot.
    expect([...RECEPTION_STATIC_ASSET_KEY_LIST].sort()).toEqual([
      'drop-uploader.js', // D-172 step 5b — the resumable-uploader bundle
      'favicon.ico',
      'style.css',
    ]);
    for (const k of RECEPTION_STATIC_ASSET_KEY_LIST) {
      expect(k).toMatch(/^[a-z0-9._-]+$/);
    }
  });
});

describe('D-149 P4 § A.5.1 — handler.ts static-asset dispatch', () => {
  it('GET /reception/_static/style.css returns 200 with CSS bytes', async () => {
    const env = buildEnv();
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/_static/style.css'), res);
    expect(res.status).toBe(200);
    expect(res.getHeader('content-type')).toMatch(/text\/css/);
    expect(res.getHeader('cache-control')).toMatch(/max-age=86400/);
    expect(res.getHeader('x-content-type-options')).toBe('nosniff');
    expect(res.body.byteLength).toBeGreaterThan(0);
  });

  it('GET /reception/_static/missing returns 404', async () => {
    const env = buildEnv();
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/_static/missing.txt'), res);
    expect(res.status).toBe(404);
  });

  it('GET /reception/_static/../etc/passwd returns 404 (no traversal)', async () => {
    const env = buildEnv();
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/_static/../etc/passwd'), res);
    expect(res.status).toBe(404);
  });

  it('POST /reception/_static/style.css returns 404 (GET-only static surface)', async () => {
    const env = buildEnv();
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
    });
    const res = fakeRes();
    await handler(fakeReq('POST', '/reception/_static/style.css'), res);
    expect(res.status).toBe(404);
  });
});
