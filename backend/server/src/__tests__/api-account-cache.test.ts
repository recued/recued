import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { cacheKey, createInMemoryStore, wrapStoreWithPeer, type CacheStore } from '@recued/cache';
import type { CacheEntry, ConnectionRow, IngredientManifest } from '@recued/contracts';
import { createConnectionStore } from '../storage/connection-store.js';
import { createSQLiteCacheStore } from '../storage/index.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createBoundExecutor, createNamespaceStores } from '../server-executor.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const manifest: IngredientManifest = { slug: 'fixture-api-read', version: 1, name: 'Account read', description: '', author: 'fixture',
  kind: 'connection', category: 'data', risk_tier: 'read',
  input: { connection_kind: 'api', connection: '{{config.crm_connection}}', method: 'GET', path: '/contacts/42' }, output: {} };
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'api-account-cache-'));
  const file = join(dir, 'realm.sqlite');
  let db = new Database(file);
  let connections = createConnectionStore(db);
  let cache = createSQLiteCacheStore(db, createBlobStore(join(dir, 'blobs')));
  const row: ConnectionRow = { pk: 'api:sales', kind: 'api', name: 'sales', display_name: 'Sales',
    config_json: JSON.stringify({ vendor: 'hubspot', base_url: 'https://api.example.test' }),
    auth_ciphertext: 'account-a', enrolled_at: 1, updated_at: 1 };
  connections.upsert(row);
  const manifests = createManifestRegistry('/nonexistent'); manifests.register(manifest);
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify({
    account: new Headers(init?.headers).get('authorization'),
  }), { headers: { 'content-type': 'application/json' } }));
  const statuses: string[] = [];
  const api = { persistAuth: async () => {}, decodeAuth: vi.fn(async (record: ConnectionRow) => ({ type: 'bearer' as const, token: record.auth_ciphertext })), fetchImpl };
  const executor = (store: CacheStore = cache, recipe_id = 'read-fixture') => createBoundExecutor({
    manifests, connectionStore: connections, connectionApi: api, cacheStore: store, instanceId: 'fixture',
  }, createNamespaceStores({}, { crm_connection: 'sales' }, {}), { recipe_id, recipe_ttl: 300 }, status => statuses.push(status));
  const run = (store?: CacheStore, recipe_id?: string, freshness?: 'any' | 'fresh') =>
    executor(store, recipe_id)(manifest.slug, {}, undefined, freshness ? { cache: freshness } : undefined);
  const current = () => connections.get('api', 'sales')!;
  const replace = (change: Partial<ConnectionRow> = { auth_ciphertext: 'account-b' }) => connections.upsert({ ...current(), ...change });
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { run, executor, fetchImpl, statuses, api, manifests, replace, current, cache: () => cache, connections: () => connections,
    reopen: () => {
      db.close(); db = new Database(file); connections = createConnectionStore(db);
      cache = createSQLiteCacheStore(db, createBlobStore(join(dir, 'blobs')));
    } };
};

describe('API cache account identity', () => {
  it('makes legacy recipe connection reads reach the scoped cache instead of replaying L2', async () => {
    const f = fixture(); const recipes = createRecipeStore('/nonexistent');
    recipes.register({ recipe_id: 'legacy-read', version: 1, ttl: 300, variables: { crm_connection: 'sales' },
      metadata: { name: 'Legacy read', description: 'Read a contact using its enrolled account.', author: 'fixture', supported_platforms: [] },
      requires: [manifest.slug], prefetch_steps: [], steps: [{ id: 'read', ingredient: manifest.slug, input: {} }],
      output: { render: [{ type: 'json', source: 'step.read.result' }] } });
    const deps: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, connectionStore: f.connections(),
      executorConfig: { manifests: f.manifests, connectionStore: f.connections(), connectionApi: f.api,
        cacheStore: f.cache(), instanceId: 'fixture' } };
    const run = () => handleExecute(deps, { recipe_id: 'legacy-read',
      execution_source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'fixture' } });
    const initial = await run(); expect(initial.success, JSON.stringify(initial.errors)).toBe(true);
    expect(initial.output.render[0]?.data).toEqual({ account: 'Bearer account-a' });
    f.replace();
    const next = await run(); expect(next.success, JSON.stringify(next.errors)).toBe(true);
    expect(next.output.render[0]?.data).toEqual({ account: 'Bearer account-b' });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('isolates a replacement behind the same name, shares unchanged accounts across recipes, and survives SQLite restart', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ result: { account: 'Bearer account-a' } });
    expect(await f.run(undefined, 'other-recipe')).toMatchObject({ result: { account: 'Bearer account-a' } });
    f.reopen();
    await f.run();
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    f.replace();
    expect(await f.run()).toMatchObject({ result: { account: 'Bearer account-b' } });
    await f.run();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.statuses).toEqual(['miss', 'hit', 'hit', 'miss', 'hit']);
  });

  it('preserves hits through trusted token renewal and routine health or display changes', async () => {
    const f = fixture(); await f.run();
    expect(f.connections().persistRefreshedAuth?.(f.current(), 'renewed-token', 2)).toBe(true);
    f.replace({ display_name: 'Renamed', health_json: '{}', updated_at: 3, last_used_at: 3 });
    await f.run();
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.statuses).toEqual(['miss', 'hit']);
  });

  it.each<Partial<ConnectionRow>>([{ enrolled_at: 2 }, { subresource_path: '/contacts' },
    { granted_scopes_json: '["read"]' }, { config_json: '{"vendor":"hubspot","base_url":"https://new.example.test"}' }])(
    'misses after enrollment or scope changes: %j', async change => {
      const f = fixture(); await f.run(); f.replace(change); await f.run();
      expect(f.fetchImpl).toHaveBeenCalledTimes(2); expect(f.statuses).toEqual(['miss', 'miss']);
    });

  it('never serves legacy entries, even with any freshness', async () => {
    const f = fixture();
    const key = await cacheKey({ ingredient_slug: manifest.slug, manifest_version: '1',
      inputs: { ...manifest.input, connection: 'sales' } });
    await f.cache().set({ key, value: { result: { account: 'legacy-account' } },
      expires_at: Date.now() + 300_000, created_at: Date.now(), last_accessed_at: Date.now(),
      recipe_id: 'old', ingredient_slug: manifest.slug, category: 'data', risk_tier: 'read', size_bytes: 1 });
    expect(await f.run(undefined, undefined, 'any')).toMatchObject({ result: { account: 'Bearer account-a' } });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });

  it('cannot replay an old value after deletion of its enrolled account', async () => {
    const f = fixture(); await f.run(); f.connections().delete('api', 'sales');
    await expect(f.run()).rejects.toThrow('no api connection');
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(['get', 'touch', 'set'] as const)('refuses replacement across asynchronous cache %s', async method => {
    const f = fixture(); if (method !== 'set') await f.run();
    const cache = f.cache(); const original = cache[method]!.bind(cache);
    vi.spyOn(cache, method).mockImplementationOnce((async (...args: never[]) => {
      const result = await (original as (...args: never[]) => Promise<unknown>)(...args);
      f.replace(); return result;
    }) as never);
    await expect(f.run()).rejects.toThrow('account changed');
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(await f.run()).toMatchObject({ result: { account: 'Bearer account-b' } });
  });

  it('checks again before HTTP after authentication awaits', async () => {
    const f = fixture();
    f.api.decodeAuth.mockImplementationOnce(async record => {
      f.replace(); return { type: 'bearer', token: record.auth_ciphertext };
    });
    await expect(f.run()).rejects.toThrow('account changed');
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ result: { account: 'Bearer account-b' } });
  });

  it.each(['path', 'connection_kind'] as const)('refuses a changed %s reference before dispatching a cache miss', async field => {
    const f = fixture();
    const config = { crm_connection: 'sales', request_path: '/contacts/42', transport: 'api' };
    f.manifests.register({ ...manifest, input: { ...manifest.input,
      path: '{{config.request_path}}', connection_kind: '{{config.transport}}' } });
    const cache = f.cache(); const get = cache.get.bind(cache);
    vi.spyOn(cache, 'get').mockImplementationOnce(async key => {
      const entry = await get(key);
      if (field === 'path') config.request_path = '/contacts/99';
      else config.transport = 'mcp';
      return entry;
    });
    const set = vi.spyOn(cache, 'set');
    const bound = createBoundExecutor({ manifests: f.manifests, connectionStore: f.connections(),
      connectionApi: f.api, cacheStore: cache, instanceId: 'fixture' },
    createNamespaceStores({}, config, {}), { recipe_id: 'mutable-request', recipe_ttl: 300 });
    await expect(bound(manifest.slug, {})).rejects.toMatchObject({ code: 'CONNECTION_REFUSED',
      details: { reason: 'cache_input_changed' } });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('checks the request before privacy masking and preserves cache hits for unchanged inputs', async () => {
    const f = fixture(); const bound = f.executor();
    f.fetchImpl.mockImplementationOnce(async (_url, init) => new Response(JSON.stringify({
      account: new Headers(init?.headers).get('authorization'),
      email: new URL(String(_url)).searchParams.get('email'),
    }), { headers: { 'content-type': 'application/json' } }));
    const run = () => bound(manifest.slug, { 'query.email': 'person@example.test' },
      undefined, { pii_fields: ['query.email'] });
    expect(await run()).toMatchObject({ result: { email: 'person@example.test' } });
    expect(await run()).toMatchObject({ result: { email: 'person@example.test' } });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(new URL(String(f.fetchImpl.mock.calls[0]![0])).searchParams.get('email')).toMatch(/^HASH_STEP_/);
  });

  it('refuses an obsolete credential row returned by an asynchronous store lookup', async () => {
    const f = fixture(); let providerLookup = false;
    const store = { get: async (kind: 'api' | 'mcp' | 'notification', name: string) => {
      const row = f.connections().get(kind, name);
      if (providerLookup) { providerLookup = false; return { ...row!, auth_ciphertext: 'obsolete-other-account' }; }
      return row;
    } };
    const bound = createBoundExecutor({ manifests: f.manifests, connectionStore: store, connectionApi: f.api,
      cacheStore: f.cache(), instanceId: 'fixture' }, createNamespaceStores({}, { crm_connection: 'sales' }, {}),
    { recipe_id: 'async-store', recipe_ttl: 300 }, status => { if (status === 'miss') providerLookup = true; });
    await expect(bound(manifest.slug, {})).rejects.toThrow('account changed');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps concurrently running accounts in separate cache and dispatch contexts', async () => {
    const f = fixture();
    f.connections().upsert({ ...f.current(), name: 'personal', auth_ciphertext: 'account-p' });
    const bound = f.executor();
    const [salesResult, personalResult] = await Promise.all([
      bound(manifest.slug, { connection: 'sales' }), bound(manifest.slug, { connection: 'personal' }),
    ]);
    expect(salesResult).toMatchObject({ result: { account: 'Bearer account-a' } });
    expect(personalResult).toMatchObject({ result: { account: 'Bearer account-p' } });
    await Promise.all([bound(manifest.slug, { connection: 'sales' }), bound(manifest.slug, { connection: 'personal' })]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('cannot consume a previous account peer entry (misrouted=%s)', async misrouted => {
    const f = fixture(); const entries = new Map<string, CacheEntry>(); const requested: string[] = [];
    let original: CacheEntry | undefined;
    const transport = { connected: () => true, getEntry: vi.fn(async (key: string) => {
      requested.push(key); return misrouted && original ? original : entries.get(key) ?? null;
    }), putEntries: async () => {}, getSince: async () => ({ entries: [], next_cursor: null }) };
    const peer = wrapStoreWithPeer(createInMemoryStore(), { transport, setTimer: () => () => {} });
    const set = vi.spyOn(peer, 'set'); await f.run(peer);
    original = set.mock.calls[0]![0]; entries.set(original.key, original);
    f.replace(); expect(await f.run(peer)).toMatchObject({ result: { account: 'Bearer account-b' } });
    expect(requested).toHaveLength(2); expect(requested[0]).not.toBe(requested[1]);
    expect(requested.every(key => key.startsWith('v2:'))).toBe(true);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });
});
