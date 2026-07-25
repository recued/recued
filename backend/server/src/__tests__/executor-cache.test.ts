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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { IngredientManifest } from '@recued/contracts';
import { createBoundExecutor, createNamespaceStores, type ServerExecutorConfig } from '../server-executor.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createSQLiteCacheStore } from '../storage/index.js';

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
      const executor = createBoundExecutor(config, stores, {
        recipe_id: 'test-recipe',
        recipe_ttl: 300,
      });

      const input = { url: 'https://example.com/deal/42' };

      const r1 = await executor('test-data-reader', input);
      const r2 = await executor('test-data-reader', input);

      expect(fetchCalls).toBe(1); // second call hit the cache
      expect(r1).toEqual(r2);
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
