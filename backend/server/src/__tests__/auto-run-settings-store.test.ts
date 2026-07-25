import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import {
  createAutoRunSettingsStore,
  createCircuitBreakerStore,
  createServerAutoRunScheduler,
} from '../auto-run-scheduler.js';
import type { RecipeStore } from '../recipe-store.js';
import type { ExecuteRequest, ExecuteResponse } from '../types.js';
import type { StoredRecipe } from '../types.js';

const makeRecipe = (recipe_id: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  auto_run: { interval_ms: 1_000 },
  metadata: {
    name: recipe_id,
    description: 'test',
    author: 'test',
    supported_platforms: ['test'],
  },
  steps: [],
} as unknown as RecipeDefinition);

const makeStoredRow = (recipe: RecipeDefinition): StoredRecipe => ({
  recipe_id: recipe.recipe_id,
  publisher_id: 'publisher',
  version: recipe.version,
  recipe_hash: 'hash',
  recipe_json: JSON.stringify(recipe),
  source: 'inline',
  installed_at: 0,
  pack_slug: null,
});

const makeRecipeStore = (recipes: RecipeDefinition[]): RecipeStore => ({
  get: (id) => recipes.find((r) => r.recipe_id === id) ?? null,
  getBundled: (id) => recipes.find((r) => r.recipe_id === id) ?? null,
  getStored: () => null,
  size: () => recipes.length,
  ids: () => recipes.map((r) => r.recipe_id),
  register: () => {},
  save: () => {},
  delete: () => false,
  listForPack: () => [],
  listStored: () => recipes.map(makeStoredRow),
  updateUpstream: () => {},
  setOnUpgrade: () => {},
  setOnMutated: () => {},
});

const successResponse = (request: ExecuteRequest): ExecuteResponse => ({
  recipe_id: request.recipe_id ?? 'r',
  recipe_hash: 'hash',
  success: true,
  output: { sidebar: [] },
  errors: [],
  steps: [],
  duration_ms: 1,
  validation_issues: [],
} as unknown as ExecuteResponse);

describe('createAutoRunSettingsStore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('defaults unknown recipes to enabled and roundtrips explicit disabled state idempotently', () => {
    const store = createAutoRunSettingsStore(db);

    expect(store.isEnabled('r')).toBe(true);
    expect(store.isEnabled('owner-armed', false)).toBe(false);
    store.setEnabled('r', false);
    store.setEnabled('r', false);
    expect(store.isEnabled('r')).toBe(false);
    expect(store.listDisabled()).toEqual(['r']);

    store.setEnabled('r', true);
    store.setEnabled('r', true);
    expect(store.isEnabled('r')).toBe(true);
    expect(store.listDisabled()).toEqual([]);
  });

  it('keeps a fresh config dish at the recipe default until explicit enable', () => {
    const store = createAutoRunSettingsStore(db);

    store.setDishId('owner-armed', 'dish-1', false);
    expect(store.getDishId('owner-armed')).toBe('dish-1');
    expect(store.isEnabled('owner-armed', false)).toBe(false);
    expect(store.listDisabled()).toEqual(['owner-armed']);

    store.setEnabled('owner-armed', true);
    store.setDishId('owner-armed', 'dish-2', false);
    expect(store.getDishId('owner-armed')).toBe('dish-2');
    expect(store.isEnabled('owner-armed', false)).toBe(true);
  });
});

describe('createServerAutoRunScheduler settingsStore and onFired seams', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('excludes user-disabled auto-run recipes from the roster until re-enabled', async () => {
    const settingsStore = createAutoRunSettingsStore(db);
    settingsStore.setEnabled('r', false);
    const handle = createServerAutoRunScheduler({
      recipeStore: makeRecipeStore([makeRecipe('r')]),
      execute: vi.fn(async (request: ExecuteRequest) => successResponse(request)),
      circuitStore: createCircuitBreakerStore(db),
      settingsStore,
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });

    await handle.start();
    await handle.refreshRoster();
    expect(handle.roster.has('r')).toBe(false);

    settingsStore.setEnabled('r', true);
    await handle.refreshRoster();
    expect(handle.roster.has('r')).toBe(true);
    await handle.stop();
  });

  it('excludes a default-disabled recipe from an otherwise empty settings store', async () => {
    const settingsStore = createAutoRunSettingsStore(db);
    const recipe = makeRecipe('owner-armed');
    recipe.auto_run = {
      interval_ms: 1_000,
      default_enabled: false,
    };
    const handle = createServerAutoRunScheduler({
      recipeStore: makeRecipeStore([recipe]),
      execute: vi.fn(async (request: ExecuteRequest) => successResponse(request)),
      circuitStore: createCircuitBreakerStore(db),
      settingsStore,
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });

    await handle.start();
    await handle.refreshRoster();
    expect(handle.roster.has('owner-armed')).toBe(false);

    settingsStore.setEnabled('owner-armed', true);
    await handle.refreshRoster();
    expect(handle.roster.has('owner-armed')).toBe(true);
    await handle.stop();
  });

  it('calls onFired after one due tick', async () => {
    let clock = 0;
    const onFired = vi.fn();
    const execute = vi.fn(async (request: ExecuteRequest) => successResponse(request));
    const handle = createServerAutoRunScheduler({
      recipeStore: makeRecipeStore([makeRecipe('r')]),
      execute,
      circuitStore: createCircuitBreakerStore(db),
      onFired,
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    clock = 1_000;
    handle.roster.get('r')!.next_run_at = clock;

    await handle.tick();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(onFired).toHaveBeenCalledWith('r');
  });

  it('swallows onFired errors so tick still completes', async () => {
    let clock = 0;
    const onFired = vi.fn(() => {
      throw new Error('listener failed');
    });
    const handle = createServerAutoRunScheduler({
      recipeStore: makeRecipeStore([makeRecipe('r')]),
      execute: vi.fn(async (request: ExecuteRequest) => successResponse(request)),
      circuitStore: createCircuitBreakerStore(db),
      onFired,
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    clock = 1_000;
    handle.roster.get('r')!.next_run_at = clock;

    await expect(handle.tick()).resolves.toBeDefined();
    expect(onFired).toHaveBeenCalledWith('r');
  });
});
