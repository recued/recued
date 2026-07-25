/** D-115 Phase 4 — Server-side auto-run scheduler.
 *
 *  The headless server's equivalent of the extension SW scheduler:
 *  per-recipe `setTimeout` timers (sub-second cadence supported down
 *  to `AUTO_RUN_SERVER_FLOOR_MS`), SQLite-persisted circuit-breaker
 *  state so a restart doesn't forget which recipes are auto-disabled,
 *  and direct `handleExecute` dispatch instead of the extension's
 *  `runtime.runRecipe`.
 *
 *  Lifecycle:
 *    1. `start()` → `refreshRoster()` builds the roster from the
 *       recipe store, hydrates counters from SQLite, and arms a
 *       setTimeout per entry.
 *    2. Each timer fires → `fireEntry(recipe_id)` → scheduler.tick →
 *       handleExecute → markFinished → persistCircuit →
 *       scheduleNext. Every step wraps try/catch so a single
 *       failure can't leak into the timer loop.
 *    3. `stop()` clears all timers + waits for in-flight executions
 *       to settle so callers can safely close the database.
 *
 *  Spec: docs/d-115-spec.md §3.1 (Server implementation).
 */

import type { Database } from 'better-sqlite3';
import {
  createAutoRunScheduler,
  rosterAllAutoRun,
  type AutoRunEntry,
  type AutoRunInstallInput,
  type AutoRunScheduler,
  type TickReport,
} from '@recued/scheduler';
import {
  AUTO_RUN_SERVER_FLOOR_MS,
  OWNER_CONTRACT_ID,
  type CircuitBreakerState,
  type RecipeDefinition,
} from '@recued/contracts';
import type { RecipeStore } from './recipe-store.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { handleExecute } from './execute-handler.js';
import type { ExecuteRequest, ExecuteResponse } from './types.js';

// ────────────────────────────────────────────────────────────────
// Circuit-breaker persistence (SQLite)
// ────────────────────────────────────────────────────────────────

export interface CircuitBreakerStore {
  list(): CircuitBreakerState[];
  get(recipe_id: string): CircuitBreakerState | null;
  set(state: CircuitBreakerState): void;
  clear(recipe_id: string): void;
}

// ────────────────────────────────────────────────────────────────
// Per-recipe user-intent settings (SQLite)
// ────────────────────────────────────────────────────────────────

/** Reactive-substrate slice 1 — per-recipe auto-run arm/disarm state.
 *  The user-intent axis, deliberately separate from the circuit-
 *  breaker's failure axis: `enabled: false` keeps a recipe out of the
 *  scheduler roster the same way an event-trigger's `enabled: false`
 *  keeps it off the warehouse bus. An absent row follows the recipe
 *  definition's `default_enabled` value, which remains true when omitted
 *  for existing recipes. */
export interface AutoRunSettingsStore {
  /** An explicit row wins; otherwise returns the recipe definition's
   *  supplied default (true when omitted for legacy callers). */
  isEnabled(recipe_id: string, defaultEnabled?: boolean): boolean;
  setEnabled(recipe_id: string, enabled: boolean): void;
  /** recipe_ids with an explicit `enabled = 0` row. */
  listDisabled(): string[];
  /** D-179 — the current managed auto-run config dish for a recipe, or
   *  `null` when no config is set (the fire runs on recipe defaults).
   *  `executeFired` threads this into the reactive dispatch. */
  getDishId(recipe_id: string): string | null;
  /** Point the recipe at a (new) config dish, or `null` to clear. The
   *  dish itself is immutable — a config change mints a new dish and
   *  repoints here (the caller dissolves the superseded one). */
  setDishId(
    recipe_id: string,
    dish_id: string | null,
    defaultEnabled?: boolean,
  ): void;
}

/** SQLite-backed settings store. Creates the table on first use —
 *  same shared-db posture as the circuit store above. */
export const createAutoRunSettingsStore = (db: Database): AutoRunSettingsStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_run_settings (
      recipe_id  TEXT PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );
  `);
  // D-179 — `dish_id` points at the recipe's current managed auto-run
  // config dish. Added by migration for tables that predate it.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(auto_run_settings)`).all() as Array<{ name: string }>)
      .map((c) => c.name),
  );
  if (!cols.has('dish_id')) {
    db.exec(`ALTER TABLE auto_run_settings ADD COLUMN dish_id TEXT`);
  }

  return {
    isEnabled(recipe_id, defaultEnabled = true) {
      const row = db.prepare(
        'SELECT enabled FROM auto_run_settings WHERE recipe_id = ?',
      ).get(recipe_id) as { enabled: number } | undefined;
      return row === undefined ? defaultEnabled : row.enabled === 1;
    },
    setEnabled(recipe_id, enabled) {
      db.prepare(`
        INSERT INTO auto_run_settings (recipe_id, enabled, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT (recipe_id) DO UPDATE SET
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `).run(recipe_id, enabled ? 1 : 0, Date.now());
    },
    listDisabled() {
      return (db.prepare(
        'SELECT recipe_id FROM auto_run_settings WHERE enabled = 0',
      ).all() as Array<{ recipe_id: string }>).map((r) => r.recipe_id);
    },
    getDishId(recipe_id) {
      const row = db.prepare(
        'SELECT dish_id FROM auto_run_settings WHERE recipe_id = ?',
      ).get(recipe_id) as { dish_id: string | null } | undefined;
      return row?.dish_id ?? null;
    },
    setDishId(recipe_id, dish_id, defaultEnabled = true) {
      // A fresh row preserves the recipe's definitional default; a conflict
      // touches only dish_id so explicit owner intent is preserved.
      db.prepare(`
        INSERT INTO auto_run_settings (recipe_id, enabled, updated_at, dish_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (recipe_id) DO UPDATE SET
          dish_id = excluded.dish_id,
          updated_at = excluded.updated_at
      `).run(recipe_id, defaultEnabled ? 1 : 0, Date.now(), dish_id);
    },
  };
};

/** SQLite-backed circuit-breaker store. Creates the table on first
 *  use — tolerates sharing the recued-server.db with every other
 *  table. */
export const createCircuitBreakerStore = (db: Database): CircuitBreakerStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_run_circuit (
      recipe_id            TEXT PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      auto_disabled        INTEGER NOT NULL DEFAULT 0,
      last_failure_at      INTEGER,
      last_failure_reason  TEXT
    );
  `);

  interface Row {
    recipe_id: string;
    consecutive_failures: number;
    auto_disabled: number;
    last_failure_at: number | null;
    last_failure_reason: string | null;
  }

  const rowToState = (row: Row): CircuitBreakerState => ({
    recipe_id: row.recipe_id,
    consecutive_failures: row.consecutive_failures,
    auto_disabled: row.auto_disabled === 1,
    ...(row.last_failure_at != null ? { last_failure_at: row.last_failure_at } : {}),
    ...(row.last_failure_reason != null ? { last_failure_reason: row.last_failure_reason } : {}),
  });

  return {
    list() {
      return (db.prepare('SELECT * FROM auto_run_circuit').all() as Row[]).map(rowToState);
    },
    get(recipe_id) {
      const row = db.prepare('SELECT * FROM auto_run_circuit WHERE recipe_id = ?').get(recipe_id) as Row | undefined;
      return row ? rowToState(row) : null;
    },
    set(state) {
      db.prepare(`
        INSERT INTO auto_run_circuit (recipe_id, consecutive_failures, auto_disabled, last_failure_at, last_failure_reason)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (recipe_id) DO UPDATE SET
          consecutive_failures = excluded.consecutive_failures,
          auto_disabled = excluded.auto_disabled,
          last_failure_at = excluded.last_failure_at,
          last_failure_reason = excluded.last_failure_reason
      `).run(
        state.recipe_id,
        state.consecutive_failures,
        state.auto_disabled ? 1 : 0,
        state.last_failure_at ?? null,
        state.last_failure_reason ?? null,
      );
    },
    clear(recipe_id) {
      db.prepare('DELETE FROM auto_run_circuit WHERE recipe_id = ?').run(recipe_id);
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
  /** Reactive-substrate slice 1 — per-recipe user arm/disarm state.
   *  Consulted at roster-build time: a disabled recipe maps to
   *  `status: 'disabled_by_user'` so `rosterAllAutoRun` drops it.
   *  When absent, the recipe's `default_enabled` definition applies;
   *  omission retains legacy enabled behavior. */
  settingsStore?: AutoRunSettingsStore;
  /** Reactive-substrate slice 1 — per-fire hook, invoked after each
   *  dispatched execution settles (success, skip, or failure). The
   *  boot wires `emitReactiveFire` so paired clients' Automation /
   *  Runs surfaces refresh live. Throws are swallowed. */
  onFired?: (recipe_id: string) => void;
  /** Clock override for tests. */
  now?: () => number;
  mintProcessId?: () => string;
  /** `setTimeout` override for deterministic tests. Defaults to
   *  Node's global `setTimeout`. Receives the computed delay. */
  setTimer?: (handler: () => void, delayMs: number) => unknown;
  /** `clearTimeout` override matching `setTimer`. */
  clearTimer?: (token: unknown) => void;
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
  /** Clear all pending timers + await in-flight executions so the
   *  caller can close the database safely. */
  stop(): Promise<void>;
  /** Run a single synchronous tick — for tests and for the
   *  server-boot "catch up anything due now" path. */
  tick(): Promise<TickReport>;
  /** Rebuild the roster (install / uninstall / enable / disable) +
   *  reset per-entry timers. */
  refreshRoster(): Promise<void>;
  /** User-initiated rearm after circuit-breaker auto-disable. */
  resetCircuit(recipe_id: string): void;
  /** Read-only roster view — used by status CLI + tests. */
  readonly roster: ReadonlyMap<string, AutoRunEntry>;
  /** True while any `handleExecute` promise is still pending. Used
   *  by the drain orchestrator to wait for a clean shutdown. */
  inFlight(): boolean;
}

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
  const execute = config.execute ?? ((request: ExecuteRequest) => {
    if (!config.executeDeps) {
      throw new Error('auto-run scheduler: executeDeps required when no custom execute provided');
    }
    return handleExecute(config.executeDeps, request);
  });

  const timers = new Map<string, unknown>();
  let running = false;
  let inflightCount = 0;

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
      const defaultEnabled = recipe.auto_run.default_enabled ?? true;
      const enabled = config.settingsStore
        ? config.settingsStore.isEnabled(recipe.recipe_id, defaultEnabled)
        : defaultEnabled;
      out.push({
        recipe_id: recipe.recipe_id,
        publisher_id: row.publisher_id,
        // User-disabled recipes map to a non-'enabled' status so
        // `rosterAllAutoRun` drops them — same mechanism the extension
        // install registry used for its pause state.
        status: !enabled
          ? 'disabled_by_user'
          : 'enabled',
        auto_run: recipe.auto_run,
      });
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
    const existing = timers.get(entry.recipe_id);
    if (existing !== undefined) clearTimer(existing);
    const delay = Math.max(AUTO_RUN_SERVER_FLOOR_MS, entry.next_run_at - now());
    const token = setTimer(() => {
      timers.delete(entry.recipe_id);
      void fireEntry(entry.recipe_id);
    }, delay);
    timers.set(entry.recipe_id, token);
  };

  const hydrateFromCircuitStore = () => {
    const states = config.circuitStore.list();
    for (const state of states) {
      const entry = scheduler.roster.get(state.recipe_id);
      if (!entry) continue;
      entry.consecutive_failures = state.consecutive_failures;
      entry.auto_disabled = state.auto_disabled;
    }
  };

  const persistCircuitState = (recipe_id: string, nowMs: number, reason?: string) => {
    const entry = scheduler.roster.get(recipe_id);
    if (!entry) return;
    config.circuitStore.set({
      recipe_id,
      consecutive_failures: entry.consecutive_failures,
      auto_disabled: entry.auto_disabled,
      ...(entry.consecutive_failures > 0 ? { last_failure_at: nowMs } : {}),
      ...(reason ? { last_failure_reason: reason } : {}),
    });
  };

  const executeFired = async (
    recipe_id: string,
    process_id: string,
    firedAt: number,
  ): Promise<void> => {
    scheduler.markStarting(recipe_id, process_id, firedAt);
    inflightCount++;
    let outcome: 'success' | 'skipped' | 'failed' = 'failed';
    let nextRunHint: number | undefined;
    let failureReason: string | undefined;
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
      // D-179 — dispatch as the recipe's current managed auto-run config
      // dish when one is set, so the headless fire honours the user's
      // configured overlay (the executor merges dish.config_overlay over
      // recipe defaults). Null ⇒ a dishless fire on recipe defaults,
      // exactly as before.
      const configDishId = config.settingsStore?.getDishId(recipe_id) ?? null;
      const result = await execute({
        recipe_id,
        trigger_source: 'auto_run',
        execution_source: {
          channel: 'reactive',
          actor: 'system',
          event_kind: 'auto_run_tick',
          source_recipe: recipe_id,
          // D-209 §1.4 — the owner's own automation runs under the owner contract:
          // has-contract → `read` ceiling → writes HOLD for review (silence earned via
          // the D-177 learner). A normal auto-run — no split from a pair-triggered one.
          contract_id: OWNER_CONTRACT_ID,
        },
        process_id,
        ...(configDishId !== null ? { dish_id: configDishId } : {}),
      });
      nextRunHint = result.next_run_at;
      // D-115 outcome classification mirrors the extension controller:
      // trigger_skipped takes precedence (silent-skip), then
      // success/failure. Skipped keeps the failure counter unchanged;
      // a failed run increments toward the circuit breaker.
      if (result.trigger_skipped) {
        outcome = 'skipped';
      } else if (result.success) {
        outcome = 'success';
      } else {
        outcome = 'failed';
        const first = result.errors[0] as { message?: string } | undefined;
        failureReason = first?.message ?? 'execution failed';
      }
    } catch (e) {
      outcome = 'failed';
      failureReason = e instanceof Error ? e.message : String(e);
    } finally {
      inflightCount--;
    }
    scheduler.markFinished(recipe_id, outcome, nextRunHint, now());
    persistCircuitState(recipe_id, now(), failureReason);
    try {
      config.onFired?.(recipe_id);
    } catch {
      // A broken listener is a UI bug, not a scheduler bug.
    }
  };

  const fireEntry = async (recipe_id: string): Promise<void> => {
    // Vault-locked gate: skip before advancing the scheduler clock so the
    // entry stays due, and do NOT re-arm — the dormant one-shot timer is
    // re-armed by the coordinator's `tick()` kick on unlock.
    if (config.isVaultUnlocked && !config.isVaultUnlocked()) return;
    const t = now();
    const report = scheduler.tick(t);
    const fired = report.fired.find((f) => f.recipe_id === recipe_id);
    if (fired) {
      await executeFired(recipe_id, fired.process_id, t);
    }
    const updated = scheduler.roster.get(recipe_id);
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
      await executeFired(fired.recipe_id, fired.process_id, t);
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
      await refreshRoster();
      // Immediate catch-up tick for anything due at boot. setTimeout
      // would otherwise wait the full AUTO_RUN_SERVER_FLOOR_MS
      // before firing the first round.
      void tick();
    },
    async stop() {
      running = false;
      clearAllTimers();
      // Await in-flight executions so the caller can close the DB
      // without racing an updateCircuit write.
      while (inflightCount > 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
    },
    tick,
    refreshRoster,
    resetCircuit(recipe_id) {
      scheduler.resetCircuit(recipe_id, now());
      config.circuitStore.clear(recipe_id);
      const entry = scheduler.roster.get(recipe_id);
      if (entry && running) scheduleNext(entry);
    },
    get roster() {
      return scheduler.roster;
    },
    inFlight() {
      return inflightCount > 0;
    },
  };
};
