/** D-148 follow-up #7 — bare-302 root redirect handler tests.
 *
 *  Tests the `createRootApexHandler` factory in
 *  `backend/server/src/root-redirect-handler.ts`. Pure-handler scope —
 *  no listener-set, no path-router, no http server. The factory's
 *  responsibilities:
 *
 *  1. Methods other than GET / HEAD → 405 with `Allow: GET, HEAD`.
 *  2. Host header does not match the Pro DDNS shape → 404 (generic
 *     dispatcher-look-alike body, no fingerprint).
 *  3. Host header matches → 302 with:
 *       - `Location: https://app.recued.com/` (exact constant; no
 *         interpolation of Host, query, or fragment)
 *       - `Cache-Control: no-store`
 *       - `Content-Length: 0`
 *       - empty body
 *
 *  Critical no-leak ratchet: the Location header NEVER contains the
 *  visitor's Host header value, any query parameter, or any fragment
 *  from the incoming request. Per `feedback_no_handle_in_redirect_chain`. */

import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ROOT_REDIRECT_TARGET } from '@recued/contracts';
import {
  createRootApexHandler,
  createLanWebclientRootHandler,
} from '../root-redirect-handler.js';

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: string | null = null;
  writableEnded = false;
  readonly headersSent = false;
  setHeader(k: string, v: string): void {
    this.headers[k.toLowerCase()] = v;
  }
  end(body?: string): void {
    this.body = body ?? '';
    this.writableEnded = true;
  }
}

const buildReq = (args: {
  method?: string;
  url?: string;
  host?: string | undefined;
}): IncomingMessage => {
  const headers: Record<string, string> = {};
  if (args.host !== undefined) headers.host = args.host;
  return {
    method: args.method ?? 'GET',
    url: args.url ?? '/',
    headers,
  } as unknown as IncomingMessage;
};

const runHandler = async (
  args: { method?: string; url?: string; host?: string | undefined },
  handler = createRootApexHandler(),
): Promise<FakeRes> => {
  const res = new FakeRes();
  await handler(buildReq(args), res as unknown as ServerResponse);
  return res;
};

describe('D-148 FU#7 — bare-302 root redirect handler', () => {
  describe('happy path — GET / HEAD', () => {
    it('GET with Pro DDNS Host returns 302 to ROOT_REDIRECT_TARGET', async () => {
      const res = await runHandler({ method: 'GET', host: 'alice.recued.net' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(ROOT_REDIRECT_TARGET);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-length']).toBe('0');
      expect(res.body).toBe('');
    });

    it('HEAD with Pro DDNS Host returns 302 with same headers', async () => {
      const res = await runHandler({ method: 'HEAD', host: 'alice.recued.net' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(ROOT_REDIRECT_TARGET);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('handles mixed-case method (`get`) by upper-casing before lookup', async () => {
      const res = await runHandler({ method: 'get', host: 'alice.recued.net' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(ROOT_REDIRECT_TARGET);
    });

    it('handles uppercase Host header (DNS RFC 1035 case-insensitivity)', async () => {
      const res = await runHandler({ method: 'GET', host: 'ALICE.RECUED.NET' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(ROOT_REDIRECT_TARGET);
    });

    it('handles Pro DDNS Host with :port suffix', async () => {
      const res = await runHandler({ method: 'GET', host: 'alice.recued.net:443' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(ROOT_REDIRECT_TARGET);
    });
  });

  describe('host rejection — 404 (generic, no fingerprint)', () => {
    it('returns 404 for BYO custom domain', async () => {
      const res = await runHandler({ method: 'GET', host: 'recued.example.com' });
      expect(res.statusCode).toBe(404);
      expect(res.headers.location).toBeUndefined();
      const parsed = JSON.parse(res.body ?? 'null');
      expect(parsed).toEqual({ error: { code: 'not_found' } });
    });

    it('returns 404 for bare apex `recued.net`', async () => {
      const res = await runHandler({ method: 'GET', host: 'recued.net' });
      expect(res.statusCode).toBe(404);
      expect(res.headers.location).toBeUndefined();
    });

    it('returns 404 for multi-label `a.b.recued.net`', async () => {
      const res = await runHandler({ method: 'GET', host: 'a.b.recued.net' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for app.recued.com (.com vs .cloud TLD mismatch)', async () => {
      const res = await runHandler({ method: 'GET', host: 'app.recued.com' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for IP-only Host', async () => {
      const res = await runHandler({ method: 'GET', host: '192.168.1.42' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for missing Host header', async () => {
      const res = await runHandler({ method: 'GET', host: undefined });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for substring spoof `alice.recued.net.evil.com`', async () => {
      const res = await runHandler({ method: 'GET', host: 'alice.recued.net.evil.com' });
      expect(res.statusCode).toBe(404);
      expect(res.headers.location).toBeUndefined();
    });
  });

  describe('method rejection — 405', () => {
    it('POST returns 405 with Allow: GET, HEAD', async () => {
      const res = await runHandler({ method: 'POST', host: 'alice.recued.net' });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD');
      const parsed = JSON.parse(res.body ?? 'null');
      expect(parsed).toEqual({ error: { code: 'method_not_allowed' } });
    });

    it.each(['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'CONNECT'])(
      '%s returns 405 (method-rejection runs BEFORE host check)',
      async (method) => {
        // Notably: even with a valid Pro DDNS Host, non-GET/HEAD methods
        // never get the 302 — the method gate runs first so the response
        // is consistent regardless of host.
        const res = await runHandler({ method, host: 'alice.recued.net' });
        expect(res.statusCode).toBe(405);
        expect(res.headers.location).toBeUndefined();
      },
    );

    it('method gate fires BEFORE host gate (consistent 405 across hosts)', async () => {
      const proHostRes = await runHandler({ method: 'POST', host: 'alice.recued.net' });
      const byoHostRes = await runHandler({ method: 'POST', host: 'recued.example.com' });
      const noHostRes = await runHandler({ method: 'POST', host: undefined });
      expect(proHostRes.statusCode).toBe(405);
      expect(byoHostRes.statusCode).toBe(405);
      expect(noHostRes.statusCode).toBe(405);
    });
  });

  describe('no-leak invariants', () => {
    it('Location header is the exact constant — no Host interpolation', async () => {
      const res = await runHandler({ method: 'GET', host: 'alice.recued.net' });
      expect(res.headers.location).toBe(ROOT_REDIRECT_TARGET);
      // Negative assertions: handle must NOT appear anywhere in the
      // response. Critical ratchet per feedback_no_handle_in_redirect_chain.
      expect(res.headers.location).not.toContain('alice');
      expect(res.headers.location).not.toContain('recued.net');
      expect(JSON.stringify(res.headers)).not.toContain('alice');
    });

    it('query string from request URL does NOT survive into Location', async () => {
      const res = await runHandler({
        method: 'GET',
        url: '/?pair=alice&utm_source=evil',
        host: 'alice.recued.net',
      });
      expect(res.headers.location).toBe(ROOT_REDIRECT_TARGET);
      expect(res.headers.location).not.toContain('pair=');
      expect(res.headers.location).not.toContain('utm');
    });

    it('fragment from request URL does NOT survive into Location', async () => {
      const res = await runHandler({
        method: 'GET',
        url: '/#token=evil',
        host: 'alice.recued.net',
      });
      expect(res.headers.location).toBe(ROOT_REDIRECT_TARGET);
      expect(res.headers.location).not.toContain('#');
      expect(res.headers.location).not.toContain('token');
    });

    it('handle in Host header is NOT echoed into the response body either', async () => {
      const res = await runHandler({ method: 'GET', host: 'alice.recued.net' });
      expect(res.body).toBe('');
    });

    it('rejected-host 404 body is identical to the path-router unknown-path body shape', async () => {
      // Fingerprint-discipline ratchet: a visitor hitting bare / on a
      // BYO domain sees the same generic 404 they'd get hitting an
      // unknown path on the dispatcher. They cannot infer that this
      // server runs the redirect surface.
      const res = await runHandler({ method: 'GET', host: 'recued.example.com' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.body).toBe(JSON.stringify({ error: { code: 'not_found' } }));
    });
  });

  describe('factory options', () => {
    it('honours `target` override (test injection)', async () => {
      const handler = createRootApexHandler({ target: 'https://example.test/' });
      const res = await runHandler({ method: 'GET', host: 'alice.recued.net' }, handler);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://example.test/');
    });

    it('honours `hostMatcher` override — accept all', async () => {
      const handler = createRootApexHandler({ hostMatcher: () => true });
      const res = await runHandler({ method: 'GET', host: 'unknown.example' }, handler);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(ROOT_REDIRECT_TARGET);
    });

    it('honours `hostMatcher` override — reject all', async () => {
      const handler = createRootApexHandler({ hostMatcher: () => false });
      const res = await runHandler({ method: 'GET', host: 'alice.recued.net' }, handler);
      expect(res.statusCode).toBe(404);
    });

    it('emits one info log per dispatch decision', async () => {
      const calls: Array<{ level: string; msg: string }> = [];
      const log = (level: 'info' | 'warn', msg: string) => calls.push({ level, msg });
      const handler = createRootApexHandler({ log });
      await runHandler({ method: 'GET', host: 'alice.recued.net' }, handler);
      await runHandler({ method: 'GET', host: 'recued.example.com' }, handler);
      await runHandler({ method: 'POST', host: 'alice.recued.net' }, handler);
      expect(calls.map((c) => c.msg)).toEqual([
        expect.stringMatching(/302/),
        expect.stringMatching(/host rejected/),
        expect.stringMatching(/method not allowed/),
      ]);
    });
  });

  describe('idempotency — already-ended response', () => {
    it('is a no-op when the response has already ended', async () => {
      const handler = createRootApexHandler();
      const res = new FakeRes();
      res.writableEnded = true;
      res.statusCode = 200;
      await handler(buildReq({ method: 'GET', host: 'alice.recued.net' }), res as unknown as ServerResponse);
      // Status stays as the prior caller left it — the redirect helper
      // checked writableEnded and bailed.
      expect(res.statusCode).toBe(200);
      expect(res.headers.location).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // R26.2 Delta 2 — apex modes
  // ────────────────────────────────────────────────────────────────
  describe('R26.2 Delta 2 — apex modes', () => {
    it('not_found mode returns 404 even for a Pro DDNS Host', async () => {
      const handler = createRootApexHandler({ getApexMode: () => 'not_found' });
      const res = new FakeRes();
      await handler(
        buildReq({ method: 'GET', host: 'alice.recued.net' }),
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(404);
      expect(res.headers.location).toBeUndefined();
    });

    it('serve_reception delegates to the reception handler with req.url rewritten to /reception', async () => {
      let seenUrl: string | undefined;
      const receptionHandler = (req: IncomingMessage, res: ServerResponse): void => {
        seenUrl = req.url;
        res.statusCode = 200;
        res.end('reception');
      };
      const handler = createRootApexHandler({
        getApexMode: () => 'serve_reception',
        getReceptionPublic: () => true,
        receptionHandler,
      });
      const res = new FakeRes();
      // Any Host — serve modes don't host-gate (it's the user's own content).
      await handler(
        buildReq({ method: 'GET', host: 'recued.example.com', url: '/' }),
        res as unknown as ServerResponse,
      );
      expect(seenUrl).toBe('/reception');
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('reception');
    });

    it('serve_reception answers HEAD with a bare 200 WITHOUT delegating (Codex fold)', async () => {
      let delegated = false;
      const handler = createRootApexHandler({
        getApexMode: () => 'serve_reception',
        getReceptionPublic: () => true,
        receptionHandler: (_req, res) => {
          delegated = true;
          res.end('reception');
        },
      });
      const res = new FakeRes();
      await handler(
        buildReq({ method: 'HEAD', host: 'recued.example.com' }),
        res as unknown as ServerResponse,
      );
      // HEAD must not burn the reception page path's per-IP rate-limit.
      expect(delegated).toBe(false);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('');
      expect(res.headers['content-length']).toBe('0');
    });

    it('serve_reception HEAD still 404s when /reception is not public', async () => {
      const handler = createRootApexHandler({
        getApexMode: () => 'serve_reception',
        getReceptionPublic: () => false,
        receptionHandler: (_req, res) => {
          res.end('reception');
        },
      });
      const res = new FakeRes();
      await handler(
        buildReq({ method: 'HEAD', host: 'recued.example.com' }),
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(404);
    });

    it('serve_reception 404s defensively when /reception is not public', async () => {
      let delegated = false;
      const handler = createRootApexHandler({
        getApexMode: () => 'serve_reception',
        getReceptionPublic: () => false,
        receptionHandler: (_req, res) => {
          delegated = true;
          res.end('reception');
        },
      });
      const res = new FakeRes();
      await handler(
        buildReq({ method: 'GET', host: 'recued.example.com' }),
        res as unknown as ServerResponse,
      );
      expect(delegated).toBe(false);
      expect(res.statusCode).toBe(404);
    });

    it('serve_reception 404s when no reception handler is wired', async () => {
      const handler = createRootApexHandler({
        getApexMode: () => 'serve_reception',
        getReceptionPublic: () => true,
      });
      const res = new FakeRes();
      await handler(
        buildReq({ method: 'GET', host: 'recued.example.com' }),
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(404);
    });

    it('serve_webclient 404s when not servable (no bundle / /webclient not public)', async () => {
      const handler = createRootApexHandler({
        getApexMode: () => 'serve_webclient',
        getWebclientServable: () => false,
      });
      const res = new FakeRes();
      await handler(
        buildReq({ method: 'GET', host: 'recued.example.com' }),
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(404);
      expect(res.headers.location).toBeUndefined();
    });

    it('serve_webclient 302s to /webclient/ once servable (relative-asset + SW-scope correctness)', async () => {
      const handler = createRootApexHandler({
        getApexMode: () => 'serve_webclient',
        getWebclientServable: () => true,
      });
      const res = new FakeRes();
      await handler(
        buildReq({ method: 'GET', host: 'recued.example.com', url: '/' }),
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/webclient/');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-length']).toBe('0');
    });

    it('serve_webclient HEAD also 302s (a redirect is side-effect-free — no HEAD special-case)', async () => {
      const handler = createRootApexHandler({
        getApexMode: () => 'serve_webclient',
        getWebclientServable: () => true,
      });
      const res = new FakeRes();
      await handler(
        buildReq({ method: 'HEAD', host: 'recued.example.com', url: '/' }),
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/webclient/');
    });

    it('serve_webclient awaits an async getWebclientServable', async () => {
      const handler = createRootApexHandler({
        getApexMode: () => 'serve_webclient',
        getWebclientServable: async () => true,
      });
      const res = new FakeRes();
      await handler(
        buildReq({ method: 'GET', host: 'recued.example.com', url: '/' }),
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/webclient/');
    });

    it('still 405s a non-GET/HEAD method regardless of mode', async () => {
      const handler = createRootApexHandler({ getApexMode: () => 'serve_reception' });
      const res = new FakeRes();
      await handler(
        buildReq({ method: 'POST', host: 'recued.example.com' }),
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(405);
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Offline-pairing convenience — LAN webclient root handler.
//
// `createLanWebclientRootHandler` governs the LAN listener's bare `/`
// (mirror of the public apex handler above). Its single useful behavior:
// land the operator on `/webclient/` to pair to their own server offline
// when a verified bundle is servable on the LAN grid bit; otherwise 404.
// No host gate — the LAN bind scopes reachability; the visitor is the user.
// ────────────────────────────────────────────────────────────────

describe('Offline-pairing — LAN webclient root handler', () => {
  const runLan = async (
    args: { method?: string; url?: string; host?: string | undefined },
    handler: ReturnType<typeof createLanWebclientRootHandler>,
  ): Promise<FakeRes> => {
    const res = new FakeRes();
    await handler(buildReq(args), res as unknown as ServerResponse);
    return res;
  };

  describe('servable — 302 to /webclient/', () => {
    it('GET 302s to /webclient/ with no-store + content-length 0 + empty body', async () => {
      const res = await runLan(
        { method: 'GET', host: '192.168.1.42' },
        createLanWebclientRootHandler({ getWebclientServable: () => true }),
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/webclient/');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-length']).toBe('0');
      expect(res.body).toBe('');
    });

    it('HEAD also 302s (a redirect is side-effect-free — no HEAD special-case)', async () => {
      const res = await runLan(
        { method: 'HEAD', host: 'localhost' },
        createLanWebclientRootHandler({ getWebclientServable: () => true }),
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/webclient/');
    });

    it('does NOT host-gate — any Host reaches the redirect (the LAN visitor is the user)', async () => {
      // Contrast with the apex `redirect` mode, which 404s a non-recued.cloud
      // Host. On LAN the bind already scopes reachability, so no host gate.
      const res = await runLan(
        { method: 'GET', host: 'anything.example' },
        createLanWebclientRootHandler({ getWebclientServable: () => true }),
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/webclient/');
    });

    it('awaits an async getWebclientServable', async () => {
      const res = await runLan(
        { method: 'GET' },
        createLanWebclientRootHandler({ getWebclientServable: async () => true }),
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/webclient/');
    });

    it('upper-cases a mixed-case method before the gate', async () => {
      const res = await runLan(
        { method: 'get' },
        createLanWebclientRootHandler({ getWebclientServable: () => true }),
      );
      expect(res.statusCode).toBe(302);
    });
  });

  describe('not servable — 404 (a source build with no bundle still 404s)', () => {
    it('404s when getWebclientServable returns false', async () => {
      const res = await runLan(
        { method: 'GET' },
        createLanWebclientRootHandler({ getWebclientServable: () => false }),
      );
      expect(res.statusCode).toBe(404);
      expect(res.headers.location).toBeUndefined();
      expect(JSON.parse(res.body ?? 'null')).toEqual({ error: { code: 'not_found' } });
    });

    it('404s when getWebclientServable is omitted (undefined → not servable)', async () => {
      const res = await runLan({ method: 'GET' }, createLanWebclientRootHandler());
      expect(res.statusCode).toBe(404);
    });

    it('404s when an async getWebclientServable resolves false', async () => {
      const res = await runLan(
        { method: 'GET' },
        createLanWebclientRootHandler({ getWebclientServable: async () => false }),
      );
      expect(res.statusCode).toBe(404);
    });

    it('404 body matches the generic dispatcher unknown-path shape', async () => {
      const res = await runLan(
        { method: 'GET' },
        createLanWebclientRootHandler({ getWebclientServable: () => false }),
      );
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.body).toBe(JSON.stringify({ error: { code: 'not_found' } }));
    });
  });

  describe('method rejection — 405 runs BEFORE the servability gate', () => {
    it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])(
      '%s returns 405 with Allow: GET, HEAD even when servable',
      async (method) => {
        const servable = vi.fn(() => true);
        const res = await runLan(
          { method },
          createLanWebclientRootHandler({ getWebclientServable: servable }),
        );
        expect(res.statusCode).toBe(405);
        expect(res.headers.allow).toBe('GET, HEAD');
        expect(res.headers.location).toBeUndefined();
        // The method gate fires first — servability is never consulted.
        expect(servable).not.toHaveBeenCalled();
      },
    );
  });

  describe('idempotency + logging', () => {
    it('is a no-op when the response has already ended', async () => {
      const handler = createLanWebclientRootHandler({ getWebclientServable: () => true });
      const res = new FakeRes();
      res.writableEnded = true;
      res.statusCode = 200;
      await handler(buildReq({ method: 'GET' }), res as unknown as ServerResponse);
      expect(res.statusCode).toBe(200);
      expect(res.headers.location).toBeUndefined();
    });

    it('emits one info log per dispatch decision (302 / 404 / 405)', async () => {
      const calls: Array<{ level: string; msg: string }> = [];
      const log = (level: 'info' | 'warn', msg: string) => calls.push({ level, msg });
      await runLan({ method: 'GET' }, createLanWebclientRootHandler({ getWebclientServable: () => true, log }));
      await runLan({ method: 'GET' }, createLanWebclientRootHandler({ getWebclientServable: () => false, log }));
      await runLan({ method: 'POST' }, createLanWebclientRootHandler({ getWebclientServable: () => true, log }));
      expect(calls.map((c) => c.msg)).toEqual([
        expect.stringMatching(/302/),
        expect.stringMatching(/not servable/),
        expect.stringMatching(/method not allowed/),
      ]);
    });
  });
});
