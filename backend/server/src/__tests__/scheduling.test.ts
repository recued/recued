import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Schedule } from '@recued/scheduler';
import { RpcError } from '@recued/contracts';
import { createScheduleStore } from '../schedule-store.js';
import { createScheduler } from '../scheduler.js';
import {
  listSchedules, createSchedule, updateSchedule, deleteSchedule,
  type ScheduleHandlerDeps,
} from '../schedule-handler.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const mkDeps = (): { handler: ScheduleHandlerDeps; db: Database.Database } => {
  const db = new Database(':memory:');
  const store = createScheduleStore(db);
  return {
    db,
    handler: { store, instanceId: 'server-test-1' },
  };
};

describe('schedule-store', () => {
  it('round-trips a schedule', () => {
    const { handler } = mkDeps();
    const sched: Schedule = {
      schedule_id: 's1',
      recipe_id: 'r1',
      publisher_id: 'me',
      cron_expression: '*/5 * * * *',
      enabled: true,
      created_at: 100,
      last_run_at: null,
      next_run_at: null,
      last_status: null,
      last_error: null,
    };
    handler.store.set(sched);
    expect(handler.store.get('s1')).toEqual(sched);
    expect(handler.store.list()).toHaveLength(1);
  });

  it('listByRecipe filters correctly', () => {
    const { handler } = mkDeps();
    for (const i of [1, 2, 3]) {
      handler.store.set({
        schedule_id: `s${i}`,
        recipe_id: i === 2 ? 'other' : 'r1',
        publisher_id: 'me',
        cron_expression: '0 9 * * *',
        enabled: true, created_at: 0, last_run_at: null, next_run_at: null,
        last_status: null, last_error: null,
      });
    }
    expect(handler.store.listByRecipe('r1')).toHaveLength(2);
    expect(handler.store.listByRecipe('other')).toHaveLength(1);
  });

  it('updateRun patches run-status fields without touching cron/recipe', () => {
    const { handler } = mkDeps();
    handler.store.set({
      schedule_id: 's1', recipe_id: 'r1', publisher_id: 'me',
      cron_expression: '0 9 * * *', enabled: true, created_at: 0,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
    });
    handler.store.updateRun('s1', { last_run_at: 999, last_status: 'success' });
    const after = handler.store.get('s1')!;
    expect(after.last_run_at).toBe(999);
    expect(after.last_status).toBe('success');
    expect(after.cron_expression).toBe('0 9 * * *');
  });

  it('updateRun can disable a one-shot schedule after terminal attempt', () => {
    const { handler } = mkDeps();
    handler.store.set({
      schedule_id: 's1', recipe_id: 'r1', publisher_id: 'me',
      mode: 'one_shot', cron_expression: '0 9 14 4 *', run_at: 123,
      enabled: true, created_at: 0,
      last_run_at: null, next_run_at: 123, last_status: null, last_error: null,
    });
    handler.store.updateRun('s1', {
      last_run_at: 123,
      next_run_at: null,
      last_status: 'success',
      last_error: null,
      enabled: false,
    });
    const after = handler.store.get('s1')!;
    expect(after.enabled).toBe(false);
    expect(after.next_run_at).toBeNull();
    expect(after.mode).toBe('one_shot');
  });

  it('delete returns true on hit, false on miss', () => {
    const { handler } = mkDeps();
    handler.store.set({
      schedule_id: 's1', recipe_id: 'r1', publisher_id: 'me',
      cron_expression: '0 9 * * *', enabled: true, created_at: 0,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
    });
    expect(handler.store.delete('s1')).toBe(true);
    expect(handler.store.delete('nonexistent')).toBe(false);
  });
});

describe('schedule-handler operations (used by ws rpc)', () => {
  let deps: ScheduleHandlerDeps;

  beforeEach(() => {
    deps = mkDeps().handler;
  });

  it('create generates a schedule_id and defaults', () => {
    const res = createSchedule(deps, { recipe_id: 'r1', cron_expression: '0 9 * * *' });
    expect(res.schedule.schedule_id).toMatch(/^sch_/);
    expect(res.schedule.recipe_id).toBe('r1');
    expect(res.schedule.enabled).toBe(true);
    expect(res.schedule.publisher_id).toBe('local');
    expect(res.schedule.instance_id).toBe('server-test-1');
  });

  it('create rejects missing recipe_id', () => {
    expect(() => createSchedule(deps, { cron_expression: '0 9 * * *' }))
      .toThrow(RpcError);
  });

  it('create rejects sub-floor intervals', () => {
    try {
      createSchedule(deps, { recipe_id: 'r1', cron_expression: '* * * * *' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe('invalid_cron');
    }
  });

  it('creates one-shot schedules without applying the cron floor', () => {
    const runAt = new Date(2026, 3, 14, 9, 0, 0).getTime();
    const res = createSchedule(deps, {
      recipe_id: 'r1',
      mode: 'one_shot',
      run_at: runAt,
    });
    expect(res.schedule.mode).toBe('one_shot');
    expect(res.schedule.run_at).toBe(runAt);
    expect(res.schedule.next_run_at).toBe(runAt);
    expect(res.schedule.cron_expression).toBe('0 9 14 4 *');
  });

  it('rejects schedule_recipe targets that are not installed when recipeStore is wired', () => {
    const guarded: ScheduleHandlerDeps = {
      ...deps,
      recipeStore: { get: () => null },
    };
    expect(() =>
      createSchedule(guarded, {
        recipe_id: 'missing',
        mode: 'one_shot',
        run_at: 123,
      }),
    ).toThrow(/Recipe 'missing' not found/);
  });

  it('list returns all, and filter by recipe_id works', () => {
    createSchedule(deps, { recipe_id: 'r1', cron_expression: '0 9 * * *' });
    createSchedule(deps, { recipe_id: 'r2', cron_expression: '0 10 * * *' });
    const all = listSchedules(deps, {});
    expect(all.schedules).toHaveLength(2);

    const filtered = listSchedules(deps, { recipe_id: 'r1' });
    expect(filtered.schedules).toHaveLength(1);
    expect(filtered.schedules[0].recipe_id).toBe('r1');
  });

  it('update patches cron and enabled', () => {
    const created = createSchedule(deps, { recipe_id: 'r1', cron_expression: '0 9 * * *' });
    const id = created.schedule.schedule_id;

    const patched = updateSchedule(deps, id, { enabled: false, cron_expression: '0 17 * * 5' });
    expect(patched.schedule.enabled).toBe(false);
    expect(patched.schedule.cron_expression).toBe('0 17 * * 5');
  });

  it('update on unknown id throws not_found', () => {
    try {
      updateSchedule(deps, 'missing', { enabled: false });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe('not_found');
      expect((err as RpcError).status).toBe(404);
    }
  });

  it('delete removes', () => {
    const created = createSchedule(deps, { recipe_id: 'r1', cron_expression: '0 9 * * *' });
    const id = created.schedule.schedule_id;
    const res = deleteSchedule(deps, id);
    expect(res.deleted).toBe(true);
    expect(deps.store.get(id)).toBeNull();
  });
});

describe('scheduler loop', () => {
  const mkExecuteDeps = (fired: string[]): ExecuteHandlerDeps => ({
    recipeStore: {
      get: (id: string) => ({ recipe_id: id, steps: [], version: 1 }) as any,
      size: () => 1,
    } as unknown as ExecuteHandlerDeps['recipeStore'],
    executorConfig: {
      manifests: { get: () => undefined, size: () => 0 } as any,
      vault: {},
    },
    baseVault: {},
    instanceId: 'server-test-1',
  });

  it('fires a matching schedule exactly once per minute', async () => {
    const db = new Database(':memory:');
    const store = createScheduleStore(db);
    const fired: string[] = [];

    // Tue 2026-04-14 09:00 local time
    // Build in local time so cronMatchesAt (which uses getHours/etc.) aligns
    const boundTime = new Date(2026, 3, 14, 9, 0, 0).getTime();

    store.set({
      schedule_id: 's1', recipe_id: 'test-recipe', publisher_id: 'me',
      cron_expression: '0 9 * * *', enabled: true,
      created_at: boundTime - 100_000, last_run_at: null, next_run_at: null,
      last_status: null, last_error: null,
    });

    const execDeps: ExecuteHandlerDeps = {
      recipeStore: {
        get: (id: string) => { fired.push(id); return { recipe_id: id, steps: [], version: 1 } as any; },
        size: () => 1,
      } as unknown as ExecuteHandlerDeps['recipeStore'],
      executorConfig: { manifests: { get: () => undefined, size: () => 0 } as any, vault: {} },
      baseVault: {},
      instanceId: 's',
    };

    const sched = createScheduler({
      store,
      executeDeps: execDeps,
      now: () => boundTime,
    });

    // Two ticks within the same minute — should fire once, skip second
    await sched.tick();
    await sched.tick();
    expect(fired).toEqual(['test-recipe']);

    const after = store.get('s1')!;
    expect(after.last_run_at).toBe(boundTime);
    // last_status reflects what executeRecipe returned — with stubbed deps,
    // the execute will error out downstream; we only assert that SOMETHING
    // was written (not null).
    expect(after.last_status).not.toBeNull();
    // next_run_at must be recomputed on fire so the stored value doesn't
    // drift. For "0 9 * * *" firing at 09:00, next is tomorrow 09:00.
    expect(after.next_run_at).not.toBeNull();
    expect(after.next_run_at! > boundTime).toBe(true);
    // roughly 24 hours later
    const diffMs = after.next_run_at! - boundTime;
    expect(diffMs).toBeGreaterThan(23 * 60 * 60_000);
    expect(diffMs).toBeLessThan(25 * 60 * 60_000);
  });

  it('does not fire disabled schedules', async () => {
    const db = new Database(':memory:');
    const store = createScheduleStore(db);
    // Build in local time so cronMatchesAt (which uses getHours/etc.) aligns
    const boundTime = new Date(2026, 3, 14, 9, 0, 0).getTime();

    store.set({
      schedule_id: 's1', recipe_id: 'test-recipe', publisher_id: 'me',
      cron_expression: '0 9 * * *', enabled: false,
      created_at: 0, last_run_at: null, next_run_at: null,
      last_status: null, last_error: null,
    });

    const sched = createScheduler({
      store,
      executeDeps: mkExecuteDeps([]),
      now: () => boundTime,
    });
    const fired = await sched.tick();
    expect(fired).toEqual([]);
  });

  it('skips schedules with non-matching cron minute', async () => {
    const db = new Database(':memory:');
    const store = createScheduleStore(db);
    // schedule fires at 10:00, tick at 09:00 → no match
    // Build in local time so cronMatchesAt (which uses getHours/etc.) aligns
    const boundTime = new Date(2026, 3, 14, 9, 0, 0).getTime();

    store.set({
      schedule_id: 's1', recipe_id: 'test-recipe', publisher_id: 'me',
      cron_expression: '0 10 * * *', enabled: true,
      created_at: 0, last_run_at: null, next_run_at: null,
      last_status: null, last_error: null,
    });

    const sched = createScheduler({
      store,
      executeDeps: mkExecuteDeps([]),
      now: () => boundTime,
    });
    const fired = await sched.tick();
    expect(fired).toEqual([]);
  });

  it('fires a due one-shot schedule once and disables it', async () => {
    const db = new Database(':memory:');
    const store = createScheduleStore(db);
    const fired: string[] = [];
    const runAt = new Date(2026, 3, 14, 9, 0, 0).getTime();

    store.set({
      schedule_id: 's1',
      recipe_id: 'one-shot-recipe',
      publisher_id: 'me',
      mode: 'one_shot',
      cron_expression: '0 9 14 4 *',
      run_at: runAt,
      enabled: true,
      created_at: runAt - 100_000,
      last_run_at: null,
      next_run_at: runAt,
      last_status: null,
      last_error: null,
    });

    const sched = createScheduler({
      store,
      executeDeps: {
        recipeStore: {
          get: (id: string) => {
            fired.push(id);
            return { recipe_id: id, steps: [], version: 1 } as any;
          },
          size: () => 1,
        } as unknown as ExecuteHandlerDeps['recipeStore'],
        executorConfig: { manifests: { get: () => undefined, size: () => 0 } as any, vault: {} },
        baseVault: {},
        instanceId: 's',
      },
      now: () => runAt + 5_000,
    });

    expect(await sched.tick()).toEqual(['s1']);
    expect(await sched.tick()).toEqual([]);
    expect(fired).toEqual(['one-shot-recipe']);
    const after = store.get('s1')!;
    expect(after.enabled).toBe(false);
    expect(after.next_run_at).toBeNull();
    expect(after.last_run_at).toBe(runAt);
    expect(after.last_status).not.toBeNull();
  });

  it('overlapping ticks do not parallel-fire the same schedule', async () => {
    // Race: a schedule's execution is still running when the next tick
    // occurs. The second tick must observe the firingNow set and skip,
    // even though last_run_at hasn't been written yet.
    const db = new Database(':memory:');
    const store = createScheduleStore(db);
    const boundTime = new Date(2026, 3, 14, 9, 0, 0).getTime();
    let recipeGetCalls = 0;

    store.set({
      schedule_id: 's1', recipe_id: 'slow-recipe', publisher_id: 'me',
      cron_expression: '0 9 * * *', enabled: true,
      created_at: 0, last_run_at: null, next_run_at: null,
      last_status: null, last_error: null,
    });

    const execDeps: ExecuteHandlerDeps = {
      recipeStore: {
        get: (id: string) => {
          recipeGetCalls++;
          return { recipe_id: id, steps: [], version: 1 } as any;
        },
        size: () => 1,
      } as unknown as ExecuteHandlerDeps['recipeStore'],
      executorConfig: { manifests: { get: () => undefined, size: () => 0 } as any, vault: {} },
      baseVault: {},
      instanceId: 's',
    };
    const sched = createScheduler({ store, executeDeps: execDeps, now: () => boundTime });

    // Two overlapping ticks evaluating at the same cron minute.
    const [firedA, firedB] = await Promise.all([sched.tick(), sched.tick()]);

    // Only ONE tick fired the schedule.
    expect(firedA.length + firedB.length).toBe(1);
    // recipeStore.get was called exactly once — no parallel load.
    expect(recipeGetCalls).toBe(1);
  });

  it('stop() awaits in-flight tick before resolving', async () => {
    const db = new Database(':memory:');
    const store = createScheduleStore(db);
    const boundTime = new Date(2026, 3, 14, 9, 0, 0).getTime();

    let firedObserved = false;

    store.set({
      schedule_id: 's1', recipe_id: 'r1', publisher_id: 'me',
      cron_expression: '0 9 * * *', enabled: true,
      created_at: 0, last_run_at: null, next_run_at: null,
      last_status: null, last_error: null,
    });

    const execDeps: ExecuteHandlerDeps = {
      recipeStore: {
        get: (id: string) => {
          firedObserved = true;
          return { recipe_id: id, steps: [], version: 1 } as any;
        },
        size: () => 1,
      } as unknown as ExecuteHandlerDeps['recipeStore'],
      executorConfig: { manifests: { get: () => undefined, size: () => 0 } as any, vault: {} },
      baseVault: {},
      instanceId: 's',
    };

    const sched = createScheduler({ store, executeDeps: execDeps, now: () => boundTime });
    sched.start();
    // Wait for the immediate start-tick to enter execute
    await new Promise((r) => setTimeout(r, 0));
    await sched.stop();
    // After stop() resolves, the tick has definitely written its result —
    // meaning bin.ts can safely db.close() on the next line without racing.
    const after = store.get('s1')!;
    expect(after.last_run_at).toBe(boundTime);
    expect(firedObserved).toBe(true);

    db.close();
  });
});
