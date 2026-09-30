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
  // D-247 — required so a store double cannot silently miss the grant seam.
  addOnMutated: () => {},
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

/** D-319 — the dishes each recipe is switched on as: one timer per dish. */
const makeDishes = (dishes: Array<{ dish_id: string; recipe_id: string; enabled?: boolean }>) => ({
  get: (dish_id: string) => {
    const dish = dishes.find((d) => d.dish_id === dish_id);
    return dish ? ({ ...dish, enabled: dish.enabled ?? true } as never) : null;
  },
  listByRecipe: (recipe_id: string) =>
    dishes.filter((d) => d.recipe_id === recipe_id).map((d) => ({ ...d, enabled: d.enabled ?? true }) as never),
});

describe('createAutoRunSettingsStore — a dish’s timer (D-319)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('a dish with no timer is off; switching makes its row, idempotently', () => {
    const store = createAutoRunSettingsStore(db);

    expect(store.isEnabled('dsh_a')).toBe(false);
    expect(store.get('dsh_a')).toBeNull();
    store.setEnabled('dsh_a', 'r', true);
    store.setEnabled('dsh_a', 'r', true);
    expect(store.isEnabled('dsh_a')).toBe(true);
    expect(store.ownerEnabled('dsh_a')).toBe(true);
    expect(store.get('dsh_a')).toEqual({ dish_id: 'dsh_a', recipe_id: 'r', enabled: true });

    store.setEnabled('dsh_a', 'r', false);
    expect(store.isEnabled('dsh_a')).toBe(false);
    store.setEnabled('dsh_b', 'r', true);
    store.setEnabled('dsh_c', 'other', true);
    expect(store.list().map((t) => [t.dish_id, t.enabled])).toEqual([['dsh_a', false], ['dsh_b', true], ['dsh_c', true]]);
  });

  it('forgets one dish’s timer, or every timer of an uninstalled recipe', () => {
    const store = createAutoRunSettingsStore(db);
    store.setEnabled('dsh_a', 'r', true);
    store.setEnabled('dsh_b', 'r', true);
    store.setEnabled('dsh_c', 'other', true);
    expect(store.forget!('dsh_a')).toBe(true);
    expect(store.forget!('dsh_a')).toBe(false);
    expect(store.forgetRecipe!('r')).toBe(1);
    expect(store.list().map((t) => t.dish_id)).toEqual(['dsh_c']);
  });

  it('drops the per-recipe table it replaces — a timer the owner never switched on as a dish does not start', () => {
    db.exec(`CREATE TABLE auto_run_settings (recipe_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
      INSERT INTO auto_run_settings VALUES ('r', 1, 0);
      CREATE TABLE auto_run_circuit (recipe_id TEXT PRIMARY KEY, consecutive_failures INTEGER NOT NULL DEFAULT 0,
        auto_disabled INTEGER NOT NULL DEFAULT 0, last_failure_at INTEGER, last_failure_reason TEXT);`);
    createAutoRunSettingsStore(db);
    createCircuitBreakerStore(db);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).not.toContain('auto_run_settings');
    expect(tables).not.toContain('auto_run_circuit');
    expect(tables).toEqual(expect.arrayContaining(['auto_run_timers', 'auto_run_timer_circuit']));
  });
});

describe('createServerAutoRunScheduler — one timer per dish, and the onFired seam', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('a recipe with no dish runs nothing — installing starts nothing, whatever `default_enabled` says', async () => {
    const recipe = makeRecipe('r');
    recipe.auto_run = { interval_ms: 1_000, default_enabled: true };
    const handle = createServerAutoRunScheduler({
      recipeStore: makeRecipeStore([recipe]),
      execute: vi.fn(async (request: ExecuteRequest) => successResponse(request)),
      circuitStore: createCircuitBreakerStore(db),
      settingsStore: createAutoRunSettingsStore(db),
      dishStore: makeDishes([]),
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.start();
    expect(handle.roster.size).toBe(0);
    await handle.stop();
  });

  it('keys one timer per dish; a timer switched off, or a dish switched off, is not on the roster', async () => {
    const settingsStore = createAutoRunSettingsStore(db);
    const dishes = [
      { dish_id: 'dsh_work', recipe_id: 'r' },
      { dish_id: 'dsh_home', recipe_id: 'r' },
      { dish_id: 'dsh_off', recipe_id: 'r', enabled: false },
    ];
    settingsStore.setEnabled('dsh_work', 'r', true);
    settingsStore.setEnabled('dsh_off', 'r', true);
    const handle = createServerAutoRunScheduler({
      recipeStore: makeRecipeStore([makeRecipe('r')]),
      execute: vi.fn(async (request: ExecuteRequest) => successResponse(request)),
      circuitStore: createCircuitBreakerStore(db),
      settingsStore,
      dishStore: makeDishes(dishes),
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });

    await handle.start();
    expect([...handle.roster.keys()]).toEqual(['dsh_work']);
    expect(handle.roster.get('dsh_work')).toMatchObject({ recipe_id: 'r', dish_id: 'dsh_work' });

    settingsStore.setEnabled('dsh_home', 'r', true);
    await handle.refreshRoster();
    expect([...handle.roster.keys()].sort()).toEqual(['dsh_home', 'dsh_work']);
    await handle.stop();
  });

  it('fires AS the dish, and calls onFired with its recipe', async () => {
    let clock = 0;
    const onFired = vi.fn();
    const execute = vi.fn(async (request: ExecuteRequest) => successResponse(request));
    const settingsStore = createAutoRunSettingsStore(db);
    settingsStore.setEnabled('dsh_a', 'r', true);
    const handle = createServerAutoRunScheduler({
      recipeStore: makeRecipeStore([makeRecipe('r')]),
      execute,
      circuitStore: createCircuitBreakerStore(db),
      settingsStore,
      dishStore: makeDishes([{ dish_id: 'dsh_a', recipe_id: 'r' }]),
      onFired,
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    clock = 1_000;
    handle.roster.get('dsh_a')!.next_run_at = clock;

    await handle.tick();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ recipe_id: 'r', dish_id: 'dsh_a', trigger_source: 'auto_run' });
    expect(onFired).toHaveBeenCalledWith('r');
  });

  it('⛔ a dish switched off after the roster was built skips the tick — nothing ran, nothing failed', async () => {
    let clock = 0;
    const execute = vi.fn(async (request: ExecuteRequest) => successResponse(request));
    const settingsStore = createAutoRunSettingsStore(db);
    settingsStore.setEnabled('dsh_a', 'r', true);
    const dishes = [{ dish_id: 'dsh_a', recipe_id: 'r', enabled: true }];
    const circuitStore = createCircuitBreakerStore(db);
    const handle = createServerAutoRunScheduler({
      recipeStore: makeRecipeStore([makeRecipe('r')]),
      execute,
      circuitStore,
      settingsStore,
      dishStore: makeDishes(dishes),
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    dishes[0]!.enabled = false;
    clock = 1_000;
    handle.roster.get('dsh_a')!.next_run_at = clock;

    await handle.tick();

    expect(execute).not.toHaveBeenCalled();
    expect(circuitStore.get('dsh_a')?.consecutive_failures ?? 0).toBe(0);
  });

  it('⛔ with no injected executor, a fire rechecks the dish’s own timer before the pre-approval driver decides', async () => {
    // The roster was built while the timer was on; the owner paused it a
    // moment later. The server's own executor must hand the driver the
    // timer's state NOW, not "the recipe runs on a timer".
    let clock = 0;
    const settingsStore = createAutoRunSettingsStore(db);
    settingsStore.setEnabled('dsh_a', 'r', true);
    const seen: Array<{ dish_id: string | undefined; enabled: boolean }> = [];
    const driver = {
      autoRunEligible: (_dish_id: string, enabled: boolean) => enabled,
      executeAutoRun: vi.fn(async (request: ExecuteRequest, enabled: boolean) => {
        seen.push({ dish_id: request.dish_id, enabled });
        return null;
      }),
    };
    const handle = createServerAutoRunScheduler({
      recipeStore: makeRecipeStore([makeRecipe('r')]),
      executeDeps: { preapprovalDriver: driver } as never,
      circuitStore: createCircuitBreakerStore(db),
      settingsStore,
      dishStore: makeDishes([{ dish_id: 'dsh_a', recipe_id: 'r' }]),
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    expect(handle.roster.has('dsh_a')).toBe(true);
    settingsStore.setEnabled('dsh_a', 'r', false);
    clock = 1_000;
    handle.roster.get('dsh_a')!.next_run_at = clock;

    await handle.tick();

    expect(seen).toEqual([{ dish_id: 'dsh_a', enabled: false }]);
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
      dishStore: makeDishes([{ dish_id: 'dsh_a', recipe_id: 'r' }]),
      onFired,
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    clock = 1_000;
    handle.roster.get('dsh_a')!.next_run_at = clock;

    await expect(handle.tick()).resolves.toBeDefined();
    expect(onFired).toHaveBeenCalledWith('r');
  });
});
