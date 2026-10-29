import type Database from 'better-sqlite3';
import type { ChatPlanRecord, ChatToolCallRecord, PromptSchedule, PromptScheduleRunOutcome } from '@recued/contracts';
import { chatToolCallFromMetadata } from './storage/chat-tool-call-store.js';

type ScheduleRef = Pick<PromptSchedule, 'schedule_id' | 'session_id'>;
const workRows = (db: Database.Database, schedule: ScheduleRef) => ({
  plans: db.prepare(`SELECT p.plan_id, p.turn_id, p.consumed_at, p.execution_status, p.execution_turn_id, p.execution_updated_at
    FROM chat_plans p WHERE p.session_id=? AND p.status='approved'
      AND (p.consumed_at IS NULL OR p.execution_status IN ('running','held'))
      AND EXISTS (SELECT 1 FROM chat_prompt_occurrences o WHERE o.schedule_id=? AND o.turn_id=p.turn_id)
    ORDER BY p.created_at, p.plan_id`).all(schedule.session_id, schedule.schedule_id) as Array<{ plan_id: string; turn_id: string;
      consumed_at: number | null; execution_status: string | null; execution_turn_id: string | null; execution_updated_at: number | null }>,
  calls: db.prepare(`SELECT m.message_id, m.turn_id, m.metadata_blob FROM chat_messages m
    WHERE m.session_id=? AND m.role='tool' AND json_valid(m.metadata_blob)
      AND json_extract(m.metadata_blob,'$.tool_call.state') IN ('running','held')
      AND EXISTS (SELECT 1 FROM chat_prompt_occurrences o WHERE o.schedule_id=? AND o.turn_id=m.turn_id)
    ORDER BY m.message_id`).all(schedule.session_id, schedule.schedule_id) as Array<{ message_id: string; turn_id: string; metadata_blob: string | null }>,
});

/** Compared inside queue admission after asynchronous decryption/encryption. Never persisted or sent to clients. */
export const promptScheduleWorkStamp = (db: Database.Database, schedule: ScheduleRef): string => JSON.stringify(workRows(db, schedule));

/** Returns status and retained links only; approval and execution remain in Chat. */
export const readPromptScheduleOutcome = async (
  db: Database.Database,
  schedule: ScheduleRef & Pick<PromptSchedule, 'last_turn_id' | 'last_status'>,
  readPlans: (session: string, turn: string) => Promise<ReadonlyArray<ChatPlanRecord>>,
): Promise<Pick<PromptSchedule, 'last_outcome' | 'pending_approvals' | 'pending_work'>> => {
  const pending = db.prepare(`SELECT p.plan_id, p.message_id, COUNT(*) OVER () AS count
    FROM chat_plans p JOIN chat_prompt_occurrences o ON o.session_id=p.session_id AND o.turn_id=p.turn_id
    WHERE o.schedule_id=? AND p.status='proposed' ORDER BY p.created_at, p.plan_id LIMIT 1`)
    .get(schedule.schedule_id) as { plan_id: string; message_id: string | null; count: number } | undefined;
  const pending_approvals = pending ? { count: pending.count, plan_id: pending.plan_id,
    ...(pending.message_id ? { message_id: pending.message_id } : {}) } : null;
  const active = workRows(db, schedule);
  const recordCache = new Map<string, Promise<ReadonlyArray<ChatPlanRecord>>>();
  const recordsFor = (turn: string) => {
    let records = recordCache.get(turn);
    if (!records) { records = readPlans(schedule.session_id, turn); recordCache.set(turn, records); }
    return records;
  };
  const messageRows = (turn: string) => db.prepare(`SELECT message_id, role, metadata_blob FROM chat_messages
    WHERE session_id=? AND turn_id=? ORDER BY ts DESC, message_id DESC`).all(schedule.session_id, turn) as
    Array<{ message_id: string; role: string; metadata_blob: string | null }>;
  const reference = (record: ChatPlanRecord) => ({ plan_id: record.plan.plan_id,
    ...(record.message_id ? { message_id: record.message_id } : {}) });
  const unfinished = (record: ChatPlanRecord): PromptScheduleRunOutcome | null => {
    if (record.execution?.status === 'running') return { status: 'running', ...reference(record) };
    if (record.execution?.status === 'held') return { status: 'needs_attention', reason: 'action_held', ...reference(record) };
    if (!record.execution && record.plan.status === 'approved' && record.plan.consumed_at === undefined) {
      return { status: 'needs_attention', reason: 'awaiting_execution', ...reference(record) };
    }
    return null;
  };
  const callCompleted = (call: ChatToolCallRecord, records: ReadonlyArray<ChatPlanRecord>) => records.some(record =>
    record.execution?.status === 'completed' && (record.execution.result_ref === `${call.message_id}:result`
      || call.run_id !== undefined && record.execution.run_id === call.run_id));
  let pending_work: PromptScheduleRunOutcome | null = null;
  for (const candidate of active.plans) {
    const record = (await recordsFor(candidate.turn_id)).find(record => record.plan.plan_id === candidate.plan_id);
    if (record && (pending_work = unfinished(record))) break;
  }
  if (!pending_work) for (const candidate of active.calls) {
    const call = chatToolCallFromMetadata(candidate.metadata_blob);
    if (!call || !['running', 'held'].includes(call.state) || callCompleted(call, await recordsFor(candidate.turn_id))) continue;
    const messages = messageRows(candidate.turn_id);
    const answer = messages.find(message => message.role === 'assistant') ?? messages.find(message => message.role === 'user');
    pending_work = { status: call.state === 'running' ? 'running' : 'needs_attention',
      ...(call.state === 'held' ? { reason: 'action_held' as const } : {}), ...(answer ? { message_id: answer.message_id } : {}) };
    break;
  }
  const turn = schedule.last_turn_id;
  if (!turn) return { last_outcome: schedule.last_status
    ? { status: schedule.last_status === 'completed' ? 'finished' : schedule.last_status } : null, pending_approvals, pending_work };
  const records = await recordsFor(turn), messages = messageRows(turn);
  const calls = messages.filter(message => message.role === 'tool')
    .flatMap(message => { const call = chatToolCallFromMetadata(message.metadata_blob); return call ? [call] : []; });
  const answer = messages.find(message => message.role === 'assistant') ?? messages.find(message => message.role === 'user');
  const outcome = (status: PromptScheduleRunOutcome['status'], reason?: PromptScheduleRunOutcome['reason'], record?: ChatPlanRecord) => {
    const message_id = record?.message_id ?? answer?.message_id;
    return { last_outcome: { status, ...(reason ? { reason } : {}), ...(record ? reference(record) : {}),
      ...(message_id ? { message_id } : {}) }, pending_approvals, pending_work };
  };
  const approval = records.find(record => record.plan.status === 'proposed');
  if (approval) return outcome('needs_approval', undefined, approval);
  if (schedule.last_status === 'failed') return outcome('failed', 'turn_failed');
  if (schedule.last_status === 'interrupted') return outcome('interrupted', 'outcome_unknown');
  if (schedule.last_status && schedule.last_status !== 'completed') return outcome(schedule.last_status);
  const waiting = records.find(record => unfinished(record));
  if (waiting) { const work = unfinished(waiting)!; return outcome(work.status, work.reason, waiting); }
  const activeCall = calls.find(call => ['running', 'held'].includes(call.state) && !callCompleted(call, records));
  if (activeCall) return outcome(activeCall.state === 'running' ? 'running' : 'needs_attention', activeCall.state === 'held' ? 'action_held' : undefined);
  const failed = records.find(record => record.execution?.status === 'failed');
  if (failed) return outcome('failed', 'tool_failed', failed);
  if (calls.some(call => call.state === 'failed' && !call.denied)) return outcome('needs_attention', 'tool_failed');
  const unknown = records.find(record => record.execution?.status === 'unknown');
  if (unknown || calls.some(call => call.state === 'interrupted')) return outcome('interrupted', 'outcome_unknown', unknown);
  const expired = records.find(record => record.plan.hold?.lapsed_at !== undefined);
  if (expired) return outcome('needs_attention', 'approval_expired', expired);
  if (db.prepare(`SELECT 1 FROM chat_prompt_failure_signals
    WHERE failure_key=? AND schedule_id=? AND session_id=? AND source_kind='turn'`)
    .get(`turn:${turn}`, schedule.schedule_id, schedule.session_id)) return outcome('failed', 'turn_failed');
  return outcome('finished', calls.some(call => call.denied) ? 'approval_declined' : undefined);
};
