/** D-201 Slice 10N — an approved run the server's own stop ended after its
 *  approved step returned, kept for the next start to finish.
 *
 *  The owner's call (2026-11-19): an approved run a restart stops is finished
 *  by the next start without asking again, which an unattended server needs.
 *  When the step had already returned, finishing it must not send the approved
 *  operation a second time. So the value the step left in `step.*` is kept
 *  here, keyed by the checkpoint the owner answered, and the next start resumes
 *  the run at that step with the value standing in for the call
 *  (`resume_from.replayed_result`).
 *
 *  D-201 Slice 10R (10Q finding 1) — nor any step after it. The resume starts at
 *  the approved step's checkpoint, so every step that had finished after it
 *  would otherwise run again: a create that ran unasked was made twice. Each
 *  finished step is kept too, as it came out (`later`), and stands in for its
 *  step (`resume_from.replayed_steps`), with the run's alias ledgers at the stop
 *  (`pii_ledgers`) so the values those steps left still restore. The owner's
 *  call (2026-11-19): the run goes on from the first step that had not started.
 *
 *  A checkpoint is immutable for its lifetime (`CheckpointStore`: only the
 *  owner's argument edits may change one), so this sits beside it rather than
 *  on it. Written only by the host resumer, from its own record of the stop;
 *  removed once the run it continues has run. The answer it continues stays
 *  answered meanwhile, which is what keeps the checkpoint (an answered ask's
 *  checkpoint is never expired).
 *
 *  D-201 Slice 10W — written FIRST (10V finding 3): the resumer keeps the row
 *  from the run's own report of the stop, before the run's record says
 *  `killed`. A kill, or a drain wait that ran out, between the two left a
 *  `killed` run and no row, which the next start ended. Two more kinds:
 *    - `unsent`: the approved step never started. Its receipt goes back to
 *      waiting on the answer at the next start, before it is claimed again.
 *    - `held`: an approved webhook run a stop left IN DOUBT, kept for the
 *      owner's try again from its dead letter, which goes on from the step in
 *      doubt with what went through standing in (10V finding 1; the owner's
 *      call, 2026-11-19). The answer is used up and its checkpoint deleted, so
 *      the row carries its own copy of the checkpoint and the paused record. The
 *      runner continues it (`continueHeldRun`), never the start: only the owner
 *      decides that a step in doubt runs again. A stop during that try again
 *      keeps it here again. The start drops one whose dead letter is gone. */

import type Database from 'better-sqlite3';
import type { ReplayedStep } from '@recued/engine';
import type { Checkpoint, PiiLedgerStoreSnapshot } from '@recued/contracts';
import type { AuditEntry } from '@recued/storage';

export interface ApprovalRestartContinuation {
  checkpoint_id: string;
  run_id: string;
  gated_step_id: string;
  /** What the approved step left in `step.<gated_step_id>`. */
  value: unknown;
  /** D-201 Slice 10R — the steps after the approved one that had finished
   *  before the stop, in the order they ran. `undefined` for a row a server
   *  before 10R wrote, which kept only the approved step: what ran after it is
   *  unknown, so the resumer drops such a row and the run reads in doubt. */
  later: readonly ReplayedStep[] | undefined;
  /** D-201 Slice 10R — the run's alias ledgers at the stop, which the next
   *  start's run continues from (in place of the checkpoint's). */
  pii_ledgers?: PiiLedgerStoreSnapshot;
  /** D-201 Slice 10W — the approved step never started: nothing to replay. */
  unsent?: true;
  /** D-201 Slice 10W (10V finding 3) — the run's paused record, which the next
   *  start puts back when the process went before the resumer did. */
  paused_anchor?: AuditEntry;
  /** D-201 Slice 10W — held for the owner's try again (see the module note). */
  held?: ApprovalRestartHeldRun;
  /** D-201 Slice 10AG — kept by a restart that stopped the resume an answer
   *  made to a held try again's ask: the held run it was. The next start's
   *  finish holds a later failure again from the step that failed, and an
   *  unsent row is held again as it was for the answer's replay. Without it
   *  that finish ran as any approved run's, and a later failure cancelled the
   *  delivery. */
  held_before?: ApprovalRestartHeldRun;
  /** D-201 Slice 10BO (10BM finding 7) — kept for the next start (`returned`)
   *  past an approved step that was skipped: the next start replays it as
   *  skipped, so every row past it says so. */
  approved_skipped?: true;
  created_at: number;
}

/** D-201 Slice 10W — what the owner's try again of an approved run left in
 *  doubt goes on from. */
export interface ApprovalRestartHeldRun {
  /** The answered checkpoint, as it was: the run resumes from it. */
  readonly checkpoint: Checkpoint;
  /** The run's paused record, which the resume is built from. */
  readonly anchor: AuditEntry;
  /** Whether the approved step came back (its value is `value`). When it did
   *  not, the try again asks the owner for it afresh. */
  readonly approved_returned: boolean;
  /** The step in doubt: the one the try again runs again, the only one that
   *  can run twice. The dead letter names it. */
  readonly step_in_doubt: string;
  /** A process went without a drain (a crash): how far the run got past the
   *  approved step is unknown, so the steps after it may run again too.
   *  D-201 Slice 10AB (10AA finding 1) — also when the process went during the
   *  owner's try again: the try again may have gone past the step in doubt. */
  readonly progress_unknown?: true;
  /** D-201 Slice 10AB (10AA finding 2) — the owner's try again failed rather
   *  than stopped: `step_in_doubt` is the step it failed at (or, when nothing
   *  ran, where it stood), and the next try again goes on from it. */
  readonly failed?: true;
  /** D-201 Slice 10BC (10AY findings 2, 9 and 11) — the run went past the step
   *  in doubt and Recued could not keep what ran after it, so the try again
   *  runs again each step after it that went through, not that step alone. Set
   *  when the approved step is held at itself once the run went past it (a
   *  loop, a chunked upload, a resume bound to an egress budget or a resource
   *  review, or a hand-off its receipt cannot prove), and on a row a later
   *  write could not replace (`markLaterRunAgain`). Carried as
   *  `progress_unknown` is, which says the same after a death with no row. */
  readonly later_run_again?: true;
  /** D-201 Slice 10BH (the owner's call, 2026-11-21) — the approved step is a
   *  loop, kept once it finished (`approved_returned`): the start settles its
   *  receipt item by item from the kept value. */
  readonly approved_foreach?: true;
  /** D-201 Slice 10BJ (10BF finding 9) — the approved step was skipped
   *  (`approved_returned`): the start settles its receipt as skipped, as the
   *  live stop does, and reads a cancelled receipt as gone through. The row
   *  dropped it, and the start settled the skipped step as one that ran. */
  readonly approved_skipped?: true;
  /** D-201 Slice 10BI (10BF finding 5) — held at the approved step for a
   *  hand-off its receipt cannot check: the step returned, having handed its
   *  work on; only the hand-off is unproven. Its words say so, where they said
   *  Recued could not keep what the step did. */
  readonly handoff_unproven?: true;
  /** D-201 Slice 10BO (10BM finding 2) — written ahead (`approved_returned`) by
   *  the run that ran the approved step, before its receipt was settled. A stop
   *  or the start that settles it after holds the run at that step where its
   *  hand-off is unproven, and the try again reads the receipt of such a row,
   *  in case that hold could not be written (`heldAsItsReceiptReads`). A row
   *  written once the receipt was settled (a failure's, a try again's) stands
   *  as it was written: the run went on past the step and the try again goes on
   *  from the step that row names. */
  readonly receipt_unsettled?: true;
}

export interface ApprovalRestartContinuationStore {
  /** Keep (or replace) what one answered checkpoint's run had done. Throws
   *  when it cannot be stored as JSON: the caller then treats the run as in
   *  doubt. */
  put(row: Omit<ApprovalRestartContinuation, 'created_at' | 'later'> & {
    later: readonly ReplayedStep[];
  }): void;
  /** D-201 Slice 10AK (10AI finding 15) — move a held run's row to another
   *  ask: `row` written and the one at `from_checkpoint_id` gone, in one
   *  transaction. A fault leaves the row where it was, never both: the newest
   *  of two is read by the clock, then by id (`getHeldForRun`). */
  move(from_checkpoint_id: string, row: Omit<ApprovalRestartContinuation, 'created_at' | 'later'> & {
    later: readonly ReplayedStep[];
  }): void;
  get(checkpoint_id: string): ApprovalRestartContinuation | null;
  delete(checkpoint_id: string): void;
  /** D-201 Slice 10R (10Q finding 17) — every kept checkpoint id, for the
   *  start's sweep of rows whose checkpoint is gone. D-201 Slice 10W — not the
   *  held ones: their checkpoint is gone by design. */
  list(): string[];
  /** D-201 Slice 10W — the held row of a run, if any (the newest). */
  getHeldForRun(run_id: string): ApprovalRestartContinuation | null;
  /** D-201 Slice 10W — every held run, for the start's sweep. */
  listHeld(): Array<{ checkpoint_id: string; run_id: string }>;
  /** D-201 Slice 10AB (10AA finding 6) — whether a run has a row kept for the
   *  next start to finish (not a held one): the start's replay of its answer
   *  finishes it, so the delivery it belongs to waits for that. */
  hasKeptForRun(run_id: string): boolean;
  /** D-201 Slice 10BC (10AY finding 9) — mark a held row `later_run_again`,
   *  writing nothing else: the run went past it and its next row was refused.
   *  The values it kept are not stored again, so a step value that cannot be
   *  stored, which refused that row, does not refuse this. Whether a held row
   *  was marked. */
  markLaterRunAgain(checkpoint_id: string): boolean;
}

export const APPROVAL_RESTART_CONTINUATIONS_TABLE = 'approval_restart_continuations';

/** A held run as stored, only when it reads whole. */
const wholeHeldRun = (value: unknown): ApprovalRestartHeldRun | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const held = value as Partial<ApprovalRestartHeldRun>;
  return typeof held.checkpoint === 'object' && held.checkpoint !== null
    && typeof held.anchor === 'object' && held.anchor !== null
    && typeof held.approved_returned === 'boolean'
    && typeof held.step_in_doubt === 'string'
    ? held as ApprovalRestartHeldRun
    : undefined;
};

export const createApprovalRestartContinuationStore = (
  db: Database.Database,
  now: () => number = Date.now,
): ApprovalRestartContinuationStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS ${APPROVAL_RESTART_CONTINUATIONS_TABLE} (
    checkpoint_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    gated_step_id TEXT NOT NULL,
    value_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_approval_restart_continuations_run
    ON ${APPROVAL_RESTART_CONTINUATIONS_TABLE} (run_id)`);
  const upsert = db.prepare(`
    INSERT INTO ${APPROVAL_RESTART_CONTINUATIONS_TABLE}
      (checkpoint_id, run_id, gated_step_id, value_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(checkpoint_id) DO UPDATE SET
      run_id = excluded.run_id,
      gated_step_id = excluded.gated_step_id,
      value_json = excluded.value_json,
      created_at = excluded.created_at
  `);
  const select = db.prepare(`
    SELECT checkpoint_id, run_id, gated_step_id, value_json, created_at
    FROM ${APPROVAL_RESTART_CONTINUATIONS_TABLE} WHERE checkpoint_id = ?
  `);
  const remove = db.prepare(`DELETE FROM ${APPROVAL_RESTART_CONTINUATIONS_TABLE} WHERE checkpoint_id = ?`);
  const ids = db.prepare(`
    SELECT checkpoint_id FROM ${APPROVAL_RESTART_CONTINUATIONS_TABLE}
    WHERE json_extract(value_json, '$.held') IS NULL
  `);
  const heldIds = db.prepare(`
    SELECT checkpoint_id, run_id FROM ${APPROVAL_RESTART_CONTINUATIONS_TABLE}
    WHERE json_extract(value_json, '$.held') IS NOT NULL
  `);
  const heldForRun = db.prepare(`
    SELECT checkpoint_id FROM ${APPROVAL_RESTART_CONTINUATIONS_TABLE}
    WHERE run_id = ? AND json_extract(value_json, '$.held') IS NOT NULL
    ORDER BY created_at DESC, checkpoint_id DESC LIMIT 1
  `);
  const keptForRun = db.prepare(`
    SELECT 1 FROM ${APPROVAL_RESTART_CONTINUATIONS_TABLE}
    WHERE run_id = ? AND json_extract(value_json, '$.held') IS NULL LIMIT 1
  `);
  const markLater = db.prepare(`
    UPDATE ${APPROVAL_RESTART_CONTINUATIONS_TABLE}
    SET value_json = json_set(value_json, '$.held.later_run_again', json('true'))
    WHERE checkpoint_id = ? AND json_extract(value_json, '$.held') IS NOT NULL
  `);
  const store: ApprovalRestartContinuationStore = {
    put(row) {
      if (row.checkpoint_id.length === 0 || row.run_id.length === 0 || row.gated_step_id.length === 0) {
        throw new Error('an approval restart continuation needs its checkpoint, run and step');
      }
      // Wrapped, so a null or absent value survives the round trip. `later` is
      // always written: its absence is how a row from before 10R reads.
      const json = JSON.stringify({
        ...(row.value === undefined ? {} : { value: row.value }),
        later: row.later.map((step) => ({
          step_id: step.step_id,
          skipped: step.skipped,
          ...(step.skipped || step.value === undefined ? {} : { value: step.value }),
        })),
        ...(row.pii_ledgers === undefined ? {} : { pii_ledgers: row.pii_ledgers }),
        ...(row.unsent === true ? { unsent: true } : {}),
        ...(row.paused_anchor === undefined ? {} : { paused_anchor: row.paused_anchor }),
        ...(row.held === undefined ? {} : { held: row.held }),
        ...(row.held_before === undefined ? {} : { held_before: row.held_before }),
        ...(row.approved_skipped === true ? { approved_skipped: true } : {}),
      });
      if (typeof json !== 'string') throw new Error('the step value cannot be stored');
      upsert.run(row.checkpoint_id, row.run_id, row.gated_step_id, json, now());
    },
    move(fromCheckpointId, row) {
      db.transaction(() => {
        store.put(row);
        if (fromCheckpointId !== row.checkpoint_id) remove.run(fromCheckpointId);
      })();
    },
    get(checkpointId) {
      const row = select.get(checkpointId) as {
        checkpoint_id: string;
        run_id: string;
        gated_step_id: string;
        value_json: string;
        created_at: number;
      } | undefined;
      if (row === undefined) return null;
      const parsed = JSON.parse(row.value_json) as {
        value?: unknown;
        later?: ReadonlyArray<{ step_id?: unknown; skipped?: unknown; value?: unknown }>;
        pii_ledgers?: PiiLedgerStoreSnapshot;
        unsent?: unknown;
        paused_anchor?: unknown;
        held?: unknown;
        held_before?: unknown;
        approved_skipped?: unknown;
      };
      // A held row that does not read whole is no held row: the try again
      // then runs as before 10W, never from half a record.
      const held = wholeHeldRun(parsed.held);
      const heldBefore = wholeHeldRun(parsed.held_before);
      // A malformed list is as unknown as a missing one.
      const later = Array.isArray(parsed.later)
        && parsed.later.every((step) => typeof step?.step_id === 'string' && typeof step.skipped === 'boolean')
        ? parsed.later.map((step): ReplayedStep => ({
          step_id: step.step_id as string,
          skipped: step.skipped as boolean,
          ...(Object.hasOwn(step, 'value') ? { value: step.value } : {}),
        }))
        : undefined;
      return {
        checkpoint_id: row.checkpoint_id,
        run_id: row.run_id,
        gated_step_id: row.gated_step_id,
        value: Object.hasOwn(parsed, 'value') ? parsed.value : undefined,
        later,
        ...(parsed.pii_ledgers === undefined ? {} : { pii_ledgers: parsed.pii_ledgers }),
        ...(parsed.unsent === true ? { unsent: true as const } : {}),
        ...(typeof parsed.paused_anchor === 'object' && parsed.paused_anchor !== null
          ? { paused_anchor: parsed.paused_anchor as AuditEntry }
          : {}),
        ...(held === undefined ? {} : { held }),
        ...(heldBefore === undefined ? {} : { held_before: heldBefore }),
        ...(parsed.approved_skipped === true ? { approved_skipped: true as const } : {}),
        created_at: row.created_at,
      };
    },
    delete(checkpointId) {
      remove.run(checkpointId);
    },
    list() {
      return (ids.all() as Array<{ checkpoint_id: string }>).map((row) => row.checkpoint_id);
    },
    getHeldForRun(runId) {
      const row = heldForRun.get(runId) as { checkpoint_id: string } | undefined;
      return row === undefined ? null : store.get(row.checkpoint_id);
    },
    listHeld() {
      return heldIds.all() as Array<{ checkpoint_id: string; run_id: string }>;
    },
    hasKeptForRun(runId) {
      return keptForRun.get(runId) !== undefined;
    },
    markLaterRunAgain(checkpointId) {
      return markLater.run(checkpointId).changes > 0;
    },
  };
  return store;
};

/** D-201 Slice 10W — drop a held run whose dead letter is gone: the owner
 *  closed it, the review limit or its webhook's retirement did, or the try
 *  again ran it. What it kept goes too (`release`: its temp files and "Yes,
 *  this time" pre-approvals). Best effort, row by row; run by the start. */
export const sweepHeldApprovalRuns = (deps: {
  continuations: ApprovalRestartContinuationStore;
  /** Whether the run still waits on the owner: an open dead letter, or a
   *  delivery still running or queued, carries it. */
  stillHeld: (runId: string) => boolean;
  release: (runId: string) => void;
}): number => {
  let removed = 0;
  for (const row of deps.continuations.listHeld()) {
    try {
      if (deps.stillHeld(row.run_id)) continue;
      deps.continuations.delete(row.checkpoint_id);
      deps.release(row.run_id);
      removed += 1;
    } catch {
      // The next start sweeps again.
    }
  }
  return removed;
};

/** D-201 Slice 10AB — what the webhook outbox's passes ask of the runs a
 *  restart kept or held: whether a run waits for the start's replay of its
 *  answer to finish it (10AA finding 6: the reconciler made it a dead letter
 *  the replay then contradicted), and a sweep of held runs whose dead letter is
 *  gone, so a closed one's held copy (its checkpoint, the decoded payload and
 *  what was read) goes within a pass rather than at the next start (10AA
 *  finding 14). Without a continuation store, nothing is kept or held. */
export interface HeldRunPass {
  hasKeptRun(runId: string): boolean;
  /** D-201 Slice 10AG (10AE finding 2) — whether the run is held for the
   *  owner's try again, its resume having failed: the answer to an ask its try
   *  again paused at, failing later, is its dead letter again. D-201 Slice 10AK
   *  (10AI finding 11) — only a held row marked failed: one at an ask that
   *  expired, or whose resume was refused before it ran, ends as any run does.
   *  It said held for any held row, so those read as the server restarting. */
  isHeldFailure(runId: string): boolean;
  sweep(): number;
}

export const createHeldRunPass = (deps: {
  continuations: ApprovalRestartContinuationStore | undefined;
  stillHeld: (runId: string) => boolean;
  release: (runId: string) => void;
}): HeldRunPass => ({
  hasKeptRun: (runId) => deps.continuations?.hasKeptForRun(runId) === true,
  isHeldFailure: (runId) => deps.continuations?.getHeldForRun(runId)?.held?.failed === true,
  sweep: () => (deps.continuations === undefined
    ? 0
    : sweepHeldApprovalRuns({
      continuations: deps.continuations,
      stillHeld: deps.stillHeld,
      release: deps.release,
    })),
});

/** D-201 Slice 10R (10Q finding 17) — drop what a restart kept for a
 *  checkpoint that is gone: its answer was consumed (the run finished,
 *  failed, was refused or denied), expired, or swept, so nothing will resume
 *  it. Best effort, row by row; run by the start after the ask sweep. */
export const sweepApprovalRestartContinuations = async (deps: {
  continuations: ApprovalRestartContinuationStore;
  hasCheckpoint: (checkpointId: string) => Promise<boolean>;
}): Promise<number> => {
  let removed = 0;
  for (const checkpointId of deps.continuations.list()) {
    try {
      if (await deps.hasCheckpoint(checkpointId)) continue;
      deps.continuations.delete(checkpointId);
      removed += 1;
    } catch {
      // The next start sweeps again.
    }
  }
  return removed;
};
