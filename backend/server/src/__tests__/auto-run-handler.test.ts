import { describe, expect, it, vi } from 'vitest';
import type { CircuitBreakerState, RecipeDefinition } from '@recued/contracts';
import type { AutoRunEntry } from '@recued/scheduler';
import {
  listAutoRun,
  makeAutoRunHandlers,
  updateAutoRun,
  type AutoRunRpcDeps,
} from '../auto-run-handler.js';
import Database from 'better-sqlite3';
import type {
  AutoRunSettingsStore,
  CircuitBreakerStore,
  ServerAutoRunHandle,
} from '../auto-run-scheduler.js';
import { createDishStore } from '../dish-store.js';
import { createDishContextStore } from '../dish-context-store.js';
import type { StoredRecipe } from '../types.js';

const makeRecipe = (
  recipe_id: string,
  autoRun: RecipeDefinition['auto_run'] | undefined = { interval_ms: 1_000 },
  name?: string,
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  ...(autoRun ? { auto_run: autoRun } : {}),
  metadata: {
    name: name ?? recipe_id,
    description: 'test',
    author: 'test',
    supported_platforms: ['test'],
  },
  steps: [],
} as unknown as RecipeDefinition);

const storedRow = (
  recipe: RecipeDefinition,
  overrides: Partial<StoredRecipe> = {},
): StoredRecipe => ({
  recipe_id: recipe.recipe_id,
  publisher_id: 'publisher',
  version: recipe.version,
  recipe_hash: 'hash',
  recipe_json: JSON.stringify(recipe),
  source: 'inline',
  installed_at: 0,
  pack_slug: null,
  ...overrides,
});

const makeSettingsStore = (disabled = new Set<string>()) => {
  const dishIds = new Map<string, string | null>();
  const enabledByRecipe = new Map<string, boolean>(
    [...disabled].map((id) => [id, false]),
  );
  return {
    isEnabled: vi.fn((id: string, defaultEnabled = true) =>
      enabledByRecipe.get(id) ?? defaultEnabled),
    setEnabled: vi.fn((id: string, enabled: boolean) => {
      enabledByRecipe.set(id, enabled);
    }),
    listDisabled: vi.fn(() => [...enabledByRecipe]
      .filter(([, enabled]) => !enabled)
      .map(([id]) => id)),
    getDishId: vi.fn((id: string) => dishIds.get(id) ?? null),
    setDishId: vi.fn((
      id: string,
      dish_id: string | null,
      defaultEnabled = true,
    ) => {
      dishIds.set(id, dish_id);
      if (!enabledByRecipe.has(id)) enabledByRecipe.set(id, defaultEnabled);
    }),
  } satisfies AutoRunSettingsStore;
};

const makeCircuitStore = () => {
  const rows = new Map<string, CircuitBreakerState>();
  return {
    rows,
    store: {
      list: vi.fn(() => [...rows.values()]),
      get: vi.fn((id: string) => rows.get(id) ?? null),
      set: vi.fn((row: CircuitBreakerState) => {
        rows.set(row.recipe_id, row);
      }),
      clear: vi.fn((id: string) => {
        rows.delete(id);
      }),
    } satisfies CircuitBreakerStore,
  };
};

const makeHandle = (roster = new Map<string, AutoRunEntry>()) => ({
  roster,
  refreshRoster: vi.fn(async () => {}),
  resetCircuit: vi.fn(),
} as unknown as ServerAutoRunHandle);

const makeDeps = (
  rows: StoredRecipe[],
  overrides: Partial<AutoRunRpcDeps> = {},
): AutoRunRpcDeps => {
  const circuit = makeCircuitStore();
  const handle = makeHandle();
  return {
    recipeStore: {
      listStored: vi.fn(() => rows),
    } as unknown as AutoRunRpcDeps['recipeStore'],
    settingsStore: makeSettingsStore(),
    circuitStore: circuit.store,
    getHandle: vi.fn(() => handle),
    eventBus: { emit: vi.fn() } as unknown as AutoRunRpcDeps['eventBus'],
    ...overrides,
  };
};

describe('auto-run rpc handlers', () => {
  it('lists merged definitional, settings, persisted circuit, and live roster state', () => {
    const unnamed = makeRecipe('unnamed', { interval_ms: 2_000, dynamic: true });
    delete (unnamed as { metadata?: unknown }).metadata;
    const manual = makeRecipe('manual');
    delete (manual as { auto_run?: unknown }).auto_run;
    const disabled = new Set(['disabled']);
    const settingsStore = makeSettingsStore(disabled);
    const { rows: circuitRows, store: circuitStore } = makeCircuitStore();
    circuitRows.set('disabled', {
      recipe_id: 'disabled',
      consecutive_failures: 3,
      auto_disabled: true,
      last_failure_at: 11,
      last_failure_reason: 'persisted',
    });
    circuitRows.set('live-tripped', {
      recipe_id: 'live-tripped',
      consecutive_failures: 2,
      auto_disabled: false,
      last_failure_at: 22,
      last_failure_reason: 'stored reason',
    });
    const handle = makeHandle(new Map([
      ['live-tripped', {
        recipe_id: 'live-tripped',
        publisher_id: 'publisher',
        interval_ms: 1_000,
        dynamic: false,
        next_run_at: 100,
        last_started_at: 90,
        last_finished_at: 95,
        consecutive_failures: 9,
        auto_disabled: true,
        process_id: 'p-live',
      }],
    ]));
    const deps = makeDeps([
      storedRow(makeRecipe('enabled', { interval_ms: 1_000 }, 'Enabled Recipe')),
      storedRow(makeRecipe('disabled')),
      storedRow(makeRecipe('live-tripped')),
      storedRow(unnamed),
      storedRow(manual),
      {
        ...storedRow(makeRecipe('bad-json')),
        recipe_id: 'bad-json',
        recipe_json: '{not json',
      },
    ], {
      settingsStore,
      circuitStore,
      getHandle: vi.fn(() => handle),
    });

    expect(listAutoRun(deps).entries).toEqual([
      expect.objectContaining({
        recipe_id: 'enabled',
        recipe_name: 'Enabled Recipe',
        enabled: true,
        auto_disabled: false,
        consecutive_failures: 0,
        last_failure_at: null,
        last_failure_reason: null,
        next_run_at: null,
        last_started_at: null,
        last_finished_at: null,
      }),
      expect.objectContaining({
        recipe_id: 'disabled',
        enabled: false,
        auto_disabled: true,
        consecutive_failures: 3,
        last_failure_at: 11,
        last_failure_reason: 'persisted',
      }),
      expect.objectContaining({
        recipe_id: 'live-tripped',
        auto_disabled: true,
        consecutive_failures: 9,
        last_failure_at: 22,
        last_failure_reason: 'stored reason',
        next_run_at: 100,
        last_started_at: 90,
        last_finished_at: 95,
      }),
      expect.objectContaining({
        recipe_id: 'unnamed',
        recipe_name: null,
        interval_ms: 2_000,
        dynamic: true,
      }),
    ]);
  });

  it('uses null live fields when the scheduler handle is unavailable or missing an entry', () => {
    const deps = makeDeps([
      storedRow(makeRecipe('r1')),
      storedRow(makeRecipe('r2')),
    ], {
      getHandle: vi.fn(() => undefined),
    });

    expect(listAutoRun(deps).entries).toEqual([
      expect.objectContaining({
        recipe_id: 'r1',
        next_run_at: null,
        last_started_at: null,
        last_finished_at: null,
      }),
      expect.objectContaining({
        recipe_id: 'r2',
        next_run_at: null,
        last_started_at: null,
        last_finished_at: null,
      }),
    ]);
  });

  it('lists a default-disabled definition as paused until explicit owner enable', () => {
    const deps = makeDeps([
      storedRow(makeRecipe('owner-armed', {
        interval_ms: 900_000,
        default_enabled: false,
      })),
    ]);

    expect(listAutoRun(deps).entries).toEqual([
      expect.objectContaining({
        recipe_id: 'owner-armed',
        enabled: false,
        next_run_at: null,
      }),
    ]);
  });

  it.each([
    [{}, 'recipe_id is required'],
    [{ recipe_id: 123, enabled: true }, 'recipe_id is required'],
    [{ recipe_id: 'r', enabled: 'yes' }, 'enabled must be a boolean'],
  ])('rejects invalid update body %#', async (body, message) => {
    const deps = makeDeps([storedRow(makeRecipe('r'))]);

    await expect(updateAutoRun(deps, body)).rejects.toMatchObject({
      code: 'bad_request',
      message,
    });
  });

  it('rejects unknown and non-auto-run recipes', async () => {
    const manual = makeRecipe('manual');
    delete (manual as { auto_run?: unknown }).auto_run;
    const deps = makeDeps([storedRow(manual)]);

    await expect(updateAutoRun(deps, { recipe_id: 'missing', enabled: true }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(updateAutoRun(deps, { recipe_id: 'manual', enabled: true }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('persists disable, refreshes the roster, emits a rule change, and leaves circuit state intact', async () => {
    const handle = makeHandle();
    const settingsStore = makeSettingsStore();
    const { store: circuitStore } = makeCircuitStore();
    const eventBus = { emit: vi.fn() };
    const deps = makeDeps([storedRow(makeRecipe('r'))], {
      settingsStore,
      circuitStore,
      getHandle: vi.fn(() => handle),
      eventBus: eventBus as unknown as AutoRunRpcDeps['eventBus'],
    });

    await updateAutoRun(deps, { recipe_id: 'r', enabled: false });

    expect(settingsStore.setEnabled).toHaveBeenCalledWith('r', false);
    expect(handle.refreshRoster).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledWith({
      kind: 'automation_rule_changed',
      mechanism: 'auto_run',
    });
    expect(circuitStore.clear).not.toHaveBeenCalled();
  });

  it('clears persisted circuit state before roster refresh and resets a tripped live circuit', async () => {
    const calls: string[] = [];
    const handle = makeHandle(new Map([
      ['r', {
        recipe_id: 'r',
        publisher_id: 'publisher',
        interval_ms: 1_000,
        dynamic: false,
        next_run_at: 0,
        consecutive_failures: 1,
        auto_disabled: true,
        process_id: 'p',
      }],
    ]));
    handle.refreshRoster = vi.fn(async () => {
      calls.push('refresh');
    });
    handle.resetCircuit = vi.fn(() => {
      calls.push('reset');
    });
    const { store: circuitStore } = makeCircuitStore();
    circuitStore.clear = vi.fn((id: string) => {
      calls.push(`clear:${id}`);
    });
    const deps = makeDeps([storedRow(makeRecipe('r'))], {
      circuitStore,
      getHandle: vi.fn(() => handle),
    });

    await updateAutoRun(deps, { recipe_id: 'r', enabled: true });

    expect(circuitStore.clear).toHaveBeenCalledWith('r');
    expect(handle.resetCircuit).toHaveBeenCalledWith('r');
    expect(calls).toEqual(['clear:r', 'reset', 'refresh']);
  });

  it('resets a tripped persisted circuit even when the live roster is healthy', async () => {
    const handle = makeHandle(new Map([
      ['r', {
        recipe_id: 'r',
        publisher_id: 'publisher',
        interval_ms: 1_000,
        dynamic: false,
        next_run_at: 0,
        consecutive_failures: 0,
        auto_disabled: false,
        process_id: 'p',
      }],
    ]));
    const { rows: circuitRows, store: circuitStore } = makeCircuitStore();
    circuitRows.set('r', {
      recipe_id: 'r',
      consecutive_failures: 3,
      auto_disabled: true,
    });
    const deps = makeDeps([storedRow(makeRecipe('r'))], {
      circuitStore,
      getHandle: vi.fn(() => handle),
    });

    await updateAutoRun(deps, { recipe_id: 'r', enabled: true });

    expect(circuitStore.clear).toHaveBeenCalledWith('r');
    expect(handle.resetCircuit).toHaveBeenCalledWith('r');
  });

  it('clears but does not reset a healthy enabled recipe', async () => {
    const handle = makeHandle();
    const { store: circuitStore } = makeCircuitStore();
    const deps = makeDeps([storedRow(makeRecipe('r'))], {
      circuitStore,
      getHandle: vi.fn(() => handle),
    });

    await updateAutoRun(deps, { recipe_id: 'r', enabled: true });

    expect(circuitStore.clear).toHaveBeenCalledWith('r');
    expect(handle.resetCircuit).not.toHaveBeenCalled();
  });

  it('persists and returns an entry when enabling before the scheduler handle exists', async () => {
    const settingsStore = makeSettingsStore();
    const deps = makeDeps([storedRow(makeRecipe('r'))], {
      settingsStore,
      getHandle: vi.fn(() => undefined),
    });

    await expect(updateAutoRun(deps, { recipe_id: 'r', enabled: true }))
      .resolves.toEqual({
        entry: expect.objectContaining({
          recipe_id: 'r',
          enabled: true,
        }),
      });
    expect(settingsStore.setEnabled).toHaveBeenCalledWith('r', true);
  });

  it('only creates a handler slice when dependencies are available', () => {
    expect(makeAutoRunHandlers(undefined)).toBeUndefined();
    expect(makeAutoRunHandlers(makeDeps([]))?.methods).toEqual([
      'auto_run.list',
      'auto_run.update',
    ]);
  });
});

describe('auto-run config — managed immutable config dish (D-179)', () => {
  const makeConfigDeps = (
    recipe_id = 'r',
    autoRun: RecipeDefinition['auto_run'] = { interval_ms: 1_000 },
  ) => {
    const db = new Database(':memory:');
    const dishStore = createDishStore(db);
    const dishContextStore = createDishContextStore(db);
    const deps = makeDeps([storedRow(makeRecipe(recipe_id, autoRun))], {
      dishStore,
      dishContextStore,
    });
    return { db, dishStore, dishContextStore, deps };
  };

  it('mints a managed config dish on first config + returns its overlay', async () => {
    const { deps, dishStore } = makeConfigDeps();
    const { entry } = await updateAutoRun(deps, {
      recipe_id: 'r',
      config_overlay: { threshold: 30 },
    });
    const dishId = deps.settingsStore.getDishId('r');
    expect(dishId).not.toBeNull();
    expect(dishStore.get(dishId!)).toMatchObject({
      recipe_id: 'r',
      config_overlay: { threshold: 30 },
      is_default: false,
      enabled: true,
      managed_by_auto_run: 'r',
    });
    expect(entry.config_overlay).toEqual({ threshold: 30 });
  });

  it('a config change mints a NEW dish + dissolves the prior (+ its snapshot)', async () => {
    const { deps, dishStore, dishContextStore } = makeConfigDeps();
    await updateAutoRun(deps, { recipe_id: 'r', config_overlay: { threshold: 30 } });
    const first = deps.settingsStore.getDishId('r')!;
    dishContextStore.set(first, { step_a: 1 });

    await updateAutoRun(deps, { recipe_id: 'r', config_overlay: { threshold: 50 } });
    const second = deps.settingsStore.getDishId('r')!;
    expect(second).not.toBe(first); // one dish_id = one config
    expect(dishStore.get(first)).toBeNull(); // prior dissolved, never mutated
    expect(dishContextStore.get(first)).toBeNull(); // + its continuity snapshot
    expect(dishStore.get(second)).toMatchObject({ config_overlay: { threshold: 50 } });
  });

  it('an identical overlay is a no-op — no churn (same dish_id, key order aside)', async () => {
    const { deps, dishStore } = makeConfigDeps();
    await updateAutoRun(deps, { recipe_id: 'r', config_overlay: { a: 1, b: 2 } });
    const first = deps.settingsStore.getDishId('r')!;
    await updateAutoRun(deps, { recipe_id: 'r', config_overlay: { b: 2, a: 1 } });
    expect(deps.settingsStore.getDishId('r')).toBe(first);
    expect(dishStore.list()).toHaveLength(1);
  });

  it('an empty overlay clears config (dish_id null, prior dissolved)', async () => {
    const { deps, dishStore } = makeConfigDeps();
    await updateAutoRun(deps, { recipe_id: 'r', config_overlay: { threshold: 30 } });
    const first = deps.settingsStore.getDishId('r')!;
    const { entry } = await updateAutoRun(deps, { recipe_id: 'r', config_overlay: {} });
    expect(deps.settingsStore.getDishId('r')).toBeNull();
    expect(dishStore.get(first)).toBeNull();
    expect(entry.config_overlay).toEqual({});
  });

  it('first resume of a default-disabled recipe configures then explicitly enables it', async () => {
    const { deps } = makeConfigDeps('owner-armed', {
      interval_ms: 900_000,
      default_enabled: false,
    });
    const { entry } = await updateAutoRun(deps, {
      recipe_id: 'owner-armed',
      enabled: true,
      config_overlay: { stripe: 'stripe-primary' },
    });
    expect(deps.settingsStore.setDishId).toHaveBeenCalledWith(
      'owner-armed',
      expect.any(String),
      false,
    );
    expect(deps.settingsStore.setEnabled).toHaveBeenCalledWith('owner-armed', true);
    expect(entry.enabled).toBe(true);
    expect(entry.config_overlay).toEqual({ stripe: 'stripe-primary' });
  });

  it('a config-only edit omits enabled (no enable-state churn)', async () => {
    const { deps } = makeConfigDeps();
    await updateAutoRun(deps, { recipe_id: 'r', config_overlay: { threshold: 30 } });
    expect(deps.settingsStore.setEnabled).not.toHaveBeenCalled();
  });

  it('configuring a default-disabled recipe does not arm it implicitly', async () => {
    const { deps } = makeConfigDeps('owner-armed', {
      interval_ms: 900_000,
      default_enabled: false,
    });
    const { entry } = await updateAutoRun(deps, {
      recipe_id: 'owner-armed',
      config_overlay: { stripe: 'stripe-primary' },
    });

    expect(deps.settingsStore.setDishId).toHaveBeenCalledWith(
      'owner-armed',
      expect.any(String),
      false,
    );
    expect(deps.settingsStore.setEnabled).not.toHaveBeenCalled();
    expect(entry.enabled).toBe(false);
  });

  it('rejects a non-object config_overlay', async () => {
    const { deps } = makeConfigDeps();
    await expect(updateAutoRun(deps, {
      recipe_id: 'r',
      config_overlay: 'nope',
    })).rejects.toThrow(/config_overlay must be an object/);
  });

  it('a NESTED value re-sent in different key order is a no-op (deep canonical, no churn)', async () => {
    const { deps, dishStore } = makeConfigDeps();
    await updateAutoRun(deps, { recipe_id: 'r', config_overlay: { filter: { a: 1, b: 2 } } });
    const first = deps.settingsStore.getDishId('r')!;
    await updateAutoRun(deps, { recipe_id: 'r', config_overlay: { filter: { b: 2, a: 1 } } });
    expect(deps.settingsStore.getDishId('r')).toBe(first);
    expect(dishStore.list()).toHaveLength(1);
  });

  it('an empty overlay clears a STALE dish pointer (dish deleted out-of-band)', async () => {
    const { deps, dishStore } = makeConfigDeps();
    await updateAutoRun(deps, { recipe_id: 'r', config_overlay: { threshold: 30 } });
    const stale = deps.settingsStore.getDishId('r')!;
    // Simulate out-of-band deletion (e.g. uninstall) leaving the pointer
    // dangling; an empty clear must still drop it or fires dispatch as a
    // dead dish.
    dishStore.delete(stale);
    await updateAutoRun(deps, { recipe_id: 'r', config_overlay: {} });
    expect(deps.settingsStore.getDishId('r')).toBeNull();
  });
});
