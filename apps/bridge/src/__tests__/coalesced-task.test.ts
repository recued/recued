import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoalescedTask } from '../coalesced-task.js';

afterEach(() => vi.useRealTimers());

describe('coalesced tasks', () => {
  it('combines a burst and retains one follow-up while the task is pending', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const run = vi.fn<() => Promise<void>>().mockImplementationOnce(() => new Promise(done => { release = done; }))
      .mockResolvedValue(undefined);
    const task = createCoalescedTask(run);
    for (let i = 0; i < 100; i++) task.request();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(49); expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) task.request();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    task.stop();
  });

  it('does not postpone the first run when requests keep arriving', async () => {
    vi.useFakeTimers(); const run = vi.fn(), task = createCoalescedTask(run);
    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < 5; i++) { task.request(); await vi.advanceTimersByTimeAsync(10); }
      expect(run).toHaveBeenCalledTimes(batch + 1);
    }
    task.stop();
  });

  it.each(['throw', 'reject'])('recovers after a task fails by %s', async failure => {
    vi.useFakeTimers();
    const run = vi.fn().mockImplementationOnce(() => {
      if (failure === 'throw') throw new Error('closed receiver');
      return Promise.reject(new Error('closed receiver'));
    }).mockResolvedValue(undefined);
    const task = createCoalescedTask(run);
    task.request(); await vi.advanceTimersByTimeAsync(50);
    task.request(); await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    task.stop();
  });

  it('cancels a queued window and ignores requests after stop', async () => {
    vi.useFakeTimers(); const run = vi.fn(), task = createCoalescedTask(run);
    task.request(); task.stop(); task.stop(); task.request();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule a trailing run after a stopped task settles', async () => {
    vi.useFakeTimers(); let reject!: (error: Error) => void;
    const run = vi.fn(() => new Promise<void>((_done, fail) => { reject = fail; }));
    const task = createCoalescedTask(run);
    task.request(); await vi.advanceTimersByTimeAsync(50);
    task.request(); task.stop(); reject(new Error('receiver closed'));
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
