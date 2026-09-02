/** D-178 — the two decisions an update makes when a release misbehaves:
 *  should a failing boot trip an auto-revert, and how should a rollback be
 *  performed (spec § Update machinery, "Rollback × migrations").
 *
 *  Pure decision logic — no fs, no clock, no process.
 *
 *  ⛔⛔ THIS FILE USED TO CARRY AN APPLY LOCK AND A PHASE MACHINE, AND NOTHING
 *  EVER CALLED THEM (removed 2026-09-01). `acquireApply` / `advanceApply` /
 *  `isValidPhaseTransition` / `canRollback` / `APPLY_PHASES` had ZERO production
 *  references — built, typed and tested, driven only by their own unit test.
 *
 *  🔑 AND THEY WERE WORSE THAN DEAD, because they encoded a DIFFERENT POLICY
 *  than the one that ships, in a module whose docblock claimed the orchestrator
 *  drove them:
 *    · one-at-a-time was an in-memory lock that COALESCED a duplicate and
 *      QUEUED one other release. Production excludes with the host-wide
 *      `link()` lease (`update-lease.ts`) and has no queue at all — a second
 *      apply is refused.
 *    · "rollback is refused while an apply is in flight" (I-6) was
 *      `canRollback(state) => !state.inFlight`, over an `ApplyLockState` nothing
 *      maintained. Production derives it from the LEDGER on disk
 *      (`deriveInFlightRelease`), which is the only version that survives a
 *      restart.
 *
 *  So a reader chasing "where is the apply lock?" had three believable answers,
 *  one of which was fiction with tests behind it. Both invariants keep their
 *  coverage on the live paths: I-6 in `apply-orchestrator.test.ts` ("busy"), and
 *  exclusion in `update-lease-concurrency.test.ts`, across real processes.
 *
 *  ⚠ THE FILENAME IS NOW A MISNOMER — there is no state machine here. Renaming
 *  it touches importers a concurrent session is editing, so it is left as a
 *  deliberate follow-up rather than folded into a removal.
 */

/** Consecutive failed boots of an UNCOMMITTED binary before auto-revert. */
export const BOOT_FAILURE_THRESHOLD = 3;

/** Boot-health auto-revert decision: N consecutive failed boots of an
 *  uncommitted binary trips the revert (counted OUTSIDE the DB). */
export const shouldAutoRevert = (
  failedBootCount: number,
  threshold: number = BOOT_FAILURE_THRESHOLD,
): boolean => failedBootCount >= threshold;

export type RollbackAction = 'binary-swap' | 'restore-snapshot' | 'refuse';

export interface RollbackInputs {
  /** The applied (current) release migrated the schema. */
  appliedMigration: boolean;
  /** `recued.old` (the previous binary) is present. */
  hasPreviousBinary: boolean;
  /** A pre-migration SQLite snapshot is present. */
  hasSnapshot: boolean;
}

export interface RollbackDecision {
  action: RollbackAction;
  reason: string;
}

/** Decide how to roll back the current release (spec § Rollback × migrations:
 *  mechanism (c) pre-migration snapshot, guard (b) refuse-past-migration). */
export const decideRollback = (inputs: RollbackInputs): RollbackDecision => {
  if (!inputs.hasPreviousBinary) {
    return { action: 'refuse', reason: 'no previous binary (recued.old) to roll back to' };
  }
  if (inputs.appliedMigration) {
    if (!inputs.hasSnapshot) {
      // Guard (b): a migrating release with no snapshot can't be safely reverted.
      return { action: 'refuse', reason: 'release migrated the schema and no pre-migration snapshot exists' };
    }
    // Mechanism (c): restore the snapshot + binary, accepting post-update write loss.
    return { action: 'restore-snapshot', reason: 'restoring pre-migration snapshot (post-update writes since the migration are lost)' };
  }
  // Plain binary swap for a non-migrating release.
  return { action: 'binary-swap', reason: 'swapping recued.old back (no migration to reverse)' };
};
