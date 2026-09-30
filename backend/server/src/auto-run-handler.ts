/** Reactive-substrate slice 1 — `auto_run.*` rpc handlers.
 *
 *  Two methods:
 *    auto_run.list     merged status per dish's timer (definitional roster ⋈
 *                      the dishes ⋈ timer switches ⋈ circuit store ⋈ live
 *                      scheduler)
 *    auto_run.update   { dish_id, enabled } — one timer's pause / re-arm
 *
 *  D-319 — ONE TIMER PER DISH. A dish is an auto-run recipe switched on with
 *  its own settings; its timer fires as it. A recipe nobody switched on
 *  lists as one row with `dish_id: null` and runs nothing. The dish's switch
 *  (`dishes.update`) writes its timer through `dish-automation.ts`; this rpc
 *  is the timer alone ("Pause" / "Re-arm" on one row).
 *
 *  The definitional source mirrors the scheduler's own `listInstallInputs`
 *  (SQLite-stored recipes with `recipe.auto_run`, each dish of them), so the
 *  list shows exactly the set the scheduler ticks. The live roster is read
 *  through the late-bound handle getter — the scheduler boots after the WS
 *  server, so a pre-boot call sees `null` live fields instead of a reference
 *  error (same posture as the `/status` page's `buildSummary`). */

import {
  RpcError,
  type AutoRunStatusEntry,
  type Dish,
  type HandlerSlice,
  type RecipeDefinition,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type {
  AutoRunSettingsStore,
  CircuitBreakerStore,
  ServerAutoRunHandle,
} from './auto-run-scheduler.js';
import type { RecipeStore } from './recipe-store.js';
import type { DishStore } from './dish-store.js';
import type { WsClient } from './ws-server.js';
import type { EventBus } from './events/bus.js';
import { emitAutomationRule } from './events/emit-sites.js';

export interface AutoRunRpcDeps {
  recipeStore: RecipeStore;
  settingsStore: AutoRunSettingsStore;
  circuitStore: CircuitBreakerStore;
  /** Late-bound live scheduler handle — undefined while the scheduler
   *  is still booting (or in harnesses that never boot one). List
   *  degrades to null live fields; update still persists + the roster
   *  refresh becomes a no-op the boot's own `refreshRoster` covers. */
  getHandle: () => ServerAutoRunHandle | undefined;
  /** D-261 — a timer's reviewed next run, keyed by its dish. */
  preapprovalStatus?: (dishId: string) => Pick<AutoRunStatusEntry, 'enabled' | 'lifecycle_revision' | 'preapproval'> | null;
  /** D-319 — the dishes each auto-run recipe is switched on as. Absent ⇒ no
   *  dish, so every recipe lists as not switched on. */
  dishStore?: Pick<DishStore, 'get' | 'listByRecipe'>;
  /** D-319 — the dish a recipe-only update acts on: its main dish, made (on,
   *  with the settings given) when it has none (`mainDishFor`). Late-bound
   *  by the composition. Absent ⇒ a recipe-only update is refused. */
  mainDish?: (input: {
    recipe_id: string;
    publisher_id: string;
    config_overlay: Record<string, unknown> | null;
  }) => Dish;
  /** D-121 broadcast bus — mutations fan `automation_rule_changed`
   *  so every paired client's Automation surface refreshes live. */
  eventBus?: EventBus;
}

interface DefinitionalRow {
  recipe: RecipeDefinition;
  publisher_id: string;
}

/** SQLite-stored recipes carrying `auto_run` — the same definitional
 *  set the scheduler rosters from. */
const listDefinitional = (deps: AutoRunRpcDeps): DefinitionalRow[] => {
  const out: DefinitionalRow[] = [];
  for (const row of deps.recipeStore.listStored()) {
    let recipe: RecipeDefinition;
    try {
      recipe = JSON.parse(row.recipe_json) as RecipeDefinition;
    } catch {
      continue;
    }
    if (!recipe.auto_run) continue;
    out.push({ recipe, publisher_id: row.publisher_id });
  }
  return out;
};

/** One timer's row — or, with no dish, the recipe's "not switched on" row. */
const buildEntry = (
  deps: AutoRunRpcDeps,
  row: DefinitionalRow,
  dish: Dish | null,
): AutoRunStatusEntry => {
  const recipe_id = row.recipe.recipe_id;
  const dish_id = dish?.dish_id ?? null;
  const circuit = dish_id !== null ? deps.circuitStore.get(dish_id) : null;
  const live = dish_id !== null ? deps.getHandle()?.roster.get(dish_id) : undefined;
  const reviewed = dish_id !== null ? deps.preapprovalStatus?.(dish_id) : null;
  return {
    recipe_id,
    publisher_id: row.publisher_id,
    dish_id,
    dish_name: dish?.name ?? null,
    recipe_name: row.recipe.metadata?.name ?? null,
    interval_ms: row.recipe.auto_run!.interval_ms,
    dynamic: row.recipe.auto_run!.dynamic ?? false,
    enabled: dish_id === null ? false : reviewed?.enabled ?? deps.settingsStore.isEnabled(dish_id),
    ...(reviewed?.lifecycle_revision !== undefined ? { lifecycle_revision: reviewed.lifecycle_revision } : {}),
    ...(reviewed?.preapproval ? { preapproval: reviewed.preapproval } : {}),
    config_overlay: dish?.config_overlay ?? {},
    variables: row.recipe.variables ?? {},
    // Prefer the live entry's circuit view (it includes failures not
    // yet persisted mid-tick); fall back to the persisted store.
    auto_disabled: live?.auto_disabled ?? circuit?.auto_disabled ?? false,
    consecutive_failures:
      live?.consecutive_failures ?? circuit?.consecutive_failures ?? 0,
    last_failure_at: circuit?.last_failure_at ?? null,
    last_failure_reason: circuit?.last_failure_reason ?? null,
    next_run_at: live?.next_run_at ?? null,
    last_started_at: live?.last_started_at ?? null,
    last_finished_at: live?.last_finished_at ?? null,
  };
};

export const listAutoRun = (
  deps: AutoRunRpcDeps,
): { entries: AutoRunStatusEntry[] } => ({
  entries: listDefinitional(deps).flatMap((row) => {
    // The main dish first: a reader that looks up a recipe's row by its id
    // (the palette's Arm acts on the main dish) finds the main dish's timer.
    const dishes = [...(deps.dishStore?.listByRecipe(row.recipe.recipe_id) ?? [])]
      .sort((a, b) => Number(b.is_default) - Number(a.is_default));
    return dishes.length === 0
      ? [buildEntry(deps, row, null)]
      : dishes.map((dish) => buildEntry(deps, row, dish));
  }),
});

export const updateAutoRun = async (
  deps: AutoRunRpcDeps,
  body: { dish_id?: unknown; recipe_id?: unknown; enabled?: unknown; config_overlay?: unknown },
): Promise<{ entry: AutoRunStatusEntry }> => {
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw new RpcError('bad_request', 'enabled must be a boolean', 400);
  }
  if (body.config_overlay !== undefined
    && (typeof body.config_overlay !== 'object' || body.config_overlay === null || Array.isArray(body.config_overlay))) {
    throw new RpcError('bad_request', 'config_overlay must be an object', 400);
  }
  const overlay = body.config_overlay as Record<string, unknown> | undefined;

  // The dish: named, or the recipe's main one.
  let dish: Dish;
  if (typeof body.dish_id === 'string' && body.dish_id.length > 0) {
    if (overlay !== undefined) {
      throw new RpcError('bad_request', 'A timer has no settings of its own — change its dish’s settings', 400);
    }
    const found = deps.dishStore?.get(body.dish_id);
    if (!found) throw new RpcError('not_found', `Dish '${body.dish_id}' not found`, 404);
    dish = found;
  } else if (typeof body.recipe_id === 'string' && body.recipe_id.length > 0) {
    const recipe_id = body.recipe_id;
    const definitional = listDefinitional(deps).find((r) => r.recipe.recipe_id === recipe_id);
    if (!definitional) {
      throw new RpcError('not_found', `No installed auto-run recipe '${recipe_id}'`, 404);
    }
    if (!deps.mainDish) {
      throw new RpcError('not_configured', 'Switching a recipe on needs a dish, and this server keeps none', 501);
    }
    dish = deps.mainDish({ recipe_id, publisher_id: definitional.publisher_id, config_overlay: overlay ?? null });
  } else {
    throw new RpcError('bad_request', 'dish_id (or recipe_id) is required', 400);
  }

  const row = listDefinitional(deps).find((r) => r.recipe.recipe_id === dish.recipe_id);
  if (!row) {
    throw new RpcError('not_found', `No installed auto-run recipe '${dish.recipe_id}'`, 404);
  }

  if (body.enabled !== undefined) {
    deps.settingsStore.setEnabled(dish.dish_id, dish.recipe_id, body.enabled);
    if (body.enabled) {
      // Re-arming clears any tripped circuit — "turn it on" must mean it
      // actually runs again, not "on but still tripped". Clearing BEFORE
      // the roster refresh matters: refresh hydrates persisted circuit
      // state back onto fresh roster entries. `resetCircuit` (which also
      // retires the live process_id) only fires when the breaker was
      // actually tripped, so a redundant enable on a healthy timer
      // doesn't churn its reactive process identity.
      const tripped =
        deps.getHandle()?.roster.get(dish.dish_id)?.auto_disabled === true
        || deps.circuitStore.get(dish.dish_id)?.auto_disabled === true;
      deps.circuitStore.clear(dish.dish_id);
      if (tripped) deps.getHandle()?.resetCircuit(dish.dish_id);
    }
  }
  await deps.getHandle()?.refreshRoster();

  emitAutomationRule(deps.eventBus, 'auto_run');
  return { entry: buildEntry(deps, row, deps.dishStore?.get(dish.dish_id) ?? dish) };
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type AutoRunMethods = 'auto_run.list' | 'auto_run.update';

export const makeAutoRunHandlers = (
  deps: AutoRunRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, AutoRunMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['auto_run.list', 'auto_run.update'],
    handlers: {
      'auto_run.list': async () => listAutoRun(deps),
      'auto_run.update': async (args) => updateAutoRun(deps, args),
    },
  };
};
