/** D-319 — giving each recipe's auto-run timer back to the dish it ran as
 *  (`auto-run-timer-rearm.ts`).
 *
 *  26.9.30 dropped 26.9.29's per-recipe timer tables unconverted, so every
 *  recipe that ran stopped — and one with a dish read On in Automation. The
 *  repair writes ONE timer per recipe, on the dish it ran as: exactly, from
 *  the old tables, on a server that still has them (set aside, never dropped);
 *  taking every recipe as running on one that ran 26.9.30 and lost them.
 *
 *  Over the real timer, breaker and dish stores and the real D-308 ledger, on
 *  an in-memory database shaped the way each release left it. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Dish, RecipeDefinition } from '@recued/contracts';

import {
  createAutoRunSettingsStore,
  createCircuitBreakerStore,
  PRE_D319_AUTO_RUN_CIRCUIT_TABLE,
  PRE_D319_AUTO_RUN_SETTINGS_TABLE,
} from '../auto-run-scheduler.js';
import {
  AUTO_RUN_TIMER_REARM_ID,
  rearmAutoRunTimers,
  rearmAutoRunTimersAtBoot,
  type AutoRunTimerRearmDeps,
} from '../auto-run-timer-rearm.js';
import { createDishStore, type DishStore } from '../dish-store.js';
import { createDataRepairLedger, type DataRepairLedger } from '../storage/data-repair-ledger.js';
import type { StoredRecipe } from '../types.js';

const recipe = (
  recipe_id: string,
  over: Partial<RecipeDefinition> = {},
  name: string = recipe_id,
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  variables: {},
  metadata: { name, description: 'test', author: 'test', supported_platforms: ['test'] },
  steps: [],
  ...over,
} as unknown as RecipeDefinition);

/** A recipe on a timer; `defaultOff` writes 26.9.29's `default_enabled: false`. */
const onTimer = (recipe_id: string, opts: { name?: string; defaultOff?: boolean } = {}): RecipeDefinition =>
  recipe(recipe_id, {
    auto_run: { interval_ms: 60_000, ...(opts.defaultOff ? { default_enabled: false } : {}) },
  } as Partial<RecipeDefinition>, opts.name);

const stored = (r: RecipeDefinition): StoredRecipe => ({
  recipe_id: r.recipe_id,
  publisher_id: 'publisher',
  version: r.version,
  recipe_hash: 'hash',
  recipe_json: JSON.stringify(r),
  source: 'inline',
  installed_at: 0,
  pack_slug: null,
});

let db: Database.Database;
let dishes: DishStore;
let ledger: DataRepairLedger;

beforeEach(() => {
  db = new Database(':memory:');
  dishes = createDishStore(db);
  ledger = createDataRepairLedger(db);
});
afterEach(() => { db.close(); });

/** A dish as 26.9.29 left it; `marker` is its auto-run settings dish's stamp. */
const dish = (
  dish_id: string,
  recipe_id: string,
  over: Partial<Dish> & { marker?: true } = {},
): Dish => {
  const { marker, ...rest } = over;
  const row = {
    dish_id,
    recipe_id,
    publisher_id: 'publisher',
    name: '',
    is_default: false,
    config_overlay: {},
    enabled: true,
    created_at: 1,
    ...rest,
    ...(marker ? { managed_by_auto_run: recipe_id } : {}),
  } as Dish;
  dishes.set(row);
  return row;
};

/** 26.9.29's two per-recipe tables, under their own names, as a server updating
 *  straight from it holds them. */
const preD319Tables = (
  settings: Array<{ recipe_id: string; enabled: 0 | 1; dish_id?: string | null }>,
  circuits: Array<{ recipe_id: string; failures: number; tripped: 0 | 1; at?: number; reason?: string }> = [],
): void => {
  db.exec(`
    CREATE TABLE auto_run_settings (recipe_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL, dish_id TEXT);
    CREATE TABLE auto_run_circuit (recipe_id TEXT PRIMARY KEY, consecutive_failures INTEGER NOT NULL DEFAULT 0,
      auto_disabled INTEGER NOT NULL DEFAULT 0, last_failure_at INTEGER, last_failure_reason TEXT);`);
  for (const s of settings) {
    db.prepare('INSERT INTO auto_run_settings VALUES (?, ?, 1, ?)').run(s.recipe_id, s.enabled, s.dish_id ?? null);
  }
  for (const c of circuits) {
    db.prepare('INSERT INTO auto_run_circuit VALUES (?, ?, ?, ?, ?)')
      .run(c.recipe_id, c.failures, c.tripped, c.at ?? null, c.reason ?? null);
  }
};

const deps = (rows: StoredRecipe[], over: Partial<AutoRunTimerRearmDeps> = {}): AutoRunTimerRearmDeps => ({
  db,
  ledger,
  recipeStore: { listStored: () => rows },
  dishStore: dishes,
  now: () => 42,
  ...over,
});

const timers = () => createAutoRunSettingsStore(db).list()
  .map(({ dish_id, enabled }) => ({ dish_id, enabled }))
  .sort((a, b) => a.dish_id.localeCompare(b.dish_id));

const tables = (): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
    .map((t) => t.name);

describe('a server updating straight from 26.9.29: converted exactly from the old tables', () => {
  it('a recipe that ran gets ONE timer, on the dish its settings pointed at — not its main dish, not every dish', () => {
    dish('dsh_main', 'brief', { is_default: true, created_at: 1 });
    dish('dsh_settings', 'brief', { marker: true, created_at: 2 });
    dish('dsh_other', 'brief', { created_at: 3 });
    preD319Tables([{ recipe_id: 'brief', enabled: 1, dish_id: 'dsh_settings' }]);

    const { applied, summary } = rearmAutoRunTimers(deps([stored(onTimer('brief', { name: 'Morning brief' }))]));

    expect(applied).toBe(true);
    expect(timers()).toEqual([{ dish_id: 'dsh_settings', enabled: true }]);
    expect(summary).toEqual({
      path: 'converted',
      rearmed: [{ recipe_id: 'brief', dish_id: 'dsh_settings', name: 'Morning brief' }],
      kept_off: [],
      tripped: [],
      left: [],
    });
  });

  it('the pointer is the old table’s, not the marker: a stale marked dish it does not name is not chosen', () => {
    dish('dsh_stale', 'brief', { marker: true, created_at: 9 });
    dish('dsh_named', 'brief', { created_at: 1 });
    preD319Tables([{ recipe_id: 'brief', enabled: 1, dish_id: 'dsh_named' }]);
    rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
    expect(timers()).toEqual([{ dish_id: 'dsh_named', enabled: true }]);
  });

  it('with no settings pointer it ran with its main dish’s settings: the main dish gets it', () => {
    dish('dsh_old', 'brief', { created_at: 1 });
    dish('dsh_main', 'brief', { is_default: true, created_at: 5 });
    preD319Tables([]);
    rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
    expect(timers()).toEqual([{ dish_id: 'dsh_main', enabled: true }]);
  });

  it('a pointer at a dish since removed falls back to the main dish', () => {
    dish('dsh_main', 'brief', { is_default: true });
    preD319Tables([{ recipe_id: 'brief', enabled: 1, dish_id: 'dsh_gone' }]);
    rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
    expect(timers()).toEqual([{ dish_id: 'dsh_main', enabled: true }]);
  });

  it('with neither, its oldest dish that is on — still one', () => {
    dish('dsh_c', 'brief', { created_at: 3 });
    dish('dsh_off', 'brief', { created_at: 1, enabled: false });
    dish('dsh_b', 'brief', { created_at: 2 });
    preD319Tables([]);
    rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
    expect(timers()).toEqual([{ dish_id: 'dsh_b', enabled: true }]);
  });

  it('a recipe the owner had paused gets its timer written OFF — it does not start', () => {
    dish('dsh_digest', 'digest', { is_default: true });
    preD319Tables([{ recipe_id: 'digest', enabled: 0 }]);
    const { summary } = rearmAutoRunTimers(deps([stored(onTimer('digest', { name: 'Daily digest' }))]));
    expect(timers()).toEqual([{ dish_id: 'dsh_digest', enabled: false }]);
    expect(summary.kept_off).toEqual([{ recipe_id: 'digest', dish_id: 'dsh_digest', name: 'Daily digest' }]);
    expect(summary.rearmed).toEqual([]);
  });

  it('off by default with no row of its own: it never ran, so its timer is written off', () => {
    dish('dsh_quiet', 'quiet', { is_default: true });
    dish('dsh_loud', 'loud', { is_default: true });
    preD319Tables([{ recipe_id: 'loud', enabled: 1 }]);
    const { summary } = rearmAutoRunTimers(deps([
      stored(onTimer('quiet', { defaultOff: true })),
      // Off by default, but the owner turned it on: its own row says so.
      stored(onTimer('loud', { defaultOff: true })),
    ]));
    expect(timers()).toEqual([{ dish_id: 'dsh_loud', enabled: true }, { dish_id: 'dsh_quiet', enabled: false }]);
    expect(summary.kept_off.map((t) => t.recipe_id)).toEqual(['quiet']);
  });

  it('a recipe its breaker had stopped keeps that stop on its dish: timer on, breaker tripped, with why', () => {
    dish('dsh_flaky', 'flaky', { is_default: true });
    preD319Tables(
      [{ recipe_id: 'flaky', enabled: 1 }],
      [{ recipe_id: 'flaky', failures: 5, tripped: 1, at: 7, reason: 'boom' }],
    );
    const { summary } = rearmAutoRunTimers(deps([stored(onTimer('flaky'))]));
    expect(timers()).toEqual([{ dish_id: 'dsh_flaky', enabled: true }]);
    expect(createCircuitBreakerStore(db).get('dsh_flaky')).toEqual({
      dish_id: 'dsh_flaky', recipe_id: 'flaky', consecutive_failures: 5, auto_disabled: true,
      last_failure_at: 7, last_failure_reason: 'boom',
    });
    expect(summary.tripped.map((t) => t.dish_id)).toEqual(['dsh_flaky']);
    expect(summary.rearmed).toEqual([]);
  });

  it('failures short of a trip are not carried, and a paused recipe’s trip is moot', () => {
    dish('dsh_a', 'a', { is_default: true });
    dish('dsh_b', 'b', { is_default: true });
    preD319Tables(
      [{ recipe_id: 'a', enabled: 1 }, { recipe_id: 'b', enabled: 0 }],
      [{ recipe_id: 'a', failures: 2, tripped: 0 }, { recipe_id: 'b', failures: 5, tripped: 1 }],
    );
    rearmAutoRunTimers(deps([stored(onTimer('a')), stored(onTimer('b'))]));
    expect(createCircuitBreakerStore(db).list()).toEqual([]);
    expect(timers()).toEqual([{ dish_id: 'dsh_a', enabled: true }, { dish_id: 'dsh_b', enabled: false }]);
  });

  it('reads tables a store already set aside, and an old table from before D-179 with no pointer column', () => {
    dish('dsh_main', 'brief', { is_default: true });
    db.exec(`CREATE TABLE auto_run_settings (recipe_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL);
      INSERT INTO auto_run_settings VALUES ('brief', 0, 1);`);
    // The serve boot opens the stores before boot recovery runs the repair.
    createCircuitBreakerStore(db);
    createAutoRunSettingsStore(db);
    expect(tables()).toContain(PRE_D319_AUTO_RUN_SETTINGS_TABLE);
    rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
    expect(timers()).toEqual([{ dish_id: 'dsh_main', enabled: false }]);
  });

  it('drops the old tables with the ledger row — what it did is the record', () => {
    dish('dsh_main', 'brief', { is_default: true });
    preD319Tables([{ recipe_id: 'brief', enabled: 1 }], [{ recipe_id: 'brief', failures: 1, tripped: 0 }]);
    rearmAutoRunTimers(deps([stored(onTimer('brief', { name: 'Morning brief' }))]));
    expect(tables()).not.toContain(PRE_D319_AUTO_RUN_SETTINGS_TABLE);
    expect(tables()).not.toContain(PRE_D319_AUTO_RUN_CIRCUIT_TABLE);
    expect(tables()).not.toContain('auto_run_settings');
    expect(ledger.get(AUTO_RUN_TIMER_REARM_ID)).toEqual({
      repair_id: AUTO_RUN_TIMER_REARM_ID,
      applied_at: 42,
      noticed_at: null,
      summary: {
        path: 'converted',
        rearmed: [{ recipe_id: 'brief', dish_id: 'dsh_main', name: 'Morning brief' }],
        kept_off: [], tripped: [], left: [],
      },
    });
  });
});

describe('a server that already ran 26.9.30: the old tables are gone, recipes are taken as running', () => {
  it('the dish 26.9.29 marked as holding its settings gets the timer, over its main dish', () => {
    dish('dsh_main', 'brief', { is_default: true, created_at: 1 });
    dish('dsh_settings', 'brief', { marker: true, created_at: 2 });
    const { summary } = rearmAutoRunTimers(deps([stored(onTimer('brief', { name: 'Morning brief' }))]));
    expect(timers()).toEqual([{ dish_id: 'dsh_settings', enabled: true }]);
    expect(summary).toEqual({
      path: 'recovered',
      rearmed: [{ recipe_id: 'brief', dish_id: 'dsh_settings', name: 'Morning brief' }],
      kept_off: [], tripped: [], left: [],
    });
  });

  it('of two marked dishes, the newer: 26.9.29 replaced the older', () => {
    dish('dsh_older', 'brief', { marker: true, created_at: 1 });
    dish('dsh_newer', 'brief', { marker: true, created_at: 2 });
    rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
    expect(timers()).toEqual([{ dish_id: 'dsh_newer', enabled: true }]);
  });

  it('a marker naming ANOTHER recipe is not this one’s pointer', () => {
    dish('dsh_main', 'brief', { is_default: true, created_at: 5 });
    dishes.set({ ...dish('dsh_x', 'brief', { created_at: 1 }), managed_by_auto_run: 'someone-else' } as Dish);
    rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
    expect(timers()).toEqual([{ dish_id: 'dsh_main', enabled: true }]);
  });

  it('no marker: the main dish; no main: the oldest dish that is on', () => {
    dish('dsh_m_old', 'withmain', { created_at: 1 });
    dish('dsh_m_main', 'withmain', { is_default: true, created_at: 2 });
    dish('dsh_n_late', 'nomain', { created_at: 3 });
    dish('dsh_n_early', 'nomain', { created_at: 2 });
    rearmAutoRunTimers(deps([stored(onTimer('withmain')), stored(onTimer('nomain'))]));
    expect(timers()).toEqual([
      { dish_id: 'dsh_m_main', enabled: true },
      { dish_id: 'dsh_n_early', enabled: true },
    ]);
  });

  it('never one off by default: nothing says the owner turned it on', () => {
    dish('dsh_quiet', 'quiet', { is_default: true });
    const { summary } = rearmAutoRunTimers(deps([stored(onTimer('quiet', { defaultOff: true, name: 'Quiet one' }))]));
    expect(timers()).toEqual([]);
    expect(summary).toMatchObject({
      path: 'recovered',
      left: [{ recipe_id: 'quiet', dish_id: 'dsh_quiet', name: 'Quiet one', reason: 'default_off' }],
    });
  });
});

describe('only what the update stopped, on either path', () => {
  for (const path of ['converted', 'recovered'] as const) {
    describe(path, () => {
      beforeEach(() => { if (path === 'converted') preD319Tables([]); });

      it('a recipe with no dish is not touched: making one is switching it on', () => {
        const { summary } = rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
        expect(dishes.listByRecipe('brief')).toEqual([]);
        expect(timers()).toEqual([]);
        expect(summary.rearmed).toEqual([]);
        expect(summary.left).toEqual([]);
      });

      it('a recipe whose dish already has a timer is the owner’s since: no other dish of it is armed', () => {
        dish('dsh_main', 'brief', { is_default: true });
        dish('dsh_switched', 'brief');
        createAutoRunSettingsStore(db).setEnabled('dsh_switched', 'brief', false);
        const { summary } = rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
        expect(timers()).toEqual([{ dish_id: 'dsh_switched', enabled: false }]);
        expect(summary.rearmed).toEqual([]);
      });

      it('a chosen dish that is off stays off — the owner’s switch — and is left in the record', () => {
        dish('dsh_main', 'brief', { is_default: true, enabled: false });
        dish('dsh_on', 'brief', { created_at: 0 });
        const { summary } = rearmAutoRunTimers(deps([stored(onTimer('brief', { name: 'Morning brief' }))]));
        expect(timers()).toEqual([]);
        expect(summary.left).toEqual([
          { recipe_id: 'brief', dish_id: 'dsh_main', name: 'Morning brief', reason: 'dish_off' },
        ]);
      });

      it('every dish off: nothing is armed, and the recipe is left in the record', () => {
        dish('dsh_b', 'brief', { enabled: false, created_at: 2 });
        dish('dsh_a', 'brief', { enabled: false, created_at: 1 });
        const { summary } = rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
        expect(timers()).toEqual([]);
        expect(summary.left).toEqual([{ recipe_id: 'brief', dish_id: 'dsh_a', name: 'brief', reason: 'dish_off' }]);
      });

      it('a recipe not on a timer, and one no longer installed, are not touched', () => {
        dish('dsh_manual', 'manual', { is_default: true });
        dish('dsh_gone', 'uninstalled', { is_default: true });
        rearmAutoRunTimers(deps([stored(recipe('manual'))]));
        expect(timers()).toEqual([]);
      });

      it('a recipe it cannot write is left, with why, and the others are still armed', () => {
        dish('dsh_held', 'held', { is_default: true });
        dish('dsh_brief', 'brief', { is_default: true });
        // A reviewed execution owns the held dish's timer (D-261): enabling the
        // ordinary rule under it is refused.
        createAutoRunSettingsStore(db);
        db.prepare(`INSERT INTO preapproval_activations (future_ref, target_kind, target_key,
          target_incarnation, target_revision, original_enabled, owner_mode, selector_sequence)
          VALUES ('f1', 'next_auto_run', 'dsh_held', 'i', 1, 1, 'owner', 1)`).run();
        const { summary } = rearmAutoRunTimers(deps([stored(onTimer('held')), stored(onTimer('brief'))]));
        expect(timers()).toEqual([{ dish_id: 'dsh_brief', enabled: true }]);
        expect(summary.left).toEqual([expect.objectContaining({
          recipe_id: 'held', dish_id: 'dsh_held', reason: 'failed', detail: expect.stringContaining('reviewed execution'),
        })]);
      });
    });
  }

  it('a fresh server with nothing to give back records `nothing`', () => {
    expect(rearmAutoRunTimers(deps([stored(onTimer('brief'))])).summary).toEqual({
      path: 'nothing', rearmed: [], kept_off: [], tripped: [], left: [],
    });
    expect(ledger.get(AUTO_RUN_TIMER_REARM_ID)).not.toBeNull();
  });
});

describe('once per server, all or nothing', () => {
  it('runs once: a later boot writes nothing, even where it would have', () => {
    dish('dsh_main', 'brief', { is_default: true });
    expect(rearmAutoRunTimersAtBoot(deps([stored(onTimer('brief'))]))).toEqual({
      applied: true, path: 'recovered', rearmed: 1, kept_off: 0, tripped: 0, left: 0,
    });
    // The owner removed the timer; a second boot does not put it back.
    createAutoRunSettingsStore(db).forget!('dsh_main');
    const again = rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
    expect(again.applied).toBe(false);
    expect(again.summary.rearmed).toEqual([{ recipe_id: 'brief', dish_id: 'dsh_main', name: 'brief' }]);
    expect(timers()).toEqual([]);
  });

  it('a server that recorded it under the shipped id is never re-armed: the id is persisted, not renamed', () => {
    // ⛔ The literal, not the constant.
    ledger.record({ repair_id: 'd319-auto-run-timer-rearm-v1', applied_at: 1, summary: { path: 'nothing' } });
    dish('dsh_main', 'brief', { is_default: true });
    expect(rearmAutoRunTimers(deps([stored(onTimer('brief'))])).applied).toBe(false);
    expect(timers()).toEqual([]);
  });

  it('a crash before the ledger row leaves nothing written and the old tables in place; the next boot converts', () => {
    dish('dsh_main', 'brief', { is_default: true });
    dish('dsh_flaky', 'flaky', { is_default: true });
    preD319Tables([{ recipe_id: 'brief', enabled: 1 }], [{ recipe_id: 'flaky', failures: 5, tripped: 1 }]);
    const rows = [stored(onTimer('brief')), stored(onTimer('flaky'))];
    const dying: Pick<DataRepairLedger, 'get' | 'record'> = {
      get: (id) => ledger.get(id),
      record: () => { throw new Error('disk full'); },
    };
    expect(() => rearmAutoRunTimers(deps(rows, { ledger: dying }))).toThrow(/disk full/u);
    expect(timers()).toEqual([]);
    expect(createCircuitBreakerStore(db).list()).toEqual([]);
    expect(tables()).toEqual(expect.arrayContaining([PRE_D319_AUTO_RUN_SETTINGS_TABLE, PRE_D319_AUTO_RUN_CIRCUIT_TABLE]));
    expect(ledger.get(AUTO_RUN_TIMER_REARM_ID)).toBeNull();

    const { summary } = rearmAutoRunTimers(deps(rows));
    expect(summary.path).toBe('converted');
    expect(timers()).toEqual([{ dish_id: 'dsh_flaky', enabled: true }, { dish_id: 'dsh_main', enabled: true }]);
    expect(createCircuitBreakerStore(db).get('dsh_flaky')?.auto_disabled).toBe(true);
  });

  it('an old table a rollback re-made after it ran is dropped, and changes nothing', () => {
    dish('dsh_main', 'brief', { is_default: true });
    rearmAutoRunTimers(deps([stored(onTimer('brief'))]));
    createAutoRunSettingsStore(db).setEnabled('dsh_main', 'brief', false);
    preD319Tables([{ recipe_id: 'brief', enabled: 1 }]);
    expect(rearmAutoRunTimers(deps([stored(onTimer('brief'))])).applied).toBe(false);
    expect(tables()).not.toContain('auto_run_settings');
    expect(tables()).not.toContain(PRE_D319_AUTO_RUN_SETTINGS_TABLE);
    expect(timers()).toEqual([{ dish_id: 'dsh_main', enabled: false }]);
  });
});
