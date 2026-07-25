/** SQLite-backed Schedule store for the server.
 *
 *  Each instance is autonomous: schedules live on the instance that
 *  owns them. The extension reads this list via GET /schedules and
 *  writes via POST/PATCH/DELETE. No mirroring, no cross-instance
 *  consensus — the instance is the source of truth for its own
 *  scheduled work.
 *
 *  Persistence mirrors the `@recued/scheduler` Schedule shape so the
 *  extension client can round-trip values without translation.
 */

import type Database from 'better-sqlite3';
import type { Schedule } from '@recued/scheduler';

export interface ScheduleStore {
  list(): Schedule[];
  listByRecipe(recipe_id: string): Schedule[];
  get(schedule_id: string): Schedule | null;
  set(schedule: Schedule): void;
  delete(schedule_id: string): boolean;
  /** Update last_run_at / next_run_at / status fields on a schedule.
   *  Scheduler calls this after each fire attempt. When `last_run_at`
   *  is in the patch, the prior `last_run_at` rolls into `prev_run_at`
   *  automatically — Phase 5 Smart Backfill reads the observed
   *  cadence from those two timestamps. */
  updateRun(schedule_id: string, patch: Partial<Pick<Schedule,
    'last_run_at' | 'next_run_at' | 'last_status' | 'last_error' | 'enabled'
  >>): void;
}

export interface CreateScheduleStoreOptions {
  /** Phase B gate hook — every `set` / `delete` / `updateRun` reports
   *  the signed byte delta measured against the serialized row's
   *  `length(data)` column (same metric `computeInitialUsage` uses at
   *  boot). Sink exceptions are swallowed. */
  onBytesChanged?: (delta: number) => void;
}

/** Create a SQLite-backed schedule store. Auto-creates the table. */
export const createScheduleStore = (
  db: Database.Database,
  options: CreateScheduleStoreOptions = {},
): ScheduleStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      schedule_id TEXT NOT NULL PRIMARY KEY,
      recipe_id   TEXT NOT NULL,
      data        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedules_recipe_idx ON schedules (recipe_id);
  `);

  const onBytesChanged = options.onBytesChanged;
  const reportDelta = (delta: number): void => {
    if (!onBytesChanged || delta === 0) return;
    try { onBytesChanged(delta); } catch (_err) { /* never break writes */ }
  };

  const rowToSchedule = (row: { data: string }): Schedule =>
    JSON.parse(row.data) as Schedule;

  const priorBytes = (schedule_id: string): number => {
    const row = db
      .prepare(`SELECT length(data) AS len FROM schedules WHERE schedule_id = ?`)
      .get(schedule_id) as { len: number } | undefined;
    return row?.len ?? 0;
  };

  return {
    list() {
      const rows = db.prepare(`SELECT data FROM schedules ORDER BY schedule_id`).all() as { data: string }[];
      return rows.map(rowToSchedule);
    },

    listByRecipe(recipe_id) {
      const rows = db.prepare(`SELECT data FROM schedules WHERE recipe_id = ? ORDER BY schedule_id`).all(recipe_id) as { data: string }[];
      return rows.map(rowToSchedule);
    },

    get(schedule_id) {
      const row = db.prepare(`SELECT data FROM schedules WHERE schedule_id = ?`).get(schedule_id) as { data: string } | undefined;
      return row ? rowToSchedule(row) : null;
    },

    set(schedule) {
      const serialized = JSON.stringify(schedule);
      const prev = priorBytes(schedule.schedule_id);
      db.prepare(`INSERT OR REPLACE INTO schedules (schedule_id, recipe_id, data) VALUES (?, ?, ?)`)
        .run(schedule.schedule_id, schedule.recipe_id, serialized);
      reportDelta(serialized.length - prev);
    },

    delete(schedule_id) {
      const prev = priorBytes(schedule_id);
      const result = db.prepare(`DELETE FROM schedules WHERE schedule_id = ?`).run(schedule_id);
      if (result.changes > 0 && prev > 0) reportDelta(-prev);
      return result.changes > 0;
    },

    updateRun(schedule_id, patch) {
      const existing = db.prepare(`SELECT data FROM schedules WHERE schedule_id = ?`).get(schedule_id) as { data: string } | undefined;
      if (!existing) return;
      const schedule = JSON.parse(existing.data) as Schedule;
      // Roll prev_run_at = old last_run_at whenever the patch advances
      // last_run_at — Smart Backfill (Phase 5) reconstructs the
      // observed cadence from these two timestamps without parsing
      // the cron expression. Skip the roll when the new last_run_at
      // is identical to the old (idempotent re-write) so prev doesn't
      // collapse to last on a no-op patch.
      const rollPrev =
        patch.last_run_at !== undefined &&
        patch.last_run_at !== null &&
        patch.last_run_at !== schedule.last_run_at;
      const updated: Schedule = {
        ...schedule,
        ...patch,
        ...(rollPrev ? { prev_run_at: schedule.last_run_at ?? null } : {}),
      };
      const serialized = JSON.stringify(updated);
      const prev = existing.data.length;
      db.prepare(`INSERT OR REPLACE INTO schedules (schedule_id, recipe_id, data) VALUES (?, ?, ?)`)
        .run(updated.schedule_id, updated.recipe_id, serialized);
      reportDelta(serialized.length - prev);
    },
  };
};
