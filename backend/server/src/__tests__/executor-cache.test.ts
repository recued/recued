import { connectionRevision } from '../connection-revision.js';
/** End-to-end test: the server executor memoizes ingredient calls when
 *  a cache store is wired in.
 *
 *  Approach: build ServerExecutorConfig with cacheStore + instanceId +
 *  a fake HTTP adapter that counts invocations. Call createBoundExecutor
 *  twice with the same recipe context + same inputs; verify the HTTP
 *  adapter ran exactly once (second call = cache hit).
 *
 *  Directly tests that the cache threading we added in this phase
 *  actually flows through createBoundExecutor → withIngredientCache →
 *  SQLite cache store → blob store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { IngredientManifest, EntitySchemaIngredientInput, RecipeDefinition, ConnectionRow, Commit } from '@recued/contracts';
import { executeRecipe } from '@recued/engine';
import { wrapWithCommitGateway } from '@recued/gateway';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';
import { cacheAwareGatewayInner, observeCacheStatus } from '../commit-gateway-wiring.js';
import { createRecordOutputSources } from '../record-output-source.js';
import { recordOutputSourceCache } from '../record-output-source-cache.js';
import { createBoundExecutor, createNamespaceStores, type ServerExecutorConfig } from '../server-executor.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createSQLiteCacheStore } from '../storage/index.js';
import { createConnectionStore } from '../storage/connection-store.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'recued-exec-cache-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// D-112 note: `url` is engine-locked, so we declare it in the
// manifest rather than expecting the recipe to override it via step
// input. Tests below pass a `url` field in step input for historical
// reasons; D-112 C3 silently strips that at dispatch and the manifest
// value wins — which is what these caching tests exercise.
const mkManifest = (slug: string, category: 'data' | 'ai' | 'action' = 'data'): IngredientManifest => ({
  slug,
  name: slug,
  description: 'test',
  author: 'test',
  kind: 'http',
  version: 1,
  category,
  risk_tier: category === 'action' ? 'write' : 'read',
  input: { method: 'GET', url: 'https://example.com/fixture' },
  output: { 'data.id': 'id' },
});

describe('server executor + cache — memoizes across calls', () => {
  it.each(['hit', 'miss'])('refuses changed page accounts across an asynchronous cache %s', async mode => {
    const db = new Database(':memory:');
    const cacheStore = createSQLiteCacheStore(db, createBlobStore(join(workDir, 'guard-blobs')));
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register(mkManifest('guard-reader'));
    const originalFetch = globalThis.fetch;
    const fetchImpl = vi.fn(async () => new Response('{"data":{"id":"42"}}', { headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchImpl;
    try {
      let changed = false;
      const config = { manifests, cacheStore, instanceId: 'fixture' };
      const stores = createNamespaceStores({}, {}, {});
      const context = { recipe_id: 'guard-fixture', recipe_ttl: 300 };
      await createBoundExecutor(config, stores, context)('guard-reader', {});
      const get = cacheStore.get.bind(cacheStore);
      vi.spyOn(cacheStore, 'get').mockImplementation(async (...args) => {
        const result = await get(...args);
        changed = true;
        return mode === 'miss' ? null : result;
      });
      const guarded = createBoundExecutor(config, stores, context, undefined, undefined,
        () => { if (changed) throw new Error('Account changed'); });
      await expect(guarded('guard-reader', {})).rejects.toThrow('Account changed');
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally { globalThis.fetch = originalFetch; db.close(); }
  });

  it('same inputs on second call skip the HTTP adapter (cache hit)', async () => {
    const db = new Database(join(workDir, 'test.db'));
    db.pragma('journal_mode = WAL');

    const blobs = createBlobStore(join(workDir, 'blobs'));
    const cacheStore = createSQLiteCacheStore(db, blobs);

    const manifests = createManifestRegistry();
    manifests.register(mkManifest('test-data-reader', 'data'));

    // We need to spy on the HTTP adapter. The simplest path: patch the
    // global fetch that the HTTP adapter uses. Since ingredient dispatch
    // imports executeHTTP which calls fetch, stubbing globalThis.fetch
    // intercepts there.
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: unknown) => {
      fetchCalls++;
      return new Response(JSON.stringify({ data: { id: 'id-42' } }), {
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response;
    };

    try {
      const config: ServerExecutorConfig = {
        manifests,
        cacheStore,
        instanceId: 'pair-test',
      };
      const stores = createNamespaceStores({}, {}, {});
      const cached = vi.fn(); const stored = vi.fn();
      const resultEvidence = vi.fn(() => ({ cached, stored }));
      const executor = createBoundExecutor(config, stores, {
        recipe_id: 'test-recipe',
        recipe_ttl: 300,
      }, undefined, resultEvidence);

      const input = { url: 'https://example.com/deal/42' };

      const r1 = await executor('test-data-reader', input);
      const r2 = await executor('test-data-reader', input);

      expect(fetchCalls).toBe(1); // second call hit the cache
      expect(r1).toEqual(r2);
      expect(resultEvidence).toHaveBeenCalledTimes(2);
      expect(cached).toHaveBeenCalledOnce();
      expect(stored).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

  it('action ingredients are never cached (always hit the adapter)', async () => {
    const db = new Database(join(workDir, 'test.db'));
    db.pragma('journal_mode = WAL');

    const blobs = createBlobStore(join(workDir, 'blobs'));
    const cacheStore = createSQLiteCacheStore(db, blobs);

    const manifests = createManifestRegistry();
    manifests.register(mkManifest('test-writer', 'action'));

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response;
    };

    try {
      const config: ServerExecutorConfig = {
        manifests,
        cacheStore,
        instanceId: 'pair-test',
      };
      const stores = createNamespaceStores({}, {}, {});
      const executor = createBoundExecutor(config, stores, {
        recipe_id: 'write-recipe',
        recipe_ttl: 300,
      });

      await executor('test-writer', { url: 'https://example.com/do' });
      await executor('test-writer', { url: 'https://example.com/do' });

      expect(fetchCalls).toBe(2); // both calls reached the adapter
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

  it('without cache config, executor runs uncached (baseline)', async () => {
    const manifests = createManifestRegistry();
    manifests.register(mkManifest('test-data-reader', 'data'));

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ data: { id: 'x' } }), {
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response;
    };

    try {
      const config: ServerExecutorConfig = { manifests };
      const stores = createNamespaceStores({}, {}, {});
      // No recipeContext → no cache wrap even if cacheStore were set
      const executor = createBoundExecutor(config, stores);

      await executor('test-data-reader', { url: 'https://example.com/deal/1' });
      await executor('test-data-reader', { url: 'https://example.com/deal/1' });

      expect(fetchCalls).toBe(2); // no memoization
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


describe('API source evidence through the bound executor and commit gateway', () => {
  it('retains provenance across cache hits and SQLite restart with recursive triggers enabled', async () => {
    const filename = join(workDir, 'catalog.db');
    let db = new Database(filename);
    db.pragma('recursive_triggers = ON');
    const catalog = 'fixture-crm';
    const manifest: IngredientManifest = { slug: catalog, version: 3, name: 'CRM', description: '', author: 'local',
      kind: 'connection', category: 'data', risk_tier: 'read', input: {}, output: {},
      operations: { read: { operation_id: `${catalog}.read`, risk_tier: 'read', groups: [] } },
      surfaces: { api: { transport: 'rest', default_base_url: 'https://api.example.test', auth: { kind: 'none' },
        executes: { read: { kind: 'rest', method: 'GET', path_template: '/contacts/{{id}}' } } } } };
    const schema: EntitySchemaIngredientInput = { ingredient_id: catalog, wraps_vendor: 'hubspot', entity_id: 'contact',
      scope: 'connection.api.hubspot.contact', projection_mode: 'platform_reference', schema_mode: 'static', meta_fields: [],
      target_id: { fields: ['id'], template: 'contact_{id}' }, source_operations: { get: { catalog, operation: 'read' } } };
    const recipe: RecipeDefinition = { recipe_id: 'contact-page', version: 1, ttl: 300, variables: {}, requires: [catalog],
      metadata: { name: 'Contact', description: '', author: 'local', supported_platforms: ['hubspot'] }, prefetch_steps: [],
      steps: [{ id: 'fetch', ingredient: catalog, ingredient_version: 3, input: { operation: 'read', connection: 'sales', args: { id: '42' } } }],
      output: { render: [{ type: 'record_fields', source: 'step.fetch.result', entity: 'contact' }] } };
    const row: ConnectionRow = { pk: 'api:sales', kind: 'api', name: 'sales', display_name: 'Sales',
      config_json: JSON.stringify({ base_url: 'https://api.example.test', vendor: 'hubspot' }),
      auth_ciphertext: 'synthetic-fixture', enrolled_at: 1, updated_at: 1 };
    const manifests = createManifestRegistry('/nonexistent'); manifests.register(manifest);
    const commits = createCommitStore(createInMemoryCollection<Commit>());
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: '42', email: 'ana@example.test' }),
      { headers: { 'content-type': 'application/json' } }));
    const run = async (number: number, uncached = false, expectSource = true, invalidateHit = false) => {
      const connections = createConnectionStore(db);
      connections.upsert(row);
      const cache = createSQLiteCacheStore(db, createBlobStore(join(workDir, 'blobs')));
      const trace = createRecordOutputSources({ recipe, manifest: (slug, version) => manifests.get(slug, version),
        schemas: () => [schema], connectionVendor: () => 'hubspot', connectionIdentity: () => row,
        cacheEvidence: recordOutputSourceCache(cache, db) });
      const stores = createNamespaceStores({}, {}, {});
      if (invalidateHit) db.exec('DELETE FROM record_output_cache_sources');
      let retired = false;
      const onStatus: NonNullable<import('@recued/ingredients').IngredientCacheOptions['onStatus']> = (status, context) => {
        observeCacheStatus(status, context);
        if (invalidateHit && !retired && status === 'hit') {
          retired = true; connections.beginReadCacheWrite!('api', 'sales')(true);
        }
      };
      const bound = createBoundExecutor({ manifests, ...(uncached ? {} : { cacheStore: cache }), instanceId: 'fixture',
        connectionStore: connections, connectionApi: {
          decodeAuth: async () => ({ type: 'none' }), persistAuth: async () => {}, fetchImpl,
        } }, stores, { recipe_id: recipe.recipe_id, recipe_ttl: 300 }, onStatus, trace.resultEvidence);
      const executor = wrapWithCommitGateway(cacheAwareGatewayInner(bound), { commitStore: commits,
        getIngredientCategory: () => 'data', getManifest: slug => manifests.get(slug) ?? undefined,
        identity: { request_id: `request-${number}`, source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'fixture' },
          channel_session_id: 'user:fixture', correlation_id: `run-${number}`, dispatch_depth: 0 } });
      const result = await executeRecipe({ recipe, stores, ingredientExecutor: executor,
        manifestGetter: (slug, version) => manifests.get(slug, version),
        connectionProfileResolver: () => ({ catalog_slug: catalog, allowed_operations: ['read'] }),
        entityFields: () => [{ key: 'id', type: 'string', required: true }],
        onGatewayCall: trace.observe, recordOutputSource: trace.source });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      if (expectSource) expect(result.output.render[0]?.record_source).toEqual({ kind: 'api', platform: 'hubspot', connection_name: 'sales', entity: 'contact', connection_revision: connectionRevision(row) });
      else expect(result.output.render[0]?.record_source).toBeUndefined();
      return result.output;
    };
    try {
      const initial = await run(1);
      expect(await run(2)).toEqual(initial);
      db.close(); db = new Database(filename); db.pragma('recursive_triggers = ON');
      expect(await run(3)).toEqual(initial);
      expect(fetchImpl).toHaveBeenCalledOnce();
      const rows = await commits.listByRun('request-3');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.cached).toBe(true);
      fetchImpl.mockImplementationOnce(async () => {
        row.enrolled_at += 1;
        return new Response(JSON.stringify({ id: '42' }), { headers: { 'content-type': 'application/json' } });
      });
      await run(4, true, false);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // A new account revision gets a fresh value and new private provenance;
      // subsequent runs may reuse only this revision's entry and receipt.
      const replacement = await run(5);
      expect(await run(6)).toEqual(replacement);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(await run(7, false, true, true)).toEqual(replacement);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      const recovered = await commits.listByRun('request-7');
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.cached).not.toBe(true);
      expect(await run(8)).toEqual(replacement);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect((await commits.listByRun('request-8'))[0]?.cached).toBe(true);
    } finally { db.close(); }
  });
});
