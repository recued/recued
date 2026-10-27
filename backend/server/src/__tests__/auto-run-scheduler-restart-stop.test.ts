/** Auto-run scheduler — what a restart's `pause_scheduler` step needs from
 *  `stop()`.
 *
 *  `stop()` used to wait for every entry a tick had fired, one after another,
 *  so a restart drain waited on each remaining reactive run and ran out of its
 *  5 s step. These pin that a stop ends the tick after the entry already
 *  running, returns within `STOP_GRACE_MS` even when that run never finishes,
 *  and that a run the draining server refused (or killed) never reaches the
 *  breaker or the owner. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { RpcError, type RecipeDefinition } from '@recued/contracts';

import {
  createCircuitBreakerStore,
  createServerAutoRunScheduler,
  type ServerAutoRunConfig,
} from '../auto-run-scheduler.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import type { RecipeStore } from '../recipe-store.js';
import type { ExecuteRequest, ExecuteResponse, StoredRecipe } from '../types.js';
import { STOP_GRACE_MS } from '../lifecycle/settle-within.js';

const recipe = (id: string): RecipeDefinition => ({
  recipe_id: id,
  version: 1,
  ttl: 300,
  auto_run: { interval_ms: 30_000 },
  metadata: { name: id, description: 'test', author: 'recued-core', supported_platforms: ['test'] },
  steps: [],
} as unknown as RecipeDefinition);

const recipeStore = (recipes: RecipeDefinition[]): RecipeStore => ({
  get: (id: string) => recipes.find((r) => r.recipe_id === id) ?? null,
  listStored: () => recipes.map((r): StoredRecipe => ({
    recipe_id: r.recipe_id,
    publisher_id: 'recued-core',
    version: r.version,
    recipe_hash: 'h',
    recipe_json: JSON.stringify(r),
    source: 'inline',
    installed_at: 0,
    pack_slug: null,
  })),
} as unknown as RecipeStore);

/** One dish per recipe, keyed by the recipe's own id. */
const oneDishEach: NonNullable<ServerAutoRunConfig['dishStore']> = {
  get: (dish_id) => ({ dish_id, recipe_id: dish_id, enabled: true } as never),
  listByRecipe: (recipe_id) => [{ dish_id: recipe_id, recipe_id, enabled: true } as never],
};

const response = (request: ExecuteRequest, extra: Partial<ExecuteResponse> = {}): ExecuteResponse => ({
  recipe_id: request.recipe_id ?? 'r',
  recipe_hash: 'h',
  success: true,
  output: { sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 1,
  ...extra,
} as unknown as ExecuteResponse);

const build = (
  db: Database.Database,
  ids: string[],
  execute: (request: ExecuteRequest) => Promise<ExecuteResponse>,
  extra: Partial<ServerAutoRunConfig> = {},
) => createServerAutoRunScheduler({
  recipeStore: recipeStore(ids.map(recipe)),
  dishStore: oneDishEach,
  execute,
  circuitStore: createCircuitBreakerStore(db),
  now: () => 0,
  // The per-entry timers are not under test; direct `tick()` drives fires.
  setTimer: () => ({}),
  clearTimer: () => {},
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('auto-run stop() during a restart drain', () => {
  it('returns within the grace while a fire never finishes, and runs no further entry', async () => {
    vi.useFakeTimers();
    const db = new Database(':memory:');
    try {
      const started: string[] = [];
      let release!: () => void;
      const hung = new Promise<void>((resolve) => { release = resolve; });
      const handle = build(db, ['r1', 'r2', 'r3'], async (request) => {
        started.push(request.recipe_id ?? '');
        if (started.length === 1) await hung;
        return response(request);
      });
      await handle.refreshRoster();
      const ticking = handle.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toHaveLength(1);

      let stopped = false;
      const stopping = handle.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
      // Still running: `await_inflight` keeps covering it.
      expect(handle.inFlight()).toBe(true);

      release();
      await ticking;
      // The two entries behind it never started mid-drain.
      expect(started).toHaveLength(1);
      expect(handle.inFlight()).toBe(false);
    } finally {
      db.close();
    }
  });

  it('a tick() asked for after stop() fires nothing', async () => {
    const db = new Database(':memory:');
    try {
      const execute = vi.fn(async (request: ExecuteRequest) => response(request));
      const handle = build(db, ['r1'], execute);
      await handle.refreshRoster();
      await handle.stop();
      const report = await handle.tick();
      expect(report.fired).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('a run refused because the server is draining reaches no breaker, notice or fire broadcast', async () => {
    const db = new Database(':memory:');
    try {
      const circuitStore = createCircuitBreakerStore(db);
      const set = vi.spyOn(circuitStore, 'set');
      const onAutomationFailure = vi.fn();
      const onFired = vi.fn();
      const handle = build(db, ['r1'], async () => {
        throw new RpcError('draining', 'The server is restarting; try again in a moment.', 503);
      }, { circuitStore, onAutomationFailure, onFired });
      await handle.refreshRoster();

      await handle.tick();

      expect(set).not.toHaveBeenCalled();
      expect(onAutomationFailure).not.toHaveBeenCalled();
      expect(onFired).not.toHaveBeenCalled();
      expect(handle.roster.get('r1')!.consecutive_failures).toBe(0);
      expect(circuitStore.get('r1')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('attempts nothing while the server is draining, and fires again once it is not', async () => {
    const db = new Database(':memory:');
    try {
      let isDraining = true;
      const execute = vi.fn(async (request: ExecuteRequest) => response(request));
      const handle = build(db, ['r1'], execute, {
        executeDeps: { isDraining: () => isDraining } as unknown as ExecuteHandlerDeps,
      });
      await handle.refreshRoster();

      expect((await handle.tick()).fired).toEqual([]);
      expect(execute).not.toHaveBeenCalled();

      // The entry stayed due: the same scheduler fires it once the drain is over.
      isDraining = false;
      expect((await handle.tick()).fired.map((f) => f.key)).toEqual(['r1']);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('a run the restart killed moves no breaker and sends no notice; an ordinary kill still does', async () => {
    const run = async (drainBegins: boolean) => {
      const db = new Database(':memory:');
      try {
        let isDraining = false;
        const onAutomationFailure = vi.fn();
        const handle = build(db, ['r1'], async (request) => {
          if (drainBegins) isDraining = true;
          return response(request, {
            success: false,
            run_terminated: 'killed',
            errors: [{ code: 'run_killed', message: 'The run was stopped before this step finished.' }] as never,
          });
        }, {
          onAutomationFailure,
          executeDeps: { isDraining: () => isDraining } as unknown as ExecuteHandlerDeps,
        });
        await handle.refreshRoster();
        await handle.tick();
        return {
          failures: handle.roster.get('r1')!.consecutive_failures,
          notices: onAutomationFailure.mock.calls.length,
        };
      } finally {
        db.close();
      }
    };

    expect(await run(true)).toEqual({ failures: 0, notices: 0 });
    // Mutate only the drain: outside a restart a kill is the owner's, booked
    // as it always was.
    expect(await run(false)).toEqual({ failures: 1, notices: 1 });
  });
});
