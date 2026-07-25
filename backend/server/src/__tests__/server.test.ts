import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type RunningServer } from '../server.js';
import { createPairingManager } from '../pairing.js';

/** Post-trim server surface: /health, /auth/pair, 404 for everything else.
 *  Execute and schedules CRUD live on the WebSocket rpc channel — see
 *  ws-server.test.ts. HTTP only handles what cannot be WS. */

const client = (baseUrl: string, realm: string) => ({
  async request(method: string, path: string, body?: unknown): Promise<{
    status: number;
    body: unknown;
  }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${realm}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    return { status: res.status, body: parsed };
  },
});

describe('recued-server HTTP server — slim surface', () => {
  let server: RunningServer;
  let baseUrl: string;

  beforeAll(async () => {
    let t = 1_700_000_000_000;
    server = await startServer(0, {
      now: () => t++,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('/health responds with status ok (no auth required)', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  it('unknown route → vendor-agnostic 404 (path-router fingerprint discipline)', async () => {
    // D-148 W3.5b — the path-routed dispatcher emits the same
    // `{ error: { code: 'not_found' } }` body for unknown paths,
    // paths-disabled-on-this-listener, and unwired-handler-for-role.
    // Spec § A.6 — "Body never echoes role names or any handler-
    // specific hint." The legacy hint about WebSocket / rpc that the
    // old single-handler 404 emitted is retired alongside the per-port
    // model.
    const api = client(baseUrl, 'any-realm');
    const res = await api.request('GET', '/not-a-real-endpoint');
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('execute over HTTP → 404 (WS-only)', async () => {
    const api = client(baseUrl, 'any-realm');
    const res = await api.request('POST', '/execute', { recipe_id: 'foo' });
    expect(res.status).toBe(404);
  });

  it('schedules over HTTP → 404 (WS-only)', async () => {
    const api = client(baseUrl, 'any-realm');
    const res = await api.request('GET', '/schedules');
    expect(res.status).toBe(404);
  });
});

describe('recued-server HTTP server — pairing', () => {
  let server: RunningServer;
  let baseUrl: string;

  beforeAll(async () => {
    const pairing = createPairingManager();
    server = await startServer(0, { pairing });
    baseUrl = `http://127.0.0.1:${server.port}`;
    // Keep a reference to the pairing manager so we can read the code
    (server as unknown as { pairing: typeof pairing }).pairing = pairing;
  });

  afterAll(async () => {
    await server.close();
  });

  it('/auth/pair with invalid code → 401', async () => {
    const res = await fetch(`${baseUrl}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'wrong-code' }),
    });
    expect(res.status).toBe(401);
  });

  it('/auth/pair without code → 400', async () => {
    const res = await fetch(`${baseUrl}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('/auth/pair with valid code → 200 returns token', async () => {
    const pairing = (server as unknown as { pairing: ReturnType<typeof createPairingManager> }).pairing;
    const code = pairing.getCode();
    const res = await fetch(`${baseUrl}/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    expect(body.token).toBeTruthy();
    expect(body.token).toBe(pairing.getRealmToken());
  });

});

// D-116 follow-up — `/status` route mirror.
describe('recued-server HTTP server — /status', () => {
  let server: RunningServer;
  let baseUrl: string;
  const realm = 'realm-test-token';

  beforeAll(async () => {
    server = await startServer(0, {
      statusPageDeps: {
        realmToken: realm,
        serverId: 'inst-test',
        buildSummary: () => [
          {
            recipe_id: 'watch-mail', publisher_id: 'recued-core',
            name: 'Watch Mail', consecutive_failures: 5,
            last_process_id: 'pid-1', last_finished_at: 1714_000_000_000,
            last_failure_reason: 'NETWORK_ERROR',
          },
        ],
        now: () => 1714_000_000_000,
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => { await server.close(); });

  it('rejects unauthenticated GET /status with 401', async () => {
    const res = await fetch(`${baseUrl}/status`);
    expect(res.status).toBe(401);
  });

  it('returns HTML when authorized', async () => {
    const res = await fetch(`${baseUrl}/status`, {
      headers: { Authorization: `Bearer ${realm}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('watch-mail');
    expect(body).toContain('NETWORK_ERROR');
    expect(body).toContain('inst-test');
  });

  it('returns JSON for /status.json when authorized', async () => {
    const res = await fetch(`${baseUrl}/status.json`, {
      headers: { Authorization: `Bearer ${realm}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as {
      generated_at: number;
      server_id?: string;
      auto_disabled: Array<{ recipe_id: string }>;
    };
    expect(body.auto_disabled).toHaveLength(1);
    expect(body.auto_disabled[0].recipe_id).toBe('watch-mail');
    expect(body.server_id).toBe('inst-test');
  });

  it('absent statusPageDeps → /status returns 404', async () => {
    const slim = await startServer(0, {});
    try {
      const res = await fetch(`http://127.0.0.1:${slim.port}/status`);
      expect(res.status).toBe(404);
    } finally {
      await slim.close();
    }
  });
});
