import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createInMemoryStore, wrapStoreWithPeer, type CacheStore } from '@recued/cache';
import { CHUNKED_UPLOAD_WIRE_WALK_KEY, type CacheEntry, type ConnectionAuth, type ChunkedUploadSpec, type IngredientManifest, type McpTransport, type RecipeDefinition, type StepMeta } from '@recued/contracts';
import { IngredientError, type ConnectionApiHandlerDeps, type ConnectionMcpHandlerDeps, type McpStreamHandle, type ResolvedCall } from '@recued/ingredients';
import { createConnectionStore } from '../storage/connection-store.js';
import { createSQLiteCacheStore } from '../storage/index.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createBoundExecutor, createNamespaceStores, createServerExecutor, type ServerExecutorConfig } from '../server-executor.js';
import { withPreapprovalOrdinaryGuard } from '../preapproval-io-context.js';
import { connectionIdentity, connectionRevision, connectionRevisionGuard } from '../connection-revision.js';
import { createRecipeStore } from '../recipe-store.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) close(); });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
type Frame = { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
const exitedOwner = () => {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.error || child.status !== 0) throw new Error('Fixture child did not exit cleanly');
  return `${child.pid}:interrupted`;
};
type Outcome = 'ok' | 'reject' | 'uncertain' | 'partial_error';
const fixture = (kind: 'api' | 'mcp', transport: McpTransport = 'sse') => {
  const dir = mkdtempSync(join(tmpdir(), 'connection-write-cache-'));
  const executable = join(dir, 'fixture-mcp');
  // Fingerprinted only; the injected stream never launches this file.
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const file = join(dir, 'realm.sqlite');
  let db = new Database(file);
  let connections = createConnectionStore(db);
  let cache = createSQLiteCacheStore(db, createBlobStore(join(dir, 'blobs')));
  for (const name of ['sales', 'personal']) connections.upsert({ kind, name, display_name: name,
    auth_ciphertext: name, enrolled_at: 1, updated_at: 1,
    config_json: JSON.stringify(kind === 'api' ? { vendor: 'hubspot', base_url: 'https://api.example.test' }
      : transport === 'stdio' ? { transport, command: executable, args: [], env: { FIXTURE_ACCOUNT: name } }
        : { transport, endpoint: `${transport === 'websocket' ? 'wss' : 'https'}://mcp.example.test/server` }),
    ...(kind === 'mcp' ? { health_json: JSON.stringify({ tools: ['lookup', 'change'],
      mcp_tool_schemas: { lookup: { type: 'object', properties: {} }, change: { type: 'object', properties: {} } } }) } : {}),
  });
  const read: IngredientManifest = { slug: `fixture-${kind}-read`, version: 1, name: 'Read', description: '', author: 'fixture',
    kind: 'connection', category: 'data', risk_tier: 'read', input: { connection_kind: kind, connection: 'sales',
      ...(kind === 'api' ? { method: 'GET', path: '/contacts/42' } : { tool: 'lookup', args: {} }) }, output: {} };
  const write: IngredientManifest = { ...read, slug: `fixture-${kind}-write`, category: 'action', risk_tier: 'write',
    input: { ...read.input, ...(kind === 'api' ? { method: 'POST' } : { tool: 'change' }) } };
  const manifests = createManifestRegistry('/nonexistent'); manifests.register(read); manifests.register(write);
  const versions = new Map([['sales', 0], ['personal', 0]]);
  const requests: Array<{ name: string; writes: boolean }> = [];
  let outcome: Outcome = 'ok';
  let observeRequest: ((writes: boolean) => void) | undefined;
  const writePauses: Array<{ started(): void; wait: Promise<void> }> = [];
  let readPause: Promise<void> | undefined;
  let readStarted = deferred();
  const operation = async (name: string, writes: boolean) => {
    observeRequest?.(writes);
    requests.push({ name, writes });
    if (writes) {
      const pause = writePauses.shift(); pause?.started(); await pause?.wait;
      if (outcome === 'reject') return { rejected: true };
      versions.set(name, versions.get(name)! + 1);
      if (outcome === 'partial_error') return { rejected: true };
      if (outcome === 'uncertain') throw new Error('Fixture dropped an acknowledged write response');
    }
    const result = { version: versions.get(name)! };
    if (!writes) { readStarted.resolve(); await readPause; }
    return result;
  };
  const reply = async (frame: Frame, name: string) => {
    if (frame.method === 'server/discover') return { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } };
    if (frame.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } };
    const result = await operation(name, frame.method === 'tools/call' && frame.params?.name === 'change');
    return 'rejected' in result ? { isError: true, content: [{ type: 'text', text: 'Refused by fixture' }] } : result;
  };
  const stream = (name: string): McpStreamHandle => {
    let onMessage: ((data: string) => void) | undefined;
    let closed = false;
    const handle: McpStreamHandle = {
      send: data => {
        const frame = JSON.parse(data) as Frame;
        if (frame.id === undefined) return;
        void reply(frame, name).then(result => {
          if (!closed) onMessage?.(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
        });
      },
      onMessage: listener => { onMessage = listener; }, onClose: () => {}, onError: () => {},
      close: () => { closed = true; },
    };
    cleanups.push(() => handle.close());
    return handle;
  };
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const name = new Headers(init?.headers).get('authorization')!.replace(/^Bearer /, '');
    if (kind === 'api') {
      const result = await operation(name, init?.method !== 'GET');
      return new Response(JSON.stringify(result), { status: 'rejected' in result ? 403 : 200,
        headers: { 'content-type': 'application/json' } });
    }
    const frame = JSON.parse(String(init?.body)) as Frame;
    if (frame.id === undefined) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: await reply(frame, name) }),
      { headers: { 'content-type': 'application/json' } });
  });
  const mcp: ConnectionMcpHandlerDeps = {
    decodeAuth: async row => ({ type: 'bearer', token: row.auth_ciphertext }), persistAuth: async () => {}, fetchImpl,
    wsConnect: vi.fn(async (_url, options) => stream(new Headers(options.headers).get('authorization')!.replace(/^Bearer /, ''))),
    spawnStdioMcp: vi.fn(async spec => stream(spec.env?.FIXTURE_ACCOUNT ?? 'sales')),
  };
  const api: ConnectionApiHandlerDeps = { decodeAuth: mcp.decodeAuth, persistAuth: async () => {}, fetchImpl };
  const statuses: string[] = [];
  const config = (): ServerExecutorConfig => ({ manifests, connectionStore: connections, connectionApi: api, connectionMcp: mcp,
    cacheStore: cache, instanceId: 'fixture' });
  const bound = (store: CacheStore = cache, recipe_id = 'read-fixture', cached = true, signal?: AbortSignal) => createBoundExecutor({ ...config(), cacheStore: store },
    createNamespaceStores({}, {}, {}), cached ? { recipe_id, recipe_ttl: 300 } : undefined, status => statuses.push(status), undefined, undefined, signal);
  const runRead = (executor = bound(), name = 'sales', freshness?: 'any' | 'fresh') => executor(read.slug, { connection: name }, undefined,
    freshness ? { cache: freshness } : undefined);
  const runWrite = (executor = bound(), name = 'sales') => executor(write.slug, { connection: name });
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { read, write, manifests, config, bound, runRead, runWrite, statuses, requests, mcp, api, fetchImpl,
    observeRequest: (observer: (writes: boolean) => void) => { observeRequest = observer; },
    versions, cache: () => cache, connections: () => connections, db: () => db,
    outcome: (value: Outcome) => { outcome = value; },
    pauseWrite: () => { const pause = deferred(); const started = deferred();
      writePauses.push({ started: () => started.resolve(), wait: pause.promise });
      return { started: started.promise, release: () => pause.resolve() }; },
    pauseRead: () => { const pause = deferred(); readPause = pause.promise; readStarted = deferred();
      return { started: readStarted.promise, release: () => { readPause = undefined; pause.resolve(); } }; },
    reopen: () => { db.close(); db = new Database(file); connections = createConnectionStore(db);
      cache = createSQLiteCacheStore(db, createBlobStore(join(dir, 'blobs'))); },
  };
};

/** Start from an actual hit, then pause a writer until the host's recovery
 * probe has seen its durable pending marker. No wall-clock delay starts it. */
const beginPendingRecovery = async <T>(f: ReturnType<typeof fixture>, read: () => Promise<T>) => {
  await read(); const gate = f.pauseWrite(); let write!: Promise<unknown>;
  const waiting = deferred(); let pendingChecks = 0;
  const store = f.connections(); const revision = store.getReadCacheRevision!.bind(store);
  vi.spyOn(store, 'getReadCacheRevision').mockImplementation((...args) => {
    const value = revision(...args);
    if (value === undefined && ++pendingChecks === 2) waiting.resolve();
    return value;
  });
  const cache = f.cache(); const get = cache.get.bind(cache);
  vi.spyOn(cache, 'get').mockImplementationOnce(async key => {
    const entry = await get(key); write = f.runWrite(); await gate.started; return entry;
  });
  const result = read(); void result.catch(() => {});
  await waiting.promise;
  return { result, finishWrite: async () => { gate.release(); await write; } };
};

const budgetReader = (f: ReturnType<typeof fixture>, registry?: InFlightRegistry,
  route: 'direct' | 'nested' | 'exchange' = 'direct', childBudget = 0) => {
  const recipes = createRecipeStore('/nonexistent');
  const reader: RecipeDefinition = { recipe_id: 'budget-pending-read', version: 1, ttl: 300, variables: {},
    metadata: { name: 'Read account', description: 'Read the current contact.', author: 'fixture', supported_platforms: [], budget_ms: 100 },
    requires: [f.read.slug], prefetch_steps: [], steps: [{ id: 'read', ingredient: f.read.slug, input: {} }],
    output: { render: [{ type: 'json', source: 'step.read.result' }] } };
  if (route === 'direct') recipes.register(reader);
  else {
    const childId = 'budget-read-child'; const slug = 'fixture-invoke-read';
    recipes.register({ ...reader, recipe_id: childId, metadata: { ...reader.metadata, budget_ms: childBudget } });
    f.manifests.register({ ...f.read, slug, input: {},
      operations: { invoke: { operation_id: `${slug}.invoke`, risk_tier: 'read', groups: ['fixture'] } },
      surfaces: { api: { transport: 'rest', default_base_url: 'https://fixture.invalid', auth: { kind: 'none' },
        executes: { invoke: { kind: 'mcp', tool: `recued-core/${childId}` } } } } });
    recipes.register({ ...reader, requires: [slug],
      steps: route === 'nested' ? [{ id: 'read', ingredient: slug, input: { operation: 'invoke', args: {} } }] : [],
      output: route === 'exchange' ? { exchange: { ref: 'fixture-ref', deliver_to: `recued-core/${childId}` } } : reader.output });
  }
  const deps: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, connectionStore: f.connections(),
    executorConfig: f.config(), ...(registry ? { inFlightRegistry: registry } : {}) };
  return () => handleExecute(deps, { recipe_id: 'budget-pending-read',
    ...(registry || route !== 'direct' ? { execution_source: { channel: 'user' as const, actor: 'user_self' as const,
      user_id: 'owner', client_token_id: 'fixture' } } : {}) });
};

const providers = ['api', 'mcp'] as const;
describe('account reads after writes', () => {
  it.each(['bound', 'server'] as const)('shares one credential refresh with a separate %s executor', async mode => {
    const f = fixture('api'); const gate = deferred(); const started = deferred();
    let auth: ConnectionAuth = { type: 'oauth2_refresh', refresh_token: 'fixture-refresh', client_id: 'fixture-client',
      token_endpoint: 'https://auth.example.test/token', current_access_token: 'old', expires_at: 0 };
    f.api.decodeAuth = async () => auth; f.api.persistAuth = async (_row, next) => { auth = next; };
    f.fetchImpl.mockImplementation(async url => {
      if (String(url).startsWith('https://auth.example.test/')) {
        started.resolve(); await gate.promise;
        return Response.json({ access_token: 'fresh', expires_in: 3600 });
      }
      return Response.json({ version: 1 });
    });
    const first = f.runRead(f.bound()); const second = f.runRead(mode === 'bound' ? f.bound() : createServerExecutor(f.config()));
    try {
      await started.promise; await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).startsWith('https://auth.example.test/'))).toHaveLength(1);
    } finally { gate.resolve(); await Promise.all([first, second]); }
  });

  it.each(providers)('%s refreshes all read slugs across recipes and SQLite restart after an uncached write', async kind => {
    const f = fixture(kind); const otherRead = { ...f.read, slug: `${f.read.slug}-other` }; f.manifests.register(otherRead);
    await f.runRead(); await f.bound()(otherRead.slug, {}); await f.runRead();
    await f.runWrite(f.bound(undefined, 'uncached-write', false));
    f.reopen();
    expect(await f.runRead(f.bound(undefined, 'other-recipe'), 'sales', 'any')).toMatchObject({ result: { version: 1 } });
    expect(await f.bound()(otherRead.slug, {})).toMatchObject({ result: { version: 1 } });
    await f.runRead();
    expect(f.requests.filter(r => !r.writes)).toHaveLength(4);
    expect(f.requests.filter(r => r.writes)).toHaveLength(1);
  });

  it.each(['sse', 'websocket', 'stdio'] as const)('refreshes MCP reads while keeping the warm %s session', async transport => {
    const f = fixture('mcp', transport); const executor = f.bound();
    await f.runRead(executor); await f.runWrite(executor);
    expect(await f.runRead(executor)).toMatchObject({ result: { version: 1 } });
    await f.runRead(executor);
    expect(f.requests).toEqual([{ name: 'sales', writes: false }, { name: 'sales', writes: true }, { name: 'sales', writes: false }]);
    if (transport === 'stdio') expect(f.mcp.spawnStdioMcp).toHaveBeenCalledOnce();
    if (transport === 'websocket') expect(f.mcp.wsConnect).toHaveBeenCalledOnce();
  });

  it.each(providers)('%s host writes refresh bound recipe reads without changing account review identity', async kind => {
    const f = fixture(kind); const before = f.connections().get(kind, 'sales')!;
    const revision = connectionRevision(connectionIdentity(before, f.connections().getAuthSourceId!(kind, 'sales')));
    const guard = revision ? connectionRevisionGuard({ sales: revision }, name => f.connections().get('api', name),
      name => f.connections().getAuthSourceId!('api', name)) : undefined;
    await f.runRead(); await f.runWrite(createServerExecutor(f.config()));
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    expect(f.connections().get(kind, 'sales')).toEqual(before);
    guard?.();
  });

  it.each(providers)('%s refreshes rejected dispatched writes while retaining another account', async kind => {
    const f = fixture(kind); await f.runRead(); await f.runRead(undefined, 'personal');
    f.outcome('reject');
    if (kind === 'api') await expect(f.runWrite()).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
    else expect(await f.runWrite()).toMatchObject({ status: 'tool_error' });
    await f.runRead(); expect(f.requests.filter(r => !r.writes)).toHaveLength(3);
    f.outcome('ok'); await f.runWrite(); await f.runRead(undefined, 'personal');
    expect(f.requests.filter(r => !r.writes)).toHaveLength(3);
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
  });

  it.each(['sse', 'websocket', 'stdio'] as const)('retires reads after a partially applied MCP %s tool error', async transport => {
    const f = fixture('mcp', transport); const executor = f.bound(); await f.runRead(executor);
    f.outcome('partial_error');
    expect(await f.runWrite(executor)).toMatchObject({ status: 'tool_error' });
    expect(await f.runRead(executor)).toMatchObject({ result: { version: 1 } });
    expect(f.requests.filter(request => request.writes)).toHaveLength(1);
  });

  it.each(['processing', 'admission'] as const)('retires API reads after an upload %s failure following earlier requests', async failure => {
    const f = fixture('api'); await f.runRead();
    const original = f.fetchImpl.getMockImplementation()!;
    const commands: string[] = [];
    f.fetchImpl.mockImplementation(async (url, init) => {
      const command = new URL(String(url)).searchParams.get('command');
      if (!command) return original(url, init);
      commands.push(command);
      if (command === 'INIT') f.versions.set('sales', 1);
      return new Response(JSON.stringify(command === 'INIT' ? { session: 'fixture-session' }
        : command === 'STATUS' ? { state: 'failed' } : {}), { headers: { 'content-type': 'application/json' } });
    });
    f.api.uploadStaging = { stage: async () => ({ token: 'fixture-staged', size_bytes: 16 }), dispose: async () => {} };
    f.api.readUploadChunk = async () => ({ bytes: new Uint8Array(16), mime_type: 'application/octet-stream' });
    if (failure === 'admission') f.api.beforeRequest = async (_call, target) => {
      if (new URL(target.actual).searchParams.get('command') === 'APPEND') {
        throw new IngredientError('CONNECTION_REFUSED', 'Fixture refused a later upload request');
      }
    };
    const spec: ChunkedUploadSpec = { kind: 'chunked', arg: 'file', chunk_bytes: 16, session_from: 'result.session',
      init: { method: 'POST', path: '/upload', query: { command: 'INIT' } },
      append: { method: 'POST', path: '/upload', query: { command: 'APPEND', session: '{session}' } },
      finalize: { method: 'POST', path: '/upload', query: { command: 'FINALIZE' } },
      status: { method: 'GET', path: '/upload', query: { command: 'STATUS' }, max_polls: 1,
        done: { path: 'result.state', equals: 'succeeded' }, failed: { path: 'result.state', equals: 'failed' } } };
    f.manifests.register({ ...f.write, input: { ...f.write.input, [CHUNKED_UPLOAD_WIRE_WALK_KEY]: {
      spec, file_ref: 'file:fixture', total_bytes: 16, count: 1, request_bound: 4,
    } } });
    await expect(f.runWrite()).rejects.toMatchObject({ code: failure === 'processing' ? 'NETWORK_ERROR' : 'CONNECTION_REFUSED' });
    expect(commands).toEqual(failure === 'processing' ? ['INIT', 'APPEND', 'FINALIZE', 'STATUS'] : ['INIT']);
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
  });

  it.each(providers)('%s isolates provider admission between concurrent account writes', async kind => {
    const f = fixture(kind); await f.runRead(); await f.runRead(undefined, 'personal');
    const refusePersonal: NonNullable<ConnectionMcpHandlerDeps['beforeRequest']> = async call => {
      if (call.input.connection === 'personal') throw new IngredientError('CONNECTION_REFUSED', 'Fixture account refused before dispatch');
    };
    f.api.beforeRequest = refusePersonal; f.mcp.beforeRequest = refusePersonal;
    const gate = f.pauseWrite(); const write = f.runWrite(); await gate.started;
    await expect(f.runWrite(undefined, 'personal')).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    await f.runRead(undefined, 'personal');
    expect(f.requests.filter(request => !request.writes)).toHaveLength(2);
    gate.release(); await write;
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    expect(f.requests.filter(request => request.writes)).toEqual([{ name: 'sales', writes: true }]);
  });

  it.each(providers)('%s recovers an interrupted write when a restarted process reuses its PID', async kind => {
    const f = fixture(kind); await f.runRead();
    f.db().prepare('INSERT INTO connection_read_cache_writes VALUES (?, ?, ?, ?)')
      .run('old-incarnation', kind, 'sales', `${process.pid}:previous-incarnation`);
    f.versions.set('sales', 1); f.reopen();
    expect(f.connections().getReadCacheRevision!(kind, 'sales')).toEqual(expect.any(String));
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    await f.runRead();
    expect(f.requests.filter(request => !request.writes)).toHaveLength(2);
  });

  it.each(providers)('%s uncertain writes retire cached evidence without retrying the write', async kind => {
    const f = fixture(kind); await f.runRead(); f.outcome('uncertain');
    await expect(f.runWrite()).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    expect(f.requests.filter(r => r.writes)).toHaveLength(1);
  });

  it.each(providers)('%s bypasses caching during overlapping writes and resumes only after both finish', async kind => {
    const f = fixture(kind); await f.runRead(); const gate = f.pauseWrite(); const otherGate = f.pauseWrite();
    const first = f.runWrite(); const second = f.runWrite(); await Promise.all([gate.started, otherGate.started]);
    // Both writes enter synchronously before either simulated provider reply.
    await vi.waitFor(() => expect(f.db().prepare('SELECT count(*) AS n FROM connection_read_cache_writes').get()).toEqual({ n: 2 }));
    expect(await f.runRead()).toMatchObject({ result: { version: 0 } });
    expect(f.connections().getReadCacheRevision!(kind, 'sales')).toBeUndefined();
    gate.release(); await first;
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    expect(f.connections().getReadCacheRevision!(kind, 'sales')).toBeUndefined();
    otherGate.release(); await second;
    expect(await f.runRead()).toMatchObject({ result: { version: 2 } });
    await f.runRead();
    expect(f.requests.filter(r => !r.writes)).toHaveLength(4);
    expect(f.db().prepare('SELECT count(*) AS n FROM connection_read_cache_writes').get()).toEqual({ n: 0 });
  });

  it.each(providers)('%s retries a read response that crosses a completed write', async kind => {
    const f = fixture(kind); const gate = f.pauseRead();
    const read = f.runRead(); const refreshed = expect(read).resolves.toMatchObject({ result: { version: 1 } });
    await gate.started; await f.runWrite(); gate.release(); await refreshed;
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    expect(f.requests.filter(r => !r.writes)).toHaveLength(2);
  });

  it.each(providers.flatMap(kind => (['get', 'touch', 'set'] as const).map(method => ({ kind, method }))))(
    '$kind retries cache $method that crosses a completed write', async ({ kind, method }) => {
      const f = fixture(kind); if (method !== 'set') await f.runRead();
      const cache = f.cache();
      if (method === 'get') {
        const get = cache.get.bind(cache);
        vi.spyOn(cache, 'get').mockImplementationOnce(async key => { const entry = await get(key); await f.runWrite(); return entry; });
      } else if (method === 'touch') {
        const touch = cache.touch!.bind(cache);
        vi.spyOn(cache, 'touch').mockImplementationOnce(async (...args) => { await touch(...args); await f.runWrite(); });
      } else {
        const set = cache.set.bind(cache);
        vi.spyOn(cache, 'set').mockImplementationOnce(async entry => { await set(entry); await f.runWrite(); });
      }
      expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
      expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    });

  it.each(['sse', 'websocket', 'stdio'] as const)('retries an invalidated MCP %s response on its warm session', async transport => {
    const f = fixture('mcp', transport); const executor = f.bound(); const gate = f.pauseRead();
    const read = f.runRead(executor); const refreshed = expect(read).resolves.toMatchObject({ result: { version: 1 } });
    await gate.started; await f.runWrite(executor); gate.release(); await refreshed;
    await f.runRead(executor);
    expect(f.requests.filter(request => !request.writes)).toHaveLength(2);
    if (transport === 'stdio') expect(f.mcp.spawnStdioMcp).toHaveBeenCalledOnce();
    if (transport === 'websocket') expect(f.mcp.wsConnect).toHaveBeenCalledOnce();
  });

  it.each(providers)('%s reapplies provider admission when retrying an invalidated response', async kind => {
    const f = fixture(kind); const executor = f.bound(); const gate = f.pauseRead();
    const refused = new IngredientError('CONNECTION_REFUSED', 'Fixture no longer admits this read');
    let admit = true;
    const beforeRequest = vi.fn(async (call: ResolvedCall) => {
      if (call.risk_tier === 'read' && !admit) throw refused;
    });
    // Construct a fresh bound handler after installing the mutable admission gate.
    f.api.beforeRequest = beforeRequest; f.mcp.beforeRequest = beforeRequest;
    const guarded = f.bound();
    const read = f.runRead(guarded); const rejected = expect(read).rejects.toBe(refused);
    await gate.started; await f.runWrite(executor); admit = false; gate.release(); await rejected;
    expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
    expect(f.requests.filter(request => request.writes)).toHaveLength(1);
    expect(beforeRequest.mock.calls.map(([call]) => call.risk_tier)).toEqual(['read', 'write', 'read']);
  });

  it('preserves API output mapping when another reader fills the recovered generation', async () => {
    const f = fixture('api'); const executor = f.bound();
    const output = { 'result.version': 'selected_version' };
    expect(await executor(f.read.slug, {}, output)).toEqual({ selected_version: 0 });
    const cache = f.cache(); const get = cache.get.bind(cache);
    vi.spyOn(cache, 'get').mockImplementationOnce(async key => {
      const entry = await get(key); await f.runWrite();
      expect(await executor(f.read.slug, {}, { 'result.version': 'other_version' })).toEqual({ other_version: 1 });
      return entry;
    });
    expect(await executor(f.read.slug, {}, output)).toEqual({ selected_version: 1 });
    expect(f.requests.filter(request => !request.writes)).toHaveLength(3);
    expect(await executor(f.read.slug, {}, output)).toEqual({ selected_version: 1 });
    expect(f.requests.filter(request => !request.writes)).toHaveLength(3);
  });

  it.each(providers)('%s preserves privacy settings when another reader fills the recovered generation', async kind => {
    const f = fixture(kind); const executor = f.bound();
    const input = kind === 'api' ? { 'query.email': 'person@example.test' } : { args: { email: 'person@example.test' } };
    const options = { pii_fields: [kind === 'api' ? 'query.email' : 'email'] };
    const original = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      const frame = kind === 'mcp' ? JSON.parse(String(init?.body)) as Frame : undefined;
      if (kind === 'api' ? init?.method !== 'GET' : frame?.params?.name !== 'lookup') return response;
      const email = kind === 'api' ? new URL(String(url)).searchParams.get('email') : frame?.params?.arguments?.email;
      const protectedInput = typeof email === 'string' && email.startsWith('HASH_STEP_');
      const data = await response.json();
      return new Response(JSON.stringify(kind === 'api' ? { ...data, protected: protectedInput }
        : { ...data, result: { ...data.result, protected: protectedInput } }),
      { headers: { 'content-type': 'application/json' } });
    });
    expect(await executor(f.read.slug, input, undefined, options)).toMatchObject({ result: { protected: true } });
    const cache = f.cache(); const get = cache.get.bind(cache);
    vi.spyOn(cache, 'get').mockImplementationOnce(async key => {
      const entry = await get(key); await f.runWrite();
      expect(await executor(f.read.slug, input)).toMatchObject({ result: { protected: false } });
      return entry;
    });
    expect(await executor(f.read.slug, input, undefined, options)).toMatchObject({ result: { protected: true } });
    expect(f.requests.filter(request => !request.writes)).toHaveLength(3);
    expect(await executor(f.read.slug, input, undefined, options)).toMatchObject({ result: { protected: true } });
    expect(f.requests.filter(request => !request.writes)).toHaveLength(3);
  });

  it.each(providers)('%s stops after one retry if another write invalidates the retry too', async kind => {
    const f = fixture(kind); const cache = f.cache(); const set = cache.set.bind(cache);
    const invalidate = vi.spyOn(cache, 'set').mockImplementation(async entry => { await set(entry); await f.runWrite(); });
    await expect(f.runRead()).rejects.toMatchObject({ details: { reason: 'connection_data_changed' } });
    expect(f.requests.filter(request => !request.writes)).toHaveLength(2);
    expect(f.requests.filter(request => request.writes)).toHaveLength(2);
    invalidate.mockRestore();
    expect(await f.runRead()).toMatchObject({ result: { version: 2 } });
  });

  it.each(providers)('%s does not retry a provider error shaped like a cache invalidation', async kind => {
    const f = fixture(kind); const fake = new IngredientError('CONNECTION_REFUSED', 'Fixture provider refused',
      { reason: 'connection_data_changed' });
    const beforeRequest = vi.fn(async () => { throw fake; });
    f.api.beforeRequest = beforeRequest; f.mcp.beforeRequest = beforeRequest;
    await expect(f.runRead()).rejects.toBe(fake);
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(f.requests).toHaveLength(0);
  });

  it.each(providers)('%s waits for a pending write before retrying the read once', async kind => {
    const f = fixture(kind); const recovery = await beginPendingRecovery(f, () => f.runRead());
    try {
      expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
      await recovery.finishWrite();
      expect(await recovery.result).toMatchObject({ result: { version: 1 } });
      expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
      expect(f.requests.filter(request => !request.writes)).toHaveLength(2);
      expect(f.requests.filter(request => request.writes)).toHaveLength(1);
    } finally { await recovery.finishWrite(); }
  });

  it.each(providers)('%s waits for all overlapping writes before choosing a generation', async kind => {
    const f = fixture(kind); const recovery = await beginPendingRecovery(f, () => f.runRead());
    const secondGate = f.pauseWrite(); const secondWrite = f.runWrite();
    try {
      await secondGate.started; await recovery.finishWrite();
      expect(f.connections().getReadCacheRevision!(kind, 'sales')).toBeUndefined();
      expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
      secondGate.release(); await secondWrite;
      expect(await recovery.result).toMatchObject({ result: { version: 2 } });
      expect(f.requests.filter(request => !request.writes)).toHaveLength(2);
      expect(f.requests.filter(request => request.writes)).toHaveLength(2);
    } finally { secondGate.release(); await secondWrite; await recovery.finishWrite(); }
  });

  it.each(providers)('%s cancels the wait without issuing another read or interrupting the writer', async kind => {
    const f = fixture(kind); const controller = new AbortController(); const executor = f.bound(undefined, 'read-fixture', true, controller.signal);
    const recovery = await beginPendingRecovery(f, () => f.runRead(executor));
    try {
      controller.abort(); await expect(recovery.result).rejects.toMatchObject({ code: 'run_killed' });
      expect(f.connections().getReadCacheRevision!(kind, 'sales')).toBeUndefined();
      await recovery.finishWrite();
      expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
      expect(f.requests.filter(request => request.writes)).toHaveLength(1);
      expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    } finally { await recovery.finishWrite(); }
  });

  it.each(providers)('%s stops cancelled recovery before decoding credentials', async kind => {
    const f = fixture(kind); const controller = new AbortController();
    const decode = vi.fn<ConnectionMcpHandlerDeps['decodeAuth']>(async row => ({ type: 'bearer', token: row.auth_ciphertext }));
    f.api.decodeAuth = decode; f.mcp.decodeAuth = decode;
    const executor = createBoundExecutor(f.config(), createNamespaceStores({}, {}, {}),
      { recipe_id: 'read-fixture', recipe_ttl: 300 }, (status, context) => {
        if (status === 'miss' && context.retried) controller.abort();
      }, undefined, undefined, controller.signal);
    const recovery = await beginPendingRecovery(f, () => f.runRead(executor));
    try {
      await recovery.finishWrite();
      await expect(recovery.result).rejects.toMatchObject({ code: 'run_killed' });
      // The initial read and admitted write decoded their credentials. The
      // cancelled recovery must stop before it can start token renewal.
      expect(decode).toHaveBeenCalledTimes(2);
      expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
    } finally { await recovery.finishWrite(); }
  });

  it.each(['api', 'managed', 'sse', 'websocket', 'stdio'] as const)('fences %s recovery at the actual transport after cancellation', async transport => {
    const selected = transport === 'managed' ? 'api' : transport;
    const f = fixture(selected === 'api' ? 'api' : 'mcp', selected === 'api' ? 'sse' : selected);
    if (transport === 'managed') {
      f.api.decodeAuth = async row => ({ type: 'managed_oauth', broker_profile_id: 'fixture', integration_id: 'hubspot',
        connection_id: row.name, target_origin: 'https://api.example.test', requested_scopes: [] });
      f.api.managedOAuthFetch = async (auth, url, init) => {
        const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${auth.connection_id}`);
        return f.fetchImpl(url, { ...init, headers });
      };
    }
    const controller = new AbortController(); let recovering = false; let arm = false;
    const afterAbort: boolean[] = []; f.observeRequest(writes => { if (!writes) afterAbort.push(controller.signal.aborted); });
    const beforeRequest = async (call: ResolvedCall) => { if (recovering && call.risk_tier === 'read') arm = true; };
    f.api.beforeRequest = beforeRequest; f.mcp.beforeRequest = beforeRequest;
    const executor = f.bound(undefined, 'read-fixture', true, controller.signal);
    const recovery = await beginPendingRecovery(f, () => f.runRead(executor));
    const revision = vi.mocked(f.connections().getReadCacheRevision!);
    const get = revision.getMockImplementation()!;
    revision.mockImplementation((...args) => {
      const value = get(...args);
      if (arm) {
        arm = false;
        // Abort after the final async admission fence has returned, while the
        // adapter is resuming its await before fetch()/stream.send().
        queueMicrotask(() => queueMicrotask(() => controller.abort()));
      }
      return value;
    });
    try {
      recovering = true; await recovery.finishWrite();
      await expect(recovery.result).rejects.toMatchObject({ code: 'run_killed' });
      expect(afterAbort).toEqual([false]);
      expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
      // Cancellation leaves the account available to an independent request.
      recovering = false;
      expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    } finally { await recovery.finishWrite(); }
  });

  it('rechecks cancellation after awaiting the credential-row fence', async () => {
    const f = fixture('api'); const controller = new AbortController(); let arm = false;
    const decodedAfterAbort: boolean[] = [];
    f.api.decodeAuth = async row => { decodedAfterAbort.push(controller.signal.aborted); return { type: 'bearer', token: row.auth_ciphertext }; };
    const executor = createBoundExecutor(f.config(), createNamespaceStores({}, {}, {}),
      { recipe_id: 'read-fixture', recipe_ttl: 300 }, (status, context) => {
        if (status === 'miss' && context.retried) arm = true;
      }, undefined, undefined, controller.signal);
    const recovery = await beginPendingRecovery(f, () => f.runRead(executor));
    const revision = vi.mocked(f.connections().getReadCacheRevision!); const get = revision.getMockImplementation()!;
    revision.mockImplementation((...args) => {
      const value = get(...args);
      if (arm) { arm = false; queueMicrotask(() => controller.abort()); }
      return value;
    });
    try {
      await recovery.finishWrite();
      await expect(recovery.result).rejects.toMatchObject({ code: 'run_killed' });
      expect(decodedAfterAbort).toEqual([false, false]);
      expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
    } finally { await recovery.finishWrite(); }
  });

  it.each(providers.flatMap(kind => (['input', 'operation', 'mapping', 'privacy', 'account'] as const)
    .map(change => ({ kind, change }))))('$kind refuses changed $change after a pending-write wait', async ({ kind, change }) => {
    const f = fixture(kind); const executor = f.bound(); const input = { connection: 'sales' };
    const output = { 'result.version': 'version' }; const options = { pii_fields: [] as string[] };
    const recovery = await beginPendingRecovery(f, () => executor(f.read.slug, input, output, options));
    try {
      if (change === 'input') input.connection = 'personal';
      if (change === 'operation') f.manifests.register({ ...f.read, risk_tier: 'write' });
      if (change === 'mapping') output['result.version'] = 'other';
      if (change === 'privacy') options.pii_fields.push('connection');
      if (change === 'account') f.connections().upsert({ ...f.connections().get(kind, 'sales')!, enrolled_at: 2 });
      const rejected = expect(recovery.result).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
      await recovery.finishWrite(); await rejected;
      expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
      expect(f.requests.filter(request => request.writes)).toHaveLength(1);
    } finally { await recovery.finishWrite(); }
  });

  it.each(providers)('%s wires owner kill through handleExecute into the pending-write wait', async kind => {
    const f = fixture(kind); const registry = new InFlightRegistry(new LaneSemaphore());
    const recipes = createRecipeStore('/nonexistent');
    recipes.register({ recipe_id: 'kill-pending-read', version: 1, ttl: 300, variables: {},
      metadata: { name: 'Read account', description: 'Read the current contact.', author: 'fixture', supported_platforms: [] },
      requires: [f.read.slug], prefetch_steps: [], steps: [{ id: 'read', ingredient: f.read.slug, input: {} }],
      output: { render: [{ type: 'json', source: 'step.read.result' }] } });
    const deps: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, connectionStore: f.connections(),
      executorConfig: f.config(), inFlightRegistry: registry };
    const read = () => handleExecute(deps, { recipe_id: 'kill-pending-read',
      execution_source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'fixture' } });
    const recovery = await beginPendingRecovery(f, read);
    try {
      const runId = registry.snapshot().entries.find(entry => entry.entry_kind === 'run')?.run_id;
      if (runId === undefined) throw new Error('Fixture owner run missing');
      expect(registry.kill(runId)).toBe('killed');
      expect((await recovery.result).success).toBe(false);
      await expect.poll(() => registry.isActive(runId)).toBe(false);
      await recovery.finishWrite();
      expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
      expect(f.requests.filter(request => request.writes)).toHaveLength(1);
    } finally { await recovery.finishWrite(); }
  });

  it.each(providers.flatMap(kind => [false, true].map(live => ({ kind, live }))))(
    '$kind stops pending-read recovery at the recipe budget with live registration $live', async ({ kind, live }) => {
    const f = fixture(kind); const registry = new InFlightRegistry(new LaneSemaphore());
    const read = budgetReader(f, live ? registry : undefined);
    vi.useFakeTimers();
    const recovery = await beginPendingRecovery(f, read);
    let settled = false; void recovery.result.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);
      expect(await recovery.result).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
      expect(f.connections().getReadCacheRevision!(kind, 'sales')).toBeUndefined();
      expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
      expect(f.requests.filter(request => request.writes)).toHaveLength(1);
      if (live) expect(registry.snapshot().entries.filter(entry => entry.entry_kind === 'run')).toHaveLength(0);
      await recovery.finishWrite();
      expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    } finally {
      await recovery.finishWrite(); await vi.advanceTimersByTimeAsync(250); await recovery.result;
    }
  });

  it.each(providers.flatMap(kind => (['nested', 'exchange'] as const).flatMap(route =>
    [0, 50, 200].map(childBudget => ({ kind, route, childBudget })))))(
    '$kind honors parent and child budgets through $route recovery with child budget $childBudget', async ({ kind, route, childBudget }) => {
    const f = fixture(kind); const read = budgetReader(f, undefined, route, childBudget); vi.useFakeTimers();
    const warm = await read(); expect(warm.success, JSON.stringify(warm.errors)).toBe(true);
    const recovery = await beginPendingRecovery(f, read);
    let settled = false; void recovery.result.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(childBudget === 50 ? 50 : 100); expect(settled).toBe(true);
      const result = await recovery.result; expect(result.success).toBe(false);
      if (childBudget === 50) expect(JSON.stringify(result.errors)).toContain('50ms budget');
      else expect(result.errors).toMatchObject([{ code: 'RECIPE_BUDGET_EXCEEDED' }]);
      expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
      expect(f.connections().getReadCacheRevision!(kind, 'sales')).toBeUndefined();
      await recovery.finishWrite();
      expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    } finally { await recovery.finishWrite(); await vi.advanceTimersByTimeAsync(250); await recovery.result; }
  });

  it.each(['api', 'managed', 'sse', 'websocket', 'stdio'] as const)(
    'fences %s recovery when the recipe budget expires at transport dispatch', async transport => {
    const selected = transport === 'managed' ? 'api' : transport;
    const f = fixture(selected === 'api' ? 'api' : 'mcp', selected === 'api' ? 'sse' : selected);
    if (transport === 'managed') {
      f.api.decodeAuth = async row => ({ type: 'managed_oauth', broker_profile_id: 'fixture', integration_id: 'hubspot',
        connection_id: row.name, target_origin: 'https://api.example.test', requested_scopes: [] });
      f.api.managedOAuthFetch = async (auth, url, init) => {
        const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${auth.connection_id}`);
        return f.fetchImpl(url, { ...init, headers });
      };
    }
    let recovering = false; let arm = false; let expired = false;
    const afterExpiry: boolean[] = []; f.observeRequest(writes => { if (!writes) afterExpiry.push(expired); });
    const beforeRequest = async (call: ResolvedCall) => { if (recovering && call.risk_tier === 'read') arm = true; };
    f.api.beforeRequest = beforeRequest; f.mcp.beforeRequest = beforeRequest;
    vi.useFakeTimers();
    const recovery = await beginPendingRecovery(f, budgetReader(f));
    const revision = vi.mocked(f.connections().getReadCacheRevision!); const get = revision.getMockImplementation()!;
    revision.mockImplementation((...args) => {
      const value = get(...args);
      if (arm) {
        arm = false;
        queueMicrotask(() => queueMicrotask(() => { expired = true; vi.advanceTimersByTime(100); }));
      }
      return value;
    });
    try {
      recovering = true; await recovery.finishWrite(); await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(() => expect({ expired, requests: f.requests }).toMatchObject({ expired: true }), { interval: 1, timeout: 50 });
      expect(await recovery.result).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
      expect(afterExpiry).toEqual([false]);
      expect(f.requests.filter(request => request.writes)).toHaveLength(1);
      recovering = false;
      expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    } finally { await recovery.finishWrite(); await vi.advanceTimersByTimeAsync(250); await recovery.result; }
  });

  it.each(providers)('%s drains a recovery read already admitted when its recipe budget expires', async kind => {
    const f = fixture(kind); vi.useFakeTimers();
    const recovery = await beginPendingRecovery(f, budgetReader(f)); const admitted = f.pauseRead();
    let settled = false; void recovery.result.then(() => { settled = true; });
    try {
      await recovery.finishWrite(); await vi.advanceTimersByTimeAsync(25); await admitted.started;
      await vi.advanceTimersByTimeAsync(75);
      expect(settled).toBe(false);
      admitted.release();
      expect(await recovery.result).toMatchObject({ success: false, errors: [{ code: 'RECIPE_BUDGET_EXCEEDED' }] });
      expect(f.requests.filter(request => !request.writes)).toHaveLength(2);
      expect(f.requests.filter(request => request.writes)).toHaveLength(1);
      expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    } finally { admitted.release(); await recovery.finishWrite(); await vi.advanceTimersByTimeAsync(250); await recovery.result; }
  });

  it.each(providers)('%s declines recovery while the conflicting write is still pending', async kind => {
    const f = fixture(kind); await f.runRead(); const gate = f.pauseWrite();
    let pending: Promise<unknown> | undefined;
    const cache = f.cache(); const get = cache.get.bind(cache);
    vi.spyOn(cache, 'get').mockImplementationOnce(async key => {
      const entry = await get(key); pending = f.runWrite(); await gate.started; return entry;
    });
    try {
      await expect(f.runRead()).rejects.toMatchObject({ details: { reason: 'connection_data_changed' } });
      expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
    } finally { gate.release(); await pending; }
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
  });

  it.each(providers)('%s rechecks the account after recognizing a host invalidation', async kind => {
    const f = fixture(kind); await f.runRead(); const store = f.connections();
    const revision = store.getReadCacheRevision!.bind(store); let replace = false;
    vi.spyOn(store, 'getReadCacheRevision').mockImplementation((...args) => {
      const value = revision(...args);
      if (replace) {
        replace = false;
        store.upsert({ ...store.get(kind, 'sales')!, enrolled_at: 2 });
      }
      return value;
    });
    const cache = f.cache(); const get = cache.get.bind(cache);
    vi.spyOn(cache, 'get').mockImplementationOnce(async key => {
      const entry = await get(key); await f.runWrite(); replace = true; return entry;
    });
    await expect(f.runRead()).rejects.toMatchObject({ details: { reason: 'connection_changed' } });
    expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
  });

  it.each(providers.flatMap(kind => (['input', 'operation', 'mapping', 'privacy', 'surface'] as const)
    .map(change => ({ kind, change }))))('$kind refuses changed $change during recovery', async ({ kind, change }) => {
    const f = fixture(kind); const input = { connection: 'sales' }; const output = { 'result.version': 'version' };
    const options = { pii_fields: [] as string[] }; const executor = f.bound();
    const meta: StepMeta = { recipe_id: 'read-fixture', step_id: 'read', surface_dispatch: true, surface_risk_tier: 'read' };
    const run = () => executor(f.read.slug, input, output, options, meta);
    await run();
    const cache = f.cache(); const get = cache.get.bind(cache);
    vi.spyOn(cache, 'get').mockImplementationOnce(async key => {
      const entry = await get(key); await f.runWrite();
      if (change === 'input') input.connection = 'personal';
      if (change === 'operation') f.manifests.register({ ...f.read, risk_tier: 'write' });
      if (change === 'mapping') output['result.version'] = 'other';
      if (change === 'privacy') options.pii_fields.push('connection');
      if (change === 'surface') meta.surface_risk_tier = 'write';
      return entry;
    });
    await expect(run()).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    expect(f.requests.filter(request => !request.writes)).toHaveLength(1);
    expect(f.requests.filter(request => request.writes)).toHaveLength(1);
  });

  it.each(providers)('%s cannot rehydrate an older generation from a peer after a write', async kind => {
    const f = fixture(kind); let old: CacheEntry | undefined; const keys: string[] = [];
    const peer = wrapStoreWithPeer(createInMemoryStore(), { setTimer: () => () => {}, transport: {
      connected: () => true, getEntry: async key => { keys.push(key); return old ?? null; },
      putEntries: async () => {}, getSince: async () => ({ entries: [], next_cursor: null }),
    } });
    const set = vi.spyOn(peer, 'set'); await f.runRead(f.bound(peer)); old = set.mock.calls[0]![0];
    await f.runWrite();
    expect(await f.runRead(f.bound(peer))).toMatchObject({ result: { version: 1 } });
    expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
  });

  it.each(providers)('%s preserves completed writes if cache finalization fails and bypasses stale reads', async kind => {
    const f = fixture(kind); await f.runRead();
    const begin = f.connections().beginReadCacheWrite!.bind(f.connections());
    vi.spyOn(f.connections(), 'beginReadCacheWrite').mockImplementation((...args) => {
      begin(...args); return () => { throw new Error('Fixture SQLite unavailable at completion'); };
    });
    expect(await f.runWrite()).toMatchObject({ result: { version: 1 } });
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    expect(f.requests.filter(r => r.writes)).toHaveLength(1);
    expect(f.requests.filter(r => !r.writes)).toHaveLength(3);
  });

  it.each(providers)('%s fails before dispatch when the durable write marker cannot be recorded', async kind => {
    const f = fixture(kind); await f.runRead();
    vi.spyOn(f.connections(), 'beginReadCacheWrite').mockImplementation(() => { throw new Error('Fixture SQLite unavailable'); });
    await expect(f.runWrite()).rejects.toThrow('Fixture SQLite unavailable');
    await f.runRead(); expect(f.requests).toEqual([{ name: 'sales', writes: false }]);
  });

  it.each(providers)('%s recovers an interrupted durable write after reopen and preserves live same-process markers', async kind => {
    const f = fixture(kind); await f.runRead();
    const finish = f.connections().beginReadCacheWrite!(kind, 'sales');
    expect(createConnectionStore(f.db()).getReadCacheRevision!(kind, 'sales')).toBeUndefined();
    finish(false);
    f.db().prepare('INSERT INTO connection_read_cache_writes VALUES (?, ?, ?, ?)').run('interrupted', kind, 'sales', exitedOwner());
    f.versions.set('sales', 1); f.reopen();
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    await f.runRead(); expect(f.requests.filter(r => !r.writes)).toHaveLength(2);
  });

  it.each(providers)('%s uses the effective catalog operation tier when the wrapper itself is read', async kind => {
    const f = fixture(kind); await f.runRead();
    const catalog = { ...f.write, slug: 'fixture-catalog', category: 'data' as const, risk_tier: 'read' as const };
    f.manifests.register(catalog);
    await f.bound()(catalog.slug, {}, undefined, undefined, { recipe_id: 'catalog', step_id: 'write',
      surface_dispatch: true, surface_risk_tier: 'write' });
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
  });

  it.each(providers)('%s preserves caches when a held or cancelled run refuses provider admission', async kind => {
    const f = fixture(kind); await f.runRead();
    await expect(withPreapprovalOrdinaryGuard(() => { throw new Error('Fixture run admission refused'); },
      () => f.runWrite())).rejects.toThrow('Fixture run admission refused');
    await f.runRead();
    expect(f.requests).toEqual([{ name: 'sales', writes: false }]);
    expect(f.db().prepare('SELECT count(*) AS n FROM connection_read_cache_writes').get()).toEqual({ n: 0 });
  });

  it.each(providers)('%s rolls back a failed cache completion transaction and still returns the acknowledged write', async kind => {
    const f = fixture(kind); await f.runRead();
    f.db().exec(`CREATE TRIGGER refuse_cache_completion BEFORE INSERT ON connection_read_cache_revisions
      BEGIN SELECT RAISE(ABORT, 'Fixture cache completion failed'); END`);
    expect(await f.runWrite()).toMatchObject({ result: { version: 1 } });
    expect(f.connections().getReadCacheRevision!(kind, 'sales')).toBeUndefined();
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    f.db().exec('DROP TRIGGER refuse_cache_completion');
    f.db().prepare('UPDATE connection_read_cache_writes SET owner = ?').run(exitedOwner());
    f.reopen();
    expect(await f.runRead()).toMatchObject({ result: { version: 1 } });
    await f.runRead(); expect(f.requests.filter(r => !r.writes)).toHaveLength(3);
  });

  it.each(providers)('%s keeps credential renewal and health updates separate from the data revision', async kind => {
    const f = fixture(kind); await f.runRead(); await f.runWrite(); await f.runRead();
    const row = f.connections().get(kind, 'sales')!;
    // Same fixture bearer bytes stand in for a renewed encrypted credential.
    expect(f.connections().persistRefreshedAuth!(row, row.auth_ciphertext, 2)).toBe(true);
    f.connections().setHealth(kind, 'sales', row.health_json ?? '{}');
    await f.runRead(); expect(f.requests.filter(r => !r.writes)).toHaveLength(2);
  });

  it.each(providers)('%s scopes custom adapters without durable storage to their live store instance', async kind => {
    const f = fixture(kind); const store = { get: f.connections().get.bind(f.connections()) };
    const bound = (connectionStore = store) => createBoundExecutor({ ...f.config(), connectionStore },
      createNamespaceStores({}, {}, {}), { recipe_id: 'custom-store', recipe_ttl: 300 });
    await f.runRead(bound()); await f.runRead(bound()); await f.runWrite(bound());
    expect(await f.runRead(bound())).toMatchObject({ result: { version: 1 } });
    await f.runRead(bound()); expect(f.requests.filter(r => !r.writes)).toHaveLength(2);
    await f.runRead(bound({ ...store })); expect(f.requests.filter(r => !r.writes)).toHaveLength(3);
  });

  it('preserves pending writes owned by another live process during recovery', async () => {
    const f = fixture('api'); await f.runRead();
    f.db().prepare('INSERT INTO connection_read_cache_writes VALUES (?, ?, ?, ?)')
      .run('live-peer', 'api', 'sales', `${process.ppid}:live-parent`);
    const otherHandle = createConnectionStore(f.db());
    expect(otherHandle.getReadCacheRevision!('api', 'sales')).toBeUndefined();
    expect(await f.runRead()).toMatchObject({ result: { version: 0 } });
    expect(f.requests.filter(r => !r.writes)).toHaveLength(2);
  });

  it('separates cache retirement for API and MCP accounts with the same name', async () => {
    const f = fixture('api'); const finish = f.connections().beginReadCacheWrite!('mcp', 'sales');
    expect(await f.runRead()).toMatchObject({ result: { version: 0 } });
    finish(true); await f.runRead();
    expect(f.requests.filter(r => !r.writes)).toHaveLength(1);
    expect(f.connections().getReadCacheRevision!('api', 'sales')).toBe('0');
  });

  it('keeps MCP resource reads out of the write journal even under an admin wrapper', async () => {
    const f = fixture('mcp'); await f.runRead();
    f.manifests.register({ ...f.write, risk_tier: 'admin', input: { connection_kind: 'mcp', connection: 'sales', resource: 'fixture:///contact' } });
    await f.runWrite(); await f.runRead();
    expect(f.requests.filter(r => !r.writes)).toHaveLength(2);
    expect(f.connections().getReadCacheRevision!('mcp', 'sales')).toBe('0');
  });

  it('keeps recipe replay from bypassing write freshness', async () => {
    const f = fixture('api'); const recipes = createRecipeStore('/nonexistent');
    recipes.register({ recipe_id: 'read-after-write', version: 1, ttl: 300, variables: {},
      metadata: { name: 'Read account', description: 'Read the current contact.', author: 'fixture', supported_platforms: [] },
      requires: [f.read.slug], prefetch_steps: [], steps: [{ id: 'read', ingredient: f.read.slug, input: {} }],
      output: { render: [{ type: 'json', source: 'step.read.result' }] } });
    const deps: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, connectionStore: f.connections(), executorConfig: f.config() };
    const run = () => handleExecute(deps, { recipe_id: 'read-after-write',
      execution_source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'fixture' } });
    expect((await run()).output.render[0]?.data).toEqual({ version: 0 });
    await f.runWrite();
    const result = await run(); expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.output.render[0]?.data).toEqual({ version: 1 });
  });
});
