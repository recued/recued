/** D-116 follow-up — `/status` + `/status.json` mirror.
 *  Pure-handler tests using mock IncomingMessage/ServerResponse so
 *  we don't pay http-server boot cost per case. The integration check
 *  in server.test.ts covers the real route registration. */

import { describe, it, expect } from 'vitest';
import {
  renderStatusHtml,
  renderStatusJson,
  handleStatusRequest,
  type StatusPageDeps,
} from '../status-page.js';
import type { AutoDisabledSummary } from '@recued/scheduler';
import type { LaneStatus } from '@recued/contracts';

const mkSummary = (
  o: Partial<AutoDisabledSummary> & Pick<AutoDisabledSummary, 'recipe_id'>,
): AutoDisabledSummary => ({
  publisher_id: 'recued-core',
  name: o.recipe_id,
  consecutive_failures: 5,
  last_process_id: 'pid-' + o.recipe_id,
  last_finished_at: 1714_000_000_000,
  ...o,
});

const mkLane = (o: Partial<LaneStatus> & Pick<LaneStatus, 'lane'>): LaneStatus => ({
  capacity: 2,
  in_use: 0,
  queued: 0,
  oldest_wait_ms: 0,
  ...o,
});

describe('renderStatusHtml', () => {
  it('renders an empty-state message when summary is empty', () => {
    const html = renderStatusHtml([], { generatedAt: 1714_000_000_000 });
    expect(html).toContain('No reactive recipes are currently auto-disabled');
    expect(html).not.toContain('<table>');
  });

  it('renders one row per entry with recipe + reason columns', () => {
    const html = renderStatusHtml(
      [
        mkSummary({ recipe_id: 'watch-mail', name: 'Watch Mail', consecutive_failures: 7 }),
        mkSummary({
          recipe_id: 'watch-cal', name: 'Watch Calendar',
          last_failure_reason: 'NETWORK_ERROR: refused',
        }),
      ],
      { generatedAt: 1714_000_000_000 },
    );
    expect(html).toContain('<table>');
    expect(html).toContain('watch-mail');
    expect(html).toContain('Watch Mail');
    expect(html).toContain('7');
    expect(html).toContain('NETWORK_ERROR: refused');
  });

  it('escapes HTML in recipe-controlled fields', () => {
    const html = renderStatusHtml(
      [mkSummary({
        recipe_id: 'r&id<x>',
        name: '<script>alert(1)</script>',
        last_failure_reason: '"injected" & ugly',
      })],
      { generatedAt: 1714_000_000_000 },
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('threads server id into the meta line when supplied', () => {
    const html = renderStatusHtml(
      [],
      { generatedAt: 1714_000_000_000, serverId: 'inst-abc' },
    );
    expect(html).toContain('inst-abc');
  });

  it('renders missing last_finished_at as em-dash', () => {
    const html = renderStatusHtml(
      [mkSummary({ recipe_id: 'r', last_finished_at: null })],
      { generatedAt: 1714_000_000_000 },
    );
    // Empty timestamp slot exists but renders as em-dash.
    expect(html).toContain('—');
  });
});

describe('renderStatusJson', () => {
  it('shapes the payload with generated_at + auto_disabled', () => {
    const payload = renderStatusJson(
      [mkSummary({ recipe_id: 'a', auto_disabled: true } as Partial<AutoDisabledSummary> & Pick<AutoDisabledSummary, 'recipe_id'>)],
      { generatedAt: 1714_000_000_000 },
    );
    expect(payload.generated_at).toBe(1714_000_000_000);
    expect(payload.auto_disabled).toHaveLength(1);
    expect(payload.auto_disabled[0].recipe_id).toBe('a');
  });

  it('includes server_id only when supplied', () => {
    const without = renderStatusJson([], { generatedAt: 0 });
    expect(without.server_id).toBeUndefined();
    const withId = renderStatusJson([], { generatedAt: 0, serverId: 'inst-1' });
    expect(withId.server_id).toBe('inst-1');
  });
});

// ────────────────────────────────────────────────────────────────
// D-181 §12 — long-op lanes section
// ────────────────────────────────────────────────────────────────

describe('renderStatusHtml — long-op lanes', () => {
  it('omits the lanes section when no lane status is supplied', () => {
    const html = renderStatusHtml([], { generatedAt: 0 });
    expect(html).not.toContain('long-op lanes');
  });

  it('omits the lanes section when the lanes array is empty', () => {
    const html = renderStatusHtml([], { generatedAt: 0, lanes: [] });
    expect(html).not.toContain('long-op lanes');
  });

  it('renders one row per lane with in-use / capacity, queued, oldest wait', () => {
    const html = renderStatusHtml([], {
      generatedAt: 0,
      lanes: [
        mkLane({ lane: 'local-heavy', capacity: 2, in_use: 2, queued: 3, oldest_wait_ms: 720_000 }),
        mkLane({ lane: 'external-io', capacity: 16, in_use: 1, queued: 0, oldest_wait_ms: 0 }),
      ],
    });
    expect(html).toContain('long-op lanes');
    expect(html).toContain('local-heavy');
    expect(html).toContain('2 / 2');
    expect(html).toContain('12m'); // 720_000ms oldest wait
    expect(html).toContain('external-io');
    expect(html).toContain('1 / 16');
    // No queued waiter → em-dash for the oldest-wait cell.
    expect(html).toContain('—');
  });

  it('formats sub-minute, minute, and hour wait times', () => {
    const s = renderStatusHtml([], {
      generatedAt: 0,
      lanes: [mkLane({ lane: 'local-heavy', queued: 1, oldest_wait_ms: 45_000 })],
    });
    expect(s).toContain('45s');
    const h = renderStatusHtml([], {
      generatedAt: 0,
      lanes: [mkLane({ lane: 'local-heavy', queued: 1, oldest_wait_ms: 3 * 3_600_000 })],
    });
    expect(h).toContain('3h');
  });
});

describe('renderStatusJson — long-op lanes', () => {
  it('omits `lanes` when none supplied / empty', () => {
    expect(renderStatusJson([], { generatedAt: 0 }).lanes).toBeUndefined();
    expect(renderStatusJson([], { generatedAt: 0, lanes: [] }).lanes).toBeUndefined();
  });

  it('carries the lanes array when supplied', () => {
    const payload = renderStatusJson([], {
      generatedAt: 0,
      lanes: [mkLane({ lane: 'local-heavy', in_use: 2, queued: 1 })],
    });
    expect(payload.lanes).toHaveLength(1);
    expect(payload.lanes?.[0].lane).toBe('local-heavy');
    expect(payload.lanes?.[0].in_use).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// handleStatusRequest — auth + dispatch
// ────────────────────────────────────────────────────────────────

class MockResponse {
  statusCode = 0;
  body = '';
  headers = new Map<string, string>();
  setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value); }
  end(payload: string) { this.body = payload; }
}

const mkReq = (auth?: string): {
  headers: Record<string, string>;
  url: string;
  method: string;
} => ({
  headers: auth ? { authorization: auth } : {},
  url: '/status',
  method: 'GET',
});

const mkDeps = (over: Partial<StatusPageDeps> = {}): StatusPageDeps => ({
  realmToken: 'realm-secret',
  buildSummary: () => [mkSummary({ recipe_id: 'a' })],
  now: () => 1714_000_000_000,
  ...over,
});

describe('handleStatusRequest — auth', () => {
  it('returns 401 when no Authorization header is supplied', () => {
    const res = new MockResponse();
    handleStatusRequest(mkDeps(), mkReq() as never, res as never, 'json');
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('unauthorized');
  });

  it('returns 401 when Bearer token does not match realm', () => {
    const res = new MockResponse();
    handleStatusRequest(mkDeps(), mkReq('Bearer wrong') as never, res as never, 'json');
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 + JSON payload when token matches', () => {
    const res = new MockResponse();
    handleStatusRequest(mkDeps(), mkReq('Bearer realm-secret') as never, res as never, 'json');
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const parsed = JSON.parse(res.body) as { auto_disabled: Array<{ recipe_id: string }> };
    expect(parsed.auto_disabled[0].recipe_id).toBe('a');
  });

  it('returns 200 + HTML when token matches and format=html', () => {
    const res = new MockResponse();
    handleStatusRequest(mkDeps(), mkReq('Bearer realm-secret') as never, res as never, 'html');
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.body).toContain('<!DOCTYPE html>');
  });

  it('skips auth when realmToken is empty (test composition)', () => {
    const res = new MockResponse();
    handleStatusRequest(mkDeps({ realmToken: '' }), mkReq() as never, res as never, 'json');
    expect(res.statusCode).toBe(200);
  });
});

describe('handleStatusRequest — error path', () => {
  it('returns 500 with status_unavailable when buildSummary throws', () => {
    const res = new MockResponse();
    handleStatusRequest(
      mkDeps({ buildSummary: () => { throw new Error('roster offline'); } }),
      mkReq('Bearer realm-secret') as never, res as never, 'json',
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('status_unavailable');
    expect(res.body).toContain('roster offline');
  });
});

describe('handleStatusRequest — long-op lanes (D-181 §12)', () => {
  it('reads live lane status into the JSON payload', () => {
    const res = new MockResponse();
    handleStatusRequest(
      mkDeps({ laneStatus: () => [mkLane({ lane: 'local-heavy', in_use: 1, queued: 2 })] }),
      mkReq('Bearer realm-secret') as never, res as never, 'json',
    );
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { lanes?: LaneStatus[] };
    expect(parsed.lanes).toHaveLength(1);
    expect(parsed.lanes?.[0].lane).toBe('local-heavy');
  });

  it('renders the lanes section in the HTML page', () => {
    const res = new MockResponse();
    handleStatusRequest(
      mkDeps({ laneStatus: () => [mkLane({ lane: 'external-io', capacity: 16 })] }),
      mkReq('Bearer realm-secret') as never, res as never, 'html',
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('long-op lanes');
    expect(res.body).toContain('external-io');
  });

  it('swallows a laneStatus throw — /status still serves 200, no lanes', () => {
    const res = new MockResponse();
    handleStatusRequest(
      mkDeps({ laneStatus: () => { throw new Error('governor gone'); } }),
      mkReq('Bearer realm-secret') as never, res as never, 'json',
    );
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { lanes?: LaneStatus[]; auto_disabled: unknown[] };
    expect(parsed.lanes).toBeUndefined();
    expect(parsed.auto_disabled).toHaveLength(1);
  });

  it('omits the lanes section when no laneStatus getter is wired', () => {
    const res = new MockResponse();
    handleStatusRequest(
      mkDeps(), mkReq('Bearer realm-secret') as never, res as never, 'json',
    );
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { lanes?: LaneStatus[] }).lanes).toBeUndefined();
  });
});
