import { describe, expect, it, vi } from 'vitest';

import {
  buildAuditEntry,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';

import { createDrainableAuditLog } from '../audit/drainable.js';

const activity = (): ActivityEntry => ({
  activity_id: 'activity-1',
  timestamp: 1,
  action: 'server_boot',
  target: 'server',
  detail: '{}',
});

const execution = (): AuditEntry => buildAuditEntry({
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  recipe_hash: 'hash-1',
  now: 2,
  duration_ms: 1,
  commit_status: 'succeeded',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: null,
  instance_id: null,
});

describe('createDrainableAuditLog', () => {
  it('closes late admission and waits for every admitted append kind', async () => {
    let releaseActivity!: () => void;
    const activityPending = new Promise<void>((resolve) => {
      releaseActivity = resolve;
    });
    let releaseExecution!: () => void;
    const executionPending = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const logActivity = vi.fn(() => activityPending);
    const append = vi.fn(() => executionPending);
    const drainable = createDrainableAuditLog({
      logActivity,
      append,
    } as unknown as AuditLogStore);

    const activityWrite = drainable.auditLog.logActivity(activity());
    const executionWrite = drainable.auditLog.append(execution());
    let drained = false;
    const firstDrain = drainable.closeAndDrain().then(() => { drained = true; });
    const secondDrain = drainable.closeAndDrain();

    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(drainable.auditLog.logActivity({
      ...activity(),
      activity_id: 'late',
    })).resolves.toBeUndefined();
    expect(logActivity).toHaveBeenCalledOnce();

    releaseActivity();
    await activityWrite;
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseExecution();
    await executionWrite;
    await Promise.all([firstDrain, secondDrain]);
    expect(drained).toBe(true);
    expect(append).toHaveBeenCalledOnce();
  });

  it('preserves an append failure for its caller while containing it in drain', async () => {
    const failure = new Error('audit unavailable');
    const drainable = createDrainableAuditLog({
      logActivity: vi.fn(async () => { throw failure; }),
    } as unknown as AuditLogStore);

    const write = drainable.auditLog.logActivity(activity());
    await expect(write).rejects.toBe(failure);
    await expect(drainable.closeAndDrain()).resolves.toBeUndefined();
  });

  it('R13 T4-6.1 — counts refused writes after drain and notifies the marker callback', async () => {
    const logActivity = vi.fn(() => Promise.resolve());
    const append = vi.fn(() => Promise.resolve());
    const onDroppedWrite = vi.fn((_total: number) => undefined);
    const drainable = createDrainableAuditLog(
      { logActivity, append } as unknown as AuditLogStore,
      { onDroppedWrite },
    );
    expect(drainable.droppedWrites()).toBe(0);
    await drainable.closeAndDrain();

    await expect(drainable.auditLog.logActivity(activity())).resolves.toBeUndefined();
    await expect(drainable.auditLog.append(execution())).resolves.toBeUndefined();

    expect(drainable.droppedWrites()).toBe(2);
    expect(onDroppedWrite).toHaveBeenNthCalledWith(1, 1);
    expect(onDroppedWrite).toHaveBeenNthCalledWith(2, 2);
    // The refused writes never reached the underlying store.
    expect(logActivity).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('R13 T4-6.1 — a throwing marker callback is contained (shutdown path)', async () => {
    const drainable = createDrainableAuditLog(
      { logActivity: vi.fn(() => Promise.resolve()) } as unknown as AuditLogStore,
      { onDroppedWrite: () => { throw new Error('marker disk gone'); } },
    );
    await drainable.closeAndDrain();
    await expect(drainable.auditLog.logActivity(activity())).resolves.toBeUndefined();
    expect(drainable.droppedWrites()).toBe(1);
  });

  it('⛔⛔ a SYNCHRONOUS throw from the store becomes a rejection, not an escape', async () => {
    // ⛔ THE WHOLE POINT OF THIS WRAPPER IS THAT AN AUDIT ROW CANNOT BREAK ITS
    // CALLER. The header says an observability row "must not turn a quota
    // denial, notification, or housekeeping pass into a user-visible failure".
    // Producers call this non-blockingly and do not try/catch it — so a store
    // that throws SYNCHRONOUSLY (a closed handle, a prepared-statement error)
    // would propagate straight out of the call and do exactly what the wrapper
    // exists to prevent.
    //
    // ⚠ A REJECTED PROMISE, NOT A SWALLOW: the failure is still reported to a
    // caller that awaits, and it is still TRACKED so the drain waits for it.
    const append = vi.fn(() => { throw new Error('sqlite handle closed'); });
    const drainable = createDrainableAuditLog({
      append,
      logActivity: vi.fn(async () => {}),
    } as unknown as AuditLogStore);

    let escaped: unknown;
    let returned: Promise<unknown> | undefined;
    try {
      returned = drainable.auditLog.append(execution());
    } catch (err) {
      escaped = err;
    }
    expect(escaped, 'the store threw straight through the wrapper').toBeUndefined();
    await expect(returned).rejects.toThrow('sqlite handle closed');
    // And the drain still completes rather than waiting on a task it never saw.
    await expect(drainable.closeAndDrain()).resolves.toBeUndefined();
  });

  it('⛔ concurrent closeAndDrain callers share ONE drain', async () => {
    // ⚠ The interface promises "safe and idempotent under concurrent shutdown
    // callers" and nothing checked it. Two shutdown paths racing (a signal
    // handler and an rpc-driven stop) would each run the drain loop; the
    // memoised promise is what makes the second a join rather than a restart.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let appendCalls = 0;
    const drainable = createDrainableAuditLog({
      append: vi.fn(() => { appendCalls += 1; return gate; }),
      logActivity: vi.fn(async () => {}),
    } as unknown as AuditLogStore);

    void drainable.auditLog.append(execution());
    const a = drainable.closeAndDrain();
    const b = drainable.closeAndDrain();
    expect(a, 'a second shutdown caller started its own drain').toBe(b);

    release!();
    await Promise.all([a, b]);
    expect(appendCalls).toBe(1);
    // ⚠ And a drain called AFTER completion is still the same promise — a late
    // caller must not reopen or re-run anything.
    expect(drainable.closeAndDrain()).toBe(a);
  });
});

/* ─── Mutation sweep of `audit/drainable.ts`, 2026-09-18 ────────────────────
 *  18 mutations written, 16 runnable; 15 caught. Two findings about the module
 *  and one about sweeping it.
 *
 *  EQUIVALENT — the `while (pending.size > 0)` loop in `closeAndDrain`. A
 *  single `allSettled` reaches the same state: measured with three timer-backed
 *  writes, both forms finish all three and leave `pending` empty. The loop is
 *  defensive against an entry ARRIVING during the drain, which the admission
 *  gate already prevents — `accepting = false` is set before the drain begins
 *  and `track` is the only path into `pending`. Keep it (it costs nothing and
 *  covers a future path that bypasses the gate), but no test can see it.
 *
 *  ⛔⛔ TWO MUTATIONS ARE UNRUNNABLE, AND THE REASON GENERALISES. Making
 *  `clear` a no-op, or clearing only on fulfilment, leaves `pending` non-empty
 *  forever — and `while (pending.size > 0) { await Promise.allSettled(...) }`
 *  over already-settled promises is then a TIGHT MICROTASK LOOP. It never
 *  yields to a macrotask, so vitest's own test timeout never fires: the suite
 *  does not fail, it HANGS, and a mutation harness wedges with the source still
 *  edited. (It did; the file was restored by hand.)
 *  ⇒ Before sweeping a module with an `await` inside a `while`, ask which
 *  mutations make the condition permanently true. Those are real defects worth
 *  knowing about, but they must be pinned by a direct test — the two here are
 *  covered by "admitted writes settle before the drain resolves" above, which
 *  fails rather than hangs.
 * ────────────────────────────────────────────────────────────────────────── */

