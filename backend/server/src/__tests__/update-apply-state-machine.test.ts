import { describe, expect, it } from 'vitest';
import {
  BOOT_FAILURE_THRESHOLD,
  decideRollback,
  shouldAutoRevert,
} from '../update/apply-state-machine.js';

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
