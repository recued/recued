import type Database from 'better-sqlite3';
import type { PromptSchedule } from '@recued/contracts';

export interface PromptScheduleQueueFailure {
  enabled: number;
  revision: number;
  next_run_at: number | null;
  queue_revision: number | null;
  queue_due_at: number | null;
  queue_since_at: number | null;
  admitted_turn_id: string | null;
}

/** Old errors cease to be current after an edit, pause, removal or admission. */
export const currentPromptQueueIssue = (row: PromptScheduleQueueFailure): PromptSchedule['scheduling_issue'] =>
  row.enabled === 1 && row.queue_revision === row.revision && row.queue_due_at === row.next_run_at
    && row.queue_since_at !== null && row.admitted_turn_id === null
    ? { code: 'queue_unconfirmed', since_at: row.queue_since_at } : null;

export interface PromptScheduleHealthSnapshot extends PromptScheduleQueueFailure {
  schedule_id: string;
  session_id: string;
  turn_id: string | null;
  status: PromptSchedule['last_status'];
}

export const promptScheduleHealthStamp = (row: PromptScheduleHealthSnapshot): string =>
  JSON.stringify([row.revision, row.enabled, row.next_run_at, row.turn_id, row.status, currentPromptQueueIssue(row)]);

export interface PromptScheduleFailureNotice {
  schedule_id: string;
  session_id: string;
  episode_no: number;
  episode_kind: 'admission' | 'run';
  notice_at: number;
  history_recorded: number;
  failure_key: string | null;
  plan_id: string | null;
  message_id: string | null;
}
export interface PromptScheduleFailureSignal {
  failure_key: string;
  schedule_id: string;
  session_id: string;
  turn_id: string;
  source_kind: 'plan' | 'tool' | 'turn';
  source_id: string;
  checkpoint_turn_id: string | null;
  checkpoint_complete: number;
}
export const promptScheduleNoticeId = (notice: Pick<PromptScheduleFailureNotice, 'schedule_id' | 'episode_no'>): string =>
  `prompt-failure:${notice.schedule_id}:${notice.episode_no}`;

/** Notification metadata only. Requests and results stay in encrypted Chat storage. */
export const createPromptScheduleHealthStore = (db: Database.Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_prompt_schedule_notices (
    schedule_id TEXT PRIMARY KEY REFERENCES chat_prompt_schedules(schedule_id) ON DELETE CASCADE,
    queue_revision INTEGER, queue_due_at INTEGER, queue_since_at INTEGER,
    episode_no INTEGER NOT NULL DEFAULT 0, episode_kind TEXT,
    episode_open INTEGER NOT NULL DEFAULT 0, notice_at INTEGER,
    history_recorded INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER,
    failure_key TEXT
  )`);
  // Catch-up is a delivery surface too. Keep unclaimed history out of it,
  // including obsolete episodes and removed schedules; the audit stays intact.
  db.exec(`CREATE TABLE IF NOT EXISTS chat_prompt_notice_holds (activity_id TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO chat_prompt_notice_holds
      SELECT 'prompt-failure:' || schedule_id || ':' || episode_no FROM chat_prompt_schedule_notices
      WHERE episode_no>0 AND claimed_at IS NULL;`);
  // A failed action may settle after its Chat turn and a newer response.
  // Capture that metadata with the failure write, before any notification I/O.
  db.exec(`CREATE INDEX IF NOT EXISTS chat_prompt_occurrences_turn ON chat_prompt_occurrences(session_id, turn_id);
    CREATE TABLE IF NOT EXISTS chat_prompt_failure_signals (
      failure_key TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES chat_prompt_schedules(schedule_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL, turn_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
      checkpoint_turn_id TEXT, checkpoint_complete INTEGER NOT NULL, observed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS chat_prompt_failure_signals_pending ON chat_prompt_failure_signals(observed);
    CREATE TRIGGER IF NOT EXISTS chat_prompt_plan_failed AFTER UPDATE OF execution_status, execution_updated_at ON chat_plans
    WHEN NEW.execution_status IN ('failed','unknown') BEGIN
      INSERT OR IGNORE INTO chat_prompt_failure_signals
        (failure_key,schedule_id,session_id,turn_id,source_kind,source_id,checkpoint_turn_id,checkpoint_complete)
      SELECT 'plan:' || NEW.plan_id || ':' || COALESCE(NEW.execution_updated_at,0) || ':' || NEW.execution_status,
        o.schedule_id,o.session_id,o.turn_id,'plan',NEW.plan_id,
        (SELECT turn_id FROM chat_prompt_occurrences WHERE schedule_id=o.schedule_id ORDER BY due_at DESC,rowid DESC LIMIT 1),
        COALESCE((SELECT q.status='completed' FROM chat_prompt_occurrences recent JOIN chat_turn_queue q ON q.turn_id=recent.turn_id
          WHERE recent.schedule_id=o.schedule_id ORDER BY recent.due_at DESC,recent.rowid DESC LIMIT 1),0)
      FROM chat_prompt_occurrences o JOIN chat_prompt_schedules live ON live.schedule_id=o.schedule_id
        WHERE o.session_id=NEW.session_id AND o.turn_id=NEW.turn_id;
    END;`);
  for (const action of ['INSERT', 'UPDATE OF metadata_blob'] as const) {
    const suffix = action === 'INSERT' ? 'insert' : 'update';
    db.exec(`CREATE TRIGGER IF NOT EXISTS chat_prompt_tool_failed_${suffix} AFTER ${action} ON chat_messages
      WHEN NEW.role='tool' AND CASE WHEN json_valid(NEW.metadata_blob)
        THEN json_extract(NEW.metadata_blob,'$.tool_call.state') IN ('failed','interrupted')
          AND COALESCE(json_extract(NEW.metadata_blob,'$.tool_call.denied'),0)<>1 ELSE 0 END BEGIN
        INSERT OR IGNORE INTO chat_prompt_failure_signals
          (failure_key,schedule_id,session_id,turn_id,source_kind,source_id,checkpoint_turn_id,checkpoint_complete)
        SELECT 'tool:' || NEW.message_id || ':' || json_extract(NEW.metadata_blob,'$.tool_call.state'),
          o.schedule_id,o.session_id,o.turn_id,'tool',NEW.message_id,
          (SELECT turn_id FROM chat_prompt_occurrences WHERE schedule_id=o.schedule_id ORDER BY due_at DESC,rowid DESC LIMIT 1),
          COALESCE((SELECT q.status='completed' FROM chat_prompt_occurrences recent JOIN chat_turn_queue q ON q.turn_id=recent.turn_id
            WHERE recent.schedule_id=o.schedule_id ORDER BY recent.due_at DESC,recent.rowid DESC LIMIT 1),0)
        FROM chat_prompt_occurrences o JOIN chat_prompt_schedules live ON live.schedule_id=o.schedule_id
          WHERE o.session_id=NEW.session_id AND o.turn_id=NEW.turn_id;
      END;`);
  }
  const view = `SELECT s.schedule_id, s.session_id, s.revision, s.enabled, s.next_run_at,
      n.queue_revision, n.queue_due_at, n.queue_since_at, admitted.turn_id AS admitted_turn_id, o.turn_id, q.status
    FROM chat_prompt_schedules s
    LEFT JOIN chat_prompt_schedule_notices n ON n.schedule_id=s.schedule_id
    LEFT JOIN chat_prompt_occurrences admitted ON admitted.occurrence_id=(s.schedule_id || ':' || s.revision || ':' || s.next_run_at)
    LEFT JOIN chat_prompt_occurrences o ON o.rowid=(SELECT recent.rowid FROM chat_prompt_occurrences recent
      WHERE recent.schedule_id=s.schedule_id ORDER BY recent.due_at DESC, recent.rowid DESC LIMIT 1)
    LEFT JOIN chat_turn_queue q ON q.turn_id=o.turn_id`;
  const all = db.prepare(view + ' ORDER BY s.rowid');
  const one = db.prepare(view + ' WHERE s.schedule_id=?');
  const recordQueueFailure = db.prepare(`INSERT INTO chat_prompt_schedule_notices
    (schedule_id, queue_revision, queue_due_at, queue_since_at)
    SELECT schedule_id, revision, next_run_at, ? FROM chat_prompt_schedules
      WHERE schedule_id=? AND revision=? AND enabled=1 AND next_run_at=?
    ON CONFLICT(schedule_id) DO UPDATE SET queue_revision=excluded.queue_revision,
      queue_due_at=excluded.queue_due_at, queue_since_at=excluded.queue_since_at
    WHERE chat_prompt_schedule_notices.queue_revision IS NOT excluded.queue_revision
      OR chat_prompt_schedule_notices.queue_due_at IS NOT excluded.queue_due_at`);
  const open = db.prepare(`INSERT INTO chat_prompt_schedule_notices
    (schedule_id, episode_no, episode_kind, episode_open, notice_at)
    SELECT schedule_id, 1, ?, 1, ? FROM chat_prompt_schedules WHERE schedule_id=?
    ON CONFLICT(schedule_id) DO UPDATE SET episode_no=episode_no+1, episode_kind=excluded.episode_kind,
      episode_open=1, notice_at=excluded.notice_at, history_recorded=0, claimed_at=NULL, failure_key=NULL
    WHERE chat_prompt_schedule_notices.episode_open=0`);
  const resolve = db.prepare(`UPDATE chat_prompt_schedule_notices SET episode_open=0
    WHERE schedule_id=? AND episode_open=1 AND (? IS NULL OR episode_kind=?)`);
  const pending = db.prepare(`SELECT n.schedule_id, s.session_id, n.episode_no, n.episode_kind,
      n.notice_at, n.history_recorded, n.failure_key,
      CASE WHEN f.source_kind='plan' THEN f.source_id ELSE NULL END AS plan_id,
      CASE WHEN f.source_kind='tool' THEN f.source_id ELSE NULL END AS message_id
    FROM chat_prompt_schedule_notices n JOIN chat_prompt_schedules s ON s.schedule_id=n.schedule_id
    LEFT JOIN chat_prompt_failure_signals f ON f.failure_key=n.failure_key
    WHERE n.episode_open=1 AND n.claimed_at IS NULL ORDER BY n.notice_at, n.schedule_id`);
  const history = db.prepare(`UPDATE chat_prompt_schedule_notices SET history_recorded=1
    WHERE schedule_id=? AND episode_no=? AND episode_open=1 AND history_recorded=0`);
  const claim = db.prepare(`UPDATE chat_prompt_schedule_notices SET claimed_at=?
    WHERE schedule_id=? AND episode_no=? AND episode_open=1 AND history_recorded=1 AND claimed_at IS NULL AND failure_key IS ?`);
  const hold = db.prepare(`INSERT OR IGNORE INTO chat_prompt_notice_holds
    SELECT 'prompt-failure:' || schedule_id || ':' || episode_no FROM chat_prompt_schedule_notices
    WHERE schedule_id=? AND episode_open=1 AND claimed_at IS NULL`);
  const openEpisode = db.transaction((id: string, kind: PromptScheduleFailureNotice['episode_kind'], at: number): void => {
    open.run(kind, at, id); hold.run(id);
  });
  const claimNotice = db.transaction((notice: PromptScheduleFailureNotice, at: number): boolean => {
    if (!claim.run(at, notice.schedule_id, notice.episode_no, notice.failure_key).changes) return false;
    db.prepare('DELETE FROM chat_prompt_notice_holds WHERE activity_id=?').run(promptScheduleNoticeId(notice));
    return true;
  });
  const attachSignal = db.prepare(`UPDATE chat_prompt_schedule_notices SET failure_key=?
    WHERE schedule_id=? AND episode_open=1 AND failure_key IS NOT ?`);
  const signal = db.prepare('SELECT * FROM chat_prompt_failure_signals WHERE failure_key=?');
  // Native decoder failures complete the Chat transport with a diagnostic
  // reply. Keep their outcome separate from the queue's delivery status.
  const recordTurnFailure = db.prepare(`INSERT OR IGNORE INTO chat_prompt_failure_signals
    (failure_key,schedule_id,session_id,turn_id,source_kind,source_id,checkpoint_turn_id,checkpoint_complete)
    SELECT 'turn:' || o.turn_id,o.schedule_id,o.session_id,o.turn_id,'turn',o.turn_id,
      (SELECT turn_id FROM chat_prompt_occurrences WHERE schedule_id=o.schedule_id ORDER BY due_at DESC,rowid DESC LIMIT 1),
      COALESCE((SELECT q.status='completed' FROM chat_prompt_occurrences recent JOIN chat_turn_queue q ON q.turn_id=recent.turn_id
        WHERE recent.schedule_id=o.schedule_id ORDER BY recent.due_at DESC,recent.rowid DESC LIMIT 1),0)
    FROM chat_prompt_occurrences o JOIN chat_prompt_schedules live ON live.schedule_id=o.schedule_id
    WHERE o.session_id=? AND o.turn_id=?`);
  const unseen = db.prepare('SELECT * FROM chat_prompt_failure_signals WHERE observed=0 ORDER BY rowid LIMIT 100');
  const planFailed = db.prepare("SELECT 1 FROM chat_plans WHERE session_id=? AND plan_id=? AND execution_status IN ('failed','unknown')");
  const toolFailed = db.prepare(`SELECT 1 FROM chat_messages WHERE session_id=? AND message_id=? AND CASE WHEN json_valid(metadata_blob)
    THEN json_extract(metadata_blob,'$.tool_call.state') IN ('failed','interrupted')
      AND COALESCE(json_extract(metadata_blob,'$.tool_call.denied'),0)<>1 ELSE 0 END`);
  const stillFailed = (value: PromptScheduleFailureSignal): boolean => value.source_kind === 'turn'
    || !!(value.source_kind === 'plan' ? planFailed : toolFailed).get(value.session_id, value.source_id);
  const noticeSignal = db.prepare('SELECT failure_key FROM chat_prompt_schedule_notices WHERE schedule_id=? AND episode_open=1');
  const unresolvedSignal = (id: string, latest: string | null, finished: boolean): PromptScheduleFailureSignal | undefined => {
    const notice = noticeSignal.get(id) as { failure_key: string | null } | undefined;
    const value = notice?.failure_key ? signal.get(notice.failure_key) as PromptScheduleFailureSignal | undefined : undefined;
    const laterSuccess = value && finished && (value.checkpoint_turn_id !== latest || value.checkpoint_complete === 0);
    return value && !laterSuccess && stillFailed(value) ? value : undefined;
  };
  const observeSignal = db.transaction((value: PromptScheduleFailureSignal, at: number, finished: boolean, failed: boolean): void => {
    const current = one.get(value.schedule_id) as PromptScheduleHealthSnapshot | undefined;
    if (failed && current && stillFailed(value) && (!finished || current.turn_id === value.checkpoint_turn_id && value.checkpoint_complete === 1)) {
      openEpisode(value.schedule_id, 'run', at);
      attachSignal.run(value.failure_key, value.schedule_id, value.failure_key);
    }
    db.prepare('UPDATE chat_prompt_failure_signals SET observed=1 WHERE failure_key=?').run(value.failure_key);
  });
  return {
    snapshot: () => all.all() as PromptScheduleHealthSnapshot[],
    get: (id: string) => one.get(id) as PromptScheduleHealthSnapshot | undefined,
    recordQueueFailure: (id: string, revision: number, dueAt: number, at: number): boolean =>
      recordQueueFailure.run(at, id, revision, dueAt).changes > 0,
    open: (id: string, kind: PromptScheduleFailureNotice['episode_kind'], at: number): void => { openEpisode(id, kind, at); },
    resolve: (id: string, kind?: PromptScheduleFailureNotice['episode_kind']): void => { resolve.run(id, kind ?? null, kind ?? null); },
    pending: () => pending.all() as PromptScheduleFailureNotice[],
    recordHistory: (notice: PromptScheduleFailureNotice): boolean => history.run(notice.schedule_id, notice.episode_no).changes > 0,
    claim: (notice: PromptScheduleFailureNotice, at: number): boolean => claimNotice(notice, at),
    attachSignal: (id: string, key: string): void => { attachSignal.run(key, id, key); },
    unseen: () => unseen.all() as PromptScheduleFailureSignal[],
    observeSignal: (value: PromptScheduleFailureSignal, at: number, finished: boolean, failed: boolean): void => { observeSignal(value, at, finished, failed); },
    unresolvedSignal,
    signal: (key: string) => signal.get(key) as PromptScheduleFailureSignal | undefined,
    recordTurnFailure: (session: string, turn: string): boolean => recordTurnFailure.run(session, turn).changes > 0,
    heldNoticeIds: (): ReadonlySet<string> => new Set((db.prepare('SELECT activity_id FROM chat_prompt_notice_holds').all() as Array<{ activity_id: string }>).map(row => row.activity_id)),
  };
};
export type PromptScheduleHealthStore = ReturnType<typeof createPromptScheduleHealthStore>;
