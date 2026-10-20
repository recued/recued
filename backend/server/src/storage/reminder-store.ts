/** D-324 — the owner's reminders: "tell me at T", rung once, then over.
 *
 *  ⛔ ITS OWN TABLE, NOT `data.task`. D-193 kept a reminder as a task row, and the
 *  task-ness cost the owner (D-324 §2): D-269 took it for a deadline, it stayed
 *  open in Tasks and Today, and its "delivered" mark was a task write. Here a
 *  reminder has no vendor, no container and no `done`; its whole life is
 *  `pending` → `delivered` (or `cancelled`), then 30 days of history.
 *
 *  ⚠ EVERY CHANGE IS TO A PENDING ROW ONLY. A delivered reminder is history: a
 *  change to its time would read as a reminder that never rang, and a cancel as
 *  one that never came. The `WHERE state = 'pending'` on each write is that rule,
 *  and it is also what keeps a delivery and a cancel from both landing. */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  REMINDER_PENDING_MAX,
  isReminderState,
  type Reminder,
  type ReminderOrigin,
} from '@recued/contracts';

export const ensureReminderSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      reminder_id      TEXT PRIMARY KEY,
      text             TEXT NOT NULL,
      at               INTEGER NOT NULL,
      time_zone        TEXT,
      origin_channel   TEXT,
      origin_vendor    TEXT,
      origin_recipe_id TEXT,
      state            TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      delivered_at     INTEGER,
      delivered_to     TEXT NOT NULL DEFAULT '[]',
      attempts         INTEGER NOT NULL DEFAULT 0,
      last_attempt_at  INTEGER,
      from_task_id     TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS reminders_state_at_idx ON reminders (state, at);
    CREATE TABLE IF NOT EXISTS reminder_task_moves (
      task_id TEXT PRIMARY KEY,
      outcome TEXT NOT NULL,
      at      INTEGER NOT NULL
    );
  `);
  const columns = new Set((db.prepare('PRAGMA table_info(reminders)').all() as { name: string }[]).map(row => row.name));
  for (const name of ['clock_occurrence_id', 'clock_point_key', 'clock_ask_id']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE reminders ADD COLUMN ${name} TEXT`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS reminder_clock_point ON reminders(clock_occurrence_id,clock_point_key) WHERE clock_occurrence_id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS reminder_clock_ask ON reminders(clock_ask_id) WHERE clock_ask_id IS NOT NULL');
};

/** Refused: too many reminders already wait (`REMINDER_PENDING_MAX`). */
export class ReminderLimitError extends Error {
  constructor(readonly pending: number) {
    super(
      `You have ${pending} reminders waiting, the most Recued keeps at once. `
      + 'Cancel some before setting another.',
    );
    this.name = 'ReminderLimitError';
  }
}

export interface ReminderCreateInput {
  text: string;
  at: number;
  time_zone: string | null;
  origin: ReminderOrigin;
  /** D-324 §6 — the D-193 task this reminder was moved from, once. */
  from_task_id?: string;
  clock?: NonNullable<Reminder['clock']>;
}

/** D-324 §6 — what became of one D-193 reminder task. */
export type ReminderTaskMoveOutcome = 'moved' | 'closed' | 'left_in_vendor';

export interface ReminderStore {
  /** ⛔ Throws `ReminderLimitError` at the cap, counted in the same transaction
   *  as the insert. `uncapped` is for moving D-193's tasks only (§6): the owner
   *  set those already, and leaving the overflow behind as tasks would leave it
   *  unrung. */
  create(input: ReminderCreateInput, now: number, opts?: { uncapped?: boolean }): Reminder;
  /** Idempotent built-in clock point; not exposed as a recipe argument. */
  ensureClock(input: ReminderCreateInput & { clock: NonNullable<Reminder['clock']> }, now: number): Reminder;
  get(reminder_id: string): Reminder | null;
  clockForAsk(ask_id: string): Reminder | null;
  countPending(): number;
  /** Waiting reminders, soonest first. */
  listPending(limit: number): Reminder[];
  /** Delivered and cancelled ones, most recent first. */
  listHistory(limit: number): Reminder[];
  /** Pending reminders whose time has come. The ones tried least recently come
   *  first (never tried first of all), so one that cannot be delivered does not
   *  hold up the rest. */
  listDue(now: number, limit: number): Reminder[];
  /** Pending only; `null` when there is no such pending reminder. A new time
   *  starts its tries afresh. */
  update(reminder_id: string, patch: { text?: string; at?: number }, now: number): Reminder | null;
  /** Pending only; `null` when there is no such pending reminder. */
  cancel(reminder_id: string, now: number): Reminder | null;
  /** Counts a send about to be tried. False when it is no longer pending
   *  (cancelled meanwhile), and then it must not be sent. */
  recordAttempt(reminder_id: string, now: number): boolean;
  /** Pending only. */
  markDelivered(reminder_id: string, now: number, delivered_to: readonly string[]): boolean;
  /** Drops delivered and cancelled reminders that finished before `before`. */
  prune(before: number): number;
  /** Whether a D-193 task was moved here already (D-324 §6). */
  hasFromTask(task_id: string): boolean;
  /** D-324 §6 — records what became of a D-193 reminder task, once. False when it
   *  was recorded before. */
  recordTaskMove(task_id: string, outcome: ReminderTaskMoveOutcome, now: number): boolean;
  /** D-324 §6 — what became of one, when it was recorded. */
  taskMoveOf(task_id: string): ReminderTaskMoveOutcome | null;
}

interface Row {
  reminder_id: string;
  text: string;
  at: number;
  time_zone: string | null;
  origin_channel: string | null;
  origin_vendor: string | null;
  origin_recipe_id: string | null;
  clock_occurrence_id: string | null;
  clock_point_key: string | null;
  clock_ask_id: string | null;
  state: string;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  delivered_to: string;
  attempts: number;
}

const readDeliveredTo = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

const toReminder = (row: Row): Reminder => ({
  reminder_id: row.reminder_id,
  text: row.text,
  at: row.at,
  time_zone: row.time_zone,
  origin: {
    ...(row.origin_channel !== null ? { channel: row.origin_channel } : {}),
    ...(row.origin_vendor !== null ? { vendor: row.origin_vendor } : {}),
    ...(row.origin_recipe_id !== null ? { recipe_id: row.origin_recipe_id } : {}),
  },
  ...(row.clock_occurrence_id && row.clock_point_key && row.clock_ask_id ? { clock: {
    occurrence_id: row.clock_occurrence_id, point_key: row.clock_point_key, ask_id: row.clock_ask_id,
  } } : {}),
  // A row this server wrote holds one of the three; anything else reads as
  // cancelled, which is never sent.
  state: isReminderState(row.state) ? row.state : 'cancelled',
  created_at: row.created_at,
  updated_at: row.updated_at,
  delivered_at: row.delivered_at,
  delivered_to: readDeliveredTo(row.delivered_to),
  attempts: row.attempts,
});

export const createReminderStore = (db: Database.Database): ReminderStore => {
  ensureReminderSchema(db);
  const countPendingStmt = db.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE state = 'pending'`);
  const insertStmt = db.prepare(`
    INSERT INTO reminders (
      reminder_id, text, at, time_zone, origin_channel, origin_vendor, origin_recipe_id,
      state, created_at, updated_at, from_task_id
      ,clock_occurrence_id,clock_point_key,clock_ask_id
    ) VALUES (
      @reminder_id, @text, @at, @time_zone, @origin_channel, @origin_vendor, @origin_recipe_id,
      'pending', @now, @now, @from_task_id
      ,@clock_occurrence_id,@clock_point_key,@clock_ask_id
    )
  `);
  const getStmt = db.prepare(`SELECT * FROM reminders WHERE reminder_id = ?`);
  const listPendingStmt = db.prepare(`
    SELECT * FROM reminders WHERE state = 'pending' ORDER BY at ASC, reminder_id ASC LIMIT ?
  `);
  const listHistoryStmt = db.prepare(`
    SELECT * FROM reminders WHERE state != 'pending'
    ORDER BY COALESCE(delivered_at, updated_at) DESC, reminder_id ASC LIMIT ?
  `);
  const listDueStmt = db.prepare(`
    SELECT * FROM reminders WHERE state = 'pending' AND at <= ? AND clock_occurrence_id IS NULL
    ORDER BY COALESCE(last_attempt_at, 0) ASC, at ASC, reminder_id ASC LIMIT ?
  `);
  const updateTextStmt = db.prepare(`
    UPDATE reminders SET text = ?, updated_at = ? WHERE reminder_id = ? AND state = 'pending'
  `);
  const updateAtStmt = db.prepare(`
    UPDATE reminders SET at = ?, attempts = 0, last_attempt_at = NULL, updated_at = ?
    WHERE reminder_id = ? AND state = 'pending'
  `);
  const cancelStmt = db.prepare(`
    UPDATE reminders SET state = 'cancelled', updated_at = ? WHERE reminder_id = ? AND state = 'pending'
  `);
  const attemptStmt = db.prepare(`
    UPDATE reminders SET attempts = attempts + 1, last_attempt_at = ?
    WHERE reminder_id = ? AND state = 'pending'
  `);
  const deliveredStmt = db.prepare(`
    UPDATE reminders SET state = 'delivered', delivered_at = ?, delivered_to = ?, updated_at = ?
    WHERE reminder_id = ? AND state = 'pending'
  `);
  const pruneStmt = db.prepare(`
    DELETE FROM reminders WHERE state != 'pending' AND COALESCE(delivered_at, updated_at) < ?
  `);
  const fromTaskStmt = db.prepare(`SELECT 1 FROM reminders WHERE from_task_id = ?`);
  const recordMoveStmt = db.prepare(`
    INSERT INTO reminder_task_moves (task_id, outcome, at) VALUES (?, ?, ?)
    ON CONFLICT(task_id) DO NOTHING
  `);
  const moveOfStmt = db.prepare(`SELECT outcome FROM reminder_task_moves WHERE task_id = ?`);

  const get = (reminder_id: string): Reminder | null => {
    const row = getStmt.get(reminder_id) as Row | undefined;
    return row ? toReminder(row) : null;
  };
  const countPending = (): number => (countPendingStmt.get() as { n: number }).n;

  const create = db.transaction((input: ReminderCreateInput, now: number, uncapped: boolean): Reminder => {
    const pending = countPending();
    if (!uncapped && pending >= REMINDER_PENDING_MAX) throw new ReminderLimitError(pending);
    const reminder_id = `rem_${randomUUID()}`;
    insertStmt.run({
      reminder_id,
      text: input.text,
      at: input.at,
      time_zone: input.time_zone,
      origin_channel: input.origin.channel ?? null,
      origin_vendor: input.origin.vendor ?? null,
      origin_recipe_id: input.origin.recipe_id ?? null,
      now,
      from_task_id: input.from_task_id ?? null,
      clock_occurrence_id: input.clock?.occurrence_id ?? null,
      clock_point_key: input.clock?.point_key ?? null,
      clock_ask_id: input.clock?.ask_id ?? null,
    });
    return get(reminder_id)!;
  });

  const update = db.transaction(
    (reminder_id: string, patch: { text?: string; at?: number }, now: number): Reminder | null => {
      const current = get(reminder_id);
      if (current === null || current.state !== 'pending') return null;
      if (patch.text !== undefined) updateTextStmt.run(patch.text, now, reminder_id);
      if (patch.at !== undefined) updateAtStmt.run(patch.at, now, reminder_id);
      return get(reminder_id);
    },
  );

  return {
    create: (input, now, opts) => create(input, now, opts?.uncapped === true),
    ensureClock: db.transaction((input, now) => {
      const old = db.prepare('SELECT * FROM reminders WHERE clock_occurrence_id=? AND clock_point_key=?')
        .get(input.clock.occurrence_id, input.clock.point_key) as Row | undefined;
      if (old) {
        if (old.clock_ask_id !== input.clock.ask_id) throw new Error('The clock point already has a different question');
        return toReminder(old);
      }
      return create(input, now, true);
    }),
    get,
    clockForAsk(ask_id) {
      const row = db.prepare('SELECT * FROM reminders WHERE clock_ask_id=?').get(ask_id) as Row | undefined;
      return row ? toReminder(row) : null;
    },
    countPending,
    listPending: (limit) => (listPendingStmt.all(limit) as Row[]).map(toReminder),
    listHistory: (limit) => (listHistoryStmt.all(limit) as Row[]).map(toReminder),
    listDue: (now, limit) => (listDueStmt.all(now, limit) as Row[]).map(toReminder),
    update: (reminder_id, patch, now) => update(reminder_id, patch, now),
    cancel: (reminder_id, now) =>
      cancelStmt.run(now, reminder_id).changes === 1 ? get(reminder_id) : null,
    recordAttempt: (reminder_id, now) => attemptStmt.run(now, reminder_id).changes === 1,
    markDelivered: (reminder_id, now, delivered_to) =>
      deliveredStmt.run(now, JSON.stringify([...delivered_to]), now, reminder_id).changes === 1,
    prune: (before) => pruneStmt.run(before).changes,
    hasFromTask: (task_id) => fromTaskStmt.get(task_id) !== undefined,
    recordTaskMove: (task_id, outcome, now) => recordMoveStmt.run(task_id, outcome, now).changes === 1,
    taskMoveOf: (task_id) => {
      const row = moveOfStmt.get(task_id) as { outcome: string } | undefined;
      return row === undefined ? null : row.outcome as ReminderTaskMoveOutcome;
    },
  };
};
