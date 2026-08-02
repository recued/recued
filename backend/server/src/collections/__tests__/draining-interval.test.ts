import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startDrainingInterval } from '../draining-interval.js';

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
