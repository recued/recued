import { describe, expect, it, vi } from 'vitest';

import { createStorageGate } from '../gate.js';
import { MIN_RESERVE_BYTES } from '../types.js';

const mb = (n: number) => n * 1024 * 1024;

describe('createStorageGate', () => {
  it('starts in running with reserve carved out', () => {
    const g = createStorageGate({ surface: 'vault', quota: mb(100), reservePct: 2 });
    const info = g.info();
    expect(info.state).toBe('running');
    expect(info.quota).toBe(mb(100));
    // reservePct 2% of 100MB = 2MB, but MIN floor is 10MB, so 10MB wins.
    expect(info.reserve).toBe(MIN_RESERVE_BYTES);
    expect(info.available).toBe(mb(100) - MIN_RESERVE_BYTES);
    expect(info.used).toBe(0);
  });

  it('uses reservePct when it exceeds the 10 MB floor', () => {
    // 5% of 1GB = 50MB — above the 10MB floor.
    const g = createStorageGate({ surface: 'cache', quota: mb(1024), reservePct: 5 });
    expect(g.info().reserve).toBe(Math.floor(mb(1024) * 0.05));
  });

  it('transitions running → pressure_managed at the pressureRatio threshold', () => {
    const events: string[] = [];
    const g = createStorageGate({
      surface: 'cache',
      quota: mb(200),
      reservePct: 5,
      pressureRatio: 0.8,
    });
    g.onStateChange((e) => events.push(`${e.previous}->${e.next}`));

    const { pressureAt, blockedAt } = g.info();
    g.setUsed(pressureAt - 1);
    expect(g.info().state).toBe('running');
    g.setUsed(pressureAt);
    expect(g.info().state).toBe('pressure_managed');

    g.setUsed(blockedAt);
    expect(g.info().state).toBe('writes_blocked');

    expect(events).toEqual([
      'running->pressure_managed',
      'pressure_managed->writes_blocked',
    ]);
  });

  it('emits down-transitions when usage drops', () => {
    const events: string[] = [];
    const g = createStorageGate({ surface: 'cache', quota: mb(200), reservePct: 5 });
    g.onStateChange((e) => events.push(`${e.previous}->${e.next}`));

    const { blockedAt, pressureAt } = g.info();
    g.setUsed(blockedAt + 10);
    g.setUsed(pressureAt + 1);
    g.setUsed(0);

    expect(events).toEqual([
      'running->writes_blocked',
      'writes_blocked->pressure_managed',
      'pressure_managed->running',
    ]);
  });

  it('canWrite rejects user writes at writes_blocked', () => {
    const g = createStorageGate({ surface: 'shared', quota: mb(100), reservePct: 5 });
    const { blockedAt } = g.info();
    g.setUsed(blockedAt);
    const check = g.canWrite(1);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('writes_blocked');
  });

  it('canWrite admits reserve-class writes up to the full quota', () => {
    const g = createStorageGate({ surface: 'audit', quota: mb(100), reservePct: 5 });
    const { blockedAt, quota } = g.info();
    g.setUsed(blockedAt);
    // User write is blocked…
    expect(g.canWrite(1).ok).toBe(false);
    // …but an audit entry can still land inside the reserve.
    expect(g.canWrite(1, { reserve: true }).ok).toBe(true);
    // Even a reserve write is rejected once the full quota is exceeded.
    g.setUsed(quota);
    expect(g.canWrite(1, { reserve: true }).ok).toBe(false);
  });

  it('canWrite flags storage_pressure without blocking in pressure_managed', () => {
    const g = createStorageGate({ surface: 'cache', quota: mb(200), reservePct: 5 });
    const { pressureAt, available } = g.info();
    g.setUsed(pressureAt + 1);
    expect(g.info().state).toBe('pressure_managed');
    // Writes up to the blocked threshold still succeed.
    const space = available - (pressureAt + 1);
    expect(g.canWrite(Math.floor(space / 2)).ok).toBe(true);
    // A write that would push us over the available ceiling is rejected.
    const check = g.canWrite(space + 1);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('storage_pressure');
  });

  it('halt overrides every state and can be resumed', () => {
    const events: string[] = [];
    const g = createStorageGate({ surface: 'cache', quota: mb(200), reservePct: 5 });
    g.onStateChange((e) => events.push(`${e.previous}->${e.next}`));

    g.halt('kill-switch');
    expect(g.info().state).toBe('halted');
    expect(g.info().haltReason).toBe('kill-switch');
    const check = g.canWrite(1);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('halted');
    const reserveCheck = g.canWrite(1, { reserve: true });
    expect(reserveCheck.ok).toBe(false);
    expect(reserveCheck.reason).toBe('halted');

    // While halted, usage updates should not move us back into running.
    g.setUsed(0);
    expect(g.info().state).toBe('halted');

    g.resume();
    expect(g.info().state).toBe('running');
    expect(events.some((e) => e.startsWith('running->halted'))).toBe(true);
    expect(events.some((e) => e.startsWith('halted->running'))).toBe(true);
  });

  it('reconfigure triggers state recomputation', () => {
    const events: string[] = [];
    const g = createStorageGate({ surface: 'data.shared', quota: mb(1000), reservePct: 2 });
    g.onStateChange((e) => events.push(`${e.previous}->${e.next}`));
    g.setUsed(mb(500));
    expect(g.info().state).toBe('running');

    // Shrink the quota — same used, now over threshold.
    g.reconfigure({ quota: mb(600) });
    expect(g.info().state).toBe('pressure_managed');
    expect(events).toContain('running->pressure_managed');
  });

  it('addUsed / subUsed compose to setUsed', () => {
    const g = createStorageGate({ surface: 'shared', quota: mb(100), reservePct: 5 });
    g.addUsed(mb(10));
    g.addUsed(mb(5));
    g.subUsed(mb(3));
    expect(g.info().used).toBe(mb(12));
  });

  it('subUsed never drops below zero', () => {
    const g = createStorageGate({ surface: 'shared', quota: mb(100), reservePct: 5 });
    g.subUsed(mb(999));
    expect(g.info().used).toBe(0);
  });

  it('guards input — negative usage throws', () => {
    const g = createStorageGate({ surface: 's', quota: mb(100), reservePct: 5 });
    expect(() => g.setUsed(-1)).toThrow(/non-negative/);
    expect(() => g.canWrite(-1)).toThrow(/non-negative/);
  });

  it('guards config — invalid quota / reservePct / pressureRatio throw', () => {
    expect(() => createStorageGate({ surface: 's', quota: 0, reservePct: 5 })).toThrow();
    expect(() => createStorageGate({ surface: 's', quota: mb(100), reservePct: 200 })).toThrow();
    expect(() => createStorageGate({ surface: 's', quota: mb(100), reservePct: 5, pressureRatio: 1.5 })).toThrow();
  });

  it('unsubscribe stops delivering events', () => {
    const g = createStorageGate({ surface: 'cache', quota: mb(200), reservePct: 5 });
    const spy = vi.fn();
    const off = g.onStateChange(spy);
    g.setUsed(g.info().pressureAt);
    off();
    g.setUsed(g.info().blockedAt);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('listener exceptions never crash the gate', () => {
    const g = createStorageGate({ surface: 'cache', quota: mb(200), reservePct: 5 });
    g.onStateChange(() => {
      throw new Error('oops');
    });
    expect(() => g.setUsed(g.info().pressureAt)).not.toThrow();
  });

  it('passes the configured now() into events', () => {
    const times = [1, 2, 3];
    const clock = () => times.shift() ?? 0;
    const g = createStorageGate({ surface: 'cache', quota: mb(200), reservePct: 5, now: clock });
    const captured: number[] = [];
    g.onStateChange((e) => captured.push(e.at));
    g.setUsed(g.info().pressureAt);
    g.halt('x');
    expect(captured.slice(0, 2)).toEqual([1, 2]);
  });
});
