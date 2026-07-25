/** R21.1 — vault-state bus + the vault-gated-executors coordinator.
 *
 *  The executor-internal gates are covered in their own suites
 *  (`watch-poll-manager` for the watch race, the scheduler suites for
 *  the tick skips); this pins the RESUME-edge wiring: the bus fans
 *  `KeyManager.onStateChange` to subscribers, and the coordinator kicks
 *  the dormant executors only on the `-> unlocked` transition. */

import { describe, expect, it, vi } from 'vitest';

import { createVaultStateBus } from '../vault-state-bus.js';
import { wireVaultGatedExecutors } from '../vault-gated-executors.js';
import type { ServerAutoRunHandle } from '../auto-run-scheduler.js';
import type { SchedulerHandle } from '../scheduler.js';
import type { PollManagerHandle } from '../watch/poll-manager.js';

describe('vault-state bus', () => {
  it('fans a transition to every subscriber with (next, prev)', () => {
    const bus = createVaultStateBus();
    const a: Array<[string, string]> = [];
    const b: Array<[string, string]> = [];
    bus.subscribe((next, prev) => a.push([next, prev]));
    bus.subscribe((next, prev) => b.push([next, prev]));

    bus.emit('unlocked', 'locked');

    expect(a).toEqual([['unlocked', 'locked']]);
    expect(b).toEqual([['unlocked', 'locked']]);
  });

  it('unsubscribe() stops further delivery to that listener only', () => {
    const bus = createVaultStateBus();
    const seen: string[] = [];
    const off = bus.subscribe((next) => seen.push(`a:${next}`));
    bus.subscribe((next) => seen.push(`b:${next}`));

    bus.emit('locked', 'unlocked');
    off();
    bus.emit('unlocked', 'locked');

    expect(seen).toEqual(['a:locked', 'b:locked', 'b:unlocked']);
  });

  it('a throwing listener is isolated — siblings still fire and emit() never throws', () => {
    const bus = createVaultStateBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('broken consumer');
    });
    bus.subscribe((next) => seen.push(next));

    expect(() => bus.emit('locked', 'unlocked')).not.toThrow();
    expect(seen).toEqual(['locked']);
  });
});

describe('vault-gated-executors coordinator', () => {
  const stubAutoRun = (tick: () => Promise<unknown>): ServerAutoRunHandle =>
    ({ tick } as unknown as ServerAutoRunHandle);
  const stubCron = (tick: () => Promise<unknown>): SchedulerHandle =>
    ({ tick } as unknown as SchedulerHandle);
  const stubWatch = (recompute: () => void): PollManagerHandle =>
    ({ recompute } as unknown as PollManagerHandle);

  it('kicks executors and durable answered-ask recovery on the -> unlocked transition', async () => {
    const bus = createVaultStateBus();
    const autoTick = vi.fn(() => Promise.resolve());
    const cronTick = vi.fn(() => Promise.resolve());
    const recompute = vi.fn();
    const recoverPendingApprovals = vi.fn(() => Promise.resolve());

    wireVaultGatedExecutors({
      vaultStateBus: bus,
      getAutoRunHandle: () => stubAutoRun(autoTick),
      getCronHandle: () => stubCron(cronTick),
      watchManager: stubWatch(recompute),
      recoverPendingApprovals,
    });

    bus.emit('unlocked', 'locked');
    await new Promise((resolve) => setImmediate(resolve));

    expect(autoTick).toHaveBeenCalledTimes(1);
    expect(cronTick).toHaveBeenCalledTimes(1);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(recoverPendingApprovals).toHaveBeenCalledTimes(1);
  });

  it('does NOTHING on a transition to a sealed state', () => {
    const bus = createVaultStateBus();
    const autoTick = vi.fn(() => Promise.resolve());
    const recompute = vi.fn();

    wireVaultGatedExecutors({
      vaultStateBus: bus,
      getAutoRunHandle: () => stubAutoRun(autoTick),
      getCronHandle: () => stubCron(() => Promise.resolve()),
      watchManager: stubWatch(recompute),
    });

    bus.emit('locked', 'unlocked');
    bus.emit('uninitialized', 'locked');

    expect(autoTick).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();
  });

  it('reads handles through the accessors each time (picks up a maintenance rebuild)', async () => {
    const bus = createVaultStateBus();
    const firstTick = vi.fn(() => Promise.resolve());
    const secondTick = vi.fn(() => Promise.resolve());
    let handle = stubAutoRun(firstTick);

    wireVaultGatedExecutors({
      vaultStateBus: bus,
      getAutoRunHandle: () => handle,
      getCronHandle: () => stubCron(() => Promise.resolve()),
      watchManager: undefined,
    });

    bus.emit('unlocked', 'locked');
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstTick).toHaveBeenCalledTimes(1);

    // A maintenance-exit rebuild swaps the live handle behind the accessor.
    handle = stubAutoRun(secondTick);
    bus.emit('unlocked', 'locked');
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondTick).toHaveBeenCalledTimes(1);
    expect(firstTick).toHaveBeenCalledTimes(1);
  });

  it('a rejecting resume kick never throws out of the bus callback', () => {
    const bus = createVaultStateBus();
    wireVaultGatedExecutors({
      vaultStateBus: bus,
      getAutoRunHandle: () => stubAutoRun(() => Promise.reject(new Error('kick failed'))),
      getCronHandle: () => stubCron(() => Promise.reject(new Error('kick failed'))),
      watchManager: stubWatch(() => {
        throw new Error('recompute failed');
      }),
      recoverPendingApprovals: () => Promise.reject(new Error('recovery failed')),
    });

    // recompute() throws synchronously inside the callback; the bus
    // isolates it, so emit() still returns cleanly.
    expect(() => bus.emit('unlocked', 'locked')).not.toThrow();
  });

  it('dispose() detaches — a later unlock kicks nothing', async () => {
    const bus = createVaultStateBus();
    const autoTick = vi.fn(() => Promise.resolve());
    const coordinator = wireVaultGatedExecutors({
      vaultStateBus: bus,
      getAutoRunHandle: () => stubAutoRun(autoTick),
      getCronHandle: () => stubCron(() => Promise.resolve()),
      watchManager: undefined,
    });

    coordinator.dispose();
    bus.emit('unlocked', 'locked');
    await new Promise((resolve) => setImmediate(resolve));

    expect(autoTick).not.toHaveBeenCalled();
  });
});
