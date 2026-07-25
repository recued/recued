import { describe, expect, it, vi } from 'vitest';

import {
  createHousekeepingSchedulerRegistry,
  housekeepingSchedulerRegistry,
} from '../composition/bin/housekeeping-scheduler-instance.js';

const makeScheduler = (overrides: Record<string, any> = {}) => ({
  start: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  runOnce: vi.fn(),
  ...overrides,
});

describe('createHousekeepingSchedulerRegistry', () => {
  it('round-trips setScheduler and getScheduler', () => {
    const registry = createHousekeepingSchedulerRegistry();
    const scheduler = makeScheduler();

    expect(registry.getScheduler()).toBeUndefined();
    registry.setScheduler(scheduler as any);

    expect(registry.getScheduler()).toBe(scheduler);
  });

  it('returns the same producer Map identity on every call', () => {
    const registry = createHousekeepingSchedulerRegistry();
    const first = registry.producers();
    const second = registry.producers();

    first.set('enrichment.test', { producer: { topic: 'test.topic' }, walker: {} } as any);

    expect(second).toBe(first);
    expect(second.get('enrichment.test')).toBe(first.get('enrichment.test'));
  });

  it('makes stop a no-op when no scheduler is registered', async () => {
    const registry = createHousekeepingSchedulerRegistry();

    await expect(registry.stop()).resolves.toBeUndefined();
    expect(registry.getScheduler()).toBeUndefined();
  });

  it('clears the scheduler ref before awaiting scheduler.stop', async () => {
    const registry = createHousekeepingSchedulerRegistry();
    let observedDuringStop: unknown = 'not-called';
    const scheduler = makeScheduler({
      stop: vi.fn(async () => {
        observedDuringStop = registry.getScheduler();
      }),
    });

    registry.setScheduler(scheduler as any);
    await registry.stop();

    expect(observedDuringStop).toBeUndefined();
    expect(registry.getScheduler()).toBeUndefined();
    expect(scheduler.stop).toHaveBeenCalledOnce();
  });

  it('leaves the scheduler ref cleared when scheduler.stop rejects', async () => {
    const registry = createHousekeepingSchedulerRegistry();
    const error = new Error('stop failed');
    const scheduler = makeScheduler({
      stop: vi.fn(async () => {
        expect(registry.getScheduler()).toBeUndefined();
        throw error;
      }),
    });

    registry.setScheduler(scheduler as any);

    await expect(registry.stop()).rejects.toThrow(error);
    expect(registry.getScheduler()).toBeUndefined();
  });

  it('exports a singleton distinct from isolated test registries', () => {
    const registry = createHousekeepingSchedulerRegistry();

    expect(housekeepingSchedulerRegistry).not.toBe(registry);
    expect(housekeepingSchedulerRegistry.producers()).not.toBe(registry.producers());
  });
});
