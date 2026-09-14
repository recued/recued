/** D-268 — the cron path, driven end to end.
 *
 *  ⛔ THE CRON PATH HAD NO BREAKER AT ALL. `CIRCUIT_BREAKER_THRESHOLD` has
 *  exactly one consumer (`packages/scheduler/src/auto-run.ts`), so a daily
 *  schedule that failed every day recorded `last_error` and fired again
 *  tomorrow, forever — with nothing reaching the owner, because none of the
 *  three unattended paths holds a notifier.
 *
 *  ⛔⛔ THESE ARE SEQUENCE TESTS, NOT SINGLE-FAILURE TESTS. Both halves of this
 *  feature — the dedup and the breaker — are properties of a RUN SEQUENCE, and a
 *  suite that fails once and asserts one notification cannot see either. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotificationMessage } from '@recued/notification';

import { createScheduleStore } from '../schedule-store.js';
import { createScheduler } from '../scheduler.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

/** Every minute, so ticking is DST-proof and one tick = one fire. */
const CRON = '* * * * *';
const START = new Date(2026, 3, 14, 9, 0, 0).getTime();
const MINUTE = 60_000;

let db: Database.Database;
let store: ReturnType<typeof createScheduleStore>;

beforeEach(() => {
  db = new Database(':memory:');
  store = createScheduleStore(db);
  store.set({
    schedule_id: 's1',
    recipe_id: 'pub/renewal-notice',
    cron_expression: CRON,
    enabled: true,
    next_run_at: START,
    last_run_at: null,
    last_status: null,
    last_error: null,
    created_at: START,
  } as never);
});
afterEach(() => { db.close(); });

const deps = {
  recipeStore: { get: (id: string) => ({ recipe_id: id, version: 1, steps: [] }), size: () => 1 },
  executorConfig: { manifests: { get: () => undefined, size: () => 0 }, vault: {} },
  baseVault: {},
  instanceId: 'server-test-1',
} as unknown as ExecuteHandlerDeps;

type Outcome =
  | { ok: true }
  | { ok: false; code?: string }
  | { held: true }
  | { refusal: { items: number; failed: number } };

/** Fires `outcomes.length` consecutive cron minutes, feeding one outcome each,
 *  and returns every notice the scheduler handed out. */
const drive = async (
  outcomes: readonly Outcome[],
  threshold = 5,
): Promise<{ notices: NotificationMessage[]; fires: number }> => {
  const notices: NotificationMessage[] = [];
  let i = 0;
  let fires = 0;
  let nowMs = START;
  const sched = createScheduler({
    store,
    executeDeps: deps,
    now: () => nowMs,
    failureThreshold: threshold,
    onAutomationFailure: (notice) => { notices.push(notice); },
    execute: (async () => {
      const outcome = outcomes[Math.min(i, outcomes.length - 1)]!;
      i += 1;
      fires += 1;
      if ('held' in outcome) {
        // The shape that has already cost this repo a disabled one-shot:
        // `success: false` with an EMPTY errors array.
        return { success: false, steps: [], errors: [], awaiting_approval: true };
      }
      if ('refusal' in outcome) {
        return {
          success: true, errors: [],
          steps: [{ id: 'a', type: 'op', skipped: false, duration_ms: 1, error: null, foreach: outcome.refusal }],
        };
      }
      if (outcome.ok) return { success: true, steps: [], errors: [] };
      return {
        success: false, steps: [],
        errors: [{ code: outcome.code, message: 'Provider said no.' }],
      };
    }) as never,
  });
  for (let n = 0; n < outcomes.length; n++) {
    nowMs = START + n * MINUTE;
    await sched.tick();
  }
  return { notices, fires };
};

const titles = (notices: readonly NotificationMessage[]): (string | undefined)[] =>
  notices.map((n) => n.title);

describe('D-268 cron failure reporting', () => {
  it('⛔ fail → fail → fail → success → fail sends exactly TWO notices', async () => {
    const { notices } = await drive([
      { ok: false, code: 'NETWORK_ERROR' },
      { ok: false, code: 'NETWORK_ERROR' },
      { ok: false, code: 'NETWORK_ERROR' },
      { ok: true },
      { ok: false, code: 'NETWORK_ERROR' },
    ]);
    expect(titles(notices)).toEqual([
      'pub/renewal-notice failed',
      'pub/renewal-notice failed',
    ]);
    expect(store.get('s1')!.enabled).toBe(true);
    expect(store.get('s1')!.consecutive_failures).toBe(1);
  });

  it('a transient fault disarms at the threshold and STOPS FIRING', async () => {
    const { notices, fires } = await drive(
      Array.from({ length: 12 }, () => ({ ok: false as const, code: 'NETWORK_ERROR' })),
    );
    expect(titles(notices)).toEqual([
      'pub/renewal-notice failed',
      'pub/renewal-notice has stopped',
    ]);
    const after = store.get('s1')!;
    expect(after.enabled).toBe(false);
    expect(after.consecutive_failures).toBe(5);
    // The point of disarming: it stopped costing cycles. Without the breaker
    // this fires all twelve minutes and every later one forever.
    expect(fires).toBe(5);
  });

  it('a credential fault stops on the FIRST failure — waiting buys nothing', async () => {
    const { notices, fires } = await drive(
      Array.from({ length: 4 }, () => ({ ok: false as const, code: 'TOKEN_REFRESH_FAILED' })),
    );
    expect(titles(notices)).toEqual(['pub/renewal-notice has stopped']);
    expect(store.get('s1')!.enabled).toBe(false);
    expect(fires).toBe(1);
  });

  it('⛔ A HOLD IS NOT A FAILURE — the regression this repo has already shipped once', async () => {
    // `awaiting_approval` reports `success: false` with an EMPTY errors array.
    // Treating it as an error once set `enabled: false` on a one-shot whose ask
    // the owner then answered, leaving it "permanently marked as a failed run
    // that never happened".
    const { notices } = await drive(Array.from({ length: 8 }, () => ({ held: true as const })));
    expect(notices).toEqual([]);
    const after = store.get('s1')!;
    expect(after.enabled).toBe(true);
    expect(after.last_status).toBe('skipped');
    // The named cause: it stayed armed BECAUSE the run was held, not because
    // the scheduler happened to skip it.
    expect(after.consecutive_failures ?? 0).toBe(0);
  });

  it('a hold mid-episode does not launder the counter', async () => {
    await drive([
      { ok: false, code: 'NETWORK_ERROR' },
      { ok: false, code: 'NETWORK_ERROR' },
      { held: true },
    ]);
    expect(store.get('s1')!.consecutive_failures).toBe(2);
  });

  it('⛔ total refusal — a run reporting SUCCESS that produced nothing', async () => {
    const { notices } = await drive([{ refusal: { items: 40, failed: 40 } }]);
    expect(titles(notices)).toEqual(['pub/renewal-notice failed']);
    const after = store.get('s1')!;
    expect(after.consecutive_failures).toBe(1);
    // ⛔ It must NOT rewrite the status: the run did complete. D-237's rule —
    // what is false is the inference that it produced anything.
    expect(after.last_status).toBe('success');
    expect(after.enabled).toBe(true);
  });

  it('a partial refusal is an ordinary success and resets the counter', async () => {
    await drive([
      { ok: false, code: 'NETWORK_ERROR' },
      { refusal: { items: 40, failed: 39 } },
    ]);
    const after = store.get('s1')!;
    expect(after.consecutive_failures).toBe(0);
    expect(after.enabled).toBe(true);
  });

  it('a successful run clears an episode silently', async () => {
    await drive([{ ok: false, code: 'NETWORK_ERROR' }, { ok: true }]);
    expect(store.get('s1')!.consecutive_failures).toBe(0);
  });

  it('runs unchanged when no consumer is wired — the seam is optional', async () => {
    const sched = createScheduler({
      store,
      executeDeps: deps,
      now: () => START,
      execute: (async () => ({
        success: false, steps: [], errors: [{ code: 'NETWORK_ERROR', message: 'x' }],
      })) as never,
    });
    await sched.tick();
    const after = store.get('s1')!;
    expect(after.last_status).toBe('error');
    expect(after.consecutive_failures).toBe(1);
  });
});
