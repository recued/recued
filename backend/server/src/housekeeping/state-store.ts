/** D-123 Phase 1 — Per-task housekeeping state store.
 *
 *  Per-task cursor + last-run telemetry. Same shape as
 *  `calendar_watcher_cursors`: SQLite-backed, JSON-serialized
 *  cursor in a single text column, no migration scaffolding (the
 *  closed `HousekeepingCursor` discriminator is the schema).
 *
 *  Spec: D-123 §1.2. */

import type Database from 'better-sqlite3';

import type {
  HousekeepingCursor,
  HousekeepingLastStatus,
  HousekeepingStateRow,
  HousekeepingYieldReason,
} from '@recued/contracts';

import { ensureHousekeepingSchema } from './schema.js';

export interface HousekeepingStateUpdate {
  task_id: string;
  cursor: HousekeepingCursor;
  last_status: HousekeepingLastStatus;
  last_run_at?: number;
  last_run_duration_ms?: number;
  last_yield_reason?: HousekeepingYieldReason;
  consecutive_errors?: number;
  last_error?: string;
}

export interface HousekeepingStateStore {
  /** Read a task's persisted state. Returns `null` if the task has
   *  never been stepped — caller seeds a fresh row on first run
   *  with cursor `{ kind: 'complete' }` or a task-specific shape. */
  get(task_id: string): HousekeepingStateRow | null;
  /** Read every persisted task row. Used by the Settings UI's
   *  status table + the topo-sort dependency check. */
  list(): ReadonlyArray<HousekeepingStateRow>;
  /** Write a task's full state — overwrites any prior row. The
   *  scheduler calls this once per `step()` invocation to checkpoint
   *  cursor + telemetry. Optional fields absent in the update map
   *  to NULL in storage (so a successful run clears the prior
   *  `last_error`). */
  set(update: HousekeepingStateUpdate): void;
  /** Increment a task's `consecutive_errors` and stamp `last_error`.
   *  Returns the new error count so the scheduler can decide whether
   *  to flip `last_status: 'error'` (per
   *  `HOUSEKEEPING_DISABLE_AFTER_FAILURES`). */
  recordError(task_id: string, error_message: string, now: number): number;
  /** Reset a task's error counter + status to `'pending'`. Called
   *  when the auto-retry window elapses or when the user clicks
   *  Reset in the Settings UI. */
  resetError(task_id: string): void;
  /** D-123 P6 — flip `last_status` from `'complete'` → `'pending'`
   *  when a cascade-engine invalidation hint matches a task. The
   *  notifier (`createHousekeepingInvalidator`) calls this for every
   *  task whose `onInvalidate` hook is defined so the next idle
   *  cycle picks it up. Idempotent for `'pending'` / no-op for
   *  `'in_progress'` / `'error'` (the scheduler handles those via
   *  its own paths). Errors are not cleared — a task in `'error'`
   *  state stays disabled until the auto-retry window or user reset. */
  markPendingForInvalidation(task_id: string): void;
  /** Drop a task's row entirely. Called on task deregistration so
   *  stale state doesn't accumulate. */
  clear(task_id: string): void;
  /** R13 T1-Q1 — read the persisted whole-cycle clock (the moment the
   *  last idle cycle finished). `null` iff no cycle has ever completed
   *  on this server. The scheduler seeds its in-memory clock from this
   *  at construction so a restart honours `cycle_interval_minutes`
   *  instead of firing on the first idle probe. */
  getCycleClock(): number | null;
  /** R13 T1-Q1 — persist the whole-cycle clock. Called once per
   *  completed cycle. Singleton row — overwrites the prior value. */
  setCycleClock(ts: number): void;
}

interface Row {
  task_id: string;
  cursor_json: string;
  last_run_at: number | null;
  last_run_duration_ms: number | null;
  last_yield_reason: string | null;
  last_status: string;
  consecutive_errors: number;
  last_error: string | null;
}

const rowToState = (row: Row): HousekeepingStateRow => ({
  task_id: row.task_id,
  cursor: JSON.parse(row.cursor_json) as HousekeepingCursor,
  ...(row.last_run_at != null ? { last_run_at: row.last_run_at } : {}),
  ...(row.last_run_duration_ms != null
    ? { last_run_duration_ms: row.last_run_duration_ms }
    : {}),
  ...(row.last_yield_reason != null
    ? { last_yield_reason: row.last_yield_reason as HousekeepingYieldReason }
    : {}),
  last_status: row.last_status as HousekeepingLastStatus,
  consecutive_errors: row.consecutive_errors,
  ...(row.last_error != null ? { last_error: row.last_error } : {}),
});

export const createHousekeepingStateStore = (db: Database.Database): HousekeepingStateStore => {
  ensureHousekeepingSchema(db);

  const getStmt = db.prepare(`SELECT * FROM housekeeping_state WHERE task_id = ?`);
  const listStmt = db.prepare(`SELECT * FROM housekeeping_state ORDER BY task_id ASC`);
  const deleteStmt = db.prepare(`DELETE FROM housekeeping_state WHERE task_id = ?`);

  const setStmt = db.prepare(`
    INSERT INTO housekeeping_state (
      task_id, cursor_json, last_run_at, last_run_duration_ms,
      last_yield_reason, last_status, consecutive_errors, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      cursor_json = excluded.cursor_json,
      last_run_at = excluded.last_run_at,
      last_run_duration_ms = excluded.last_run_duration_ms,
      last_yield_reason = excluded.last_yield_reason,
      last_status = excluded.last_status,
      consecutive_errors = excluded.consecutive_errors,
      last_error = excluded.last_error
  `);

  const recordErrorStmt = db.prepare(`
    INSERT INTO housekeeping_state (
      task_id, cursor_json, last_run_at, last_status,
      consecutive_errors, last_error
    ) VALUES (?, ?, ?, 'error', 1, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      consecutive_errors = housekeeping_state.consecutive_errors + 1,
      last_error = excluded.last_error,
      last_run_at = excluded.last_run_at,
      last_status = 'error'
  `);

  const readErrorCountStmt = db.prepare(
    `SELECT consecutive_errors FROM housekeeping_state WHERE task_id = ?`,
  );

  const resetErrorStmt = db.prepare(`
    UPDATE housekeeping_state
    SET consecutive_errors = 0,
        last_error = NULL,
        last_status = CASE WHEN last_status = 'error' THEN 'pending' ELSE last_status END
    WHERE task_id = ?
  `);

  const markPendingForInvalidationStmt = db.prepare(`
    UPDATE housekeeping_state
    SET last_status = 'pending'
    WHERE task_id = ?
      AND last_status = 'complete'
  `);

  const getCycleClockStmt = db.prepare(
    `SELECT last_cycle_at FROM housekeeping_cycle_clock WHERE id = 'singleton'`,
  );
  const setCycleClockStmt = db.prepare(`
    INSERT INTO housekeeping_cycle_clock (id, last_cycle_at)
    VALUES ('singleton', ?)
    ON CONFLICT(id) DO UPDATE SET last_cycle_at = excluded.last_cycle_at
  `);

  return {
    get(task_id) {
      const row = getStmt.get(task_id) as Row | undefined;
      return row ? rowToState(row) : null;
    },
    list() {
      return (listStmt.all() as Row[]).map(rowToState);
    },
    set(update) {
      setStmt.run(
        update.task_id,
        JSON.stringify(update.cursor),
        update.last_run_at ?? null,
        update.last_run_duration_ms ?? null,
        update.last_yield_reason ?? null,
        update.last_status,
        update.consecutive_errors ?? 0,
        update.last_error ?? null,
      );
    },
    recordError(task_id, error_message, now) {
      // Seed cursor for fresh row — never-stepped task hitting an
      // error before a successful step is rare but possible.
      recordErrorStmt.run(
        task_id,
        JSON.stringify({ kind: 'complete' } satisfies HousekeepingCursor),
        now,
        error_message,
      );
      const row = readErrorCountStmt.get(task_id) as
        | { consecutive_errors: number }
        | undefined;
      return row?.consecutive_errors ?? 1;
    },
    resetError(task_id) {
      resetErrorStmt.run(task_id);
    },
    markPendingForInvalidation(task_id) {
      markPendingForInvalidationStmt.run(task_id);
    },
    clear(task_id) {
      deleteStmt.run(task_id);
    },
    getCycleClock() {
      const row = getCycleClockStmt.get() as { last_cycle_at: number } | undefined;
      return row?.last_cycle_at ?? null;
    },
    setCycleClock(ts) {
      setCycleClockStmt.run(ts);
    },
  };
};
