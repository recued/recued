/** D-148 W3.3 — path-router dispatcher tests.
 *
 *  Pure unit tests against a stub IncomingMessage / ServerResponse pair
 *  (request side) and a stub Socket (upgrade side) — no actual http
 *  server required. The dispatcher is provider-agnostic; it just
 *  inspects `req.url` + delegates to handlers. Listener-level wiring
 *  (createServer + .listen()) lives in `listener-set.test.ts` and is
 *  the W3.4 layer's concern. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PATH_RESOLUTION,
  EXPOSURE_PRESET_PATH_MAP,
  PATH_FOR_ROLE,
  PATH_ROLES,
  totalRecord,
  type PathResolution,
  type PathRole,
} from '@recued/contracts';
import { createPathRouter, type PathRouterListener } from '../path-router.js';
import type { PortRequestHandler, PortUpgradeHandler } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Stubs — IncomingMessage / ServerResponse / Socket
// ────────────────────────────────────────────────────────────────

interface StubResponse {
  res: ServerResponse;
  statusCode: () => number;
  body: () => string;
  contentType: () => string | undefined;
}

interface StubSocket {
  socket: Socket;
  written: () => string;
  destroyed: () => boolean;
}

const buildReq = (url: string): IncomingMessage => {
  return { url } as unknown as IncomingMessage;
};

const buildRes = (): StubResponse => {
  let statusCode = 0;
  let body = '';
  let contentType: string | undefined;
  let writableEnded = false;
  const headersSent = false;
  const headers: Record<string, string> = {};
  const res = {
    get statusCode() { return statusCode; },
    set statusCode(v: number) { statusCode = v; },
    get writableEnded() { return writableEnded; },
    get headersSent() { return headersSent; },
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
      if (k.toLowerCase() === 'content-type') contentType = v;
    },
    end: (chunk?: string) => {
      if (chunk) body += chunk;
      writableEnded = true;
    },
    getHeader: (k: string) => headers[k.toLowerCase()],
  } as unknown as ServerResponse;
  return {
    res,
    statusCode: () => statusCode,
    body: () => body,
    contentType: () => contentType,
  };
};

const buildSocket = (): StubSocket => {
  let written = '';
  let destroyed = false;
  const socket = {
    write: (chunk: string) => { written += chunk; return true; },
    destroy: () => { destroyed = true; },
  } as unknown as Socket;
  return {
    socket,
    written: () => written,
    destroyed: () => destroyed,
  };
};


const buildRoleHandlers = (
  spy?: (role: PathRole, url: string) => void,
): Record<PathRole, PortRequestHandler> => {
  const out = totalRecord(PATH_ROLES, (role): PortRequestHandler => {
    return (req, res) => {
      spy?.(role, req.url ?? '');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end(`role:${role}`);
    };
  });
  return out;
};

const buildUpgradeHandler = (
  spy?: (role: PathRole, url: string) => void,
): PortUpgradeHandler => (req, _socket, _head) => {
  spy?.('ws', req.url ?? '');
};

const allOn: Record<PathRole, PathResolution> = {
  health: { lan: true, public: true },
  ws: { lan: true, public: true },
  mcp: { lan: true, public: true },
  llm_gateway: { lan: true, public: true },
  webhooks: { lan: true, public: true },
  reception: { lan: true, public: true },
  oauth: { lan: true, public: true },
  ask: { lan: true, public: true },
  webclient: { lan: true, public: true },
};

const allOff: Record<PathRole, PathResolution> = {
  health: { lan: false, public: false },
  ws: { lan: false, public: false },
  mcp: { lan: false, public: false },
  llm_gateway: { lan: false, public: false },
  webhooks: { lan: false, public: false },
  reception: { lan: false, public: false },
  oauth: { lan: false, public: false },
  ask: { lan: false, public: false },
  webclient: { lan: false, public: false },
};

const parse404 = (body: string): { code?: string } => {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string } };
    return parsed.error ?? {};
  } catch {
    return {};
  }
};

// ────────────────────────────────────────────────────────────────
// Request side — happy path per role
// ────────────────────────────────────────────────────────────────

describe('path-router request — happy path per role', () => {
  // ⛔ PATH_ROLES, NOT A HAND-SPELLED LIST. This used to iterate a local six while
  // `PathRole` had NINE, so `oauth`, `ask` and `webclient` routing was never
  // exercised — and the handler map's cast to a total `Record<PathRole, …>` meant
  // nothing said so. Driving the parametrised test off the canonical list means a
  // new role joins it by itself.
  it.each(PATH_ROLES)('dispatches /<role-base> to the matching handler', async (role) => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(spy),
      listener: 'lan',
    });
    const { res, statusCode, body } = buildRes();
    const path = PATH_FOR_ROLE[role];
    await router.request(buildReq(path), res);
    expect(statusCode()).toBe(200);
    expect(body()).toBe(`role:${role}`);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(role, path);
  });

  it('dispatches /mcp/catalog to the mcp handler (sub-path delegation)', async () => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(spy),
      listener: 'lan',
    });
    const { res, body } = buildRes();
    await router.request(buildReq('/mcp/catalog'), res);
    expect(body()).toBe('role:mcp');
    expect(spy).toHaveBeenCalledWith('mcp', '/mcp/catalog');
  });

  it('dispatches /webhooks/<vendor>/<conn> to the webhooks handler', async () => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(spy),
      listener: 'lan',
    });
    const { res, body } = buildRes();
    await router.request(buildReq('/webhooks/hubspot/abc-123'), res);
    expect(body()).toBe('role:webhooks');
    expect(spy).toHaveBeenCalledWith('webhooks', '/webhooks/hubspot/abc-123');
  });

  it('dispatches /reception/_health + /reception/intake/<id> to the reception handler', async () => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(spy),
      listener: 'lan',
    });
    const { res: r1, body: b1 } = buildRes();
    const { res: r2, body: b2 } = buildRes();
    await router.request(buildReq('/reception/_health'), r1);
    await router.request(buildReq('/reception/intake/end_abc'), r2);
    expect(b1()).toBe('role:reception');
    expect(b2()).toBe('role:reception');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('strips ?query string before role matching', async () => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(spy),
      listener: 'lan',
    });
    const { res, body } = buildRes();
    await router.request(buildReq('/mcp/catalog?token=abc&trace=1'), res);
    expect(body()).toBe('role:mcp');
  });
});

// ────────────────────────────────────────────────────────────────
// Request side — 404 on unknown paths
// ────────────────────────────────────────────────────────────────

describe('path-router request — 404 on unknown paths', () => {
  it.each([
    '/',
    '',
    '/foo',
    '/mcpevil',
    '/webhooksevil',
    '/receptionx',
    '/healthcheck',
    '/wsx',
  ])('returns 404 for %s (no role match)', async (path) => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(spy),
      listener: 'lan',
    });
    const { res, statusCode, body, contentType } = buildRes();
    await router.request(buildReq(path), res);
    expect(statusCode()).toBe(404);
    expect(contentType()).toBe('application/json; charset=utf-8');
    expect(parse404(body()).code).toBe('not_found');
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 404 for undefined req.url', async () => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(spy),
      listener: 'lan',
    });
    const { res, statusCode } = buildRes();
    await router.request({ url: undefined } as unknown as IncomingMessage, res);
    expect(statusCode()).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// Request side — 404 on disabled paths
// ────────────────────────────────────────────────────────────────

describe('path-router request — 404 on disabled paths', () => {
  it('returns 404 when the role exists but the listener bit is false', async () => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: {
        health: { lan: false, public: true },
        ws: { lan: true, public: false },
        mcp: { lan: true, public: false },
        llm_gateway: { lan: false, public: false },
        webhooks: { lan: false, public: false },
        reception: { lan: false, public: false },
        oauth: { lan: false, public: false },
        ask: { lan: false, public: false },
        webclient: { lan: false, public: false },
      },
      handlers: buildRoleHandlers(spy),
      listener: 'lan',
    });
    // /health has lan=false on the lan listener
    const { res: r1, statusCode: s1 } = buildRes();
    await router.request(buildReq('/health'), r1);
    expect(s1()).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    // /ws has lan=true → dispatches
    const { res: r2, statusCode: s2 } = buildRes();
    await router.request(buildReq('/ws'), r2);
    expect(s2()).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shares the same generic 404 body for unknown vs disabled paths (no fingerprint)', async () => {
    const router = createPathRouter({
      resolution: {
        ...allOn,
        webhooks: { lan: false, public: false },
      },
      handlers: buildRoleHandlers(),
      listener: 'lan',
    });
    const { res: r1, statusCode: s1, body: b1, contentType: c1 } = buildRes();
    await router.request(buildReq('/webhooks/hubspot/x'), r1);
    const { res: r2, statusCode: s2, body: b2, contentType: c2 } = buildRes();
    await router.request(buildReq('/totally-unknown'), r2);
    expect(s1()).toBe(s2());
    expect(b1()).toBe(b2());
    expect(c1()).toBe(c2());
  });

  it('returns 404 for every path when resolution is all-off (maintenance preset shape)', async () => {
    const router = createPathRouter({
      resolution: allOff,
      handlers: buildRoleHandlers(),
      listener: 'lan',
    });
    for (const path of ['/health', '/ws', '/mcp', '/mcp/catalog', '/webhooks/slack/x', '/reception/_health']) {
      const { res, statusCode } = buildRes();
      await router.request(buildReq(path), res);
      expect(statusCode()).toBe(404);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Request side — 404 on unwired handler
// ────────────────────────────────────────────────────────────────

describe('path-router request — 404 on unwired handler', () => {
  it('returns 404 when the role is resolved but the handler is missing', async () => {
    const router = createPathRouter({
      resolution: allOn,
      handlers: { health: (req, res) => { res.statusCode = 200; res.end('h'); } },
      listener: 'lan',
    });
    const { res, statusCode, body } = buildRes();
    await router.request(buildReq('/mcp'), res);
    expect(statusCode()).toBe(404);
    expect(parse404(body()).code).toBe('not_found');
  });

  it('emits a warn-level log when a handler is missing (diagnostic only)', async () => {
    const log = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: {},
      listener: 'lan',
      log,
    });
    const { res } = buildRes();
    await router.request(buildReq('/ws'), res);
    expect(log).toHaveBeenCalled();
    const warns = log.mock.calls.filter(([level]) => level === 'warn');
    expect(warns.length).toBe(1);
    expect(warns[0][1]).toMatch(/handler missing/);
  });
});

// ────────────────────────────────────────────────────────────────
// Request side — cross-channel isolation
// ────────────────────────────────────────────────────────────────

describe('path-router request — cross-channel isolation', () => {
  it('dispatches /webhooks/<vendor> to webhooks handler only, never to mcp handler', async () => {
    const calls: PathRole[] = [];
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers((role) => calls.push(role)),
      listener: 'lan',
    });
    const { res } = buildRes();
    await router.request(buildReq('/webhooks/anything/at/all'), res);
    expect(calls).toEqual(['webhooks']);
  });

  it('dispatches /mcp/catalog to mcp handler only, never to webhooks or reception handler', async () => {
    const calls: PathRole[] = [];
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers((role) => calls.push(role)),
      listener: 'lan',
    });
    const { res } = buildRes();
    await router.request(buildReq('/mcp/catalog'), res);
    expect(calls).toEqual(['mcp']);
  });

  it('never dispatches to more than one handler for a single request', async () => {
    const calls: PathRole[] = [];
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers((role) => calls.push(role)),
      listener: 'lan',
    });
    for (const path of [
      '/health',
      '/ws',
      '/mcp',
      '/mcp/catalog',
      '/webhooks/x/y',
      '/reception/_health',
      '/reception/intake/abc',
    ]) {
      calls.length = 0;
      const { res } = buildRes();
      await router.request(buildReq(path), res);
      expect(calls.length).toBe(1);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Request side — LAN vs public listener-bit dispatch
// ────────────────────────────────────────────────────────────────

describe('path-router request — lan vs public listener-bit', () => {
  const split: Record<PathRole, PathResolution> = {
    health: { lan: true, public: true },
    ws: { lan: true, public: false },
    mcp: { lan: true, public: false },
    llm_gateway: { lan: true, public: false },
    webhooks: { lan: false, public: true },
    reception: { lan: false, public: false },
    oauth: { lan: false, public: false },
    ask: { lan: false, public: false },
    webclient: { lan: false, public: false },
  };

  const buildBoth = () => {
    const calls: PathRole[] = [];
    const handlers = buildRoleHandlers((role) => calls.push(role));
    const lan = createPathRouter({ resolution: split, handlers, listener: 'lan' });
    const pub = createPathRouter({ resolution: split, handlers, listener: 'public' });
    return { lan, public: pub, calls };
  };

  it('same resolution serves /ws on lan but 404 on public', async () => {
    const { lan, public: pub, calls } = buildBoth();
    const r1 = buildRes(); await lan.request(buildReq('/ws'), r1.res);
    expect(r1.statusCode()).toBe(200);
    expect(calls).toEqual(['ws']);
    calls.length = 0;
    const r2 = buildRes(); await pub.request(buildReq('/ws'), r2.res);
    expect(r2.statusCode()).toBe(404);
    expect(calls).toEqual([]);
  });

  it('same resolution serves /webhooks on public but 404 on lan', async () => {
    const { lan, public: pub, calls } = buildBoth();
    const r1 = buildRes(); await pub.request(buildReq('/webhooks/slack/x'), r1.res);
    expect(r1.statusCode()).toBe(200);
    expect(calls).toEqual(['webhooks']);
    calls.length = 0;
    const r2 = buildRes(); await lan.request(buildReq('/webhooks/slack/x'), r2.res);
    expect(r2.statusCode()).toBe(404);
    expect(calls).toEqual([]);
  });

  it('both listeners serve /health when both bits are true', async () => {
    const { lan, public: pub, calls } = buildBoth();
    const r1 = buildRes(); await lan.request(buildReq('/health'), r1.res);
    const r2 = buildRes(); await pub.request(buildReq('/health'), r2.res);
    expect(r1.statusCode()).toBe(200);
    expect(r2.statusCode()).toBe(200);
    expect(calls).toEqual(['health', 'health']);
  });

  it('neither listener serves /reception when both bits are false', async () => {
    const { lan, public: pub, calls } = buildBoth();
    const r1 = buildRes(); await lan.request(buildReq('/reception/_health'), r1.res);
    const r2 = buildRes(); await pub.request(buildReq('/reception/_health'), r2.res);
    expect(r1.statusCode()).toBe(404);
    expect(r2.statusCode()).toBe(404);
    expect(calls).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Request side — preset integration
// ────────────────────────────────────────────────────────────────

describe('path-router request — preset integration', () => {
  it('lan_only preset serves /health /ws /mcp on lan listener; 404 on public', async () => {
    const handlers = buildRoleHandlers();
    const lan = createPathRouter({
      resolution: EXPOSURE_PRESET_PATH_MAP.lan_only,
      handlers,
      listener: 'lan',
    });
    const pub = createPathRouter({
      resolution: EXPOSURE_PRESET_PATH_MAP.lan_only,
      handlers,
      listener: 'public',
    });
    for (const path of ['/health', '/ws', '/mcp']) {
      const r1 = buildRes(); await lan.request(buildReq(path), r1.res);
      const r2 = buildRes(); await pub.request(buildReq(path), r2.res);
      expect(r1.statusCode()).toBe(200);
      expect(r2.statusCode()).toBe(404);
    }
    for (const path of ['/webhooks/x/y', '/reception/_health']) {
      const r1 = buildRes(); await lan.request(buildReq(path), r1.res);
      expect(r1.statusCode()).toBe(404);
    }
  });

  it('maintenance preset returns 404 for every path on both listeners', async () => {
    const handlers = buildRoleHandlers();
    const lan = createPathRouter({
      resolution: EXPOSURE_PRESET_PATH_MAP.maintenance,
      handlers,
      listener: 'lan',
    });
    const pub = createPathRouter({
      resolution: EXPOSURE_PRESET_PATH_MAP.maintenance,
      handlers,
      listener: 'public',
    });
    for (const path of ['/health', '/ws', '/mcp', '/mcp/catalog', '/webhooks/slack/x', '/reception/_health']) {
      const r1 = buildRes(); await lan.request(buildReq(path), r1.res);
      const r2 = buildRes(); await pub.request(buildReq(path), r2.res);
      expect(r1.statusCode()).toBe(404);
      expect(r2.statusCode()).toBe(404);
    }
  });

  it('DEFAULT_PATH_RESOLUTION dispatches lan-only-shaped traffic', async () => {
    const handlers = buildRoleHandlers();
    const lan = createPathRouter({
      resolution: DEFAULT_PATH_RESOLUTION,
      handlers,
      listener: 'lan',
    });
    const pub = createPathRouter({
      resolution: DEFAULT_PATH_RESOLUTION,
      handlers,
      listener: 'public',
    });
    const r1 = buildRes(); await lan.request(buildReq('/health'), r1.res);
    const r2 = buildRes(); await pub.request(buildReq('/health'), r2.res);
    expect(r1.statusCode()).toBe(200);
    expect(r2.statusCode()).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────────
// Request side — handler return value
// ────────────────────────────────────────────────────────────────

describe('path-router request — handler return value', () => {
  it('returns the handler\'s promise so caller can await it', async () => {
    let resolved = false;
    const router = createPathRouter({
      resolution: allOn,
      handlers: {
        mcp: async (_req, res) => {
          await new Promise((r) => setTimeout(r, 5));
          resolved = true;
          res.statusCode = 200;
          res.end('done');
        },
      } as Partial<Record<PathRole, PortRequestHandler>>,
      listener: 'lan',
    });
    const { res, body } = buildRes();
    const result = router.request(buildReq('/mcp'), res);
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(resolved).toBe(true);
    expect(body()).toBe('done');
  });

  it('does not leak handler return as the 404 path return', async () => {
    const router = createPathRouter({
      resolution: allOff,
      handlers: buildRoleHandlers(),
      listener: 'lan',
    });
    const { res } = buildRes();
    const result = router.request(buildReq('/totally-unknown'), res);
    expect(result).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Request side — diagnostic logging
// ────────────────────────────────────────────────────────────────

describe('path-router request — diagnostic logging', () => {
  it('does not emit warn on successful dispatch', async () => {
    const log = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      listener: 'lan',
      log,
    });
    const { res } = buildRes();
    await router.request(buildReq('/health'), res);
    expect(log.mock.calls.filter(([level]) => level === 'warn').length).toBe(0);
  });

  it('emits info on unknown path (no fingerprint in the body itself)', async () => {
    const log = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      listener: 'lan',
      log,
    });
    const { res, body } = buildRes();
    await router.request(buildReq('/totally-unknown'), res);
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toBe('info');
    expect(body()).toBe('{"error":{"code":"not_found"}}');
  });

  it('emits info on disabled path on this listener', async () => {
    const log = vi.fn();
    const router = createPathRouter({
      resolution: { ...allOn, webhooks: { lan: false, public: true } },
      handlers: buildRoleHandlers(),
      listener: 'lan',
      log,
    });
    const { res } = buildRes();
    await router.request(buildReq('/webhooks/slack/x'), res);
    const infoCalls = log.mock.calls.filter(([level]) => level === 'info');
    expect(infoCalls.length).toBeGreaterThan(0);
    expect(infoCalls[0][1]).toMatch(/disabled/);
  });
});

// ────────────────────────────────────────────────────────────────
// Upgrade side — Codex P1 #1 fold; routes real WS handshakes
// ────────────────────────────────────────────────────────────────

describe('path-router upgrade — happy path', () => {
  it('dispatches /ws upgrade to the ws upgrade handler', () => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: { ws: buildUpgradeHandler(spy) },
      listener: 'lan',
    });
    const sock = buildSocket();
    router.upgrade(buildReq('/ws'), sock.socket, Buffer.from(''));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('ws', '/ws');
    expect(sock.destroyed()).toBe(false);
    expect(sock.written()).toBe('');
  });

  it('strips query string before dispatching /ws?token=abc', () => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: { ws: buildUpgradeHandler(spy) },
      listener: 'lan',
    });
    const sock = buildSocket();
    router.upgrade(buildReq('/ws?token=abc'), sock.socket, Buffer.from(''));
    expect(spy).toHaveBeenCalledWith('ws', '/ws?token=abc');
    expect(sock.destroyed()).toBe(false);
  });

  it('passes through the raw head buffer to the upgrade handler', () => {
    let receivedHead: Buffer | null = null;
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: {
        ws: (_req, _socket, head) => { receivedHead = head; },
      },
      listener: 'lan',
    });
    const sock = buildSocket();
    const head = Buffer.from('xyz-head-bytes');
    router.upgrade(buildReq('/ws'), sock.socket, head);
    expect(receivedHead).toBe(head);
  });
});

describe('path-router upgrade — 404 (raw HTTP/1.1 + close)', () => {
  const expect404Line = (written: string): void => {
    expect(written).toMatch(/^HTTP\/1\.1 404 Not Found/);
    expect(written).toMatch(/Connection: close/);
    expect(written).toMatch(/\r\n\r\n$/);
  };

  it('rejects upgrade on unknown path', () => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: { ws: buildUpgradeHandler(spy) },
      listener: 'lan',
    });
    const sock = buildSocket();
    router.upgrade(buildReq('/totally-unknown'), sock.socket, Buffer.from(''));
    expect(spy).not.toHaveBeenCalled();
    expect(sock.destroyed()).toBe(true);
    expect404Line(sock.written());
  });

  it('rejects upgrade when listener bit is false (disabled)', () => {
    const spy = vi.fn();
    const router = createPathRouter({
      resolution: { ...allOn, ws: { lan: false, public: true } },
      handlers: buildRoleHandlers(),
      upgradeHandlers: { ws: buildUpgradeHandler(spy) },
      listener: 'lan',
    });
    const sock = buildSocket();
    router.upgrade(buildReq('/ws'), sock.socket, Buffer.from(''));
    expect(spy).not.toHaveBeenCalled();
    expect(sock.destroyed()).toBe(true);
    expect404Line(sock.written());
  });

  it('rejects upgrade when ws is enabled but no upgrade handler is wired', () => {
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: {},
      listener: 'lan',
    });
    const sock = buildSocket();
    router.upgrade(buildReq('/ws'), sock.socket, Buffer.from(''));
    expect(sock.destroyed()).toBe(true);
    expect404Line(sock.written());
  });

  it('rejects upgrade on /mcp (resolved role but role does not speak WS)', () => {
    // Upgrade attempt against /mcp: role resolves, listener bit true,
    // but no upgrade handler wired for mcp. Should 404 + close — no
    // fingerprint that mcp accepts requests but not upgrades.
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: { ws: buildUpgradeHandler() },
      listener: 'lan',
    });
    const sock = buildSocket();
    router.upgrade(buildReq('/mcp/catalog'), sock.socket, Buffer.from(''));
    expect(sock.destroyed()).toBe(true);
    expect404Line(sock.written());
  });

  it('returns 404 for undefined req.url on upgrade', () => {
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: { ws: buildUpgradeHandler() },
      listener: 'lan',
    });
    const sock = buildSocket();
    router.upgrade({ url: undefined } as unknown as IncomingMessage, sock.socket, Buffer.from(''));
    expect(sock.destroyed()).toBe(true);
    expect404Line(sock.written());
  });
});

describe('path-router upgrade — listener-bit + cross-channel isolation', () => {
  const split: Record<PathRole, PathResolution> = {
    health: { lan: true, public: true },
    ws: { lan: true, public: false },
    mcp: { lan: true, public: false },
    llm_gateway: { lan: true, public: false },
    webhooks: { lan: false, public: true },
    reception: { lan: false, public: false },
    oauth: { lan: false, public: false },
    ask: { lan: false, public: false },
    webclient: { lan: false, public: false },
  };

  it('serves /ws upgrade on lan listener only when public bit is false', () => {
    const spy = vi.fn();
    const handlers = buildRoleHandlers();
    const lan = createPathRouter({
      resolution: split,
      handlers,
      upgradeHandlers: { ws: buildUpgradeHandler(spy) },
      listener: 'lan',
    });
    const pub = createPathRouter({
      resolution: split,
      handlers,
      upgradeHandlers: { ws: buildUpgradeHandler(spy) },
      listener: 'public',
    });

    const s1 = buildSocket();
    lan.upgrade(buildReq('/ws'), s1.socket, Buffer.from(''));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(s1.destroyed()).toBe(false);

    const s2 = buildSocket();
    pub.upgrade(buildReq('/ws'), s2.socket, Buffer.from(''));
    expect(spy).toHaveBeenCalledTimes(1); // still 1 — public bit false
    expect(s2.destroyed()).toBe(true);
  });

  it('cross-channel isolation — upgrade routed to the matching role only', () => {
    const wsSpy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: {
        ws: buildUpgradeHandler(wsSpy),
        // Pretend webhooks accepts upgrades too — they should be
        // routed correctly without leaking to the ws handler.
        webhooks: (_req, _socket, _head) => { /* webhook-specific */ },
      },
      listener: 'lan',
    });
    const sock1 = buildSocket();
    router.upgrade(buildReq('/webhooks/foo/bar'), sock1.socket, Buffer.from(''));
    expect(wsSpy).not.toHaveBeenCalled();
    expect(sock1.destroyed()).toBe(false);

    const sock2 = buildSocket();
    router.upgrade(buildReq('/ws'), sock2.socket, Buffer.from(''));
    expect(wsSpy).toHaveBeenCalledTimes(1);
  });

  it('maintenance preset rejects every upgrade on both listeners', () => {
    const spy = vi.fn();
    const handlers = buildRoleHandlers();
    const lan = createPathRouter({
      resolution: EXPOSURE_PRESET_PATH_MAP.maintenance,
      handlers,
      upgradeHandlers: { ws: buildUpgradeHandler(spy) },
      listener: 'lan',
    });
    const pub = createPathRouter({
      resolution: EXPOSURE_PRESET_PATH_MAP.maintenance,
      handlers,
      upgradeHandlers: { ws: buildUpgradeHandler(spy) },
      listener: 'public',
    });
    for (const path of ['/ws', '/ws/sub', '/mcp', '/webhooks/x/y']) {
      const s1 = buildSocket(); lan.upgrade(buildReq(path), s1.socket, Buffer.from(''));
      const s2 = buildSocket(); pub.upgrade(buildReq(path), s2.socket, Buffer.from(''));
      expect(s1.destroyed()).toBe(true);
      expect(s2.destroyed()).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('path-router upgrade — diagnostic logging', () => {
  it('emits info on rejected upgrade (unknown path)', () => {
    const log = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: { ws: buildUpgradeHandler() },
      listener: 'lan',
      log,
    });
    const sock = buildSocket();
    router.upgrade(buildReq('/totally-unknown'), sock.socket, Buffer.from(''));
    const infoCalls = log.mock.calls.filter(([level]) => level === 'info');
    expect(infoCalls.length).toBeGreaterThan(0);
    expect(infoCalls[0][1]).toMatch(/upgrade 404 \(unknown path\)/);
  });

  it('emits warn on rejected upgrade (unwired handler)', () => {
    const log = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: {},
      listener: 'lan',
      log,
    });
    const sock = buildSocket();
    router.upgrade(buildReq('/ws'), sock.socket, Buffer.from(''));
    const warns = log.mock.calls.filter(([level]) => level === 'warn');
    expect(warns.length).toBe(1);
    expect(warns[0][1]).toMatch(/upgrade handler missing/);
  });
});

describe('path-router upgrade — socket close is idempotent', () => {
  it('does not throw when socket.write fails (socket already closed)', () => {
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: {},
      listener: 'lan',
    });
    const socket = {
      write: () => { throw new Error('socket closed'); },
      destroy: vi.fn(),
    } as unknown as Socket;
    expect(() => router.upgrade(buildReq('/totally-unknown'), socket, Buffer.from(''))).not.toThrow();
    expect((socket.destroy as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('does not throw when socket.destroy throws (idempotent)', () => {
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: {},
      listener: 'lan',
    });
    const socket = {
      write: () => true,
      destroy: () => { throw new Error('already destroyed'); },
    } as unknown as Socket;
    expect(() => router.upgrade(buildReq('/totally-unknown'), socket, Buffer.from(''))).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// PathRouterListener type narrowing
// ────────────────────────────────────────────────────────────────

describe('path-router — PathRouterListener type', () => {
  it('accepts lan + public values', () => {
    const lan: PathRouterListener = 'lan';
    const pub: PathRouterListener = 'public';
    expect(lan).toBe('lan');
    expect(pub).toBe('public');
  });
});

// ────────────────────────────────────────────────────────────────
// D-148 FU#7 — bare-root request carve-out
// ────────────────────────────────────────────────────────────────

describe('path-router request — D-148 FU#7 root handler', () => {
  it('dispatches bare / to the rootHandler on the public listener', async () => {
    const roleSpy = vi.fn();
    const rootSpy = vi.fn();
    const rootHandler: PortRequestHandler = (req, res) => {
      rootSpy(req.url ?? '');
      res.statusCode = 302;
      res.setHeader('location', 'https://example.test/');
      res.end();
    };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(roleSpy),
      rootHandler,
      listener: 'public',
    });
    const { res, statusCode } = buildRes();
    await router.request(buildReq('/'), res);
    expect(statusCode()).toBe(302);
    expect(rootSpy).toHaveBeenCalledTimes(1);
    expect(roleSpy).not.toHaveBeenCalled();
  });

  it('does NOT dispatch bare / to the rootHandler on the lan listener (LAN visitors are the user)', async () => {
    const rootSpy = vi.fn();
    const rootHandler: PortRequestHandler = (_req, res) => {
      rootSpy();
      res.statusCode = 302;
      res.end();
    };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      rootHandler,
      listener: 'lan',
    });
    const { res, statusCode, body } = buildRes();
    await router.request(buildReq('/'), res);
    expect(statusCode()).toBe(404);
    expect(parse404(body()).code).toBe('not_found');
    expect(rootSpy).not.toHaveBeenCalled();
  });

  it('does NOT dispatch role bases or sub-paths to the rootHandler', async () => {
    const rootSpy = vi.fn();
    const roleSpy = vi.fn();
    const rootHandler: PortRequestHandler = (_req, res) => { rootSpy(); res.end(); };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(roleSpy),
      rootHandler,
      listener: 'public',
    });
    for (const path of ['/health', '/ws', '/mcp', '/mcp/catalog', '/webhooks/slack/x', '/reception/_health']) {
      const { res } = buildRes();
      await router.request(buildReq(path), res);
    }
    expect(rootSpy).not.toHaveBeenCalled();
    expect(roleSpy).toHaveBeenCalledTimes(6);
  });

  it('strips ?query before matching bare / against the rootHandler', async () => {
    const rootSpy = vi.fn();
    const rootHandler: PortRequestHandler = (_req, res) => {
      rootSpy();
      res.statusCode = 302;
      res.end();
    };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      rootHandler,
      listener: 'public',
    });
    const { res, statusCode } = buildRes();
    await router.request(buildReq('/?pair=alice&utm=evil#frag'), res);
    expect(statusCode()).toBe(302);
    expect(rootSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to 404 when rootHandler is unset on the public listener', async () => {
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      listener: 'public',
    });
    const { res, statusCode, body } = buildRes();
    await router.request(buildReq('/'), res);
    expect(statusCode()).toBe(404);
    expect(parse404(body()).code).toBe('not_found');
  });

  it('upgrade-side bare / continues to reject (root surface is request-only)', async () => {
    const rootHandler: PortRequestHandler = (_req, res) => {
      res.statusCode = 302;
      res.end();
    };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: { ws: buildUpgradeHandler() },
      rootHandler,
      listener: 'public',
    });
    const { socket, written } = buildSocket();
    router.upgrade(buildReq('/'), socket, Buffer.from(''));
    expect(written()).toMatch(/^HTTP\/1\.1 404 Not Found/);
  });

  it('emits an info-level log when dispatching bare / to the rootHandler', async () => {
    const log = vi.fn();
    const rootHandler: PortRequestHandler = (_req, res) => {
      res.statusCode = 302;
      res.end();
    };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      rootHandler,
      listener: 'public',
      log,
    });
    const { res } = buildRes();
    await router.request(buildReq('/'), res);
    const infos = log.mock.calls.filter(([level, msg]) => level === 'info' && /root handler dispatched/.test(String(msg)));
    expect(infos.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Offline-pairing convenience — LAN-only bare-root carve-out. The
// mirror of the D-148 FU#7 public `rootHandler` above, but the opposite
// listener: `lanRootHandler` fires bare `/` on the LAN bit only (lands the
// operator on `/webclient/`); the public bit keeps the app.recued.com
// redirect. The two slots never cross-fire.
// ────────────────────────────────────────────────────────────────

describe('path-router request — LAN bare-root handler (lanRootHandler)', () => {
  it('dispatches bare / to the lanRootHandler on the LAN listener', async () => {
    const roleSpy = vi.fn();
    const lanSpy = vi.fn();
    const lanRootHandler: PortRequestHandler = (req, res) => {
      lanSpy(req.url ?? '');
      res.statusCode = 302;
      res.setHeader('location', '/webclient/');
      res.end();
    };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(roleSpy),
      lanRootHandler,
      listener: 'lan',
    });
    const { res, statusCode } = buildRes();
    await router.request(buildReq('/'), res);
    expect(statusCode()).toBe(302);
    expect(lanSpy).toHaveBeenCalledTimes(1);
    expect(roleSpy).not.toHaveBeenCalled();
  });

  it('does NOT dispatch bare / to the lanRootHandler on the public listener (public root stays the app.recued.com redirect)', async () => {
    const lanSpy = vi.fn();
    const lanRootHandler: PortRequestHandler = (_req, res) => {
      lanSpy();
      res.statusCode = 302;
      res.end();
    };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      lanRootHandler,
      listener: 'public',
    });
    const { res, statusCode, body } = buildRes();
    await router.request(buildReq('/'), res);
    expect(statusCode()).toBe(404);
    expect(parse404(body()).code).toBe('not_found');
    expect(lanSpy).not.toHaveBeenCalled();
  });

  it('lanRootHandler + rootHandler never cross-fire — LAN fires only lanRootHandler', async () => {
    const pubSpy = vi.fn();
    const lanSpy = vi.fn();
    const rootHandler: PortRequestHandler = (_req, res) => { pubSpy(); res.statusCode = 302; res.end(); };
    const lanRootHandler: PortRequestHandler = (_req, res) => { lanSpy(); res.statusCode = 302; res.end(); };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      rootHandler,
      lanRootHandler,
      listener: 'lan',
    });
    const { res } = buildRes();
    await router.request(buildReq('/'), res);
    expect(lanSpy).toHaveBeenCalledTimes(1);
    expect(pubSpy).not.toHaveBeenCalled();
  });

  it('lanRootHandler + rootHandler never cross-fire — public fires only rootHandler', async () => {
    const pubSpy = vi.fn();
    const lanSpy = vi.fn();
    const rootHandler: PortRequestHandler = (_req, res) => { pubSpy(); res.statusCode = 302; res.end(); };
    const lanRootHandler: PortRequestHandler = (_req, res) => { lanSpy(); res.statusCode = 302; res.end(); };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      rootHandler,
      lanRootHandler,
      listener: 'public',
    });
    const { res } = buildRes();
    await router.request(buildReq('/'), res);
    expect(pubSpy).toHaveBeenCalledTimes(1);
    expect(lanSpy).not.toHaveBeenCalled();
  });

  it('does NOT dispatch role bases or sub-paths to the lanRootHandler', async () => {
    const lanSpy = vi.fn();
    const roleSpy = vi.fn();
    const lanRootHandler: PortRequestHandler = (_req, res) => { lanSpy(); res.end(); };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(roleSpy),
      lanRootHandler,
      listener: 'lan',
    });
    for (const path of ['/health', '/ws', '/mcp', '/webhooks/slack/x', '/reception/_health']) {
      const { res } = buildRes();
      await router.request(buildReq(path), res);
    }
    expect(lanSpy).not.toHaveBeenCalled();
    expect(roleSpy).toHaveBeenCalledTimes(5);
  });

  it('strips ?query before matching bare / against the lanRootHandler', async () => {
    const lanSpy = vi.fn();
    const lanRootHandler: PortRequestHandler = (_req, res) => { lanSpy(); res.statusCode = 302; res.end(); };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      lanRootHandler,
      listener: 'lan',
    });
    const { res, statusCode } = buildRes();
    await router.request(buildReq('/?foo=bar#frag'), res);
    expect(statusCode()).toBe(302);
    expect(lanSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to 404 when lanRootHandler is unset on the LAN listener', async () => {
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      listener: 'lan',
    });
    const { res, statusCode, body } = buildRes();
    await router.request(buildReq('/'), res);
    expect(statusCode()).toBe(404);
    expect(parse404(body()).code).toBe('not_found');
  });

  it('upgrade-side bare / continues to reject (LAN root surface is request-only)', async () => {
    const lanRootHandler: PortRequestHandler = (_req, res) => { res.statusCode = 302; res.end(); };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      upgradeHandlers: { ws: buildUpgradeHandler() },
      lanRootHandler,
      listener: 'lan',
    });
    const { socket, written } = buildSocket();
    router.upgrade(buildReq('/'), socket, Buffer.from(''));
    expect(written()).toMatch(/^HTTP\/1\.1 404 Not Found/);
  });

  it('emits an info-level log when dispatching bare / to the lanRootHandler', async () => {
    const log = vi.fn();
    const lanRootHandler: PortRequestHandler = (_req, res) => { res.statusCode = 302; res.end(); };
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildRoleHandlers(),
      lanRootHandler,
      listener: 'lan',
      log,
    });
    const { res } = buildRes();
    await router.request(buildReq('/'), res);
    const infos = log.mock.calls.filter(([level, msg]) => level === 'info' && /lan root handler dispatched/.test(String(msg)));
    expect(infos.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// R26.2 Delta 3 — webclient is a first-class `webclient` path role
// (was the D-152 LAN-only carve-out). It dispatches through the
// regular role + resolution chain: `/webclient` + `/webclient/*` map
// to the `webclient` role, `resolution.webclient[listener]` gates
// serving on EACH listener (LAN + public — no longer LAN-only), and
// `handlers.webclient` (present only when a verified bundle loaded at
// boot) does the static-file dispatch.
// ────────────────────────────────────────────────────────────────

/** Compose a role-handler map with an explicit `webclient` entry —
 *  `buildRoleHandlers` only populates the core rpc roles, so the
 *  bundle handler is added here the way `createServerHandlerSet` puts
 *  it into `handlers.webclient`. */
const buildHandlersWithWebclient = (
  webclient: PortRequestHandler,
  roleSpy?: (role: PathRole, url: string) => void,
): Record<PathRole, PortRequestHandler> => ({
  ...buildRoleHandlers(roleSpy),
  webclient,
});

const webclientStub = (spy?: (url: string) => void): PortRequestHandler => (req, res) => {
  spy?.(req.url ?? '');
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html');
  res.end('webclient');
};

describe('path-router request — R26.2 Delta 3 webclient path role', () => {
  it('dispatches /webclient + /webclient/* to handlers.webclient on the LAN listener', async () => {
    const wcSpy = vi.fn();
    const roleSpy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildHandlersWithWebclient(webclientStub(wcSpy), roleSpy),
      listener: 'lan',
    });
    for (const path of [
      '/webclient',
      '/webclient/',
      '/webclient/index.html',
      '/webclient/assets/main.js',
      '/webclient/icons/icon-192.png',
    ]) {
      const { res, statusCode, body } = buildRes();
      await router.request(buildReq(path), res);
      expect(statusCode()).toBe(200);
      expect(body()).toBe('webclient');
    }
    expect(wcSpy).toHaveBeenCalledTimes(5);
    expect(roleSpy).not.toHaveBeenCalled();
  });

  it('ALSO dispatches on the PUBLIC listener when resolution.webclient.public is on (Delta 3 — no longer LAN-only)', async () => {
    const wcSpy = vi.fn();
    const router = createPathRouter({
      // allOn has webclient { lan:true, public:true }
      resolution: allOn,
      handlers: buildHandlersWithWebclient(webclientStub(() => wcSpy())),
      listener: 'public',
    });
    for (const path of ['/webclient', '/webclient/', '/webclient/index.html']) {
      const { res, statusCode } = buildRes();
      await router.request(buildReq(path), res);
      expect(statusCode()).toBe(200);
    }
    expect(wcSpy).toHaveBeenCalledTimes(3);
  });

  it('404s when resolution.webclient is off on the listener (grid gating — public-off by default)', async () => {
    const wcSpy = vi.fn();
    const router = createPathRouter({
      resolution: { ...allOn, webclient: { lan: true, public: false } },
      handlers: buildHandlersWithWebclient(webclientStub(() => wcSpy())),
      listener: 'public',
    });
    for (const path of ['/webclient', '/webclient/', '/webclient/index.html']) {
      const { res, statusCode, body } = buildRes();
      await router.request(buildReq(path), res);
      expect(statusCode()).toBe(404);
      expect(parse404(body()).code).toBe('not_found');
    }
    expect(wcSpy).not.toHaveBeenCalled();
  });

  it('404s when handlers.webclient is unset (no bundle loaded at boot)', async () => {
    // ⚠ The omission is STATED here, not inherited. This test used to rely on
    // `buildRoleHandlers()` happening to leave `webclient` out — an accident of a
    // hand-spelled role list, invisible because the helper's return was cast to a
    // total Record. Once the helper covered every role this test went red, which
    // is the right outcome: the behaviour under test is a MISSING handler, so the
    // test has to remove one. `handlers` is `Partial<…>`, so this needs no cast.
    const { webclient: _noBundleAtBoot, ...handlersWithoutWebclient } = buildRoleHandlers();
    const router = createPathRouter({
      resolution: allOn,
      handlers: handlersWithoutWebclient,
      listener: 'lan',
    });
    const { res, statusCode, body } = buildRes();
    await router.request(buildReq('/webclient/index.html'), res);
    expect(statusCode()).toBe(404);
    expect(parse404(body()).code).toBe('not_found');
  });

  it('does NOT poach `/webclient-other` (boundary discipline)', async () => {
    const wcSpy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildHandlersWithWebclient(webclientStub(() => wcSpy())),
      listener: 'lan',
    });
    for (const path of ['/webclientevil', '/webclient-other', '/webclient.json']) {
      const { res, statusCode } = buildRes();
      await router.request(buildReq(path), res);
      expect(statusCode()).toBe(404);
    }
    expect(wcSpy).not.toHaveBeenCalled();
  });

  it('strips ?query before matching /webclient', async () => {
    const wcSpy = vi.fn();
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildHandlersWithWebclient(webclientStub((u) => wcSpy(u))),
      listener: 'lan',
    });
    const { res, statusCode } = buildRes();
    await router.request(buildReq('/webclient/index.html?token=evil'), res);
    expect(statusCode()).toBe(200);
    expect(wcSpy).toHaveBeenCalledTimes(1);
  });

  it('upgrade-side /webclient rejects (static-file mount is request-only — no webclient upgrade handler)', async () => {
    const router = createPathRouter({
      resolution: allOn,
      handlers: buildHandlersWithWebclient(webclientStub()),
      upgradeHandlers: { ws: buildUpgradeHandler() },
      listener: 'lan',
    });
    const { socket, written } = buildSocket();
    router.upgrade(buildReq('/webclient'), socket, Buffer.from(''));
    expect(written()).toMatch(/^HTTP\/1\.1 404 Not Found/);
  });
});
