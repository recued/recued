/** D-149 P1 § A.2 — Reception path-mount handler (W3.7 path-mount swap).
 *
 *  Acceptance:
 *    - `/reception/_health` returns 200 (D-149 § A.2 canonical path).
 *    - `/health` returns 404 from the Reception handler — the dedicated
 *      `health` PathRole owns the generic probe (D-148 § A.6); the
 *      path-router dispatches `/health` to that role's handler before
 *      reaching here. The W3.7 path-mount swap retired the legacy
 *      `/health` branch in this handler (it was only ever needed under
 *      the pre-amendment 4th-port framing).
 *    - Every other path returns 404 with no body fingerprint of the
 *      role or any configured kind list (Must Hold I-1 default-off
 *      baseline + spec line 1742 "returns 404 for any path under
 *      `/reception/*`").
 *    - 404 body redacts well-known fingerprintable strings — the
 *      same closed list D-148 P6 § A.6 asserts on the webhook port.
 *    - Health responses are minimal (no `stub: 'reception'` / no
 *      version banner / no role name).
 */

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createReceptionPortHandler,
  RECEPTION_HEALTH_PATH,
} from '../ports/reception/handler.js';

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: string | null = null;
  setHeader(k: string, v: string): void {
    this.headers[k.toLowerCase()] = v;
  }
  end(body?: string): void {
    this.body = body ?? '';
  }
}

const buildReq = (url: string, method = 'POST'): IncomingMessage =>
  ({ url, method, headers: {} } as unknown as IncomingMessage);

describe('D-149 P1 — Reception path-mount handler (W3.7 path-mount swap)', () => {
  it('returns 200 on /reception/_health (spec § A.2 canonical path)', async () => {
    const handler = createReceptionPortHandler();
    const res = new FakeRes();
    await handler(buildReq(RECEPTION_HEALTH_PATH, 'GET'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body ?? 'null');
    expect(parsed).toEqual({ status: 'ok' });
  });

  it('returns 404 on /health (W3.7 path-mount swap — generic probe belongs to the dedicated `health` PathRole)', async () => {
    // Pre-amendment, the Reception listener bound its own port (8446)
    // and answered `/health` itself for the listener-set probe. The
    // W3.7 path-mount swap retired that binding; `/health` is now
    // owned by the `health` PathRole and dispatched by the path-router
    // before reaching this handler. A direct hit on this handler with
    // `/health` is dead code in production but still returns the
    // generic 404 so an out-of-band caller cannot fingerprint that
    // the legacy branch ever existed.
    const handler = createReceptionPortHandler();
    const res = new FakeRes();
    await handler(buildReq('/health', 'GET'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(404);
    const parsed = JSON.parse(res.body ?? 'null');
    expect(parsed).toEqual({ error: { code: 'not_found' } });
  });

  it('health response is minimal — no role name / no stub banner / no version', async () => {
    const handler = createReceptionPortHandler();
    const res = new FakeRes();
    await handler(buildReq(RECEPTION_HEALTH_PATH, 'GET'), res as unknown as ServerResponse);
    const body = res.body ?? '';
    expect(body).not.toContain('reception');
    expect(body).not.toContain('stub');
    expect(body).not.toContain('version');
    expect(body).not.toContain('recued');
  });

  it('non-GET on /reception/_health returns 404 (probes use GET only)', async () => {
    const handler = createReceptionPortHandler();
    const res = new FakeRes();
    await handler(buildReq(RECEPTION_HEALTH_PATH, 'POST'), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for every other path (spec P1 line 1742)', async () => {
    const handler = createReceptionPortHandler();
    const probes = [
      '/',
      '/reception/',
      '/reception/scheduling/abc',
      '/reception/intake/foo',
      '/reception/drop/bar',
      '/reception/approve/baz',
      '/reception/status/qux',
      '/reception/_static/favicon.ico',
      '/api/v1',
      '/inbox',
      '/some/probe',
    ];
    for (const url of probes) {
      const res = new FakeRes();
      await handler(buildReq(url, 'GET'), res as unknown as ServerResponse);
      expect(res.statusCode).toBe(404);
    }
  });

  it('404 body does not fingerprint the server (Must Hold I-1 default-off)', async () => {
    const handler = createReceptionPortHandler();
    const res = new FakeRes();
    await handler(buildReq('/reception/scheduling/abc', 'GET'), res as unknown as ServerResponse);
    const body = res.body ?? '';
    expect(body).not.toContain('reception');
    expect(body).not.toContain('scheduling_link');
    expect(body).not.toContain('intake_form');
    expect(body).not.toContain('drop_link');
    expect(body).not.toContain('approval_link');
    expect(body).not.toContain('status_link');
    expect(body).not.toContain('recued');
    expect(body).not.toContain('version');
    const parsed = JSON.parse(body || 'null');
    expect(parsed).toEqual({ error: { code: 'not_found' } });
  });

  it('query-string presence does not change route resolution', async () => {
    // Token-bearing paths (e.g., /reception/scheduling/<id>?t=<secret>)
    // still resolve to 404 at P1 — the per-kind handlers land at
    // P4-P9. The handler MUST split the pathname from the query string
    // so a bogus token doesn't accidentally promote a path to 200.
    const handler = createReceptionPortHandler();
    const res = new FakeRes();
    await handler(
      buildReq('/reception/scheduling/abc?t=fake-token', 'GET'),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
  });

  it('query-string presence on /reception/_health does not change the 200 response', async () => {
    // W3.7 regression guard — query-string strip must apply uniformly
    // before the canonical-path equality check. `/reception/_health?probe=foo`
    // is the canonical health path with an arbitrary probe parameter;
    // the listener-set's reachability probes are allowed to attach
    // diagnostics + must not get downgraded to 404 by them.
    const handler = createReceptionPortHandler();
    const res = new FakeRes();
    await handler(
      buildReq(`${RECEPTION_HEALTH_PATH}?probe=reachability`, 'GET'),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
  });

  it('content-type is application/json on both 200 and 404', async () => {
    const handler = createReceptionPortHandler();
    const okRes = new FakeRes();
    await handler(buildReq(RECEPTION_HEALTH_PATH, 'GET'), okRes as unknown as ServerResponse);
    expect(okRes.headers['content-type']).toMatch(/application\/json/);
    const notFoundRes = new FakeRes();
    await handler(buildReq('/some/probe', 'GET'), notFoundRes as unknown as ServerResponse);
    expect(notFoundRes.headers['content-type']).toMatch(/application\/json/);
  });
});
