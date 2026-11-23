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
import { reminderRevision } from '../reminders/reminder-revision.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  REMINDER_PENDING_MAX,
  readReminderRecordReference,
  readReminderMailReference,
  type ReminderMailReference,
  type ReminderRecordReference,
  isReminderState,
  type Reminder,
  type ReminderOrigin,
  type ReminderListPageInput,
  type ReminderListCursor,
  type ReminderSearchStatus,
} from '@recued/contracts';

const referenceKey = (ref: ReminderRecordReference): string =>
  JSON.stringify([ref.kind, ref.id, ref.source_id, ref.source_record_id, ref.created_at]);
const mailKey = (ref: ReminderMailReference): string =>
  JSON.stringify([ref.slug, ref.record_id, ref.source_id, ref.received_at, ref.incarnation]);

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
    CREATE TABLE IF NOT EXISTS reminder_triage_receipts (
      request_id TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      PRIMARY KEY (request_id, reminder_id)
    );
    CREATE TABLE IF NOT EXISTS reminder_creation_requests (
      creation_id TEXT PRIMARY KEY,
      reminder_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL
    );
  `);
  const columns = new Set((db.prepare('PRAGMA table_info(reminders)').all() as { name: string }[]).map(row => row.name));
  for (const name of ['clock_occurrence_id', 'clock_point_key', 'clock_ask_id', 'record_ref_json', 'mail_ref_json']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE reminders ADD COLUMN ${name} TEXT`);
  }
  // Resume safely after interrupted upgrades and normalize old JSON field
  // order into one indexed identity. Corrupt legacy references stay unlinked.
  db.transaction(() => {
    if (!columns.has('record_ref_key')) db.exec('ALTER TABLE reminders ADD COLUMN record_ref_key TEXT');
    const old = db.prepare('SELECT reminder_id, record_ref_json FROM reminders WHERE record_ref_key IS NULL AND record_ref_json IS NOT NULL')
      .all() as { reminder_id: string; record_ref_json: string }[];
    const update = db.prepare('UPDATE reminders SET record_ref_key=? WHERE reminder_id=?');
    for (const row of old) {
      const ref = recordReference(row.record_ref_json);
      if (ref) update.run(referenceKey(ref), row.reminder_id);
    }
    db.exec('CREATE INDEX IF NOT EXISTS reminders_record_state_at ON reminders(record_ref_key,state,at,reminder_id)');
    if (!columns.has('mail_ref_key')) db.exec('ALTER TABLE reminders ADD COLUMN mail_ref_key TEXT');
    const mail = db.prepare('SELECT reminder_id, mail_ref_json FROM reminders WHERE mail_ref_key IS NULL AND mail_ref_json IS NOT NULL')
      .all() as { reminder_id: string; mail_ref_json: string }[];
    const updateMail = db.prepare('UPDATE reminders SET mail_ref_key=? WHERE reminder_id=?');
    for (const row of mail) {
      const ref = mailReference(row.mail_ref_json);
      if (ref) updateMail.run(mailKey(ref), row.reminder_id);
    }
    db.exec('CREATE INDEX IF NOT EXISTS reminders_mail_state_at ON reminders(mail_ref_key,state,at,reminder_id)');
  })();
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

/** Retained creation receipts never re-arm a cancelled or pruned alarm. */
export class ReminderCreationConflictError extends Error {}

export interface ReminderCreateInput {
  creation_id?: string;
  record_ref?: ReminderRecordReference; mail_ref?: ReminderMailReference;
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

export interface ReviewedReminderChange {
  request_id: string; reminder_id: string; fingerprint: string;
  /** Undefined refuses the write, while still allowing an earlier receipt to replay. */
  expected_revision?: string;
  at?: number;
}
export type ReviewedReminderChangeResult = { applied: boolean; replayed?: true; reminder: Reminder | null };

export interface ReminderStore {
  /** Checks content and pending/personal eligibility under an immediate write lock.
   * A success and its retained receipt commit together; retries never re-arm it. */
  applyReviewed(input: ReviewedReminderChange, now: number): ReviewedReminderChangeResult;
  findCreated(creationId: string, input: { text: string; at: number; record_ref?: ReminderRecordReference; mail_ref?: ReminderMailReference }): Reminder | undefined;
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
  pagePending(input: ReminderListPageInput & { limit: number }): {
    reminders: Reminder[]; matched_count: number; next_cursor: ReminderListCursor | null;
  };
  pageSearch(input: ReminderListPageInput & { state: ReminderSearchStatus; history_since: number; limit: number }): {
    reminders: Reminder[]; matched_count: number; next_cursor: ReminderListCursor | null;
  };
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
   *  (cancelled meanwhile), or a queued snapshot changed before its turn. */
  recordAttempt(reminder_id: string, now: number, expected_revision?: string): boolean;
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
  record_ref_json: string | null;
  mail_ref_json: string | null;
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

const recordReference = (raw: string | null): ReminderRecordReference | undefined => {
  try { return raw ? readReminderRecordReference(JSON.parse(raw)) : undefined; } catch { return; }
};
const mailReference = (raw: string | null): ReminderMailReference | undefined => {
  try { return raw ? readReminderMailReference(JSON.parse(raw)) : undefined; } catch { return; }
};
const toReminder = (row: Row): Reminder => ({
  ...(recordReference(row.record_ref_json) ? { record_ref: recordReference(row.record_ref_json)! } : {}),
  ...(mailReference(row.mail_ref_json) ? { mail_ref: mailReference(row.mail_ref_json)! } : {}),
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
  const fold = (value: string): string => value.normalize('NFKC').toLowerCase();
  db.function('recued_reminder_search', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? fold(value) : '');
  const page = db.transaction((input: ReminderListPageInput & { limit: number; history_since?: number }) => {
    const state = input.state ?? 'pending';
    const clauses: string[] = [];
    const values: Record<string, string | number> = {};
    if (input.record_ref) { clauses.push('record_ref_key = @record_key'); values.record_key = referenceKey(input.record_ref); }
    if (input.mail_ref) { clauses.push('mail_ref_key = @mail_key'); values.mail_key = mailKey(input.mail_ref); }
    if (input.history_only) clauses.push("state IN ('delivered','cancelled')");
    if (state !== 'all') { clauses.push('state = @state'); values.state = state; }
    if (state !== 'pending') {
      clauses.push("(state = 'pending' OR COALESCE(delivered_at, updated_at) >= @history_since)");
      values.history_since = input.history_since!;
    }
    if (input.query?.trim()) { clauses.push('instr(recued_reminder_search(text), @query) > 0'); values.query = fold(input.query.trim()); }
    if (input.from !== undefined) { clauses.push('at >= @from'); values.from = input.from; }
    if (input.before !== undefined) { clauses.push('at < @before'); values.before = input.before; }
    const where = clauses.join(' AND ') || '1';
    const matched = db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE ' + where).get(values) as { n: number };
    if (input.cursor) {
      clauses.push('(at > @cursor_at OR (at = @cursor_at AND reminder_id > @cursor_id))');
      values.cursor_at = input.cursor.at; values.cursor_id = input.cursor.reminder_id;
    }
    const rows = db.prepare('SELECT * FROM reminders WHERE ' + clauses.join(' AND ')
      + ' ORDER BY at ASC, reminder_id ASC LIMIT @limit').all({ ...values, limit: input.limit + 1 }) as Row[];
    const visible = rows.slice(0, input.limit).map(toReminder);
    const last = visible.at(-1);
    return { reminders: visible, matched_count: matched.n,
      next_cursor: rows.length > input.limit && last ? { at: last.at, reminder_id: last.reminder_id } : null };
  });
  const countPendingStmt = db.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE state = 'pending'`);
  const insertStmt = db.prepare(`
    INSERT INTO reminders (
      reminder_id, text, at, time_zone, origin_channel, origin_vendor, origin_recipe_id,
      state, created_at, updated_at, from_task_id
      ,clock_occurrence_id,clock_point_key,clock_ask_id,record_ref_json,record_ref_key,mail_ref_json,mail_ref_key
    ) VALUES (
      @reminder_id, @text, @at, @time_zone, @origin_channel, @origin_vendor, @origin_recipe_id,
      'pending', @now, @now, @from_task_id
      ,@clock_occurrence_id,@clock_point_key,@clock_ask_id,@record_ref_json,@record_ref_key,@mail_ref_json,@mail_ref_key
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
  const fingerprint = (input: { text: string; at: number; record_ref?: ReminderRecordReference; mail_ref?: ReminderMailReference }): string =>
    createHash('sha256').update(JSON.stringify(input.mail_ref
      ? ['mail', input.text, input.at, input.mail_ref.slug, input.mail_ref.record_id, input.mail_ref.source_id, input.mail_ref.received_at, input.mail_ref.incarnation]
      : input.record_ref
      ? [input.text, input.at, input.record_ref.kind, input.record_ref.id, input.record_ref.source_id, input.record_ref.source_record_id, input.record_ref.created_at]
      : [input.text, input.at])).digest('hex');
  const findCreated = (creationId: string, input: { text: string; at: number; record_ref?: ReminderRecordReference; mail_ref?: ReminderMailReference }): Reminder | undefined => {
    const receipt = db.prepare('SELECT reminder_id, fingerprint FROM reminder_creation_requests WHERE creation_id=?')
      .get(creationId) as { reminder_id: string; fingerprint: string } | undefined;
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprint(input)) throw new ReminderCreationConflictError('This request already created an alarm with different details. Review your alarms before creating another.');
    const existing = get(receipt.reminder_id);
    if (!existing) throw new ReminderCreationConflictError('This alarm was already created and its history has expired. Start a new alarm to schedule it again.');
    return existing;
  };

  const create = db.transaction((input: ReminderCreateInput, now: number, uncapped: boolean): Reminder => {
    const existing = input.creation_id ? findCreated(input.creation_id, input) : undefined;
    if (existing) return existing;
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
      record_ref_json: input.record_ref ? JSON.stringify(input.record_ref) : null,
      record_ref_key: input.record_ref ? referenceKey(input.record_ref) : null,
      mail_ref_json: input.mail_ref ? JSON.stringify(input.mail_ref) : null,
      mail_ref_key: input.mail_ref ? mailKey(input.mail_ref) : null,
    });
    if (input.creation_id) db.prepare('INSERT INTO reminder_creation_requests VALUES (?, ?, ?)')
      .run(input.creation_id, reminder_id, fingerprint(input));
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

  const applyReviewed = db.transaction((input: ReviewedReminderChange, now: number): ReviewedReminderChangeResult => {
    const receipt = db.prepare('SELECT fingerprint FROM reminder_triage_receipts WHERE request_id=? AND reminder_id=?')
      .get(input.request_id, input.reminder_id) as { fingerprint: string } | undefined;
    const current = get(input.reminder_id);
    if (receipt) return { applied: receipt.fingerprint === input.fingerprint,
      ...(receipt.fingerprint === input.fingerprint ? { replayed: true as const } : {}), reminder: current };
    if (!current || current.state !== 'pending' || current.clock || !input.expected_revision
      || reminderRevision(current) !== input.expected_revision) return { applied: false, reminder: current };
    if (input.at !== undefined) updateAtStmt.run(input.at, now, input.reminder_id);
    else cancelStmt.run(now, input.reminder_id);
    db.prepare('INSERT INTO reminder_triage_receipts VALUES (?, ?, ?)').run(input.request_id, input.reminder_id, input.fingerprint);
    return { applied: true, reminder: get(input.reminder_id) };
  });

  const recordAttempt = db.transaction((id: string, now: number, expected?: string): boolean => {
    const row = get(id);
    if (expected !== undefined && (!row || reminderRevision(row) !== expected)) return false;
    return attemptStmt.run(now, id).changes === 1;
  });

  return {
    applyReviewed: (input, now) => applyReviewed.immediate(input, now),
    findCreated,
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
    pagePending: input => page({ ...input, state: 'pending' }),
    pageSearch: input => page(input),
    listHistory: (limit) => (listHistoryStmt.all(limit) as Row[]).map(toReminder),
    listDue: (now, limit) => (listDueStmt.all(now, limit) as Row[]).map(toReminder),
    update: (reminder_id, patch, now) => update(reminder_id, patch, now),
    cancel: (reminder_id, now) =>
      cancelStmt.run(now, reminder_id).changes === 1 ? get(reminder_id) : null,
    recordAttempt: (reminder_id, now, expected) => recordAttempt.immediate(reminder_id, now, expected),
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
