import { describe, expect, it } from 'vitest';
import {
  acquireApply,
  advanceApply,
  BOOT_FAILURE_THRESHOLD,
  canRollback,
  decideRollback,
  isValidPhaseTransition,
  shouldAutoRevert,
  type ApplyLockState,
} from '../update/apply-state-machine.js';

describe('apply lock (one update at a time)', () => {
  it('acquires when idle', () => {
    const r = acquireApply({}, 'rel-A');
    expect(r.decision).toBe('acquired');
    expect(r.state.inFlight).toEqual({ releaseIdentity: 'rel-A', phase: 'staging' });
  });

  it('coalesces a duplicate trigger for the same release', () => {
    const { state } = acquireApply({}, 'rel-A');
    expect(acquireApply(state, 'rel-A').decision).toBe('coalesced');
  });

  it('queues a different release behind the in-flight one, refuses a third', () => {
    const a = acquireApply({}, 'rel-A').state;
    const b = acquireApply(a, 'rel-B');
    expect(b.decision).toBe('queued');
    expect(b.state.queued).toEqual({ releaseIdentity: 'rel-B' });
    expect(acquireApply(b.state, 'rel-C').decision).toBe('busy-queue-full');
    // re-requesting the queued release coalesces
    expect(acquireApply(b.state, 'rel-B').decision).toBe('coalesced');
  });
});

describe('phase transitions', () => {
  it('enforces the legal stage→boot→commit order', () => {
    expect(isValidPhaseTransition('staging', 'staged')).toBe(true);
    expect(isValidPhaseTransition('staged', 'booting')).toBe(true);
    expect(isValidPhaseTransition('booting', 'committed')).toBe(true);
    expect(isValidPhaseTransition('staging', 'committed')).toBe(false);
    expect(isValidPhaseTransition('committed', 'booting')).toBe(false);
  });

  it('advances and throws on an illegal jump', () => {
    let s: ApplyLockState = acquireApply({}, 'rel-A').state;
    s = advanceApply(s, 'staged');
    expect(s.inFlight?.phase).toBe('staged');
    expect(() => advanceApply(s, 'committed')).toThrow(/illegal transition/);
  });

  it('binds advance to a release identity when given (defense-in-depth)', () => {
    const s = acquireApply({}, 'rel-A').state;
    expect(() => advanceApply(s, 'staged', 'rel-B')).toThrow(/release mismatch/);
    expect(advanceApply(s, 'staged', 'rel-A').inFlight?.phase).toBe('staged');
  });

  it('frees the lock on commit and promotes a queued release', () => {
    let s = acquireApply({}, 'rel-A').state;
    s = acquireApply(s, 'rel-B').state; // queue rel-B
    s = advanceApply(s, 'staged');
    s = advanceApply(s, 'booting');
    s = advanceApply(s, 'committed');
    expect(s.inFlight).toEqual({ releaseIdentity: 'rel-B', phase: 'staging' });
    expect(s.queued).toBeUndefined();
  });

  it('frees the lock entirely on commit with nothing queued', () => {
    let s = acquireApply({}, 'rel-A').state;
    s = advanceApply(s, 'reverting');
    s = advanceApply(s, 'reverted');
    expect(s.inFlight).toBeUndefined();
  });
});

describe('rollback gating', () => {
  it('refuses rollback while an apply is in flight (I-6)', () => {
    expect(canRollback({})).toBe(true);
    expect(canRollback(acquireApply({}, 'rel-A').state)).toBe(false);
  });
});

describe('boot-health auto-revert', () => {
  it('trips at the threshold', () => {
    expect(shouldAutoRevert(BOOT_FAILURE_THRESHOLD - 1)).toBe(false);
    expect(shouldAutoRevert(BOOT_FAILURE_THRESHOLD)).toBe(true);
    expect(shouldAutoRevert(5)).toBe(true);
  });
});

describe('rollback × migration decision', () => {
  it('plain binary swap for a non-migrating release', () => {
    expect(decideRollback({ appliedMigration: false, hasPreviousBinary: true, hasSnapshot: false }).action)
      .toBe('binary-swap');
  });
  it('restores the snapshot past a migration', () => {
    expect(decideRollback({ appliedMigration: true, hasPreviousBinary: true, hasSnapshot: true }).action)
      .toBe('restore-snapshot');
  });
  it('refuses past a migration with no snapshot (guard b)', () => {
    expect(decideRollback({ appliedMigration: true, hasPreviousBinary: true, hasSnapshot: false }).action)
      .toBe('refuse');
  });
  it('refuses when there is no previous binary', () => {
    expect(decideRollback({ appliedMigration: false, hasPreviousBinary: false, hasSnapshot: true }).action)
      .toBe('refuse');
  });
});
