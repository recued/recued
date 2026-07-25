/** D-148 P6 / D-149 P1 / D-148 W3.7 — Reception path-mount handler smoke.
 *
 *  Originally landed at D-148 P6 as the per-port stub returning 404
 *  everywhere except the cross-port `/health` liveness probe; carried
 *  through D-149 P1 with a `/health` 200 carryover for the listener-set
 *  probe; W3.7 path-mount swap retired the legacy `/health` branch (the
 *  generic probe is now owned by the dedicated `health` PathRole + the
 *  path-router dispatches it before reaching this handler). The handler
 *  now serves only `/reception/_health`; every other path returns the
 *  vendor-agnostic 404 floor. */

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createReceptionPortHandler,
  RECEPTION_HEALTH_PATH,
} from '../ports/reception/handler.js';

class FakeRes {
  statusCode = 0;
  body: string | null = null;
  setHeader(_k: string, _v: string): void {}
  end(body?: string): void { this.body = body ?? ''; }
}

const buildReq = (url: string, method = 'POST'): IncomingMessage =>
  ({ url, method, headers: {} } as unknown as IncomingMessage);

describe('createReceptionPortHandler', () => {
  it('returns 404 for any path other than /reception/_health', async () => {
    const handler = createReceptionPortHandler();
    // `/health` joins the 404 set after the W3.7 path-mount swap — the
    // dedicated `health` PathRole owns the generic probe upstream of
    // this handler.
    for (const url of ['/', '/health', '/api/v1', '/inbox', '/abc/def']) {
      const res = new FakeRes();
      await handler(buildReq(url), res as unknown as ServerResponse);
      expect(res.statusCode).toBe(404);
    }
  });

  it('returns 200 ok on /reception/_health (so reachability probes succeed)', async () => {
    const handler = createReceptionPortHandler();
    const res = new FakeRes();
    await handler(buildReq(RECEPTION_HEALTH_PATH, 'GET'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
  });

  it('404 body does not fingerprint the underlying server', async () => {
    const handler = createReceptionPortHandler();
    const res = new FakeRes();
    await handler(buildReq('/some/probe'), res as unknown as ServerResponse);
    const body = res.body ?? '';
    expect(body).not.toContain('reception');
    expect(body).not.toContain('recued');
    expect(body).not.toContain('version');
  });
});
