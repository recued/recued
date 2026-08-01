/** D-179 P1 — dish substrate unit coverage.
 *
 *  Covers the three new server pieces:
 *    1. `dish-store` — CRUD round-trip, default-dish partial unique
 *       index (upsert must SURFACE the constraint, never OR-REPLACE the
 *       existing default away), byte-delta reporting.
 *    2. `dish-context-store` — snapshot round-trip + corrupt-row
 *       degradation to first-run semantics.
 *    3. `dish-handler` — rpc validation (lifecycle fields rejected when
 *       malformed), default-dish conflict mapping, delete clearing the
 *       continuity snapshot.
 *
 *  Spec: D-179 (RATIFIED 2026-06-12).
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
  getRecipeConfig,
  listDishes,
  setRecipeConfig,
  updateDish,
  type DishHandlerDeps,
} from '../dish-handler.js';

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
  const makeDeps = (): DishHandlerDeps & { store: DishStore } => {
    const db = makeDb();
    return {
      store: createDishStore(db),
      contextStore: createDishContextStore(db),
      now: () => 5_000,
    };
  };

  it('creates with defaults and lists by recipe', async () => {
    const deps = makeDeps();
    const { dish: created } = createDish(deps, {
      recipe_id: 'recipe-a',
      name: 'repo: x',
      config_overlay: { repo_dir: '/x' },
    });
    expect(created.dish_id.startsWith('dsh_')).toBe(true);
    expect(created.enabled).toBe(true);
    expect(created.is_default).toBe(false);
    expect(created.created_at).toBe(5_000);
    expect((await listDishes(deps, { recipe_id: 'recipe-a' })).dishes).toEqual([created]);
    expect((await listDishes(deps, { recipe_id: 'recipe-zzz' })).dishes).toEqual([]);
  });

  it.each([
    [{ name: 7 }, /name must be a string/],
    [{ enabled: 'yes' }, /enabled must be a boolean/],
    [{ is_default: 1 }, /is_default must be a boolean/],
    [{ config_overlay: [1] }, /config_overlay must be an object/],
  ] as const)('create rejects malformed input %j', (bad, message) => {
    const deps = makeDeps();
    expect(() => createDish(deps, { recipe_id: 'recipe-a', ...bad })).toThrow(message);
  });

  it('create requires recipe_id', () => {
    expect(() => createDish(makeDeps(), {})).toThrow(/recipe_id is required/);
  });

  it('maps a second default dish to a conflict error (pre-check AND race backstop)', () => {
    const deps = makeDeps();
    createDish(deps, { recipe_id: 'recipe-a', is_default: true });
    expect(() =>
      createDish(deps, { recipe_id: 'recipe-a', is_default: true }),
    ).toThrow(/already has a default dish/);
    // Race backstop: bypass the pre-check by inserting the competing
    // default directly at the store layer, then verify the handler's
    // constraint-mapping path also yields the conflict shape.
    const fresh = makeDeps();
    fresh.store.set(dish({ dish_id: 'dsh_racer', recipe_id: 'recipe-r', is_default: true }));
    const getDefault = fresh.store.getDefault.bind(fresh.store);
    fresh.store.getDefault = (() => null) as typeof fresh.store.getDefault; // simulate losing the race
    expect(() =>
      createDish(fresh, { recipe_id: 'recipe-r', is_default: true }),
    ).toThrow(/already has a default dish/);
    fresh.store.getDefault = getDefault;
  });

  it('updates name / overlay / enabled and rejects malformed lifecycle input', () => {
    const deps = makeDeps();
    const { dish: created } = createDish(deps, { recipe_id: 'recipe-a' });

    const { dish: updated } = updateDish(deps, created.dish_id, {
      name: 'renamed',
      config_overlay: { repo_dir: '/y' },
      enabled: false,
    });
    expect(updated.name).toBe('renamed');
    expect(updated.config_overlay).toEqual({ repo_dir: '/y' });
    expect(updated.enabled).toBe(false);

    expect(() => updateDish(deps, created.dish_id, { enabled: 'no' })).toThrow(
      /enabled must be a boolean/,
    );
    expect(() => updateDish(deps, created.dish_id, { name: 9 })).toThrow(
      /name must be a string/,
    );
    expect(() => updateDish(deps, 'dsh_missing', {})).toThrow(/not found/);
  });

  it('delete removes the dish AND its continuity snapshot', () => {
    const deps = makeDeps();
    const { dish: created } = createDish(deps, { recipe_id: 'recipe-a' });
    deps.contextStore!.set(created.dish_id, { step1: 42 });

    expect(deleteDish(deps, created.dish_id)).toEqual({ deleted: true });
    expect(deps.store.get(created.dish_id)).toBeNull();
    expect(deps.contextStore!.get(created.dish_id)).toBeNull();
    expect(() => deleteDish(deps, created.dish_id)).toThrow(/not found/);
  });
});

// ── D-179 P2 — attachment binding validation ─────────────────────

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

    // update: null detaches; bad value rejects.
    const detached = await handleTriggersUpdate(deps, {
      trigger_id: trigger.trigger_id,
      dish_id: null,
    });
    expect(detached.trigger.dish_id).toBeUndefined();
    await expect(handleTriggersUpdate(deps, {
      trigger_id: trigger.trigger_id,
      watch_interval_ms: -5,
    })).rejects.toThrow(/watch_interval_ms/);
  });
});

// ── D-179 config-on-schedule/trigger — managed overlay dish ──────
// A schedule/trigger created with a non-empty `config_overlay` and no
// explicit dish mints a managed dish to carry the overlay into headless
// fires; deleting the row dissolves it.

describe('schedule create/delete — managed overlay dish', () => {
  const makeDeps = async (now = () => 5_000) => {
    const { createScheduleStore } = await import('../schedule-store.js');
    const db = makeDb();
    const dishStore = createDishStore(db);
    const contextStore = createDishContextStore(db);
    return {
      dishStore,
      contextStore,
      deps: {
        store: createScheduleStore(makeDb()),
        dishStore,
        dishContextStore: contextStore,
        instanceId: 'i-1',
        now,
      },
    };
  };

  it('mints a managed dish holding the overlay + binds the schedule to it', async () => {
    const { dishStore, deps } = await makeDeps();
    const { createSchedule } = await import('../schedule-handler.js');

    const { schedule } = createSchedule(deps, {
      recipe_id: 'recipe-a',
      cron_expression: '0 9 * * *',
      config_overlay: { threshold: 30 },
    });

    expect(schedule.dish_id).toBeDefined();
    const minted = dishStore.get(schedule.dish_id!);
    expect(minted).toMatchObject({
      recipe_id: 'recipe-a',
      config_overlay: { threshold: 30 },
      is_default: false,
      enabled: true,
      managed_by_schedule_id: schedule.schedule_id,
      created_at: 5_000,
    });
  });

  it('mints nothing for an empty overlay (fires on recipe defaults)', async () => {
    const { dishStore, deps } = await makeDeps();
    const { createSchedule } = await import('../schedule-handler.js');
    const { schedule } = createSchedule(deps, {
      recipe_id: 'recipe-a',
      cron_expression: '0 9 * * *',
      config_overlay: {},
    });
    expect(schedule.dish_id).toBeUndefined();
    expect(dishStore.list()).toEqual([]);
  });

  it('lets an explicit dish_id win over config_overlay (no mint)', async () => {
    const { dishStore, deps } = await makeDeps();
    dishStore.set(dish({ dish_id: 'dsh_user', recipe_id: 'recipe-a' }));
    const { createSchedule } = await import('../schedule-handler.js');
    const { schedule } = createSchedule(deps, {
      recipe_id: 'recipe-a',
      cron_expression: '0 9 * * *',
      dish_id: 'dsh_user',
      config_overlay: { threshold: 30 },
    });
    expect(schedule.dish_id).toBe('dsh_user');
    expect(dishStore.list().map((d) => d.dish_id)).toEqual(['dsh_user']);
  });

  it('rejects a non-object config_overlay', async () => {
    const { deps } = await makeDeps();
    const { createSchedule } = await import('../schedule-handler.js');
    expect(() => createSchedule(deps, {
      recipe_id: 'recipe-a',
      cron_expression: '0 9 * * *',
      config_overlay: 'nope',
    })).toThrow(/config_overlay must be an object/);
  });

  it('dissolves its managed dish + continuity snapshot on delete but never a user-assigned one', async () => {
    const { dishStore, contextStore, deps } = await makeDeps();
    const { createSchedule, deleteSchedule } = await import('../schedule-handler.js');

    const { schedule } = createSchedule(deps, {
      recipe_id: 'recipe-a',
      cron_expression: '0 9 * * *',
      config_overlay: { threshold: 30 },
    });
    const managedDishId = schedule.dish_id!;
    contextStore.set(managedDishId, { step_a: 1 });
    deleteSchedule(deps, schedule.schedule_id);
    expect(dishStore.get(managedDishId)).toBeNull();
    expect(contextStore.get(managedDishId)).toBeNull(); // snapshot cleared too

    // A user-assigned binding + its snapshot survive the schedule's deletion.
    dishStore.set(dish({ dish_id: 'dsh_user', recipe_id: 'recipe-a' }));
    contextStore.set('dsh_user', { step_a: 2 });
    const { schedule: bound } = createSchedule(deps, {
      recipe_id: 'recipe-a',
      cron_expression: '0 9 * * *',
      dish_id: 'dsh_user',
    });
    deleteSchedule(deps, bound.schedule_id);
    expect(dishStore.get('dsh_user')).not.toBeNull();
    expect(contextStore.get('dsh_user')).not.toBeNull();
  });

  it('edit: a config change on update mints a new dish + dissolves the prior (immutable)', async () => {
    const { dishStore, contextStore, deps } = await makeDeps();
    const { createSchedule, updateSchedule } = await import('../schedule-handler.js');

    const { schedule } = createSchedule(deps, {
      recipe_id: 'recipe-a',
      cron_expression: '0 9 * * *',
      config_overlay: { threshold: 30 },
    });
    const first = schedule.dish_id!;
    contextStore.set(first, { step_a: 1 });

    const { schedule: edited } = updateSchedule(deps, schedule.schedule_id, {
      config_overlay: { threshold: 50 },
    });
    expect(edited.dish_id).not.toBe(first); // new immutable dish
    expect(dishStore.get(first)).toBeNull(); // prior dissolved, never mutated
    expect(contextStore.get(first)).toBeNull(); // + its snapshot
    expect(dishStore.get(edited.dish_id!)).toMatchObject({ config_overlay: { threshold: 50 } });
  });

  it('edit: an identical config is a no-op; empty clears', async () => {
    const { dishStore, deps } = await makeDeps();
    const { createSchedule, updateSchedule } = await import('../schedule-handler.js');

    const { schedule } = createSchedule(deps, {
      recipe_id: 'recipe-a',
      cron_expression: '0 9 * * *',
      config_overlay: { a: 1, b: 2 },
    });
    const first = schedule.dish_id!;
    const { schedule: same } = updateSchedule(deps, schedule.schedule_id, {
      config_overlay: { b: 2, a: 1 }, // key order aside
    });
    expect(same.dish_id).toBe(first); // no churn

    const { schedule: cleared } = updateSchedule(deps, schedule.schedule_id, {
      config_overlay: {},
    });
    expect(cleared.dish_id).toBeUndefined(); // cleared
    expect(dishStore.get(first)).toBeNull(); // prior dissolved
  });
});

describe('trigger create/delete — managed overlay dish', () => {
  const makeDeps = async () => {
    const { createEventTriggersStore } = await import('../triggers/store.js');
    const db = makeDb();
    const dishStore = createDishStore(db);
    const contextStore = createDishContextStore(db);
    return {
      dishStore,
      contextStore,
      deps: {
        store: createEventTriggersStore(db),
        dishStore,
        dishContextStore: contextStore,
      },
    };
  };

  it('mints a managed dish holding the overlay + binds the trigger to it', async () => {
    const { dishStore, deps } = await makeDeps();
    const { handleTriggersCreate } = await import('../triggers/handler.js');

    const { trigger } = await handleTriggersCreate(deps, {
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      config_overlay: { threshold: 30 },
    });

    expect(trigger.dish_id).toBeDefined();
    expect(dishStore.get(trigger.dish_id!)).toMatchObject({
      recipe_id: 'recipe-a',
      config_overlay: { threshold: 30 },
      managed_by_trigger_id: trigger.trigger_id,
    });
  });

  it('mints nothing for an empty overlay', async () => {
    const { dishStore, deps } = await makeDeps();
    const { handleTriggersCreate } = await import('../triggers/handler.js');
    const { trigger } = await handleTriggersCreate(deps, {
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      config_overlay: {},
    });
    expect(trigger.dish_id).toBeUndefined();
    expect(dishStore.list()).toEqual([]);
  });

  it('dissolves its managed dish + continuity snapshot on delete but never a user-assigned one', async () => {
    const { dishStore, contextStore, deps } = await makeDeps();
    const { handleTriggersCreate, handleTriggersDelete } = await import('../triggers/handler.js');

    const { trigger } = await handleTriggersCreate(deps, {
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      config_overlay: { threshold: 30 },
    });
    const managedDishId = trigger.dish_id!;
    contextStore.set(managedDishId, { step_a: 1 });
    await handleTriggersDelete(deps, { trigger_id: trigger.trigger_id });
    expect(dishStore.get(managedDishId)).toBeNull();
    expect(contextStore.get(managedDishId)).toBeNull(); // snapshot cleared too

    dishStore.set(dish({ dish_id: 'dsh_user', recipe_id: 'recipe-a' }));
    contextStore.set('dsh_user', { step_a: 2 });
    const { trigger: bound } = await handleTriggersCreate(deps, {
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.calendar.**',
      dish_id: 'dsh_user',
    });
    await handleTriggersDelete(deps, { trigger_id: bound.trigger_id });
    expect(dishStore.get('dsh_user')).not.toBeNull();
    expect(contextStore.get('dsh_user')).not.toBeNull();
  });

  it('edit: a config change via update mints a new dish + dissolves the prior; empty clears', async () => {
    const { dishStore, contextStore, deps } = await makeDeps();
    const { handleTriggersCreate, handleTriggersUpdate } = await import('../triggers/handler.js');

    const { trigger } = await handleTriggersCreate(deps, {
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      config_overlay: { threshold: 30 },
    });
    const first = trigger.dish_id!;
    contextStore.set(first, { step_a: 1 });

    const { trigger: edited } = await handleTriggersUpdate(deps, {
      trigger_id: trigger.trigger_id,
      config_overlay: { threshold: 50 },
    });
    expect(edited.dish_id).not.toBe(first); // new immutable dish
    expect(dishStore.get(first)).toBeNull(); // prior dissolved
    expect(contextStore.get(first)).toBeNull(); // + its snapshot
    expect(dishStore.get(edited.dish_id!)).toMatchObject({ config_overlay: { threshold: 50 } });

    // Empty clears (dish detached + dissolved).
    const { trigger: cleared } = await handleTriggersUpdate(deps, {
      trigger_id: trigger.trigger_id,
      config_overlay: {},
    });
    expect(cleared.dish_id).toBeUndefined();
    expect(dishStore.get(edited.dish_id!)).toBeNull();
  });
});

describe('recipe install config (recipe_config.*) — default-dish overlay (D-179)', () => {
  const makeRcDeps = (): DishHandlerDeps => {
    const db = makeDb();
    return {
      store: createDishStore(db),
      contextStore: createDishContextStore(db),
      now: () => 5_000,
    };
  };

  it('set creates the is_default dish when none exists; get reads it back', () => {
    const deps = makeRcDeps();
    expect(getRecipeConfig(deps, { recipe_id: 'recipe-a' }).config_overlay).toEqual({});
    setRecipeConfig(deps, { recipe_id: 'recipe-a', config_overlay: { threshold: 30 } });
    const dishes = deps.store.listByRecipe('recipe-a');
    expect(dishes).toHaveLength(1);
    expect(dishes[0]).toMatchObject({
      is_default: true,
      config_overlay: { threshold: 30 },
      name: '',
    });
    expect(getRecipeConfig(deps, { recipe_id: 'recipe-a' }).config_overlay).toEqual({ threshold: 30 });
  });

  it('set updates the SAME dish in place — mutable config source, dish_id stable', () => {
    const deps = makeRcDeps();
    setRecipeConfig(deps, { recipe_id: 'recipe-a', config_overlay: { threshold: 30 } });
    const first = deps.store.listByRecipe('recipe-a')[0]!.dish_id;
    setRecipeConfig(deps, { recipe_id: 'recipe-a', config_overlay: { threshold: 50 } });
    const dishes = deps.store.listByRecipe('recipe-a');
    expect(dishes).toHaveLength(1);
    expect(dishes[0].dish_id).toBe(first); // in place, NOT a new dish (config source ≠ dispatch identity)
    expect(dishes[0].config_overlay).toEqual({ threshold: 50 });
  });

  it('set with empty {} clears install config (drops the default dish + its snapshot)', () => {
    const deps = makeRcDeps();
    setRecipeConfig(deps, { recipe_id: 'recipe-a', config_overlay: { threshold: 30 } });
    const dishId = deps.store.listByRecipe('recipe-a')[0]!.dish_id;
    deps.contextStore!.set(dishId, { step_a: 1 });
    setRecipeConfig(deps, { recipe_id: 'recipe-a', config_overlay: {} });
    expect(deps.store.listByRecipe('recipe-a')).toEqual([]);
    expect(deps.contextStore!.get(dishId)).toBeNull();
    expect(getRecipeConfig(deps, { recipe_id: 'recipe-a' }).config_overlay).toEqual({});
  });

  it('rejects a non-object config_overlay + a missing recipe_id', () => {
    const deps = makeRcDeps();
    expect(() => setRecipeConfig(deps, { recipe_id: 'recipe-a', config_overlay: 'nope' }))
      .toThrow(/config_overlay must be an object/);
    expect(() => setRecipeConfig(deps, { config_overlay: {} }))
      .toThrow(/recipe_id is required/);
  });

  it('gates a set on the storage admission check (same posture as dishes.create)', () => {
    const db = makeDb();
    const deps: DishHandlerDeps = {
      store: createDishStore(db),
      contextStore: createDishContextStore(db),
      now: () => 5_000,
      gate: {
        canWrite: () => ({ ok: false, reason: 'writes_blocked' }),
      } as unknown as DishHandlerDeps['gate'],
    };
    expect(() => setRecipeConfig(deps, {
      recipe_id: 'recipe-a',
      config_overlay: { note: 'x'.repeat(200) },
    })).toThrow(/rejected/);
    // A clearing set frees space → never gated.
    expect(() => setRecipeConfig(deps, { recipe_id: 'recipe-a', config_overlay: {} }))
      .not.toThrow();
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

  it('propagates group and dish overlays with dish precedence over group over install config', async () => {
    const { makeDishHandlers } = await import('../dish-handler.js');
    const deps = await makeGroupDeps();
    const handlers = makeDishHandlers(deps)!.handlers;

    const { group } = await handlers['dish_groups.create']({
      name: 'pipeline',
      config_overlay: {
        shared: 'group',
        group_only: true,
        tool: 'group-tool',
      },
    }, undefined as never) as { group: { group_id: string } };
    const { dish: created } = await handlers['dishes.create']({
      recipe_id: 'recipe-a',
      group_id: group.group_id,
      config_overlay: {
        shared: 'dish',
        dish_only: true,
      },
    }, undefined as never) as { dish: { dish_id: string } };

    const storedGroup = deps.groupStore.get(group.group_id)!;
    const storedDish = deps.store.get(created.dish_id)!;

    // No execute-handler harness exists in this suite; assert the
    // store+handler propagation that feeds its documented merge:
    // { ...installConfig, ...groupOverlay, ...dishOverlay }.
    const resolved = {
      shared: 'install',
      install_only: true,
      tool: 'install-tool',
      ...storedGroup.config_overlay,
      ...storedDish.config_overlay,
    };

    expect(resolved).toEqual({
      shared: 'dish',
      install_only: true,
      group_only: true,
      dish_only: true,
      tool: 'group-tool',
    });
  });
});
