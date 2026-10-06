/** D-115 Phase 4 — Server-side auto-run scheduler.
 *
 *  The headless server's equivalent of the extension SW scheduler:
 *  per-timer `setTimeout` timers (sub-second cadence supported down
 *  to `AUTO_RUN_SERVER_FLOOR_MS`), SQLite-persisted circuit-breaker
 *  state so a restart doesn't forget which timers are auto-disabled,
 *  and direct `handleExecute` dispatch instead of the extension's
 *  `runtime.runRecipe`.
 *
 *  D-319 — ONE TIMER PER DISH. A dish is an auto-run recipe switched on
 *  with its own settings; each dish of it runs on its own timer, as the
 *  dish, with its own breaker. A recipe with no dish runs nothing.
 *
 *  Lifecycle:
 *    1. `start()` → `refreshRoster()` builds the roster from the
 *       recipe store, hydrates counters from SQLite, and arms a
 *       setTimeout per entry.
 *    2. Each timer fires → `fireEntry(recipe_id)` → scheduler.tick →
 *       handleExecute → markFinished → persistCircuit →
 *       scheduleNext. Scheduler-owned promises are tracked and reported so a
 *       single store/runtime failure cannot reach the process-wide fatal
 *       rejection handler.
 *    3. `stop()` clears all timers + waits for every scheduler-owned task
 *       to settle so callers can safely close the database.
 *
 *  Spec: D-115 §3.1 (Server implementation).
 */

import type { Database } from 'better-sqlite3';
import {
  autoRunKey,
  createAutoRunScheduler,
  rosterAllAutoRun,
  type AutoRunEntry,
  type AutoRunInstallInput,
  type AutoRunOutcome,
  type AutoRunScheduler,
  type TickReport,
} from '@recued/scheduler';
import {
  AUTO_RUN_SERVER_FLOOR_MS,
  type CircuitBreakerState,
  type RecipeDefinition,
} from '@recued/contracts';
import type { RecipeStore } from './recipe-store.js';
import type { DishStore } from './dish-store.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { handleExecute } from './execute-handler.js';
import type { ExecuteRequest, ExecuteResponse } from './types.js';
import type { NotificationMessage } from '@recued/notification';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  deriveRunYield,
  runYieldIsTotalRefusal,
} from '@recued/contracts';
import { presentAutomationFailure } from './automation-failure.js';
import {
  decideAutomationFailure,
  type AutomationUnitRef,
} from './automation-failure-reporter.js';
import {
  assertPreapprovalLegacyEnable, initializePreapprovalLifecycle, mutatePreapprovalResource,
  notePreapprovalOwnerMutation, preapprovalLogicalEnabled,
} from './storage/preapproval-lifecycle.js';

// ────────────────────────────────────────────────────────────────
// Circuit-breaker persistence (SQLite) — one breaker per dish's timer
// ────────────────────────────────────────────────────────────────

export interface CircuitBreakerStore {
  list(): CircuitBreakerState[];
  /** The breaker of a dish's timer (D-319). */
  get(dish_id: string): CircuitBreakerState | null;
  set(state: CircuitBreakerState): void;
  clear(dish_id: string): void;
  /** D-304 — every breaker of a recipe's dishes: it was uninstalled.
   *  Optional for test doubles. */
  clearRecipe?(recipe_id: string): number;
}

// ────────────────────────────────────────────────────────────────
// A dish's auto-run timer (SQLite)
// ────────────────────────────────────────────────────────────────

/** D-319 — one auto-run timer per dish of an auto-run recipe. */
export interface AutoRunTimer {
  dish_id: string;
  recipe_id: string;
  enabled: boolean;
}

/** D-319 — each dish's auto-run timer switch. The user-intent axis,
 *  deliberately separate from the circuit breaker's failure axis:
 *  `enabled: false` keeps a timer out of the scheduler roster the same way
 *  a trigger row's `enabled: false` keeps it off the warehouse bus. A dish
 *  with NO row is off — installing a recipe, or making a dish only to hold
 *  a schedule's settings, starts nothing (§ 3.3, § 3.6); the dish's switch
 *  (`dish-automation.ts`) writes the row.
 *
 *  (Until D-319 this was one row per RECIPE, on by default, with a pointer
 *  to a managed config dish. 26.9.30 dropped that table unconverted, so every
 *  timer that ran before stopped; it is now set aside instead
 *  (`PRE_D319_AUTO_RUN_SETTINGS_TABLE`) for the one-shot conversion in
 *  `auto-run-timer-rearm.ts`, which gives each recipe's timer back to the
 *  dish it ran as.) */
export interface AutoRunSettingsStore {
  /** A dish's timer, when it has one. */
  get(dish_id: string): AutoRunTimer | null;
  list(): AutoRunTimer[];
  /** Whether a dish's timer is on; a dish with no timer is off. */
  isEnabled(dish_id: string): boolean;
  /** As the OWNER set it: a timer a reviewed execution parks (D-261) reads
   *  off in the store but is on for the owner. */
  ownerEnabled(dish_id: string): boolean;
  /** Switch a dish's timer, making its row when it has none. */
  setEnabled(dish_id: string, recipe_id: string, enabled: boolean): void;
  /** The dish is gone. `true` when it had a timer. Optional for test doubles. */
  forget?(dish_id: string): boolean;
  /** D-304 — the recipe was uninstalled: every timer of its dishes goes.
   *  Optional for test doubles. */
  forgetRecipe?(recipe_id: string): number;
}

/** D-319 — where 26.9.29's per-recipe tables wait for the one-shot conversion
 *  (`auto-run-timer-rearm.ts`), which drops them once its ledger row is
 *  written. */
export const PRE_D319_AUTO_RUN_SETTINGS_TABLE = 'auto_run_settings_pre_d319';
export const PRE_D319_AUTO_RUN_CIRCUIT_TABLE = 'auto_run_circuit_pre_d319';

const tableExists = (db: Database, name: string): boolean =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

/** ⛔ SET ASIDE, NEVER DROPPED. A pre-D-319 table holds the only record of
 *  which recipes ran and which the owner had paused; 26.9.30 dropped them and
 *  every timer stopped. Whichever store opens first moves its table aside —
 *  the circuit store opens before the timer store at serve boot, after it in
 *  `recued mcp` — so no process can destroy what the conversion needs. When an
 *  aside copy already exists (a rollback re-made the old table), the first
 *  copy is kept: it is the state the owner left before any update.
 *
 *  ⚠ The check and the move hold the write lock together (IMMEDIATE; a
 *  savepoint when nested): serve and `recued mcp` can open one realm at
 *  once, and a check-then-rename that lost the race would throw "no such
 *  table" at boot, where `DROP TABLE IF EXISTS` never could. */
export const setAsidePreD319Table = (db: Database, table: string, aside: string): void => {
  db.transaction(() => {
    if (!tableExists(db, table)) return;
    db.exec(tableExists(db, aside) ? `DROP TABLE ${table}` : `ALTER TABLE ${table} RENAME TO ${aside}`);
  }).immediate();
};

/** SQLite-backed timer store. Creates its table on first use — the same
 *  shared-db posture as the circuit store below. */
export const createAutoRunSettingsStore = (db: Database): AutoRunSettingsStore => {
  initializePreapprovalLifecycle(db);
  setAsidePreD319Table(db, 'auto_run_settings', PRE_D319_AUTO_RUN_SETTINGS_TABLE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_run_timers (
      dish_id    TEXT PRIMARY KEY,
      recipe_id  TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auto_run_timers_recipe_idx ON auto_run_timers (recipe_id);
  `);
  interface Row { dish_id: string; recipe_id: string; enabled: number }
  const toTimer = (row: Row): AutoRunTimer => ({ dish_id: row.dish_id, recipe_id: row.recipe_id, enabled: row.enabled === 1 });
  const read = (dish_id: string): Row | undefined =>
    db.prepare('SELECT dish_id, recipe_id, enabled FROM auto_run_timers WHERE dish_id = ?').get(dish_id) as Row | undefined;
  const material = (dish_id: string) => {
    const row = read(dish_id);
    return row ? { enabled: preapprovalLogicalEnabled(db, 'next_auto_run', dish_id, row.enabled === 1) } : null;
  };

  const store: AutoRunSettingsStore = {
    get(dish_id) {
      const row = read(dish_id);
      return row ? toTimer(row) : null;
    },
    list() {
      return (db.prepare('SELECT dish_id, recipe_id, enabled FROM auto_run_timers ORDER BY dish_id').all() as Row[]).map(toTimer);
    },
    isEnabled(dish_id) {
      return read(dish_id)?.enabled === 1;
    },
    ownerEnabled(dish_id) {
      const row = read(dish_id);
      return row !== undefined && preapprovalLogicalEnabled(db, 'next_auto_run', dish_id, row.enabled === 1);
    },
    setEnabled(dish_id, recipe_id, enabled) {
      mutatePreapprovalResource(db, 'next_auto_run', dish_id, () => material(dish_id), () => {
        assertPreapprovalLegacyEnable(db, 'next_auto_run', dish_id, enabled);
        notePreapprovalOwnerMutation(db, 'next_auto_run', dish_id);
        db.prepare(`
          INSERT INTO auto_run_timers (dish_id, recipe_id, enabled, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (dish_id) DO UPDATE SET
            enabled = excluded.enabled,
            updated_at = excluded.updated_at
        `).run(dish_id, recipe_id, enabled ? 1 : 0, Date.now());
      });
    },
    forget(dish_id) {
      return mutatePreapprovalResource(db, 'next_auto_run', dish_id, () => material(dish_id), () => {
        notePreapprovalOwnerMutation(db, 'next_auto_run', dish_id);
        return db.prepare('DELETE FROM auto_run_timers WHERE dish_id = ?').run(dish_id).changes > 0;
      });
    },
    forgetRecipe(recipe_id) {
      const dishes = (db.prepare('SELECT dish_id FROM auto_run_timers WHERE recipe_id = ?').all(recipe_id) as Array<{ dish_id: string }>);
      let forgotten = 0;
      for (const { dish_id } of dishes) {
        if (store.forget!(dish_id)) forgotten += 1;
      }
      return forgotten;
    },
  };
  return store;
};

/** SQLite-backed circuit-breaker store, one row per dish's timer. Creates
 *  its table on first use — tolerates sharing the recued-server.db with
 *  every other table. (The per-recipe `auto_run_circuit` is set aside with
 *  the per-recipe timers — D-319, `setAsidePreD319Table`.) */
export const createCircuitBreakerStore = (db: Database): CircuitBreakerStore => {
  initializePreapprovalLifecycle(db);
  setAsidePreD319Table(db, 'auto_run_circuit', PRE_D319_AUTO_RUN_CIRCUIT_TABLE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_run_timer_circuit (
      dish_id              TEXT PRIMARY KEY,
      recipe_id            TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      auto_disabled        INTEGER NOT NULL DEFAULT 0,
      last_failure_at      INTEGER,
      last_failure_reason  TEXT
    );
  `);

  interface Row {
    dish_id: string;
    recipe_id: string;
    consecutive_failures: number;
    auto_disabled: number;
    last_failure_at: number | null;
    last_failure_reason: string | null;
  }

  const rowToState = (row: Row): CircuitBreakerState => ({
    dish_id: row.dish_id,
    recipe_id: row.recipe_id,
    consecutive_failures: row.consecutive_failures,
    auto_disabled: row.auto_disabled === 1,
    ...(row.last_failure_at != null ? { last_failure_at: row.last_failure_at } : {}),
    ...(row.last_failure_reason != null ? { last_failure_reason: row.last_failure_reason } : {}),
  });

  return {
    list() {
      return (db.prepare('SELECT * FROM auto_run_timer_circuit').all() as Row[]).map(rowToState);
    },
    get(dish_id) {
      const row = db.prepare('SELECT * FROM auto_run_timer_circuit WHERE dish_id = ?').get(dish_id) as Row | undefined;
      return row ? rowToState(row) : null;
    },
    set(state) {
      db.transaction(() => {
        if (state.auto_disabled) notePreapprovalOwnerMutation(db, 'next_auto_run', state.dish_id);
        db.prepare(`
          INSERT INTO auto_run_timer_circuit (dish_id, recipe_id, consecutive_failures, auto_disabled, last_failure_at, last_failure_reason)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (dish_id) DO UPDATE SET
            consecutive_failures = excluded.consecutive_failures,
            auto_disabled = excluded.auto_disabled,
            last_failure_at = excluded.last_failure_at,
            last_failure_reason = excluded.last_failure_reason
        `).run(
          state.dish_id,
          state.recipe_id,
          state.consecutive_failures,
          state.auto_disabled ? 1 : 0,
          state.last_failure_at ?? null,
          state.last_failure_reason ?? null,
        );
      }).immediate();
    },
    clear(dish_id) {
      db.prepare('DELETE FROM auto_run_timer_circuit WHERE dish_id = ?').run(dish_id);
    },
    clearRecipe(recipe_id) {
      return db.prepare('DELETE FROM auto_run_timer_circuit WHERE recipe_id = ?').run(recipe_id).changes;
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Server scheduler handle
// ────────────────────────────────────────────────────────────────

export interface ServerAutoRunConfig {
  /** Inject a prebuilt scheduler (tests). Omitted → fresh one via
   *  `createAutoRunScheduler`. */
  scheduler?: AutoRunScheduler;
  recipeStore: RecipeStore;
  /** Deps for the default `handleExecute`-backed executor. Ignored
   *  when a custom `execute` function is supplied. */
  executeDeps?: ExecuteHandlerDeps;
  /** Custom executor — overrides the default `handleExecute`
   *  composition. Tests inject a stub that returns a predetermined
   *  result; production wiring omits this and passes `executeDeps`. */
  execute?: (request: ExecuteRequest) => Promise<ExecuteResponse>;
  circuitStore: CircuitBreakerStore;
  /** D-319 — each dish's timer switch. Consulted at roster-build time: a
   *  timer switched off maps to `status: 'disabled_by_user'` so
   *  `rosterAllAutoRun` drops it. Absent (a harness) ⇒ every dish's timer
   *  counts as on, and the dish's own switch decides. */
  settingsStore?: AutoRunSettingsStore;
  /** D-319 — the dishes each auto-run recipe is switched on as: one timer
   *  per dish. Defaults to `executeDeps.dishStore`; with neither, no dish ⇒
   *  nothing runs. */
  dishStore?: Pick<DishStore, 'listByRecipe' | 'get'>;
  /** Reactive-substrate slice 1 — per-fire hook, invoked after each
   *  dispatched execution settles (success, skip, or failure). The
   *  boot wires `emitReactiveFire` so paired clients' Automation /
   *  Runs surfaces refresh live. Throws are swallowed. */
  onFired?: (recipe_id: string) => void;
  /** D-268 — deliver one owner notice about a failed unattended fire: the first
   *  failure of an episode, and the disarm. Absent ⇒ failures stay on the
   *  circuit row and reach nobody, which is the pre-D-268 behaviour.
   *
   *  ⚠ Synchronous and fire-and-forget: an owner channel must never be able to
   *  delay a fire's finalization, which runs inside the shutdown gate. */
  onAutomationFailure?: (notice: NotificationMessage, unit: AutomationUnitRef) => void;
  /** Clock override for tests. */
  now?: () => number;
  mintProcessId?: () => string;
  /** `setTimeout` override for deterministic tests. Defaults to
   *  Node's global `setTimeout`. Receives the computed delay. */
  setTimer?: (handler: () => void, delayMs: number) => unknown;
  /** `clearTimeout` override matching `setTimer`. */
  clearTimer?: (token: unknown) => void;
  /** Reports failures from scheduler-owned background work. Direct `tick()`
   *  and `start()` initialization failures still reject to their callers. The
   *  hook is guarded so diagnostics cannot create an unhandled rejection. */
  onBackgroundError?: (message: string, error: unknown) => void;
  /** Vault-unlocked gate. When provided and `false`, `tick` + `fireEntry`
   *  are no-ops — they skip BEFORE advancing the scheduler clock, so
   *  due entries stay due for catch-up on unlock, and they do NOT re-arm
   *  (the per-entry one-shot timers go dormant rather than busy-loop on a
   *  past `next_run_at`). The coordinator re-arms via `tick()` on unlock.
   *  Absent → un-gated (legacy / tests). */
  isVaultUnlocked?: () => boolean;
}

export interface ServerAutoRunHandle {
  /** Start the scheduler — refreshes roster, hydrates circuit state,
   *  arms per-entry timers. Fires an immediate tick for anything
   *  already due. */
  start(): Promise<void>;
  /** Clear all pending timers + await scheduler-owned background work and
   *  in-flight executions so the caller can close the database safely. */
  stop(): Promise<void>;
  /** Run a single synchronous tick — for tests and for the
   *  server-boot "catch up anything due now" path. */
  tick(): Promise<TickReport>;
  /** Rebuild the roster (install / uninstall / enable / disable) +
   *  reset per-entry timers. */
  refreshRoster(): Promise<void>;
  /** User-initiated rearm after circuit-breaker auto-disable, by roster
   *  key — the dish's id (D-319). */
  resetCircuit(key: string): void;
  /** Read-only roster view, keyed by dish — used by status CLI + tests. */
  readonly roster: ReadonlyMap<string, AutoRunEntry>;
  /** True while scheduler-owned work is running, including a fire executing
   *  or persisting its final state. Used by the drain orchestrator to wait for
   *  a clean shutdown. */
  inFlight(): boolean;
}

/** A tick whose dish was switched off after the roster was built: nothing
 *  ran, nothing failed. */
class SkippedFire extends Error {}

export const createServerAutoRunScheduler = (
  config: ServerAutoRunConfig,
): ServerAutoRunHandle => {
  const now = config.now ?? (() => Date.now());
  const scheduler = config.scheduler
    ?? createAutoRunScheduler({ mintProcessId: config.mintProcessId });
  const setTimer = config.setTimer ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  const clearTimer = config.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  const dishes = config.dishStore ?? config.executeDeps?.dishStore;
  /** A dish's timer is on: its row, and the dish's own switch. */
  const timerOn = (dish_id: string): boolean =>
    (config.settingsStore ? config.settingsStore.isEnabled(dish_id) : true)
    && dishes?.get(dish_id)?.enabled === true;
  const execute = config.execute ?? ((request: ExecuteRequest) => {
    if (!config.executeDeps) {
      throw new Error('auto-run scheduler: executeDeps required when no custom execute provided');
    }
    const recipe = request.recipe_id ? config.recipeStore.get(request.recipe_id) : null;
    const enabled = !!recipe?.auto_run && request.dish_id !== undefined && timerOn(request.dish_id);
    if (config.executeDeps.preapprovalDriver) return config.executeDeps.preapprovalDriver.executeAutoRun(request, enabled);
    // Recheck when a timer actually fires; a roster built before Disarm must
    // not dispatch a now-disabled timer through the ordinary path.
    return enabled ? handleExecute(config.executeDeps, request) : Promise.resolve(null);
  });

  const timers = new Map<string, unknown>();
  let running = false;
  let inflightCount = 0;
  const backgroundTasks = new Set<Promise<void>>();

  const reportBackgroundError = (message: string, error: unknown): void => {
    try {
      if (config.onBackgroundError) {
        config.onBackgroundError(message, error);
      } else {
        console.error(`[auto-run] ${message}`, error);
      }
    } catch {
      // A diagnostics hook must never promote a contained scheduler failure
      // back into the process-wide fatal `unhandledRejection` path.
    }
  };

  /** Attach the rejection handler immediately and retain the raw task through
   *  settlement. Using both branches of `then` avoids creating a detached
   *  rejected promise from `finally`, while stop() can still await the task. */
  const launchBackground = (message: string, task: Promise<void>): void => {
    backgroundTasks.add(task);
    void task.then(
      () => {
        backgroundTasks.delete(task);
      },
      (error) => {
        backgroundTasks.delete(task);
        reportBackgroundError(message, error);
      },
    );
  };

  /** D-319 — one install input per dish of each installed auto-run recipe. */
  const listInstallInputs = (): AutoRunInstallInput[] => {
    const stored = config.recipeStore.listStored();
    const out: AutoRunInstallInput[] = [];
    for (const row of stored) {
      let recipe: RecipeDefinition;
      try {
        recipe = JSON.parse(row.recipe_json) as RecipeDefinition;
      } catch {
        continue;
      }
      if (!recipe.auto_run) continue;
      for (const dish of dishes?.listByRecipe(recipe.recipe_id) ?? []) {
        const legacyEnabled = timerOn(dish.dish_id);
        const enabled = config.executeDeps?.preapprovalDriver?.autoRunEligible(dish.dish_id, legacyEnabled) ?? legacyEnabled;
        out.push({
          recipe_id: recipe.recipe_id,
          dish_id: dish.dish_id,
          publisher_id: row.publisher_id,
          // A timer switched off maps to a non-'enabled' status so
          // `rosterAllAutoRun` drops it — same mechanism the extension
          // install registry used for its pause state.
          status: !enabled
            ? 'disabled_by_user'
            : 'enabled',
          auto_run: recipe.auto_run,
        });
      }
    }
    return out;
  };

  const clearAllTimers = () => {
    for (const t of timers.values()) clearTimer(t);
    timers.clear();
  };

  const scheduleNext = (entry: AutoRunEntry) => {
    if (!running) return;
    if (entry.auto_disabled) return;
    const key = autoRunKey(entry);
    const existing = timers.get(key);
    if (existing !== undefined) clearTimer(existing);
    const delay = Math.max(AUTO_RUN_SERVER_FLOOR_MS, entry.next_run_at - now());
    const token = setTimer(() => {
      timers.delete(key);
      launchBackground(
        `timer fire failed for recipe ${entry.recipe_id} (dish ${key})`,
        fireEntry(key),
      );
    }, delay);
    timers.set(key, token);
  };

  const hydrateFromCircuitStore = () => {
    const states = config.circuitStore.list();
    for (const state of states) {
      const entry = scheduler.roster.get(state.dish_id);
      if (!entry) continue;
      entry.consecutive_failures = state.consecutive_failures;
      entry.auto_disabled = state.auto_disabled;
    }
  };

  const persistCircuitState = (key: string, nowMs: number, reason?: string) => {
    const entry = scheduler.roster.get(key);
    if (!entry) return;
    config.circuitStore.set({
      dish_id: key,
      recipe_id: entry.recipe_id,
      consecutive_failures: entry.consecutive_failures,
      auto_disabled: entry.auto_disabled,
      ...(entry.consecutive_failures > 0 ? { last_failure_at: nowMs } : {}),
      ...(reason ? { last_failure_reason: reason } : {}),
    });
  };

  const executeFired = async (
    key: string,
    process_id: string,
    firedAt: number,
  ): Promise<void> => {
    const fired = scheduler.roster.get(key);
    if (!fired) return;
    const { recipe_id } = fired;
    const dish_id = fired.dish_id;
    scheduler.markStarting(key, process_id, firedAt);
    inflightCount++;
    let outcome: AutoRunOutcome = 'failed';
    let nextRunHint: number | undefined;
    let failureReason: string | undefined;
    // D-268 — what KIND of failure it was, which decides whether waiting for the
    // breaker buys anything at all.
    let failureCode: string | undefined;
    let totalRefusal = false;
    /** D-268 — the run reported an error the recipe DECIDED to raise. Nothing
     *  about the circuit changed, so nothing about the circuit is written. */
    let notAFailure = false;
    const visibleFailure = (failure: unknown): string => {
      const presented = presentAutomationFailure(failure);
      if (presented.redacted) {
        console.error(
          `[auto-run] recipe ${recipe_id} internal failure: ${presented.internalMessage}`,
        );
      }
      return presented.userMessage;
    };
    try {
      try {
        // D-153 P2.C — pass typed `ExecutionSource` so the execute-handler's
        // policy gate evaluates this run against the
        // `(channel: 'reactive', actor: 'system')` matrix cell. Every
        // auto-run fire is a periodic timer tick — the recipe's
        // `trigger_steps` decide whether the sequential phase actually
        // runs. There's no per-fire synthetic event payload at this
        // dispatch site (D-115 trigger source registry is a later
        // phase), so `event_kind` carries the generic `'auto_run_tick'`
        // placeholder. When the trigger-source registry lands (spec
        // line 587), this widens to the registered event kind.
        // D-319 — fire-time dish gate. A dish switched off (or gone) SKIPS
        // the tick silently: its switch also takes its timer off the roster,
        // so this is the backstop for a roster built a moment before.
        if (dish_id !== undefined && dishes !== undefined && dishes.get(dish_id)?.enabled !== true) {
          throw new SkippedFire();
        }
        // D-319 — the timer fires AS its dish, with its settings (resolved
        // inside handleExecute).
        const result = await execute({
          recipe_id,
          trigger_source: 'auto_run',
          execution_source: {
            channel: 'reactive',
            actor: 'system',
            event_kind: 'auto_run_tick',
            source_recipe: recipe_id,
            // ⛔ D-215 slice 1a — NO `contract_id` here, deliberately. Same
            // finding as `scheduler.ts` (see the long note there): D-209 §1.4's
            // stamp changed neither the ceiling (a contract-free `system`
            // non-housekeeping source already resolves to the same `read` HOLD)
            // nor the grant axis (the owner sentinel is rejected as a bound door
            // id), but made every source contract-bearing — so
            // `gateRecipeAgainstPolicy` threw "requires a ContractSnapshot" and
            // every auto-run tick failed at the gate.
          },
          process_id,
          ...(dish_id !== undefined ? { dish_id } : {}),
        });
        nextRunHint = result?.next_run_at;
        // D-115 outcome classification mirrors the extension controller:
        // trigger_skipped takes precedence (silent-skip), then
        // success/failure. Skipped keeps the failure counter unchanged;
        // a failed run increments toward the circuit breaker.
        // ⛔⛔ A DURABLE PAUSE IS A THIRD STATE, AND CLASSIFYING IT AS `failed`
        // DISABLED THE RECIPE. The engine returns `success: false` with an
        // EMPTY `errors` array when a run pauses on a preflight gate, so
        // deciding on `!success` alone recorded a failure whose reason degraded
        // to the generic "execution failed" — and `CIRCUIT_BREAKER_THRESHOLD`
        // consecutive holds set `auto_disabled`. Any auto-run recipe whose
        // first write is approval-gated therefore switched itself off while its
        // asks sat unanswered: at a 15-minute interval, inside an hour and a
        // half, with nothing on the record mentioning approval.
        //
        // A hold is the system working. The ask IS the surface the owner acts
        // on, the checkpoint is durable, and the next tick should keep firing.
        //
        // ⚠ `awaiting_approval` / `awaiting_peer` are set on the response ONLY
        // when the pause is durable — a downgraded pause with no checkpoint
        // stays a terminal failure, which is right, because nothing will ever
        // come back to finish it. Reading the marker rather than
        // `result.awaiting_*` on the engine result is what keeps that
        // distinction.
        const heldForAnswer = result?.awaiting_approval === true
          || result?.awaiting_peer === true;
        if (result === null || result.trigger_skipped) {
          outcome = 'skipped';
        } else if (heldForAnswer) {
          outcome = 'held';
        } else if (result.success) {
          // D-268 — a `foreach` is continue-on-error, so a run whose every item
          // was refused reports `success: true` and writes no error. D-237's
          // predicate is the only thing that can tell the two apart; until now
          // its only consumers were the D-214 case compiler, so nothing
          // notified and nothing stopped.
          // ⛔ The OUTCOME stays `'failed'` for the counter's sake but the run
          // genuinely completed — nothing here may rewrite its anchor status.
          if (runYieldIsTotalRefusal(deriveRunYield(result.steps))) {
            outcome = 'failed';
            totalRefusal = true;
            failureReason = 'This run attempted items and every one was refused.';
          } else {
            outcome = 'success';
          }
        } else {
          outcome = 'failed';
          const first = result.errors[0] as { message?: string; code?: string } | undefined;
          failureCode = typeof first?.code === 'string' ? first.code : undefined;
          failureReason = visibleFailure(first?.message ?? 'execution failed');
        }
      } catch (e) {
        if (e instanceof SkippedFire) {
          outcome = 'skipped';
        } else {
          outcome = 'failed';
          const code = (e as { code?: unknown } | null)?.code;
          failureCode = typeof code === 'string' ? code : undefined;
          failureReason = visibleFailure(e);
        }
      }

      // Finalization is part of the in-flight unit. In particular, keep the
      // shutdown gate raised through the SQLite circuit write; releasing it
      // after `execute` but before this write lets close_db race the store.
      // D-268 — classify BEFORE `markFinished`, because the prior counter is the
      // episode boundary and `markFinished` is what moves it.
      const priorFailures = scheduler.roster.get(key)?.consecutive_failures ?? 0;
      let disarmNow = false;
      if (outcome === 'failed') {
        // D-319 — the failing unit is the dish's timer.
        const unit: AutomationUnitRef = {
          kind: 'auto_run',
          id: key,
          recipe_id,
        };
        const report = decideAutomationFailure({
          unit,
          code: failureCode,
          total_refusal: totalRefusal,
          reason: failureReason ?? 'execution failed',
          prior_consecutive_failures: priorFailures,
          threshold: CIRCUIT_BREAKER_THRESHOLD,
        });
        // ⚠ A `conditional` code reaching here means the run reported an error
        // the recipe DECIDED to raise — a tripped guard. It is not evidence the
        // recipe is broken, so it must not touch the counter either.
        if (report.not_a_failure) {
          outcome = 'skipped';
          // ⛔ AND THE REASON GOES WITH IT. `persistCircuitState` writes
          // `last_failure_reason` whenever a reason is truthy, and re-stamps
          // `last_failure_at` whenever the counter is non-zero — so a tripped
          // guard arriving after a REAL failure would overwrite that failure's
          // reason and time with a non-failure's, on the row every kill-switch
          // surface reads.
          //
          // ⛔ AND CLEARING THE REASON IS NOT THE FIX — IT ERASES THE PRIOR ONE.
          // `persistCircuitState` writes a WHOLE ROW with the reason omitted
          // when falsy, so blanking it leaves `consecutive_failures: 1` beside
          // no reason at all. "Nothing happened" has to mean the row is not
          // rewritten, which is what `notAFailure` below buys.
          notAFailure = true;
        } else {
          disarmNow = report.disarm && report.consecutive_failures < CIRCUIT_BREAKER_THRESHOLD;
          if (report.notice) {
            try {
              config.onAutomationFailure?.(report.notice, unit);
            } catch {
              // Telling the owner is best-effort; a broken consumer must not
              // turn a recorded failure into a failed fire.
            }
          }
        }
      }
      scheduler.markFinished(key, outcome, nextRunHint, now(),
        ...(disarmNow ? [{ disarmNow: true }] as const : []));
      // ⚠ A tripped guard skips the persist entirely. Every other outcome still
      // writes, including `skipped` / `held` — unchanged, and out of scope here:
      // a `trigger_skipped` tick has always rewritten this row without a reason.
      if (!notAFailure) persistCircuitState(key, now(), failureReason);
      try {
        config.onFired?.(recipe_id);
      } catch {
        // A broken listener is a UI bug, not a scheduler bug.
      }
    } finally {
      inflightCount--;
    }
  };

  const fireEntry = async (key: string): Promise<void> => {
    // Vault-locked gate: skip before advancing the scheduler clock so the
    // entry stays due, and do NOT re-arm — the dormant one-shot timer is
    // re-armed by the coordinator's `tick()` kick on unlock.
    if (config.isVaultUnlocked && !config.isVaultUnlocked()) return;
    const t = now();
    const report = scheduler.tick(t);
    const fired = report.fired.find((f) => f.key === key);
    if (fired) {
      await executeFired(key, fired.process_id, t);
    }
    const updated = scheduler.roster.get(key);
    if (updated) scheduleNext(updated);
  };

  const refreshRoster = async (): Promise<void> => {
    const installs = listInstallInputs();
    const next = rosterAllAutoRun({
      installs,
      previousRoster: scheduler.roster,
      now: now(),
      mintProcessId: config.mintProcessId,
    });
    scheduler.setRoster(next);
    hydrateFromCircuitStore();
    clearAllTimers();
    if (running) {
      for (const [, entry] of scheduler.roster) scheduleNext(entry);
    }
  };

  const tick = async (): Promise<TickReport> => {
    // Vault-locked gate: skip the whole tick while sealed. No clock
    // advance (due entries stay due), no timer re-arm (the scheduler
    // goes dormant rather than busy-looping on past `next_run_at`s).
    // The coordinator calls `tick()` again on unlock to fire the
    // catch-up + re-arm every roster entry.
    if (config.isVaultUnlocked && !config.isVaultUnlocked()) {
      return { fired: [], skipped_overlap: [], skipped_circuit: [] };
    }
    const t = now();
    const report = scheduler.tick(t);
    // Dispatch each fired entry sequentially — a server is a
    // constrained resource and we don't want 200 reactive recipes
    // all hitting the engine at once. A future tuning knob could
    // parallelize with a concurrency cap; Phase 4 keeps it simple.
    for (const fired of report.fired) {
      await executeFired(fired.key, fired.process_id, t);
    }
    // Rearm timers for every entry that's now got an updated
    // next_run_at (tick advanced them and markFinished may have
    // overridden dynamic entries).
    if (running) {
      for (const [, entry] of scheduler.roster) scheduleNext(entry);
    }
    return report;
  };

  return {
    async start() {
      if (running) return;
      running = true;
      try {
        await refreshRoster();
      } catch (error) {
        // A failed roster hydration must not leave the handle looking started:
        // callers can fix the dependency and retry the same handle.
        running = false;
        clearAllTimers();
        throw error;
      }
      // Immediate catch-up tick for anything due at boot. setTimeout
      // would otherwise wait the full AUTO_RUN_SERVER_FLOOR_MS
      // before firing the first round.
      launchBackground('initial background tick failed', tick().then(() => undefined));
    },
    async stop() {
      running = false;
      clearAllTimers();
      // Preserve the established drain ordering for direct/manual tick()
      // calls: a stop requested during persistence does not settle in the
      // same microtask turn as that persistence callback.
      while (inflightCount > 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
      // Then await the whole scheduler-owned task. scheduler.tick(), roster
      // lookup, circuit persistence, and timer re-arm can fail outside the
      // narrower executeFired counter window.
      await Promise.allSettled([...backgroundTasks]);
    },
    tick,
    refreshRoster,
    resetCircuit(key) {
      scheduler.resetCircuit(key, now());
      config.circuitStore.clear(key);
      const entry = scheduler.roster.get(key);
      if (entry && running) scheduleNext(entry);
    },
    get roster() {
      return scheduler.roster;
    },
    inFlight() {
      return backgroundTasks.size > 0 || inflightCount > 0;
    },
  };
};
