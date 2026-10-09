import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MESSENGER_PROBE_TOKEN_PLACEHOLDER,
  RpcError,
  getMessengerVendorDeclaration,
  MESSENGER_AUTH_KIND_CONNECTION_TYPES,
  listMessengerVendors,
} from '@recued/contracts';
import type { ConnectionAuth, ConnectionHealth, ConnectionKind } from '@recued/contracts';
import {
  DEFAULT_RESPONSE_BODY_MAX_BYTES,
  type McpStreamHandle,
  type StdioSpawn,
  type WsConnect,
} from '@recued/ingredients';

import {
  decodeAuthFromStorage,
  encodeAuthForStorage,
  credentialSafeStopAcknowledgementToken,
  handleConnectionAcknowledgeCredentialRotationSafeStop,
  handleConnectionEnroll,
  handleConnectionList,
  handleConnectionProbe,
  handleConnectionCredentialRotationActivity,
  handleConnectionCredentialRotationStatus,
  handleConnectionRotateCredentials,
  handleConnectionUpdate,
} from '../connection-handler.js';
import type { HttpFetcher } from '../connection-vendor-oauth.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';

const NOW = 1_700_000_000_000;
const key = new Uint8Array(32).fill(7);
const getEncryptionKey = (): Uint8Array => key;

let db: Database.Database;
let store: ConnectionStoreSqlite;

beforeEach(() => {
  db = new Database(':memory:');
  store = createConnectionStore(db);
});

afterEach(() => {
  db.close();
});

const jsonResponse = (
  status: number,
  body: unknown = {},
): Awaited<ReturnType<HttpFetcher>> => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const enroll = async (
  kind: ConnectionKind,
  overrides: {
    name?: string;
    subtype?: string;
    config?: Record<string, unknown>;
    auth?: ConnectionAuth;
    publisher_id?: string;
    subresource_path?: string;
  } = {},
): Promise<string> => {
  const name = overrides.name ?? `${kind}-probe`;
  const auth = overrides.auth ?? { type: 'bearer', token: 'secret' };
  const config = overrides.config ?? (
    kind === 'api'
      ? { base_url: 'https://api.example.test/root' }
      : kind === 'mcp'
        ? { endpoint: 'https://mcp.example.test/rpc', transport: 'sse' }
        : {}
  );
  await handleConnectionEnroll(
    {
      store,
      now: () => NOW,
      getEncryptionKey,
    },
    {
      name,
      kind,
      ...(overrides.subtype !== undefined ? { subtype: overrides.subtype } : {}),
      display_name: name,
      ...(overrides.publisher_id !== undefined ? { publisher_id: overrides.publisher_id } : {}),
      config,
      auth,
      ...(overrides.subresource_path !== undefined ? { subresource_path: overrides.subresource_path } : {}),
    },
  );
  return name;
};

const probe = async (
  kind: ConnectionKind,
  name: string,
  fetcher: HttpFetcher,
  streamDeps: { wsConnect?: WsConnect; spawnStdioMcp?: StdioSpawn } = {},
): Promise<ConnectionHealth> => {
  const effectiveFetcher: HttpFetcher = kind === 'mcp'
    ? async (url, init) => {
        const body = typeof init?.body === 'string'
          ? JSON.parse(init.body) as { id?: number; method?: string }
          : undefined;
        if (body?.method === 'server/discover') {
          return jsonResponse(200, {
            jsonrpc: '2.0',
            id: body.id,
            result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
          });
        }
        return fetcher(url, init);
      }
    : fetcher;
  const result = await handleConnectionProbe(
    {
      store,
      now: () => NOW + 1_000,
      getEncryptionKey,
      fetcher: effectiveFetcher,
      ...streamDeps,
    },
    { kind, name },
  );
  return result.health;
};

const storedHealth = (kind: ConnectionKind, name: string): ConnectionHealth =>
  JSON.parse(store.get(kind, name)!.health_json!) as ConnectionHealth;

const makeMcpStream = (
  responseFor: (request: Record<string, unknown>) => Record<string, unknown> =
    (request) => request.method === 'initialize'
      ? { result: { protocolVersion: '2024-11-05' } }
      : { result: { tools: [{ name: 'search' }, { name: 'write-note' }] } },
  options: { legacy?: boolean } = {},
): { handle: McpStreamHandle; sent: Record<string, unknown>[]; close: ReturnType<typeof vi.fn> } => {
  let onMessage: ((data: string) => void) | undefined;
  const sent: Record<string, unknown>[] = [];
  const close = vi.fn();
  const handle: McpStreamHandle = {
    send: (data) => {
      const request = JSON.parse(data) as Record<string, unknown>;
      sent.push(request);
      if (typeof request.id !== 'number') return;
      const reply = request.method === 'server/discover'
        ? (options.legacy
            ? { error: { code: -32601, message: 'Method not found' } }
            : { result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } })
        : responseFor(request);
      onMessage?.(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        ...reply,
      }));
    },
    onMessage: (listener) => { onMessage = listener; },
    onClose: () => {},
    onError: () => {},
    close,
  };
  return { handle, sent, close };
};

describe('handleConnectionProbe real health probes', () => {
  it('bounds the production default fetch response before classifying it healthy', async () => {
    const name = await enroll('api');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: {
          'content-length': String(DEFAULT_RESPONSE_BODY_MAX_BYTES + 1),
        },
      }),
    );
    try {
      const result = await handleConnectionProbe(
        { store, now: () => NOW + 1_000, getEncryptionKey },
        { kind: 'api', name },
      );

      expect(result.health.status).toBe('unreachable');
      expect(result.health.last_error).toContain('response body declared');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
        method: 'HEAD',
        redirect: 'manual',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('classifies an authed api HEAD response as ok and preserves row fields', async () => {
    const name = await enroll('api', {
      publisher_id: 'pub.api',
      subresource_path: '/accounts/123',
    });
    const fetcher = vi.fn<HttpFetcher>(async (url, init) => {
      expect(url).toBe('https://api.example.test/root');
      expect(init?.method).toBe('HEAD');
      expect(init?.headers?.Authorization).toBe('Bearer secret');
      return jsonResponse(204);
    });

    const health = await probe('api', name, fetcher);

    expect(health.status).toBe('ok');
    expect(storedHealth('api', name).status).toBe('ok');
    const row = store.get('api', name)!;
    expect(row.publisher_id).toBe('pub.api');
    expect(row.subresource_path).toBe('/accounts/123');
  });

  it('classifies api 401/403 as auth_failed', async () => {
    const name = await enroll('api');

    const health = await probe('api', name, async () => jsonResponse(401));

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).toBe('http_status_401');
  });

  it('binds an auth rejection to the checked row and returns only closed-list correction fields', async () => {
    const name = await enroll('api', {
      name: 'revision-bound-rejection',
      auth: { type: 'basic', username: 'owner', password: 'private-password' },
    });
    const before = store.get('api', name)!;

    const result = await handleConnectionProbe(
      {
        store,
        now: () => NOW + 1_000,
        getEncryptionKey,
        fetcher: async () => jsonResponse(401),
      },
      {
        kind: 'api',
        name,
        expected_updated_at: before.updated_at,
      },
    );

    expect(result).toMatchObject({
      health: {
        status: 'auth_failed',
        last_probed_at: NOW + 1_000,
      },
      connection_updated_at: NOW + 1_000,
      credential_correction: {
        auth_type: 'basic',
        field_keys: ['auth.username', 'auth.password'],
      },
    });
    expect(store.get('api', name)?.updated_at).toBe(result.connection_updated_at);
    expect(JSON.stringify(result)).not.toContain('owner');
    expect(JSON.stringify(result)).not.toContain('private-password');
  });

  it('preserves a newer row when it changes while the provider check is in flight', async () => {
    const name = await enroll('api', { name: 'probe-race' });
    const before = store.get('api', name)!;
    let releaseProvider!: () => void;
    let markStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const fetcher = vi.fn<HttpFetcher>(async () => {
      markStarted();
      await providerRelease;
      return jsonResponse(204);
    });

    const pending = handleConnectionProbe(
      {
        store,
        now: () => NOW + 2_000,
        getEncryptionKey,
        fetcher,
      },
      {
        kind: 'api',
        name,
        expected_updated_at: before.updated_at,
      },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'conflict',
      details: { existing_credential_preserved: true },
    });
    await providerStarted;
    await handleConnectionUpdate(
      { store, now: () => NOW + 1_500, getEncryptionKey },
      {
        kind: 'api',
        name,
        expected_updated_at: before.updated_at,
        patch: { display_name: 'Newer saved version' },
      },
    );
    const newer = store.get('api', name)!;
    releaseProvider();

    await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(store.get('api', name)).toEqual(newer);
    expect(store.get('api', name)?.display_name).toBe('Newer saved version');
  });

  it('mints an OAuth2 client-credentials token before probing an api connection', async () => {
    const name = await enroll('api', {
      name: 'airbyte',
      config: { base_url: 'https://api.airbyte.com/v1' },
      auth: {
        type: 'oauth2_client_credentials',
        client_id: 'airbyte-client',
        client_secret: 'airbyte-secret',
        token_endpoint: 'https://api.airbyte.com/v1/applications/token',
      },
    });
    const tokenFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(input.toString()).toBe('https://api.airbyte.com/v1/applications/token');
      expect(init?.method).toBe('POST');
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        grant_type: 'client_credentials',
        client_id: 'airbyte-client',
        client_secret: 'airbyte-secret',
      });
      return new Response(JSON.stringify({
        access_token: 'airbyte-access',
        token_type: 'Bearer',
        expires_in: 180,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const apiFetch = vi.fn<HttpFetcher>(async (url, init) => {
      expect(url).toBe('https://api.airbyte.com/v1');
      expect(init?.method).toBe('HEAD');
      expect(init?.headers?.Authorization).toBe('Bearer airbyte-access');
      return jsonResponse(204);
    });

    const result = await handleConnectionProbe(
      {
        store,
        now: () => NOW + 1_000,
        getEncryptionKey,
        fetcher: apiFetch,
        resolveFetch: tokenFetch,
      },
      { kind: 'api', name },
    );

    expect(result.health.status).toBe('ok');
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('probes and persists a validated provider origin returned with a rotated OAuth credential', async () => {
    const name = await enroll('api', {
      name: 'pipedrive-moving-tenant',
      config: {
        vendor: 'pipedrive',
        base_url: 'https://old-company.pipedrive.com',
        cadence: 'daily',
      },
      auth: {
        type: 'oauth2_refresh',
        refresh_token: 'refresh-old',
        client_id: 'pipedrive-client',
        client_secret: 'pipedrive-secret',
        token_endpoint: 'https://oauth.pipedrive.com/oauth/token',
      },
    });
    const tokenFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      token_type: 'Bearer',
      expires_in: 300,
      api_domain: 'https://new-company.pipedrive.com/',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const apiFetch = vi.fn<HttpFetcher>(async (url, init) => {
      expect(url).toBe('https://new-company.pipedrive.com/');
      expect(init?.headers?.Authorization).toBe('Bearer access-new');
      return jsonResponse(204);
    });

    const result = await handleConnectionProbe(
      {
        store,
        now: () => NOW + 1_000,
        getEncryptionKey,
        fetcher: apiFetch,
        resolveFetch: tokenFetch,
      },
      { kind: 'api', name },
    );

    expect(result.health.status).toBe('ok');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get('api', name)!.config_json)).toEqual({
      vendor: 'pipedrive',
      base_url: 'https://new-company.pipedrive.com',
      cadence: 'daily',
    });
    expect(await decodeAuthFromStorage(
      store.get('api', name)!.auth_ciphertext,
      { kind: 'api', name },
      getEncryptionKey,
    )).toMatchObject({
      type: 'oauth2_refresh',
      refresh_token: 'refresh-new',
      current_access_token: 'access-new',
    });
  });

  it('ignores and audits an off-provider refresh origin while preserving the rotated credential', async () => {
    const name = await enroll('api', {
      name: 'pipedrive-hostile-origin',
      config: {
        vendor: 'pipedrive',
        base_url: 'https://known-company.pipedrive.com',
      },
      auth: {
        type: 'oauth2_refresh',
        refresh_token: 'refresh-old',
        client_id: 'pipedrive-client',
        client_secret: 'pipedrive-secret',
        token_endpoint: 'https://oauth.pipedrive.com/oauth/token',
      },
    });
    const logActivity = vi.fn(async () => undefined);
    const apiFetch = vi.fn<HttpFetcher>(async (url, init) => {
      expect(url).toBe('https://known-company.pipedrive.com/');
      expect(init?.headers?.Authorization).toBe('Bearer access-new');
      return jsonResponse(204);
    });

    const result = await handleConnectionProbe(
      {
        store,
        now: () => NOW + 1_000,
        getEncryptionKey,
        fetcher: apiFetch,
        resolveFetch: vi.fn(async () => new Response(JSON.stringify({
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          token_type: 'Bearer',
          expires_in: 300,
          api_domain: 'https://attacker.example',
        }), { status: 200, headers: { 'content-type': 'application/json' } })),
        auditLog: { logActivity, listInboundContractIds: async () => [] },
      },
      { kind: 'api', name },
    );

    expect(result.health.status).toBe('ok');
    expect(JSON.parse(store.get('api', name)!.config_json).base_url)
      .toBe('https://known-company.pipedrive.com');
    expect(await decodeAuthFromStorage(
      store.get('api', name)!.auth_ciphertext,
      { kind: 'api', name },
      getEncryptionKey,
    )).toMatchObject({
      refresh_token: 'refresh-new',
      current_access_token: 'access-new',
    });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({
      timestamp: NOW + 1_000,
      action: 'connection_runtime_base_refresh_ignored',
      target: name,
      detail: JSON.stringify({
        kind: 'api',
        vendor: 'pipedrive',
        status: 'invalid',
        field: 'api_domain',
        reason: 'host is outside the provider allowlist',
      }),
    }));
    expect(JSON.stringify(logActivity.mock.calls)).not.toContain('attacker.example');
    expect(JSON.stringify(logActivity.mock.calls)).not.toContain('access-new');
    expect(JSON.stringify(logActivity.mock.calls)).not.toContain('refresh-new');
  });

  it('maps an OAuth2 client-credentials exchange failure to auth_failed without probing', async () => {
    const name = await enroll('api', {
      name: 'airbyte',
      config: { base_url: 'https://api.airbyte.com/v1' },
      auth: {
        type: 'oauth2_client_credentials',
        client_id: 'airbyte-client',
        client_secret: 'airbyte-secret',
        token_endpoint: 'https://api.airbyte.com/v1/applications/token',
      },
    });
    const apiFetch = vi.fn<HttpFetcher>();

    const result = await handleConnectionProbe(
      {
        store,
        now: () => NOW + 1_000,
        getEncryptionKey,
        fetcher: apiFetch,
        resolveFetch: vi.fn<typeof fetch>(async () => new Response(
          JSON.stringify({ error: 'invalid_client' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        )),
      },
      { kind: 'api', name },
    );

    expect(result.health).toMatchObject({
      status: 'auth_failed',
      last_error: 'token_exchange_failed',
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('falls back from api HEAD to GET and treats other HTTP statuses as reachable', async () => {
    const name = await enroll('api');
    const fetcher = vi.fn<HttpFetcher>(async (_url, init) => (
      init?.method === 'HEAD' ? jsonResponse(405) : jsonResponse(500)
    ));

    const health = await probe('api', name, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(health.status).toBe('ok');
    expect(health.last_error).toBe('http_status_500');
  });

  it('maps api fetch throws to unreachable without throwing the rpc', async () => {
    const name = await enroll('api');

    const health = await probe('api', name, async () => {
      throw new Error('dns failed');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('dns failed');
  });

  it('discovers modern MCP then lists and caches tool names', async () => {
    const name = await enroll('mcp', { subtype: 'sse' });
    const fetcher = vi.fn<HttpFetcher>(async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { method?: string };
      if (body.method === 'initialize') {
        return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } });
      }
      // Case 1 — the same probe now also asks what this server PUSHES. A
      // server that refuses those two is ordinary, not unhealthy, which is what
      // the `push.reason` assertion below pins.
      if (body.method === 'resources/list' || body.method === 'subscriptions/listen') {
        return jsonResponse(404, {
          jsonrpc: '2.0',
          id: 9,
          error: { code: -32601, message: `Method not found: ${String(body.method)}` },
        });
      }
      expect(body.method).toBe('tools/list');
      return jsonResponse(200, {
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'search' }, { name: 'write-note' }] },
      });
    });

    const health = await probe('mcp', name, fetcher);

    expect(health.status).toBe('ok');
    expect(health.tools).toEqual(['search', 'write-note']);
    expect(health.mcp_tool_schemas).toEqual({ search: {}, 'write-note': {} });
    expect(storedHealth('mcp', name).tools).toEqual(['search', 'write-note']);
    expect(storedHealth('mcp', name).mcp_tool_schemas)
      .toEqual({ search: {}, 'write-note': {} });
    // ⛔ A server that does not push stays `ok`. The capability is recorded as
    // an answer — absent `acknowledged`, a reason — never as a health failure.
    expect(health.status).toBe('ok');
    expect(health.push).toMatchObject({ reason: 'listen_method_unsupported' });
    expect(health.push?.acknowledged).toBeUndefined();
    expect(storedHealth('mcp', name).push?.reason).toBe('listen_method_unsupported');
    // tools/list + resources/list + subscriptions/listen — the push question
    // costs two requests on every modern probe, the same posture as `tools`.
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('falls back from HTTP discovery to the validated legacy lifecycle', async () => {
    const name = await enroll('mcp', { subtype: 'sse' });
    const methods: string[] = [];
    const fetcher = vi.fn<HttpFetcher>(async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { id?: number; method?: string };
      methods.push(body.method ?? '');
      if (body.method === 'server/discover') {
        return jsonResponse(200, {
          jsonrpc: '2.0', id: body.id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
      if (body.method === 'initialize') {
        return jsonResponse(200, {
          jsonrpc: '2.0', id: body.id,
          result: { protocolVersion: '2024-11-05', capabilities: {} },
        });
      }
      if (body.method === 'notifications/initialized') {
        return jsonResponse(202, {});
      }
      return jsonResponse(200, {
        jsonrpc: '2.0', id: body.id,
        result: { tools: [{ name: 'legacy-tool' }] },
      });
    });

    const result = await handleConnectionProbe(
      { store, now: () => NOW + 1_000, getEncryptionKey, fetcher },
      { kind: 'mcp', name },
    );

    expect(result.health).toMatchObject({ status: 'ok', tools: ['legacy-tool'] });
    expect(methods).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      'MCP-Protocol-Version': '2026-07-28',
    });
    expect(fetcher.mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty(
      'MCP-Protocol-Version',
    );
  });

  it('reaches a handshake-era Streamable HTTP server with NO injected fetcher', async () => {
    // ⛔ The handshake-era fallback used to be gated on `deps.fetcher !== undefined`
    // — a fixture seam production never supplies. Every test therefore proved a
    // path no user could take, while the real composition fell straight through
    // to the 2024-11-05 two-endpoint transport and 405'd on its opening GET.
    // This test deliberately injects NO fetcher, so it runs what ships.
    const name = await enroll('mcp', { subtype: 'sse' });
    const methods: string[] = [];
    const realFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
      methods.push(body.method ?? '');
      if (body.method === 'server/discover') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          error: { code: -32601, message: 'Method not found' },
        }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          result: { protocolVersion: '2025-11-25', capabilities: {} },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: body.id,
        result: { tools: [{ name: 'handshake-era-tool' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', realFetch);
    try {
      const result = await handleConnectionProbe(
        { store, now: () => NOW + 1_000, getEncryptionKey },
        { kind: 'mcp', name },
      );
      expect(result.health).toMatchObject({
        status: 'ok',
        tools: ['handshake-era-tool'],
      });
      expect(methods).toEqual([
        'server/discover',
        'initialize',
        'notifications/initialized',
        'tools/list',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not downgrade a recognized modern HTTP protocol error', async () => {
    const name = await enroll('mcp', { subtype: 'sse' });
    const methods: string[] = [];
    const fetcher = vi.fn<HttpFetcher>(async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { id?: number; method?: string };
      methods.push(body.method ?? '');
      return jsonResponse(400, {
        jsonrpc: '2.0', id: body.id,
        error: {
          code: -32022,
          message: 'Unsupported protocol version',
          data: { supported: ['2099-01-01'], requested: '2026-07-28' },
        },
      });
    });

    const result = await handleConnectionProbe(
      { store, now: () => NOW + 1_000, getEncryptionKey, fetcher },
      { kind: 'mcp', name },
    );

    expect(result.health).toMatchObject({
      status: 'unreachable',
      last_error: 'jsonrpc_discover_modern_error_-32022',
    });
    expect(methods).toEqual(['server/discover']);
  });

  it('D-225 — PERSISTS descriptor hashes beside the names, and they track the SCHEMA', async () => {
    // ⛔ Without this the drift substrate has nothing to compare against, and a
    // tool MUTATED IN PLACE — same name, new argument schema — is invisible:
    // the names are identical, so a name-based check reports no change while
    // the installed pack keeps dispatching under a grant issued for a shape the
    // server no longer has.
    const schemaOf = (required: string[]) => ({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [{ name: 'search', inputSchema: { type: 'object', required } }],
      },
    });
    const probeWithSchema = async (required: string[]) => {
      const nm = await enroll('mcp', { subtype: 'sse' });
      const f = vi.fn<HttpFetcher>(async (_url, init) => {
        const body = JSON.parse(init?.body ?? '{}') as { method?: string };
        if (body.method === 'initialize') {
          return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } });
        }
        return jsonResponse(200, schemaOf(required));
      });
      return { health: await probe('mcp', nm, f), nm };
    };

    const first = await probeWithSchema(['q']);
    expect(first.health.tool_hashes).toHaveLength(1);
    expect(first.health.tool_hashes![0]).toMatch(/^[a-f0-9]{64}$/);
    // Persisted, not just returned.
    expect(storedHealth('mcp', first.nm).tool_hashes).toEqual(first.health.tool_hashes);

    const second = await probeWithSchema(['q', 'limit']);
    // The NAME is unchanged — which is exactly what makes this case invisible
    // to a name check — but the hash moved.
    expect(second.health.tools).toEqual(first.health.tools);
    expect(second.health.tool_hashes).not.toEqual(first.health.tool_hashes);
  });

  it('drains every paginated SSE tools/list page, including an empty-string cursor', async () => {
    const name = await enroll('mcp', { subtype: 'sse' });
    const fetcher = vi.fn<HttpFetcher>(async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as {
        id?: number;
        method?: string;
        params?: { cursor?: string };
      };
      if (body.method === 'initialize') {
        return jsonResponse(200, { jsonrpc: '2.0', id: body.id, result: {} });
      }
      if (body.params?.cursor === undefined) {
        return jsonResponse(200, {
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'first-page' }], nextCursor: '' },
        });
      }
      expect(body.params.cursor).toBe('');
      return jsonResponse(200, {
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [{ name: 'second-page' }] },
      });
    });

    const health = await probe('mcp', name, fetcher);

    expect(health).toMatchObject({
      status: 'ok',
      tools: ['first-page', 'second-page'],
    });
    // +2: the modern probe also asks resources/list + subscriptions/listen.
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('probes MCP websocket through the live connector and caches tool names', async () => {
    const name = await enroll('mcp', {
      subtype: 'websocket',
      config: { endpoint: 'wss://mcp.example.test/socket', transport: 'websocket' },
    });
    const stream = makeMcpStream();
    const wsConnect = vi.fn<WsConnect>(async () => stream.handle);
    const fetcher = vi.fn<HttpFetcher>();

    const health = await probe('mcp', name, fetcher, { wsConnect });

    expect(health).toMatchObject({ status: 'ok', tools: ['search', 'write-note'] });
    expect(storedHealth('mcp', name).tools).toEqual(['search', 'write-note']);
    expect(fetcher).not.toHaveBeenCalled();
    expect(wsConnect).toHaveBeenCalledTimes(1);
    const [url, opts] = wsConnect.mock.calls[0]!;
    expect(url).toBe('wss://mcp.example.test/socket');
    expect(opts.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(stream.sent.map((message) => message.method)).toEqual([
      'server/discover',
      'tools/list',
    ]);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('uses the row subtype when legacy config.transport disagrees with live execution', async () => {
    const name = await enroll('mcp', {
      subtype: 'websocket',
      config: { endpoint: 'wss://mcp.example.test/socket', transport: 'sse' },
    });
    const stream = makeMcpStream();
    const wsConnect = vi.fn<WsConnect>(async () => stream.handle);
    const fetcher = vi.fn<HttpFetcher>();

    const health = await probe('mcp', name, fetcher, { wsConnect });

    expect(health.status).toBe('ok');
    expect(wsConnect).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falls back to config.transport for a legacy row with an invalid subtype', async () => {
    const name = await enroll('mcp', {
      subtype: 'sse',
      config: { endpoint: 'https://mcp.example.test/rpc', transport: 'sse' },
    });
    const row = store.get('mcp', name)!;
    store.upsert({ ...row, subtype: 'legacy-invalid' });
    const fetcher = vi.fn<HttpFetcher>(async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { id?: number; method?: string };
      return body.method === 'initialize'
        ? jsonResponse(200, { jsonrpc: '2.0', id: body.id, result: {} })
        : jsonResponse(200, {
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'legacy-tool' }] },
          });
    });
    const wsConnect = vi.fn<WsConnect>();

    const health = await probe('mcp', name, fetcher, { wsConnect });

    expect(health).toMatchObject({ status: 'ok', tools: ['legacy-tool'] });
    // +2: the modern probe also asks resources/list + subscriptions/listen.
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(wsConnect).not.toHaveBeenCalled();
  });

  it('drains every paginated websocket tools/list page before caching', async () => {
    const name = await enroll('mcp', {
      subtype: 'websocket',
      config: { endpoint: 'wss://mcp.example.test/socket', transport: 'websocket' },
    });
    const stream = makeMcpStream((request) => {
      if (request.method === 'initialize') return { result: {} };
      const cursor = (request.params as { cursor?: unknown } | undefined)?.cursor;
      return cursor === undefined
        ? { result: { tools: [{ name: 'page-one' }], nextCursor: 'next' } }
        : { result: { tools: [{ name: 'page-two' }] } };
    });
    const wsConnect = vi.fn<WsConnect>(async () => stream.handle);

    const health = await probe('mcp', name, vi.fn<HttpFetcher>(), { wsConnect });

    expect(health).toMatchObject({ status: 'ok', tools: ['page-one', 'page-two'] });
    expect(stream.sent.filter((message) => message.method === 'tools/list')).toMatchObject([
      { params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
      { params: { cursor: 'next', _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
    ]);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('fails a malformed tools/list page instead of caching an incomplete allow-list', async () => {
    const name = await enroll('mcp', {
      subtype: 'websocket',
      config: { endpoint: 'wss://mcp.example.test/socket', transport: 'websocket' },
    });
    const stream = makeMcpStream((request) => request.method === 'initialize'
      ? { result: {} }
      : { result: { nextCursor: 'more-but-tools-is-missing' } });
    const wsConnect = vi.fn<WsConnect>(async () => stream.handle);

    const health = await probe('mcp', name, vi.fn<HttpFetcher>(), { wsConnect });

    expect(health).toMatchObject({
      status: 'unreachable',
      last_error: 'jsonrpc_tools_list_invalid_response',
    });
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('fails cyclic websocket pagination without looping or caching a partial allow-list', async () => {
    const name = await enroll('mcp', {
      subtype: 'websocket',
      config: { endpoint: 'wss://mcp.example.test/socket', transport: 'websocket' },
    });
    const stream = makeMcpStream((request) => request.method === 'initialize'
      ? { result: {} }
      : { result: { tools: [{ name: 'partial' }], nextCursor: 'repeat' } });
    const wsConnect = vi.fn<WsConnect>(async () => stream.handle);

    const health = await probe('mcp', name, vi.fn<HttpFetcher>(), { wsConnect });

    expect(health).toMatchObject({
      status: 'unreachable',
      last_error: 'jsonrpc_tools_list_pagination_cycle',
    });
    expect(health.tools).toBeUndefined();
    expect(stream.sent.filter((message) => message.method === 'tools/list')).toHaveLength(2);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('probes MCP stdio through the hardened spawner and closes the child', async () => {
    const name = await enroll('mcp', {
      subtype: 'stdio',
      config: {
        transport: 'stdio',
        command: '/usr/local/bin/example-mcp',
        args: ['--mode', 'probe'],
        env: { MCP_PROFILE: 'test' },
      },
      auth: { type: 'none' },
    });
    const stream = makeMcpStream();
    const spawnStdioMcp = vi.fn<StdioSpawn>(async () => stream.handle);
    const fetcher = vi.fn<HttpFetcher>();

    const health = await probe('mcp', name, fetcher, { spawnStdioMcp });

    expect(health).toMatchObject({ status: 'ok', tools: ['search', 'write-note'] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(spawnStdioMcp).toHaveBeenCalledTimes(1);
    const [spec, opts] = spawnStdioMcp.mock.calls[0]!;
    expect(spec).toEqual({
      command: '/usr/local/bin/example-mcp',
      args: ['--mode', 'probe'],
      env: { MCP_PROFILE: 'test' },
    });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(stream.sent.map((message) => message.method)).toEqual([
      'server/discover',
      'tools/list',
    ]);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('maps a websocket JSON-RPC initialize error to auth_failed and closes', async () => {
    const name = await enroll('mcp', {
      subtype: 'websocket',
      config: { endpoint: 'wss://mcp.example.test/socket', transport: 'websocket' },
    });
    const stream = makeMcpStream(() => ({
      error: { code: -32_001, message: 'unauthorized' },
    }), { legacy: true });
    const wsConnect = vi.fn<WsConnect>(async () => stream.handle);

    const health = await probe('mcp', name, vi.fn<HttpFetcher>(), { wsConnect });

    expect(health).toMatchObject({
      status: 'auth_failed',
      last_error: 'jsonrpc_initialize_error',
    });
    expect(stream.close).toHaveBeenCalledTimes(2);
  });

  it('never persists a query credential echoed by a websocket connect error', async () => {
    const secret = 'top secret/123';
    const name = await enroll('mcp', {
      subtype: 'websocket',
      config: { endpoint: 'wss://mcp.example.test/socket', transport: 'websocket' },
      auth: { type: 'query', param_name: 'access_token', value: secret },
    });
    const wsConnect = vi.fn<WsConnect>(async (url) => {
      throw new Error(`connect failed for ${url}`);
    });

    const health = await probe('mcp', name, vi.fn<HttpFetcher>(), { wsConnect });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toContain('***');
    expect(health.last_error).not.toContain(secret);
    expect(health.last_error).not.toContain('top+secret%2F123');
    expect(storedHealth('mcp', name).last_error).toBe(health.last_error);
  });

  it('⛔ D-218 — an API probe redacts a BEARER token too (pre-existing leak)', async () => {
    // ⚠ **Not a new-type problem.** `probeApi`'s catch never called the
    // redactor — it lived inside `probeMcp` — so every api auth type has been
    // returning raw transport errors into persisted `health_json`. Found while
    // wiring a type whose stored credential is an app password; fixed for all
    // of them. This pins the general case so the hoist cannot be undone.
    const token = 'bearer-token-abc123';
    const name = await enroll('api', {
      name: 'bearer-leak-probe',
      auth: { type: 'bearer', token },
    });
    const fetcher = vi.fn<HttpFetcher>(async () => {
      throw new Error(`connect failed sending Authorization: Bearer ${token}`);
    });

    const health = await probe('api', name, fetcher);

    expect(health.status).toBe('unreachable');
    expect(health.last_error).not.toContain(token);
    expect(health.last_error).toContain('***');
  });

  it('⛔ D-218 — never echoes an atproto APP PASSWORD in a probe error', async () => {
    // ⛔ **This is the site the widened union walked straight past.** The
    // redaction switch has no `default`, so a new auth type collects NOTHING
    // and its credentials reach `last_error` verbatim — and for this type the
    // stored credential is an APP PASSWORD, a reusable account credential that
    // outlives every token derived from it. The compiler reported nothing.
    const appPassword = 'abcd-efgh-ijkl-mnop';
    const accessJwt = 'access-jwt-value';
    const refreshJwt = 'refresh-jwt-value';
    const name = await enroll('api', {
      name: 'bsky-probe',
      config: { base_url: 'https://bsky.social' },
      auth: {
        type: 'atproto_session',
        identifier: 'alice.bsky.social',
        app_password: appPassword,
        current_access_token: accessJwt,
        refresh_token: refreshJwt,
      } as ConnectionAuth,
    });
    const fetcher = vi.fn<HttpFetcher>(async () => {
      // A target that echoes every credential it was handed — the worst case a
      // redactor exists for, and not far-fetched for a service that logs the
      // request it rejected.
      throw new Error(
        `probe failed: ${appPassword} / ${accessJwt} / ${refreshJwt}`,
      );
    });

    const health = await probe('api', name, fetcher);

    // ⚠ All THREE, not just the access token: the refresh JWT is a live
    // credential of its own, and the app password survives revoking the rest.
    expect(health.last_error).not.toContain(appPassword);
    expect(health.last_error).not.toContain(accessJwt);
    expect(health.last_error).not.toContain(refreshJwt);
    expect(health.last_error).toContain('***');
    expect(storedHealth('api', name).last_error).toBe(health.last_error);
  });

  it('⛔⛔ never echoes a SIGNING SECRET in a probe error', async () => {
    // The same site, one member later, and the compiler was silent again. Every
    // other place `request_signature` broke was caught by a missing return or a
    // `Record` key; the redaction switch was caught by nothing, exactly as
    // D-218 recorded. It now carries a `never` guard so the tenth member is a
    // compile error here rather than a leak.
    //
    // ⚠ The secret is the worst thing in this file to leak: it is never sent on
    // the wire in any scheme — it only keys a MAC — so the ONLY way it can
    // escape is by being echoed, which is precisely what this redactor is for.
    // ⚠ Deliberately short and self-describing. This test proves the REDACTOR
    // scrubs an echoed credential; the value is arbitrary, so it has no reason
    // to be credential-shaped. It previously held Binance's 64-char published
    // example, which the secret scanner could not see here (the pattern wants
    // `secret:` or `api_key:`, and these are camelCase) — so the one file whose
    // comment calls the secret "the worst thing in this file to leak" was the
    // one carrying a live-looking pair past the gate.
    const secretKey = 'fixture-secret-xyz';
    const apiKey = 'fixture-api-key-xyz';
    const name = await enroll('api', {
      name: 'binance-signed-probe',
      config: { base_url: 'https://api.binance.com' },
      auth: {
        type: 'request_signature',
        scheme: 'binance_hmac_sha256',
        api_key: apiKey,
        secret_key: secretKey,
      } as ConnectionAuth,
    });
    const fetcher = vi.fn<HttpFetcher>(async () => {
      throw new Error(`probe failed for key ${apiKey} secret ${secretKey}`);
    });

    const health = await probe('api', name, fetcher);

    expect(health.last_error).not.toContain(secretKey);
    expect(health.last_error).not.toContain(apiKey);
    expect(health.last_error).toContain('***');
    expect(storedHealth('api', name).last_error).toBe(health.last_error);
  });

  it('⛔ a signed probe SENDS a signature — it does not call the endpoint bare', async () => {
    // The other uncaught site: the handler's own `applyAuth` also had no
    // `default`, so a member falling through applies NO credential and the
    // probe reports whatever an ANONYMOUS request earns. Against a public
    // endpoint that is a green health check on a credential nobody verified.
    const name = await enroll('api', {
      name: 'binance-signed-applied',
      config: { base_url: 'https://api.binance.com/api/v3/account' },
      auth: {
        type: 'request_signature',
        scheme: 'binance_hmac_sha256',
        api_key: 'pub-key',
        secret_key: 'sec-key',
      } as ConnectionAuth,
    });
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = vi.fn<HttpFetcher>(async (url, init) => {
      seen.push({
        url: String(url),
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      });
      return new Response('{}', { status: 200 });
    });

    await probe('api', name, fetcher);

    expect(seen.length).toBeGreaterThan(0);
    const first = seen[0]!;
    expect(first.headers['X-MBX-APIKEY']).toBe('pub-key');
    const sent = new URL(first.url);
    expect(sent.searchParams.get('signature')).toMatch(/^[0-9a-f]{64}$/u);
    expect(sent.searchParams.get('timestamp')).toMatch(/^\d+$/u);
    // ⛔ and the secret is not in the request it produced
    expect(first.url).not.toContain('sec-key');
  });

  it('⛔⛔ a body_field probe reports UNKNOWN and never calls the vendor', async () => {
    // ⛔ **The failure this refuses is a GREEN health check on a credential
    // nobody checked.** The probe is a GET/HEAD and has no body, so there is
    // nowhere to put a body-borne credential. Applying nothing and calling
    // anyway is the tempting path and it is the wrong one: on a vendor whose
    // base URL answers 200 to anyone, an unauthenticated request comes back
    // `ok` and the owner is told a credential works that was never presented.
    //
    // ⚠ Asserting the fetcher was NOT called is the load-bearing half. A test
    // that only checked `status === 'unknown'` would also pass if the probe
    // called the endpoint and merely failed to classify the answer.
    const name = await enroll('api', {
      name: 'plaid-body-probe',
      config: { base_url: 'https://sandbox.plaid.com' },
      auth: {
        type: 'body_field',
        fields: [{ field_name: 'access_token', value: 'access-sandbox-fixture' }],
      } as ConnectionAuth,
    });
    const fetcher = vi.fn<HttpFetcher>(async () => new Response('{}', { status: 200 }));

    const health = await probe('api', name, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(health.status).toBe('unknown');
    expect(health.last_error).toBe('body_field_auth_not_probeable');
    expect(storedHealth('api', name).status).toBe('unknown');
  });

  it('⛔ body_field is refused on a kind whose adapter cannot send it', async () => {
    // Nothing outside the api adapter writes a JSON request body, so an mcp row
    // carrying one would hold a credential that is never sent — a connection
    // that looks configured and authenticates as nobody. `VALID_AUTH_TYPES` is
    // derived from `CONNECTION_AUTH_TYPES`, so a new member becomes enrollable
    // on every kind the moment it is added; this is the gate that stops it.
    await expect(enroll('mcp', {
      name: 'mcp-body-field',
      subtype: 'sse',
      auth: {
        type: 'body_field',
        fields: [{ field_name: 'access_token', value: 'v' }],
      } as ConnectionAuth,
    })).rejects.toMatchObject({ message: expect.stringContaining('only valid on an api connection') });
  });

  it('⛔ a malformed body_field record is refused at enroll, not at first use', async () => {
    await expect(enroll('api', {
      name: 'plaid-bad-field',
      auth: {
        type: 'body_field',
        fields: [{ field_name: '__proto__', value: 'v' }],
      } as unknown as ConnectionAuth,
    })).rejects.toMatchObject({ message: expect.stringContaining('auth.fields') });
  });

  it('D-218 creates and persists an AT Protocol session before the first probe', async () => {
    const name = await enroll('api', {
      name: 'bsky-create-probe',
      config: { base_url: 'https://bsky.social' },
      auth: {
        type: 'atproto_session',
        identifier: 'alice.bsky.social',
        app_password: 'app-pass',
      },
    });
    const resolveFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        'https://bsky.social/xrpc/com.atproto.server.createSession',
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        identifier: 'alice.bsky.social', password: 'app-pass',
      });
      return new Response(JSON.stringify({ accessJwt: 'access-1', refreshJwt: 'refresh-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const fetcher = vi.fn<HttpFetcher>(async (url, init) => {
      expect(url).toBe(
        'https://bsky.social/xrpc/com.atproto.server.getSession',
      );
      expect(init?.method).toBe('GET');
      expect(init?.headers?.Authorization).toBe('Bearer access-1');
      return jsonResponse(204);
    });

    const { health } = await handleConnectionProbe({
      store,
      now: () => NOW + 1_000,
      getEncryptionKey,
      fetcher,
      resolveFetch,
    }, { kind: 'api', name });

    expect(health.status).toBe('ok');
    expect(resolveFetch).toHaveBeenCalledTimes(1);
    const saved = store.get('api', name)!;
    expect(await decodeAuthFromStorage(
      saved.auth_ciphertext, { kind: 'api', name }, getEncryptionKey,
    )).toMatchObject({ current_access_token: 'access-1', refresh_token: 'refresh-1' });
  });

  it('D-218 refreshes and persists an opaque AT Protocol session after probe 401', async () => {
    const name = await enroll('api', {
      name: 'bsky-refresh-probe',
      config: { base_url: 'https://bsky.social' },
      auth: {
        type: 'atproto_session',
        identifier: 'alice.bsky.social',
        app_password: 'app-pass',
        current_access_token: 'stale-access',
        refresh_token: 'refresh-old',
      },
    });
    const resolveFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        'https://bsky.social/xrpc/com.atproto.server.refreshSession',
      );
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer refresh-old');
      return new Response(JSON.stringify({ accessJwt: 'access-2', refreshJwt: 'refresh-2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    let probes = 0;
    const fetcher = vi.fn<HttpFetcher>(async (url, init) => {
      probes += 1;
      expect(url).toBe(
        'https://bsky.social/xrpc/com.atproto.server.getSession',
      );
      expect(init?.method).toBe('GET');
      expect(init?.headers?.Authorization).toBe(
        probes === 1 ? 'Bearer stale-access' : 'Bearer access-2',
      );
      return jsonResponse(probes === 1 ? 401 : 204);
    });

    const { health } = await handleConnectionProbe({
      store,
      now: () => NOW + 1_000,
      getEncryptionKey,
      fetcher,
      resolveFetch,
    }, { kind: 'api', name });

    expect(health.status).toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(resolveFetch).toHaveBeenCalledTimes(1);
    const saved = store.get('api', name)!;
    expect(await decodeAuthFromStorage(
      saved.auth_ciphertext, { kind: 'api', name }, getEncryptionKey,
    )).toMatchObject({ current_access_token: 'access-2', refresh_token: 'refresh-2' });
  });

  it('D-218 does not rotate an AT Protocol session after an authenticated 403', async () => {
    const name = await enroll('api', {
      name: 'bsky-forbidden-probe',
      config: { base_url: 'https://bsky.social' },
      auth: {
        type: 'atproto_session',
        identifier: 'alice.bsky.social',
        app_password: 'app-pass',
        current_access_token: 'access-current',
        refresh_token: 'refresh-current',
      },
    });
    const resolveFetch = vi.fn<typeof fetch>();
    const fetcher = vi.fn<HttpFetcher>(async (url, init) => {
      expect(url).toBe(
        'https://bsky.social/xrpc/com.atproto.server.getSession',
      );
      expect(init?.headers?.Authorization).toBe('Bearer access-current');
      return jsonResponse(403);
    });

    const { health } = await handleConnectionProbe({
      store,
      now: () => NOW + 1_000,
      getEncryptionKey,
      fetcher,
      resolveFetch,
    }, { kind: 'api', name });

    expect(health).toMatchObject({ status: 'auth_failed', last_error: 'http_status_403' });
    expect(resolveFetch).not.toHaveBeenCalled();
    const saved = store.get('api', name)!;
    expect(await decodeAuthFromStorage(
      saved.auth_ciphertext, { kind: 'api', name }, getEncryptionKey,
    )).toMatchObject({
      current_access_token: 'access-current', refresh_token: 'refresh-current',
    });
  });

  it('reports an unavailable stream capability honestly instead of not_implemented', async () => {
    const name = await enroll('mcp', {
      subtype: 'websocket',
      config: { endpoint: 'wss://mcp.example.test/socket', transport: 'websocket' },
    });

    const health = await probe('mcp', name, vi.fn<HttpFetcher>());

    expect(health).toMatchObject({
      status: 'unknown',
      last_error: 'transport_websocket_probe_unavailable',
    });
  });

  it('maps mcp JSON-RPC error envelopes to auth_failed', async () => {
    const name = await enroll('mcp', { subtype: 'sse' });

    const health = await probe('mcp', name, async () => jsonResponse(200, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32001, message: 'unauthorized' },
    }));

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).toBe('jsonrpc_tools_list_error');
  });

  it('maps mcp transport failures to unreachable', async () => {
    const name = await enroll('mcp', { subtype: 'sse' });

    const health = await probe('mcp', name, async () => {
      throw new Error('connection refused');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('connection refused');
  });

  it('classifies notification in-app locally as ok', async () => {
    const name = await enroll('notification', {
      subtype: 'in-app',
      auth: { type: 'none' },
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('ok');
  });

  it('classifies notification slack auth.test failures as auth_failed', async () => {
    const name = await enroll('notification', { subtype: 'slack' });

    const health = await probe('notification', name, async (url, init) => {
      expect(url).toBe('https://slack.com/api/auth.test');
      expect(init?.headers?.Authorization).toBe('Bearer secret');
      return jsonResponse(200, { ok: false, error: 'invalid_auth' });
    });

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).toBe('invalid_auth');
  });

  it('classifies notification telegram getMe transport failures as unreachable', async () => {
    const name = await enroll('notification', { subtype: 'telegram' });

    const health = await probe('notification', name, async () => {
      throw new Error('telegram timeout');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('telegram timeout');
  });

  it('classifies a notification email connection with a sender_mail_instance as ok (config readiness, no network)', async () => {
    const name = await enroll('notification', {
      subtype: 'email',
      auth: { type: 'none' },
      config: { sender_mail_instance: 'my-mailbox' },
    });

    // The email subtype is a façade over a mail instance, so the probe is a
    // config-readiness check — the fetcher must NOT fire.
    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('ok');
  });

  it('classifies a notification email connection missing sender_mail_instance as unreachable', async () => {
    const name = await enroll('notification', {
      subtype: 'email',
      auth: { type: 'none' },
      config: {},
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('email_no_sender_mail_instance');
  });

  it('treats a blank sender_mail_instance as unreachable', async () => {
    const name = await enroll('notification', {
      subtype: 'email',
      auth: { type: 'none' },
      config: { sender_mail_instance: '   ' },
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('email_no_sender_mail_instance');
  });

  it('treats a surrounding-whitespace sender_mail_instance as unreachable (send uses the exact key)', async () => {
    const name = await enroll('notification', {
      subtype: 'email',
      auth: { type: 'none' },
      config: { sender_mail_instance: ' my-mailbox ' },
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).toBe('email_no_sender_mail_instance');
  });

  it('maps a locked vault to unknown plus vault_locked without decoding auth', async () => {
    const name = 'locked-api';
    store.upsert({
      kind: 'api',
      name,
      display_name: name,
      config_json: JSON.stringify({ base_url: 'https://api.example.test/root' }),
      auth_ciphertext: await encodeAuthForStorage(
        { type: 'bearer', token: 'secret' },
        { kind: 'api', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const fetcher = vi.fn<HttpFetcher>();

    const result = await handleConnectionProbe(
      {
        store,
        now: () => NOW + 1_000,
        getEncryptionKey: () => null,
        fetcher,
      },
      { kind: 'api', name },
    );

    expect(result.health.status).toBe('unknown');
    expect(result.health.last_error).toBe('vault_locked');
    expect(fetcher).not.toHaveBeenCalled();
    expect(storedHealth('api', name).last_error).toBe('vault_locked');
  });
});

describe('handleConnectionRotateCredentials', () => {
  const attempt_id = 'rotation-attempt-test-0001';

  it('⛔ the signing negative control corrupts the SECRET, not the api key', async () => {
    // A rotation proves the check DISCRIMINATES by re-running it with an
    // intentionally wrong credential and requiring a rejection. Which half is
    // corrupted decides what that proves.
    //
    // ⛔ Corrupting the api key would prove the endpoint validates KEYS — Binance
    // rejects an unknown `X-MBX-APIKEY` before it ever looks at the signature,
    // so the control would be refused for a reason unrelated to signing, and a
    // provider that ignored signatures entirely would still pass. A valid key
    // with a wrong secret fails at signature verification, which is the negative
    // this control has to establish.
    const name = await enroll('api', {
      name: 'binance-negctl',
      config: { base_url: 'https://api.binance.com/api/v3/account' },
      auth: {
        type: 'request_signature',
        scheme: 'binance_hmac_sha256',
        api_key: 'real-public-key',
        secret_key: 'real-signing-secret',
      } as ConnectionAuth,
    });
    const before = store.get('api', name)!;
    const sent: { key: string | undefined; signature: string | null }[] = [];
    const fetcher = vi.fn<HttpFetcher>(async (url, init) => {
      const h = { ...(init?.headers as Record<string, string> | undefined) };
      sent.push({
        key: h['X-MBX-APIKEY'],
        signature: new URL(String(url)).searchParams.get('signature'),
      });
      // candidate passes, control must be REJECTED for the probe to discriminate
      return new Response('{}', { status: sent.length === 1 ? 200 : 401 });
    });

    await handleConnectionRotateCredentials(
      { store, now: () => NOW + 500, getEncryptionKey, fetcher },
      {
        attempt_id: 'rotation-negctl-0001',
        name,
        kind: 'api',
        expected_updated_at: before.updated_at,
        patch: {
          auth: {
            type: 'request_signature',
            scheme: 'binance_hmac_sha256',
            api_key: 'real-public-key',
            secret_key: 'real-signing-secret',
          } as ConnectionAuth,
        },
      },
    ).catch(() => undefined);

    expect(sent.length).toBeGreaterThanOrEqual(2);
    const [candidate, control] = sent;
    // SAME public key on both — the control is not testing key validation
    expect(control!.key).toBe(candidate!.key);
    expect(control!.key).toBe('real-public-key');
    // and a DIFFERENT signature, because the secret behind it was corrupted
    expect(control!.signature).not.toBe(candidate!.signature);
    expect(control!.signature).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects a stale editor revision before claiming an attempt or contacting the provider', async () => {
    const name = await enroll('api', { name: 'stale-editor' });
    const before = store.get('api', name)!;
    const fetcher = vi.fn<HttpFetcher>();

    await expect(handleConnectionRotateCredentials(
      { store, now: () => NOW + 500, getEncryptionKey, fetcher },
      {
        attempt_id,
        name,
        kind: 'api',
        expected_updated_at: before.updated_at - 1,
        patch: { auth: { type: 'bearer', token: 'must-not-be-checked' } },
      },
    )).rejects.toMatchObject({
      code: 'conflict',
      details: { existing_credential_preserved: true },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.get('api', name)).toEqual(before);
    await expect(handleConnectionCredentialRotationStatus(
      { store },
      { attempt_id, kind: 'api', name },
    )).resolves.toEqual({ outcome: { status: 'not_found' } });
  });

  it('refuses a Slack Socket Mode rotation that would drop the app-level token', async () => {
    const name = await enroll('notification', {
      name: 'slack',
      subtype: 'slack',
      config: { channel_id: 'C1', ingress_mode: 'socket' },
      auth: {
        type: 'bearer',
        token: 'synthetic-bot-original',
        app_token: 'synthetic-app-original',
      },
    });
    const before = store.get('notification', name)!;
    const fetcher = vi.fn<HttpFetcher>();

    // The bot token alone is exactly what a rotation form (or any non-UI
    // caller) sends when it treats `auth.token` as the whole credential.
    // Committing it would erase `app_token`, and the supervisor would stop
    // Socket Mode with nothing left to restart it.
    await expect(handleConnectionRotateCredentials(
      { store, now: () => NOW + 500, getEncryptionKey, fetcher },
      {
        attempt_id,
        name,
        kind: 'notification',
        patch: { auth: { type: 'bearer', token: 'fake-bot-next' } },
      },
    )).rejects.toMatchObject({ code: 'bad_request' });
    // Refused BEFORE the attempt is claimed or the provider is contacted.
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.get('notification', name)).toEqual(before);
    await expect(handleConnectionCredentialRotationStatus(
      { store },
      { attempt_id, kind: 'notification', name },
    )).resolves.toEqual({ outcome: { status: 'not_found' } });
  });

  it('allows a webhook-mode Slack rotation to carry only the bot token', async () => {
    const name = await enroll('notification', {
      name: 'slack-webhook',
      subtype: 'slack',
      config: { channel_id: 'C1', ingress_mode: 'webhook', signing_secret: 's3cret' },
      auth: { type: 'bearer', token: 'synthetic-bot-original' },
    });
    const fetcher = vi.fn<HttpFetcher>(async () => jsonResponse(200, { ok: true }));

    // The guard is Socket Mode's, not Slack's — webhook mode never needed an
    // app-level token, so requiring one here would block a valid rotation.
    await expect(handleConnectionRotateCredentials(
      { store, now: () => NOW + 500, getEncryptionKey, fetcher },
      {
        attempt_id,
        name,
        kind: 'notification',
        patch: { auth: { type: 'bearer', token: 'fake-bot-next' } },
      },
    )).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalled();
  });

  it('keeps the exact durable row when the provider rejects a replacement', async () => {
    const name = await enroll('api', { name: 'kept-working' });
    const before = store.get('api', name)!;
    const observed = vi.fn();
    const unsubscribe = store.addOnUpsert(observed);
    const fetcher = vi.fn<HttpFetcher>(async (_url, init) => {
      expect(init?.headers?.Authorization).toBe('Bearer rejected-replacement');
      return jsonResponse(401);
    });

    let thrown: unknown;
    try {
      await handleConnectionRotateCredentials(
        { store, now: () => NOW + 1_000, getEncryptionKey, fetcher },
        {
          attempt_id,
          name,
          kind: 'api',
          patch: {
            display_name: 'Should not land',
            config: { base_url: 'https://replacement.example.test' },
            auth: { type: 'bearer', token: 'rejected-replacement' },
          },
          match_patterns: [{ kind: 'tag', value: 'must_not_land' }],
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RpcError);
    expect(thrown).toMatchObject({
      code: 'credential_verification_failed',
      details: {
        verification_status: 'auth_failed',
        reason: 'http_status_401',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'bearer',
          field_keys: ['auth.token'],
        },
      },
    });
    expect(store.get('api', name)).toEqual(before);
    await expect(handleConnectionCredentialRotationStatus(
      { store },
      { attempt_id, kind: 'api', name },
    )).resolves.toEqual({
      outcome: {
        status: 'failed',
        started_at: NOW + 1_000,
        finished_at: NOW + 1_000,
        reason: 'auth_failed',
        correction: {
          auth_type: 'bearer',
          field_keys: ['auth.token'],
        },
      },
    });
    await expect(handleConnectionRotateCredentials(
      { store, now: () => NOW + 2_000, getEncryptionKey, fetcher },
      {
        attempt_id,
        name,
        kind: 'api',
        patch: {
          auth: {
            type: 'basic',
            username: 'must-not-replay',
            password: 'must-not-replay',
          },
        },
      },
    )).rejects.toMatchObject({
      code: 'credential_verification_failed',
      details: {
        verification_status: 'auth_failed',
        correction: {
          auth_type: 'bearer',
          field_keys: ['auth.token'],
        },
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(observed).not.toHaveBeenCalled();
    const storedAuth = await decodeAuthFromStorage(
      before.auth_ciphertext,
      { kind: 'api', name },
      getEncryptionKey,
    );
    expect(storedAuth).toEqual({ type: 'bearer', token: 'secret' });
    unsubscribe();
  });

  it('triages only a consecutive provider rejection and preserves it for status and replay', async () => {
    const name = await enroll('api', { name: 'rejected-again' });
    const before = store.get('api', name)!;
    const fetcher = vi.fn<HttpFetcher>(async () => jsonResponse(401));
    const rotate = (attemptId: string) => handleConnectionRotateCredentials(
      { store, now: () => NOW + 1_500, getEncryptionKey, fetcher },
      {
        attempt_id: attemptId,
        name,
        kind: 'api' as const,
        patch: {
          config: { base_url: 'https://api.example.test' },
          auth: { type: 'bearer' as const, token: 'rejected-again' },
        },
      },
    );

    let first: unknown;
    try {
      await rotate('rotation-rejected-again-0001');
    } catch (error) {
      first = error;
    }
    expect(first).toBeInstanceOf(RpcError);
    expect((first as RpcError).details?.correction).not.toHaveProperty('triage');

    await expect(rotate('rotation-rejected-again-0002')).rejects.toMatchObject({
      code: 'credential_verification_failed',
      details: {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'bearer',
          field_keys: ['auth.token'],
          triage: {
            reason: 'repeated_auth_rejection',
            stage: 'provider_probe',
            endpoint_field_keys: ['config.base_url', 'config.endpoint'],
          },
        },
      },
    });
    expect(store.get('api', name)).toEqual(before);

    await expect(handleConnectionCredentialRotationStatus(
      { store },
      {
        attempt_id: 'rotation-rejected-again-0002',
        kind: 'api',
        name,
      },
    )).resolves.toMatchObject({
      outcome: {
        status: 'failed',
        correction: {
          triage: {
            stage: 'provider_probe',
            endpoint_field_keys: ['config.base_url', 'config.endpoint'],
          },
        },
      },
    });

    await expect(rotate('rotation-rejected-again-0002')).rejects.toMatchObject({
      details: {
        correction: {
          triage: { stage: 'provider_probe' },
        },
      },
    });
    expect(
      store.getCredentialRotationAttempt?.('rotation-rejected-again-0002'),
    ).not.toHaveProperty('auth_rejection_resolution');

    await expect(rotate('rotation-rejected-again-0003')).rejects.toMatchObject({
      code: 'credential_verification_failed',
      details: {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'bearer',
          field_keys: ['auth.token'],
          triage: {
            reason: 'repeated_auth_rejection',
            stage: 'provider_probe',
            endpoint_field_keys: ['config.base_url', 'config.endpoint'],
            resolution: 'regenerate_credential_or_contact_admin',
          },
        },
      },
    });
    expect(store.get('api', name)).toEqual(before);

    await expect(handleConnectionCredentialRotationStatus(
      { store },
      {
        attempt_id: 'rotation-rejected-again-0003',
        kind: 'api',
        name,
      },
    )).resolves.toMatchObject({
      outcome: {
        status: 'failed',
        correction: {
          triage: {
            stage: 'provider_probe',
            resolution: 'regenerate_credential_or_contact_admin',
          },
        },
      },
    });

    const siblingActivity = await handleConnectionCredentialRotationActivity(
      { store },
      { kind: 'api', name },
    );
    const safeStopAttempt = store.getLatestCredentialRotationAttempt!(
      'api',
      name,
    )!;
    const acknowledgementToken = credentialSafeStopAcknowledgementToken(
      safeStopAttempt,
    );
    expect(siblingActivity).toEqual({
      activity: {
        status: 'idle',
        safe_stop: {
          finished_at: NOW + 1_500,
          acknowledgement_token: acknowledgementToken,
          correction: {
            auth_type: 'bearer',
            field_keys: ['auth.token'],
            triage: {
              reason: 'repeated_auth_rejection',
              stage: 'provider_probe',
              endpoint_field_keys: ['config.base_url', 'config.endpoint'],
              resolution: 'regenerate_credential_or_contact_admin',
            },
          },
        },
      },
    });
    expect(JSON.stringify(siblingActivity)).not.toMatch(
      /rejected-again|api\.example|provider-authored|attempt_id|token.*value/i,
    );

    const coldList = await handleConnectionList({ store }, { kind: 'api' });
    expect(coldList.credential_rotation_safe_stops).toEqual([{
      kind: 'api',
      name,
      ...(siblingActivity.activity.status === 'idle'
        ? siblingActivity.activity.safe_stop
        : {}),
    }]);
    expect(JSON.stringify(coldList.credential_rotation_safe_stops)).not.toMatch(
      /api\.example|provider-authored|attempt_id|rejected-again-0003/i,
    );

    await expect(handleConnectionAcknowledgeCredentialRotationSafeStop(
      { store },
      {
        kind: 'api',
        name,
        acknowledgement_token: 'not-a-token',
      },
    )).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleConnectionAcknowledgeCredentialRotationSafeStop(
      { store, now: () => NOW + 2_000 },
      {
        kind: 'api',
        name,
        acknowledgement_token: 'b'.repeat(64),
      },
    )).resolves.toEqual({ acknowledgement: { status: 'superseded' } });
    await expect(handleConnectionAcknowledgeCredentialRotationSafeStop(
      { store, now: () => NOW + 2_000 },
      { kind: 'api', name, acknowledgement_token: acknowledgementToken },
    )).resolves.toEqual({
      acknowledgement: {
        status: 'acknowledged',
        acknowledged_at: NOW + 2_000,
      },
    });
    await expect(handleConnectionAcknowledgeCredentialRotationSafeStop(
      { store, now: () => NOW + 3_000 },
      { kind: 'api', name, acknowledgement_token: acknowledgementToken },
    )).resolves.toEqual({
      acknowledgement: {
        status: 'already_acknowledged',
        acknowledged_at: NOW + 2_000,
      },
    });
    await expect(handleConnectionCredentialRotationStatus(
      { store },
      {
        attempt_id: 'rotation-rejected-again-0003',
        kind: 'api',
        name,
      },
    )).resolves.toEqual({
      outcome: {
        status: 'failed',
        started_at: NOW + 1_500,
        finished_at: NOW + 1_500,
        reason: 'auth_failed',
        correction: {
          auth_type: 'bearer',
          field_keys: ['auth.token'],
          triage: {
            reason: 'repeated_auth_rejection',
            stage: 'provider_probe',
            endpoint_field_keys: ['config.base_url', 'config.endpoint'],
          },
        },
        safe_stop_acknowledged_at: NOW + 2_000,
      },
    });
    await expect(handleConnectionCredentialRotationActivity(
      { store },
      { kind: 'api', name },
    )).resolves.toEqual({
      activity: { status: 'idle', safe_stop: null },
    });
    const awaitingPostAckCheck = await handleConnectionList(
      { store, getEncryptionKey },
      { kind: 'api' },
    );
    expect(awaitingPostAckCheck).not.toHaveProperty(
      'credential_rotation_safe_stops',
    );
    expect(
      awaitingPostAckCheck.credential_post_safe_stop_verifications,
    ).toEqual([{
      kind: 'api',
      name,
      status: 'pending',
      acknowledged_at: NOW + 2_000,
    }]);

    const postAckRejection = await handleConnectionProbe(
      {
        store,
        // Deliberate clock rollback: lineage, not timestamp ordering, proves
        // this check follows the acknowledgement at NOW + 2_000.
        now: () => NOW + 1_000,
        getEncryptionKey,
        fetcher: async () => jsonResponse(401),
      },
      { kind: 'api', name },
    );
    expect(postAckRejection.health).toMatchObject({ status: 'auth_failed' });
    expect(postAckRejection.health).not.toHaveProperty(
      'post_safe_stop_verification',
    );
    const rejectedSavedCredential = await handleConnectionList(
      { store, getEncryptionKey },
      { kind: 'api' },
    );
    expect(
      rejectedSavedCredential.credential_post_safe_stop_verifications,
    ).toEqual([{
      kind: 'api',
      name,
      status: 'auth_failed',
      acknowledged_at: NOW + 2_000,
      checked_at: NOW + 1_000,
      connection_updated_at: NOW + 1_000,
      credential_correction: {
        auth_type: 'bearer',
        field_keys: ['auth.token'],
      },
    }]);

    const originalAcknowledgedList =
      store.listAcknowledgedCredentialRotationSafeStops!;
    let injectedConcurrentEdit = false;
    store.listAcknowledgedCredentialRotationSafeStops = (query) => {
      if (!injectedConcurrentEdit) {
        injectedConcurrentEdit = true;
        const current = store.get('api', name)!;
        store.upsert({
          ...current,
          display_name: 'Edited while the list decoded auth',
          updated_at: current.updated_at + 1,
        });
      }
      return originalAcknowledgedList.call(store, query);
    };
    try {
      await expect(handleConnectionList(
        { store, getEncryptionKey },
        { kind: 'api' },
      )).resolves.toMatchObject({
        credential_post_safe_stop_verifications: [{
          kind: 'api',
          name,
          status: 'pending',
          acknowledged_at: NOW + 2_000,
        }],
      });
    } finally {
      store.listAcknowledgedCredentialRotationSafeStops =
        originalAcknowledgedList;
    }

    await handleConnectionProbe(
      {
        store,
        now: () => NOW + 500,
        getEncryptionKey,
        fetcher: async () => jsonResponse(204),
      },
      { kind: 'api', name },
    );
    await expect(handleConnectionList(
      { store, getEncryptionKey },
      { kind: 'api' },
    )).resolves.toMatchObject({
      credential_post_safe_stop_verifications: [],
    });

    await expect(rotate('rotation-rejected-again-0004')).rejects
      .toMatchObject({
        details: {
          correction: {
            triage: {
              resolution: 'regenerate_credential_or_contact_admin',
            },
          },
        },
      });
    const collidingSafeStop = store.getLatestCredentialRotationAttempt!(
      'api',
      name,
    )!;
    const collidingAcknowledgementToken =
      credentialSafeStopAcknowledgementToken(collidingSafeStop);
    expect(collidingAcknowledgementToken).not.toBe(acknowledgementToken);
    await expect(handleConnectionAcknowledgeCredentialRotationSafeStop(
      { store, now: () => NOW + 2_000 },
      {
        kind: 'api',
        name,
        acknowledgement_token: collidingAcknowledgementToken,
      },
    )).resolves.toMatchObject({
      acknowledgement: {
        status: 'acknowledged',
        acknowledged_at: NOW + 2_000,
      },
    });
    await expect(handleConnectionList(
      { store, getEncryptionKey },
      { kind: 'api' },
    )).resolves.toMatchObject({
      credential_post_safe_stop_verifications: [{
        kind: 'api',
        name,
        status: 'pending',
        acknowledged_at: NOW + 2_000,
      }],
    });

    let releasePostAckProbe!: () => void;
    let markPostAckProbeStarted!: () => void;
    const postAckProbeStarted = new Promise<void>((resolve) => {
      markPostAckProbeStarted = resolve;
    });
    const releasePostAckProvider = new Promise<void>((resolve) => {
      releasePostAckProbe = resolve;
    });
    const supersededProbe = handleConnectionProbe(
      {
        store,
        now: () => NOW + 5_000,
        getEncryptionKey,
        fetcher: async () => {
          markPostAckProbeStarted();
          await releasePostAckProvider;
          return jsonResponse(204);
        },
      },
      { kind: 'api', name },
    );
    const supersededProbeRejection = expect(supersededProbe).rejects
      .toMatchObject({
        code: 'conflict',
        details: { existing_credential_preserved: true },
      });
    await postAckProbeStarted;
    const rowBeforeSuccessor = store.get('api', name)!;
    store.claimCredentialRotationAttempt!({
      attempt_id: 'rotation-rejected-again-reset-0004',
      kind: 'api',
      name,
      started_at: NOW + 1_600,
    });
    releasePostAckProbe();
    await supersededProbeRejection;
    expect(store.get('api', name)).toEqual(rowBeforeSuccessor);
    store.failCredentialRotationAttempt!({
      attempt_id: 'rotation-rejected-again-reset-0004',
      finished_at: NOW + 1_601,
      reason: 'unreachable',
    });
    await expect(handleConnectionCredentialRotationActivity(
      { store },
      { kind: 'api', name },
    )).resolves.toEqual({
      activity: { status: 'idle', safe_stop: null },
    });

    let replayAfterClosure: unknown;
    try {
      await rotate('rotation-rejected-again-0003');
    } catch (error) {
      replayAfterClosure = error;
    }
    expect(replayAfterClosure).toMatchObject({
      details: {
        correction: { triage: { stage: 'provider_probe' } },
      },
    });
    expect((replayAfterClosure as RpcError).details?.correction)
      .not.toMatchObject({
        triage: { resolution: 'regenerate_credential_or_contact_admin' },
      });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not resurrect an older safe stop after a newer terminal attempt', async () => {
    const name = await enroll('api', { name: 'superseded-safe-stop' });
    const fail = (
      attemptId: string,
      reason: 'auth_failed' | 'unreachable',
      at: number,
    ): void => {
      store.claimCredentialRotationAttempt!({
        attempt_id: attemptId,
        kind: 'api',
        name,
        started_at: at,
      });
      store.failCredentialRotationAttempt!({
        attempt_id: attemptId,
        finished_at: at + 1,
        reason,
        ...(reason === 'auth_failed'
          ? {
              auth_type: 'bearer',
              auth_rejection_stage: 'provider_probe',
            }
          : {}),
      });
    };

    fail('rotation-safe-stop-seed-0001', 'auth_failed', NOW + 100);
    fail('rotation-safe-stop-triaged-0002', 'auth_failed', NOW + 200);
    fail('rotation-safe-stop-current-0003', 'auth_failed', NOW + 300);
    await expect(handleConnectionCredentialRotationStatus(
      { store },
      {
        attempt_id: 'rotation-safe-stop-current-0003',
        kind: 'api',
        name,
      },
    )).resolves.toMatchObject({
      outcome: {
        status: 'failed',
        correction: {
          triage: {
            resolution: 'regenerate_credential_or_contact_admin',
          },
        },
      },
    });
    const currentAttempt = store.getLatestCredentialRotationAttempt!(
      'api',
      name,
    )!;
    await expect(handleConnectionAcknowledgeCredentialRotationSafeStop(
      { store, now: () => NOW + 350 },
      {
        kind: 'api',
        name,
        acknowledgement_token:
          credentialSafeStopAcknowledgementToken(currentAttempt),
      },
    )).resolves.toMatchObject({
      acknowledgement: { status: 'acknowledged' },
    });

    // A later terminal attempt can leave the connection row revision exactly
    // unchanged. The old exact receipt remains readable, but it is no longer
    // allowed to project the connection-current safe-stop resolution.
    fail('rotation-safe-stop-reset-0004', 'unreachable', NOW + 400);
    const superseded = await handleConnectionCredentialRotationStatus(
      { store },
      {
        attempt_id: 'rotation-safe-stop-current-0003',
        kind: 'api',
        name,
      },
    );
    expect(superseded).toMatchObject({
      outcome: {
        status: 'failed',
        correction: { triage: { stage: 'provider_probe' } },
      },
    });
    expect(superseded.outcome).not.toMatchObject({
      correction: {
        triage: { resolution: 'regenerate_credential_or_contact_admin' },
      },
    });
    expect(superseded.outcome).not.toHaveProperty(
      'safe_stop_acknowledged_at',
    );
    await expect(handleConnectionCredentialRotationActivity(
      { store },
      { kind: 'api', name },
    )).resolves.toEqual({
      activity: { status: 'idle', safe_stop: null },
    });
  });

  it('does not infer correction fields from a replay when a legacy failed receipt lacks its auth shape', async () => {
    const name = await enroll('api', { name: 'legacy-failed-receipt' });
    store.claimCredentialRotationAttempt!({
      attempt_id,
      kind: 'api',
      name,
      started_at: NOW + 1_100,
    });
    store.failCredentialRotationAttempt!({
      attempt_id,
      finished_at: NOW + 1_200,
      reason: 'auth_failed',
    });
    const fetcher = vi.fn<HttpFetcher>();

    let replayError: unknown;
    try {
      await handleConnectionRotateCredentials(
        { store, now: () => NOW + 2_000, getEncryptionKey, fetcher },
        {
          attempt_id,
          name,
          kind: 'api',
          patch: {
            auth: {
              type: 'basic',
              username: 'must-not-be-trusted',
              password: 'must-not-be-trusted',
            },
          },
        },
      );
    } catch (error) {
      replayError = error;
    }

    expect(replayError).toBeInstanceOf(RpcError);
    expect(replayError).toMatchObject({
      code: 'credential_verification_failed',
      details: {
        verification_status: 'auth_failed',
        existing_credential_preserved: true,
      },
    });
    expect((replayError as RpcError).details).not.toHaveProperty('correction');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps recovery mandatory when a terminal failure receipt cannot be closed', async () => {
    const name = await enroll('api', { name: 'receipt-write-fails' });
    const before = store.get('api', name)!;
    store.failCredentialRotationAttempt = () => {
      throw new Error('simulated receipt write failure');
    };

    await expect(handleConnectionRotateCredentials(
      {
        store,
        now: () => NOW + 1_250,
        getEncryptionKey,
        fetcher: async () => jsonResponse(401),
      },
      {
        attempt_id,
        name,
        kind: 'api',
        patch: { auth: { type: 'bearer', token: 'rejected-replacement' } },
      },
    )).rejects.toMatchObject({
      code: 'credential_rotation_outcome_unknown',
    });
    expect(store.get('api', name)).toEqual(before);
    await expect(handleConnectionCredentialRotationStatus(
      { store },
      { attempt_id, kind: 'api', name },
    )).resolves.toEqual({
      outcome: { status: 'pending', started_at: NOW + 1_250 },
    });
  });

  it('does not mistake a merely reachable provider error for credential verification', async () => {
    const name = await enroll('api', { name: 'reachable-but-unverified' });
    const before = store.get('api', name)!;

    await expect(handleConnectionRotateCredentials(
      {
        store,
        now: () => NOW + 1_500,
        getEncryptionKey,
        // Ordinary row health intentionally calls this reachable/ok, but a
        // 500 says nothing affirmative about the replacement credential.
        fetcher: async () => jsonResponse(500),
      },
      {
        attempt_id,
        name,
        kind: 'api',
        patch: { auth: { type: 'bearer', token: 'not-proven' } },
      },
    )).rejects.toMatchObject({
      code: 'credential_verification_failed',
      details: {
        verification_status: 'unknown',
        reason: 'http_status_500',
        existing_credential_preserved: true,
      },
    });
    expect(store.get('api', name)).toEqual(before);
  });

  it('preserves the current row when a public endpoint accepts an invalid control credential too', async () => {
    const name = await enroll('api', { name: 'public-health-endpoint' });
    const before = store.get('api', name)!;
    const fetcher = vi.fn<HttpFetcher>(async () => jsonResponse(204));

    await expect(handleConnectionRotateCredentials(
      { store, now: () => NOW + 1_750, getEncryptionKey, fetcher },
      {
        attempt_id,
        name,
        kind: 'api',
        patch: { auth: { type: 'bearer', token: 'cannot-be-proven-here' } },
      },
    )).rejects.toMatchObject({
      code: 'credential_verification_failed',
      details: {
        verification_status: 'unknown',
        reason: 'credential_check_did_not_require_auth',
        existing_credential_preserved: true,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.get('api', name)).toEqual(before);
  });

  it('writes once only after verification and returns a secret-free receipt', async () => {
    const name = await enroll('api', { name: 'rotate-me' });
    const before = store.get('api', name)!;
    const observed = vi.fn();
    const unsubscribe = store.addOnUpsert(observed);
    const result = await handleConnectionRotateCredentials(
      {
        store,
        now: () => NOW + 2_000,
        getEncryptionKey,
        fetcher: async (_url, init) => {
          const authorization = init?.headers?.Authorization;
          if (authorization === 'Bearer recued-intentionally-invalid-credential') {
            return jsonResponse(401);
          }
          expect(authorization).toBe('Bearer verified-new-secret');
          return jsonResponse(204);
        },
      },
      {
        attempt_id,
        name,
        kind: 'api',
        expected_updated_at: before.updated_at,
        patch: {
          display_name: 'Rotated API',
          config: { base_url: 'https://api.example.test/rotated' },
          auth: { type: 'bearer', token: 'verified-new-secret' },
        },
        match_patterns: [{ kind: 'tag', value: 'rotated' }],
      },
    );

    expect(result.verification).toEqual({
      status: 'verified',
      verified_at: NOW + 2_000,
      auth_type: 'bearer',
    });
    expect(JSON.stringify(result)).not.toContain('verified-new-secret');
    expect(observed).toHaveBeenCalledTimes(1);
    const row = store.get('api', name)!;
    expect(row.updated_at).toBeGreaterThan(before.updated_at);
    expect(row.display_name).toBe('Rotated API');
    expect(JSON.parse(row.config_json)).toEqual({
      base_url: 'https://api.example.test/rotated',
      match_patterns: [{ kind: 'tag', value: 'rotated' }],
    });
    expect(JSON.parse(row.health_json!)).toMatchObject({ status: 'ok' });
    expect(row.granted_scopes_json).toBeUndefined();
    expect(await decodeAuthFromStorage(
      row.auth_ciphertext,
      { kind: 'api', name },
      getEncryptionKey,
    )).toEqual({ type: 'bearer', token: 'verified-new-secret' });

    await expect(handleConnectionCredentialRotationStatus(
      { store },
      { attempt_id, kind: 'api', name },
    )).resolves.toEqual({
      outcome: {
        status: 'succeeded',
        started_at: NOW + 2_000,
        verification: result.verification,
      },
    });
    const replayFetch = vi.fn<HttpFetcher>();
    const replay = await handleConnectionRotateCredentials(
      { store, now: () => NOW + 99_000, getEncryptionKey, fetcher: replayFetch },
      {
        attempt_id,
        name,
        kind: 'api',
        // Replaying the same attempt remains idempotent even though this is now
        // intentionally older than the committed row revision.
        expected_updated_at: before.updated_at,
        patch: { auth: { type: 'bearer', token: 'must-not-replace-again' } },
      },
    );
    expect(replay.verification).toEqual(result.verification);
    expect(replayFetch).not.toHaveBeenCalled();
    expect(await decodeAuthFromStorage(
      store.get('api', name)!.auth_ciphertext,
      { kind: 'api', name },
      getEncryptionKey,
    )).toEqual({ type: 'bearer', token: 'verified-new-secret' });
    unsubscribe();
  });

  it('rotates and verifies both Slack Socket Mode credentials as one candidate', async () => {
    const name = await enroll('notification', {
      name: 'slack',
      subtype: 'slack',
      config: { channel_id: 'C-1', ingress_mode: 'socket' },
      auth: {
        type: 'bearer',
        token: 'old-bot-token',
        app_token: 'old-app-token',
      },
    });
    const before = store.get('notification', name)!;
    const fetcher = vi.fn<HttpFetcher>(async (url, init) => {
      if (url === 'https://slack.com/api/auth.test') {
        expect(init?.headers?.Authorization).toBe('Bearer new-bot-token');
        return jsonResponse(200, { ok: true });
      }
      expect(url).toBe('https://slack.com/api/apps.connections.open');
      expect(init?.headers?.Authorization).toBe('Bearer new-app-token');
      return jsonResponse(200, { ok: true, url: 'wss://wss-primary.slack.com/link' });
    });

    const result = await handleConnectionRotateCredentials(
      { store, now: () => NOW + 2_500, getEncryptionKey, fetcher },
      {
        attempt_id,
        name,
        kind: 'notification',
        expected_updated_at: before.updated_at,
        patch: {
          auth: {
            type: 'bearer',
            token: 'new-bot-token',
            app_token: 'new-app-token',
          },
        },
      },
    );

    expect(result.verification).toMatchObject({
      status: 'verified',
      auth_type: 'bearer',
      verified_at: NOW + 2_500,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await decodeAuthFromStorage(
      store.get('notification', name)!.auth_ciphertext,
      { kind: 'notification', name },
      getEncryptionKey,
    )).toEqual({
      type: 'bearer',
      token: 'new-bot-token',
      app_token: 'new-app-token',
    });
    expect(JSON.stringify(result)).not.toContain('new-bot-token');
    expect(JSON.stringify(result)).not.toContain('new-app-token');
  });

  it('exchanges an OAuth refresh credential before the provider probe and persists its rotation metadata', async () => {
    const name = await enroll('api', { name: 'oauth-rotate' });
    const tokenFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'replacement-refresh',
        client_id: 'replacement-client',
      });
      return new Response(JSON.stringify({
        access_token: 'fresh-access',
        refresh_token: 'rotated-refresh',
        token_type: 'Bearer',
        expires_in: 300,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const apiFetch = vi.fn<HttpFetcher>(async (_url, init) => {
      expect(init?.headers?.Authorization).toBe('Bearer fresh-access');
      return jsonResponse(204);
    });

    const result = await handleConnectionRotateCredentials(
      {
        store,
        now: () => NOW + 3_000,
        getEncryptionKey,
        fetcher: apiFetch,
        resolveFetch: tokenFetch,
      },
      {
        attempt_id,
        name,
        kind: 'api',
        patch: {
          auth: {
            type: 'oauth2_refresh',
            refresh_token: 'replacement-refresh',
            client_id: 'replacement-client',
            token_endpoint: 'https://oauth.example.test/token',
          },
        },
        granted_scopes: [' read ', 'write', 'read'],
      },
    );

    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(result.verification).toMatchObject({
      status: 'verified',
      auth_type: 'oauth2_refresh',
      verified_at: NOW + 3_000,
      access_expires_at: NOW + 303_000,
    });
    const stored = await decodeAuthFromStorage(
      store.get('api', name)!.auth_ciphertext,
      { kind: 'api', name },
      getEncryptionKey,
    );
    expect(stored).toMatchObject({
      type: 'oauth2_refresh',
      refresh_token: 'rotated-refresh',
      current_access_token: 'fresh-access',
      expires_at: NOW + 303_000,
    });
    expect(JSON.parse(store.get('api', name)!.granted_scopes_json!)).toEqual([
      'read',
      'write',
    ]);
  });

  it('ignores a caller-supplied OAuth cache and verifies the durable refresh credential', async () => {
    const name = await enroll('api', { name: 'oauth-cache-bypass' });
    const before = store.get('api', name)!;
    const tokenFetch = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    const apiFetch = vi.fn<HttpFetcher>(async () => jsonResponse(204));

    await expect(handleConnectionRotateCredentials(
      {
        store,
        now: () => NOW + 3_500,
        getEncryptionKey,
        fetcher: apiFetch,
        resolveFetch: tokenFetch,
      },
      {
        attempt_id,
        name,
        kind: 'api',
        patch: {
          auth: {
            type: 'oauth2_refresh',
            refresh_token: 'rejected-durable-refresh',
            client_id: 'replacement-client',
            token_endpoint: 'https://oauth.example.test/token',
            current_access_token: 'caller-injected-cache',
            expires_at: NOW + 86_400_000,
          },
        },
      },
    )).rejects.toMatchObject({
      code: 'credential_verification_failed',
      details: {
        verification_status: 'auth_failed',
        reason: 'token_exchange_failed',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'oauth2_refresh',
          field_keys: [
            'auth.refresh_token',
            'auth.client_id',
            'auth.client_secret',
            'auth.token_endpoint',
          ],
        },
      },
    });
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(store.get('api', name)).toEqual(before);
  });

  it('routes a repeated OAuth exchange rejection to the token endpoint without provider prose', async () => {
    const name = await enroll('api', { name: 'oauth-exchange-triage' });
    store.claimCredentialRotationAttempt!({
      attempt_id: 'rotation-oauth-prior-failure-0001',
      kind: 'api',
      name,
      started_at: NOW + 3_540,
    });
    store.failCredentialRotationAttempt!({
      attempt_id: 'rotation-oauth-prior-failure-0001',
      finished_at: NOW + 3_550,
      reason: 'auth_failed',
      auth_type: 'oauth2_refresh',
      auth_rejection_stage: 'provider_probe',
    });
    const tokenFetch = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'provider-authored-secret-bearing-prose' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));

    await expect(handleConnectionRotateCredentials(
      {
        store,
        now: () => NOW + 3_600,
        getEncryptionKey,
        fetcher: vi.fn<HttpFetcher>(),
        resolveFetch: tokenFetch,
      },
      {
        attempt_id: 'rotation-oauth-repeat-failure-0002',
        name,
        kind: 'api',
        patch: {
          auth: {
            type: 'oauth2_refresh',
            refresh_token: 'replacement-refresh',
            client_id: 'replacement-client',
            token_endpoint: 'https://oauth.example.test/token',
          },
        },
      },
    )).rejects.toMatchObject({
      code: 'credential_verification_failed',
      details: {
        verification_status: 'auth_failed',
        correction: {
          triage: {
            reason: 'repeated_auth_rejection',
            stage: 'credential_exchange',
            endpoint_field_keys: ['auth.token_endpoint'],
          },
        },
      },
    });

    const receipt = store.getCredentialRotationAttempt!(
      'rotation-oauth-repeat-failure-0002',
    );
    expect(receipt).toMatchObject({
      status: 'failed',
      auth_rejection_triage_stage: 'credential_exchange',
    });
    expect(JSON.stringify(receipt)).not.toContain(
      'provider-authored-secret-bearing-prose',
    );
  });

  it('classifies a credential-exchange network failure as unreachable, not rejected auth', async () => {
    const name = await enroll('api', { name: 'oauth-network-failure' });
    const before = store.get('api', name)!;

    await expect(handleConnectionRotateCredentials(
      {
        store,
        now: () => NOW + 3_625,
        getEncryptionKey,
        fetcher: vi.fn<HttpFetcher>(),
        resolveFetch: async () => { throw new Error('network offline'); },
      },
      {
        attempt_id,
        name,
        kind: 'api',
        patch: {
          auth: {
            type: 'oauth2_refresh',
            refresh_token: 'replacement-refresh',
            client_id: 'replacement-client',
            token_endpoint: 'https://oauth.example.test/token',
          },
        },
      },
    )).rejects.toMatchObject({
      code: 'credential_verification_failed',
      details: {
        verification_status: 'unreachable',
        reason: 'token_exchange_failed',
        existing_credential_preserved: true,
      },
    });
    expect(store.get('api', name)).toEqual(before);
  });

  it('ignores caller-supplied AT Protocol sessions and verifies the app password', async () => {
    const name = await enroll('api', {
      name: 'atproto-cache-bypass',
      config: { base_url: 'https://bsky.social' },
    });
    const before = store.get('api', name)!;
    const sessionFetch = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'AuthenticationRequired' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));
    const apiFetch = vi.fn<HttpFetcher>(async () => jsonResponse(204));

    await expect(handleConnectionRotateCredentials(
      {
        store,
        now: () => NOW + 3_750,
        getEncryptionKey,
        fetcher: apiFetch,
        resolveFetch: sessionFetch,
      },
      {
        attempt_id,
        name,
        kind: 'api',
        patch: {
          auth: {
            type: 'atproto_session',
            identifier: 'alice.bsky.social',
            app_password: 'rejected-app-password',
            current_access_token: 'caller-injected-access',
            refresh_token: 'caller-injected-refresh',
          },
        },
      },
    )).rejects.toMatchObject({
      code: 'credential_verification_failed',
      details: {
        verification_status: 'auth_failed',
        reason: 'atproto_session_exchange_failed',
        existing_credential_preserved: true,
        correction: {
          auth_type: 'atproto_session',
          field_keys: ['auth.identifier', 'auth.app_password'],
        },
      },
    });
    expect(sessionFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(store.get('api', name)).toEqual(before);
  });

  it('drops a verified candidate when the real row changes during the network check', async () => {
    const name = await enroll('api', { name: 'contended' });
    let release!: (response: Awaited<ReturnType<HttpFetcher>>) => void;
    const gate = new Promise<Awaited<ReturnType<HttpFetcher>>>((resolve) => {
      release = resolve;
    });
    const rotation = handleConnectionRotateCredentials(
      {
        store,
        now: () => NOW + 4_000,
        getEncryptionKey,
        fetcher: async (_url, init) =>
          init?.headers?.Authorization === 'Bearer recued-intentionally-invalid-credential'
            ? jsonResponse(401)
            : gate,
      },
      {
        attempt_id,
        name,
        kind: 'api',
        patch: { auth: { type: 'bearer', token: 'stale-candidate' } },
      },
    );
    await vi.waitFor(() => {
      // The candidate has reached the awaited provider check.
      expect(store.get('api', name)?.display_name).toBe(name);
    });
    await handleConnectionUpdate(
      { store, now: () => NOW + 4_000, getEncryptionKey },
      {
        name,
        kind: 'api',
        patch: { display_name: 'Newer edit wins' },
      },
    );
    release(jsonResponse(204));

    await expect(rotation).rejects.toMatchObject({ code: 'conflict' });
    const row = store.get('api', name)!;
    expect(row.display_name).toBe('Newer edit wins');
    expect(await decodeAuthFromStorage(
      row.auth_ciphertext,
      { kind: 'api', name },
      getEncryptionKey,
    )).toEqual({ type: 'bearer', token: 'secret' });
  });

  it('rejects a stale contender after its claim and before duplicate provider work', async () => {
    const name = await enroll('api', { name: 'claim-race' });
    const before = store.get('api', name)!;
    const claim = store.claimCredentialRotationAttempt!.bind(store);
    let advanced = false;
    const racingStore: ConnectionStoreSqlite = {
      ...store,
      claimCredentialRotationAttempt(input) {
        if (!advanced) {
          advanced = true;
          store.upsert({
            ...before,
            display_name: 'Prior owner already won',
            updated_at: before.updated_at + 1,
          });
        }
        return claim(input);
      },
    };
    const fetcher = vi.fn<HttpFetcher>(async () => jsonResponse(204));

    await expect(handleConnectionRotateCredentials(
      { store: racingStore, now: () => NOW + 4_250, getEncryptionKey, fetcher },
      {
        attempt_id,
        name,
        kind: 'api',
        expected_updated_at: before.updated_at,
        patch: { auth: { type: 'bearer', token: 'queued-stale-candidate' } },
      },
    )).rejects.toMatchObject({
      code: 'conflict',
      details: { existing_credential_preserved: true },
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(store.get('api', name)).toMatchObject({
      display_name: 'Prior owner already won',
      updated_at: before.updated_at + 1,
    });
    expect(store.getCredentialRotationAttempt!(attempt_id)).toMatchObject({
      status: 'failed',
      failure_reason: 'conflict',
    });
  });

  it('reports an in-flight claim without replaying provider work', async () => {
    const name = await enroll('api', { name: 'pending-rotation' });
    let release!: (response: Awaited<ReturnType<HttpFetcher>>) => void;
    const gate = new Promise<Awaited<ReturnType<HttpFetcher>>>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<HttpFetcher>(async (_url, init) =>
      init?.headers?.Authorization === 'Bearer recued-intentionally-invalid-credential'
        ? jsonResponse(401)
        : gate);
    const first = handleConnectionRotateCredentials(
      { store, now: () => NOW + 4_500, getEncryptionKey, fetcher },
      {
        attempt_id,
        name,
        kind: 'api',
        patch: { auth: { type: 'bearer', token: 'first-candidate' } },
      },
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await expect(handleConnectionCredentialRotationStatus(
      { store },
      { attempt_id, kind: 'api', name },
    )).resolves.toEqual({
      outcome: { status: 'pending', started_at: NOW + 4_500 },
    });
    await expect(handleConnectionCredentialRotationActivity(
      { store },
      { kind: 'api', name },
    )).resolves.toEqual({
      activity: { status: 'pending', started_at: NOW + 4_500 },
    });
    await expect(handleConnectionCredentialRotationStatus(
      { store },
      { attempt_id, kind: 'api', name: 'different-connection' },
    )).resolves.toEqual({ outcome: { status: 'not_found' } });
    await expect(handleConnectionRotateCredentials(
      { store, now: () => NOW + 4_600, getEncryptionKey, fetcher },
      {
        attempt_id,
        name,
        kind: 'api',
        patch: { auth: { type: 'bearer', token: 'must-not-run' } },
      },
    )).rejects.toMatchObject({ code: 'credential_rotation_in_progress' });
    await expect(handleConnectionRotateCredentials(
      { store, now: () => NOW + 4_700, getEncryptionKey, fetcher },
      {
        attempt_id: 'rotation-probe-test-contender-0002',
        name,
        kind: 'api',
        patch: { auth: { type: 'bearer', token: 'must-not-run-either' } },
      },
    )).rejects.toMatchObject({
      code: 'credential_rotation_owned_elsewhere',
      details: { existing_credential_preserved: true },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    release(jsonResponse(204));
    await expect(first).resolves.toMatchObject({
      verification: { status: 'verified', auth_type: 'bearer' },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(handleConnectionCredentialRotationActivity(
      { store },
      { kind: 'api', name },
    )).resolves.toEqual({
      activity: { status: 'idle', safe_stop: null },
    });
  });
});

/** D-192 CORE #6 seam 8 — the notification probe's per-vendor `switch (subtype)`
 *  is gone: the URL, the method + where the credential rides are now DECLARED
 *  facts on each messenger vendor's `health_probe` facet, and one generic prober
 *  reads them. The table below iterates the LIVE registry rather than naming
 *  slack/telegram, so a newly-declared vendor (Teams) is covered here the moment
 *  it is declared — with no edit to this file. That is the property under test. */
/** The auth shape a vendor will actually ACCEPT, derived from its declaration.
 *
 *  ⚠ NOT the fixture default `bearer`. D-238's Teams sends with a bot token and
 *  `enroll` refuses any other credential shape — one would "enroll, report
 *  healthy, and then silently never deliver a message". Two loops hardcoded
 *  `bearer`, which asserted that EVERY vendor accepts bearer; that is now false
 *  and would be false again for the next vendor with its own auth kind.
 *  Deriving it keeps both loops honest as the registry grows.
 *
 *  `token` carries the probe credential into whichever field that shape uses,
 *  so the probe-URL assertion still sees it. */
const messengerAuthFor = (vendor: string, token: string): ConnectionAuth => {
  const declaration = getMessengerVendorDeclaration(vendor)!;
  const [authType] = MESSENGER_AUTH_KIND_CONNECTION_TYPES[declaration.auth];
  if (authType === 'oauth2_refresh') {
    return {
      type: 'oauth2_refresh',
      refresh_token: 'refresh',
      client_id: 'client',
      client_secret: 'secret',
      token_endpoint: 'https://example.test/token',
      current_access_token: token,
    };
  }
  return { type: authType as 'bearer', token };
};

describe('D-192 seam 8 — registry-driven messenger health probes', () => {
  const TOKEN = 'bot-secret-123:AAH';

  it.each(listMessengerVendors().map((v) => [v] as const))(
    'probes %s exactly as its health_probe facet declares',
    async (vendor) => {
      const probeFacet = getMessengerVendorDeclaration(vendor)!.health_probe;
      const name = await enroll('notification', {
        subtype: vendor,
        auth: messengerAuthFor(vendor, TOKEN),
      });
      const fetcher = vi.fn<HttpFetcher>(async () => jsonResponse(200, { ok: true }));

      const health = await probe('notification', name, fetcher);

      expect(health.status).toBe('ok');
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe(
        probeFacet.url.split(MESSENGER_PROBE_TOKEN_PLACEHOLDER).join(TOKEN),
      );
      expect(init?.method).toBe(probeFacet.method);
      // EXHAUSTIVE over the placements, not a binary if/else.
      //
      // This was `if (bearer_header) … else …`, which quietly assumed there would
      // only ever be two. When Discord arrived with `bot_header` it fell into the
      // `else` — the `url_token` branch — and asserted that no Authorization header
      // was sent, on a vendor whose entire credential IS an Authorization header. The
      // it.each above is registry-driven, so it CAUGHT the new vendor for free; the
      // assertion body was the part that had a hand-spelled enumeration hiding in it.
      //
      // A placement with no arm here now fails loudly instead of inheriting whatever
      // the last `else` happened to assert.
      switch (probeFacet.auth) {
        case 'bearer_header':
          // Rides in the header, NEVER in the URL.
          expect(init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
          expect(url).not.toContain(TOKEN);
          break;
        case 'bot_header':
          // ⚠ `Bot`, not `Bearer`. Discord reads `Bearer` as an OAuth2 user token, so
          // the wrong scheme would 401 a perfectly valid bot token — reporting
          // `auth_failed` on a healthy channel, indistinguishable from a revoked one.
          expect(init?.headers?.Authorization).toBe(`Bot ${TOKEN}`);
          expect(url).not.toContain(TOKEN);
          break;
        case 'url_token':
          // Rides in the path and sends NO Authorization header at all.
          expect(init?.headers?.Authorization).toBeUndefined();
          expect(url).toContain(TOKEN);
          break;
        default:
          throw new Error(
            `unhandled health_probe.auth placement '${String(probeFacet.auth)}' — `
            + 'add an arm rather than letting it inherit another placement\'s assertions',
          );
      }
    },
  );

  // RETIRED (D-192 CORE #6 make-live) — 'resolves an oauth2_refresh credential via
  // its access token (an OAuth vendor needs no prober edit)'.
  //
  // It asserted that a `slack` row enrolled with `oauth2_refresh` probes GREEN. It
  // did — and that was the DEFECT, not the feature. The send path could not use
  // that credential and silently dropped every message, so the row sat green,
  // ready, and mute. The claim in the test's own name was half-true in the way that
  // matters least: the PROBER needed no edit, but the SEND path did, and nobody had
  // checked it.
  //
  // The shape also contradicted Slack's own declaration (`auth: 'bot_token'`).
  // Enrollment now enforces that declaration, so the row can no longer exist — see
  // `d-192-messenger-auth-deliverability.test.ts`. Deliberately not restored: it
  // pinned a state that must never be reachable again.

  it('keeps auth_failed (NOT unknown) for a messenger row holding a non-bearer credential', async () => {
    // The enroll gate refuses this shape now, so — like the store-write tests below
    // — the row can only be created directly. The prober's fail-closed floor sits
    // BENEATH that gate and still has to hold. The status is load-bearing
    // downstream: `reasonsFromConnectionHealth` maps `auth_failed` →
    // `permission_revoked` and `unknown` → no reason at all, so reporting `unknown`
    // here would silently drop a degradation signal.
    const name = 'slack-oauth-row';
    store.upsert({
      kind: 'notification',
      name,
      subtype: 'slack',
      display_name: name,
      config_json: '{}',
      auth_ciphertext: await encodeAuthForStorage(
        {
          type: 'oauth2_refresh',
          refresh_token: 'r',
          client_id: 'c',
          token_endpoint: 'https://slack.com/api/oauth.v2.access',
        },
        { kind: 'notification', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).toBe('auth_type_oauth2_refresh');
  });

  it('fails closed on a whitespace-only bearer token instead of probing with a blank credential', async () => {
    // The shared `resolveBearerAccessToken` admits `'   '` (`length > 0`); the
    // `authString` it replaced did not. Enrollment rejects it, so this needs a
    // direct store write — but it must fail closed, not put `Bearer    ` on the
    // wire.
    const name = 'slack-blank-token';
    store.upsert({
      kind: 'notification',
      name,
      subtype: 'slack',
      display_name: name,
      config_json: '{}',
      auth_ciphertext: await encodeAuthForStorage(
        { type: 'bearer', token: '   ' },
        { kind: 'notification', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const fetcher = vi.fn<HttpFetcher>();

    const health = await probe('notification', name, fetcher);

    expect(health.status).toBe('unknown');
    expect(health.last_error).toBe('auth.token_missing');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts a percent-encoded rendering of the credential, not just the raw one', async () => {
    // A token holding URL-significant characters is normalized into the path, so
    // an error echoing the URL carries it ENCODED — a raw-substring scrub alone
    // would miss it.
    const rawToken = 'tok en/with?chars';
    const name = 'telegram-urlish-token';
    store.upsert({
      kind: 'notification',
      name,
      subtype: 'telegram',
      display_name: name,
      config_json: '{}',
      auth_ciphertext: await encodeAuthForStorage(
        { type: 'bearer', token: rawToken },
        { kind: 'notification', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });

    const health = await probe('notification', name, async (url) => {
      // Mimic a fetch error that echoes the NORMALIZED url — this is the exact
      // rendering that leaks: URL normalization escapes the space but leaves `/`
      // and `?` structural, i.e. `encodeURI`, NOT `encodeURIComponent`. Scrubbing
      // only the raw token (or only the fully component-escaped one) would let
      // this through — assert on the rendering that actually appears.
      throw new Error(`request to ${new URL(url).toString()} failed`);
    });
    const leaked = encodeURI(rawToken); // → `tok%20en/with?chars`

    expect(health.status).toBe('unreachable');
    expect(leaked).not.toBe(rawToken); // guard: the fixture must actually re-encode
    expect(health.last_error).not.toContain(rawToken);
    expect(health.last_error).not.toContain(leaked);
    expect(health.last_error).not.toContain(encodeURIComponent(rawToken));
    expect(storedHealth('notification', name).last_error).not.toContain(leaked);
  });

  it('never persists the credential in last_error, even when the token rides in the URL', async () => {
    // Telegram bakes the bot token into the path, so a fetcher/vendor error that
    // echoes the URL would otherwise write the live token into `health_json`
    // (and onto the Settings surface).
    const name = await enroll('notification', {
      subtype: 'telegram',
      auth: { type: 'bearer', token: TOKEN },
    });

    const health = await probe('notification', name, async (url) => {
      throw new Error(`connect ECONNREFUSED for ${url}`);
    });

    expect(health.status).toBe('unreachable');
    expect(health.last_error).not.toContain(TOKEN);
    expect(health.last_error).toContain('***');
    expect(storedHealth('notification', name).last_error).not.toContain(TOKEN);
  });

  it('redacts a credential echoed back in the vendor error envelope too', async () => {
    const name = await enroll('notification', {
      subtype: 'slack',
      auth: { type: 'bearer', token: TOKEN },
    });

    const health = await probe('notification', name, async () =>
      jsonResponse(200, { ok: false, error: `invalid_auth for ${TOKEN}` }),
    );

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).not.toContain(TOKEN);
  });

  it('fails a messenger subtype whose credential carries no bearer token', async () => {
    // Same fail-closed floor, the other undeliverable shape. Enrollment refuses a
    // credential-less chat transport now (a `none` auth cannot send), so the row
    // needs a direct store write — but the prober must still refuse it rather than
    // report a healthy transport that can never deliver.
    const name = 'telegram-no-credential';
    store.upsert({
      kind: 'notification',
      name,
      subtype: 'telegram',
      display_name: name,
      config_json: '{}',
      auth_ciphertext: await encodeAuthForStorage(
        { type: 'none' },
        { kind: 'notification', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('auth_failed');
    expect(health.last_error).toBe('auth_type_none');
  });

  it('surfaces a bearer-shaped credential with an empty token as unknown', async () => {
    // Enrollment already rejects an empty bearer token, so this row can only
    // exist via a direct store write — the branch is defensive, and it holds the
    // pre-registry behavior (`authString` threw; the caller mapped it to
    // `unknown`) rather than probing with an empty credential.
    const name = 'slack-empty-token';
    store.upsert({
      kind: 'notification',
      name,
      subtype: 'slack',
      display_name: name,
      config_json: '{}',
      auth_ciphertext: await encodeAuthForStorage(
        { type: 'bearer', token: '' },
        { kind: 'notification', name },
        getEncryptionKey,
      ),
      enrolled_at: NOW,
      updated_at: NOW,
    });

    const health = await probe('notification', name, async () => {
      throw new Error('should not fetch');
    });

    expect(health.status).toBe('unknown');
    expect(health.last_error).toBe('auth.token_missing');
  });

  it('enrolls every declared messenger vendor (the subtype gate reads the registry)', async () => {
    // If a vendor were declared but not enrollable, its `health_probe` facet
    // would be unreachable — the enrollment gate is the other half of seam 8.
    for (const vendor of listMessengerVendors()) {
      // ⚠ Per-vendor, derived — see `messengerAuthFor`.
      const auth = messengerAuthFor(vendor, 'secret');
      await expect(
        enroll('notification', { name: `enroll-${vendor}`, subtype: vendor, auth }),
      ).resolves.toBe(`enroll-${vendor}`);
    }
  });

  it('still rejects an undeclared notification subtype', async () => {
    // ⚠ The fixture was the literal `whatsapp` — a vendor that did not exist yet.
    // The day it shipped, this stopped asserting "an undeclared subtype is refused"
    // and started asserting that a REAL one was. Name something that can never be a
    // chat transport instead.
    await expect(
      enroll('notification', { name: 'nope', subtype: 'not_a_transport' }),
    ).rejects.toThrow(/subtype/i);
  });
});

/** HubSpot as measured 2026-10-08: its API ROOT answers 302 whatever the
 *  credential — a working key, a wrong key, no key — while
 *  `/account-info/v3/details` answers 200 to a working key and 401 otherwise.
 *  The generic HEAD-root probe therefore passed every Service Key, and
 *  rotation refused every replacement (its invalid control key passed too).
 *  This double answers by URL AND credential, so it can refuse. */
const hubspotLike = (workingKeys: readonly string[]) => vi.fn<HttpFetcher>(async (url, init) => {
  const authorization = init?.headers?.Authorization;
  if (url === 'https://api.hubapi.com/') return jsonResponse(302);
  if (url === 'https://api.hubapi.com/account-info/v3/details') {
    return workingKeys.some((key) => authorization === `Bearer ${key}`)
      ? jsonResponse(200, { portalId: 245836902 })
      : jsonResponse(401);
  }
  return jsonResponse(404);
});

const HUBSPOT_CONFIG = { base_url: 'https://api.hubapi.com', vendor: 'hubspot' };

describe('a HubSpot connection is checked with a read that needs the key', () => {
  it('passes a working Service Key and fails a wrong one, which the root passes alike', async () => {
    const fetcher = hubspotLike(['pat-working']);
    const working = await enroll('api', {
      name: 'hubspot-working',
      config: HUBSPOT_CONFIG,
      auth: { type: 'bearer', token: 'pat-working' },
    });
    const mistyped = await enroll('api', {
      name: 'hubspot-mistyped',
      config: HUBSPOT_CONFIG,
      auth: { type: 'bearer', token: 'pat-mistyped' },
    });

    expect(await probe('api', working, fetcher)).toMatchObject({ status: 'ok' });
    const health = await probe('api', mistyped, fetcher);
    expect(health.status).toBe('auth_failed');
    expect(health.last_error).toBe('http_status_401');
    expect(storedHealth('api', mistyped).status).toBe('auth_failed');
    // Both checks were the authenticated read, as a GET — never the root.
    expect(fetcher.mock.calls.map(([url, init]) => `${String(init?.method)} ${url}`)).toEqual([
      'GET https://api.hubapi.com/account-info/v3/details',
      'GET https://api.hubapi.com/account-info/v3/details',
    ]);
  });

  it('an api connection that names no such vendor still probes its root', async () => {
    const fetcher = hubspotLike([]);
    const name = await enroll('api', {
      name: 'hubspot-by-hand',
      config: { base_url: 'https://api.hubapi.com' },
      auth: { type: 'bearer', token: 'pat-anything' },
    });

    // The root's 302 reads as healthy: this is the vacuous check the vendor
    // entry replaces, kept for an api form that does not say it is HubSpot.
    expect(await probe('api', name, fetcher)).toMatchObject({ status: 'ok' });
    expect(fetcher.mock.calls.map(([url, init]) => `${String(init?.method)} ${url}`)).toEqual([
      'HEAD https://api.hubapi.com/',
    ]);
  });

  it('lets the owner replace a HubSpot Service Key, as HubSpot asks every six months', async () => {
    const name = await enroll('api', {
      name: 'hubspot-rotate',
      config: HUBSPOT_CONFIG,
      auth: { type: 'bearer', token: 'pat-old' },
    });
    const before = store.get('api', name)!;
    const fetcher = hubspotLike(['pat-old', 'pat-new']);

    const result = await handleConnectionRotateCredentials(
      { store, now: () => NOW + 2_000, getEncryptionKey, fetcher },
      {
        attempt_id: 'rotation-attempt-hubspot-0001',
        name,
        kind: 'api',
        expected_updated_at: before.updated_at,
        patch: { auth: { type: 'bearer', token: 'pat-new' } },
      },
    );

    expect(result.verification).toMatchObject({ status: 'verified', auth_type: 'bearer' });
    // The invalid control key was asked too, and refused.
    expect(fetcher.mock.calls.some(([, init]) =>
      init?.headers?.Authorization === 'Bearer recued-intentionally-invalid-credential')).toBe(true);
    expect(await decodeAuthFromStorage(
      store.get('api', name)!.auth_ciphertext,
      { kind: 'api', name },
      getEncryptionKey,
    )).toEqual({ type: 'bearer', token: 'pat-new' });
  });
});
