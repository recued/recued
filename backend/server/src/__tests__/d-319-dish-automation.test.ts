/** D-319 — a dish is a recipe switched on, and the rows that start it on its
 *  own follow it: made with it, switched with it, re-pointed with its
 *  template setting, removed with it.
 *
 *  Over the real stores and the real reconciler, wired as compose-listeners
 *  wires them (`createDishAutomation` onto the dish rpc deps, `mainDishFor`
 *  onto the schedule and trigger rpc deps). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RecipeDefinition } from '@recued/contracts';

import { createAutoRunSettingsStore, createCircuitBreakerStore, type AutoRunSettingsStore, type CircuitBreakerStore } from '../auto-run-scheduler.js';
import { createDishAutomation, type DishAutomationDeps } from '../dish-automation.js';
import { createDishContextStore } from '../dish-context-store.js';
import { createDish, deleteDish, mainDishFor, updateDish, type DishHandlerDeps } from '../dish-handler.js';
import { createDishStore } from '../dish-store.js';
import { createScheduleStore } from '../schedule-store.js';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  updateSchedule,
  type ScheduleHandlerDeps,
} from '../schedule-handler.js';
import { reconcileDeclarativeTriggers, type StoredRecipeRowLike } from '../triggers/declarative-reconciler.js';
import { handleTriggersCreate, type TriggersRpcDeps } from '../triggers/handler.js';
import { createEventTriggersStore, type EventTriggersStore } from '../triggers/store.js';

const NOW = Date.UTC(2026, 8, 29, 9, 0, 0);

const recipe = (recipe_id: string, event_triggers: Array<Record<string, unknown>>): StoredRecipeRowLike => ({
  recipe_id,
  publisher_id: 'recued-core',
  recipe_json: JSON.stringify({ recipe_id, version: 1, event_triggers } as Partial<RecipeDefinition>),
});

let db: Database.Database;
let triggers: EventTriggersStore;
let dishDeps: DishHandlerDeps;
let scheduleDeps: ScheduleHandlerDeps;
let triggerDeps: TriggersRpcDeps;
let recipes: StoredRecipeRowLike[];
let emitted: string[];
let rebuilds: number;
let timers: AutoRunSettingsStore;
let circuits: CircuitBreakerStore;
let rosterRefreshes: number;
let resets: string[];

const wire = (overrides: Partial<DishAutomationDeps> = {}): void => {
  dishDeps.automation = createDishAutomation({
    triggers: {
      store: triggers,
      reconcile: () => reconcileDeclarativeTriggers({
        store: triggers,
        listStored: () => recipes,
        listDishes: () => dishDeps.store.list(),
        now: () => NOW,
      }).changed,
      rebuild: () => { rebuilds += 1; },
    },
    schedules: {
      list: () => listSchedules(scheduleDeps, {}).schedules,
      setEnabled: (schedule_id, enabled) => { updateSchedule(scheduleDeps, schedule_id, { enabled }); },
      remove: (schedule_id) => { deleteSchedule(scheduleDeps, schedule_id); },
    },
    autoRun: {
      isAutoRun: (recipe_id) => recipe_id === 'ticker',
      timers,
      circuits,
      refresh: () => { rosterRefreshes += 1; },
      resetCircuit: (dish_id) => { resets.push(dish_id); },
    },
    eventBus: {
      emit: (event: { kind: string; mechanism?: string }) => { emitted.push(`${event.kind}:${event.mechanism ?? ''}`); },
    } as never,
    log: () => undefined,
    ...overrides,
  });
};

beforeEach(() => {
  db = new Database(':memory:');
  triggers = createEventTriggersStore(db);
  dishDeps = { store: createDishStore(db), contextStore: createDishContextStore(db), now: () => NOW };
  const mainDish = (input: Parameters<typeof mainDishFor>[1]) => mainDishFor(dishDeps, input);
  scheduleDeps = { store: createScheduleStore(db), dishStore: dishDeps.store, mainDish, instanceId: 'i-1', now: () => NOW };
  triggerDeps = { store: triggers, dishStore: dishDeps.store, mainDish, now: () => NOW };
  recipes = [recipe('watcher', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.updated' }])];
  emitted = [];
  rebuilds = 0;
  timers = createAutoRunSettingsStore(db);
  circuits = createCircuitBreakerStore(db);
  rosterRefreshes = 0;
  resets = [];
  wire();
});

afterEach(() => { db.close(); });

const rowsOf = (dish_id: string) => triggers.list().filter((row) => row.dish_id === dish_id);
const schedulesOf = (dish_id: string) => scheduleDeps.store.list().filter((row) => row.dish_id === dish_id);

describe('switching on — `dishes.create`', () => {
  it('makes the recipe’s declared triggers for the dish, on, and says so', () => {
    const { dish } = createDish(dishDeps, { recipe_id: 'watcher', publisher_id: 'recued-core' });
    expect(rowsOf(dish.dish_id).map((row) => [row.pattern, row.enabled, row.origin]).sort()).toEqual([
      ['data.mail.**.created', true, 'recipe'],
      ['data.mail.**.updated', true, 'recipe'],
    ]);
    expect(rebuilds).toBeGreaterThan(0);
    expect(emitted).toContain('automation_rule_changed:dish');
    expect(emitted).toContain('automation_rule_changed:event_trigger');
  });

  it('a dish made off has its triggers, off', () => {
    const { dish } = createDish(dishDeps, { recipe_id: 'watcher', enabled: false });
    expect(rowsOf(dish.dish_id)).toHaveLength(2);
    expect(rowsOf(dish.dish_id).every((row) => !row.enabled)).toBe(true);
  });

  it('a second dish gets its own copies; the first is untouched', () => {
    const { dish: work } = createDish(dishDeps, { recipe_id: 'watcher' });
    const workRows = rowsOf(work.dish_id).map((row) => row.trigger_id).sort();
    const { dish: home } = createDish(dishDeps, { recipe_id: 'watcher', name: 'Home' });
    expect(rowsOf(home.dish_id).every((row) => row.enabled)).toBe(true);
    expect(rowsOf(work.dish_id).map((row) => row.trigger_id).sort()).toEqual(workRows);
    expect(triggers.list()).toHaveLength(4);
  });
});

describe('a schedule or trigger that names no dish', () => {
  it('makes the main dish from its settings, and only that row runs — the recipe’s own triggers wait for the switch', () => {
    const { schedule } = createSchedule(scheduleDeps, {
      recipe_id: 'watcher', publisher_id: 'recued-core', cron_expression: '0 9 * * *', config_overlay: { folder: 'Inbox' },
    });
    const main = dishDeps.store.getDefault('watcher')!;
    expect(main).toMatchObject({ enabled: true, config_overlay: { folder: 'Inbox' } });
    expect(schedule).toMatchObject({ dish_id: main.dish_id, enabled: true });
    expect(rowsOf(main.dish_id)).toHaveLength(2);
    expect(rowsOf(main.dish_id).every((row) => !row.enabled)).toBe(true);
  });

  it('an owner’s trigger naming no dish joins the main dish that exists', async () => {
    const { dish: main } = createDish(dishDeps, { recipe_id: 'watcher' });
    const { trigger } = await handleTriggersCreate(triggerDeps, {
      recipe_id: 'watcher', publisher_id: 'recued-core', pattern: 'data.calendar.**',
    });
    expect(trigger).toMatchObject({ dish_id: main.dish_id, origin: 'user' });
  });
});

describe('the switch — `dishes.update { enabled }`', () => {
  it('off writes every row of the dish off — its triggers, the owner’s, its schedules — and no other dish’s', async () => {
    const { dish: work } = createDish(dishDeps, { recipe_id: 'watcher' });
    const { dish: home } = createDish(dishDeps, { recipe_id: 'watcher', name: 'Home' });
    await handleTriggersCreate(triggerDeps, { recipe_id: 'watcher', publisher_id: 'recued-core', pattern: 'data.calendar.**', dish_id: work.dish_id });
    createSchedule(scheduleDeps, { recipe_id: 'watcher', cron_expression: '0 9 * * *', dish_id: work.dish_id });

    updateDish(dishDeps, work.dish_id, { enabled: false });
    expect(rowsOf(work.dish_id)).toHaveLength(3);
    expect(rowsOf(work.dish_id).every((row) => !row.enabled)).toBe(true);
    expect(schedulesOf(work.dish_id).every((row) => !row.enabled)).toBe(true);
    expect(rowsOf(home.dish_id).every((row) => row.enabled)).toBe(true);
  });

  it('on re-arms every row, including one the server stopped after failures — even when the dish is already on', () => {
    const { dish } = createDish(dishDeps, { recipe_id: 'watcher' });
    const [tripped] = rowsOf(dish.dish_id);
    // D-268 — the dispatcher's error cap switches a row off; its dish stays on.
    triggers.update(tripped!.trigger_id, { enabled: false, last_error: 'mailbox refused' });
    expect(dishDeps.store.get(dish.dish_id)!.enabled).toBe(true);

    updateDish(dishDeps, dish.dish_id, { enabled: true });
    expect(rowsOf(dish.dish_id).every((row) => row.enabled)).toBe(true);
  });

  it('a schedule the server stopped comes back with its failure count cleared (D-268, as the owner’s own re-arm)', () => {
    const { dish } = createDish(dishDeps, { recipe_id: 'watcher' });
    const { schedule } = createSchedule(scheduleDeps, { recipe_id: 'watcher', cron_expression: '0 9 * * *', dish_id: dish.dish_id });
    scheduleDeps.store.updateRun(schedule.schedule_id, { enabled: false, consecutive_failures: 5 });
    updateDish(dishDeps, dish.dish_id, { enabled: true });
    expect(scheduleDeps.store.get(schedule.schedule_id)).toMatchObject({ enabled: true, consecutive_failures: 0 });
  });

  it('⛔ a one-shot that already ran is its retry handle, not a timer: switching on leaves it off', () => {
    const { dish } = createDish(dishDeps, { recipe_id: 'watcher' });
    const { schedule } = createSchedule(scheduleDeps, {
      recipe_id: 'watcher', mode: 'one_shot', run_at: NOW + 60_000, dish_id: dish.dish_id,
    });
    scheduleDeps.store.updateRun(schedule.schedule_id, { enabled: false, last_run_at: NOW, last_status: 'error' });
    const { schedule: pending } = createSchedule(scheduleDeps, {
      recipe_id: 'watcher', mode: 'one_shot', run_at: NOW + 120_000, dish_id: dish.dish_id,
    });
    updateDish(dishDeps, dish.dish_id, { enabled: false });
    updateDish(dishDeps, dish.dish_id, { enabled: true });
    expect(scheduleDeps.store.get(schedule.schedule_id)!.enabled).toBe(false);
    expect(scheduleDeps.store.get(pending.schedule_id)!.enabled).toBe(true);
  });

  it('one row that cannot follow does not stop the others, nor fail the owner’s switch', () => {
    const { dish } = createDish(dishDeps, { recipe_id: 'watcher' });
    createSchedule(scheduleDeps, { recipe_id: 'watcher', cron_expression: '0 9 * * *', dish_id: dish.dish_id });
    wire({
      schedules: {
        list: () => listSchedules(scheduleDeps, {}).schedules,
        setEnabled: () => { throw new Error('store busy'); },
        remove: () => undefined,
      },
    });
    expect(() => updateDish(dishDeps, dish.dish_id, { enabled: false })).not.toThrow();
    expect(dishDeps.store.get(dish.dish_id)!.enabled).toBe(false);
    expect(rowsOf(dish.dish_id).every((row) => !row.enabled)).toBe(true);
  });
});

describe('settings — `dishes.update { config_overlay }`', () => {
  it('a trigger narrowed to the dish’s template follows its new pick, in place and on', () => {
    recipes = [recipe('parcels', [{ on: 'mail_fact.shipment', template_variable: 'template' }])];
    const { dish } = createDish(dishDeps, { recipe_id: 'parcels', config_overlay: { template: 'mtpl_a' } });
    const [row] = rowsOf(dish.dish_id);
    expect(row).toMatchObject({ filter: { 'record.template': 'mtpl_a' }, enabled: true });
    updateDish(dishDeps, dish.dish_id, { config_overlay: { template: 'mtpl_b' } });
    expect(triggers.get(row!.trigger_id)).toMatchObject({ filter: { 'record.template': 'mtpl_b' }, enabled: true });
    // The dish is the same dish: its settings changed in place.
    expect(dishDeps.store.get(dish.dish_id)!.config_overlay).toEqual({ template: 'mtpl_b' });
  });
});

describe('removing — `dishes.delete`', () => {
  it('takes its triggers (the recipe’s and the owner’s) and schedules with it, and leaves the other dish’s', async () => {
    const { dish: work } = createDish(dishDeps, { recipe_id: 'watcher' });
    const { dish: home } = createDish(dishDeps, { recipe_id: 'watcher', name: 'Home' });
    await handleTriggersCreate(triggerDeps, { recipe_id: 'watcher', publisher_id: 'recued-core', pattern: 'data.calendar.**', dish_id: work.dish_id });
    createSchedule(scheduleDeps, { recipe_id: 'watcher', cron_expression: '0 9 * * *', dish_id: work.dish_id });
    createSchedule(scheduleDeps, { recipe_id: 'watcher', cron_expression: '0 9 * * *', dish_id: home.dish_id });

    deleteDish(dishDeps, work.dish_id);
    expect(rowsOf(work.dish_id)).toEqual([]);
    expect(schedulesOf(work.dish_id)).toEqual([]);
    expect(rowsOf(home.dish_id)).toHaveLength(2);
    expect(schedulesOf(home.dish_id)).toHaveLength(1);
    // The main dish went: the other is main now.
    expect(dishDeps.store.getDefault('watcher')!.dish_id).toBe(home.dish_id);
  });
});

describe('the recipe changes', () => {
  it('a trigger an update adds is made OFF for a dish that is on — nothing starts because a recipe changed', () => {
    const { dish } = createDish(dishDeps, { recipe_id: 'watcher' });
    recipes = [recipe('watcher', [{ event: 'data.mail.**.created' }, { event: 'data.mail.**.updated' }, { event: 'data.mail.**.deleted' }])];
    dishDeps.automation!.settingsChanged(dishDeps.store.get(dish.dish_id)!);
    const added = rowsOf(dish.dish_id).find((row) => row.pattern === 'data.mail.**.deleted')!;
    expect(added.enabled).toBe(false);
    // Switching the dish on again starts it.
    updateDish(dishDeps, dish.dish_id, { enabled: true });
    expect(triggers.get(added.trigger_id)!.enabled).toBe(true);
  });
});

describe('an auto-run recipe — one timer per dish', () => {
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('switching on makes the dish’s timer, on; a dish made without the switch has none', async () => {
    const { dish: on } = createDish(dishDeps, { recipe_id: 'ticker' });
    const { dish: held } = createDish(dishDeps, { recipe_id: 'ticker', name: 'Held' }, { switchOn: false });
    await settled();
    expect(timers.get(on.dish_id)).toMatchObject({ recipe_id: 'ticker', enabled: true });
    expect(timers.get(held.dish_id)).toBeNull();
    expect(rosterRefreshes).toBe(1);
    expect(emitted).toContain('automation_rule_changed:auto_run');
    // A recipe that runs on no timer gets none.
    const { dish: plain } = createDish(dishDeps, { recipe_id: 'watcher' });
    expect(timers.get(plain.dish_id)).toBeNull();
  });

  it('the switch writes the timer, and switching on re-arms a tripped breaker', async () => {
    const { dish } = createDish(dishDeps, { recipe_id: 'ticker' });
    updateDish(dishDeps, dish.dish_id, { enabled: false });
    expect(timers.isEnabled(dish.dish_id)).toBe(false);
    circuits.set({ dish_id: dish.dish_id, recipe_id: 'ticker', consecutive_failures: 5, auto_disabled: true });
    updateDish(dishDeps, dish.dish_id, { enabled: true });
    await settled();
    expect(timers.isEnabled(dish.dish_id)).toBe(true);
    expect(circuits.get(dish.dish_id)).toBeNull();
    expect(resets).toEqual([dish.dish_id]);
  });

  it('⛔ a dish already on whose breaker tripped is re-armed by switching it on again', () => {
    const { dish } = createDish(dishDeps, { recipe_id: 'ticker' });
    circuits.set({ dish_id: dish.dish_id, recipe_id: 'ticker', consecutive_failures: 5, auto_disabled: true });
    updateDish(dishDeps, dish.dish_id, { enabled: true });
    expect(circuits.get(dish.dish_id)).toBeNull();
  });

  it('removing a dish forgets its timer and breaker, and not another dish’s', async () => {
    const { dish: work } = createDish(dishDeps, { recipe_id: 'ticker' });
    const { dish: home } = createDish(dishDeps, { recipe_id: 'ticker', name: 'Home' });
    circuits.set({ dish_id: work.dish_id, recipe_id: 'ticker', consecutive_failures: 1, auto_disabled: false });
    deleteDish(dishDeps, work.dish_id);
    await settled();
    expect(timers.get(work.dish_id)).toBeNull();
    expect(circuits.get(work.dish_id)).toBeNull();
    expect(timers.get(home.dish_id)).toMatchObject({ enabled: true });
  });
});

