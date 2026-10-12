/** D-319 amendment (owner, 2026-10-11): "scheduled runs should require the
 *  necessary fields for any recipes to run properly, that should apply to all
 *  recipes." The arming half, per handler, with the real gate: a schedule, a
 *  trigger or the timer is not armed for a dish whose settings leave empty one its
 *  recipe needs, and a dish that starts on its own is not switched on or saved
 *  that way. A refusal names the settings and makes nothing — not even the main
 *  dish a schedule would have made. The composition's wiring of the gate is
 *  proven in `serve-compose-listeners.test.ts`.
 *
 *  ⛔ Before, the dish form was the only check, and the run dialog's Schedule tab,
 *  the Automation timer dialog, a dish's switch and chat's `recipe.schedule` all
 *  went around it. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import { createDish, mainDishFor, updateDish, type DishHandlerDeps } from '../dish-handler.js';
import { createDishStore } from '../dish-store.js';
import { createSchedule, updateSchedule, type ScheduleHandlerDeps } from '../schedule-handler.js';
import { createScheduleStore } from '../schedule-store.js';
import { createEventTriggersStore } from '../triggers/store.js';
import { handleTriggersCreate, handleTriggersUpdate } from '../triggers/handler.js';
import { updateAutoRun, type AutoRunRpcDeps } from '../auto-run-handler.js';
import { createUnattendedSettingsGate } from '../unattended-settings-gate.js';

/** A timer recipe that cannot run without its board. */
const TIMER: RecipeDefinition = {
  recipe_id: 'board-digest', version: 1, ttl: 0,
  metadata: { name: 'Board digest', description: 'test', author: 'test', supported_platforms: [] },
  variables: { board: { label: 'Board', type: 'string' } },
  auto_run: { interval_ms: 3_600_000 },
  prefetch_steps: [], steps: [{ id: 'line', transform: 'template', template: '{{config.board}}' }],
  output: { render: [] },
} as unknown as RecipeDefinition;

/** A recipe run by hand, whose send refuses an empty "Send from". */
const MANUAL: RecipeDefinition = {
  recipe_id: 'thank-you', version: 1, ttl: 0,
  metadata: { name: 'Thank you', description: 'test', author: 'test', supported_platforms: [] },
  variables: { sender: { label: 'Send from', type: 'string', default: '' } },
  prefetch_steps: [],
  steps: [{ id: 'send', op: 'core.mail.send', fail_on: '{{config.sender}} is_empty', args: { sender_mail_instance: '{{config.sender}}' } }],
  output: { render: [] },
} as unknown as RecipeDefinition;

const RECIPES = new Map([TIMER, MANUAL].map((recipe) => [recipe.recipe_id, recipe]));

const world = () => {
  const db = new Database(':memory:');
  const dishStore = createDishStore(db);
  const scheduleStore = createScheduleStore(db);
  const triggerStore = createEventTriggersStore(db);
  const gate = createUnattendedSettingsGate({
    recipeOf: (recipe_id) => RECIPES.get(recipe_id) ?? null,
    dishOf: (dish_id) => dishStore.get(dish_id),
    mainDishOf: (recipe_id) => dishStore.getDefault(recipe_id),
    ownRowsOf: (dish_id) => scheduleStore.list().filter((s) => s.dish_id === dish_id).length
      + triggerStore.list().filter((t) => t.dish_id === dish_id).length,
  });
  const dishes: DishHandlerDeps = { store: dishStore, unattendedSettings: gate };
  const mainDish = (input: Parameters<typeof mainDishFor>[1]) => mainDishFor(dishes, input);
  const schedules: ScheduleHandlerDeps = { store: scheduleStore, dishStore, instanceId: 'i-1', mainDish, unattendedSettings: gate };
  const triggers = { store: triggerStore, dishStore, mainDish, unattendedSettings: gate };
  return { db, dishStore, scheduleStore, triggerStore, gate, dishes, schedules, triggers };
};

const refusedFor = (missing: string[]) => expect.objectContaining({
  code: 'dish_settings_missing',
  details: expect.objectContaining({ missing }),
});

describe('a dish that starts on its own', () => {
  it('is not switched on without what its recipe needs, and nothing is made', () => {
    const w = world();
    expect(() => createDish(w.dishes, { recipe_id: TIMER.recipe_id })).toThrow(refusedFor(['board']));
    expect(() => createDish(w.dishes, { recipe_id: TIMER.recipe_id })).toThrow(/"Board digest" runs on its own, so .* cannot be on with "Board" empty/);
    expect(w.dishStore.listByRecipe(TIMER.recipe_id)).toEqual([]);
    expect(createDish(w.dishes, { recipe_id: TIMER.recipe_id, config_overlay: { board: 'b-1' } }).dish.enabled).toBe(true);
  });

  it('cannot have the setting emptied while it is on; off, it can', () => {
    const w = world();
    const { dish } = createDish(w.dishes, { recipe_id: TIMER.recipe_id, config_overlay: { board: 'b-1' } });
    expect(() => updateDish(w.dishes, dish.dish_id, { config_overlay: { board: '' } })).toThrow(refusedFor(['board']));
    expect(w.dishStore.get(dish.dish_id)!.config_overlay).toEqual({ board: 'b-1' });
    updateDish(w.dishes, dish.dish_id, { enabled: false });
    expect(updateDish(w.dishes, dish.dish_id, { config_overlay: {} }).dish.config_overlay).toEqual({});
    expect(() => updateDish(w.dishes, dish.dish_id, { enabled: true })).toThrow(refusedFor(['board']));
  });

  it('a dish of a recipe run by hand saves without it: nothing of it runs on its own', () => {
    const w = world();
    expect(createDish(w.dishes, { recipe_id: MANUAL.recipe_id }).dish.enabled).toBe(true);
  });
});

describe('a schedule', () => {
  it('is not armed for a dish without what its recipe needs', () => {
    const w = world();
    const { dish } = createDish(w.dishes, { recipe_id: MANUAL.recipe_id });
    const make = () => createSchedule(w.schedules, { recipe_id: MANUAL.recipe_id, cron_expression: '0 9 * * *', dish_id: dish.dish_id });
    expect(make).toThrow(refusedFor(['sender']));
    expect(make).toThrow(/Fill it in the settings of/);
    expect(w.scheduleStore.list()).toEqual([]);
    updateDish(w.dishes, dish.dish_id, { config_overlay: { sender: 'work' } });
    expect(make().schedule.dish_id).toBe(dish.dish_id);
  });

  it('naming no dish, it makes no main dish when refused', () => {
    const w = world();
    expect(() => createSchedule(w.schedules, { recipe_id: MANUAL.recipe_id, cron_expression: '0 9 * * *' })).toThrow(refusedFor(['sender']));
    expect(w.dishStore.listByRecipe(MANUAL.recipe_id)).toEqual([]);
    expect(createSchedule(w.schedules, { recipe_id: MANUAL.recipe_id, cron_expression: '0 9 * * *', config_overlay: { sender: 'work' } })
      .schedule.dish_id).toBe(w.dishStore.getDefault(MANUAL.recipe_id)!.dish_id);
  });

  it('made off is not armed; switching it on is', () => {
    const w = world();
    const { dish } = createDish(w.dishes, { recipe_id: MANUAL.recipe_id });
    const { schedule } = createSchedule(w.schedules, { recipe_id: MANUAL.recipe_id, cron_expression: '0 9 * * *', dish_id: dish.dish_id, enabled: false });
    expect(() => updateSchedule(w.schedules, schedule.schedule_id, { enabled: true })).toThrow(refusedFor(['sender']));
    expect(w.scheduleStore.get(schedule.schedule_id)!.enabled).toBe(false);
  });

  it('makes its dish one that starts on its own: its settings cannot then be emptied', () => {
    const w = world();
    const { dish } = createDish(w.dishes, { recipe_id: MANUAL.recipe_id, config_overlay: { sender: 'work' } });
    createSchedule(w.schedules, { recipe_id: MANUAL.recipe_id, cron_expression: '0 9 * * *', dish_id: dish.dish_id });
    expect(() => updateDish(w.dishes, dish.dish_id, { config_overlay: { sender: '' } })).toThrow(refusedFor(['sender']));
  });
});

describe('a trigger', () => {
  it('is not armed for a dish without what its recipe needs, made or switched on', async () => {
    const w = world();
    const { dish } = createDish(w.dishes, { recipe_id: MANUAL.recipe_id });
    const base = { recipe_id: MANUAL.recipe_id, publisher_id: 'local', pattern: 'data.mail.**', dish_id: dish.dish_id };
    await expect(handleTriggersCreate(w.triggers, base)).rejects.toThrow(refusedFor(['sender']));
    const { trigger } = await handleTriggersCreate(w.triggers, { ...base, enabled: false });
    await expect(handleTriggersUpdate(w.triggers, { trigger_id: trigger.trigger_id, enabled: true })).rejects.toThrow(refusedFor(['sender']));
    expect(w.triggerStore.get(trigger.trigger_id)!.enabled).toBe(false);
  });
});

describe('the auto-run timer', () => {
  it('is not switched on for a dish without what its recipe needs', async () => {
    const w = world();
    const { dish } = createDish(w.dishes, { recipe_id: TIMER.recipe_id, config_overlay: { board: 'b-1' } });
    updateDish(w.dishes, dish.dish_id, { enabled: false });
    updateDish(w.dishes, dish.dish_id, { config_overlay: {} });
    const deps = { dishStore: w.dishStore, unattendedSettings: w.gate } as unknown as AutoRunRpcDeps;
    await expect(updateAutoRun(deps, { dish_id: dish.dish_id, enabled: true })).rejects.toThrow(refusedFor(['board']));
  });

  it('switched on by recipe, it makes no main dish when refused', async () => {
    const w = world();
    const deps = {
      recipeStore: { listStored: () => [{ recipe_json: JSON.stringify(TIMER), publisher_id: 'local' }] },
      dishStore: w.dishStore,
      mainDish: (input: Parameters<typeof mainDishFor>[1]) => mainDishFor(w.dishes, input),
      unattendedSettings: w.gate,
    } as unknown as AutoRunRpcDeps;
    await expect(updateAutoRun(deps, { recipe_id: TIMER.recipe_id, enabled: true })).rejects.toThrow(refusedFor(['board']));
    expect(w.dishStore.listByRecipe(TIMER.recipe_id)).toEqual([]);
  });
});
