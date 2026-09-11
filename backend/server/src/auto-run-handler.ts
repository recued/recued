/** Reactive-substrate slice 1 — `auto_run.*` rpc handlers.
 *
 *  Two methods:
 *    auto_run.list     merged per-recipe status (definitional roster ⋈
 *                      user settings ⋈ circuit store ⋈ live scheduler)
 *    auto_run.update   { recipe_id, enabled } — the arm/disarm toggle
 *
 *  Closes the D-115-era gap where auto-run was the only automation
 *  mechanism without per-recipe enable/disable (schedules, event-
 *  triggers, and standing instructions all carry `enabled` + CRUD; the
 *  only way to stop an auto-run recipe was uninstalling its pack or
 *  waiting for the circuit breaker). Converges auto-run onto the same
 *  arm/disarm model so "reactive" presents uniformly.
 *
 *  The definitional source mirrors the scheduler's own
 *  `listInstallInputs` (SQLite-stored recipes with `recipe.auto_run`),
 *  so the list shows exactly the set the scheduler ticks. The live
 *  roster is read through the late-bound handle getter — the scheduler
 *  boots after the WS server, so a pre-boot call sees `null` live
 *  fields instead of a reference error (same posture as the `/status`
 *  page's `buildSummary`). */

import {
  RpcError,
  type AutoRunStatusEntry,
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
import type { DishContextStore } from './dish-context-store.js';
import { reconcileManagedConfigDish } from './managed-config-dish.js';
import type { WsClient } from './ws-server.js';
import type { EventBus } from './events/bus.js';
import { emitAutomationRule } from './events/emit-sites.js';

/** Validate an optional `config_overlay` arg — a non-object rejects. */
const requireOverlay = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new RpcError('bad_request', 'config_overlay must be an object', 400);
  }
  return v as Record<string, unknown>;
};

export interface AutoRunRpcDeps {
  recipeStore: RecipeStore;
  settingsStore: AutoRunSettingsStore;
  circuitStore: CircuitBreakerStore;
  /** Late-bound live scheduler handle — undefined while the scheduler
   *  is still booting (or in harnesses that never boot one). List
   *  degrades to null live fields; update still persists + the roster
   *  refresh becomes a no-op the boot's own `refreshRoster` covers. */
  getHandle: () => ServerAutoRunHandle | undefined;
  preapprovalStatus?: (recipeId: string) => Pick<AutoRunStatusEntry, 'enabled' | 'lifecycle_revision' | 'preapproval'> | null;
  /** D-179 — dish store for the recipe's managed auto-run config dish.
   *  A config change mints a new immutable dish + dissolves the prior;
   *  `executeFired` dispatches as `auto_run_settings.dish_id`. Absent ⇒
   *  config is a no-op (toggle-only, legacy/test path). */
  dishStore?: Pick<DishStore, 'get' | 'set' | 'delete'>;
  /** Continuity snapshots — cleared when a superseded config dish is
   *  dissolved (same discipline as the schedule/trigger delete). */
  dishContextStore?: Pick<DishContextStore, 'clear'>;
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

const buildEntry = (
  deps: AutoRunRpcDeps,
  row: DefinitionalRow,
): AutoRunStatusEntry => {
  const recipe_id = row.recipe.recipe_id;
  const circuit = deps.circuitStore.get(recipe_id);
  const live = deps.getHandle()?.roster.get(recipe_id);
  // D-179 — the config the headless fires use, read from the current
  // managed config dish (null pointer / absent dish ⇒ `{}` = defaults).
  const configDishId = deps.settingsStore.getDishId(recipe_id);
  const configDish = configDishId !== null
    ? deps.dishStore?.get(configDishId) ?? null
    : null;
  const reviewed = deps.preapprovalStatus?.(recipe_id);
  return {
    recipe_id,
    publisher_id: row.publisher_id,
    recipe_name: row.recipe.metadata?.name ?? null,
    interval_ms: row.recipe.auto_run!.interval_ms,
    dynamic: row.recipe.auto_run!.dynamic ?? false,
    enabled: reviewed?.enabled ?? deps.settingsStore.isEnabled(
      recipe_id,
      row.recipe.auto_run!.default_enabled ?? true,
    ),
    ...(reviewed?.lifecycle_revision !== undefined ? { lifecycle_revision: reviewed.lifecycle_revision } : {}),
    ...(reviewed?.preapproval ? { preapproval: reviewed.preapproval } : {}),
    config_overlay: configDish?.config_overlay ?? {},
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
  entries: listDefinitional(deps).map((row) => buildEntry(deps, row)),
});

export const updateAutoRun = async (
  deps: AutoRunRpcDeps,
  body: { recipe_id?: unknown; enabled?: unknown; config_overlay?: unknown },
): Promise<{ entry: AutoRunStatusEntry }> => {
  const recipe_id = typeof body.recipe_id === 'string' ? body.recipe_id : null;
  if (!recipe_id) {
    throw new RpcError('bad_request', 'recipe_id is required', 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw new RpcError('bad_request', 'enabled must be a boolean', 400);
  }
  // Both fields optional (a config-only edit omits `enabled`).
  const overlay = body.config_overlay !== undefined
    ? requireOverlay(body.config_overlay)
    : undefined;

  const row = listDefinitional(deps).find((r) => r.recipe.recipe_id === recipe_id);
  if (!row) {
    throw new RpcError(
      'not_found',
      `No installed auto-run recipe '${recipe_id}'`,
      404,
    );
  }

  // D-179 — reconcile the managed config dish BEFORE the roster refresh
  // so a resume-with-config fire picks up the new overlay. The dish is
  // immutable: a changed overlay mints a NEW dish + dissolves the
  // superseded one (one `dish_id` = one config → the audit never shows a
  // `dish_id` with drifting results); an identical overlay is a no-op (no
  // churn); an empty `{}` clears config back to recipe defaults. Nothing
  // is retained — superseded config is discarded, exactly like a manual
  // run's config is discarded after the run.
  if (overlay !== undefined && deps.dishStore) {
    const { nextDishId, changed } = reconcileManagedConfigDish({
      dishStore: deps.dishStore,
      ...(deps.dishContextStore ? { dishContextStore: deps.dishContextStore } : {}),
      recipe_id,
      publisher_id: row.publisher_id,
      marker: 'managed_by_auto_run',
      markerValue: recipe_id,
      currentDishId: deps.settingsStore.getDishId(recipe_id),
      overlay,
      now: Date.now(),
    });
    if (changed) {
      deps.settingsStore.setDishId(
        recipe_id,
        nextDishId,
        row.recipe.auto_run!.default_enabled ?? true,
      );
    }
  }

  if (body.enabled !== undefined) {
    deps.settingsStore.setEnabled(recipe_id, body.enabled);
    if (body.enabled) {
      // Re-arming clears any tripped circuit — "turn it on" must mean it
      // actually runs again, not "on but still tripped". Clearing BEFORE
      // the roster refresh matters: refresh hydrates persisted circuit
      // state back onto fresh roster entries. `resetCircuit` (which also
      // retires the live process_id) only fires when the breaker was
      // actually tripped, so a redundant enable on a healthy recipe
      // doesn't churn its reactive process identity.
      const tripped =
        deps.getHandle()?.roster.get(recipe_id)?.auto_disabled === true
        || deps.circuitStore.get(recipe_id)?.auto_disabled === true;
      deps.circuitStore.clear(recipe_id);
      if (tripped) deps.getHandle()?.resetCircuit(recipe_id);
    }
  }
  await deps.getHandle()?.refreshRoster();

  emitAutomationRule(deps.eventBus, 'auto_run');
  return { entry: buildEntry(deps, row) };
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
