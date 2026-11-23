import type Database from 'better-sqlite3';
import { RpcError, type ChatPlanRecord, type ChatQueuedTurnStatus, type PromptSchedule,
  type PromptScheduleRun, type PromptScheduleRunsPage } from '@recued/contracts';
import { readPromptScheduleOutcome } from './prompt-schedule-outcome.js';

type Occurrence = { history_position: number; occurrence_id: string; session_id: string; revision: number;
  due_at: number; payload: string; turn_id: string | null; queued_at: number | null };
const bad = (message: string): never => { throw new RpcError('bad_request', message, 400); };
const conflict = (): never => { throw new RpcError('conflict', 'These older runs changed. Refresh recent runs before loading more.', 409); };

/** Cursor anchors stay in the same schedule and conversation. New insertions
 * sort ahead of the anchor; a deleted anchor requires a fresh first page. */
export const createPromptScheduleRuns = (deps: {
  db: Database.Database;
  get(id: string): Promise<PromptSchedule>;
  decode<T>(payload: string, session: string, id: string): Promise<T>;
  readPlans(session: string, turn: string): Promise<ReadonlyArray<ChatPlanRecord>>;
}) => {
  const { db } = deps;
  // A single-column SQLite index also orders its rows by rowid.
  db.exec('CREATE INDEX IF NOT EXISTS chat_prompt_occurrences_history ON chat_prompt_occurrences(schedule_id)');
  return async (raw: unknown): Promise<PromptScheduleRunsPage> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Expected a scheduled prompt history request.');
    const args = raw as Record<string, unknown>;
    if (Object.keys(args).some(key => !['schedule_id', 'cursor'].includes(key)) || typeof args.schedule_id !== 'string'
      || !args.schedule_id.trim() || args.schedule_id.length > 100) return bad('A schedule ID is required.');
    const saved = await deps.get(args.schedule_id);
    if (saved.managed_by !== undefined) throw new RpcError('forbidden', 'This schedule belongs to the Agenda. Review it on the Agenda card.', 403);
    let before = Number.MAX_SAFE_INTEGER;
    if (args.cursor !== undefined) {
      if (typeof args.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(args.cursor)) return bad('Invalid scheduled prompt history cursor.');
      let cursor: { v?: unknown; schedule_id?: unknown; session_id?: unknown; row_id?: unknown; occurrence_id?: unknown };
      try { cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')); }
      catch { return bad('Invalid scheduled prompt history cursor.'); }
      if (!cursor || Array.isArray(cursor) || cursor.v !== 1 || cursor.schedule_id !== saved.schedule_id || cursor.session_id !== saved.session_id
        || !Number.isSafeInteger(cursor.row_id) || Number(cursor.row_id) < 1 || typeof cursor.occurrence_id !== 'string' || cursor.occurrence_id.length > 180)
        return bad('This history cursor belongs to another prompt or conversation.');
      const anchor = db.prepare('SELECT 1 FROM chat_prompt_occurrences WHERE rowid=? AND schedule_id=? AND session_id=? AND occurrence_id=?')
        .get(cursor.row_id, saved.schedule_id, saved.session_id, cursor.occurrence_id);
      if (!anchor) return conflict(); before = Number(cursor.row_id);
    }
    const occurrences = db.prepare(`SELECT o.rowid AS history_position,o.occurrence_id,o.session_id,o.revision,o.due_at,o.payload,
      COALESCE(o.turn_id,submission.turn_id) AS turn_id,q.created_at AS queued_at FROM chat_prompt_occurrences o
      LEFT JOIN chat_turn_submissions submission ON submission.session_id=o.session_id AND submission.submission_id=o.occurrence_id
      LEFT JOIN chat_turn_queue q ON q.turn_id=COALESCE(o.turn_id,submission.turn_id) AND q.session_id=o.session_id
      WHERE o.schedule_id=? AND o.session_id=? AND o.rowid<? ORDER BY o.rowid DESC LIMIT 11`)
      .all(saved.schedule_id, saved.session_id, before) as Occurrence[];
    const runs: PromptScheduleRun[] = [];
    for (const occurrence of occurrences.slice(0, 10)) {
      const snapshot = await deps.decode<PromptSchedule>(occurrence.payload, saved.session_id, 'occurrence:' + occurrence.occurrence_id);
      if (!snapshot || typeof snapshot !== 'object' || snapshot.schedule_id !== saved.schedule_id || snapshot.session_id !== saved.session_id || snapshot.revision !== occurrence.revision
        || typeof snapshot.time_zone !== 'string') throw Error('This saved run could not be read.');
      try { new Intl.DateTimeFormat('en', { timeZone: snapshot.time_zone }).format(0); } catch { throw Error('This saved run has an invalid timezone.'); }
      let outcome: PromptScheduleRun['outcome'] = { status: 'needs_attention', reason: 'outcome_unknown' };
      if (occurrence.turn_id) {
        const latest = db.prepare(`SELECT q.turn_id,q.status FROM chat_turn_queue q WHERE q.session_id=@session_id AND
          (q.turn_id=@origin OR q.turn_id IN (SELECT COALESCE(h.into_turn_id,h.turn_id) FROM chat_held_result_turns h
            WHERE h.session_id=@session_id AND h.origin_turn_id=@origin))
          ORDER BY CASE WHEN q.status IN ('queued','running','cancelling') THEN 1 ELSE 0 END DESC,q.position DESC LIMIT 1`)
          .get({ session_id: saved.session_id, origin: occurrence.turn_id }) as { turn_id: string; status: ChatQueuedTurnStatus } | undefined;
        const read = await readPromptScheduleOutcome(db, { ...saved, last_turn_id: latest?.turn_id ?? occurrence.turn_id,
          last_status: latest?.status ?? 'interrupted' }, deps.readPlans, occurrence.turn_id);
        outcome = read.pending_approvals ? { status: 'needs_approval', plan_id: read.pending_approvals.plan_id,
          ...(read.pending_approvals.message_id ? { message_id: read.pending_approvals.message_id } : {}) }
          : read.pending_work ?? read.last_outcome ?? outcome;
      }
      runs.push({ occurrence_id: occurrence.occurrence_id, turn_id: occurrence.turn_id, revision: occurrence.revision,
        trigger: occurrence.occurrence_id.startsWith(saved.schedule_id + ':manual:') ? 'manual' : 'scheduled',
        due_at: occurrence.due_at, queued_at: occurrence.queued_at, time_zone: snapshot.time_zone, outcome });
    }
    if (!db.prepare('SELECT 1 FROM chat_prompt_schedules WHERE schedule_id=? AND session_id=?').get(saved.schedule_id, saved.session_id))
      throw new RpcError('not_found', 'This scheduled prompt no longer exists.', 404);
    const last = occurrences[9];
    const next_cursor = occurrences.length > 10 && last ? Buffer.from(JSON.stringify({ v: 1, schedule_id: saved.schedule_id,
      session_id: saved.session_id, row_id: last.history_position, occurrence_id: last.occurrence_id })).toString('base64url') : null;
    return { schedule_id: saved.schedule_id, session_id: saved.session_id, runs, next_cursor };
  };
};
