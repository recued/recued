/** R2 build step 4c.4 — emit-WIRING tests.
 *
 *  The broadcaster itself (recompute + best-effort swallow + recompute-on-emit) is
 *  unit-tested in `recipe-runnability-handler.test.ts`. THESE tests pin that each
 *  MUTATION HANDLER actually calls its injected `recipeRunnabilityBroadcast`
 *  AFTER the mutation, with the correct GATING — via a capturing fake broadcaster
 *  (call counter). They cover the sites with CONDITIONAL logic (connection
 *  enroll/delete are `api`-gated) plus the pack-install mutation path; the
 *  unconditional grant/revoke (after `reseedOperationProfile`) + pack-uninstall
 *  (after the reconcile loop) call sites are verified by the type-checked wiring +
 *  the existing handler suites (they reuse the identical post-mutation call shape).
 *
 *  The fake never throws — the realistic case. Production only ever injects
 *  `makeRecipeRunnabilityBroadcaster`, whose `recomputeAndEmit` swallows internally
 *  (the best-effort contract, proven by its own unit tests); the call sites trust
 *  that contract rather than re-wrapping.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type BulkPackManifest,
  type ConnectionAuth,
} from '@recued/contracts';

import { createConnectionStore, type ConnectionStoreSqlite } from '../storage/connection-store.js';
import { handleConnectionDelete, handleConnectionEnroll } from '../connection-handler.js';
import { handlePacksInstall } from '../pack-install-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import type { RecipeRunnabilityBroadcaster } from '../recipe-runnability-handler.js';

/** A capturing broadcaster fake — counts `recomputeAndEmit()` calls. */
const capturingBroadcaster = (): { b: RecipeRunnabilityBroadcaster; calls: () => number } => {
  let calls = 0;
  return {
    b: {
      recomputeAndEmit: () => {
        calls += 1;
      },
    },
    calls: () => calls,
  };
};

const bearer = (token: string): ConnectionAuth => ({ type: 'bearer', token });

describe('4c.4 emit wiring — connection mutations (api-gated)', () => {
  let dir: string;
  let db: Database.Database;
  let store: ConnectionStoreSqlite;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runnability-emit-conn-'));
    db = new Database(join(dir, 'test.db'));
    store = createConnectionStore(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('enroll of an `api` connection recomputes + broadcasts', async () => {
    const { b, calls } = capturingBroadcaster();
    await handleConnectionEnroll(
      { store, recipeRunnabilityBroadcast: b },
      { name: 'hs', kind: 'api', display_name: 'HS', config: {}, auth: bearer('t') },
    );
    expect(calls()).toBe(1);
  });

  it('enroll of a NON-api (mcp) connection does NOT broadcast (api-gated)', async () => {
    const { b, calls } = capturingBroadcaster();
    await handleConnectionEnroll(
      { store, recipeRunnabilityBroadcast: b },
      { name: 'mcp1', kind: 'mcp', subtype: 'sse', display_name: 'MCP', config: {}, auth: bearer('t') },
    );
    expect(calls()).toBe(0);
  });

  it('delete of an existing `api` connection recomputes + broadcasts', async () => {
    const { b, calls } = capturingBroadcaster();
    await handleConnectionEnroll(
      { store },
      { name: 'hs', kind: 'api', display_name: 'HS', config: {}, auth: bearer('t') },
    );
    await handleConnectionDelete(
      { store, recipeRunnabilityBroadcast: b },
      { name: 'hs', kind: 'api' },
    );
    expect(calls()).toBe(1);
  });

  it('delete of a NON-EXISTENT connection does NOT broadcast (nothing removed)', async () => {
    const { b, calls } = capturingBroadcaster();
    await handleConnectionDelete(
      { store, recipeRunnabilityBroadcast: b },
      { name: 'ghost', kind: 'api' },
    );
    expect(calls()).toBe(0);
  });

  it('delete of an existing NON-api (mcp) connection does NOT broadcast (api-gated)', async () => {
    const { b, calls } = capturingBroadcaster();
    await handleConnectionEnroll(
      { store },
      { name: 'mcp1', kind: 'mcp', subtype: 'sse', display_name: 'MCP', config: {}, auth: bearer('t') },
    );
    await handleConnectionDelete(
      { store, recipeRunnabilityBroadcast: b },
      { name: 'mcp1', kind: 'mcp' },
    );
    expect(calls()).toBe(0);
  });
});

describe('4c.4 emit wiring — pack install', () => {
  let dir: string;
  let db: Database.Database;
  let recipeStore: RecipeStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runnability-emit-pack-'));
    db = new Database(':memory:');
    writeFileSync(
      join(dir, 'alpha-recipe.json'),
      JSON.stringify({
        recipe_id: 'alpha-recipe',
        version: 1,
        ttl: 60,
        metadata: {
          name: 'alpha',
          description: 'fixture',
          author: 'recued-core',
          supported_platforms: [],
          tags: [],
        },
        steps: [],
        output: { sidebar: [] },
      }),
    );
    recipeStore = createRecipeStore(dir, db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const manifest = (): BulkPackManifest => ({
    manifest_version: BULK_INSTALL_PACK_VERSION,
    slug: 'runnability-emit-pack',
    publisher: 'recued-core',
    name: 'Runnability Emit Pack',
    description: 'fixture',
    version: 1,
    recipes: [{ slug: 'alpha-recipe', version: 1 }],
    requires: [BULK_PACK_INSTALL_PERMISSION],
    tags: [],
  });

  it('a successful install recomputes + broadcasts runnability', async () => {
    const { b, calls } = capturingBroadcaster();
    const { result } = await handlePacksInstall(
      { recipeStore, recipeRunnabilityBroadcast: b },
      { manifest: manifest(), granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok).toBe(true);
    expect(calls()).toBe(1);
  });
});
