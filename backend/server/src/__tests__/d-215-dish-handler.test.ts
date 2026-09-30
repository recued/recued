/** D-215 — the dish rpc handlers: delete, update, the list's last-outcome
 *  cell, and the history that outlives a dish.
 *
 *  D-215 slice 0 guarded a MANAGED dish (one an automation row minted) from
 *  the rpc. D-319 retired managed dishes — a schedule, trigger or auto-run
 *  timer belongs to a dish and owns none — so every dish is the owner's to
 *  rename, re-set, switch and delete, and the guard went with them.
 *
 *  Spec: D-215 § 6, D-319 § 3.4.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Dish } from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import { createDishStore, type DishStore } from '../dish-store.js';
import { createDishContextStore } from '../dish-context-store.js';
import {
  deleteDish,
  dishHistory,
  listDishes,
  updateDish,
  type DishHandlerDeps,
} from '../dish-handler.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const makeDeps = (): DishHandlerDeps & { store: DishStore } => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return {
    store: createDishStore(db),
    contextStore: createDishContextStore(db),
    now: () => 5_000,
  };
};

const dish = (overrides: Partial<Dish> = {}): Dish => ({
  dish_id: 'dsh_guard1',
  recipe_id: 'recipe-a',
  publisher_id: 'local',
  name: 'queued post',
  is_default: false,
  config_overlay: { text: 'hello' },
  enabled: true,
  created_at: 1_000,
  ...overrides,
});

describe('D-319 — every dish is the owner’s: no dish is guarded', () => {
  it('deletes a dish and clears its continuity snapshot', () => {
    const deps = makeDeps();
    deps.store.set(dish());
    deps.contextStore!.set('dsh_guard1', { some_step: 'prior' } as never);
    expect(deps.contextStore!.get('dsh_guard1')).not.toBeNull();

    expect(deleteDish(deps, 'dsh_guard1')).toEqual({ deleted: true });
    expect(deps.store.get('dsh_guard1')).toBeNull();
    expect(deps.contextStore!.get('dsh_guard1')).toBeNull();
  });

  it('reports a missing dish as not_found', () => {
    expect(() => deleteDish(makeDeps(), 'dsh_nope')).toThrow(/not found/);
    expect(() => updateDish(makeDeps(), 'dsh_nope', { enabled: false })).toThrow(/not found/);
  });

  it('changes a dish’s settings and switch in place', () => {
    const deps = makeDeps();
    deps.store.set(dish());
    const { dish: updated } = updateDish(deps, 'dsh_guard1', {
      config_overlay: { text: 'edited' },
      enabled: false,
    });
    expect(updated.config_overlay).toEqual({ text: 'edited' });
    expect(updated.enabled).toBe(false);
    expect(deps.store.get('dsh_guard1')!.config_overlay).toEqual({ text: 'edited' });
  });

  it('lists every dish of a recipe', async () => {
    const deps = makeDeps();
    deps.store.set(dish());
    deps.store.set(dish({ dish_id: 'dsh_guard2', name: 'assigned' }));
    expect((await listDishes(deps, { recipe_id: 'recipe-a' })).dishes).toHaveLength(2);
  });
});

describe('D-215 slice 3 — dishes.list joins the last-outcome cell', () => {
  const withAudit = (): DishHandlerDeps & { store: DishStore; auditLog: AuditLogStore } => {
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    return {
      store: createDishStore(db),
      contextStore: createDishContextStore(db),
      auditLog: createAuditLogStore(
        createInMemoryCollection<AuditEntry>(),
        createInMemoryCollection<ActivityEntry>(),
      ),
      now: () => 5_000,
    };
  };

  const run = (over: Partial<AuditEntry>): AuditEntry => ({
    run_id: 'r1',
    recipe_id: 'recipe-a',
    recipe_hash: 'h',
    started_at: 1_000,
    finished_at: 1_100,
    duration_ms: 100,
    commit_status: 'succeeded',
    config_snapshot: {},
    errors: [],
    trigger_url: null,
    trigger_source: null,
    instance_id: null,
    ...over,
  });

  it('returns the NEWEST run per dish, projected to the cell shape', async () => {
    const deps = withAudit();
    deps.store.set(dish({ dish_id: 'dsh_a' }));
    await deps.auditLog.append(run({ run_id: 'old', dish_id: 'dsh_a', started_at: 1_000 }));
    await deps.auditLog.append(run({
      run_id: 'new', dish_id: 'dsh_a', started_at: 9_000, commit_status: 'failed',
    }));

    const { last_runs } = await listDishes(deps, {});
    expect(last_runs?.['dsh_a']).toEqual({
      run_id: 'new', started_at: 9_000, commit_status: 'failed',
    });
    // ⚠ the projection is deliberately NOT the whole audit row — a
    // config_snapshot on every list row is exactly what it avoids.
    expect(Object.keys(last_runs!['dsh_a']!).sort())
      .toEqual(['commit_status', 'run_id', 'started_at']);
  });

  it('OMITS a never-run dish rather than reporting a null status', async () => {
    const deps = withAudit();
    deps.store.set(dish({ dish_id: 'dsh_fresh' }));
    const { dishes, last_runs } = await listDishes(deps, {});
    expect(dishes).toHaveLength(1);
    expect(last_runs?.['dsh_fresh']).toBeUndefined();
  });

  it('omits the map entirely when no audit store is wired', async () => {
    const deps = makeDeps();
    deps.store.set(dish());
    const res = await listDishes(deps, {});
    expect(res.dishes).toHaveLength(1);
    expect(res.last_runs).toBeUndefined();
  });

  it('scopes the join to the LISTED page, not the whole log', async () => {
    // A recipe_id filter must not leak another recipe's dish into the map.
    const deps = withAudit();
    deps.store.set(dish({ dish_id: 'dsh_a', recipe_id: 'recipe-a' }));
    deps.store.set(dish({ dish_id: 'dsh_b', recipe_id: 'recipe-b' }));
    await deps.auditLog.append(run({ run_id: 'a1', dish_id: 'dsh_a' }));
    await deps.auditLog.append(run({ run_id: 'b1', dish_id: 'dsh_b' }));

    const { last_runs } = await listDishes(deps, { recipe_id: 'recipe-a' });
    expect(Object.keys(last_runs ?? {})).toEqual(['dsh_a']);
  });
});

describe('D-215 slice 5 — dishes.history outlives the dish', () => {
  const withAudit = (): DishHandlerDeps & { store: DishStore; auditLog: AuditLogStore } => {
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    return {
      store: createDishStore(db),
      contextStore: createDishContextStore(db),
      auditLog: createAuditLogStore(
        createInMemoryCollection<AuditEntry>(),
        createInMemoryCollection<ActivityEntry>(),
      ),
      now: () => 5_000,
    };
  };
  const run = (over: Partial<AuditEntry>): AuditEntry => ({
    run_id: 'r1', recipe_id: 'recipe-a', recipe_hash: 'h',
    started_at: 1_000, finished_at: 1_100, duration_ms: 100,
    commit_status: 'succeeded', config_snapshot: { channel: '#ops' },
    errors: [], trigger_url: null, trigger_source: null, instance_id: null,
    ...over,
  });

  it('⛔ answers for a RETIRED dish — no dish row is consulted at all', async () => {
    // The whole point. A dish the owner removed keeps its history; if this
    // validated the id against the dish store, the case it exists for would
    // be the one case it failed.
    const deps = withAudit();
    await deps.auditLog.append(run({ run_id: 'gone-1', dish_id: 'dsh_retired' }));
    expect(deps.store.get('dsh_retired')).toBeNull();

    const { runs } = await dishHistory(deps, { dish_id: 'dsh_retired' });
    expect(runs.map((r) => r.run_id)).toEqual(['gone-1']);
  });

  it('D-319 — carries the settings each run ran with, and nothing else of the audit row', async () => {
    // A dish's settings are edited in place: what a PAST run used is its
    // `config_snapshot`, never the dish's settings now.
    const deps = withAudit();
    await deps.auditLog.append(run({
      run_id: 'r9', dish_id: 'dsh_a', trigger_source: 'schedule',
      commit_status: 'failed', errors: [{ code: 'BOOM', message: 'it broke' } as never],
    }));
    await deps.auditLog.append(run({ run_id: 'r10', dish_id: 'dsh_a', started_at: 2_000, config_snapshot: undefined as never }));
    const { runs } = await dishHistory(deps, { dish_id: 'dsh_a' });
    const r9 = runs.find((r) => r.run_id === 'r9')!;
    expect(Object.keys(r9).sort()).toEqual(
      ['commit_status', 'config', 'duration_ms', 'error', 'run_id', 'started_at', 'trigger_source'],
    );
    expect(r9.error).toBe('it broke');
    expect(r9.config).toEqual({ channel: '#ops' });
    // A run that recorded none says so, rather than borrowing the dish's.
    expect(runs.find((r) => r.run_id === 'r10')!.config).toBeNull();
  });

  it('newest first, and honours an explicit limit', async () => {
    const deps = withAudit();
    await deps.auditLog.append(run({ run_id: 'old', dish_id: 'dsh_a', started_at: 1_000 }));
    await deps.auditLog.append(run({ run_id: 'new', dish_id: 'dsh_a', started_at: 9_000 }));
    expect((await dishHistory(deps, { dish_id: 'dsh_a' })).runs.map((r) => r.run_id))
      .toEqual(['new', 'old']);
    expect((await dishHistory(deps, { dish_id: 'dsh_a', limit: 1 })).runs.map((r) => r.run_id))
      .toEqual(['new']);
  });

  it('an unknown dish is an EMPTY list, not an error', async () => {
    const deps = withAudit();
    await expect(dishHistory(deps, { dish_id: 'dsh_never' })).resolves.toEqual({ runs: [] });
  });

  it('a missing dish_id is bad_request', async () => {
    await expect(dishHistory(withAudit(), {})).rejects.toThrow(/dish_id is required/);
  });

  it('degrades to empty when no audit store is wired', async () => {
    const deps = makeDeps();
    await expect(dishHistory(deps, { dish_id: 'dsh_a' })).resolves.toEqual({ runs: [] });
  });
});
