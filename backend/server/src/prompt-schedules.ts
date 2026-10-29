import { createHash, createHmac, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, type PromptSchedule, type PromptScheduleInput,
  type PromptScheduleTarget, type PromptScheduleUpdate, type ScheduledPromptOrigin,
  type ChatTurnAcceptance, type ChatQueuedTurnStatus } from '@recued/contracts';
import { nextCronMatch } from '@recued/scheduler';
import { encodeChatContentForStorage, decodeChatContentFromStorage,
  type ChatKeyProvider, type ChatStore } from './storage/chat-store.js';
import type { ChatTurnQueue } from './chat-turn-queue.js';
import type { ChatOrchestrator, ChatBroadcastEmitter, BroadcastChatEvent } from './chat-orchestrator.js';
import { readPromptScheduleOutcome, promptScheduleWorkStamp } from './prompt-schedule-outcome.js';
import { resolvePromptScheduleTiming, previewPromptScheduleTiming } from './prompt-schedule-timing.js';
import { createPromptScheduleHealthStore, currentPromptQueueIssue, type PromptScheduleQueueFailure, type PromptScheduleFailureSignal } from './prompt-schedule-health.js';

type Row = { schedule_id: string; session_id: string; revision: number; enabled: number;
  next_run_at: number | null; payload: string; creation_hash: string };
type Occurrence = { occurrence_id: string; schedule_id: string; session_id: string;
  revision: number; due_at: number; turn_id: string | null; payload: string };
const bad = (message: string): never => { throw new RpcError('bad_request', message, 400); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('Expected an object.');
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return bad(`${name} must contain 1–${max} characters.`);
  return value.trim();
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Uses the existing chat queue and cron clock. No second agent or execution store. */
export const createPromptSchedules = (deps: {
  db: Database.Database; store: ChatStore; queue: ChatTurnQueue;
  instanceId: string;
  runTurn: ChatOrchestrator['runTurn']; getKey?: ChatKeyProvider | undefined;
  broadcast?: ChatBroadcastEmitter | undefined; now?: () => number;
  recordChange?: (action: string, id: string, revision: number) => void;
  readPlans: (session: string, turn: string) => Promise<ReadonlyArray<import('@recued/contracts').ChatPlanRecord>>;
}) => {
  const { db, store, queue } = deps;
  const now = deps.now ?? Date.now;
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_prompt_schedules (
      schedule_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, enabled INTEGER NOT NULL, next_run_at INTEGER, payload TEXT NOT NULL, creation_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_prompt_schedules_due ON chat_prompt_schedules(enabled, next_run_at);
    CREATE TABLE IF NOT EXISTS chat_prompt_occurrences (
      occurrence_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, due_at INTEGER NOT NULL, turn_id TEXT, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_prompt_occurrences_schedule ON chat_prompt_occurrences(schedule_id, due_at);
    CREATE TABLE IF NOT EXISTS chat_prompt_schedule_tombstones (schedule_id TEXT PRIMARY KEY);
    CREATE TRIGGER IF NOT EXISTS chat_prompt_delete BEFORE DELETE ON chat_prompt_schedules BEGIN
      INSERT OR IGNORE INTO chat_prompt_schedule_tombstones VALUES (OLD.schedule_id);
      UPDATE chat_queue_revisions SET revision=revision+1 WHERE session_id=OLD.session_id AND EXISTS
        (SELECT 1 FROM chat_prompt_occurrences o JOIN chat_turn_queue q ON q.turn_id=o.turn_id
          WHERE o.schedule_id=OLD.schedule_id AND q.status='queued');
      UPDATE chat_turn_queue SET status='cancelled' WHERE status='queued' AND turn_id IN
        (SELECT turn_id FROM chat_prompt_occurrences WHERE schedule_id=OLD.schedule_id);
    END;
  `);
  const health = createPromptScheduleHealthStore(db);
  const recordChange = (action: string, id: string, revision: number): void => {
    try { deps.recordChange?.(action, id, revision); } catch { /* Audit delivery is best effort, like chat metadata changes. */ }
  };
  const row = (id: string): Row | undefined => db.prepare('SELECT * FROM chat_prompt_schedules WHERE schedule_id=?').get(id) as Row | undefined;
  const decode = async <T>(payload: string, session: string, id: string): Promise<T> =>
    JSON.parse(await decodeChatContentFromStorage(payload, { session_id: session, message_id: id }, deps.getKey)) as T;
  const encode = (value: unknown, session: string, id: string): Promise<string> =>
    encodeChatContentForStorage(JSON.stringify(value), { session_id: session, message_id: id }, deps.getKey);
  const announce = (session: string): void => {
    try { deps.broadcast?.emit({ kind: 'chat.session_changed', session_id: session, field: 'queue', value: true }); }
    catch { /* A reload reads the authoritative row. */ }
  };
  const hasPending = (id: string, revision: number, except = ''): boolean => !!db.prepare(`SELECT 1
    FROM chat_prompt_occurrences o LEFT JOIN chat_turn_queue q ON q.turn_id=o.turn_id
    WHERE o.schedule_id=? AND o.occurrence_id<>? AND
      (q.status IN ('queued','running','cancelling') OR o.turn_id IS NULL AND o.revision=?) LIMIT 1`)
    .get(id, except, revision);
  const hasApprovals = (id: string): boolean => !!db.prepare(`SELECT 1 FROM chat_prompt_occurrences o
    JOIN chat_plans p ON p.session_id=o.session_id AND p.turn_id=o.turn_id
    WHERE o.schedule_id=? AND p.status='proposed' LIMIT 1`).get(id);
  const get = async (id: string): Promise<PromptSchedule> => {
    const found = db.prepare(`SELECT s.*, n.queue_revision, n.queue_due_at, n.queue_since_at, admitted.turn_id AS admitted_turn_id
      FROM chat_prompt_schedules s LEFT JOIN chat_prompt_schedule_notices n ON n.schedule_id=s.schedule_id
      LEFT JOIN chat_prompt_occurrences admitted ON admitted.occurrence_id=(s.schedule_id || ':' || s.revision || ':' || s.next_run_at)
      WHERE s.schedule_id=?`).get(id) as (Row & PromptScheduleQueueFailure) | undefined;
    if (!found) throw new RpcError('not_found', 'Scheduled prompt no longer exists.', 404);
    const saved = await decode<PromptSchedule>(found.payload, found.session_id, id);
    const latest = db.prepare(`SELECT o.occurrence_id, o.turn_id, o.due_at, o.revision, q.status FROM chat_prompt_occurrences o
      LEFT JOIN chat_turn_queue q ON q.turn_id=o.turn_id WHERE o.schedule_id=? ORDER BY o.due_at DESC, o.rowid DESC LIMIT 1`)
      .get(id) as { occurrence_id: string; turn_id: string | null; due_at: number; revision: number; status: PromptSchedule['last_status'] } | undefined;
    const schedule: PromptSchedule = { ...saved, enabled: found.enabled === 1, revision: found.revision, next_run_at: found.next_run_at,
      ...(latest ? { last_run_at: latest.due_at, last_turn_id: latest.turn_id,
        last_status: latest.status ?? (latest.revision === found.revision ? 'queued' : 'cancelled') } : {}) };
    const outcome = await readPromptScheduleOutcome(db, schedule, deps.readPlans);
    const blocked = ['queued', 'running', 'cancelling', 'needs_approval'].includes(outcome.last_outcome?.status ?? '')
      || ['awaiting_execution', 'action_held'].includes(outcome.last_outcome?.reason ?? '');
    const admitted = found.admitted_turn_id ?? (latest?.occurrence_id === `${id}:${found.revision}:${found.next_run_at}` ? latest.turn_id : null);
    return { ...schedule, ...outcome, scheduling_issue: currentPromptQueueIssue({ ...found, admitted_turn_id: admitted }), run_request_scope: deps.instanceId,
      run_now_available: !blocked && !outcome.pending_approvals && !outcome.pending_work && !hasPending(id, found.revision) };
  };
  const list = async (session?: string): Promise<PromptSchedule[]> => {
    const ids = db.prepare(`SELECT schedule_id FROM chat_prompt_schedules${session ? ' WHERE session_id=?' : ''} ORDER BY rowid DESC`)
      .all(...(session ? [session] : [])) as Array<{ schedule_id: string }>;
    return Promise.all(ids.map(r => get(r.schedule_id)));
  };
  const validate = (raw: unknown, allowPast = false): PromptScheduleInput => {
    const args = object(raw);
    if (Object.keys(args).some(key => !['title', 'prompt', 'mode', 'time_zone', 'run_at', 'cron_expression', 'creation_id'].includes(key))) return bad('Unknown scheduled prompt field.');
    const title = text(args.title, 'Title', 160), prompt = text(args.prompt, 'Prompt', 32000);
    const { title: _title, prompt: _prompt, creation_id: _creation, ...timing } = args;
    return { title, prompt, ...resolvePromptScheduleTiming(timing, now(), allowPast).timing };
  };
  const next = (input: PromptScheduleInput): number | null => input.mode === 'one_shot'
    ? Date.parse(input.run_at!) : nextCronMatch(input.cron_expression!.split(' '), Math.floor(now() / 60000) * 60000 + 60000, undefined, input.time_zone);
  const create = async (raw: unknown, creationId: string, check = false): Promise<PromptSchedule | null> => {
    text(creationId, 'Creation ID', 300);
    const id = `ps_${hash(creationId).slice(0, 32)}`;
    const removed = () => !!db.prepare('SELECT 1 FROM chat_prompt_schedule_tombstones WHERE schedule_id=?').get(id);
    if (removed()) throw new RpcError('conflict', 'This creation request was removed. Use a new creation ID for a new schedule.', 409);
    const found = row(id);
    const input = validate(raw, !!found);
    const key = deps.getKey ? await deps.getKey() : undefined;
    if (deps.getKey && !key) throw new Error('Chat vault is locked.');
    const fingerprint = key ? createHmac('sha256', key).update(JSON.stringify(input)).digest('hex') : hash(JSON.stringify(input));
    if (found) {
      if (found.creation_hash !== fingerprint) throw new RpcError('conflict', 'This creation ID already names another scheduled prompt.', 409);
      return get(id);
    }
    if ((db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_schedules').get() as { n: number }).n >= 200) return bad('At most 200 scheduled prompts can be saved.');
    if (check) return null;
    const session_id = `scheduled-${randomUUID()}`;
    const { run_at, ...settings } = input;
    const made: PromptSchedule = { ...settings, ...(run_at ? { run_at: Date.parse(run_at) } : {}),
      schedule_id: id, session_id, revision: 1, enabled: true, created_at: now(), next_run_at: next(input),
      last_run_at: null, last_turn_id: null, last_status: null };
    const payload = await encode(made, session_id, id);
    const inserted = db.transaction(() => {
      if (removed()) throw new RpcError('conflict', 'This creation request was removed.', 409);
      if (row(id)) return false;
      if ((db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_schedules').get() as { n: number }).n >= 200) return bad('At most 200 scheduled prompts can be saved.');
      store.createSession({ id: session_id, title: input.title });
      db.prepare('INSERT INTO chat_prompt_schedules VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, session_id, 1, 1, made.next_run_at, payload, fingerprint);
      return true;
    }).immediate();
    const committed = row(id)!;
    if (committed.creation_hash !== fingerprint) throw new RpcError('conflict', 'This creation ID already names another scheduled prompt.', 409);
    if (inserted) { recordChange('created', id, 1); announce(committed.session_id); }
    return get(id);
  };
  const target = (raw: unknown): Row => {
    const args = object(raw), id = text(args.schedule_id, 'Schedule ID', 100);
    const found = row(id);
    if (!found) throw new RpcError('not_found', 'Scheduled prompt no longer exists.', 404);
    if (args.expected_revision !== undefined && args.expected_revision !== found.revision) throw new RpcError('conflict', 'The schedule changed. Reload it before editing.', 409);
    return found;
  };
  const cancelQueued = (id: string): void => {
    // Queue snapshots use this revision to reject a stale in-flight refresh.
    db.prepare(`UPDATE chat_queue_revisions SET revision=revision+1 WHERE session_id IN
      (SELECT o.session_id FROM chat_prompt_occurrences o JOIN chat_turn_queue q ON q.turn_id=o.turn_id
        WHERE o.schedule_id=? AND q.status='queued')`).run(id);
    db.prepare(`UPDATE chat_turn_queue SET status='cancelled' WHERE status='queued' AND turn_id IN
      (SELECT turn_id FROM chat_prompt_occurrences WHERE schedule_id=?)`).run(id);
  };
  const update = async (raw: PromptScheduleUpdate | unknown, check = false): Promise<PromptSchedule | null> => {
    const args = object(raw);
    if (Object.keys(args).some(key => !['schedule_id', 'expected_revision', 'title', 'prompt', 'time_zone', 'run_at', 'cron_expression'].includes(key))) return bad('Unknown schedule edit field. Mode cannot be changed.');
    if (!Number.isSafeInteger(args.expected_revision) || Number(args.expected_revision) < 1) return bad('An expected_revision is required to edit a schedule.');
    const before = target(args), old = await get(before.schedule_id);
    const keepPastTime = old.mode === 'one_shot' && !old.enabled
      && (args.run_at === undefined || typeof args.run_at === 'string' && Date.parse(args.run_at) === old.run_at);
    const input = validate({ title: old.title, prompt: old.prompt, mode: old.mode, time_zone: old.time_zone,
      ...(old.run_at !== undefined ? { run_at: new Date(old.run_at).toISOString() } : {}),
      ...(old.cron_expression ? { cron_expression: old.cron_expression } : {}),
      ...Object.fromEntries(Object.entries(args).filter(([key]) => ['title', 'prompt', 'time_zone', 'run_at', 'cron_expression'].includes(key))) }, keepPastTime);
    if (check) return null;
    const { last_outcome: _outcome, pending_approvals: _approvals, pending_work: _work,
      run_now_available: _available, run_request_scope: _scope, ...definition } = old;
    const changed: PromptSchedule = { ...definition, title: input.title, prompt: input.prompt, time_zone: input.time_zone,
      ...(input.run_at ? { run_at: Date.parse(input.run_at) } : {}), ...(input.cron_expression ? { cron_expression: input.cron_expression } : {}),
      revision: before.revision + 1, next_run_at: old.enabled ? next(input) : null };
    const payload = await encode(changed, old.session_id, old.schedule_id);
    db.transaction(() => {
      target({ schedule_id: old.schedule_id, expected_revision: before.revision });
      cancelQueued(old.schedule_id);
      db.prepare('UPDATE chat_prompt_schedules SET revision=?, next_run_at=CASE WHEN enabled=1 THEN ? ELSE NULL END, payload=? WHERE schedule_id=?')
        .run(changed.revision, changed.next_run_at, payload, old.schedule_id);
    }).immediate();
    recordChange('updated', old.schedule_id, changed.revision);
    announce(old.session_id); return get(old.schedule_id);
  };
  const control = async (action: 'pause' | 'resume' | 'remove', raw: PromptScheduleTarget | unknown, check = false): Promise<PromptSchedule | null> => {
    const before = target(raw), saved = await get(before.schedule_id);
    if (action === 'resume' && before.enabled === 1) return check ? null : saved;
    let nextAt = before.next_run_at;
    if (action === 'resume') {
      if (saved.mode === 'one_shot' && (saved.run_at ?? 0) <= now()) return bad('Choose a new future time before resuming this one-off request.');
      nextAt = saved.mode === 'one_shot' ? saved.run_at! : nextCronMatch(saved.cron_expression!.split(' '), now() + 60000, undefined, saved.time_zone);
    }
    if (check) return null;
    db.transaction(() => {
      target({ schedule_id: before.schedule_id, expected_revision: before.revision });
      if (action === 'remove') db.prepare('DELETE FROM chat_prompt_schedules WHERE schedule_id=?').run(before.schedule_id);
      else if (action === 'pause' || before.enabled !== 1) {
        cancelQueued(before.schedule_id);
        db.prepare('UPDATE chat_prompt_schedules SET enabled=?, revision=revision+1, next_run_at=? WHERE schedule_id=?')
          .run(action === 'resume' ? 1 : 0, action === 'resume' ? nextAt : null, before.schedule_id);
      }
    }).immediate();
    recordChange(action, before.schedule_id, before.revision + 1);
    announce(before.session_id); return action === 'remove' ? null : get(before.schedule_id);
  };

  const runNow = async (raw: unknown): Promise<ChatTurnAcceptance> => {
    const args = object(raw);
    if (Object.keys(args).some(key => !['schedule_id', 'expected_revision', 'submission_id'].includes(key))) return bad('Unknown Run now field.');
    const scheduleId = text(args.schedule_id, 'Schedule ID', 100), submission = text(args.submission_id, 'Submission ID', 128);
    if (!Number.isSafeInteger(args.expected_revision) || Number(args.expected_revision) < 1) return bad('An expected_revision is required to run a schedule.');
    const id = `${scheduleId}:manual:${hash(submission).slice(0, 32)}`;
    const replay = (): ChatTurnAcceptance | undefined => {
      const existing = db.prepare('SELECT * FROM chat_prompt_occurrences WHERE occurrence_id=?').get(id) as Occurrence | undefined;
      if (!existing) return undefined;
      if (existing.revision !== args.expected_revision) throw new RpcError('conflict', 'This run request already names another schedule revision.', 409);
      const receipt = db.prepare('SELECT turn_id, status FROM chat_turn_queue WHERE turn_id=? AND session_id=?')
        .get(existing.turn_id, existing.session_id) as { turn_id: string; status: ChatQueuedTurnStatus } | undefined;
      if (!receipt) throw new RpcError('conflict', 'This run is no longer available. It will not be repeated.', 409);
      return { ...receipt, disposition: 'replayed' };
    };
    const previous = replay(); if (previous) return previous;
    const before = target(args), workStamp = promptScheduleWorkStamp(db, before);
    const saved = await get(before.schedule_id);
    const admittedDuringRead = replay(); if (admittedDuringRead) return admittedDuringRead;
    if (!saved.run_now_available) throw new RpcError('conflict', 'This schedule has a run or action waiting. Review it before starting another run.', 409);
    const at = now(), payload = await encode(saved, saved.session_id, `occurrence:${id}`);
    const receipt = await queue.submit({ family: 'scheduled_prompt', session_id: saved.session_id,
      message: saved.prompt, input: { occurrence_id: id } }, id, true, turn => {
      target({ schedule_id: scheduleId, expected_revision: before.revision });
      if (promptScheduleWorkStamp(db, before) !== workStamp) {
        throw new RpcError('conflict', 'This schedule changed while the run was being queued. Review it and try again.', 409);
      }
      if (hasPending(scheduleId, before.revision) || hasApprovals(scheduleId)) {
        throw new RpcError('conflict', 'This schedule already has a run or approval waiting.', 409);
      }
      // Admission rolls this insert back if the queue cannot accept the turn.
      db.prepare('INSERT INTO chat_prompt_occurrences VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, scheduleId, saved.session_id, before.revision, at, turn, payload);
    });
    announce(saved.session_id); return receipt;
  };

  queue.register('scheduled_prompt', async (command, turn, assertActive, complete) => {
    const key = text(command.input.occurrence_id, 'Occurrence ID', 180);
    const occurrence = db.prepare('SELECT * FROM chat_prompt_occurrences WHERE occurrence_id=?').get(key) as Occurrence | undefined;
    if (!occurrence || occurrence.session_id !== command.session_id) throw new Error('Scheduled occurrence no longer exists.');
    const manual = key.startsWith(`${occurrence.schedule_id}:manual:`);
    // A generic Chat retry must not reuse a manual occurrence as a new execution.
    if (manual && occurrence.turn_id !== turn) { await queue.cancel(command.session_id, turn); return { turn_id: turn }; }
    const current = row(occurrence.schedule_id);
    // A pause, edit, remove, or deleted conversation wins before execution starts.
    if (!current || current.revision !== occurrence.revision) {
      await queue.cancel(command.session_id, turn); return { turn_id: turn };
    }
    db.prepare('UPDATE chat_prompt_occurrences SET turn_id=? WHERE occurrence_id=?').run(turn, key);
    const saved = await decode<PromptSchedule>(occurrence.payload, occurrence.session_id, `occurrence:${key}`);
    assertActive();
    const origin: ScheduledPromptOrigin = { schedule_id: saved.schedule_id, occurrence_id: key,
      revision: occurrence.revision, due_at: occurrence.due_at, cron: saved.cron_expression ?? 'one_shot',
      ...(manual ? { trigger: 'manual' as const } : {}) };
    return deps.runTurn({ session_id: saved.session_id, message: saved.prompt, picker_state: { current: 'self' },
      model_routing_snapshot: queue.routing(saved.session_id), time_zone: saved.time_zone,
      scheduled_prompt: origin, queue_turn_id: turn, assert_active: assertActive, complete_turn: complete });
  });
  type DueRow = Row & { scan_rowid: number };
  let dueCursor: { through: number; at: number; rowid: number } | undefined;
  const dueFromStart = db.prepare(`SELECT rowid AS scan_rowid, * FROM chat_prompt_schedules
    WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at, rowid LIMIT 100`);
  const dueAfterCursor = db.prepare(`SELECT rowid AS scan_rowid, * FROM chat_prompt_schedules
    WHERE enabled=1 AND next_run_at<=? AND (next_run_at, rowid)>(?, ?)
    ORDER BY next_run_at, rowid LIMIT 100`);
  const readDue = (through: number): DueRow[] => (dueCursor === undefined
    ? dueFromStart.all(through)
    : dueAfterCursor.all(through, dueCursor.at, dueCursor.rowid)) as DueRow[];
  let ticking: Promise<void> | undefined;
  const tick = (closed: () => boolean = () => false): Promise<void> => {
    if (ticking) return ticking;
    ticking = (async () => {
      const tickAt = now();
      // Finish the current pass before following newer recurrences. A moving
      // cutoff could otherwise keep earlier schedules behind the cursor forever.
      let through = dueCursor === undefined ? tickAt : Math.min(tickAt, dueCursor.through);
      let due = readDue(through);
      if (due.length === 0 && dueCursor !== undefined) {
        dueCursor = undefined;
        through = tickAt;
        due = readDue(through);
      }
      for (const before of due) {
        if (closed()) break;
        // Advance even past busy or unavailable rows. Rowid breaks equal-time
        // ties in the existing due index; each tick still checks at most 100.
        dueCursor = { through, at: before.next_run_at!, rowid: before.scan_rowid };
        // Coalesce overdue recurring ticks while the previous occurrence is pending.
        // The clock stays due, so it runs once after that occurrence settles.
        // A retry of the SAME admission must still advance the clock after a crash.
        const currentId = `${before.schedule_id}:${before.revision}:${before.next_run_at}`;
        const pending = hasPending(before.schedule_id, before.revision, currentId);
        const admitted = db.prepare('SELECT 1 FROM chat_prompt_occurrences WHERE occurrence_id=?').get(currentId);
        if (pending && !admitted) continue;
        try {
        const saved = await get(before.schedule_id);
        const at = before.next_run_at!;
        const id = `${before.schedule_id}:${before.revision}:${at}`;
        const payload = await encode(saved, saved.session_id, `occurrence:${id}`);
        const claimed = db.transaction(() => {
          const current = row(before.schedule_id);
          if (closed() || !current || current.revision !== before.revision || current.enabled !== 1 || current.next_run_at !== at) return false;
          if (hasPending(before.schedule_id, before.revision, id)
            && !db.prepare('SELECT 1 FROM chat_prompt_occurrences WHERE occurrence_id=?').get(id)) return false;
          db.prepare('INSERT OR IGNORE INTO chat_prompt_occurrences VALUES (?, ?, ?, ?, ?, NULL, ?)')
            .run(id, before.schedule_id, before.session_id, before.revision, at, payload);
          return true;
        }).immediate();
        if (!claimed) continue;
        // Stable submission identity closes a crash between admission and clock advance.
        const receipt = await queue.submit({ family: 'scheduled_prompt', session_id: saved.session_id,
          message: saved.prompt, input: { occurrence_id: id } }, id, true);
        db.transaction(() => {
          db.prepare('UPDATE chat_prompt_occurrences SET turn_id=? WHERE occurrence_id=?').run(receipt.turn_id, id);
          const current = row(before.schedule_id);
          if (!current || current.revision !== before.revision || current.enabled !== 1) {
            cancelQueued(before.schedule_id); return;
          }
          const nextAt = saved.mode === 'one_shot' ? null : nextCronMatch(saved.cron_expression!.split(' '), now() + 60000, undefined, saved.time_zone);
          db.prepare('UPDATE chat_prompt_schedules SET enabled=?, next_run_at=? WHERE schedule_id=?')
            .run(saved.mode === 'one_shot' ? 0 : 1, nextAt, before.schedule_id);
        }).immediate();
        announce(saved.session_id);
        } catch {
          // Persist only the current revision/due point, never provider errors or the request.
          try { if (health.recordQueueFailure(before.schedule_id, before.revision, before.next_run_at!, now())) announce(before.session_id); }
          catch { /* A full/busy database must not stop the rest of the clock. */ }
          // One unavailable/corrupt request must not starve other schedules or recipe ticks.
          console.warn('[scheduled prompts] occurrence could not be queued', before.schedule_id);
        }
      }
    })().finally(() => { ticking = undefined; });
    return ticking;
  };
  const beforeDeleteSession = async (session: string): Promise<void> => {
    for (const schedule of await list(session)) await control('remove', { schedule_id: schedule.schedule_id });
    for (const turn of (await queue.snapshot(session)).turns) {
      if (['queued', 'running', 'cancelling'].includes(turn.status)) await queue.cancel(session, turn.turn_id);
    }
  };
  // Raw recovery metadata is only a hint: a verified local receipt can prove
  // that an action completed even while its stored execution status is unknown.
  const isFailureCurrent = async (signal: PromptScheduleFailureSignal): Promise<boolean> => {
    if (signal.source_kind !== 'plan') return true;
    const record = (await deps.readPlans(signal.session_id, signal.turn_id)).find(value => value.plan.plan_id === signal.source_id);
    return record?.execution?.status === 'failed' || record?.execution?.status === 'unknown';
  };
  const recordFailure = (event: BroadcastChatEvent): void => {
    if (event.kind === 'chat.transparency' && event.event && typeof event.event === 'object'
      && 'kind' in event.event && event.event.kind === 'engine.decoder_unavailable'
      && health.recordTurnFailure(event.session_id, event.turn_id)) announce(event.session_id);
  };
  return { list, get, create, update, control, runNow, tick, beforeDeleteSession, isFailureCurrent, recordFailure,
    heldNoticeIds: health.heldNoticeIds,
    preview: (raw: unknown) => previewPromptScheduleTiming(raw, now()) };
};
export type PromptSchedules = ReturnType<typeof createPromptSchedules>;
