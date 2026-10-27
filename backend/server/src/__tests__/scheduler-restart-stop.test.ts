/** Cron scheduler — what a restart's `pause_scheduler` step needs from `stop()`.
 *
 *  The drain gives each step 5 s, and a step that runs out makes an update
 *  refuse to swap versions. `stop()` used to wait for the in-flight tick, which
 *  fires every remaining due schedule one after another — so these pin that a
 *  stop ends the tick after the schedule already firing, returns within
 *  `STOP_GRACE_MS` even when that run never finishes, and that a run the
 *  draining server refused (or killed) is never booked as the recipe failing. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { RpcError } from '@recued/contracts';
import type { Schedule } from '@recued/scheduler';

import { createScheduleStore } from '../schedule-store.js';
import { createScheduler } from '../scheduler.js';
import type { handleExecute, ExecuteHandlerDeps } from '../execute-handler.js';
import { STOP_GRACE_MS } from '../lifecycle/settle-within.js';

const NINE = new Date(2026, 3, 14, 9, 0, 0).getTime();

const schedule = (id: string, extra: Partial<Schedule> = {}): Schedule => ({
  schedule_id: id,
  recipe_id: `recipe-${id}`,
  publisher_id: 'me',
  cron_expression: '0 9 * * *',
  enabled: true,
  created_at: 0,
  last_run_at: null,
  next_run_at: null,
  last_status: null,
  last_error: null,
  ...extra,
});

const ok = (recipeId: string) => ({
  recipe_id: recipeId,
  recipe_hash: 'hash',
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 0,
});

const deps = (extra: Partial<ExecuteHandlerDeps> = {}): ExecuteHandlerDeps => ({
  recipeStore: {
    get: (id: string) => ({ recipe_id: id, steps: [], version: 1 }) as never,
    size: () => 1,
  } as unknown as ExecuteHandlerDeps['recipeStore'],
  executorConfig: { manifests: { get: () => undefined, size: () => 0 } as never, vault: {} },
  baseVault: {},
  instanceId: 'server-test',
  ...extra,
});

const never = <T>(): Promise<T> => new Promise<T>(() => {});

afterEach(() => {
  vi.useRealTimers();
});

describe('cron stop() during a restart drain', () => {
  it('returns within the grace while a fire never finishes, and starts no later due schedule', async () => {
    vi.useFakeTimers();
    const db = new Database(':memory:');
    try {
      const store = createScheduleStore(db);
      for (const id of ['a', 'b', 'c']) store.set(schedule(id));
      const started: string[] = [];
      let release!: () => void;
      const hung = new Promise<void>((resolve) => { release = resolve; });
      const execute = (async (_deps, request) => {
        started.push(request.recipe_id ?? '');
        if (request.recipe_id === 'recipe-a') await hung;
        return ok(request.recipe_id ?? '');
      }) as typeof handleExecute;
      const sched = createScheduler({
        store, executeDeps: deps(), execute, now: () => NINE, tickIntervalMs: 3_600_000,
      });

      sched.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual(['recipe-a']);

      let stopped = false;
      const stopping = sched.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
      // The tick is still out there — `await_inflight` must keep seeing it.
      expect(sched.inFlight()).toBe(true);

      // When the hung run finally ends, the tick it belonged to stops there:
      // b and c stay due for the next boot instead of starting mid-drain.
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(sched.inFlight()).toBe(false);
      expect(started).toEqual(['recipe-a']);
      expect(store.get('a')!.last_status).toBe('success');
      expect(store.get('b')!.last_run_at).toBeNull();
      expect(store.get('c')!.last_run_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it('a tick asked for after stop() fires nothing until start()', async () => {
    const db = new Database(':memory:');
    try {
      const store = createScheduleStore(db);
      store.set(schedule('a'));
      const execute = vi.fn(async (_deps: ExecuteHandlerDeps, request: { recipe_id?: string }) =>
        ok(request.recipe_id ?? '')) as unknown as typeof handleExecute;
      const sched = createScheduler({
        store, executeDeps: deps(), execute, now: () => NINE, tickIntervalMs: 3_600_000,
      });
      await sched.stop();
      // The vault-unlock coordinator kicks `tick()` directly; a stopped
      // scheduler must not take that as leave to fire.
      expect(await sched.tick()).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(store.get('a')!.last_run_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it('a run refused because the server is draining leaves the schedule due and unmarked', async () => {
    const db = new Database(':memory:');
    try {
      const store = createScheduleStore(db);
      store.set(schedule('daily'));
      store.set(schedule('once', {
        mode: 'one_shot', cron_expression: '0 9 14 4 *', run_at: NINE, next_run_at: NINE,
      }));
      const onAutomationFailure = vi.fn();
      const execute = (async () => {
        throw new RpcError('draining', 'The server is restarting; try again in a moment.', 503);
      }) as unknown as typeof handleExecute;
      const sched = createScheduler({
        store, executeDeps: deps(), execute, now: () => NINE, onAutomationFailure,
      });

      expect(await sched.tick()).toEqual([]);

      // Nothing ran, so nothing claims it did: no last_run_at, no error, no
      // counter — the next boot sees the miss, and the one-shot is still due.
      const daily = store.get('daily')!;
      expect(daily.last_run_at).toBeNull();
      expect(daily.last_status).toBeNull();
      expect(daily.last_error).toBeNull();
      expect(daily.consecutive_failures ?? 0).toBe(0);
      const once = store.get('once')!;
      expect(once.enabled).toBe(true);
      expect(once.last_run_at).toBeNull();
      expect(onAutomationFailure).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('attempts nothing — not even the pre-approval pump — while the server is draining', async () => {
    const db = new Database(':memory:');
    try {
      const store = createScheduleStore(db);
      store.set(schedule('a'));
      const execute = vi.fn() as unknown as typeof handleExecute;
      const tickSchedules = vi.fn(async () => []);
      let isDraining = true;
      const sched = createScheduler({
        store,
        executeDeps: deps({
          isDraining: () => isDraining,
          preapprovalDriver: { tickSchedules } as unknown as ExecuteHandlerDeps['preapprovalDriver'],
        }),
        execute,
        now: () => NINE,
      });

      expect(await sched.tick()).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(tickSchedules).not.toHaveBeenCalled();
      expect(store.get('a')!.last_run_at).toBeNull();

      // The permitting case: the same scheduler fires once the drain is over,
      // so the refusal above is the drain and not a broken fixture.
      isDraining = false;
      (execute as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async (_deps: unknown, request: { recipe_id?: string }) => ok(request.recipe_id ?? ''),
      );
      expect(await sched.tick()).toEqual(['a']);
      expect(tickSchedules).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('a run the restart killed moves no failure counter and sends no notice; an ordinary kill still does', async () => {
    const killed = {
      ...ok('recipe-a'),
      success: false,
      run_terminated: 'killed' as const,
      errors: [{ code: 'run_killed', message: 'The run was stopped before this step finished.' }],
    };
    const run = async (drainBegins: boolean) => {
      const db = new Database(':memory:');
      try {
        const store = createScheduleStore(db);
        store.set(schedule('a'));
        let isDraining = false;
        const onAutomationFailure = vi.fn();
        const execute = (async () => {
          // The drain begins while the run is in flight and kills it.
          if (drainBegins) isDraining = true;
          return killed;
        }) as unknown as typeof handleExecute;
        const sched = createScheduler({
          store, executeDeps: deps({ isDraining: () => isDraining }), execute, now: () => NINE,
          onAutomationFailure,
        });
        await sched.tick();
        return { row: store.get('a')!, notices: onAutomationFailure.mock.calls.length };
      } finally {
        db.close();
      }
    };

    const restart = await run(true);
    expect(restart.row.last_run_at).toBe(NINE);
    expect(restart.row.last_status).toBe('error');
    expect(restart.row.consecutive_failures ?? 0).toBe(0);
    expect(restart.notices).toBe(0);

    // Mutate only the drain: the same killed response outside a restart is
    // the owner's kill, booked as it always was.
    const ordinary = await run(false);
    expect(ordinary.row.consecutive_failures).toBe(1);
    expect(ordinary.notices).toBe(1);
  });
});
