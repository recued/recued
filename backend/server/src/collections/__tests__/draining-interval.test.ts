import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STOP_GRACE_MS } from '../../lifecycle/settle-within.js';
import { startDrainingInterval } from '../draining-interval.js';
import { CollectionStoppedError } from '../stop-signal.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startDrainingInterval', () => {
  it('tracks an immediate pass when requested', async () => {
    let release: () => void = () => {};
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = startDrainingInterval({
      tick,
      intervalMs: 1_000,
      fireImmediate: true,
    });

    expect(tick).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
  });

  it('does not overlap a slow provider poll with later intervals', async () => {
    const releases: Array<() => void> = [];
    const tick = vi.fn(() => new Promise<void>((resolve) => {
      releases.push(resolve);
    }));
    const stop = startDrainingInterval({ tick, intervalMs: 1_000 });

    vi.advanceTimersByTime(3_000);
    expect(tick).toHaveBeenCalledOnce();

    releases[0]!();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(2);

    releases[1]!();
    await stop();
  });

  it('does not settle stop until the active poll has finished', async () => {
    let release: () => void = () => {};
    const stop = startDrainingInterval({
      intervalMs: 1_000,
      tick: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    vi.advanceTimersByTime(1_000);

    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('aborts the active pass and stops waiting for it after the grace', async () => {
    let seen: AbortSignal | undefined;
    // A pass stuck on a remote party: it never settles on its own.
    const tick = vi.fn((signal: AbortSignal) => {
      seen = signal;
      return new Promise<void>(() => {});
    });
    const onError = vi.fn();
    const stop = startDrainingInterval({ tick, intervalMs: 1_000, onError, fireImmediate: true });
    expect(seen?.aborted).toBe(false);

    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    // Stop aborts the pass at once, with the stop's own reason.
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(CollectionStoppedError);

    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);

    // Nothing starts once stopped, and an aborted pass is not a failure.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('resolves stop as soon as an aborted pass unwinds', async () => {
    const tick = (signal: AbortSignal): Promise<void> => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const onError = vi.fn();
    const stop = startDrainingInterval({ tick, intervalMs: 1_000, onError, fireImmediate: true });

    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
    await stopping;
    expect(onError).not.toHaveBeenCalled();
  });

  it('contains poll failures and prevents ticks after stop', async () => {
    const failure = new Error('provider unavailable');
    const onError = vi.fn();
    const tick = vi.fn(async () => { throw failure; });
    const stop = startDrainingInterval({ tick, intervalMs: 1_000, onError });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledWith(failure);

    await stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledOnce();
  });
});
