/** D-319 — giving each recipe's auto-run timer back to the dish it ran as.
 *
 *  Until D-319 an auto-run recipe ran on ONE timer per recipe, on by default,
 *  switched in `auto_run_settings` and stopped by failures in
 *  `auto_run_circuit`; a dish only carried its settings. D-319 slice 2
 *  (`1daedf9c0`, released in 26.9.30) moved the timer onto the dish and
 *  dropped both tables unconverted ("nothing is published"). It was: every
 *  recipe that had been running stopped. One with a dish kept showing On in
 *  Automation, because a dish's status reads its switch and not its timer.
 *
 *  This repair gives each such recipe its timer back, once per server, at
 *  boot — before the auto-run scheduler builds its roster, so it runs from
 *  this boot on (`start-boot-recovery-and-adapters.ts`).
 *
 *  - **ONE dish per recipe, never more.** 26.9.29 ran one timer per recipe; a
 *    timer on every dish would run the recipe once per dish. The dish is the
 *    one it ran as: the one its settings pointed at (`managed_by_auto_run`),
 *    else its main dish — a dishless run took the main dish's settings — else
 *    its oldest dish that is on.
 *  - **Two paths.** A server updating straight from 26.9.29 or earlier still
 *    holds the old tables (`setAsidePreD319Table` sets them aside, never drops
 *    them), so the conversion is exact: a recipe the owner had paused gets its
 *    timer written OFF, one its breaker had stopped keeps that stop, and one
 *    off by default that nobody turned on stays off. A server that already
 *    ran 26.9.30 lost them: the pointer is read off the dish's own 26.9.29
 *    marker, and every recipe is taken as running — the owner's choice
 *    (2026-09-30), knowing a recipe they had paused starts again — EXCEPT one
 *    off by default, which nothing says was ever turned on.
 *  - **Only what the update stopped.** A recipe with no dish is not touched
 *    — making a dish is switching it on, which is the owner's
 *    (`auto-run-switch-on-notice.ts` names those) — nor one whose dish
 *    already has a timer: the owner switched it since, or it was converted.
 *    A chosen dish that is off stays off: that is the owner's switch.
 *
 *  ⚠ The recovery path cannot tell a main dish made BEFORE the update from
 *  one made after it to hold a schedule's settings (`mainDishFor`, which
 *  writes no timer): both look the same, so the latter's recipe starts on its
 *  own as well. The notice names every recipe switched on here, so the owner
 *  can switch it off.
 *
 *  D-308: the timer writes, the drop of the old tables and the ledger row
 *  commit together, so a crash leaves all or none and the next boot redoes
 *  it. The summary is what the notice reads to name the recipes it switched
 *  back on — only on the recovery path; the exact path changes nothing the
 *  owner could see. */

import type Database from 'better-sqlite3';
import type { Dish } from '@recued/contracts';

import { listDefinitional } from './auto-run-handler.js';
import {
  PRE_D319_AUTO_RUN_CIRCUIT_TABLE,
  PRE_D319_AUTO_RUN_SETTINGS_TABLE,
  createAutoRunSettingsStore,
  createCircuitBreakerStore,
} from './auto-run-scheduler.js';
import type { DishStore } from './dish-store.js';
import type { RecipeStore } from './recipe-store.js';
import type { DataRepairLedger } from './storage/data-repair-ledger.js';

export const AUTO_RUN_TIMER_REARM_ID = 'd319-auto-run-timer-rearm-v1';

/** A recipe and the dish whose timer the repair wrote. */
export interface RearmedTimer {
  readonly recipe_id: string;
  readonly dish_id: string;
  /** Its name as Automation shows it; its id when it has none. */
  readonly name: string;
}

export type RearmLeftReason =
  /** The dish it ran as is switched off: the owner's switch. */
  | 'dish_off'
  /** Off by default, and the switch that could have turned it on is gone. */
  | 'default_off'
  /** Writing its timer failed; nothing of it changed. */
  | 'failed';

export interface RearmLeft {
  readonly recipe_id: string;
  readonly name: string;
  readonly dish_id: string;
  readonly reason: RearmLeftReason;
  readonly detail?: string;
}

export interface AutoRunTimerRearmSummary {
  /** `converted` — the old tables were read; `recovered` — they were gone, and
   *  recipes were taken as running; `nothing` — neither had anything to do. */
  readonly path: 'converted' | 'recovered' | 'nothing';
  /** Timers written ON. */
  readonly rearmed: readonly RearmedTimer[];
  /** Converted only: timers written OFF — the recipe was not running before. */
  readonly kept_off: readonly RearmedTimer[];
  /** Converted only: timers written on, still stopped by the breaker. */
  readonly tripped: readonly RearmedTimer[];
  /** Recipes with a dish this repair did not switch, and why. */
  readonly left: readonly RearmLeft[];
}

export interface AutoRunTimerRearmDeps {
  readonly db: Database.Database;
  readonly ledger: Pick<DataRepairLedger, 'get' | 'record'>;
  /** Installed recipes — the ones the timer roster reads. */
  readonly recipeStore: Pick<RecipeStore, 'listStored'>;
  readonly dishStore: Pick<DishStore, 'listByRecipe'>;
  readonly now: () => number;
}

interface PreD319Setting {
  readonly enabled: number;
  readonly dish_id: string | null;
}

interface PreD319Circuit {
  readonly consecutive_failures: number;
  readonly auto_disabled: number;
  readonly last_failure_at: number | null;
  readonly last_failure_reason: string | null;
}

const tableExists = (db: Database.Database, name: string): boolean =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

/** 26.9.29's switch and settings pointer per recipe, or null without the
 *  table. `dish_id` arrived by migration (D-179); an older table has none. */
const readPreD319Settings = (db: Database.Database): Map<string, PreD319Setting> | null => {
  if (!tableExists(db, PRE_D319_AUTO_RUN_SETTINGS_TABLE)) return null;
  const columns = new Set((db.prepare(`PRAGMA table_info(${PRE_D319_AUTO_RUN_SETTINGS_TABLE})`).all() as
    Array<{ name: string }>).map((column) => column.name));
  const rows = db.prepare(
    `SELECT recipe_id, enabled, ${columns.has('dish_id') ? 'dish_id' : 'NULL AS dish_id'}
       FROM ${PRE_D319_AUTO_RUN_SETTINGS_TABLE}`,
  ).all() as Array<PreD319Setting & { recipe_id: string }>;
  return new Map(rows.map(({ recipe_id, ...row }) => [recipe_id, row]));
};

/** 26.9.29's breaker per recipe, or null without the table. */
const readPreD319Circuits = (db: Database.Database): Map<string, PreD319Circuit> | null => {
  if (!tableExists(db, PRE_D319_AUTO_RUN_CIRCUIT_TABLE)) return null;
  const rows = db.prepare(`SELECT * FROM ${PRE_D319_AUTO_RUN_CIRCUIT_TABLE}`).all() as
    Array<PreD319Circuit & { recipe_id: string }>;
  return new Map(rows.map(({ recipe_id, ...row }) => [recipe_id, row]));
};

const dropPreD319Tables = (db: Database.Database): void => {
  db.exec(`DROP TABLE IF EXISTS ${PRE_D319_AUTO_RUN_SETTINGS_TABLE};
    DROP TABLE IF EXISTS ${PRE_D319_AUTO_RUN_CIRCUIT_TABLE};`);
};

/** 26.9.29's marker on the dish holding a recipe's auto-run settings — gone
 *  from the `Dish` type, still in the stored row (`dish-store.ts` keeps the
 *  row as written). The newest wins: 26.9.29 replaced a superseded one. */
const markedDish = (dishes: readonly Dish[], recipe_id: string): string | null =>
  [...dishes]
    .filter((dish) => (dish as Dish & { managed_by_auto_run?: unknown }).managed_by_auto_run === recipe_id)
    .sort((a, b) => b.created_at - a.created_at)[0]?.dish_id ?? null;

const oldest = (dishes: readonly Dish[]): Dish | undefined =>
  [...dishes].sort((a, b) => a.created_at - b.created_at || a.dish_id.localeCompare(b.dish_id))[0];

/** The dish a recipe's 26.9.29 timer ran as: the one its settings pointed
 *  at, else its main dish (whose settings a dishless run took), else its
 *  oldest dish that is on. Every dish off ⇒ the oldest, which the caller
 *  leaves off. */
const dishItRanAs = (dishes: readonly Dish[], pointer: string | null): Dish | null =>
  dishes.find((dish) => dish.dish_id === pointer)
  ?? dishes.find((dish) => dish.is_default)
  ?? oldest(dishes.filter((dish) => dish.enabled))
  ?? oldest(dishes)
  ?? null;

/** `auto_run.default_enabled` is retired (D-319 slice 2) but still in the
 *  stored definitions it was written into. */
const offByDefault = (auto_run: unknown): boolean =>
  (auto_run as { default_enabled?: unknown } | undefined)?.default_enabled === false;

/** The repair. Already recorded ⇒ a no-op returning what it did then. */
export const rearmAutoRunTimers = (
  deps: AutoRunTimerRearmDeps,
): { readonly applied: boolean; readonly summary: AutoRunTimerRearmSummary } => {
  // Opening the stores sets any old table aside, whichever opened first.
  const timers = createAutoRunSettingsStore(deps.db);
  const circuits = createCircuitBreakerStore(deps.db);
  const recorded = deps.ledger.get(AUTO_RUN_TIMER_REARM_ID);
  if (recorded !== null) {
    // Only a rollback to 26.9.29 re-makes one after the conversion ran, and
    // the conversion is spent: nothing reads it.
    dropPreD319Tables(deps.db);
    return { applied: false, summary: recorded.summary as AutoRunTimerRearmSummary };
  }
  const settings = readPreD319Settings(deps.db);
  const breakers = readPreD319Circuits(deps.db);
  const exact = settings !== null || breakers !== null;
  const now = deps.now();
  let summary: AutoRunTimerRearmSummary = { path: 'nothing', rearmed: [], kept_off: [], tripped: [], left: [] };

  deps.db.transaction(() => {
    const rearmed: RearmedTimer[] = [];
    const kept_off: RearmedTimer[] = [];
    const tripped: RearmedTimer[] = [];
    const left: RearmLeft[] = [];
    for (const { recipe } of listDefinitional(deps)) {
      const recipe_id = recipe.recipe_id;
      const dishes = deps.dishStore.listByRecipe(recipe_id);
      if (dishes.length === 0) continue;
      if (dishes.some((dish) => timers.get(dish.dish_id) !== null)) continue;
      const pointer = exact ? settings?.get(recipe_id)?.dish_id ?? null : markedDish(dishes, recipe_id);
      const dish = dishItRanAs(dishes, pointer);
      if (dish === null) continue;
      const name = recipe.metadata?.name?.trim() || recipe_id;
      const timer: RearmedTimer = { recipe_id, dish_id: dish.dish_id, name };
      if (!dish.enabled) {
        left.push({ ...timer, reason: 'dish_off' });
        continue;
      }
      if (!exact && offByDefault(recipe.auto_run)) {
        left.push({ ...timer, reason: 'default_off' });
        continue;
      }
      const setting = settings?.get(recipe_id);
      const ran = setting !== undefined ? setting.enabled === 1 : !offByDefault(recipe.auto_run);
      const trip = ran ? breakers?.get(recipe_id) : undefined;
      try {
        // One recipe's writes stand or fall together (a savepoint), and a
        // recipe that cannot be written does not stop the others.
        deps.db.transaction(() => {
          timers.setEnabled(dish.dish_id, recipe_id, ran);
          if (trip?.auto_disabled === 1) {
            circuits.set({
              dish_id: dish.dish_id,
              recipe_id,
              consecutive_failures: trip.consecutive_failures,
              auto_disabled: true,
              ...(trip.last_failure_at != null ? { last_failure_at: trip.last_failure_at } : {}),
              ...(trip.last_failure_reason != null ? { last_failure_reason: trip.last_failure_reason } : {}),
            });
          }
        })();
      } catch (error) {
        left.push({ ...timer, reason: 'failed', detail: error instanceof Error ? error.message : String(error) });
        continue;
      }
      (!ran ? kept_off : trip?.auto_disabled === 1 ? tripped : rearmed).push(timer);
    }
    dropPreD319Tables(deps.db);
    const touched = rearmed.length + kept_off.length + tripped.length + left.length > 0;
    summary = { path: exact ? 'converted' : touched ? 'recovered' : 'nothing', rearmed, kept_off, tripped, left };
    deps.ledger.record({ repair_id: AUTO_RUN_TIMER_REARM_ID, applied_at: now, summary });
  })();
  return { applied: true, summary };
};

export interface AutoRunTimerRearmResult {
  readonly applied: boolean;
  readonly path: AutoRunTimerRearmSummary['path'];
  readonly rearmed: number;
  readonly kept_off: number;
  readonly tripped: number;
  readonly left: number;
}

/** At boot: the repair, as counts for the boot log. */
export const rearmAutoRunTimersAtBoot = (deps: AutoRunTimerRearmDeps): AutoRunTimerRearmResult => {
  const { applied, summary } = rearmAutoRunTimers(deps);
  return {
    applied,
    path: summary.path,
    rearmed: summary.rearmed.length,
    kept_off: summary.kept_off.length,
    tripped: summary.tripped.length,
    left: summary.left.length,
  };
};
