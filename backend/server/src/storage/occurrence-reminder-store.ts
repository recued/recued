import type Database from 'better-sqlite3';
import type { AskDeliveryInput } from '@recued/notification';

/** Reminder service metadata. Lifecycle and deadline stay in the commitment;
 * cadence stays on the asset rule, and transport receipts stay in the ask layer. */
export interface OccurrenceReminderControl {
  occurrence_id: string;
  current_ask_id: string | null;
  later_until: number | null;
  last_notified_on: string | null;
}
export interface OccurrenceReminderPoint {
  occurrence_id: string;
  point_key: string;
  on: string;
  ask_id: string;
  /** Earlier missed points are consumed by this one catch-up question. */
  skipped_keys: string[];
}
export interface OccurrenceReminderPlan {
  delivery: AskDeliveryInput;
  points: OccurrenceReminderPoint[];
}
export interface StoredOccurrenceReminderPlan {
  group_id: string;
  plan: OccurrenceReminderPlan;
  phase: 'planned' | 'prepared' | 'ready' | 'released' | 'abandoned';
  created_at: number;
  updated_at: number;
  reason: string | null;
}
export interface OccurrenceReminderAnswer {
  ask_id: string;
  occurrence_id: string;
  outcome: 'done' | 'later' | 'not_needed' | 'stop_requested' | 'muted' | 'kept'
    | 'last_done_today' | 'choose_last_done_date' | 'unknown_last_done' | 'stop_notices'
    | 'later_tomorrow' | 'later_week' | 'later_month' | 'later_custom';
  answered_at: number;
  applied_at: number | null;
  owner_action?: boolean;
}

export interface OccurrenceReminderStore {
  control(id: string): OccurrenceReminderControl;
  controls(): OccurrenceReminderControl[];
  occurrenceForAsk(ask_id: string): string | null;
  plan(id: string): StoredOccurrenceReminderPlan | null;
  point(id: string, key: string): { group_id: string; ask_id: string | null } | null;
  pending(): StoredOccurrenceReminderPlan[];
  reserve(input: OccurrenceReminderPlan, at: number): StoredOccurrenceReminderPlan;
  replacements(group_id: string): Array<{ ask_id: string; occurrence_id: string }>;
  acknowledgeReplacement(ask_id: string, at: number): void;
  requestCancellation(occurrence_id: string, ask_id: string, at: number): void;
  pendingCancellations(): Array<{ ask_id: string; occurrence_id: string }>;
  activate(group_id: string, at: number): void;
  ready(group_id: string, on: string, at: number): void;
  released(group_id: string, at: number): void;
  abandon(group_id: string, reason: string, at: number): void;
  clearCurrent(occurrence_id: string, ask_id: string): void;
  later(occurrence_id: string, until: number): void;
  clearLater(occurrence_id: string, expected: number): void;
  /** D-325 §15.7 (2026-10-24) — Today's Done on a renewal: the owner has seen its latest
   *  reminder. `acknowledged` holds until a later one is sent, so Today shows it again then. */
  acknowledge(occurrence_id: string, at: number): void;
  acknowledged(occurrence_id: string): boolean;
  pointForAsk(ask_id: string): OccurrenceReminderPoint | null;
  consumeQuestion(occurrence_id: string, at: number): void;
  answer(input: Omit<OccurrenceReminderAnswer, 'applied_at'>): OccurrenceReminderAnswer;
  applied(ask_id: string, at: number): void;
  pendingAnswers(): OccurrenceReminderAnswer[];
  answers(after?: { answered_at: number; ask_id: string }, limit?: number): OccurrenceReminderAnswer[];
  answersForOccurrence(id: string): OccurrenceReminderAnswer[];
  plansForOccurrence(id: string): StoredOccurrenceReminderPlan[];
  /** Retention: whether anything still waits for the occurrence's reminders: a
   * current ask, a cancellation, a plan or an answer not yet applied. */
  open(occurrence_id: string): boolean;
  /** Retention: when its reminders last changed, if they ever did. */
  lastActivity(occurrence_id: string): number | null;
  /** Retention: drops the occurrence's send log, with each plan none of whose
   * points remain; nothing waits on such a plan. Returns the rows it dropped. */
  dropLog(occurrence_id: string): number;
}

const canonical = (input: unknown) => JSON.stringify(input, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

export const createOccurrenceReminderStore = (db: Database.Database): OccurrenceReminderStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS occurrence_reminder_controls (
    occurrence_id TEXT PRIMARY KEY, current_ask_id TEXT UNIQUE, later_until INTEGER, last_notified_on TEXT
  );
  CREATE TABLE IF NOT EXISTS occurrence_reminder_plans (
    group_id TEXT PRIMARY KEY, payload TEXT NOT NULL, phase TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reason TEXT
  );
  CREATE INDEX IF NOT EXISTS occurrence_reminder_plan_phase ON occurrence_reminder_plans(phase,created_at);
  CREATE TABLE IF NOT EXISTS occurrence_reminder_points (
    occurrence_id TEXT NOT NULL, point_key TEXT NOT NULL, on_date TEXT,
    ask_id TEXT, group_id TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY(occurrence_id,point_key)
  );
  CREATE TABLE IF NOT EXISTS occurrence_reminder_pending (
    occurrence_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, ask_id TEXT NOT NULL UNIQUE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS occurrence_reminder_ask ON occurrence_reminder_points(ask_id) WHERE ask_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS occurrence_reminder_replacements (
    ask_id TEXT NOT NULL, group_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, closed_at INTEGER, PRIMARY KEY(group_id,ask_id)
  );
  CREATE TABLE IF NOT EXISTS occurrence_reminder_answers (
    ask_id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL, outcome TEXT NOT NULL,
    answered_at INTEGER NOT NULL, applied_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS occurrence_reminder_acknowledgements (
    occurrence_id TEXT PRIMARY KEY, notified_on TEXT NOT NULL, at INTEGER NOT NULL
  );`);
  if (!(db.prepare('PRAGMA table_info(occurrence_reminder_answers)').all() as { name: string }[]).some(row => row.name === 'owner_action'))
    db.exec('ALTER TABLE occurrence_reminder_answers ADD COLUMN owner_action INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS occurrence_reminder_answer_subject ON occurrence_reminder_answers(occurrence_id,answered_at)');
  type AnswerRow = Omit<OccurrenceReminderAnswer, 'owner_action'> & { owner_action: number | null };
  const decodeAnswer = ({ owner_action, ...row }: AnswerRow): OccurrenceReminderAnswer => ({ ...row, ...(owner_action === null ? {} : { owner_action: owner_action === 1 }) });

  const control = (id: string): OccurrenceReminderControl => db.prepare('SELECT * FROM occurrence_reminder_controls WHERE occurrence_id=?')
    .get(id) as OccurrenceReminderControl | undefined ?? { occurrence_id: id, current_ask_id: null, later_until: null, last_notified_on: null };
  type PlanRow = Omit<StoredOccurrenceReminderPlan, 'plan'> & { payload: string };
  const decode = ({ payload, ...row }: PlanRow): StoredOccurrenceReminderPlan => ({ ...row, plan: JSON.parse(payload) });
  const plan = (id: string): StoredOccurrenceReminderPlan | null => {
    const row = db.prepare('SELECT * FROM occurrence_reminder_plans WHERE group_id=?').get(id) as PlanRow | undefined;
    return row ? decode(row) : null;
  };
  const point = (id: string, key: string): { group_id: string; ask_id: string | null } | null =>
    db.prepare('SELECT group_id,ask_id FROM occurrence_reminder_points WHERE occurrence_id=? AND point_key=?')
      .get(id, key) as { group_id: string; ask_id: string | null } | undefined ?? null;

  // The reminder an acknowledgement covers is the latest sent ('' before any is).
  const notifiedOn = (id: string): string => control(id).last_notified_on ?? '';

  return {
    control, plan, point,
    acknowledge: (id, at) => {
      db.prepare(`INSERT INTO occurrence_reminder_acknowledgements(occurrence_id,notified_on,at) VALUES(?,?,?)
        ON CONFLICT(occurrence_id) DO UPDATE SET notified_on=excluded.notified_on, at=excluded.at`).run(id, notifiedOn(id), at);
    },
    acknowledged: id => (db.prepare('SELECT notified_on FROM occurrence_reminder_acknowledgements WHERE occurrence_id=?')
      .get(id) as { notified_on: string } | undefined)?.notified_on === notifiedOn(id),
    controls: () => db.prepare('SELECT * FROM occurrence_reminder_controls WHERE current_ask_id IS NOT NULL ORDER BY occurrence_id')
      .all() as OccurrenceReminderControl[],
    occurrenceForAsk: ask_id => (db.prepare('SELECT occurrence_id FROM occurrence_reminder_points WHERE ask_id=?')
      .get(ask_id) as { occurrence_id: string } | undefined)?.occurrence_id ?? null,
    pointForAsk: ask_id => {
      const row = db.prepare('SELECT occurrence_id,point_key,on_date,ask_id FROM occurrence_reminder_points WHERE ask_id=?')
        .get(ask_id) as { occurrence_id: string; point_key: string; on_date: string; ask_id: string } | undefined;
      return row ? { occurrence_id: row.occurrence_id, point_key: row.point_key, on: row.on_date, ask_id: row.ask_id, skipped_keys: [] } : null;
    },
    consumeQuestion(occurrence_id, at) {
      db.prepare('INSERT OR IGNORE INTO occurrence_reminder_points(occurrence_id,point_key,on_date,ask_id,group_id,at) VALUES(?,\'last_done_question\',NULL,NULL,?,?)')
        .run(occurrence_id, `owner-question:${occurrence_id}`, at);
    },
    pending: (): StoredOccurrenceReminderPlan[] => (db.prepare("SELECT * FROM occurrence_reminder_plans WHERE phase IN ('planned','prepared','ready') ORDER BY created_at,group_id")
      .all() as PlanRow[]).map(decode),
    reserve: db.transaction((input: OccurrenceReminderPlan, at: number): StoredOccurrenceReminderPlan => {
      const id = input.delivery.group_id;
      const existing = plan(id);
      if (existing) {
        if (canonical(existing.plan) !== canonical(input)) throw new Error('Reminder plan id is already in use');
        return existing;
      }
      if (!input.points.length || input.points.length !== input.delivery.asks.length
        || new Set(input.points.map(item => item.occurrence_id)).size !== input.points.length
        || new Set(input.points.map(item => item.ask_id)).size !== input.points.length
        || input.points.some(item => !input.delivery.asks.some(ask => ask.ask_id === item.ask_id))) {
        throw new Error('A reminder plan needs one question per occurrence');
      }
      for (const item of input.points) {
        if (point(item.occurrence_id, item.point_key)) throw new Error('This reminder point is already planned');
        if (db.prepare('SELECT 1 FROM occurrence_reminder_pending WHERE occurrence_id=?').get(item.occurrence_id)) {
          throw new Error('This occurrence already has a pending reminder plan');
        }
      }
      db.prepare("INSERT INTO occurrence_reminder_plans(group_id,payload,phase,created_at,updated_at) VALUES(?,?,'planned',?,?)")
        .run(id, JSON.stringify(input), at, at);
      for (const item of input.points) {
        db.prepare('INSERT OR IGNORE INTO occurrence_reminder_controls(occurrence_id) VALUES(?)').run(item.occurrence_id);
        const previous = control(item.occurrence_id).current_ask_id;
        if (previous) db.prepare('INSERT OR IGNORE INTO occurrence_reminder_replacements(ask_id,group_id,occurrence_id,created_at) VALUES(?,?,?,?)')
          .run(previous, id, item.occurrence_id, at);
        db.prepare('INSERT INTO occurrence_reminder_pending(occurrence_id,group_id,ask_id) VALUES(?,?,?)').run(item.occurrence_id, id, item.ask_id);
        for (const key of new Set([...item.skipped_keys, item.point_key])) {
          db.prepare('INSERT OR IGNORE INTO occurrence_reminder_points(occurrence_id,point_key,on_date,ask_id,group_id,at) VALUES(?,?,?,?,?,?)')
            .run(item.occurrence_id, key, key === item.point_key ? item.on : null,
              key === item.point_key ? item.ask_id : null, id, at);
        }
      }
      return plan(id)!;
    }),
    replacements: (group_id: string): Array<{ ask_id: string; occurrence_id: string }> => db.prepare(
      'SELECT ask_id,occurrence_id FROM occurrence_reminder_replacements WHERE group_id=? AND closed_at IS NULL ORDER BY created_at,ask_id')
      .all(group_id) as Array<{ ask_id: string; occurrence_id: string }>,
    acknowledgeReplacement(ask_id: string, at: number): void {
      db.prepare('UPDATE occurrence_reminder_replacements SET closed_at=? WHERE ask_id=? AND closed_at IS NULL').run(at, ask_id);
    },
    requestCancellation(occurrence_id: string, ask_id: string, at: number): void {
      db.prepare('INSERT OR IGNORE INTO occurrence_reminder_replacements(ask_id,group_id,occurrence_id,created_at) VALUES(?,?,?,?)')
        .run(ask_id, `close:${occurrence_id}`, occurrence_id, at);
    },
    pendingCancellations: () => db.prepare('SELECT DISTINCT ask_id,occurrence_id FROM occurrence_reminder_replacements WHERE closed_at IS NULL ORDER BY created_at,ask_id')
      .all() as Array<{ ask_id: string; occurrence_id: string }>,
    activate: db.transaction((group_id: string, at: number): void => {
      const row = plan(group_id);
      if (!row || row.phase === 'abandoned') throw new Error('Reminder plan is unavailable');
      if (row.phase !== 'planned') return;
      if (db.prepare('SELECT 1 FROM occurrence_reminder_replacements WHERE group_id=? AND closed_at IS NULL').get(group_id)) {
        throw new Error('Close the previous reminder before preparing its replacement');
      }
      for (const item of row.plan.points) db.prepare('UPDATE occurrence_reminder_controls SET current_ask_id=? WHERE occurrence_id=?')
        .run(item.ask_id, item.occurrence_id);
      db.prepare("UPDATE occurrence_reminder_plans SET phase='prepared',updated_at=? WHERE group_id=?").run(at, group_id);
    }),
    ready: db.transaction((group_id: string, on: string, at: number): void => {
      const row = plan(group_id);
      if (!row || row.phase === 'abandoned' || row.phase === 'planned') throw new Error('Prepare the reminder before releasing it');
      if (row.phase === 'released' || row.phase === 'ready') return;
      for (const item of row.plan.points) db.prepare('UPDATE occurrence_reminder_controls SET last_notified_on=? WHERE occurrence_id=? AND current_ask_id=?')
        .run(on, item.occurrence_id, item.ask_id);
      db.prepare('DELETE FROM occurrence_reminder_pending WHERE group_id=?').run(group_id);
      db.prepare("UPDATE occurrence_reminder_plans SET phase='ready',updated_at=? WHERE group_id=?").run(at, group_id);
    }),
    released(group_id: string, at: number): void {
      const row = plan(group_id);
      if (!row || (row.phase !== 'ready' && row.phase !== 'released')) throw new Error('The reminder is not ready for handoff');
      db.prepare("UPDATE occurrence_reminder_plans SET phase='released',updated_at=? WHERE group_id=? AND phase='ready'").run(at, group_id);
    },
    abandon: db.transaction((group_id: string, reason: string, at: number): void => {
      const row = plan(group_id);
      if (!row || row.phase === 'abandoned') return;
      if (row.phase === 'released') throw new Error('Close a released reminder through its ask');
      for (const item of row.plan.points) db.prepare('UPDATE occurrence_reminder_controls SET current_ask_id=NULL WHERE occurrence_id=? AND current_ask_id=?')
        .run(item.occurrence_id, item.ask_id);
      db.prepare('DELETE FROM occurrence_reminder_pending WHERE group_id=?').run(group_id);
      db.prepare("UPDATE occurrence_reminder_plans SET phase='abandoned',reason=?,updated_at=? WHERE group_id=?").run(reason, at, group_id);
    }),
    clearCurrent(occurrence_id: string, ask_id: string): void {
      db.prepare('UPDATE occurrence_reminder_controls SET current_ask_id=NULL WHERE occurrence_id=? AND current_ask_id=?').run(occurrence_id, ask_id);
    },
    later(occurrence_id: string, until: number): void {
      if (!Number.isFinite(until)) throw new Error('Choose a finite reminder time');
      db.prepare('INSERT INTO occurrence_reminder_controls(occurrence_id,later_until) VALUES(?,?) '
        + 'ON CONFLICT(occurrence_id) DO UPDATE SET later_until=excluded.later_until').run(occurrence_id, until);
    },
    clearLater(occurrence_id: string, expected: number): void {
      db.prepare('UPDATE occurrence_reminder_controls SET later_until=NULL WHERE occurrence_id=? AND later_until=?').run(occurrence_id, expected);
    },
    answer: db.transaction((input: Omit<OccurrenceReminderAnswer, 'applied_at'>): OccurrenceReminderAnswer => {
      db.prepare('INSERT OR IGNORE INTO occurrence_reminder_answers(ask_id,occurrence_id,outcome,answered_at,owner_action) VALUES(?,?,?,?,?)')
        .run(input.ask_id, input.occurrence_id, input.outcome, input.answered_at, input.owner_action === undefined ? null : Number(input.owner_action));
      const row = decodeAnswer(db.prepare('SELECT * FROM occurrence_reminder_answers WHERE ask_id=?').get(input.ask_id) as AnswerRow);
      if (row.occurrence_id !== input.occurrence_id || row.outcome !== input.outcome || row.answered_at !== input.answered_at) {
        throw new Error('The reminder already has a different answer');
      }
      return row;
    }),
    applied(ask_id: string, at: number): void {
      db.prepare('UPDATE occurrence_reminder_answers SET applied_at=? WHERE ask_id=? AND applied_at IS NULL').run(at, ask_id);
    },
    pendingAnswers: (): OccurrenceReminderAnswer[] => (db.prepare('SELECT * FROM occurrence_reminder_answers WHERE applied_at IS NULL ORDER BY answered_at,ask_id')
      .all() as AnswerRow[]).map(decodeAnswer),
    answers: (after = { answered_at: 0, ask_id: '' }, limit = 500): OccurrenceReminderAnswer[] => (db.prepare('SELECT * FROM occurrence_reminder_answers WHERE answered_at>? OR (answered_at=? AND ask_id>?) ORDER BY answered_at,ask_id LIMIT ?')
      .all(after.answered_at, after.answered_at, after.ask_id, Math.max(1, Math.min(1000, limit))) as AnswerRow[]).map(decodeAnswer),
    answersForOccurrence: (id): OccurrenceReminderAnswer[] => (db.prepare('SELECT * FROM occurrence_reminder_answers WHERE occurrence_id=? ORDER BY answered_at,ask_id').all(id) as AnswerRow[]).map(decodeAnswer),
    plansForOccurrence: (id): StoredOccurrenceReminderPlan[] => (db.prepare('SELECT p.* FROM occurrence_reminder_plans p WHERE group_id IN (SELECT group_id FROM occurrence_reminder_points WHERE occurrence_id=?) ORDER BY p.created_at,p.group_id')
      .all(id) as PlanRow[]).map(decode),
    open: id => !!db.prepare(`SELECT 1 FROM occurrence_reminder_controls WHERE occurrence_id=@id AND current_ask_id IS NOT NULL
      UNION ALL SELECT 1 FROM occurrence_reminder_replacements WHERE occurrence_id=@id AND closed_at IS NULL
      UNION ALL SELECT 1 FROM occurrence_reminder_pending WHERE occurrence_id=@id
      UNION ALL SELECT 1 FROM occurrence_reminder_answers WHERE occurrence_id=@id AND applied_at IS NULL
      UNION ALL SELECT 1 FROM occurrence_reminder_points r JOIN occurrence_reminder_plans p ON p.group_id=r.group_id
        WHERE r.occurrence_id=@id AND p.phase IN ('planned','prepared','ready')`).get({ id }),
    lastActivity: id => (db.prepare(`SELECT max(at) AS at FROM (SELECT at FROM occurrence_reminder_points WHERE occurrence_id=@id
      UNION ALL SELECT p.updated_at FROM occurrence_reminder_plans p JOIN occurrence_reminder_points r ON r.group_id=p.group_id WHERE r.occurrence_id=@id
      UNION ALL SELECT max(answered_at,coalesce(applied_at,0)) FROM occurrence_reminder_answers WHERE occurrence_id=@id
      UNION ALL SELECT max(created_at,coalesce(closed_at,0)) FROM occurrence_reminder_replacements WHERE occurrence_id=@id)`).get({ id }) as { at: number | null }).at,
    dropLog: db.transaction((id: string): number => {
      const groups = (db.prepare('SELECT DISTINCT group_id FROM occurrence_reminder_points WHERE occurrence_id=?').all(id) as { group_id: string }[]).map(row => row.group_id);
      let dropped = 0;
      for (const table of ['occurrence_reminder_controls', 'occurrence_reminder_points', 'occurrence_reminder_pending', 'occurrence_reminder_replacements', 'occurrence_reminder_answers',
        'occurrence_reminder_acknowledgements']) {
        dropped += db.prepare(`DELETE FROM ${table} WHERE occurrence_id=?`).run(id).changes;
      }
      const orphan = db.prepare('DELETE FROM occurrence_reminder_plans WHERE group_id=@group AND NOT EXISTS (SELECT 1 FROM occurrence_reminder_points WHERE group_id=@group)');
      for (const group of groups) dropped += orphan.run({ group }).changes;
      return dropped;
    }),
  };
};
