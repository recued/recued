/** D-179 P1 — dish substrate unit coverage.
 *
 *  Covers the three new server pieces:
 *    1. `dish-store` — CRUD round-trip, default-dish partial unique
 *       index (upsert must SURFACE the constraint, never OR-REPLACE the
 *       existing default away), byte-delta reporting.
 *    2. `dish-context-store` — snapshot round-trip + corrupt-row
 *       degradation to first-run semantics.
 *    3. `dish-handler` — rpc validation (lifecycle fields rejected when
 *       malformed), the main dish, delete clearing the continuity snapshot.
 *
 *  D-319 — a dish is a recipe switched on: the first is its main dish, a
 *  schedule or trigger belongs to a dish (the main one when it names none)
 *  and has no settings of its own, and a run as a dish takes its values
 *  under the run's own.
 *
 *  Spec: D-179 (RATIFIED 2026-06-12), D-319.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Dish } from '@recued/contracts';
import { ephemeralDishId, isEphemeralDishId } from '@recued/contracts';
import { createDishStore, type DishStore } from '../dish-store.js';
import { createDishContextStore } from '../dish-context-store.js';
import {
  createDish,
  deleteDish,
  dishDefaults,
  listDishes,
  mainDishFor,
  updateDish,
  type DishHandlerDeps,
} from '../dish-handler.js';
import type { DishAutomation } from '../dish-automation.js';
import { mergeRecipeConfigLayers } from '../recipe-effective-config.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return db;
};

const dish = (overrides: Partial<Dish> = {}): Dish => ({
  dish_id: 'dsh_test1',
  recipe_id: 'recipe-a',
  publisher_id: 'local',
  name: 'repo: recued-dev',
  is_default: false,
  config_overlay: { repo_dir: '/tmp/a' },
  enabled: true,
  created_at: 1_000,
  ...overrides,
});

describe('dish-store', () => {
  it('round-trips set/get/list/listByRecipe/delete', () => {
    const store = createDishStore(makeDb());
    const a = dish();
    const b = dish({ dish_id: 'dsh_test2', recipe_id: 'recipe-b', name: 'other' });
    store.set(a);
    store.set(b);

    expect(store.get('dsh_test1')).toEqual(a);
    expect(store.list().map((d) => d.dish_id).sort()).toEqual(['dsh_test1', 'dsh_test2']);
    expect(store.listByRecipe('recipe-a')).toEqual([a]);
    expect(store.delete('dsh_test1')).toBe(true);
    expect(store.delete('dsh_test1')).toBe(false);
    expect(store.get('dsh_test1')).toBeNull();
  });

  it('updates in place via upsert (same dish_id never conflicts)', () => {
    const store = createDishStore(makeDb());
    store.set(dish({ is_default: true }));
    // Re-set the SAME default row — upsert path, no constraint error.
    store.set(dish({ is_default: true, name: 'renamed' }));
    expect(store.get('dsh_test1')?.name).toBe('renamed');
    expect(store.getDefault('recipe-a')?.dish_id).toBe('dsh_test1');
  });

  it('SURFACES a second default-dish insert as a constraint error and keeps the first row', () => {
    const store = createDishStore(makeDb());
    store.set(dish({ dish_id: 'dsh_default', is_default: true }));

    expect(() =>
      store.set(dish({ dish_id: 'dsh_usurper', is_default: true })),
    ).toThrow(/UNIQUE/);
    // The OR-REPLACE failure mode would have silently DELETED the
    // existing default; the upsert must leave it untouched.
    expect(store.get('dsh_default')).not.toBeNull();
    expect(store.getDefault('recipe-a')?.dish_id).toBe('dsh_default');
  });

  it('allows one default per recipe across different recipes', () => {
    const store = createDishStore(makeDb());
    store.set(dish({ dish_id: 'dsh_a', recipe_id: 'recipe-a', is_default: true }));
    store.set(dish({ dish_id: 'dsh_b', recipe_id: 'recipe-b', is_default: true }));
    expect(store.getDefault('recipe-a')?.dish_id).toBe('dsh_a');
    expect(store.getDefault('recipe-b')?.dish_id).toBe('dsh_b');
  });

  it('reports signed byte deltas on set and delete', () => {
    const deltas: number[] = [];
    const store = createDishStore(makeDb(), { onBytesChanged: (d) => deltas.push(d) });
    store.set(dish());
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!).toBeGreaterThan(0);
    store.delete('dsh_test1');
    expect(deltas).toHaveLength(2);
    expect(deltas[1]!).toBe(-deltas[0]!);
  });
});

describe('dish-context-store', () => {
  it('round-trips snapshots per dish and clears', () => {
    const db = makeDb();
    const store = createDishContextStore(db);
    expect(store.get('dsh_a')).toBeNull();

    store.set('dsh_a', { step1: { total: 7 } });
    store.set('dsh_b', { step1: { total: 9 } });
    expect(store.get('dsh_a')).toEqual({ step1: { total: 7 } });
    expect(store.get('dsh_b')).toEqual({ step1: { total: 9 } });

    store.clear('dsh_a');
    expect(store.get('dsh_a')).toBeNull();
    expect(store.get('dsh_b')).toEqual({ step1: { total: 9 } });
  });

  it('degrades a corrupt snapshot row to first-run semantics (null)', () => {
    const db = makeDb();
    const store = createDishContextStore(db);
    db.prepare(`INSERT INTO dish_context_recipe (dish_id, data) VALUES (?, ?)`)
      .run('dsh_bad', '{not json');
    expect(store.get('dsh_bad')).toBeNull();
  });
});

describe('dish-handler', () => {
  /** What each change told the rows that follow a dish (D-319). */
  const recorder = () => {
    const calls: string[] = [];
    const automation: DishAutomation = {
      created: (d, opts) => { calls.push(`created ${d.dish_id} switchOn=${opts.switchOn}`); },
      switched: (d) => { calls.push(`switched ${d.dish_id} ${d.enabled ? 'on' : 'off'}`); },
      settingsChanged: (d) => { calls.push(`settings ${d.dish_id}`); },
      deleted: (d) => { calls.push(`deleted ${d.dish_id}`); },
      touched: () => { calls.push('touched'); },
    };
    return { calls, automation };
  };
  const makeDeps = (): DishHandlerDeps & { store: DishStore } => {
    const db = makeDb();
    return {
      store: createDishStore(db),
      contextStore: createDishContextStore(db),
      now: () => 5_000,
    };
  };

  it('the first dish of a recipe is its main one; the next is not', async () => {
    const deps = makeDeps();
    const { dish: first } = createDish(deps, { recipe_id: 'recipe-a', config_overlay: { repo_dir: '/x' } });
    expect(first.dish_id.startsWith('dsh_')).toBe(true);
    expect(first).toMatchObject({ enabled: true, is_default: true, name: '', created_at: 5_000 });
    const { dish: second } = createDish(deps, { recipe_id: 'recipe-a', name: 'repo: y' });
    expect(second.is_default).toBe(false);
    expect((await listDishes(deps, { recipe_id: 'recipe-a' })).dishes.map((d) => d.dish_id).sort())
      .toEqual([first.dish_id, second.dish_id].sort());
    expect((await listDishes(deps, { recipe_id: 'recipe-zzz' })).dishes).toEqual([]);
    // Another recipe's first is its own main.
    expect(createDish(deps, { recipe_id: 'recipe-b' }).dish.is_default).toBe(true);
  });

  it('carries the publisher its recipe is installed under when the caller names none', () => {
    const deps = { ...makeDeps(), publisherOf: (recipe_id: string) => (recipe_id === 'recipe-a' ? 'recued-core' : null) };
    expect(createDish(deps, { recipe_id: 'recipe-a' }).dish.publisher_id).toBe('recued-core');
    expect(createDish(deps, { recipe_id: 'gone' }).dish.publisher_id).toBe('local');
    expect(createDish(deps, { recipe_id: 'recipe-a', publisher_id: 'p' }).dish.publisher_id).toBe('p');
  });

  it.each([
    [{ name: 7 }, /name must be a string/],
    [{ enabled: 'yes' }, /enabled must be a boolean/],
    [{ config_overlay: [1] }, /config_overlay must be an object/],
  ] as const)('create rejects malformed input %j', (bad, message) => {
    const deps = makeDeps();
    expect(() => createDish(deps, { recipe_id: 'recipe-a', ...bad })).toThrow(message);
  });

  it('create requires recipe_id', () => {
    expect(() => createDish(makeDeps(), {})).toThrow(/recipe_id is required/);
  });

  it('a create that loses the race for main is stored as an ordinary dish', () => {
    const deps = makeDeps();
    deps.store.set(dish({ dish_id: 'dsh_racer', recipe_id: 'recipe-r', is_default: true }));
    const getDefault = deps.store.getDefault.bind(deps.store);
    deps.store.getDefault = (() => null) as typeof deps.store.getDefault; // lost the race
    const { dish: late } = createDish(deps, { recipe_id: 'recipe-r' });
    deps.store.getDefault = getDefault;
    expect(late.is_default).toBe(false);
    expect(deps.store.getDefault('recipe-r')!.dish_id).toBe('dsh_racer');
  });

  it('creating switches the dish on — unless it is made off, or made only to hold a row’s settings', () => {
    const deps = makeDeps();
    const { calls, automation } = recorder();
    deps.automation = automation;
    const on = createDish(deps, { recipe_id: 'recipe-a' }).dish;
    const off = createDish(deps, { recipe_id: 'recipe-a', enabled: false }).dish;
    const held = createDish(deps, { recipe_id: 'recipe-a' }, { switchOn: false }).dish;
    expect(calls).toEqual([
      `created ${on.dish_id} switchOn=true`,
      `created ${off.dish_id} switchOn=false`,
      `created ${held.dish_id} switchOn=false`,
    ]);
  });

  it('updates name / settings / switch in place and rejects malformed lifecycle input', () => {
    const deps = makeDeps();
    const { dish: created } = createDish(deps, { recipe_id: 'recipe-a' });

    const { dish: updated } = updateDish(deps, created.dish_id, {
      name: 'renamed',
      config_overlay: { repo_dir: '/y' },
      enabled: false,
    });
    expect(updated.dish_id).toBe(created.dish_id);
    expect(updated.name).toBe('renamed');
    expect(updated.config_overlay).toEqual({ repo_dir: '/y' });
    expect(updated.enabled).toBe(false);

    expect(() => updateDish(deps, created.dish_id, { enabled: 'no' })).toThrow(
      /enabled must be a boolean/,
    );
    expect(() => updateDish(deps, created.dish_id, { name: 9 })).toThrow(
      /name must be a string/,
    );
    expect(() => updateDish(deps, created.dish_id, { main: false })).toThrow(/main must be true/);
    expect(() => updateDish(deps, 'dsh_missing', {})).toThrow(/not found/);
  });

  it('tells the rows what changed: a switch (even to the same state — a re-arm), settings, or a label', () => {
    const deps = makeDeps();
    const { dish: created } = createDish(deps, { recipe_id: 'recipe-a' });
    const { calls, automation } = recorder();
    deps.automation = automation;
    updateDish(deps, created.dish_id, { enabled: true });
    updateDish(deps, created.dish_id, { enabled: false, config_overlay: { x: 1 } });
    updateDish(deps, created.dish_id, { config_overlay: { x: 2 } });
    updateDish(deps, created.dish_id, { name: 'n' });
    expect(calls).toEqual([
      `switched ${created.dish_id} on`,
      `switched ${created.dish_id} off`,
      `settings ${created.dish_id}`,
      'touched',
    ]);
  });

  it('`main: true` makes a dish its recipe’s main one, and only that one', () => {
    const deps = makeDeps();
    const first = createDish(deps, { recipe_id: 'recipe-a' }).dish;
    const second = createDish(deps, { recipe_id: 'recipe-a', name: 'home' }).dish;
    const { dish: made } = updateDish(deps, second.dish_id, { main: true });
    expect(made.is_default).toBe(true);
    expect(deps.store.get(first.dish_id)!.is_default).toBe(false);
    expect(deps.store.getDefault('recipe-a')!.dish_id).toBe(second.dish_id);
  });

  it('delete removes the dish AND its continuity snapshot, and tells its rows', () => {
    const deps = makeDeps();
    const { dish: created } = createDish(deps, { recipe_id: 'recipe-a' });
    deps.contextStore!.set(created.dish_id, { step1: 42 });
    const { calls, automation } = recorder();
    deps.automation = automation;

    expect(deleteDish(deps, created.dish_id)).toEqual({ deleted: true });
    expect(deps.store.get(created.dish_id)).toBeNull();
    expect(deps.contextStore!.get(created.dish_id)).toBeNull();
    expect(calls).toEqual([`deleted ${created.dish_id}`]);
    expect(() => deleteDish(deps, created.dish_id)).toThrow(/not found/);
  });

  it('removing the main dish makes the oldest remaining one main', () => {
    let now = 1_000;
    const deps = { ...makeDeps(), now: () => now };
    const main = createDish(deps, { recipe_id: 'recipe-a' }).dish;
    now = 3_000;
    const newer = createDish(deps, { recipe_id: 'recipe-a', name: 'newer' }).dish;
    now = 2_000;
    const older = createDish(deps, { recipe_id: 'recipe-a', name: 'older' }).dish;
    deleteDish(deps, main.dish_id);
    expect(deps.store.getDefault('recipe-a')!.dish_id).toBe(older.dish_id);
    expect(deps.store.get(newer.dish_id)!.is_default).toBe(false);
  });

  it('`dishes.defaults` answers what a new dish starts from', () => {
    const deps = { ...makeDeps(), defaultsFor: (recipe_id: string) => ({ template: `mtpl_${recipe_id}` }) };
    expect(dishDefaults(deps, { recipe_id: 'r' })).toEqual({ config_overlay: { template: 'mtpl_r' } });
    expect(dishDefaults(makeDeps(), { recipe_id: 'r' })).toEqual({ config_overlay: {} });
    expect(() => dishDefaults(deps, {})).toThrow(/recipe_id is required/);
  });
});

describe('D-319 — the dish a row made without naming one belongs to (`mainDishFor`)', () => {
  const makeDeps = (): DishHandlerDeps & { store: DishStore } => {
    const db = makeDb();
    return { store: createDishStore(db), now: () => 5_000 };
  };

  it('is the recipe’s main dish', () => {
    const deps = makeDeps();
    const main = createDish(deps, { recipe_id: 'recipe-a', config_overlay: { a: 1 } }).dish;
    createDish(deps, { recipe_id: 'recipe-a', name: 'other' });
    expect(mainDishFor(deps, { recipe_id: 'recipe-a', publisher_id: 'p', config_overlay: null }).dish.dish_id).toBe(main.dish_id);
    // Its own settings, in any key order, are no conflict.
    expect(mainDishFor(deps, { recipe_id: 'recipe-a', publisher_id: 'p', config_overlay: { a: 1 } }).dish.dish_id).toBe(main.dish_id);
  });

  it('⛔ refuses settings that are not the main dish’s — settings belong to the dish', () => {
    const deps = makeDeps();
    createDish(deps, { recipe_id: 'recipe-a', config_overlay: { a: 1 } });
    expect(() => mainDishFor(deps, { recipe_id: 'recipe-a', publisher_id: 'p', config_overlay: { a: 2 } }))
      .toThrow(/Settings belong to the dish/);
  });

  it('with no dish, makes the main one from the settings given — on, but not switched on as a whole', () => {
    const deps = makeDeps();
    const calls: string[] = [];
    deps.automation = {
      created: (d, opts) => { calls.push(`created switchOn=${opts.switchOn}`); },
      switched: () => undefined, settingsChanged: () => undefined, deleted: () => undefined, touched: () => undefined,
    };
    const made = mainDishFor(deps, { recipe_id: 'recipe-a', publisher_id: 'p', config_overlay: { a: 1 } }).dish;
    expect(made).toMatchObject({ is_default: true, enabled: true, config_overlay: { a: 1 }, publisher_id: 'p' });
    expect(calls).toEqual(['created switchOn=false']);
  });
});

// ── D-179 P2 / D-319 — a row belongs to a dish ───────────────────

describe('schedule create dish binding (P2)', () => {
  const makeScheduleDeps = () => {
    const db = makeDb();
    const dishStore = createDishStore(db);
    return { dishStore };
  };

  it('validates existence + recipe match when the dish store is wired', async () => {
    const { dishStore } = makeScheduleDeps();
    dishStore.set(dish({ dish_id: 'dsh_ok', recipe_id: 'recipe-a' }));
    const { createSchedule } = await import('../schedule-handler.js');
    const { createScheduleStore } = await import('../schedule-store.js');
    const deps = {
      store: createScheduleStore(makeDb()),
      dishStore,
      instanceId: 'i-1',
    };

    const { schedule } = createSchedule(deps, {
      recipe_id: 'recipe-a',
      cron_expression: '0 9 * * *',
      dish_id: 'dsh_ok',
    });
    expect(schedule.dish_id).toBe('dsh_ok');

    expect(() => createSchedule(deps, {
      recipe_id: 'recipe-a',
      cron_expression: '0 9 * * *',
      dish_id: 'dsh_missing',
    })).toThrow(/not found/);

    expect(() => createSchedule(deps, {
      recipe_id: 'recipe-OTHER',
      cron_expression: '0 9 * * *',
      dish_id: 'dsh_ok',
    })).toThrow(/instantiates recipe/);

    expect(() => createSchedule(deps, {
      recipe_id: 'recipe-a',
      cron_expression: '0 9 * * *',
      dish_id: '',
    })).toThrow(/dish_id must be a non-empty string/);
  });
});

describe('trigger create/update dish binding (P2)', () => {
  it('validates existence + recipe match and persists dish_id + watch_interval_ms', async () => {
    const db = makeDb();
    const dishStore = createDishStore(db);
    dishStore.set(dish({ dish_id: 'dsh_ok', recipe_id: 'recipe-a' }));
    dishStore.set(dish({ dish_id: 'dsh_other', recipe_id: 'recipe-a' }));
    const { createEventTriggersStore } = await import('../triggers/store.js');
    const { handleTriggersCreate, handleTriggersUpdate } = await import('../triggers/handler.js');
    const deps = { store: createEventTriggersStore(db), dishStore };

    const { trigger } = await handleTriggersCreate(deps, {
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      dish_id: 'dsh_ok',
      watch_interval_ms: 6 * 60_000,
    });
    expect(trigger.dish_id).toBe('dsh_ok');
    expect(trigger.watch_interval_ms).toBe(6 * 60_000);
    expect(deps.store.get(trigger.trigger_id)!.dish_id).toBe('dsh_ok');

    await expect(handleTriggersCreate(deps, {
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      dish_id: 'dsh_missing',
    })).rejects.toThrow(/not found/);

    await expect(handleTriggersCreate(deps, {
      recipe_id: 'recipe-OTHER',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      dish_id: 'dsh_ok',
    })).rejects.toThrow(/instantiates recipe/);

    // D-319 — the owner's trigger moves to another dish of its recipe; it
    // always has one.
    const moved = await handleTriggersUpdate(deps, { trigger_id: trigger.trigger_id, dish_id: 'dsh_other' });
    expect(moved.trigger.dish_id).toBe('dsh_other');
    await expect(handleTriggersUpdate(deps, { trigger_id: trigger.trigger_id, dish_id: null }))
      .rejects.toThrow(/dish_id must be a non-empty string/);
    await expect(handleTriggersUpdate(deps, {
      trigger_id: trigger.trigger_id,
      watch_interval_ms: -5,
    })).rejects.toThrow(/watch_interval_ms/);
  });

  it('a recipe’s own trigger belongs to the dish it was made for', async () => {
    const db = makeDb();
    const dishStore = createDishStore(db);
    dishStore.set(dish({ dish_id: 'dsh_ok', recipe_id: 'recipe-a' }));
    dishStore.set(dish({ dish_id: 'dsh_other', recipe_id: 'recipe-a' }));
    const { createEventTriggersStore } = await import('../triggers/store.js');
    const { handleTriggersUpdate } = await import('../triggers/handler.js');
    const store = createEventTriggersStore(db);
    store.create({
      trigger_id: 't-recipe', recipe_id: 'recipe-a', publisher_id: 'local', pattern: 'data.mail.**',
      enabled: false, created_at: 1, origin: 'recipe', dish_id: 'dsh_ok',
    });
    await expect(handleTriggersUpdate({ store, dishStore }, { trigger_id: 't-recipe', dish_id: 'dsh_other' }))
      .rejects.toThrow(/belongs to the dish it was made for/);
  });
});

describe('D-319 — a schedule belongs to a dish and has no settings of its own', () => {
  const makeDeps = async () => {
    const { createScheduleStore } = await import('../schedule-store.js');
    const db = makeDb();
    const dishDeps: DishHandlerDeps = { store: createDishStore(db), contextStore: createDishContextStore(db), now: () => 5_000 };
    return {
      dishDeps,
      deps: {
        store: createScheduleStore(makeDb()),
        dishStore: dishDeps.store,
        mainDish: (input: Parameters<typeof mainDishFor>[1]) => mainDishFor(dishDeps, input),
        instanceId: 'i-1',
        now: () => 5_000,
      },
    };
  };

  it('one naming no dish joins the recipe’s main dish, made from its settings when there is none', async () => {
    const { dishDeps, deps } = await makeDeps();
    const { createSchedule } = await import('../schedule-handler.js');
    const { schedule } = createSchedule(deps, { recipe_id: 'recipe-a', cron_expression: '0 9 * * *', config_overlay: { threshold: 30 } });
    const main = dishDeps.store.getDefault('recipe-a')!;
    expect(main).toMatchObject({ config_overlay: { threshold: 30 }, enabled: true });
    expect(schedule.dish_id).toBe(main.dish_id);
    // A second one joins the same dish — no settings of its own, none minted.
    const { schedule: second } = createSchedule(deps, { recipe_id: 'recipe-a', cron_expression: '0 18 * * *' });
    expect(second.dish_id).toBe(main.dish_id);
    expect(dishDeps.store.listByRecipe('recipe-a')).toHaveLength(1);
  });

  it('⛔ refuses settings on a schedule that names its dish, or that differ from its main dish’s', async () => {
    const { dishDeps, deps } = await makeDeps();
    const { createSchedule } = await import('../schedule-handler.js');
    const main = createDish(dishDeps, { recipe_id: 'recipe-a', config_overlay: { threshold: 30 } }).dish;
    expect(() => createSchedule(deps, {
      recipe_id: 'recipe-a', cron_expression: '0 9 * * *', dish_id: main.dish_id, config_overlay: { threshold: 30 },
    })).toThrow(/Settings belong to the dish/);
    expect(() => createSchedule(deps, {
      recipe_id: 'recipe-a', cron_expression: '0 9 * * *', config_overlay: { threshold: 50 },
    })).toThrow(/Settings belong to the dish/);
    expect(() => createSchedule(deps, {
      recipe_id: 'recipe-a', cron_expression: '0 9 * * *', config_overlay: 'nope',
    })).toThrow(/config_overlay must be an object/);
  });

  it('removing a schedule leaves its dish; an update may move it, never re-set it', async () => {
    const { dishDeps, deps } = await makeDeps();
    const { createSchedule, deleteSchedule, updateSchedule } = await import('../schedule-handler.js');
    const main = createDish(dishDeps, { recipe_id: 'recipe-a' }).dish;
    const other = createDish(dishDeps, { recipe_id: 'recipe-a', name: 'other' }).dish;
    dishDeps.contextStore!.set(main.dish_id, { step_a: 1 });
    const { schedule } = createSchedule(deps, { recipe_id: 'recipe-a', cron_expression: '0 9 * * *' });

    expect(() => updateSchedule(deps, schedule.schedule_id, { config_overlay: { a: 1 } }))
      .toThrow(/no settings of its own/);
    expect(updateSchedule(deps, schedule.schedule_id, { dish_id: other.dish_id }).schedule.dish_id).toBe(other.dish_id);
    expect(() => updateSchedule(deps, schedule.schedule_id, { dish_id: 'dsh_missing' })).toThrow(/not found/);

    deleteSchedule(deps, schedule.schedule_id);
    expect(dishDeps.store.get(main.dish_id)).not.toBeNull();
    expect(dishDeps.contextStore!.get(main.dish_id)).toEqual({ step_a: 1 });
  });

  it('a server that keeps no dishes refuses settings and makes a dishless schedule', async () => {
    const { createScheduleStore } = await import('../schedule-store.js');
    const { createSchedule } = await import('../schedule-handler.js');
    const deps = { store: createScheduleStore(makeDb()), instanceId: 'i-1' };
    expect(() => createSchedule(deps, { recipe_id: 'recipe-a', cron_expression: '0 9 * * *', config_overlay: { a: 1 } }))
      .toThrow(/keeps none/);
    expect(createSchedule(deps, { recipe_id: 'recipe-a', cron_expression: '0 9 * * *', config_overlay: {} }).schedule.dish_id)
      .toBeUndefined();
  });
});

describe('D-319 — a trigger belongs to a dish and has no settings of its own', () => {
  const makeDeps = async () => {
    const { createEventTriggersStore } = await import('../triggers/store.js');
    const db = makeDb();
    const dishDeps: DishHandlerDeps = { store: createDishStore(db), contextStore: createDishContextStore(db), now: () => 5_000 };
    return {
      dishDeps,
      deps: {
        store: createEventTriggersStore(db),
        dishStore: dishDeps.store,
        mainDish: (input: Parameters<typeof mainDishFor>[1]) => mainDishFor(dishDeps, input),
      },
    };
  };

  it('one naming no dish joins the recipe’s main dish, made from its settings when there is none', async () => {
    const { dishDeps, deps } = await makeDeps();
    const { handleTriggersCreate } = await import('../triggers/handler.js');
    const { trigger } = await handleTriggersCreate(deps, {
      recipe_id: 'recipe-a', publisher_id: 'local', pattern: 'data.mail.**', config_overlay: { threshold: 30 },
    });
    const main = dishDeps.store.getDefault('recipe-a')!;
    expect(main.config_overlay).toEqual({ threshold: 30 });
    expect(trigger.dish_id).toBe(main.dish_id);
  });

  it('⛔ refuses settings on a trigger that names its dish, or on an update', async () => {
    const { dishDeps, deps } = await makeDeps();
    const { handleTriggersCreate, handleTriggersUpdate } = await import('../triggers/handler.js');
    const main = createDish(dishDeps, { recipe_id: 'recipe-a' }).dish;
    await expect(handleTriggersCreate(deps, {
      recipe_id: 'recipe-a', publisher_id: 'local', pattern: 'data.mail.**', dish_id: main.dish_id, config_overlay: { a: 1 },
    })).rejects.toThrow(/Settings belong to the dish/);
    const { trigger } = await handleTriggersCreate(deps, { recipe_id: 'recipe-a', publisher_id: 'local', pattern: 'data.mail.**' });
    await expect(handleTriggersUpdate(deps, { trigger_id: trigger.trigger_id, config_overlay: { a: 1 } }))
      .rejects.toThrow(/no settings of its own/);
  });

  it('removing a trigger leaves its dish and its memory', async () => {
    const { dishDeps, deps } = await makeDeps();
    const { handleTriggersCreate, handleTriggersDelete } = await import('../triggers/handler.js');
    const main = createDish(dishDeps, { recipe_id: 'recipe-a' }).dish;
    dishDeps.contextStore!.set(main.dish_id, { step_a: 2 });
    const { trigger } = await handleTriggersCreate(deps, { recipe_id: 'recipe-a', publisher_id: 'local', pattern: 'data.mail.**' });
    await handleTriggersDelete(deps, { trigger_id: trigger.trigger_id });
    expect(dishDeps.store.get(main.dish_id)).not.toBeNull();
    expect(dishDeps.contextStore!.get(main.dish_id)).toEqual({ step_a: 2 });
  });
});

describe('ephemeral dish ids', () => {
  it('derive from the run id and never collide with persisted dsh_ keys', () => {
    const id = ephemeralDishId('20260612T080000000-abc123');
    expect(id).toBe('dsh:eph:20260612T080000000-abc123');
    expect(isEphemeralDishId(id)).toBe(true);
    expect(isEphemeralDishId('dsh_standing')).toBe(false);
  });
});

describe('dish groups (P3)', () => {
  const makeGroupDeps = async () => {
    const { createDishGroupStore } = await import('../dish-group-store.js');
    const db = makeDb();
    return {
      store: createDishStore(db),
      contextStore: createDishContextStore(db),
      groupStore: createDishGroupStore(db),
      now: () => 9_000,
    };
  };

  it('round-trips group create/list/get/update/delete', async () => {
    const {
      createDishGroup,
      deleteDishGroup,
      listDishGroups,
      updateDishGroup,
    } = await import('../dish-handler.js');
    const deps = await makeGroupDeps();

    const { group: created } = createDishGroup(deps, {
      name: 'recued-dev issue pipeline',
      config_overlay: { repo_dir: '/repo/a', branch: 'main' },
    });
    expect(created.group_id.startsWith('dgrp_')).toBe(true);
    expect(created.created_at).toBe(9_000);
    expect(deps.groupStore.get(created.group_id)).toEqual(created);
    expect(listDishGroups(deps)).toEqual({
      groups: [{ group: created, member_dish_ids: [] }],
    });

    const { group: updated } = updateDishGroup(deps, created.group_id, {
      name: 'renamed pipeline',
      config_overlay: { repo_dir: '/repo/b', queue: 'p3' },
    });
    expect(updated).toEqual({
      ...created,
      name: 'renamed pipeline',
      config_overlay: { repo_dir: '/repo/b', queue: 'p3' },
    });
    expect(deps.groupStore.get(created.group_id)).toEqual(updated);

    expect(deleteDishGroup(deps, created.group_id)).toEqual({
      deleted: true,
      detached_dish_ids: [],
    });
    expect(deps.groupStore.get(created.group_id)).toBeNull();
    expect(listDishGroups(deps)).toEqual({ groups: [] });
  });

  /** A dish's runs read its group's settings under its own, so the rows that
   *  follow a dish (a trigger watching the folder a setting names) follow a
   *  change of the group's settings too, and its leaving the group. */
  it('a change of a group’s settings, and its removal, reach each member’s rows', async () => {
    const { createDishGroup, deleteDishGroup, updateDishGroup } = await import('../dish-handler.js');
    const calls: string[] = [];
    const deps = {
      ...await makeGroupDeps(),
      automation: {
        created: () => undefined,
        switched: () => undefined,
        settingsChanged: (d: { dish_id: string }) => { calls.push(`settings ${d.dish_id}`); },
        deleted: () => undefined,
        touched: () => undefined,
      } as unknown as DishAutomation,
    };
    const { group } = createDishGroup(deps, { name: 'work', config_overlay: { file_slug: 'scans' } });
    const { dish: a } = createDish(deps, { recipe_id: 'recipe-a', group_id: group.group_id });
    const { dish: b } = createDish(deps, { recipe_id: 'recipe-b', group_id: group.group_id });
    createDish(deps, { recipe_id: 'recipe-c' });
    calls.length = 0;

    updateDishGroup(deps, group.group_id, { name: 'renamed' });
    expect(calls).toEqual([]);
    updateDishGroup(deps, group.group_id, { config_overlay: { file_slug: 'invoices' } });
    expect(calls.sort()).toEqual([`settings ${a.dish_id}`, `settings ${b.dish_id}`].sort());

    calls.length = 0;
    deleteDishGroup(deps, group.group_id);
    expect(calls.sort()).toEqual([`settings ${a.dish_id}`, `settings ${b.dish_id}`].sort());
  });

  it('createDishGroup rejects empty name', async () => {
    const { createDishGroup } = await import('../dish-handler.js');
    await expect(async () =>
      createDishGroup(await makeGroupDeps(), { name: '' }),
    ).rejects.toThrow(/name is required/);
  });

  it('binds dish create to a valid group and rejects an unknown group', async () => {
    const { createDishGroup } = await import('../dish-handler.js');
    const deps = await makeGroupDeps();
    const { group } = createDishGroup(deps, { name: 'group-a' });

    const { dish: bound } = createDish(deps, {
      recipe_id: 'recipe-a',
      name: 'bound dish',
      group_id: group.group_id,
    });
    expect(bound.group_id).toBe(group.group_id);
    expect(deps.store.get(bound.dish_id)?.group_id).toBe(group.group_id);
    expect(deps.store.listByGroup(group.group_id).map((d) => d.dish_id)).toEqual([
      bound.dish_id,
    ]);

    expect(() =>
      createDish(deps, {
        recipe_id: 'recipe-a',
        group_id: 'dgrp_missing',
      }),
    ).toThrow(/not found/);
  });

  it('updates dish group membership, detaches on null, and validates bad group_id values', async () => {
    const { createDishGroup } = await import('../dish-handler.js');
    const deps = await makeGroupDeps();
    const { group } = createDishGroup(deps, { name: 'group-a' });
    const { dish: bound } = createDish(deps, {
      recipe_id: 'recipe-a',
      group_id: group.group_id,
    });

    const { dish: detached } = updateDish(deps, bound.dish_id, { group_id: null });
    expect(detached.group_id).toBeUndefined();
    expect(deps.store.get(bound.dish_id)?.group_id).toBeUndefined();
    expect(deps.store.listByGroup(group.group_id)).toEqual([]);

    expect(() =>
      updateDish(deps, bound.dish_id, { group_id: 'dgrp_missing' }),
    ).toThrow(/not found/);
    expect(() =>
      updateDish(deps, bound.dish_id, { group_id: 7 }),
    ).toThrow(/group_id must be a string or null/);
  });

  it('deleteDishGroup checks existence, detaches members, and returns detached dish ids', async () => {
    const { createDishGroup, deleteDishGroup } = await import('../dish-handler.js');
    const deps = await makeGroupDeps();

    expect(() => deleteDishGroup(deps, 'dgrp_missing')).toThrow(/not found/);

    const { group } = createDishGroup(deps, { name: 'group-a' });
    const { dish: first } = createDish(deps, {
      recipe_id: 'recipe-a',
      name: 'first',
      group_id: group.group_id,
    });
    const { dish: second } = createDish(deps, {
      recipe_id: 'recipe-b',
      name: 'second',
      group_id: group.group_id,
    });

    const result = deleteDishGroup(deps, group.group_id);
    expect(result.deleted).toBe(true);
    expect([...result.detached_dish_ids].sort()).toEqual([
      first.dish_id,
      second.dish_id,
    ].sort());
    expect(deps.groupStore.get(group.group_id)).toBeNull();
    expect(deps.store.listByGroup(group.group_id)).toEqual([]);

    for (const id of [first.dish_id, second.dish_id]) {
      const survived = deps.store.get(id);
      expect(survived).not.toBeNull();
      expect(survived).not.toHaveProperty('group_id');
    }
  });

  it('deleteDishGroup on unknown group returns not_found', async () => {
    const { deleteDishGroup } = await import('../dish-handler.js');
    const deps = await makeGroupDeps();
    expect(() => deleteDishGroup(deps, 'dgrp_missing')).toThrow(/not found/);
  });

  it('constructs dish store twice on the same db without re-running ALTER unsafely', () => {
    const db = makeDb();
    expect(() => {
      createDishStore(db);
      createDishStore(db);
    }).not.toThrow();

    const store = createDishStore(db);
    store.set(dish({ dish_id: 'dsh_idempotent', group_id: 'dgrp_existing' }));
    expect(store.listByGroup('dgrp_existing').map((d) => d.dish_id)).toEqual([
      'dsh_idempotent',
    ]);
  });

  it('D-319 — a run as a dish takes group ‹ dish ‹ its own values; with no dish, main ‹ its own', () => {
    // `mergeRecipeConfigLayers` is the ONE merge `handleExecute` and the
    // pre-approval preparation both apply after their dish checks.
    expect(mergeRecipeConfigLayers({
      requested: { shared: 'run', run_only: true },
      bound_dish: {
        group_overlay: { shared: 'group', group_only: true, tool: 'group-tool' },
        config_overlay: { shared: 'dish', dish_only: true, tool: 'dish-tool' },
      },
    })).toEqual({ shared: 'run', run_only: true, group_only: true, dish_only: true, tool: 'dish-tool' });
    // A bound run with no values of its own runs on the dish's.
    expect(mergeRecipeConfigLayers({ bound_dish: { config_overlay: { a: 1 } } })).toEqual({ a: 1 });
    // No dish: the main dish's settings under the run's.
    expect(mergeRecipeConfigLayers({ install: { a: 1, b: 1 }, requested: { b: 2 } })).toEqual({ a: 1, b: 2 });
  });
});
