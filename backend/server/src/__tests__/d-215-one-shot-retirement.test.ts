/** D-215 slice 1 — one-shot retirement.
 *
 *  Before this slice a fired one-shot only had `enabled: false` written to
 *  it. The row survived, the managed overlay dish behind it survived, and
 *  NOTHING reaps either — there is no retention/prune/sweep anywhere in
 *  `scheduler.ts` / `schedule-handler.ts` / `dish-handler.ts`. N queued
 *  posts left N dead rows and N dead dishes forever.
 *
 *  Retirement is outcome-dependent (§ 5.2), which is the whole point:
 *
 *    success  → retire   (intent fulfilled; the record lives in audit)
 *    error    → RETAIN   (the owner needs the evidence + the re-fire handle)
 *    skipped  → RETAIN   (it never ran; retiring erases an unfulfilled intent)
 *
 *  And it is safe at that point specifically because `fireSchedule` AWAITS
 *  `handleExecute` — the dish survives the whole run and only dissolves
 *  after it resolves.
 *
 *  Spec: D-215 § 5.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Dish } from '@recued/contracts';
import { createScheduleStore, type ScheduleStore } from '../schedule-store.js';
import { createDishStore, type DishStore } from '../dish-store.js';
import { createDishContextStore, type DishContextStore } from '../dish-context-store.js';
import { retireSchedule } from '../schedule-retire.js';
import { createScheduler } from '../scheduler.js';
import {
  deleteSchedule,
  updateSchedule,
  type ScheduleHandlerDeps,
} from '../schedule-handler.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Fire-time is local because `cronMatchesAt` reads getHours()/etc. */
const FIRE_AT = new Date(2026, 3, 14, 9, 0, 0).getTime();

const makeStores = (): {
  store: ScheduleStore;
  dishStore: DishStore;
  dishContextStore: DishContextStore;
} => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return {
    store: createScheduleStore(db),
    dishStore: createDishStore(db),
    dishContextStore: createDishContextStore(db),
  };
};

const managedDish = (overrides: Partial<Dish> = {}): Dish => ({
  dish_id: 'dsh_managed',
  recipe_id: 'test-recipe',
  publisher_id: 'me',
  name: 'test-recipe',
  is_default: false,
  config_overlay: { text: 'queued post' },
  enabled: true,
  managed_by_schedule_id: 's1',
  created_at: FIRE_AT - 1_000,
  ...overrides,
});

/** A one-shot due at `FIRE_AT`, optionally bound to a dish. */
const oneShotRow = (dish_id?: string) => ({
  schedule_id: 's1',
  recipe_id: 'test-recipe',
  publisher_id: 'me',
  mode: 'one_shot' as const,
  cron_expression: '0 9 14 4 *',
  run_at: FIRE_AT,
  enabled: true,
  created_at: FIRE_AT - 10_000,
  last_run_at: null,
  next_run_at: FIRE_AT,
  last_status: null,
  last_error: null,
  ...(dish_id !== undefined ? { dish_id } : {}),
});

/** Three distinct terminal outcomes, because the scheduler reaches them by
 *  TWO different code paths and a test that only drives one leaves the other
 *  unguarded:
 *
 *    'ok'      → a valid step-less recipe resolves `success: true`.
 *    'denied'  → a step whose manifest is missing is DENIED by the fail-closed
 *                policy gate, which RESOLVES `success: false` in-band. This is
 *                the path that exercises the `result.success` branch itself.
 *    'throw'   → `recipeStore.get` returning undefined makes `handleExecute`
 *                THROW `recipe_not_found`, landing in the scheduler's catch —
 *                a different branch that never reads `result.success`.
 *
 *  ⚠ 'throw' alone is NOT sufficient: a mutation changing
 *  `if (oneShot && result.success)` to `if (oneShot)` survives it, because the
 *  catch block is reached without ever evaluating that condition. 'denied' is
 *  what kills that mutant. */
const makeExecDeps = (
  stores: ReturnType<typeof makeStores>,
  opts: { outcome?: 'ok' | 'denied' | 'throw' } = {},
): ExecuteHandlerDeps => ({
  recipeStore: {
    get: (id: string) =>
      opts.outcome === 'throw'
        ? undefined
        : ({
          recipe_id: id,
          version: 1,
          ttl: 60,
          metadata: { name: 'Test', description: 'd', author: 'a', supported_platforms: [] },
          // D-222 Slice A — the dish fixture below overlays `text`, and a dish
          // `config_overlay` merges "dish → install → defaults": the chain ends
          // in `variables`, so an overlay key with no declaration overrides
          // nothing and `{{config.text}}` would resolve undefined. The empty
          // declaration here was unrealistic, not load-bearing for retirement.
          variables: { text: '' },
          prefetch_steps: [],
          // A step whose manifest is absent trips the gate's fail-closed
          // missing-manifest deny, which RESOLVES a failure response rather
          // than throwing — the in-band `result.success === false` path.
          steps: opts.outcome === 'denied'
            ? [{ id: 'nope', ingredient: 'not-registered-ingredient', input: {} }]
            : [],
          output: { sidebar: [] },
        } as never),
    size: () => 1,
  } as unknown as ExecuteHandlerDeps['recipeStore'],
  executorConfig: { manifests: { get: () => undefined, size: () => 0 } as never, vault: {} },
  baseVault: {},
  instanceId: 's',
  dishStore: stores.dishStore,
  dishContextStore: stores.dishContextStore,
});

describe('D-215 slice 1 — retireSchedule (the shared path)', () => {
  it('deletes the row, dissolves the dish it owns, and clears continuity', () => {
    const s = makeStores();
    s.store.set(oneShotRow('dsh_managed'));
    s.dishStore.set(managedDish());
    s.dishContextStore.set('dsh_managed', { prior: 'state' } as never);

    expect(retireSchedule(s, 's1')).toBe(true);
    expect(s.store.get('s1')).toBeNull();
    expect(s.dishStore.get('dsh_managed')).toBeNull();
    expect(s.dishContextStore.get('dsh_managed')).toBeNull();
  });

  it('NEVER dissolves a dish another schedule owns', () => {
    const s = makeStores();
    s.store.set(oneShotRow('dsh_managed'));
    s.dishStore.set(managedDish({ managed_by_schedule_id: 's-other' }));

    expect(retireSchedule(s, 's1')).toBe(true);
    expect(s.store.get('s1')).toBeNull();
    expect(s.dishStore.get('dsh_managed')).not.toBeNull();
  });

  it('NEVER dissolves a user-assigned dish (no managed marker)', () => {
    const s = makeStores();
    s.store.set(oneShotRow('dsh_managed'));
    const assigned = managedDish();
    delete assigned.managed_by_schedule_id;
    s.dishStore.set(assigned);

    expect(retireSchedule(s, 's1')).toBe(true);
    expect(s.dishStore.get('dsh_managed')).not.toBeNull();
  });

  it('returns false for a row that is already gone', () => {
    expect(retireSchedule(makeStores(), 's-nope')).toBe(false);
  });

  it('deletes the row when no dish store is wired', () => {
    const s = makeStores();
    s.store.set(oneShotRow('dsh_managed'));
    expect(retireSchedule({ store: s.store }, 's1')).toBe(true);
    expect(s.store.get('s1')).toBeNull();
  });

  it('backs schedules.delete — the rpc dissolves through the same path', () => {
    const s = makeStores();
    s.store.set(oneShotRow('dsh_managed'));
    s.dishStore.set(managedDish());
    const deps: ScheduleHandlerDeps = { ...s, instanceId: 'server-test-1' };

    expect(deleteSchedule(deps, 's1')).toEqual({ deleted: true });
    expect(s.store.get('s1')).toBeNull();
    expect(s.dishStore.get('dsh_managed')).toBeNull();
    expect(() => deleteSchedule(deps, 's1')).toThrow(/not found/);
  });
});

describe('D-215 slice 1 — the scheduler terminal path is outcome-dependent', () => {
  it('SUCCESS retires the one-shot row and its managed dish', async () => {
    const s = makeStores();
    s.store.set(oneShotRow('dsh_managed'));
    s.dishStore.set(managedDish());

    await createScheduler({
      store: s.store,
      executeDeps: makeExecDeps(s),
      now: () => FIRE_AT,
    }).tick();

    expect(s.store.get('s1')).toBeNull();
    expect(s.dishStore.get('dsh_managed')).toBeNull();
  });

  it('ERROR retains the row, disabled, with its last_error and its dish', async () => {
    const s = makeStores();
    s.store.set(oneShotRow('dsh_managed'));
    s.dishStore.set(managedDish());

    await createScheduler({
      store: s.store,
      executeDeps: makeExecDeps(s, { outcome: 'throw' }),
      now: () => FIRE_AT,
    }).tick();

    const after = s.store.get('s1');
    expect(after).not.toBeNull();
    expect(after!.enabled).toBe(false);
    expect(after!.last_status).toBe('error');
    expect(after!.last_error).toBeTruthy();
    // The evidence includes the dish that carried the failed config.
    expect(s.dishStore.get('dsh_managed')).not.toBeNull();
  });

  it('an IN-BAND failure (result.success === false) also retains the row', async () => {
    // The gate-denial path: `handleExecute` RESOLVES a failure rather than
    // throwing, so this is the only test that evaluates the
    // `oneShot && result.success` condition on its false branch. Without it,
    // "retire on every terminal outcome" survives every other assertion here.
    const s = makeStores();
    s.store.set(oneShotRow('dsh_managed'));
    s.dishStore.set(managedDish());

    await createScheduler({
      store: s.store,
      executeDeps: makeExecDeps(s, { outcome: 'denied' }),
      now: () => FIRE_AT,
    }).tick();

    const after = s.store.get('s1');
    expect(after).not.toBeNull();
    expect(after!.enabled).toBe(false);
    expect(after!.last_status).toBe('error');
    expect(s.dishStore.get('dsh_managed')).not.toBeNull();
  });

  it('SKIPPED (dish disabled at fire time) retains the row — it never ran', async () => {
    const s = makeStores();
    s.store.set(oneShotRow('dsh_managed'));
    s.dishStore.set(managedDish({ enabled: false }));

    await createScheduler({
      store: s.store,
      executeDeps: makeExecDeps(s),
      now: () => FIRE_AT,
    }).tick();

    const after = s.store.get('s1');
    expect(after).not.toBeNull();
    expect(after!.last_status).toBe('skipped');
    expect(s.dishStore.get('dsh_managed')).not.toBeNull();
  });

  it.each(['error', 'skipped'] as const)(
    'Resume RE-ARMS a retained %s one-shot and lets it run',
    async (terminal) => {
      const s = makeStores();
      s.store.set({
        ...oneShotRow('dsh_managed'),
        enabled: false,
        last_run_at: FIRE_AT,
        next_run_at: null,
        last_status: terminal,
        last_error: terminal === 'error' ? 'network failed' : 'dish disabled',
      });
      s.dishStore.set(managedDish({ enabled: terminal !== 'skipped' }));

      const resumed = updateSchedule(
        { ...s, instanceId: 'server-test-1', now: () => FIRE_AT + 1 },
        's1',
        { enabled: true },
      ).schedule;

      expect(resumed).toMatchObject({
        enabled: true,
        last_run_at: null,
        next_run_at: FIRE_AT,
        last_status: null,
        last_error: null,
      });
      expect(s.dishStore.get('dsh_managed')?.enabled).toBe(true);

      await createScheduler({
        store: s.store,
        executeDeps: makeExecDeps(s),
        now: () => FIRE_AT + 1,
      }).tick();

      expect(s.store.get('s1')).toBeNull();
      expect(s.dishStore.get('dsh_managed')).toBeNull();
    },
  );

  it('a RECURRING success is never retired — it advances instead', async () => {
    const s = makeStores();
    s.store.set({
      schedule_id: 's1',
      recipe_id: 'test-recipe',
      publisher_id: 'me',
      cron_expression: '0 9 * * *',
      enabled: true,
      created_at: FIRE_AT - 100_000,
      last_run_at: null,
      next_run_at: null,
      last_status: null,
      last_error: null,
      dish_id: 'dsh_managed',
    });
    s.dishStore.set(managedDish());

    await createScheduler({
      store: s.store,
      executeDeps: makeExecDeps(s),
      now: () => FIRE_AT,
    }).tick();

    const after = s.store.get('s1');
    expect(after).not.toBeNull();
    expect(after!.enabled).toBe(true);
    expect(after!.last_status).toBe('success');
    expect(after!.next_run_at).toBeGreaterThan(FIRE_AT);
    expect(s.dishStore.get('dsh_managed')).not.toBeNull();
  });
});
