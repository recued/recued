/** D-215 slice 0 — the managed-dish guard.
 *
 *  A dish minted BY a schedule / trigger / auto-run row carries a
 *  `managed_by_*` marker and its lifecycle belongs to that row. Before
 *  this slice `dishes.delete` deleted it unconditionally, which orphans
 *  the owning schedule: the row survives pointing at a vanished dish and
 *  `scheduler.ts`'s fire-time gate then skips silently, forever, with the
 *  schedule still armed. Unreachable while nothing called the rpc — the
 *  D-215 dish surface makes it reachable, so the guard lands first.
 *
 *  The load-bearing test here is the LAST one: the guard must sit on the
 *  HANDLER, never on `DishStore`. Internal lifecycle code writes managed
 *  dishes through the store on purpose (trigger enable/disable flips
 *  `enabled`, auto-run versioning writes replacement rows,
 *  `schedule-handler` dissolves on delete) — a store-level guard would
 *  break all three, and every other assertion in this file would still
 *  pass while it did.
 *
 *  Spec: D-215 § 6.
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

/** The three markers, each with the owner value its contract defines —
 *  note `managed_by_auto_run` carries the owning RECIPE id, not a row id. */
const MANAGED_CASES = [
  ['managed_by_schedule_id', { managed_by_schedule_id: 'sch_1' }, 'schedule', 'sch_1'],
  ['managed_by_trigger_id', { managed_by_trigger_id: 'trg_1' }, 'trigger', 'trg_1'],
  ['managed_by_auto_run', { managed_by_auto_run: 'recipe-a' }, 'auto-run', 'recipe-a'],
] as const;

describe('D-215 slice 0 — dishes.delete managed guard', () => {
  it.each(MANAGED_CASES)(
    'refuses to delete a dish managed by %s, naming the owner',
    (_marker, patch, surface, owner) => {
      const deps = makeDeps();
      deps.store.set(dish(patch));

      expect(() => deleteDish(deps, 'dsh_guard1')).toThrow(
        new RegExp(`managed by its ${surface} '${owner}'`),
      );
      // The refusal must be non-destructive — the row survives.
      expect(deps.store.get('dsh_guard1')).not.toBeNull();
    },
  );

  it('refuses with a `conflict` rpc code, not a generic failure', () => {
    const deps = makeDeps();
    deps.store.set(dish({ managed_by_schedule_id: 'sch_1' }));
    try {
      deleteDish(deps, 'dsh_guard1');
      throw new Error('expected the guard to throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('conflict');
      expect((e as { status?: number }).status).toBe(409);
    }
  });

  it('still deletes a user-assigned dish and clears its continuity snapshot', () => {
    const deps = makeDeps();
    deps.store.set(dish());
    deps.contextStore!.set('dsh_guard1', { some_step: 'prior' } as never);
    expect(deps.contextStore!.get('dsh_guard1')).not.toBeNull();

    expect(deleteDish(deps, 'dsh_guard1')).toEqual({ deleted: true });
    expect(deps.store.get('dsh_guard1')).toBeNull();
    expect(deps.contextStore!.get('dsh_guard1')).toBeNull();
  });

  it('reports a missing dish as not_found, never as a conflict', () => {
    expect(() => deleteDish(makeDeps(), 'dsh_nope')).toThrow(/not found/);
  });
});

describe('D-215 slice 0 — dishes.update managed guard', () => {
  it.each(['config_overlay', 'enabled', 'group_id'] as const)(
    'refuses to set %s on a managed dish',
    (field) => {
      const deps = makeDeps();
      deps.store.set(dish({ managed_by_schedule_id: 'sch_1' }));
      const value =
        field === 'config_overlay' ? { text: 'edited' } : field === 'enabled' ? false : 'dgrp_1';

      expect(() => updateDish(deps, 'dsh_guard1', { [field]: value })).toThrow(
        new RegExp(`must be changed on that schedule row`),
      );
      // Unchanged on disk — a refused update writes nothing.
      const after = deps.store.get('dsh_guard1')!;
      expect(after.config_overlay).toEqual({ text: 'hello' });
      expect(after.enabled).toBe(true);
      expect(after.group_id).toBeUndefined();
    },
  );

  it('names every frozen field the caller attempted, not just the first', () => {
    const deps = makeDeps();
    deps.store.set(dish({ managed_by_trigger_id: 'trg_1' }));
    expect(() =>
      updateDish(deps, 'dsh_guard1', { config_overlay: {}, enabled: false }),
    ).toThrow(/config_overlay, enabled/);
  });

  it('ALLOWS renaming a managed dish — a label changes no resolution', () => {
    const deps = makeDeps();
    deps.store.set(dish({ managed_by_schedule_id: 'sch_1' }));

    const { dish: renamed } = updateDish(deps, 'dsh_guard1', { name: 'Tuesday post' });
    expect(renamed.name).toBe('Tuesday post');
    expect(renamed.managed_by_schedule_id).toBe('sch_1');
    expect(deps.store.get('dsh_guard1')!.name).toBe('Tuesday post');
  });

  it('ignores an explicit-undefined frozen field rather than refusing', () => {
    // `{ config_overlay: undefined }` is what a spread of an absent optional
    // produces; it is not an attempt to write the field.
    const deps = makeDeps();
    deps.store.set(dish({ managed_by_schedule_id: 'sch_1' }));
    expect(() =>
      updateDish(deps, 'dsh_guard1', { name: 'ok', config_overlay: undefined }),
    ).not.toThrow();
  });

  it('leaves a user-assigned dish fully mutable', () => {
    const deps = makeDeps();
    deps.store.set(dish());
    const { dish: updated } = updateDish(deps, 'dsh_guard1', {
      config_overlay: { text: 'edited' },
      enabled: false,
    });
    expect(updated.config_overlay).toEqual({ text: 'edited' });
    expect(updated.enabled).toBe(false);
  });

  it('reports a missing dish as not_found before any guard runs', () => {
    expect(() => updateDish(makeDeps(), 'dsh_nope', { enabled: false })).toThrow(/not found/);
  });
});

describe('D-215 slice 0 — the guard is on the HANDLER, not the store', () => {
  it('lets internal lifecycle code still write and delete a managed dish directly', () => {
    // This is the regression that matters. `schedule-handler` dissolves a
    // managed dish on `schedules.delete`, the trigger flow flips `enabled`
    // on disable, and auto-run versioning writes replacement rows — all
    // through `DishStore`. If the guard ever migrates into the store,
    // every one of those breaks and only THIS test notices.
    const deps = makeDeps();
    const managed = dish({ managed_by_schedule_id: 'sch_1' });
    deps.store.set(managed);

    // The trigger/auto-run disable path: flip `enabled` straight on the store.
    deps.store.set({ ...managed, enabled: false });
    expect(deps.store.get('dsh_guard1')!.enabled).toBe(false);

    // The auto-run versioning path: write a replacement row.
    deps.store.set({ ...managed, config_overlay: { text: 'v2' } });
    expect(deps.store.get('dsh_guard1')!.config_overlay).toEqual({ text: 'v2' });

    // The `schedules.delete` dissolution path.
    expect(deps.store.delete('dsh_guard1')).toBe(true);
    expect(deps.store.get('dsh_guard1')).toBeNull();
  });

  it('guards only the rpc surface — listing managed dishes is untouched', async () => {
    const deps = makeDeps();
    deps.store.set(dish({ managed_by_schedule_id: 'sch_1' }));
    deps.store.set(dish({ dish_id: 'dsh_guard2', name: 'assigned' }));
    // D-215 § 3: managed dishes are VISIBLE. The guard restricts mutation,
    // never reads.
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
    commit_status: 'succeeded', config_snapshot: { secret: 'do-not-ship' },
    errors: [], trigger_url: null, trigger_source: null, instance_id: null,
    ...over,
  });

  it('⛔ answers for a RETIRED dish — no dish row is consulted at all', async () => {
    // The whole point. A one-shot retires itself on success and auto-run
    // versioning dissolves the prior dish on every config change; if this
    // validated the id against the dish store, the case it exists for
    // would be the one case it failed.
    const deps = withAudit();
    await deps.auditLog.append(run({ run_id: 'gone-1', dish_id: 'dsh_retired' }));
    expect(deps.store.get('dsh_retired')).toBeNull();

    const { runs } = await dishHistory(deps, { dish_id: 'dsh_retired' });
    expect(runs.map((r) => r.run_id)).toEqual(['gone-1']);
  });

  it('projects the row WITHOUT config_snapshot', async () => {
    const deps = withAudit();
    await deps.auditLog.append(run({
      run_id: 'r9', dish_id: 'dsh_a', trigger_source: 'schedule',
      commit_status: 'failed', errors: [{ code: 'BOOM', message: 'it broke' } as never],
    }));
    const { runs } = await dishHistory(deps, { dish_id: 'dsh_a' });
    expect(Object.keys(runs[0]!).sort()).toEqual(
      ['commit_status', 'duration_ms', 'error', 'run_id', 'started_at', 'trigger_source'],
    );
    expect(runs[0]!.error).toBe('it broke');
    expect(JSON.stringify(runs)).not.toContain('do-not-ship');
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
