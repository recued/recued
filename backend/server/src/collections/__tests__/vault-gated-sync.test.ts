import { describe, expect, it, vi } from 'vitest';

import { createCollectionSyncController } from '../vault-gated-sync.js';

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('vault-gated collection sync controller', () => {
  it('compensates a stale resume and never starts a later collection after lock', async () => {
    const startGate = deferred();
    let firstRunning = false;
    let secondRunning = false;
    const first = {
      sync: {
        start: vi.fn(async () => {
          await startGate.promise;
          firstRunning = true;
        }),
        stop: vi.fn(async () => { firstRunning = false; }),
      },
    };
    const second = {
      sync: {
        start: vi.fn(async () => { secondRunning = true; }),
        stop: vi.fn(async () => { secondRunning = false; }),
      },
    };
    const errors: string[] = [];
    const controller = createCollectionSyncController(
      () => [first, second],
      (message) => { errors.push(message); },
    );

    const resuming = controller.resume();
    await vi.waitFor(() => expect(first.sync.start).toHaveBeenCalledTimes(1));
    const pausing = controller.pause();
    startGate.resolve();
    await Promise.all([resuming, pausing]);

    expect(firstRunning).toBe(false);
    expect(secondRunning).toBe(false);
    expect(second.sync.start).not.toHaveBeenCalled();
    expect(first.sync.stop).toHaveBeenCalled();
    expect(second.sync.stop).toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('does not overlap a newer resume with an admitted slow stop', async () => {
    const stopGate = deferred();
    let firstRunning = true;
    let secondRunning = true;
    const first = {
      sync: {
        start: vi.fn(async () => { firstRunning = true; }),
        stop: vi.fn(async () => {
          await stopGate.promise;
          firstRunning = false;
        }),
      },
    };
    const second = {
      sync: {
        start: vi.fn(async () => { secondRunning = true; }),
        stop: vi.fn(async () => { secondRunning = false; }),
      },
    };
    const controller = createCollectionSyncController(
      () => [first, second],
      () => undefined,
    );

    const pausing = controller.pause();
    await vi.waitFor(() => expect(first.sync.stop).toHaveBeenCalledTimes(1));
    const resuming = controller.resume();
    await Promise.resolve();
    expect(first.sync.start).not.toHaveBeenCalled();
    expect(second.sync.start).not.toHaveBeenCalled();

    stopGate.resolve();
    await Promise.all([pausing, resuming]);

    expect(firstRunning).toBe(true);
    expect(secondRunning).toBe(true);
    expect(first.sync.start).toHaveBeenCalled();
    expect(second.sync.start).toHaveBeenCalled();
  });

  it('dispose closes admission and drains an admitted resume to stopped', async () => {
    const startGate = deferred();
    let running = false;
    const collection = {
      sync: {
        start: vi.fn(async () => {
          await startGate.promise;
          running = true;
        }),
        stop: vi.fn(async () => { running = false; }),
      },
    };
    const controller = createCollectionSyncController(
      () => [collection],
      () => undefined,
    );

    const resuming = controller.resume();
    await vi.waitFor(() => expect(collection.sync.start).toHaveBeenCalledTimes(1));
    const disposing = controller.dispose();
    expect(controller.dispose()).toBe(disposing);
    startGate.resolve();
    await Promise.all([resuming, disposing]);

    expect(running).toBe(false);
    expect(collection.sync.stop).toHaveBeenCalled();
    expect(controller.resume()).toBe(disposing);
  });
});
