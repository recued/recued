/** D-178 slice 3 — the two-phase apply state machine + update lock + boot-health
 *  auto-revert + rollback×migration decision (spec § Update machinery,
 *  "Two-phase apply", "One update at a time", § Rollback × migrations).
 *
 *  Pure decision logic — no fs, no clock, no process. The orchestrator (slice
 *  3b) drives the real download/verify/swap/restart against these transitions
 *  and persists the lock state + boot-failure counter in the update LEDGER (so
 *  they survive crash loops + snapshot restores).
 *
 *  Invariants encoded here:
 *    - ONE update at a time (host-wide lock keyed by release identity):
 *      concurrent triggers for the SAME release coalesce; a DIFFERENT release
 *      arriving mid-apply queues behind commit/revert; a third is refused.
 *    - Rollback is refused while an apply is in flight (so `recued.old` is
 *      never overwritten mid-swap — I-6).
 *    - Apply is stage → boot → commit; a binary that fails its boot-health
 *      probe N consecutive times auto-reverts to `recued.old` (signatures
 *      prove authenticity, not boot health).
 *    - Rollback past a migrating release restores the pre-migration snapshot
 *      (mechanism c) and refuses if no snapshot exists (guard b).
 */

/** Consecutive failed boots of an UNCOMMITTED binary before auto-revert. */
export const BOOT_FAILURE_THRESHOLD = 3;

export const APPLY_PHASES = ['staging', 'staged', 'booting', 'committed', 'reverting', 'reverted'] as const;
export type ApplyPhase = (typeof APPLY_PHASES)[number];

/** Terminal phases — the in-flight slot frees once one is reached. */
const TERMINAL: ReadonlySet<ApplyPhase> = new Set<ApplyPhase>(['committed', 'reverted']);

/** Legal forward transitions. `staged → reverting` covers a stage-time abort;
 *  `booting → reverting` covers a boot-health failure. */
const NEXT: Record<ApplyPhase, readonly ApplyPhase[]> = {
  staging: ['staged', 'reverting'],
  staged: ['booting', 'reverting'],
  booting: ['committed', 'reverting'],
  committed: [],
  reverting: ['reverted'],
  reverted: [],
};

export const isValidPhaseTransition = (from: ApplyPhase, to: ApplyPhase): boolean =>
  NEXT[from].includes(to);

export interface ApplyLockState {
  /** The apply currently holding the host-wide lock. */
  inFlight?: { releaseIdentity: string; phase: ApplyPhase };
  /** A single release queued behind the in-flight one. */
  queued?: { releaseIdentity: string };
}

export type AcquireDecision = 'acquired' | 'coalesced' | 'queued' | 'busy-queue-full';

export interface AcquireResult {
  decision: AcquireDecision;
  state: ApplyLockState;
}

/** Request the apply lock for `releaseIdentity`. */
export const acquireApply = (state: ApplyLockState, releaseIdentity: string): AcquireResult => {
  if (!state.inFlight) {
    return { decision: 'acquired', state: { inFlight: { releaseIdentity, phase: 'staging' } } };
  }
  if (state.inFlight.releaseIdentity === releaseIdentity) {
    return { decision: 'coalesced', state };
  }
  if (state.queued) {
    // Already an in-flight + a queued release; refuse a third (no unbounded queue).
    if (state.queued.releaseIdentity === releaseIdentity) return { decision: 'coalesced', state };
    return { decision: 'busy-queue-full', state };
  }
  return { decision: 'queued', state: { ...state, queued: { releaseIdentity } } };
};

/** Advance the in-flight apply to `to`. Throws on an illegal transition or no
 *  in-flight apply — callers drive phases in order. Pass `expectedReleaseIdentity`
 *  to bind the call to a specific release (defense-in-depth: a stale advance from
 *  a just-committed release must not drive a freshly-promoted queued one). */
export const advanceApply = (
  state: ApplyLockState,
  to: ApplyPhase,
  expectedReleaseIdentity?: string,
): ApplyLockState => {
  if (!state.inFlight) throw new Error('advanceApply: no apply in flight');
  if (expectedReleaseIdentity !== undefined && state.inFlight.releaseIdentity !== expectedReleaseIdentity) {
    throw new Error(
      `advanceApply: release mismatch (in-flight ${state.inFlight.releaseIdentity}, expected ${expectedReleaseIdentity})`,
    );
  }
  if (!isValidPhaseTransition(state.inFlight.phase, to)) {
    throw new Error(`advanceApply: illegal transition ${state.inFlight.phase} → ${to}`);
  }
  const next: ApplyLockState = { ...state, inFlight: { ...state.inFlight, phase: to } };
  // On a terminal phase the lock frees; a queued release is promoted to in-flight.
  if (TERMINAL.has(to)) {
    if (state.queued) {
      return { inFlight: { releaseIdentity: state.queued.releaseIdentity, phase: 'staging' } };
    }
    return {};
  }
  return next;
};

/** Rollback is allowed only when no apply is in flight (I-6). */
export const canRollback = (state: ApplyLockState): boolean => !state.inFlight;

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
