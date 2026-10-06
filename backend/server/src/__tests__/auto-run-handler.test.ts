/** `auto_run.*` — one timer per dish (D-319).
 *
 *  A dish is an auto-run recipe switched on with its own settings, and it
 *  runs on its own timer: `auto_run.list` has a row per dish (the main one
 *  first) and one `dish_id: null` row for a recipe nobody switched on;
 *  `auto_run.update` pauses or re-arms one dish's timer, or — naming only a
 *  recipe — its main dish's, making it when there is none. Over the real
 *  dish, timer and circuit stores; the live scheduler handle is a fake. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import type { AutoRunEntry } from '@recued/scheduler';
import {
  listAutoRun,
  makeAutoRunHandlers,
  updateAutoRun,
  type AutoRunRpcDeps,
} from '../auto-run-handler.js';
import {
  createAutoRunSettingsStore,
  createCircuitBreakerStore,
  type ServerAutoRunHandle,
} from '../auto-run-scheduler.js';
import { createDish, mainDishFor, type DishHandlerDeps } from '../dish-handler.js';
import { createDishStore } from '../dish-store.js';
import type { StoredRecipe } from '../types.js';

const makeRecipe = (
  recipe_id: string,
  // `null` — a recipe that does not auto-run (an explicit `undefined` would
  // take the default and make it one).
  autoRun: RecipeDefinition['auto_run'] | null = { interval_ms: 1_000 },
  name?: string,
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  ...(autoRun ? { auto_run: autoRun } : {}),
  metadata: {
    name: name ?? recipe_id,
    description: 'test',
    author: 'test',
    supported_platforms: ['test'],
  },
  steps: [],
} as unknown as RecipeDefinition);

const storedRow = (recipe: RecipeDefinition): StoredRecipe => ({
  recipe_id: recipe.recipe_id,
  publisher_id: 'publisher',
  version: recipe.version,
  recipe_hash: 'hash',
  recipe_json: JSON.stringify(recipe),
  source: 'inline',
  installed_at: 0,
  pack_slug: null,
});

const liveEntry = (dish_id: string, recipe_id: string, over: Partial<AutoRunEntry> = {}): AutoRunEntry => ({
  recipe_id,
  dish_id,
  publisher_id: 'publisher',
  interval_ms: 1_000,
  dynamic: false,
  next_run_at: 0,
  consecutive_failures: 0,
  auto_disabled: false,
  process_id: 'p',
  ...over,
});

const makeHandle = (roster = new Map<string, AutoRunEntry>()) => ({
  roster,
  refreshRoster: vi.fn(async () => {}),
  resetCircuit: vi.fn(),
} as unknown as ServerAutoRunHandle);

let db: Database.Database;
let dishDeps: DishHandlerDeps;

beforeEach(() => {
  db = new Database(':memory:');
  let now = 1_000;
  dishDeps = { store: createDishStore(db), now: () => (now += 1) };
});
afterEach(() => { db.close(); });

const makeDeps = (rows: StoredRecipe[], overrides: Partial<AutoRunRpcDeps> = {}): AutoRunRpcDeps => {
  const handle = makeHandle();
  return {
    recipeStore: { listStored: vi.fn(() => rows) } as unknown as AutoRunRpcDeps['recipeStore'],
    settingsStore: createAutoRunSettingsStore(db),
    circuitStore: createCircuitBreakerStore(db),
    getHandle: vi.fn(() => handle),
    dishStore: dishDeps.store,
    mainDish: (input) => mainDishFor(dishDeps, input),
    eventBus: { emit: vi.fn() } as unknown as AutoRunRpcDeps['eventBus'],
    ...overrides,
  };
};

describe('auto_run.list — a row per dish’s timer', () => {
  it('merges each dish’s timer, circuit and live roster; the main dish first; a recipe with no dish is one row, off', () => {
    const unnamed = makeRecipe('unnamed', { interval_ms: 2_000, dynamic: true });
    delete (unnamed as { metadata?: unknown }).metadata;
    const manual = makeRecipe('manual', null);
    const main = createDish(dishDeps, { recipe_id: 'r', config_overlay: { channel: '#main' } }).dish;
    const other = createDish(dishDeps, { recipe_id: 'r', name: 'Other', config_overlay: { channel: '#other' } }).dish;
    const settingsStore = createAutoRunSettingsStore(db);
    settingsStore.setEnabled(main.dish_id, 'r', true);
    const circuitStore = createCircuitBreakerStore(db);
    circuitStore.set({ dish_id: other.dish_id, recipe_id: 'r', consecutive_failures: 3, auto_disabled: true,
      last_failure_at: 11, last_failure_reason: 'persisted' });
    const handle = makeHandle(new Map([[main.dish_id, liveEntry(main.dish_id, 'r', {
      next_run_at: 100, last_started_at: 90, last_finished_at: 95,
    })]]));
    const deps = makeDeps([
      storedRow(makeRecipe('r', { interval_ms: 1_000 }, 'The Recipe')),
      storedRow(unnamed),
      storedRow(manual),
      { ...storedRow(makeRecipe('bad-json')), recipe_json: '{not json' },
    ], { settingsStore, circuitStore, getHandle: vi.fn(() => handle) });

    expect(listAutoRun(deps).entries).toEqual([
      expect.objectContaining({
        recipe_id: 'r', dish_id: main.dish_id, dish_name: '', recipe_name: 'The Recipe', enabled: true,
        config_overlay: { channel: '#main' }, next_run_at: 100, last_started_at: 90, last_finished_at: 95,
        auto_disabled: false, consecutive_failures: 0,
      }),
      expect.objectContaining({
        recipe_id: 'r', dish_id: other.dish_id, dish_name: 'Other', enabled: false,
        config_overlay: { channel: '#other' }, auto_disabled: true, consecutive_failures: 3,
        last_failure_at: 11, last_failure_reason: 'persisted', next_run_at: null,
      }),
      expect.objectContaining({
        recipe_id: 'unnamed', dish_id: null, dish_name: null, recipe_name: null, enabled: false,
        interval_ms: 2_000, dynamic: true, config_overlay: {},
      }),
    ]);
  });

  it('⛔ installing starts nothing: a recipe with no dish lists off, whatever `default_enabled` says', () => {
    const deps = makeDeps([storedRow(makeRecipe('eager', { interval_ms: 900_000, default_enabled: true }))]);
    expect(listAutoRun(deps).entries).toEqual([
      expect.objectContaining({ recipe_id: 'eager', dish_id: null, enabled: false, next_run_at: null }),
    ]);
  });

  it('uses null live fields when the scheduler handle is unavailable', () => {
    const dish = createDish(dishDeps, { recipe_id: 'r' }).dish;
    const deps = makeDeps([storedRow(makeRecipe('r'))], { getHandle: vi.fn(() => undefined) });
    expect(listAutoRun(deps).entries).toEqual([
      expect.objectContaining({ dish_id: dish.dish_id, next_run_at: null, last_started_at: null, last_finished_at: null }),
    ]);
  });
});

describe('auto_run.update — one dish’s timer', () => {
  it.each([
    [{}, 'bad_request', 'dish_id (or recipe_id) is required'],
    [{ recipe_id: 123, enabled: true }, 'bad_request', 'dish_id (or recipe_id) is required'],
    [{ recipe_id: 'r', enabled: 'yes' }, 'bad_request', 'enabled must be a boolean'],
    [{ recipe_id: 'r', config_overlay: 'nope' }, 'bad_request', 'config_overlay must be an object'],
  ])('rejects invalid update body %#', async (body, code, message) => {
    const deps = makeDeps([storedRow(makeRecipe('r'))]);
    await expect(updateAutoRun(deps, body)).rejects.toMatchObject({ code, message });
  });

  it('rejects an unknown dish, an unknown recipe and a recipe without auto_run', async () => {
    const deps = makeDeps([storedRow(makeRecipe('manual', null))]);
    await expect(updateAutoRun(deps, { dish_id: 'dsh_missing', enabled: true })).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateAutoRun(deps, { recipe_id: 'missing', enabled: true })).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateAutoRun(deps, { recipe_id: 'manual', enabled: true })).rejects.toMatchObject({ code: 'not_found' });
    const dish = createDish(dishDeps, { recipe_id: 'manual' }).dish;
    await expect(updateAutoRun(deps, { dish_id: dish.dish_id, enabled: true })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('⛔ refuses settings on a timer: they are its dish’s', async () => {
    const dish = createDish(dishDeps, { recipe_id: 'r' }).dish;
    const deps = makeDeps([storedRow(makeRecipe('r'))]);
    await expect(updateAutoRun(deps, { dish_id: dish.dish_id, config_overlay: { a: 1 } }))
      .rejects.toThrow(/no settings of its own/);
  });

  it('pauses one dish’s timer, refreshes the roster, emits a rule change, and leaves the circuit and the other dish alone', async () => {
    const work = createDish(dishDeps, { recipe_id: 'r' }).dish;
    const home = createDish(dishDeps, { recipe_id: 'r', name: 'Home' }).dish;
    const deps = makeDeps([storedRow(makeRecipe('r'))]);
    deps.settingsStore.setEnabled(work.dish_id, 'r', true);
    deps.settingsStore.setEnabled(home.dish_id, 'r', true);
    deps.circuitStore.set({ dish_id: work.dish_id, recipe_id: 'r', consecutive_failures: 2, auto_disabled: false });

    const { entry } = await updateAutoRun(deps, { dish_id: work.dish_id, enabled: false });

    expect(entry).toMatchObject({ dish_id: work.dish_id, enabled: false });
    expect(deps.settingsStore.isEnabled(work.dish_id)).toBe(false);
    expect(deps.settingsStore.isEnabled(home.dish_id)).toBe(true);
    expect(deps.circuitStore.get(work.dish_id)?.consecutive_failures).toBe(2);
    expect(deps.getHandle()!.refreshRoster).toHaveBeenCalledTimes(1);
    expect(deps.eventBus!.emit).toHaveBeenCalledWith({ kind: 'automation_rule_changed', mechanism: 'auto_run' });
  });

  it('re-arming clears the dish’s persisted circuit before the roster refresh and resets a tripped live one', async () => {
    const dish = createDish(dishDeps, { recipe_id: 'r' }).dish;
    const calls: string[] = [];
    const handle = makeHandle(new Map([[dish.dish_id, liveEntry(dish.dish_id, 'r', { consecutive_failures: 1, auto_disabled: true })]]));
    handle.refreshRoster = vi.fn(async () => { calls.push('refresh'); });
    handle.resetCircuit = vi.fn((key: string) => { calls.push(`reset:${key}`); });
    const circuitStore = createCircuitBreakerStore(db);
    const clear = circuitStore.clear.bind(circuitStore);
    circuitStore.clear = vi.fn((key: string) => { calls.push(`clear:${key}`); clear(key); });
    const deps = makeDeps([storedRow(makeRecipe('r'))], { circuitStore, getHandle: vi.fn(() => handle) });

    await updateAutoRun(deps, { dish_id: dish.dish_id, enabled: true });

    expect(calls).toEqual([`clear:${dish.dish_id}`, `reset:${dish.dish_id}`, 'refresh']);
  });

  it('resets a tripped persisted circuit even when the live roster is healthy; a healthy one is cleared, not reset', async () => {
    const tripped = createDish(dishDeps, { recipe_id: 'r' }).dish;
    const healthy = createDish(dishDeps, { recipe_id: 'r', name: 'Healthy' }).dish;
    const handle = makeHandle(new Map([[tripped.dish_id, liveEntry(tripped.dish_id, 'r')]]));
    const deps = makeDeps([storedRow(makeRecipe('r'))], { getHandle: vi.fn(() => handle) });
    deps.circuitStore.set({ dish_id: tripped.dish_id, recipe_id: 'r', consecutive_failures: 3, auto_disabled: true });

    await updateAutoRun(deps, { dish_id: tripped.dish_id, enabled: true });
    expect(handle.resetCircuit).toHaveBeenCalledWith(tripped.dish_id);
    expect(deps.circuitStore.get(tripped.dish_id)).toBeNull();

    await updateAutoRun(deps, { dish_id: healthy.dish_id, enabled: true });
    expect(handle.resetCircuit).toHaveBeenCalledTimes(1);
  });

  it('persists and returns an entry when switching on before the scheduler handle exists', async () => {
    const dish = createDish(dishDeps, { recipe_id: 'r' }).dish;
    const deps = makeDeps([storedRow(makeRecipe('r'))], { getHandle: vi.fn(() => undefined) });
    await expect(updateAutoRun(deps, { dish_id: dish.dish_id, enabled: true }))
      .resolves.toEqual({ entry: expect.objectContaining({ dish_id: dish.dish_id, enabled: true }) });
  });
});

describe('auto_run.update naming only a recipe — its main dish', () => {
  it('with no dish, switching on makes the main dish from the settings given, and its timer on', async () => {
    const deps = makeDeps([storedRow(makeRecipe('r'))]);
    const { entry } = await updateAutoRun(deps, { recipe_id: 'r', enabled: true, config_overlay: { stripe: 'primary' } });
    const main = dishDeps.store.getDefault('r')!;
    expect(main).toMatchObject({ config_overlay: { stripe: 'primary' }, enabled: true, publisher_id: 'publisher' });
    expect(entry).toMatchObject({ dish_id: main.dish_id, enabled: true, config_overlay: { stripe: 'primary' } });
    expect(deps.settingsStore.isEnabled(main.dish_id)).toBe(true);
  });

  it('reports the webhook door a new main dish moved (D-209); an existing main dish moves none', async () => {
    const change = {
      recipe_id: 'r', state: 'opened' as const, was_open: false, added: ['connection:primary'], removed: [],
    };
    const asked: string[] = [];
    dishDeps.webhookDoors = { mainDishChanged: (recipe_id) => { asked.push(recipe_id); return [change]; } };
    const deps = makeDeps([storedRow(makeRecipe('r'))]);

    const first = await updateAutoRun(deps, { recipe_id: 'r', enabled: true, config_overlay: { stripe: 'primary' } });
    expect(first.webhook_doors).toEqual([change]);
    expect(asked).toEqual(['r']);

    const again = await updateAutoRun(deps, { recipe_id: 'r', enabled: false });
    expect(again).not.toHaveProperty('webhook_doors');
    expect(asked).toEqual(['r']);
  });

  it('acts on the main dish that exists — and refuses settings that are not its', async () => {
    const main = createDish(dishDeps, { recipe_id: 'r', config_overlay: { a: 1 } }).dish;
    createDish(dishDeps, { recipe_id: 'r', name: 'Other' });
    const deps = makeDeps([storedRow(makeRecipe('r'))]);
    const { entry } = await updateAutoRun(deps, { recipe_id: 'r', enabled: true });
    expect(entry.dish_id).toBe(main.dish_id);
    await expect(updateAutoRun(deps, { recipe_id: 'r', enabled: true, config_overlay: { a: 2 } }))
      .rejects.toThrow(/Settings belong to the dish/);
  });

  it('a server that keeps no dishes cannot switch a recipe on', async () => {
    const deps = makeDeps([storedRow(makeRecipe('r'))]);
    delete (deps as { mainDish?: unknown }).mainDish;
    await expect(updateAutoRun(deps, { recipe_id: 'r', enabled: true })).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('handler slice', () => {
  it('only creates a handler slice when dependencies are available', () => {
    expect(makeAutoRunHandlers(undefined)).toBeUndefined();
    expect(makeAutoRunHandlers(makeDeps([]))?.methods).toEqual([
      'auto_run.list',
      'auto_run.update',
    ]);
  });
});
