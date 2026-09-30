/** D-259 §6.1 — a canonical logged run is promotable only by re-reading its
 * authoritative terminal audit anchor. */

import { describe, expect, it } from 'vitest';

import type { Dish } from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type AuditEntry,
} from '@recued/storage';

import type { DishStore } from '../dish-store.js';
import { createDishFromRun, makeDishHandlers } from '../dish-handler.js';

const anchor = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: 'run-promote-1',
  recipe_id: 'recipe-from-anchor',
  recipe_hash: 'hash-1',
  started_at: 10,
  finished_at: 20,
  duration_ms: 10,
  commit_status: 'succeeded',
  config_snapshot: { account: 'acct-live', threshold: 7 },
  trigger_source: 'chat',
  ...over,
  instance_id: over.instance_id ?? null,
});

const memoryDishStore = (): DishStore => {
  const rows = new Map<string, Dish>();
  return {
    list: () => [...rows.values()],
    listByRecipe: (recipe_id) => [...rows.values()].filter((d) => d.recipe_id === recipe_id),
    listByGroup: (group_id) => [...rows.values()].filter((d) => d.group_id === group_id),
    get: (dish_id) => rows.get(dish_id) ?? null,
    getDefault: (recipe_id) =>
      [...rows.values()].find((d) => d.recipe_id === recipe_id && d.is_default) ?? null,
    set: (dish) => { rows.set(dish.dish_id, structuredClone(dish)); },
    setMain: (dish_id) => {
      const target = rows.get(dish_id);
      if (target === undefined) return null;
      for (const [id, row] of rows) {
        if (row.recipe_id === target.recipe_id && row.is_default) rows.set(id, { ...row, is_default: false });
      }
      const main = { ...target, is_default: true };
      rows.set(dish_id, main);
      return main;
    },
    delete: (dish_id) => rows.delete(dish_id),
    detachGroup: (group_id) => {
      const detached: string[] = [];
      for (const [id, row] of rows) {
        if (row.group_id !== group_id) continue;
        const next = { ...row };
        delete next.group_id;
        rows.set(id, next);
        detached.push(id);
      }
      return detached;
    },
  };
};

describe('D-259 run-to-dish promotion', () => {
  it('reads recipe/config from a succeeded anchor and always mints a new standing dish — the first is main (D-319)', async () => {
    const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>());
    await auditLog.append(anchor());
    const store = memoryDishStore();

    const first = await createDishFromRun({ store, auditLog, now: () => 100 }, {
      run_id: 'run-promote-1',
      name: 'Q3 reconciliation',
    });
    const second = await createDishFromRun({ store, auditLog, now: () => 101 }, {
      run_id: 'run-promote-1',
    });

    expect(first.dish).toMatchObject({
      recipe_id: 'recipe-from-anchor',
      name: 'Q3 reconciliation',
      config_overlay: { account: 'acct-live', threshold: 7 },
      is_default: true,
      enabled: true,
    });
    expect(second.dish.dish_id).not.toBe(first.dish.dish_id);
    expect(second.dish.is_default).toBe(false);
    expect(store.list()).toHaveLength(2);
  });

  it('refuses missing, failed, and held anchors', async () => {
    const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>());
    await auditLog.append(anchor({ run_id: 'failed', commit_status: 'failed' }));
    await auditLog.append(anchor({ run_id: 'held', commit_status: 'awaiting_approval' }));
    const deps = { store: memoryDishStore(), auditLog };

    await expect(createDishFromRun(deps, { run_id: 'missing' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(createDishFromRun(deps, { run_id: 'failed' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(createDishFromRun(deps, { run_id: 'held' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('refuses to clone a run that already belongs to a standing dish', async () => {
    const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>());
    await auditLog.append(anchor({ dish_id: 'dsh_existing' }));

    await expect(createDishFromRun({ store: memoryDishStore(), auditLog }, {
      run_id: 'run-promote-1',
    })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining("standing dish 'dsh_existing'"),
    });
  });

  it('is exposed only on the owner RPC slice, not the MCP tool catalog', () => {
    const slice = makeDishHandlers({ store: memoryDishStore() })!;
    expect(slice.methods).toContain('dishes.createFromRun');
    expect(slice.handlers).toHaveProperty('dishes.createFromRun');
  });
});
