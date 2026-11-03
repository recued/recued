/** D-337 ruling 4, design (a) — the waits a gateway request makes for the owner's answers, and
 *  what a held call returns once its run settles. */
import { describe, expect, it } from 'vitest';
import type { ChatDispatchResult } from '@recued/contracts';

import { HELD_RESULT_REFUSED_DETAIL } from '../chat-held-results.js';
import { HELD_WRITE_EXPIRED_MESSAGE } from '../chat-held-writes.js';
import {
  HELD_RUN_SETTLED_KEEP_MAX,
  HELD_RUN_SETTLED_KEEP_MS,
  createHeldRunWaiters,
  settledHeldCallResult,
} from '../held-run-waiters.js';
import type { PreflightRunSettled } from '../preflight-resumer.js';

const settled = (run_id: string, result: unknown, state?: PreflightRunSettled['state']): PreflightRunSettled => ({
  execution_source: { channel: 'chat', actor: 'contracted_user', chat_session_id: 'llm_gateway:t', user_id: 'u', contract_id: 'c' },
  run_id,
  tool_name: 'seller/remove-event',
  result,
  ts: 1,
  ...(state !== undefined ? { state } : {}),
});
const HELD: ChatDispatchResult = {
  ok: true, result: { awaiting_approval: true }, run_held: { kind: 'approval' }, run_id: 'run-1',
};

describe('createHeldRunWaiters', () => {
  it('resolves a wait with its run\'s settlement', async () => {
    const waiters = createHeldRunWaiters();
    const waiting = waiters.wait('run-1', Date.now() + 60_000);
    waiters.settled(settled('run-2', { success: true }));
    waiters.settled(settled('run-1', { success: true, recipe_id: 'r' }));
    await expect(waiting).resolves.toMatchObject({ run_id: 'run-1', result: { recipe_id: 'r' } });
  });

  it('resolves every wait on the same run', async () => {
    const waiters = createHeldRunWaiters();
    const a = waiters.wait('run-1', Date.now() + 60_000);
    const b = waiters.wait('run-1', Date.now() + 60_000);
    waiters.settled(settled('run-1', { success: true }));
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect((await a)?.run_id).toBe('run-1');
    expect((await b)?.run_id).toBe('run-1');
  });

  it('ends a wait when its time runs out', async () => {
    const waiters = createHeldRunWaiters();
    await expect(waiters.wait('run-1', Date.now() + 20)).resolves.toBeUndefined();
    await expect(waiters.wait('run-1', Date.now() - 1)).resolves.toBeUndefined();
  });

  it('ends a wait when the caller goes away', async () => {
    const waiters = createHeldRunWaiters();
    const gone = new AbortController();
    const waiting = waiters.wait('run-1', Date.now() + 60_000, gone.signal);
    gone.abort();
    await expect(waiting).resolves.toBeUndefined();
    gone.abort();
    await expect(waiters.wait('run-1', Date.now() + 60_000, gone.signal)).resolves.toBeUndefined();
  });

  it('passes over a run that paused again at a later step, and waits on for its end', async () => {
    const waiters = createHeldRunWaiters();
    const waiting = waiters.wait('run-1', Date.now() + 60_000);
    waiters.settled(settled('run-1', { awaiting_approval: true }));
    waiters.settled(settled('run-1', { ok: true, result: { status: 'pending' }, run_held: { kind: 'approval' } }));
    let resolved = false;
    void waiting.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    waiters.settled(settled('run-1', { success: true, recipe_id: 'done' }));
    await expect(waiting).resolves.toMatchObject({ result: { recipe_id: 'done' } });
  });

  it('finds a settlement that came before the wait began, once', async () => {
    const waiters = createHeldRunWaiters();
    waiters.settled(settled('run-1', { success: true, recipe_id: 'early' }));
    await expect(waiters.wait('run-1', Date.now() + 60_000)).resolves.toMatchObject({ result: { recipe_id: 'early' } });
    await expect(waiters.wait('run-1', Date.now() + 20)).resolves.toBeUndefined();
  });

  it('keeps such a settlement only for a while, and only so many of them', async () => {
    let clock = 0;
    const waiters = createHeldRunWaiters({ now: () => clock });
    waiters.settled(settled('old', { success: true }));
    clock += HELD_RUN_SETTLED_KEEP_MS;
    await expect(waiters.wait('old', clock - 1)).resolves.toBeUndefined();

    for (let i = 0; i <= HELD_RUN_SETTLED_KEEP_MAX; i += 1) waiters.settled(settled(`run-${String(i)}`, { success: true }));
    // The oldest went to make room; the newest is there.
    await expect(waiters.wait('run-0', clock - 1)).resolves.toBeUndefined();
    await expect(waiters.wait(`run-${String(HELD_RUN_SETTLED_KEEP_MAX)}`, clock - 1)).resolves.toBeDefined();
  });
});

describe('settledHeldCallResult — what the held call returns once its run settles', () => {
  it('a run that ran returns what an unheld run returns, with the call\'s run id', () => {
    const out = settledHeldCallResult(
      settled('run-1', { success: true, recipe_id: 'seller/remove-event', errors: [], steps: [] }),
      HELD,
    );
    expect(out).toMatchObject({ ok: true, run_id: 'run-1' });
    expect(out).not.toHaveProperty('run_held');
    expect(out).not.toHaveProperty('run_failed');
  });

  it('a run that failed returns as a failed unheld run does: ok, with run_failed', () => {
    const out = settledHeldCallResult(
      settled('run-1', { success: false, recipe_id: 'seller/remove-event', errors: [{ message: 'calendar unreachable' }] }),
      HELD,
    );
    expect(out).toMatchObject({ ok: true, run_failed: { detail: 'calendar unreachable' }, run_id: 'run-1' });
  });

  it('refused: the words the owner\'s own conversation reads', () => {
    expect(settledHeldCallResult(settled('run-1', { denied: true, message: 'no' }), HELD)).toEqual({
      ok: false, reason: 'plan_cancelled', detail: HELD_RESULT_REFUSED_DETAIL, run_id: 'run-1',
    });
  });

  it('expired: the same', () => {
    expect(settledHeldCallResult(settled('run-1', { expired: true }), HELD)).toEqual({
      ok: false, reason: 'plan_cancelled', detail: HELD_WRITE_EXPIRED_MESSAGE, run_id: 'run-1',
    });
  });

  it('a tool\'s own result for its run passes through', () => {
    const finished: ChatDispatchResult = { ok: true, result: { status: 'approved', file_ref: 'file:x' } };
    expect(settledHeldCallResult(settled('run-1', finished, 'succeeded'), HELD))
      .toEqual({ ...finished, run_id: 'run-1' });
  });
});
