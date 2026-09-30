/** D-319 — what a dish's switch, settings and removal do to the rows that
 *  start its recipe on their own.
 *
 *  A dish is a recipe switched on (D-319 § 3.1). Each trigger
 *  its recipe declares (one copy per dish, made by the declarative
 *  reconciler), each trigger the owner added to it, each schedule and — for
 *  an auto-run recipe — its timer belong to it, and each is a row with its
 *  own `enabled`. This keeps those rows in step with the dish:
 *
 *  - **made** — the recipe's declared triggers are made for it, OFF: the
 *    reconciler never starts anything by itself (§ 3.3). Switching on then
 *    turns every row of the dish on.
 *  - **switched** — every row follows the switch. On re-arms rows the server
 *    stopped after failures (D-268). A one-shot that already ran stays as it
 *    is: it is the owner's retry handle (D-215), not a timer.
 *  - **settings changed** — triggers narrowed to a template setting follow
 *    it (D-315 §5.1, per dish — § 3.7).
 *  - **removed** — its rows go with it.
 *
 *  A row's state is read as its OWNER set it (`ownerEnabled`, and the
 *  schedules' listed `enabled`): a row a reviewed execution parks (D-261)
 *  reads off in the store but is on for the owner, and must neither be
 *  re-enabled over its reviewed run nor skipped when the owner switches off.
 *
 *  Late-bound onto the dish rpc deps by the composition, because the trigger
 *  substrate composes after the dish stores. Absent (a harness without
 *  triggers) ⇒ dishes change and no row follows. */

import type { Dish } from '@recued/contracts';
import type { AutoRunSettingsStore, CircuitBreakerStore } from './auto-run-scheduler.js';
import type { EventBus } from './events/bus.js';
import { emitAutomationRule } from './events/emit-sites.js';
import type { EventTriggersStore } from './triggers/store.js';

export interface DishAutomation {
  /** A dish was made. `switchOn` turns every row of it on — `dishes.create`
   *  is the switch; a dish made to hold a schedule's settings is not. */
  created(dish: Dish, opts: { readonly switchOn: boolean }): void;
  /** The owner switched the dish: every row follows `dish.enabled`. */
  switched(dish: Dish): void;
  /** The dish's settings changed in place. */
  settingsChanged(dish: Dish): void;
  /** The dish is gone (already deleted from the store): its rows go. */
  deleted(dish: Dish): void;
  /** Something clients show changed (a name, the main dish) and no row
   *  follows: they re-list. */
  touched(): void;
}

export interface DishAutomationDeps {
  readonly triggers?: {
    readonly store: Pick<EventTriggersStore, 'list' | 'update' | 'remove' | 'ownerEnabled'>;
    /** Re-make the recipes' declared rows — one set per dish. True when rows
     *  changed. */
    readonly reconcile: () => boolean;
    /** Rows changed: re-subscribe the dispatcher and re-derive poll demand. */
    readonly rebuild: () => void;
  };
  readonly schedules?: {
    /** Every schedule, `enabled` as the owner set it. */
    readonly list: () => ReadonlyArray<{
      readonly schedule_id: string;
      readonly dish_id?: string;
      readonly enabled: boolean;
      readonly mode?: 'recurring' | 'one_shot';
      readonly last_run_at: number | null;
    }>;
    /** Switch one as the owner would (`schedules.update`, where D-268's
     *  counter reset lives). */
    readonly setEnabled: (schedule_id: string, enabled: boolean) => void;
    readonly remove: (schedule_id: string) => void;
  };
  /** An auto-run recipe's timer: one per dish. */
  readonly autoRun?: {
    /** Whether the recipe runs on a timer (declares `auto_run`). */
    readonly isAutoRun: (recipe_id: string) => boolean;
    readonly timers: Pick<AutoRunSettingsStore, 'get' | 'setEnabled' | 'forget' | 'ownerEnabled'>;
    readonly circuits: Pick<CircuitBreakerStore, 'get' | 'clear'>;
    /** Timers changed: rebuild the live roster. */
    readonly refresh: () => void | Promise<void>;
    /** A tripped breaker was re-armed: re-arm the live entry too. */
    readonly resetCircuit?: (dish_id: string) => void;
  };
  readonly eventBus?: EventBus;
  readonly log?: (message: string) => void;
}

export const createDishAutomation = (deps: DishAutomationDeps): DishAutomation => {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const triggersOf = (dish_id: string) =>
    deps.triggers?.store.list().filter((trigger) => trigger.dish_id === dish_id) ?? [];
  const schedulesOf = (dish_id: string) =>
    deps.schedules?.list().filter((schedule) => schedule.dish_id === dish_id) ?? [];

  /** One row that cannot follow must not stop the others, nor fail the
   *  owner's switch — the dish is already stored. */
  const each = <T>(rows: readonly T[], what: string, write: (row: T) => boolean): boolean => {
    let wrote = false;
    for (const row of rows) {
      try {
        if (write(row)) wrote = true;
      } catch (error) {
        log(`[d-319] ${what}: ${(error as Error).message ?? String(error)}`);
      }
    }
    return wrote;
  };

  const reconcile = (): boolean => {
    try {
      return deps.triggers?.reconcile() === true;
    } catch (error) {
      log(`[d-319] re-making the recipes' triggers failed: ${(error as Error).message ?? String(error)}`);
      return false;
    }
  };

  /** The dish's timer follows `enabled`; switching on re-arms a tripped one.
   *  True when the roster must be rebuilt. */
  const switchTimer = (dish: Dish, enabled: boolean): boolean => {
    const autoRun = deps.autoRun;
    if (autoRun === undefined || !autoRun.isAutoRun(dish.recipe_id)) return false;
    let changed = false;
    try {
      if (autoRun.timers.ownerEnabled(dish.dish_id) !== enabled) {
        autoRun.timers.setEnabled(dish.dish_id, dish.recipe_id, enabled);
        changed = true;
      }
      if (enabled && autoRun.circuits.get(dish.dish_id)?.auto_disabled === true) {
        autoRun.circuits.clear(dish.dish_id);
        autoRun.resetCircuit?.(dish.dish_id);
        changed = true;
      }
    } catch (error) {
      log(`[d-319] switching the timer of ${dish.dish_id}: ${(error as Error).message ?? String(error)}`);
    }
    return changed;
  };

  const refreshTimers = (changed: boolean): void => {
    if (!changed || deps.autoRun === undefined) return;
    void Promise.resolve()
      .then(() => deps.autoRun!.refresh())
      .catch((error: unknown) => log(`[d-319] refreshing the timers failed: ${(error as Error).message ?? String(error)}`));
    emitAutomationRule(deps.eventBus, 'auto_run');
  };

  const switchRows = (dish: Dish, enabled: boolean): boolean => {
    const triggers = deps.triggers;
    const triggersChanged = triggers !== undefined && each(triggersOf(dish.dish_id), `switching a trigger of ${dish.dish_id}`, (trigger) => {
      if (triggers.store.ownerEnabled(trigger.trigger_id) === enabled) return false;
      triggers.store.update(trigger.trigger_id, { enabled });
      return true;
    });
    const schedules = deps.schedules;
    const schedulesChanged = schedules !== undefined && each(schedulesOf(dish.dish_id), `switching a schedule of ${dish.dish_id}`, (schedule) => {
      if (schedule.enabled === enabled) return false;
      if (enabled && schedule.mode === 'one_shot' && schedule.last_run_at !== null) return false;
      schedules.setEnabled(schedule.schedule_id, enabled);
      return true;
    });
    return triggersChanged || schedulesChanged;
  };

  const settle = (triggersChanged: boolean): void => {
    if (triggersChanged) {
      try {
        deps.triggers?.rebuild();
      } catch (error) {
        log(`[d-319] re-subscribing the triggers failed: ${(error as Error).message ?? String(error)}`);
      }
      emitAutomationRule(deps.eventBus, 'event_trigger');
    }
    emitAutomationRule(deps.eventBus, 'dish');
  };

  return {
    created: (dish, opts) => {
      const made = reconcile();
      const on = opts.switchOn && dish.enabled;
      const switched = on ? switchRows(dish, true) : false;
      // A dish made without the switch has no timer row: off (§ 3.3).
      refreshTimers(on ? switchTimer(dish, true) : false);
      settle(made || switched);
    },
    switched: (dish) => {
      // Rows the reconciler owes this dish exist before the switch writes them.
      const made = reconcile();
      refreshTimers(switchTimer(dish, dish.enabled));
      settle(switchRows(dish, dish.enabled) || made);
    },
    settingsChanged: () => {
      settle(reconcile());
    },
    deleted: (dish) => {
      const triggers = deps.triggers;
      const removedTriggers = triggers !== undefined
        && each(triggersOf(dish.dish_id), `removing a trigger of ${dish.dish_id}`, (trigger) => triggers.store.remove(trigger.trigger_id));
      const schedules = deps.schedules;
      if (schedules !== undefined) {
        each(schedulesOf(dish.dish_id), `removing a schedule of ${dish.dish_id}`, (schedule) => {
          schedules.remove(schedule.schedule_id);
          return true;
        });
      }
      const autoRun = deps.autoRun;
      if (autoRun !== undefined) {
        let forgot = false;
        try {
          forgot = autoRun.timers.forget?.(dish.dish_id) === true;
          autoRun.circuits.clear(dish.dish_id);
        } catch (error) {
          log(`[d-319] removing the timer of ${dish.dish_id}: ${(error as Error).message ?? String(error)}`);
        }
        refreshTimers(forgot);
      }
      settle(reconcile() || removedTriggers);
    },
    touched: () => {
      emitAutomationRule(deps.eventBus, 'dish');
    },
  };
};
