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
import {
  assertPreapprovalLegacyEnable, initializePreapprovalLifecycle, mutatePreapprovalResource,
  notePreapprovalOwnerMutation, preapprovalLogicalEnabled,
  advancePreapprovalOccurrence, synchronizePreapprovalIdentity,
} from './storage/preapproval-lifecycle.js';

/** Runtime statistics and internal parking do not change reviewed material. */
export const schedulePreapprovalMaterial = (schedule: Schedule): Record<string, unknown> => ({
  recipe_id: schedule.recipe_id, publisher_id: schedule.publisher_id,
  mode: schedule.mode ?? 'recurring', cron_expression: schedule.cron_expression,
  run_at: schedule.run_at ?? null, enabled: schedule.enabled,
  instance_id: schedule.instance_id ?? null, dish_id: schedule.dish_id ?? null,
});

export interface ScheduleStore {
  list(): Schedule[];
  listByRecipe(recipe_id: string): Schedule[];
  get(schedule_id: string): Schedule | null;
  /** D-261's selected/cancelled occurrence cannot reappear after recurrence
   * restoration. Optional only for legacy in-memory store implementations. */
  wasPreapprovalOccurrenceConsumed?(schedule_id: string, occurrence_key: string): boolean;
  /** Records that an ordinary fire began, so a pending review cannot approve
   * a stale "next execution" selector. No pre-approval is granted here. */
  noteQualifyingOccurrence?(schedule_id: string, occurrence_key: string): void;
  set(schedule: Schedule): void;
  delete(schedule_id: string): boolean;
  /** Update last_run_at / next_run_at / status fields on a schedule.
   *  Scheduler calls this after each fire attempt. When `last_run_at`
   *  is in the patch, the prior `last_run_at` rolls into `prev_run_at`
   *  automatically — Phase 5 Smart Backfill reads the observed
   *  cadence from those two timestamps. */
  updateRun(schedule_id: string, patch: Partial<Pick<Schedule,
    'last_run_at' | 'next_run_at' | 'last_status' | 'last_error' | 'enabled'
    // D-268 — failures since the last success; the breaker's counter for the
    // cron path. Runtime state like `missed_answer` below, never reviewed
    // material, so it rides `updateRun` and not `set`.
    | 'consecutive_failures'
    // D-266 — the owner's one-shot answer about a missed run. Runtime
    // parking, not reviewed material (`schedulePreapprovalMaterial`
    // excludes it), so it rides `updateRun` rather than `set`: `set`
    // notes an owner mutation unconditionally and would bump a
    // pre-approval's lifecycle revision for what is not a change to
    // what was reviewed.
    | 'missed_answer'
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
  initializePreapprovalLifecycle(db);

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
  const material = (id: string): Record<string, unknown> | null => {
    const row = db.prepare('SELECT data FROM schedules WHERE schedule_id = ?').get(id) as { data: string } | undefined;
    if (!row) return null;
    const schedule = rowToSchedule(row);
    return schedulePreapprovalMaterial({ ...schedule,
      enabled: preapprovalLogicalEnabled(db, kindFor(id), id, schedule.enabled) });
  };
  const kindFor = (id: string): 'one_shot' | 'next_schedule' => db.prepare(
    "SELECT key FROM preapproval_resource_identity WHERE kind='one_shot' AND key=?",
  ).get(id) ? 'one_shot' : 'next_schedule';

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

    wasPreapprovalOccurrenceConsumed(schedule_id, occurrence_key) {
      return !!db.prepare(`SELECT o.occurrence_key FROM preapproval_occurrences o
        JOIN preapproval_resource_identity i ON i.kind=o.target_kind AND i.key=o.target_key AND i.incarnation=o.incarnation
        WHERE o.target_kind=? AND o.target_key=? AND o.occurrence_key=? AND o.future_ref IS NOT NULL`)
        .get(kindFor(schedule_id), schedule_id, occurrence_key);
    },
    noteQualifyingOccurrence(schedule_id, occurrence_key) {
      db.transaction(() => {
        const kind = kindFor(schedule_id);
        const identity = synchronizePreapprovalIdentity(db, kind, schedule_id, material(schedule_id));
        if (!identity) return;
        const prior = db.prepare(`SELECT sequence FROM preapproval_occurrences
          WHERE target_kind=? AND target_key=? AND incarnation=? AND occurrence_key=?`)
          .get(kind, schedule_id, identity.incarnation, occurrence_key);
        if (prior) return;
        const sequence = advancePreapprovalOccurrence(db, kind, schedule_id);
        db.prepare(`INSERT INTO preapproval_occurrences(target_kind,target_key,incarnation,occurrence_key,
          sequence,payload_hash,future_ref,consumed_at) VALUES(?,?,?,?,?,'',NULL,?)`)
          .run(kind, schedule_id, identity.incarnation, occurrence_key, sequence, Date.now());
      }).immediate();
    },

    set(schedule) {
      const kind = kindFor(schedule.schedule_id);
      mutatePreapprovalResource(db, kind, schedule.schedule_id, () => material(schedule.schedule_id), () => {
        assertPreapprovalLegacyEnable(db, kind, schedule.schedule_id, schedule.enabled);
        notePreapprovalOwnerMutation(db, kind, schedule.schedule_id);
        const serialized = JSON.stringify(schedule);
        const prev = priorBytes(schedule.schedule_id);
        db.prepare(`INSERT OR REPLACE INTO schedules (schedule_id, recipe_id, data) VALUES (?, ?, ?)`)
          .run(schedule.schedule_id, schedule.recipe_id, serialized);
        reportDelta(serialized.length - prev);
      });
    },

    delete(schedule_id) {
      const kind = kindFor(schedule_id);
      return mutatePreapprovalResource(db, kind, schedule_id, () => material(schedule_id), () => {
        notePreapprovalOwnerMutation(db, kind, schedule_id);
        const prev = priorBytes(schedule_id);
        const result = db.prepare(`DELETE FROM schedules WHERE schedule_id = ?`).run(schedule_id);
        if (result.changes > 0 && prev > 0) reportDelta(-prev);
        return result.changes > 0;
      });
    },

    updateRun(schedule_id, patch) {
      const kind = kindFor(schedule_id);
      mutatePreapprovalResource(db, kind, schedule_id, () => material(schedule_id), () => {
        assertPreapprovalLegacyEnable(db, kind, schedule_id, patch.enabled === true);
        if (patch.enabled !== undefined) notePreapprovalOwnerMutation(db, kind, schedule_id);
        const existing = db.prepare(`SELECT data FROM schedules WHERE schedule_id = ?`).get(schedule_id) as { data: string } | undefined;
        if (!existing) return;
        const schedule = JSON.parse(existing.data) as Schedule;
        // Roll prev_run_at = old last_run_at whenever the patch advances
        // last_run_at. Skip the roll when the new last_run_at is
        // identical to the old (idempotent re-write) so prev doesn't
        // collapse to last on a no-op patch.
        //
        // ⚠ THIS NO LONGER FEEDS ANY MEASURE, AND IS STILL WORTH DOING.
        // It existed so Smart Backfill could reconstruct an observed
        // cadence; that measure was replaced because the pair spans an
        // outage. What the roll leaves behind is a one-deep UNDO LOG of
        // `last_run_at` — the one field every scheduling decision
        // measures forward from, and whose silent corruption far into
        // the future stops a schedule with nothing else on the row to
        // restore from. See its declaration in `@recued/scheduler`.
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
      });
    },
  };
};
