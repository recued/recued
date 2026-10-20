import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { cacheKey, createInMemoryStore, wrapStoreWithPeer, type CacheStore } from '@recued/cache';
import { CONNECTION_MCP_READ_SLUG, RpcError, type CacheEntry, type ConnectionRow,
  type IngredientManifest, type McpTransport, type OperationRiskTier } from '@recued/contracts';
import { createConnectionMcpHandler, type ConnectionMcpHandlerDeps, type McpStreamHandle } from '@recued/ingredients';
import { createConnectionStore } from '../storage/connection-store.js';
import { createSQLiteCacheStore } from '../storage/index.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createBoundExecutor, createNamespaceStores } from '../server-executor.js';
import { createConnectionMcpClassificationGate } from '../connection-mcp-gate.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const manifest: IngredientManifest = { slug: CONNECTION_MCP_READ_SLUG, version: 1,
  name: 'Fixture MCP read', description: '', author: 'recued',
  kind: 'connection', category: 'data', risk_tier: 'read',
  input: { connection_kind: 'mcp', connection: '{{config.mcp_connection}}', tool: 'lookup', args: { id: '42' } }, output: {} };
type Frame = { id?: number; method: string; params?: { arguments?: Record<string, unknown> } };

const fixture = (transport: McpTransport = 'sse', legacyHttp = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-account-cache-'));
  const executable = join(dir, 'fixture-mcp');
  // Only fingerprinted. The injected stream below never executes a program.
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const file = join(dir, 'realm.sqlite');
  let db = new Database(file);
  let connections = createConnectionStore(db);
  let cache = createSQLiteCacheStore(db, createBlobStore(join(dir, 'blobs')));
  const config = transport === 'stdio' ? { transport, command: executable, args: [], env: { FIXTURE: 'yes' } }
    : { transport, endpoint: `${transport === 'websocket' ? 'wss' : 'https'}://mcp.example.test/server` };
  connections.upsert({ kind: 'mcp', name: 'workspace', display_name: 'Workspace',
    config_json: JSON.stringify(config), auth_ciphertext: 'account-a', enrolled_at: 1, updated_at: 1,
    health_json: JSON.stringify({ tools: ['lookup'], mcp_tool_schemas: { lookup: { type: 'object', properties: {} } } }) });
  const manifests = createManifestRegistry('/nonexistent'); manifests.register(manifest);
  const tiers = new Map<string, OperationRiskTier>([['lookup', 'read']]);
  const gate = createConnectionMcpClassificationGate({ resolveToolTiers: () => tiers });
  const operations: Array<{ method: string; account: string; args: unknown }> = [];
  let afterDiscovery: (() => void) | undefined;
  let closed = 0;
  const reply = (frame: Frame, account: string) => {
    if (frame.method === 'server/discover') {
      afterDiscovery?.();
      return { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } };
    }
    if (frame.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: {},
      serverInfo: { name: 'fixture', version: '1' } };
    operations.push({ method: frame.method, account, args: frame.params?.arguments });
    return { account, args: frame.params?.arguments ?? null };
  };
  const stream = (account: string): McpStreamHandle => {
    let message: ((data: string) => void) | undefined;
    let isClosed = false;
    return {
      send: data => {
        const frame = JSON.parse(data) as Frame;
        if (frame.id === undefined) return;
        queueMicrotask(() => {
          if (!isClosed) message?.(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: reply(frame, account) }));
        });
      },
      onMessage: listener => { message = listener; },
      onClose: () => {}, onError: () => {},
      close: () => { if (!isClosed) closed += 1; isClosed = true; },
    };
  };
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const frame = JSON.parse(String(init?.body)) as Frame;
    const headers = new Headers(init?.headers);
    const account = headers.get('authorization')!;
    if (legacyHttp && frame.method === 'server/discover') return new Response(JSON.stringify({
      jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' },
    }), { headers: { 'content-type': 'application/json' } });
    if (legacyHttp && frame.method === 'initialize') return new Response(JSON.stringify({
      jsonrpc: '2.0', id: frame.id, result: { protocolVersion: '2025-06-18', capabilities: {},
        serverInfo: { name: 'fixture', version: '1' } },
    }), { headers: { 'content-type': 'application/json', 'Mcp-Session-Id': account } });
    if (frame.id === undefined) return new Response(null, { status: 202 });
    const sessionAccount = legacyHttp ? headers.get('Mcp-Session-Id') ?? account : account;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: reply(frame, sessionAccount) }),
      { headers: { 'content-type': 'application/json' } });
  });
  const mcp: ConnectionMcpHandlerDeps = {
    decodeAuth: vi.fn(async row => ({ type: 'bearer' as const, token: row.auth_ciphertext })),
    persistAuth: async () => {}, fetchImpl,
    wsConnect: vi.fn(async (_url, options) => stream(new Headers(options.headers).get('authorization')!)),
    spawnStdioMcp: vi.fn(async () => stream(`Bearer ${connections.get('mcp', 'workspace')!.auth_ciphertext}`)),
  };
  const statuses: string[] = [];
  const executor = (store: CacheStore = cache, recipe_id = 'mcp-fixture') => createBoundExecutor({
    manifests, connectionStore: connections, connectionMcp: mcp,
    connectionGateDispatch: gate, cacheStore: store, instanceId: 'fixture',
  }, createNamespaceStores({}, { mcp_connection: 'workspace' }, {}), { recipe_id, recipe_ttl: 300 },
  status => statuses.push(status));
  const run = (store?: CacheStore, recipe_id?: string, freshness?: 'any' | 'fresh') =>
    executor(store, recipe_id)(manifest.slug, {}, undefined, freshness ? { cache: freshness } : undefined);
  const current = () => connections.get('mcp', 'workspace')!;
  const replace = (change: Partial<ConnectionRow> = { auth_ciphertext: 'account-b' }) => connections.upsert({ ...current(), ...change });
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { run, executor, mcp, manifests, tiers, gate, operations, statuses, fetchImpl,
    replace, current, executable, closed: () => closed, cache: () => cache, connections: () => connections,
    afterDiscovery: (callback: () => void) => { afterDiscovery = callback; },
    reopen: () => {
      db.close(); db = new Database(file); connections = createConnectionStore(db);
      cache = createSQLiteCacheStore(db, createBlobStore(join(dir, 'blobs')));
    } };
};

describe('MCP cache account identity', () => {
  it('keeps recipe-level replay from bypassing the account-scoped cache', async () => {
    const f = fixture(); const recipes = createRecipeStore('/nonexistent');
    recipes.register({ recipe_id: 'mcp-account-read', version: 1, ttl: 300, variables: { mcp_connection: 'workspace' },
      metadata: { name: 'MCP read', description: 'Read a record with its enrolled MCP account.', author: 'fixture', supported_platforms: [] },
      requires: [manifest.slug], prefetch_steps: [], steps: [{ id: 'read', ingredient: manifest.slug, input: {} }],
      output: { render: [{ type: 'json', source: 'step.read.result' }] } });
    const deps: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, connectionStore: f.connections(),
      executorConfig: { manifests: f.manifests, connectionStore: f.connections(), connectionMcp: f.mcp,
        connectionGateDispatch: f.gate, cacheStore: f.cache(), instanceId: 'fixture' } };
    const run = () => handleExecute(deps, { recipe_id: 'mcp-account-read',
      execution_source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'fixture' } });
    const initial = await run(); expect(initial.success, JSON.stringify(initial.errors)).toBe(true);
    expect(initial.output.render[0]?.data).toMatchObject({ account: 'Bearer account-a' });
    f.replace();
    const next = await run(); expect(next.success, JSON.stringify(next.errors)).toBe(true);
    expect(next.output.render[0]?.data).toMatchObject({ account: 'Bearer account-b' });
    expect(f.operations).toHaveLength(2);
  });

  it.each(['sse', 'websocket', 'stdio'] as const)('isolates replacements with a warm %s session', async transport => {
    const f = fixture(transport); const bound = f.executor();
    expect(await bound(manifest.slug, {})).toMatchObject({ result: { account: 'Bearer account-a' } });
    await bound(manifest.slug, {});
    f.replace();
    expect(await bound(manifest.slug, {})).toMatchObject({ result: { account: 'Bearer account-b' } });
    await bound(manifest.slug, {});
    expect(f.operations).toHaveLength(2);
    expect(f.statuses).toEqual(['miss', 'hit', 'miss', 'hit']);
    if (transport !== 'sse') expect(f.closed()).toBe(1);
  });

  it('reopens a legacy HTTP session after replacement at the same endpoint', async () => {
    const f = fixture('sse', true); const bound = f.executor();
    await bound(manifest.slug, {}); f.replace();
    expect(await bound(manifest.slug, {})).toMatchObject({ result: { account: 'Bearer account-b' } });
    const calls = f.fetchImpl.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).method === 'tools/call');
    expect(calls).toHaveLength(2);
    expect(calls.map(([, init]) => new Headers(init?.headers).get('Mcp-Session-Id')))
      .toEqual(['Bearer account-a', 'Bearer account-b']);
  });

  it('shares unchanged accounts across recipes and SQLite restart', async () => {
    const f = fixture(); await f.run(); await f.run(undefined, 'other-recipe');
    f.reopen(); await f.run();
    expect(f.operations).toHaveLength(1);
    expect(f.statuses).toEqual(['miss', 'hit', 'hit']);
  });

  it.each([{ resource: 'fixture:///document' }, { resources_list: true }])('scopes resource reads: %j', async input => {
    const f = fixture();
    const resource = { ...manifest, slug: 'fixture-mcp-resource-read', input: {
      connection_kind: 'mcp', connection: '{{config.mcp_connection}}', ...input } };
    f.manifests.register(resource); const bound = f.executor();
    await bound(resource.slug, {}); await bound(resource.slug, {});
    f.replace();
    expect(await bound(resource.slug, {})).toMatchObject({ result: { account: 'Bearer account-b' } });
    expect(f.operations).toHaveLength(2);
  });

  it('leaves writes and explicitly fresh reads uncached', async () => {
    const f = fixture(); const get = vi.spyOn(f.cache(), 'get'); const set = vi.spyOn(f.cache(), 'set');
    await f.run(undefined, undefined, 'fresh'); await f.run(undefined, undefined, 'fresh');
    const write: IngredientManifest = { ...manifest, slug: 'fixture-mcp-write', category: 'action', risk_tier: 'write' };
    f.manifests.register(write); const bound = f.executor();
    await bound(write.slug, {}); await bound(write.slug, {});
    expect(f.operations).toHaveLength(4);
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });

  it.each(['sse', 'websocket', 'stdio'] as const)('preserves %s hits through trusted renewal and routine health changes', async transport => {
    const f = fixture(transport); await f.run();
    expect(f.connections().persistRefreshedAuth?.(f.current(), 'renewed-token', 2)).toBe(true);
    const health = JSON.parse(f.current().health_json!);
    f.replace({ display_name: 'Renamed', last_used_at: 5, updated_at: 6,
      health_json: JSON.stringify({ ...health, status: 'ok', last_probed_at: 6 }) });
    await f.run();
    expect(f.operations).toHaveLength(1);
    expect(f.statuses).toEqual(['miss', 'hit']);
  });

  it.each<Partial<ConnectionRow>>([{ enrolled_at: 2 }, { subresource_path: '/other' },
    { granted_scopes_json: '["read"]' }, { config_json: '{"transport":"sse","endpoint":"https://other.example.test/mcp"}' }])(
    'misses after enrollment, endpoint or scope changes: %j', async change => {
      const f = fixture(); await f.run(); f.replace(change); await f.run();
      expect(f.operations).toHaveLength(2); expect(f.statuses).toEqual(['miss', 'miss']);
    });

  it('does not reuse a tool result after its cached definition changes', async () => {
    const f = fixture(); await f.run();
    const health = JSON.parse(f.current().health_json!);
    health.mcp_tool_schemas.lookup.properties.id = { type: 'string' };
    f.replace({ health_json: JSON.stringify(health) }); await f.run();
    expect(f.operations).toHaveLength(2);
    health.tools = ['other']; f.replace({ health_json: JSON.stringify(health) });
    await expect(f.run()).rejects.toMatchObject({ code: 'MCP_TOOL_NOT_FOUND' });
    expect(f.operations).toHaveLength(2);
  });

  it.each(['before', 'during'] as const)('rechecks live tool permissions %s a cache lookup', async when => {
    const f = fixture(); await f.run();
    const change = () => { f.tiers.set('lookup', 'write'); };
    if (when === 'before') change();
    else {
      const get = f.cache().get.bind(f.cache());
      vi.spyOn(f.cache(), 'get').mockImplementationOnce(async key => { const entry = await get(key); change(); return entry; });
    }
    await expect(f.run()).rejects.toMatchObject({ code: 'MCP_TOOL_NOT_CLASSIFIED' });
    expect(f.operations).toHaveLength(1);
  });

  it('never replays an unscoped entry, including any freshness', async () => {
    const f = fixture(); const key = await cacheKey({ ingredient_slug: manifest.slug, manifest_version: '1',
      inputs: { ...manifest.input, connection: 'workspace' } });
    await f.cache().set({ key, value: { result: { account: 'legacy' } }, recipe_id: 'old', ingredient_slug: manifest.slug,
      category: 'data', risk_tier: 'read', created_at: 1, last_accessed_at: 1, expires_at: 2, size_bytes: 1 });
    expect(await f.run(undefined, undefined, 'any')).toMatchObject({ result: { account: 'Bearer account-a' } });
    expect(f.operations).toHaveLength(1);
  });

  it('cannot replay a cached result after account deletion', async () => {
    const f = fixture(); await f.run(); f.connections().delete('mcp', 'workspace');
    await expect(f.run()).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    expect(f.operations).toHaveLength(1);
  });

  it.each(['get', 'touch', 'set'] as const)('refuses account drift across asynchronous cache %s', async method => {
    const f = fixture(); if (method !== 'set') await f.run();
    const cache = f.cache(); const original = cache[method]!.bind(cache);
    vi.spyOn(cache, method).mockImplementationOnce((async (...args: never[]) => {
      const result = await (original as (...args: never[]) => Promise<unknown>)(...args);
      f.replace(); return result;
    }) as never);
    await expect(f.run()).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    expect(f.operations).toHaveLength(1);
    expect(await f.run()).toMatchObject({ result: { account: 'Bearer account-b' } });
  });

  it.each(['sse', 'websocket'] as const)('refuses drift during %s credential decode before opening a connection', async transport => {
    const f = fixture(transport);
    vi.spyOn(f.mcp, 'decodeAuth').mockImplementationOnce(async row => {
      f.replace(); return { type: 'bearer', token: row.auth_ciphertext };
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'CONNECTION_REFUSED', details: { reason: 'connection_changed' } });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.mcp.wsConnect).not.toHaveBeenCalled();
    expect(f.operations).toHaveLength(0);
  });

  it.each(['sse', 'websocket', 'stdio'] as const)('refuses drift during %s negotiation before any operation', async transport => {
    const f = fixture(transport); f.afterDiscovery(() => f.replace());
    await expect(f.run()).rejects.toThrow('account changed');
    expect(f.operations).toHaveLength(0);
  });

  it('validates the actual asynchronous store row before stdio setup', async () => {
    const f = fixture('stdio'); let obsolete = false;
    const bound = createBoundExecutor({ manifests: f.manifests,
      connectionStore: { get: async (kind, name) => {
        const row = f.connections().get(kind, name);
        if (obsolete) { obsolete = false; return { ...row!, config_json: '{"command":"wrong-program","transport":"stdio"}' }; }
        return row;
      } }, connectionMcp: f.mcp, connectionGateDispatch: f.gate, cacheStore: f.cache(), instanceId: 'fixture' },
    createNamespaceStores({}, { mcp_connection: 'workspace' }, {}), { recipe_id: 'async-mcp', recipe_ttl: 300 },
    status => { if (status === 'miss') obsolete = true; });
    await expect(bound(manifest.slug, {})).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    expect(f.mcp.spawnStdioMcp).not.toHaveBeenCalled();
  });

  it('refuses obsolete tool header metadata returned by an asynchronous store', async () => {
    const f = fixture(); let obsolete = false;
    const bound = createBoundExecutor({ manifests: f.manifests,
      connectionStore: { get: async (kind, name) => {
        const row = f.connections().get(kind, name);
        if (!obsolete) return row;
        obsolete = false;
        return { ...row!, health_json: JSON.stringify({ tools: ['lookup'], mcp_tool_schemas: {
          lookup: { type: 'object', properties: { id: { type: 'string', 'x-mcp-header': 'Obsolete-Id' } } },
        } }) };
      } }, connectionMcp: f.mcp, connectionGateDispatch: f.gate, cacheStore: f.cache(), instanceId: 'fixture' },
    createNamespaceStores({}, { mcp_connection: 'workspace' }, {}), { recipe_id: 'stale-metadata', recipe_ttl: 300 },
    status => { if (status === 'miss') obsolete = true; });
    await expect(bound(manifest.slug, {})).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['sse', 'websocket', 'stdio'] as const)('preserves the page account fence during %s setup and operation admission', async transport => {
    const phases = transport === 'stdio' ? ['beforeConnect', 'beforeRequest'] as const
      : ['beforeConnect', 'beforeRequest', 'decodeAuth'] as const;
    for (const phase of phases) {
      const f = fixture(transport); let changed = false;
      if (phase === 'decodeAuth') f.mcp.decodeAuth = async row => {
        changed = true; return { type: 'bearer', token: row.auth_ciphertext };
      };
      else f.mcp[phase] = async () => { changed = true; };
      const write: IngredientManifest = { ...manifest, slug: 'fixture-mcp-write', category: 'action', risk_tier: 'write' };
      f.manifests.register(write);
      const bound = createBoundExecutor({ manifests: f.manifests, connectionStore: f.connections(), connectionMcp: f.mcp,
        connectionGateDispatch: f.gate, cacheStore: f.cache(), instanceId: 'fixture' },
      createNamespaceStores({}, { mcp_connection: 'workspace' }, {}), { recipe_id: 'page-fence', recipe_ttl: 300 },
      undefined, undefined, () => { if (changed) throw new RpcError('connection_changed', 'page account changed', 409); });
      await expect(bound(write.slug, {})).rejects.toMatchObject({ code: 'connection_changed' });
      expect(f.operations, `${transport} ${phase}`).toHaveLength(0);
      if (phase === 'beforeConnect') {
        expect(f.fetchImpl).not.toHaveBeenCalled();
        expect(f.mcp.wsConnect).not.toHaveBeenCalled();
        expect(f.mcp.spawnStdioMcp).not.toHaveBeenCalled();
      }
    }
  });

  it('does not dispatch changed argument references under a captured key', async () => {
    const f = fixture(); const config = { mcp_connection: 'workspace', record_id: '42' };
    f.manifests.register({ ...manifest, input: { ...manifest.input, args: { id: '{{config.record_id}}' } } });
    const get = f.cache().get.bind(f.cache());
    vi.spyOn(f.cache(), 'get').mockImplementationOnce(async key => {
      const entry = await get(key); config.record_id = '99'; return entry;
    });
    const bound = createBoundExecutor({ manifests: f.manifests, connectionStore: f.connections(), connectionMcp: f.mcp,
      connectionGateDispatch: f.gate, cacheStore: f.cache(), instanceId: 'fixture' }, createNamespaceStores({}, config, {}),
    { recipe_id: 'mutable-args', recipe_ttl: 300 });
    await expect(bound(manifest.slug, {})).rejects.toMatchObject({ details: { reason: 'cache_input_changed' } });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('invalidates a stdio cache entry and child after the installed executable changes', async () => {
    const f = fixture('stdio'); const bound = f.executor(); await bound(manifest.slug, {});
    writeFileSync(f.executable, '#!/bin/sh\n# changed fixture\nexit 0\n');
    await bound(manifest.slug, {});
    expect(f.operations).toHaveLength(2);
    expect(f.mcp.spawnStdioMcp).toHaveBeenCalledTimes(2);
    expect(f.closed()).toBe(1);
  });

  it('reuses the same stdio child across different request arguments', async () => {
    const f = fixture('stdio'); const bound = f.executor();
    await bound(manifest.slug, { args: { id: '42' } });
    await bound(manifest.slug, { args: { id: '99' } });
    expect(f.operations).toHaveLength(2);
    expect(f.mcp.spawnStdioMcp).toHaveBeenCalledOnce();
    expect(f.closed()).toBe(0);
  });

  it.each([['websocket', 'websocket'], ['stdio', 'stdio'], ['websocket', 'sse'], ['stdio', 'sse']] as const)(
    'discards a superseded %s open without closing its %s replacement', async (transport, replacement) => {
    const f = fixture(transport); const handler = createConnectionMcpHandler(f.mcp);
    let ready!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    if (transport === 'websocket') {
      const connect = vi.mocked(f.mcp.wsConnect!).getMockImplementation()!;
      vi.spyOn(f.mcp, 'wsConnect').mockImplementationOnce(async (...args) => {
        const handle = await connect(...args); ready(); await held; return handle;
      });
    } else {
      const spawn = vi.mocked(f.mcp.spawnStdioMcp!).getMockImplementation()!;
      vi.spyOn(f.mcp, 'spawnStdioMcp').mockImplementationOnce(async (...args) => {
        const handle = await spawn(...args); ready(); await held; return handle;
      });
    }
    const call = { slug: manifest.slug, input: {}, output: {}, risk_tier: 'read' };
    const old = handler(f.current(), { tool: 'lookup' }, call).then(value => ({ value }), error => ({ error }));
    try {
      await started; f.replace({ auth_ciphertext: 'account-b', ...(replacement === 'sse'
        ? { config_json: '{"transport":"sse","endpoint":"https://mcp.example.test/server"}' } : {}) });
      expect(await handler(f.current(), { tool: 'lookup' }, call)).toMatchObject({ result: { account: 'Bearer account-b' } });
    } finally { release(); }
    expect(await old).toMatchObject({ error: { code: 'CONNECTION_REFUSED' } });
    await handler(f.current(), { tool: 'lookup' }, call);
    expect(f.closed()).toBe(1);
    expect(transport === 'websocket' ? f.mcp.wsConnect : f.mcp.spawnStdioMcp)
      .toHaveBeenCalledTimes(replacement === 'sse' ? 1 : 2);
    if (replacement === 'sse') expect(f.fetchImpl.mock.calls.filter(([, init]) =>
      JSON.parse(String(init?.body)).method === 'server/discover')).toHaveLength(1);
    expect(f.operations.every(op => op.account === 'Bearer account-b')).toBe(true);
  });

  it('closes a superseded legacy SSE stream after its delayed initialization', async () => {
    const f = fixture(); const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const signals = new Map<string, AbortSignal>(); const delivered: string[] = [];
    let refuseOperation = false;
    let ready!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const encoder = new TextEncoder();
    cleanups.push(() => { for (const controller of streams.values()) { try { controller.close(); } catch {} } });
    const fetchImpl: typeof fetch = async (url, init) => {
      const account = new Headers(init?.headers).get('authorization')!;
      if (init?.method === 'GET') {
        signals.set(account, init.signal!);
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          streams.set(account, controller);
          init.signal!.addEventListener('abort', () => { try { controller.close(); } catch {} });
          controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'));
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      const frame = JSON.parse(String(init?.body)) as Frame;
      if (new URL(String(url)).pathname !== '/messages') return new Response(JSON.stringify({
        jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' },
      }), { headers: { 'content-type': 'application/json' } });
      if (frame.id === undefined) return new Response(null, { status: 202 });
      if (frame.method === 'tools/call' && refuseOperation) throw new RpcError('connection_changed', 'page account changed', 409);
      const answer = () => {
        const result = frame.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
          : { account };
        streams.get(account)!.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n\n`));
      };
      if (frame.method === 'initialize' && account === 'Bearer account-a') { release = answer; ready(); }
      else { if (frame.method === 'tools/call') delivered.push(account); answer(); }
      return new Response(null, { status: 202 });
    };
    const handler = createConnectionMcpHandler({ ...f.mcp, fetchImpl });
    const call = { slug: manifest.slug, input: {}, output: {}, risk_tier: 'read' };
    const old = handler(f.current(), { tool: 'lookup' }, call).then(value => ({ value }), error => ({ error }));
    try {
      await started; f.replace();
      expect(await handler(f.current(), { tool: 'lookup' }, call)).toMatchObject({ result: { account: 'Bearer account-b' } });
    } finally { release?.(); }
    expect(await old).toMatchObject({ error: { code: 'CONNECTION_REFUSED' } });
    expect(signals.get('Bearer account-a')?.aborted).toBe(true);
    expect(delivered).toEqual(['Bearer account-b']);
    refuseOperation = true;
    await expect(handler(f.current(), { tool: 'lookup' }, { ...call, risk_tier: 'write' }))
      .rejects.toMatchObject({ code: 'connection_changed' });
    expect(delivered).toEqual(['Bearer account-b']);
  });

  it('shares concurrent HTTP negotiation for the same account', async () => {
    const f = fixture('sse', true); const fetch = f.fetchImpl.getMockImplementation()!;
    let ready!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.fetchImpl.mockImplementationOnce(async (...args) => { ready(); await held; return fetch(...args); });
    const handler = createConnectionMcpHandler(f.mcp);
    const call = { slug: manifest.slug, input: {}, output: {}, risk_tier: 'read' };
    const first = handler(f.current(), { tool: 'lookup' }, call);
    await started;
    const second = handler(f.current(), { tool: 'lookup' }, call);
    await new Promise<void>(resolve => setImmediate(resolve));
    release(); await Promise.all([first, second]);
    const initializations = f.fetchImpl.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).method === 'initialize');
    expect(initializations).toHaveLength(1);
    expect(f.operations).toHaveLength(2);
  });

  it('bypasses caching when a stdio launcher cannot be fingerprinted', async () => {
    const f = fixture('stdio'); f.replace({ config_json: '{"transport":"stdio","command":"npx","args":["fixture"]}' });
    const get = vi.spyOn(f.cache(), 'get'); const set = vi.spyOn(f.cache(), 'set');
    await f.run(); await f.run();
    expect(f.operations).toHaveLength(2);
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    expect(f.statuses).toEqual(['skipped', 'skipped']);
  });

  it.each([false, true])('isolates peer entries from a previous account (misrouted=%s)', async misrouted => {
    const f = fixture(); const entries = new Map<string, CacheEntry>(); const requested: string[] = [];
    let original: CacheEntry | undefined;
    const peer = wrapStoreWithPeer(createInMemoryStore(), { transport: {
      connected: () => true, getEntry: async key => {
        requested.push(key); return misrouted && original ? original : entries.get(key) ?? null;
      }, putEntries: async () => {}, getSince: async () => ({ entries: [], next_cursor: null }),
    }, setTimer: () => () => {} });
    const set = vi.spyOn(peer, 'set'); await f.run(peer);
    original = set.mock.calls[0]![0]; entries.set(original.key, original);
    f.replace(); expect(await f.run(peer)).toMatchObject({ result: { account: 'Bearer account-b' } });
    expect(requested[0]).not.toBe(requested[1]);
    expect(requested.every(key => key.startsWith('v2:') && !key.includes('account-'))).toBe(true);
    expect(f.operations).toHaveLength(2);
  });
});
