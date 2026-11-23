import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, type PromptSchedule, type PromptScheduleSkipRequest, type PromptScheduleUndoSkipRequest,
  type PromptScheduleSkipState } from '@recued/contracts';
import { nextCronMatch } from '@recued/scheduler';

type Action = 'skip_next' | 'undo_skip';
type Request = PromptScheduleSkipRequest | PromptScheduleUndoSkipRequest;
type State = { schedule_id: string; revision: number; skip_id: string | null; run_at: number | null;
  following_run_at: number | null; last_action: Action | null; last_request: string | null };
type Clock = { revision: number; enabled: number; next_run_at: number | null };
const conflict = (message: string): never => { throw new RpcError('conflict', message, 409); };
const bad = (message: string): never => { throw new RpcError('bad_request', message, 400); };
const instant = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8.64e15;

/** One bounded row per schedule: clock CAS and the latest operation receipt.
 * Clock changes leave the configuration revision and existing queue entries alone. */
export const createPromptScheduleSkipClock = (db: Database.Database, now: () => number) => {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_prompt_schedule_skips (
    schedule_id TEXT PRIMARY KEY REFERENCES chat_prompt_schedules(schedule_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, skip_id TEXT, run_at INTEGER, following_run_at INTEGER,
    last_action TEXT, last_request TEXT
  )`);
  const read = (id: string) => db.prepare('SELECT * FROM chat_prompt_schedule_skips WHERE schedule_id=?').get(id) as State | undefined;
  const active = (state: State | undefined, next: number | null) => !!state?.skip_id && state.run_at !== null && state.following_run_at !== null && state.following_run_at === next;
  const following = (saved: PromptSchedule, at: number) => nextCronMatch(saved.cron_expression!.split(' '), at + 60000, 527040, saved.time_zone);
  const parse = (action: Action, input: unknown): Request => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Expected a scheduled run change.');
    const raw = input as Record<string, unknown>;
    const allowed = ['schedule_id', 'expected_revision', 'expected_skip_revision', action === 'skip_next' ? 'run_at' : 'skip_id'];
    if (Object.keys(raw).some(key => !allowed.includes(key)) || typeof raw.schedule_id !== 'string' || !raw.schedule_id.trim() || raw.schedule_id.length > 100
      || !Number.isSafeInteger(raw.expected_revision) || Number(raw.expected_revision) < 1
      || !Number.isSafeInteger(raw.expected_skip_revision) || Number(raw.expected_skip_revision) < 0) return bad('The schedule and both current revisions are required.');
    const base = { schedule_id: raw.schedule_id, expected_revision: Number(raw.expected_revision), expected_skip_revision: Number(raw.expected_skip_revision) };
    if (action === 'skip_next') {
      if (!instant(raw.run_at)) return bad('Choose the exact upcoming run to skip.');
      return { ...base, run_at: raw.run_at };
    }
    if (typeof raw.skip_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.skip_id)) return bad('Choose the saved skip to undo.');
    return { ...base, skip_id: raw.skip_id };
  };
  const check = (request: Request, saved: PromptSchedule, current: Clock | undefined, state: State | undefined) => {
    if (!current) throw new RpcError('not_found', 'Scheduled prompt no longer exists.', 404);
    if (current.revision !== request.expected_revision || saved.revision !== current.revision
      || (state?.revision ?? 0) !== request.expected_skip_revision) return conflict('This scheduled run changed. Refresh and review it before trying again.');
    if (saved.mode !== 'recurring' || saved.managed_by !== undefined || current.enabled !== 1) return conflict('Only an active recurring prompt can skip a run.');
  };
  const checkUpcoming = (request: PromptScheduleSkipRequest, current: Clock, state: State | undefined) => {
    if (request.run_at !== current.next_run_at || request.run_at <= now()) return conflict('This run is already due or has changed. Refresh to review its current state.');
    if (active(state, current.next_run_at) && state!.run_at! > now()) return conflict('A run is already skipped. Undo that skip before choosing another.');
    if (db.prepare(`SELECT 1 FROM chat_prompt_occurrences WHERE schedule_id=? AND due_at=?
      AND occurrence_id=(schedule_id || ':' || revision || ':' || due_at) LIMIT 1`).get(request.schedule_id, request.run_at))
      return conflict('This run was already admitted. Review its conversation instead.');
  };
  return {
    parse,
    preview(request: PromptScheduleSkipRequest, saved: PromptSchedule) {
      return db.transaction(() => {
        const current = db.prepare('SELECT revision,enabled,next_run_at FROM chat_prompt_schedules WHERE schedule_id=?').get(request.schedule_id) as Clock | undefined;
        const state = read(request.schedule_id); check(request, saved, current, state); checkUpcoming(request, current!, state);
        const next = following(saved, request.run_at);
        if (next === null) return conflict('The following run could not be confirmed. Edit the schedule to choose its timing.');
        return { ...request, following_run_at: next, time_zone: saved.time_zone };
      }).deferred();
    },
    keepsNext: (id: string, at: number | null) => active(read(id), at),
    invalidate(id: string) {
      db.prepare(`UPDATE chat_prompt_schedule_skips SET revision=revision+1, skip_id=NULL, run_at=NULL,
        following_run_at=NULL, last_action=NULL, last_request=NULL WHERE schedule_id=?`).run(id);
    },
    view(saved: PromptSchedule): PromptScheduleSkipState | undefined {
      if (saved.mode !== 'recurring' || saved.managed_by !== undefined) return;
      const state = read(saved.schedule_id), at = now();
      const result: PromptScheduleSkipState = { revision: state?.revision ?? 0 };
      const kept = saved.enabled && active(state, saved.next_run_at);
      if (kept) result.skipped = { skip_id: state!.skip_id!, run_at: state!.run_at!, following_run_at: state!.following_run_at!, undo_available: state!.run_at! > at };
      if (saved.enabled && saved.next_run_at !== null && saved.next_run_at > at && (!kept || state!.run_at! <= at)) {
        result.next = { run_at: saved.next_run_at };
      }
      return result;
    },
    change(action: Action, request: Request, saved: PromptSchedule): { revision: number; replayed: boolean } {
      return db.transaction(() => {
        const current = db.prepare('SELECT revision,enabled,next_run_at FROM chat_prompt_schedules WHERE schedule_id=?').get(request.schedule_id) as Clock | undefined;
        if (!current) throw new RpcError('not_found', 'Scheduled prompt no longer exists.', 404);
        const state = read(request.schedule_id), fingerprint = JSON.stringify(request);
        if (state?.last_action === action && state.last_request === fingerprint) return { revision: state.revision, replayed: true };
        check(request, saved, current, state);
        const at = now(); let skipId: string | null = null, runAt: number | null = null, followingAt: number | null = null, nextAt: number;
        if (action === 'skip_next') {
          const wanted = (request as PromptScheduleSkipRequest).run_at;
          checkUpcoming(request as PromptScheduleSkipRequest, current, state);
          const next = following(saved, wanted);
          if (next === null) return conflict('The following run could not be confirmed. Edit the schedule to choose its timing.');
          skipId = randomUUID(); runAt = wanted; followingAt = next; nextAt = next;
        } else {
          if (!active(state, current.next_run_at) || state!.skip_id !== (request as PromptScheduleUndoSkipRequest).skip_id
            || state!.run_at! <= at) return conflict('This skip can no longer be undone. Refresh to review the next run.');
          nextAt = state!.run_at!;
        }
        const due = action === 'skip_next' ? runAt! : nextAt;
        if (db.prepare(`SELECT 1 FROM chat_prompt_occurrences WHERE schedule_id=? AND due_at=?
          AND occurrence_id=(schedule_id || ':' || revision || ':' || due_at) LIMIT 1`).get(request.schedule_id, due))
          return conflict('This run was already admitted. Review its conversation instead.');
        if (due <= now()) return conflict('The original run time has passed. Refresh to review the next run.');
        const revision = (state?.revision ?? 0) + 1;
        db.prepare('UPDATE chat_prompt_schedules SET next_run_at=? WHERE schedule_id=?').run(nextAt, request.schedule_id);
        db.prepare(`INSERT INTO chat_prompt_schedule_skips VALUES (?,?,?,?,?,?,?) ON CONFLICT(schedule_id) DO UPDATE SET
          revision=excluded.revision,skip_id=excluded.skip_id,run_at=excluded.run_at,following_run_at=excluded.following_run_at,
          last_action=excluded.last_action,last_request=excluded.last_request`)
          .run(request.schedule_id, revision, skipId, runAt, followingAt, action, fingerprint);
        return { revision, replayed: false };
      }).immediate();
    },
  };
};
