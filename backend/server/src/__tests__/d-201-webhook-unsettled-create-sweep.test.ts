/** D-201 Slice 10Z (10V findings 8 and 9) — the timer behind the registration
 *  service's sweep of creates that may still land: every two minutes while it
 *  can, never two at once, and a stop that ends the running one between
 *  ingresses and waits for it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWebhookUnsettledCreateSweepRuntime,
  WEBHOOK_UNSETTLED_CREATE_SWEEP_INTERVAL_MS,
} from '../webhook-unsettled-create-sweep.js';
import type { WebhookUnsettledCreateSweep } from '../webhook-registration-reconciler.js';

const result: WebhookUnsettledCreateSweep = { removed: 0, settled: 0, given_up: 0, failed: 0 };

afterEach(() => {
  vi.useRealTimers();
});

describe('D-201 Slice 10Z — the timer behind the sweep of unsettled webhook creates', () => {
  it('sweeps every two minutes while it can, and never two at once', async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    const sweepUnsettledCreates = vi.fn(() => new Promise<WebhookUnsettledCreateSweep>((resolve) => {
      releases.push(() => resolve(result));
    }));
    let can = false;
    const runtime = createWebhookUnsettledCreateSweepRuntime({
      service: { sweepUnsettledCreates },
      canRun: () => can,
    });
    runtime.start();
    // The vault locked, or the server paused or stopping: nothing is searched.
    await vi.advanceTimersByTimeAsync(WEBHOOK_UNSETTLED_CREATE_SWEEP_INTERVAL_MS);
    expect(sweepUnsettledCreates).not.toHaveBeenCalled();
    can = true;
    await vi.advanceTimersByTimeAsync(WEBHOOK_UNSETTLED_CREATE_SWEEP_INTERVAL_MS - 1);
    expect(sweepUnsettledCreates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweepUnsettledCreates).toHaveBeenCalledTimes(1);
    // Still running at the next tick: not started again.
    await vi.advanceTimersByTimeAsync(WEBHOOK_UNSETTLED_CREATE_SWEEP_INTERVAL_MS);
    expect(sweepUnsettledCreates).toHaveBeenCalledTimes(1);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(WEBHOOK_UNSETTLED_CREATE_SWEEP_INTERVAL_MS);
    expect(sweepUnsettledCreates).toHaveBeenCalledTimes(2);
    releases.shift()!();
    await runtime.stop();
  });

  it('a stop ends the running sweep between ingresses, waits for it, and starts no other', async () => {
    let release!: () => void;
    let isStopping: (() => boolean) | undefined;
    const sweepUnsettledCreates = vi.fn((options?: { readonly isStopping?: () => boolean }) => {
      isStopping = options?.isStopping;
      return new Promise<WebhookUnsettledCreateSweep>((resolve) => { release = () => resolve(result); });
    });
    const runtime = createWebhookUnsettledCreateSweepRuntime({
      service: { sweepUnsettledCreates },
      canRun: () => true,
    });
    const first = runtime.runOnce();
    expect(runtime.runOnce()).toBe(first);
    expect(isStopping?.()).toBe(false);
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    expect(isStopping?.()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    await runtime.runOnce();
    expect(sweepUnsettledCreates).toHaveBeenCalledTimes(1);
  });

  it('says when a sweep throws, and the next one runs', async () => {
    const log = vi.fn();
    const sweepUnsettledCreates = vi.fn()
      .mockRejectedValueOnce(new Error('the store went away'))
      .mockResolvedValueOnce(result);
    const runtime = createWebhookUnsettledCreateSweepRuntime({
      service: { sweepUnsettledCreates },
      canRun: () => true,
      log,
    });
    await runtime.runOnce();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/sweep/), expect.any(Error));
    await runtime.runOnce();
    expect(sweepUnsettledCreates).toHaveBeenCalledTimes(2);
  });

  // D-201 Slice 10AN (the owner's call, 2026-11-20) — the webhooks whose
  // messages are refused are looked at with each sweep.
  it('D-201 Slice 10AN — runs its pass after each sweep, a failed sweep too, never once stopping, and says when it fails', async () => {
    const order: string[] = [];
    const sweepUnsettledCreates = vi.fn(async () => { order.push('sweep'); return result; });
    const afterSweep = vi.fn(async () => { order.push('pass'); });
    const log = vi.fn();
    const runtime = createWebhookUnsettledCreateSweepRuntime({
      service: { sweepUnsettledCreates },
      canRun: () => true,
      afterSweep,
      log,
    });
    await runtime.runOnce();
    expect(order).toEqual(['sweep', 'pass']);
    expect(afterSweep).toHaveBeenCalledWith({ isStopping: expect.any(Function), canRun: expect.any(Function) });
    sweepUnsettledCreates.mockRejectedValueOnce(new Error('the database is busy'));
    await runtime.runOnce();
    expect(order).toEqual(['sweep', 'pass', 'pass']);
    afterSweep.mockRejectedValueOnce(new Error('Telegram is down'));
    await runtime.runOnce();
    expect(log).toHaveBeenCalledWith('the pass over webhooks whose messages are refused failed', expect.any(Error));
    // The server stopping during a sweep: no pass after it.
    let release!: () => void;
    sweepUnsettledCreates.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(result); }));
    const running = runtime.runOnce();
    const stopped = runtime.stop();
    release();
    await running;
    await stopped;
    expect(afterSweep).toHaveBeenCalledTimes(3);
  });

  // D-201 Slice 10AR (10AM finding 29) — read once, before the sweep, the pass
  // ran on after the vault locked.
  it('D-201 Slice 10AR — reads canRun again before its pass, and hands it to the pass to read', async () => {
    let can = true;
    const sweepUnsettledCreates = vi.fn(async () => { can = false; return result; });
    const afterSweep = vi.fn(async (_options: { isStopping: () => boolean; canRun: () => boolean }) => undefined);
    const runtime = createWebhookUnsettledCreateSweepRuntime({
      service: { sweepUnsettledCreates },
      canRun: () => can,
      afterSweep,
    });
    await runtime.runOnce();
    expect(sweepUnsettledCreates).toHaveBeenCalledTimes(1);
    // The vault locked during the sweep: no pass.
    expect(afterSweep).not.toHaveBeenCalled();
    sweepUnsettledCreates.mockImplementation(async () => result);
    can = true;
    await runtime.runOnce();
    expect(afterSweep).toHaveBeenCalledTimes(1);
    const handed = afterSweep.mock.calls[0]![0].canRun;
    expect(handed()).toBe(true);
    can = false;
    expect(handed()).toBe(false);
  });
});
