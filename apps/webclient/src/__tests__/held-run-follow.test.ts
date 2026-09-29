/** A held run, followed to its end so the page that was told "held" shows what
 *  it did. The server keeps the result just AFTER the run's own events, so the
 *  follower must keep asking briefly; a declined hold has no result at all. */

import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutionGetResponse,
  GatedActionGetResponse,
  GatedActionStatus,
  ServerEvent,
  ServerExecuteResponse,
} from '@recued/contracts';

import {
  HELD_RUN_DECLINED_MESSAGE,
  HELD_RUN_READ_DELAYS_MS,
  createHeldRunFollower,
  type HeldRunDelivery,
} from '../held-run-follow.js';

type ExecutionEvent = Extract<ServerEvent, { kind: 'execution' }>;

const RECIPE = 'send-minutes';

const result = (over: Partial<ServerExecuteResponse> = {}): ServerExecuteResponse => ({
  recipe_id: RECIPE,
  recipe_hash: 'h',
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 1,
  ...over,
});

const held = (action_ref = 'act-1'): ServerExecuteResponse =>
  result({ success: false, awaiting_approval: true, action_ref });

const rig = () => {
  const listeners = new Set<(event: ExecutionEvent) => void>();
  const subscribe = vi.fn((kind: string, listener: (event: ExecutionEvent) => void) => {
    expect(kind).toBe('execution');
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const emit = (event: Partial<ExecutionEvent>): void => {
    for (const listener of [...listeners]) {
      listener({ kind: 'execution', recipe_id: RECIPE, cursor: 1, ...event } as ExecutionEvent);
    }
  };
  let stored: ServerExecuteResponse | undefined;
  const status = new Map<string, GatedActionStatus>([['act-1', 'awaiting_approval']]);
  const getAction = vi.fn(async ({ action_ref }: { action_ref: string }) => ({
    receipt: { action_ref, run_id: 'run-1', status: status.get(action_ref) ?? 'awaiting_approval' },
    group: {},
  }) as unknown as GatedActionGetResponse);
  const getRun = vi.fn(async (_args: { run_id: string }) => ({
    run: {},
    ...(stored !== undefined ? { result: stored } : {}),
  }) as unknown as ExecutionGetResponse);
  const timers: Array<{ handler: () => void; delay: number; cancelled: boolean }> = [];
  const setTimer = (handler: () => void, delay: number) => {
    const timer = { handler, delay, cancelled: false };
    timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  };
  /** Fire every pending read timer (not the long expiry). */
  const fireReads = async (): Promise<void> => {
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) continue;
      if (timer.delay > 60_000) { timers.push(timer); continue; }
      timer.handler();
    }
    await flush();
  };
  const follower = createHeldRunFollower({
    subscribe: subscribe as never,
    getAction,
    getRun,
    setTimer,
  });
  const delivered: Array<{ next: ServerExecuteResponse; replaces: ServerExecuteResponse }> = [];
  const deliver: HeldRunDelivery = (next, later) => delivered.push({ next, replaces: later.replaces });
  return {
    follower, emit, getAction, getRun, delivered, deliver, fireReads, timers,
    store: (value: ServerExecuteResponse | undefined) => { stored = value; },
    setStatus: (ref: string, value: GatedActionStatus) => status.set(ref, value),
  };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('createHeldRunFollower', () => {
  it('hands the page the run\'s own result once it is approved and finishes', async () => {
    const r = rig();
    const shown = held();
    r.follower.follow(shown, r.deliver);
    await flush();
    // Still waiting on the owner: nothing to read.
    expect(r.getRun).not.toHaveBeenCalled();

    // Approved: the receipt moves; the run is under way, no result yet.
    r.setStatus('act-1', 'dispatching');
    r.emit({ run_id: 'run-1', op: 'action_changed', action_ref: 'act-1' });
    await flush();
    expect(r.delivered).toEqual([]);

    // The run ends; its result is kept a moment later.
    const done = result({ output: { render: [{ type: 'text', data: 'Sent to 3 people' }] as never, sidebar: [] } });
    r.store(done);
    r.emit({ run_id: 'run-1', op: 'complete' });
    await flush();
    expect(r.delivered).toEqual([{ next: done, replaces: shown }]);

    // Finished with: later events read nothing more.
    const reads = r.getRun.mock.calls.length;
    r.emit({ run_id: 'run-1', op: 'complete' });
    await flush();
    expect(r.getRun.mock.calls.length).toBe(reads);
  });

  it('keeps asking briefly when the result lands just after the run\'s last event', async () => {
    const r = rig();
    const shown = held();
    r.follower.follow(shown, r.deliver);
    await flush();
    r.setStatus('act-1', 'succeeded');
    r.emit({ run_id: 'run-1', op: 'complete' });
    await flush();
    expect(r.delivered).toEqual([]);
    const done = result();
    r.store(done);
    await r.fireReads();
    expect(r.delivered).toEqual([{ next: done, replaces: shown }]);
  });

  it('stops asking after the last delay when nothing is ever kept (a server too old to keep it)', async () => {
    const r = rig();
    r.follower.follow(held(), r.deliver);
    await flush();
    r.setStatus('act-1', 'succeeded');
    r.emit({ run_id: 'run-1', op: 'complete' });
    await flush();
    for (let i = 0; i <= HELD_RUN_READ_DELAYS_MS.length + 2; i += 1) await r.fireReads();
    // One read for the event, then one per delay — and then it stops.
    expect(r.getRun).toHaveBeenCalledTimes(1 + HELD_RUN_READ_DELAYS_MS.length);
    expect(r.delivered).toEqual([]);
  });

  it('wakes on the recipe ending even when the run broadcasts an in-flight id', async () => {
    const r = rig();
    const shown = held();
    r.follower.follow(shown, r.deliver);
    await flush();
    const done = result();
    r.store(done);
    r.emit({ run_id: `inflight:${RECIPE}:abc`, op: 'complete' });
    await flush();
    expect(r.getRun).toHaveBeenCalledWith({ run_id: 'run-1' });
    expect(r.delivered).toEqual([{ next: done, replaces: shown }]);
  });

  it('ignores progress frames and other recipes', async () => {
    const r = rig();
    r.follower.follow(held(), r.deliver);
    await flush();
    r.emit({ run_id: 'run-1', op: 'progress' });
    r.emit({ run_id: 'run-9', recipe_id: 'another-recipe', op: 'complete' });
    await flush();
    expect(r.getRun).not.toHaveBeenCalled();
  });

  it('tells the page a declined hold did not go ahead', async () => {
    const r = rig();
    const shown = held();
    r.follower.follow(shown, r.deliver);
    await flush();
    r.setStatus('act-1', 'denied');
    r.emit({ run_id: 'run-1', op: 'action_changed', action_ref: 'act-1' });
    await flush();
    expect(r.delivered).toHaveLength(1);
    const { next, replaces } = r.delivered[0]!;
    expect(replaces).toBe(shown);
    expect(next.success).toBe(false);
    expect(next.awaiting_approval).toBeUndefined();
    expect(next.action_ref).toBeUndefined();
    expect(next.errors).toEqual([{ message: HELD_RUN_DECLINED_MESSAGE }]);
  });

  it('a run held again further on is delivered held, then followed to its end', async () => {
    const r = rig();
    const first = held('act-1');
    r.follower.follow(first, r.deliver);
    await flush();
    const second = held('act-2');
    r.setStatus('act-1', 'succeeded');
    r.store(second);
    r.emit({ run_id: 'run-1', op: 'action_changed', action_ref: 'act-2' });
    await flush();
    expect(r.delivered).toEqual([{ next: second, replaces: first }]);

    // The second hold is approved and the run finishes.
    const done = result();
    r.setStatus('act-2', 'succeeded');
    r.store(done);
    r.emit({ run_id: 'run-1', op: 'complete' });
    await flush();
    expect(r.delivered[1]).toEqual({ next: done, replaces: second });
  });

  it('does not follow a result that is not held', () => {
    const r = rig();
    r.follower.follow(result(), r.deliver);
    expect(r.getAction).not.toHaveBeenCalled();
  });

  it('reads at once when the hold was answered before the page started listening', async () => {
    const r = rig();
    const shown = held();
    const done = result();
    r.setStatus('act-1', 'succeeded');
    r.store(done);
    r.follower.follow(shown, r.deliver);
    await flush();
    expect(r.delivered).toEqual([{ next: done, replaces: shown }]);
  });

  it('a stopped follow reads nothing more', async () => {
    const r = rig();
    const stop = r.follower.follow(held(), r.deliver);
    await flush();
    stop();
    r.store(result());
    r.emit({ run_id: 'run-1', op: 'complete' });
    await flush();
    expect(r.getRun).not.toHaveBeenCalled();
    expect(r.delivered).toEqual([]);
  });

  it('recheck reads every followed run again — events missed while away', async () => {
    const r = rig();
    const shown = held();
    r.follower.follow(shown, r.deliver);
    await flush();
    const done = result();
    r.store(done);
    r.follower.recheck();
    await flush();
    expect(r.delivered).toEqual([{ next: done, replaces: shown }]);
  });

  it('lets go when the server has no receipt for the hold', async () => {
    const r = rig();
    r.getAction.mockRejectedValueOnce(new Error('not_configured'));
    r.follower.follow(held(), r.deliver);
    await flush();
    r.store(result());
    r.emit({ run_id: 'run-1', op: 'complete' });
    r.follower.recheck();
    await flush();
    expect(r.getRun).not.toHaveBeenCalled();
  });
});
