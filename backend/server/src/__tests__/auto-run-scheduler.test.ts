import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CIRCUIT_BREAKER_THRESHOLD, OWNER_CONTRACT_ID } from '@recued/contracts';
import type { RecipeDefinition } from '@recued/contracts';
import {
  createCircuitBreakerStore,
  createServerAutoRunScheduler,
  type AutoRunSettingsStore,
  type CircuitBreakerStore,
  type ServerAutoRunHandle,
} from '../auto-run-scheduler.js';
import type { RecipeStore } from '../recipe-store.js';
import type { StoredRecipe } from '../types.js';
import type { ExecuteRequest, ExecuteResponse } from '../types.js';

const SEC = 1000;

const flush = () => new Promise<void>((r) => setImmediate(r));

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const makeReactiveRecipe = (
  id: string,
  intervalMs = 30 * SEC,
): RecipeDefinition => ({
  recipe_id: id,
  version: 1,
  ttl: 300,
  auto_run: { interval_ms: intervalMs },
  metadata: {
    name: id,
    description: 'test',
    author: 'recued-core',
    supported_platforms: ['test'],
  },
  steps: [],
} as unknown as RecipeDefinition);

const makeStoredRow = (recipe: RecipeDefinition): StoredRecipe => ({
  recipe_id: recipe.recipe_id,
  publisher_id: 'recued-core',
  version: recipe.version,
  recipe_hash: 'h',
  recipe_json: JSON.stringify(recipe),
  source: 'inline',
  installed_at: 0,
  pack_slug: null,
});

/** A tiny in-memory RecipeStore satisfying the narrow slice the
 *  auto-run scheduler actually uses (`listStored` only). */
const mkRecipeStore = (recipes: RecipeDefinition[]): RecipeStore => ({
  get: (id) => recipes.find((r) => r.recipe_id === id) ?? null,
  getBundled: (id) => recipes.find((r) => r.recipe_id === id) ?? null,
  getStored: () => null,
  size: () => recipes.length,
  ids: () => recipes.map((r) => r.recipe_id),
  register: () => {},
  save: () => {},
  delete: () => false,
  listForPack: () => [],
  listStored: () => recipes.map(makeStoredRow),
  updateUpstream: () => {},
  setOnUpgrade: () => {},
  setOnMutated: () => {},
});

/** Either a plain boolean/Error outcome (back-compat) or a
 *  `{ success, trigger_skipped?, next_run_at? }` envelope letting
 *  D-115 Phase 5 tests exercise silent-skip + dynamic-interval paths. */
type Outcome =
  | boolean
  | Error
  | {
      success: boolean;
      trigger_skipped?: boolean;
      next_run_at?: number;
    };

/** Deterministic executor that records calls and returns a
 *  preconfigured success/failure sequence. */
const mkExecutor = (outcomes: Array<Outcome>) => {
  const calls: ExecuteRequest[] = [];
  let cursor = 0;
  const execute = async (request: ExecuteRequest): Promise<ExecuteResponse> => {
    calls.push(request);
    const outcome = outcomes[cursor] ?? outcomes[outcomes.length - 1] ?? true;
    cursor++;
    if (outcome instanceof Error) throw outcome;
    const envelope = typeof outcome === 'boolean'
      ? { success: outcome }
      : outcome;
    return {
      recipe_id: request.recipe_id ?? 'r',
      recipe_hash: 'h',
      success: envelope.success,
      output: { sidebar: [] },
      steps: [],
      errors: envelope.success ? [] : [{ code: 'test_err', message: 'fail' } as unknown as never],
      duration_ms: 1,
      validation_issues: [],
      ...(envelope.trigger_skipped ? { trigger_skipped: true } : {}),
      ...(envelope.next_run_at !== undefined ? { next_run_at: envelope.next_run_at } : {}),
    } as unknown as ExecuteResponse;
  };
  return { execute, calls };
};

/** Fake timer driver — lets tests fire timers deterministically. */
const mkFakeTimers = () => {
  const pending = new Map<number, { fn: () => void; delay: number }>();
  let nextToken = 1;
  return {
    setTimer: (fn: () => void, delay: number) => {
      const token = nextToken++;
      pending.set(token, { fn, delay });
      return token;
    },
    clearTimer: (token: unknown) => {
      pending.delete(token as number);
    },
    fireAll: async () => {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, { fn }] of entries) fn();
      // Allow the scheduled microtasks to settle.
      await flush();
      await flush();
    },
    pendingCount: () => pending.size,
  };
};

// ────────────────────────────────────────────────────────────────
// CircuitBreakerStore (SQLite)
// ────────────────────────────────────────────────────────────────

describe('createCircuitBreakerStore', () => {
  let db: Database.Database;
  let store: CircuitBreakerStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createCircuitBreakerStore(db);
  });

  it('roundtrips through SQLite', () => {
    store.set({
      recipe_id: 'r',
      consecutive_failures: 3,
      auto_disabled: true,
      last_failure_at: 1_700_000_000_000,
      last_failure_reason: 'boom',
    });
    expect(store.get('r')).toEqual({
      recipe_id: 'r',
      consecutive_failures: 3,
      auto_disabled: true,
      last_failure_at: 1_700_000_000_000,
      last_failure_reason: 'boom',
    });
  });

  it('persists across a simulated restart (new store over same db)', () => {
    store.set({
      recipe_id: 'r',
      consecutive_failures: CIRCUIT_BREAKER_THRESHOLD,
      auto_disabled: true,
    });
    const restarted = createCircuitBreakerStore(db);
    expect(restarted.get('r')).toMatchObject({
      consecutive_failures: CIRCUIT_BREAKER_THRESHOLD,
      auto_disabled: true,
    });
  });

  it('clear removes the row', () => {
    store.set({ recipe_id: 'r', consecutive_failures: 1, auto_disabled: false });
    store.clear('r');
    expect(store.get('r')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Roster build from RecipeStore.listStored
// ────────────────────────────────────────────────────────────────

describe('ServerAutoRunHandle — roster build', () => {
  it('includes only recipes that declare auto_run', async () => {
    const reactive = makeReactiveRecipe('reactive');
    const manual = { ...makeReactiveRecipe('manual') } as RecipeDefinition;
    delete (manual as { auto_run?: unknown }).auto_run;

    const db = new Database(':memory:');
    const { execute } = mkExecutor([true]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([reactive, manual]),
      execute,
      circuitStore: createCircuitBreakerStore(db),
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    expect([...handle.roster.keys()]).toEqual(['reactive']);
  });

  it('keeps a default-disabled definition out of the roster without a settings store', async () => {
    const recipe = makeReactiveRecipe('owner-armed');
    recipe.auto_run = {
      interval_ms: 15 * 60 * SEC,
      default_enabled: false,
    };
    const db = new Database(':memory:');
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([recipe]),
      execute: mkExecutor([true]).execute,
      circuitStore: createCircuitBreakerStore(db),
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });

    await handle.refreshRoster();
    expect(handle.roster.has('owner-armed')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Tick dispatch + circuit persistence
// ────────────────────────────────────────────────────────────────

describe('ServerAutoRunHandle.tick', () => {
  let db: Database.Database;
  let circuit: CircuitBreakerStore;

  beforeEach(() => {
    db = new Database(':memory:');
    circuit = createCircuitBreakerStore(db);
  });

  it('dispatches fired entries through the injected executor', async () => {
    const { execute, calls } = mkExecutor([true]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r')]),
      execute,
      circuitStore: circuit,
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    await handle.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].recipe_id).toBe('r');
    expect(calls[0].trigger_source).toBe('auto_run');
    expect(calls[0].execution_source).toEqual({
      channel: 'reactive',
      actor: 'system',
      event_kind: 'auto_run_tick',
      source_recipe: 'r',
      // D-209 §1.4 — the owner's own auto-run carries the owner contract.
      contract_id: OWNER_CONTRACT_ID,
    });
    expect(calls[0].process_id).toBe(handle.roster.get('r')!.process_id);
    // No config dish set ⇒ a dishless fire (recipe defaults), unchanged.
    expect(calls[0].dish_id).toBeUndefined();
  });

  it('D-179 — threads the current managed config dish_id into the fire', async () => {
    const { execute, calls } = mkExecutor([true]);
    const dishIds = new Map<string, string | null>([['r', 'dsh_cfg1']]);
    const settingsStore: AutoRunSettingsStore = {
      isEnabled: () => true,
      setEnabled: () => {},
      listDisabled: () => [],
      getDishId: (id) => dishIds.get(id) ?? null,
      setDishId: (id, d) => { dishIds.set(id, d); },
    };
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r')]),
      execute,
      circuitStore: circuit,
      settingsStore,
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    await handle.tick();
    expect(calls[0].dish_id).toBe('dsh_cfg1');
  });

  it('R21.1 — tick() dispatches nothing while the vault is sealed, then fires the still-due entry on unlock', async () => {
    const { execute, calls } = mkExecutor([true, true]);
    let unlocked = false;
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r')]),
      execute,
      circuitStore: circuit,
      isVaultUnlocked: () => unlocked,
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();

    // Sealed: the tick skips BEFORE advancing the scheduler clock — no
    // dispatch, and the entry stays due for catch-up.
    const sealed = await handle.tick();
    expect(calls).toHaveLength(0);
    expect(sealed.fired).toEqual([]);

    // Unlock + tick (the coordinator's resume kick) → the still-due entry fires.
    unlocked = true;
    await handle.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].recipe_id).toBe('r');
  });

  it('persists a fresh failure to SQLite and increments the counter', async () => {
    const { execute } = mkExecutor([false]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r')]),
      execute,
      circuitStore: circuit,
      now: () => 1_000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    await handle.tick();
    expect(circuit.get('r')).toMatchObject({
      consecutive_failures: 1,
      auto_disabled: false,
      last_failure_at: 1_000,
    });
  });

  it('resets the counter on success (persisted)', async () => {
    // Seed a non-zero failure state in SQLite so hydration carries it
    // into the scheduler.
    circuit.set({
      recipe_id: 'r', consecutive_failures: 3, auto_disabled: false,
    });
    const { execute } = mkExecutor([true]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r')]),
      execute,
      circuitStore: circuit,
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    // Confirm hydration before tick.
    expect(handle.roster.get('r')!.consecutive_failures).toBe(3);
    await handle.tick();
    expect(circuit.get('r')?.consecutive_failures).toBe(0);
  });

  it('trips the circuit after N consecutive failures and persists auto_disabled', async () => {
    const { execute } = mkExecutor(
      Array.from({ length: CIRCUIT_BREAKER_THRESHOLD }, () => false),
    );
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r', 100)]),
      execute,
      circuitStore: circuit,
      now: () => 1_000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      handle.roster.get('r')!.next_run_at = 1_000;
      await handle.tick();
    }
    expect(circuit.get('r')?.auto_disabled).toBe(true);
  });

  it('catches thrown executor errors and counts them as failures', async () => {
    const { execute } = mkExecutor([new Error('engine crashed')]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r')]),
      execute,
      circuitStore: circuit,
      now: () => 500,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    await handle.tick();
    expect(circuit.get('r')).toMatchObject({
      consecutive_failures: 1,
      last_failure_reason: 'engine crashed',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// D-115 Phase 5 — trigger_skipped + next_run_at outcome wiring
// ────────────────────────────────────────────────────────────────

describe('ServerAutoRunHandle — D-115 Phase 5 outcomes', () => {
  let db: Database.Database;
  let circuit: CircuitBreakerStore;

  beforeEach(() => {
    db = new Database(':memory:');
    circuit = createCircuitBreakerStore(db);
  });

  it('trigger_skipped: counter unchanged, no audit row implied', async () => {
    circuit.set({ recipe_id: 'r', consecutive_failures: 2, auto_disabled: false });
    const { execute } = mkExecutor([{ success: true, trigger_skipped: true }]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r')]),
      execute,
      circuitStore: circuit,
      now: () => 1_000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    await handle.tick();
    // counter preserved (neither reset to 0 nor advanced to 3).
    expect(circuit.get('r')?.consecutive_failures).toBe(2);
  });

  it('trigger_skipped takes precedence over success=false', async () => {
    const { execute } = mkExecutor([{ success: false, trigger_skipped: true }]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r')]),
      execute,
      circuitStore: circuit,
      now: () => 1_000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    await handle.tick();
    // counter stays at 0 — not incremented despite success=false.
    const state = circuit.get('r');
    // When the counter is 0 and nothing else is set, set() still
    // persists a zero row (no auto_disabled, no reason). So accept
    // either "null row" (never written) or "zero state".
    if (state) {
      expect(state.consecutive_failures).toBe(0);
      expect(state.auto_disabled).toBe(false);
    }
  });

  it('next_run_at hint is honoured when auto_run.dynamic is true', async () => {
    const recipe = makeReactiveRecipe('r');
    recipe.auto_run!.dynamic = true;
    const { execute } = mkExecutor([
      { success: true, next_run_at: 5_000_000 },
    ]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([recipe]),
      execute,
      circuitStore: circuit,
      now: () => 1_000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    await handle.tick();
    expect(handle.roster.get('r')!.next_run_at).toBe(5_000_000);
  });

  it('next_run_at hint is ignored when auto_run.dynamic is false (default)', async () => {
    const { execute } = mkExecutor([
      { success: true, next_run_at: 5_000_000 },
    ]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r', 60 * SEC)]),
      execute,
      circuitStore: circuit,
      now: () => 1_000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    await handle.tick();
    // 1_000 (now) + 60_000 (interval) — not 5_000_000.
    expect(handle.roster.get('r')!.next_run_at).toBe(61_000);
  });

  it('passes next_run_at hint through even on trigger_skipped (dynamic pacing)', async () => {
    const recipe = makeReactiveRecipe('r');
    recipe.auto_run!.dynamic = true;
    const { execute } = mkExecutor([
      { success: true, trigger_skipped: true, next_run_at: 7_000_000 },
    ]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([recipe]),
      execute,
      circuitStore: circuit,
      now: () => 1_000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    await handle.tick();
    expect(handle.roster.get('r')!.next_run_at).toBe(7_000_000);
  });
});

// ────────────────────────────────────────────────────────────────
// Restart recovery
// ────────────────────────────────────────────────────────────────

describe('ServerAutoRunHandle — restart recovery', () => {
  it('hydrates auto_disabled state from SQLite so ticks stay blocked', async () => {
    const db = new Database(':memory:');
    const circuit = createCircuitBreakerStore(db);
    circuit.set({
      recipe_id: 'r',
      consecutive_failures: CIRCUIT_BREAKER_THRESHOLD,
      auto_disabled: true,
    });
    const { execute, calls } = mkExecutor([true]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r')]),
      execute,
      circuitStore: circuit,
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    const report = await handle.tick();
    expect(report.skipped_circuit).toEqual(['r']);
    expect(calls).toEqual([]); // circuit-blocked — no execute call
  });
});

// ────────────────────────────────────────────────────────────────
// setTimer-driven fire + stop lifecycle
// ────────────────────────────────────────────────────────────────

describe('ServerAutoRunHandle — setTimer lifecycle', () => {
  let timers: ReturnType<typeof mkFakeTimers>;
  let handle: ServerAutoRunHandle;

  beforeEach(() => {
    timers = mkFakeTimers();
  });

  it('arms a per-recipe timer when start() runs', async () => {
    const db = new Database(':memory:');
    handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([
        makeReactiveRecipe('r1'),
        makeReactiveRecipe('r2'),
      ]),
      execute: mkExecutor([true]).execute,
      circuitStore: createCircuitBreakerStore(db),
      now: () => 0,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await handle.start();
    // One timer per reactive recipe.
    expect(timers.pendingCount()).toBe(2);
  });

  it('clears all pending timers on stop()', async () => {
    const db = new Database(':memory:');
    handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r')]),
      execute: mkExecutor([true]).execute,
      circuitStore: createCircuitBreakerStore(db),
      now: () => 0,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await handle.start();
    expect(timers.pendingCount()).toBeGreaterThan(0);
    await handle.stop();
    expect(timers.pendingCount()).toBe(0);
  });

  it('firing a timer dispatches the recipe + rearms the next one', async () => {
    const db = new Database(':memory:');
    const { execute, calls } = mkExecutor([true, true]);
    let clock = 0;
    handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r', 30 * SEC)]),
      execute,
      circuitStore: createCircuitBreakerStore(db),
      now: () => clock,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await handle.start();
    // start() fires an immediate tick (sync path), which fires once.
    await flush();
    const initialCalls = calls.length;
    // Advance clock; fire all pending timers — one per armed entry.
    clock = 100_000;
    await timers.fireAll();
    expect(calls.length).toBeGreaterThan(initialCalls);
    // A new timer is armed for the next cycle.
    expect(timers.pendingCount()).toBeGreaterThan(0);
    await handle.stop();
  });
});

// ────────────────────────────────────────────────────────────────
// resetCircuit
// ────────────────────────────────────────────────────────────────

describe('ServerAutoRunHandle.resetCircuit', () => {
  it('clears the SQLite row and rearms the scheduler', async () => {
    const db = new Database(':memory:');
    const circuit = createCircuitBreakerStore(db);
    circuit.set({
      recipe_id: 'r',
      consecutive_failures: CIRCUIT_BREAKER_THRESHOLD,
      auto_disabled: true,
    });
    const { execute, calls } = mkExecutor([true]);
    const handle = createServerAutoRunScheduler({
      recipeStore: mkRecipeStore([makeReactiveRecipe('r')]),
      execute,
      circuitStore: circuit,
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await handle.refreshRoster();
    // Circuit-blocked before reset.
    await handle.tick();
    expect(calls).toEqual([]);

    handle.resetCircuit('r');
    expect(circuit.get('r')).toBeNull();

    // Next tick fires.
    handle.roster.get('r')!.next_run_at = 0;
    await handle.tick();
    expect(calls).toHaveLength(1);
  });
});
