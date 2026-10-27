import { describe, expect, it } from 'vitest';

import { releasedAtStop, settleWithin } from '../lifecycle/settle-within.js';

describe('settleWithin — a bounded wait for a stop', () => {
  it('reports settled when the work finishes first, fulfilled or rejected', async () => {
    expect(await settleWithin(Promise.resolve('ok'), 1_000)).toBe('settled');
    expect(await settleWithin(Promise.reject(new Error('stop failed')), 1_000)).toBe('settled');
  });

  it('gives up after the grace when the work never settles', async () => {
    const started = Date.now();
    expect(await settleWithin(new Promise(() => {}), 50)).toBe('timed_out');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('releasedAtStop — a tick a timer waits on, released by the stop', () => {
  const never = new Promise<string>(() => {});

  it('settles with the work while no stop has come', async () => {
    const stop = new AbortController();
    expect(await releasedAtStop(Promise.resolve('done'), stop.signal, 'released', 50)).toBe('done');
    await expect(releasedAtStop(Promise.reject(new Error('tick failed')), stop.signal, 'released', 50))
      .rejects.toThrow('tick failed');
  });

  it('settles with `released` within the grace once the stop comes, while the work goes on', async () => {
    const stop = new AbortController();
    const waiting = releasedAtStop(never, stop.signal, 'released', 50);
    const started = Date.now();
    stop.abort();
    expect(await waiting).toBe('released');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('is released by a stop that came before it was asked', async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await releasedAtStop(never, stop.signal, 'released', 50)).toBe('released');
  });

  it('still settles with the work when it finishes inside the grace after the stop', async () => {
    const stop = new AbortController();
    let finish: (value: string) => void = () => {};
    const work = new Promise<string>((resolve) => { finish = resolve; });
    const waiting = releasedAtStop(work, stop.signal, 'released', 1_000);
    stop.abort();
    finish('done');
    expect(await waiting).toBe('done');
  });
});
