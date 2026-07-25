/** D-122 Phase 4.5 — single substrate constant.
 *
 *  Pre-rip versions of this file held the tiered-backfill scheduler
 *  knobs (`BACKFILL_CLASSES`, `BACKFILL_HOT_DAYS`,
 *  `RECORD_BUDGET_*`, `BACKFILL_QUOTA_FLOOR_PCT`,
 *  `BACKFILL_PAUSE_HOURS`, `BACKFILL_TICK_MS`,
 *  `BACKFILL_BATCH_SIZE_DEFAULT`, `BACKFILL_MAX_IN_FLIGHT_DEFAULT`).
 *  Removed pre-launch with the runs_on rip — see decisions-log
 *  D-122 amendment.
 *
 *  Today only the time-relative-watcher's sweeper cadence lives
 *  here. The file name is kept (rather than renamed) because the
 *  spec's Phase 4.5 file-touched list points at it.
 *
 *  Spec: docs/d-122-spec.md.
 */

/** Time-relative-watcher sweeper interval — the per-tick cadence at
 *  which the time-anchored sweeper checks every registered watcher's
 *  collection for records crossing an offset boundary in the next
 *  window. Matches the standard server background-loop cadence so all
 *  timers fire on the same heartbeat. */
export const TIME_RELATIVE_SWEEP_MS = 60_000;
