/** D-119 Phase 5 — `recipe.list` rpc handler tests.
 *
 *  Covers:
 *    - bundled-only store returns recued-core publisher attribution
 *    - SQLite-stored row wins over a same-id bundled row (user choice)
 *    - inline-registered (memory override) recipes are NOT returned
 *    - sort order: most recent first, alphabetical tiebreaker
 *    - serverStartedAt fallback for bundled `installed_at`
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { RecipeDefinition } from '@recued/contracts';
import { createRecipeStore } from '../recipe-store.js';
import { listServerRecipes } from '../recipe-list-handler.js';

const recipe = (id: string, version = 1): RecipeDefinition => ({
  recipe_id: id,
  version,
  ttl: 60,
  metadata: {
    name: `Test ${id}`,
    description: 'fixture',
    author: 'test',
    supported_platforms: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

/** A kernel recipe is marked by `metadata.author === 'recued'` — the same marker
 *  `chat-tool-handlers` and `mcp-server` filter on. */
const kernelRecipe = (id: string): RecipeDefinition => ({
  ...recipe(id),
  metadata: { ...recipe(id).metadata, author: 'recued' },
} as unknown as RecipeDefinition);

const SERVER_STARTED_AT = 1_700_000_000_000;

describe('listServerRecipes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('⛔⛔ A KERNEL RECIPE IS NOT LISTED — `#recipes` IS the manage UI', () => {
    // Reported from a live webclient: kernel recipes showing on the Recipes page.
    // CLAUDE.md's publisher table says the `recued` namespace is "invisible in
    // marketplace / install / manage UI"; the rule was enforced at the chat catalog
    // door and the MCP door, over this SAME store, and missing at this one.
    const store = createRecipeStore('/nonexistent', db);
    store.save(kernelRecipe('memory-embed'), 'recued-core', 'pair-sync', 1_700_001_000_000);
    store.save(recipe('detect-deal-risk'), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes.map((r) => r.recipe_id)).toEqual(['detect-deal-risk']);
  });

  it('⛔ THE MARKER IS metadata.author, NOT the emitted publisher_id', () => {
    // The bundled branch HARDCODES `publisher_id: 'recued-core'`, so a kernel recipe
    // is emitted under the same publisher as first-party marketplace content. A filter
    // written against the emitted field would match nothing and look like it worked.
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('ordinary'), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const listed = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT }).recipes;
    expect(listed).toHaveLength(1);
    expect(listed[0].publisher_id).toBe('recued-core');
    expect(listed[0].recipe.metadata.author).toBe('test');
  });

  it('returns SQLite-stored recipes with their stored hash + version + source', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('detect-deal-risk', 3), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      recipe_id: 'detect-deal-risk',
      publisher_id: 'recued-core',
      version: 3,
      source: 'pair-sync',
      installed_at: 1_700_001_000_000,
    });
    expect(result.recipes[0].recipe_hash).toMatch(/^[a-f0-9]{8,}/);
  });

  it('returns bundled recipes with serverStartedAt fallback + recued-core publisher', () => {
    const store = createRecipeStore('/nonexistent');
    store.register(recipe('bundled-fixture', 1));
    // Hack: register() is the only way to make a recipe show up in
    // ids() without a real on-disk bundle dir. The handler treats
    // anything from ids()-not-in-listStored() as bundled.

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      recipe_id: 'bundled-fixture',
      publisher_id: 'recued-core',
      source: 'bundled',
      installed_at: SERVER_STARTED_AT,
    });
  });

  it('⛔⛔ AND A BUNDLED KERNEL RECIPE IS EXCLUDED — this is the branch that fires', () => {
    // ⚠ THE PRODUCTION PATH IS THE BUNDLED ONE. Kernel recipes are never in
    // `installRegistry`, so they reach `ids()` and never `listStored()`; a filter that
    // only covered the stored branch would have passed its test and fixed nothing.
    const store = createRecipeStore('/nonexistent');
    store.register(kernelRecipe('run-ingredient'));
    store.register(recipe('bundled-fixture', 1));

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes.map((r) => r.recipe_id)).toEqual(['bundled-fixture']);
  });

  it('SQLite row wins when the same id exists in both bundled + db', () => {
    const store = createRecipeStore('/nonexistent', db);
    // "Bundled" via register so the in-memory map lights up the id.
    store.register(recipe('shared-id', 1));
    // SQLite save with a different version.
    store.save(recipe('shared-id', 7), 'someone-else', 'pair-sync', 1_700_005_000_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      recipe_id: 'shared-id',
      publisher_id: 'someone-else',
      version: 7,
      source: 'pair-sync',
      installed_at: 1_700_005_000_000,
    });
  });

  it('sorts most-recent first, alphabetical tiebreaker', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('zebra'), 'p', 'pair-sync', 1_000);
    store.save(recipe('alpha'), 'p', 'pair-sync', 2_000);
    store.save(recipe('beta'), 'p', 'pair-sync', 2_000);
    store.save(recipe('gamma'), 'p', 'pair-sync', 3_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });

    expect(result.recipes.map((r) => r.recipe_id)).toEqual([
      'gamma', // most recent
      'alpha', // tied at 2000 — alphabetical first
      'beta',  // tied at 2000
      'zebra',
    ]);
  });

  it('returns an empty list when no recipes are registered or stored', () => {
    const store = createRecipeStore('/nonexistent', db);
    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });
    expect(result.recipes).toEqual([]);
  });

  it('falls back to publisher_id="local" when SQLite row has empty publisher_id', () => {
    const store = createRecipeStore('/nonexistent', db);
    // Empty publisher_id (test fixture / older row).
    store.save(recipe('legacy'), '', 'pair-sync', 1_700_002_000_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });
    expect(result.recipes[0].publisher_id).toBe('local');
  });

  it('embeds the full RecipeDefinition for first-paint rendering', () => {
    const store = createRecipeStore('/nonexistent', db);
    store.save(recipe('detect-foo'), 'recued-core', 'pair-sync', 1_700_001_000_000);

    const result = listServerRecipes({ store, serverStartedAt: SERVER_STARTED_AT });
    expect(result.recipes[0].recipe).toMatchObject({
      recipe_id: 'detect-foo',
      metadata: expect.objectContaining({ name: 'Test detect-foo' }),
    });
  });
});
