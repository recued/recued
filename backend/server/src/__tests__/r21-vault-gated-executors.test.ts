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

  it('reports every failed resume kick without throwing out of the bus callback', async () => {
    const bus = createVaultStateBus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wireVaultGatedExecutors({
      vaultStateBus: bus,
      getAutoRunHandle: () => stubAutoRun(() => Promise.reject(new Error('auto failed'))),
      getCronHandle: () => stubCron(() => Promise.reject(new Error('cron failed'))),
      watchManager: stubWatch(() => {
        throw new Error('watch failed');
      }),
      recoverPendingApprovals: () => Promise.reject(new Error('approval failed')),
    });

    expect(() => bus.emit('unlocked', 'locked')).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith('[vault-resume] auto-run resume failed: auto failed');
    expect(warn).toHaveBeenCalledWith('[vault-resume] cron resume failed: cron failed');
    expect(warn).toHaveBeenCalledWith(
      '[vault-resume] pending approval recovery failed: approval failed',
    );
    expect(warn).toHaveBeenCalledWith('[vault-resume] watch resume failed: watch failed');
    warn.mockRestore();
  });

  it('a broken logger cannot prevent sibling resume actions', async () => {
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
      log: () => { throw new Error('logger unavailable'); },
    });

    expect(() => bus.emit('unlocked', 'locked')).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(autoTick).toHaveBeenCalledOnce();
    expect(cronTick).toHaveBeenCalledOnce();
    expect(recompute).toHaveBeenCalledOnce();
    expect(recoverPendingApprovals).toHaveBeenCalledOnce();
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

    await coordinator.dispose();
    bus.emit('unlocked', 'locked');
    await new Promise((resolve) => setImmediate(resolve));

    expect(autoTick).not.toHaveBeenCalled();
  });

  it('dispose closes admission and waits for admitted approval recovery', async () => {
    const bus = createVaultStateBus();
    let releaseRecovery!: () => void;
    const recoverPendingApprovals = vi.fn(() =>
      new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      }));
    const coordinator = wireVaultGatedExecutors({
      vaultStateBus: bus,
      getAutoRunHandle: () => undefined,
      getCronHandle: () => undefined,
      watchManager: undefined,
      recoverPendingApprovals,
    });

    bus.emit('unlocked', 'locked');
    expect(recoverPendingApprovals).toHaveBeenCalledTimes(1);
    let disposed = false;
    const firstDispose = coordinator.dispose();
    expect(coordinator.dispose()).toBe(firstDispose);
    const observed = firstDispose.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    bus.emit('unlocked', 'locked');
    expect(recoverPendingApprovals).toHaveBeenCalledTimes(1);
    releaseRecovery();
    await observed;
  });
});
