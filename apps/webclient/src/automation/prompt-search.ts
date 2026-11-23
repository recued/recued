import { isChatModelSourceId, type PromptSchedule, type PromptScheduleRunOutcome } from '@recued/contracts';
import type { AutomationChip } from './by-recipe.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { serializeShellRoute } from '../shell/route.js';
import { promptSearchTimingFields } from './prompt-search-timing.js';

export const promptScheduleHref = (id: string) => serializeShellRoute('automation', 'schedules', 'prompt', id);
const fold = (text: string) => text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
export const promptMatchesQuery = (row: Pick<PromptSchedule, 'title' | 'prompt' | 'mode' | 'time_zone' | 'run_at' | 'cron_expression'>, query: string): boolean => {
  const words = fold(query).split(' ').filter(Boolean), body = fold(row.title + ' ' + row.prompt);
  if (words.every(word => body.includes(word))) return true;
  const text = body + ' ' + fold(Object.values(promptSearchTimingFields(row)).join(' '));
  return words.every(word => text.includes(word));
};
/** A paused prompt can still have an older action waiting for its owner. */
export const promptScheduleChip = (row: PromptSchedule): AutomationChip => {
  if (row.pending_approvals?.count || row.pending_work?.status === 'needs_attention'
    || row.last_outcome?.status === 'needs_approval' || row.last_outcome?.status === 'needs_attention') return 'needs-you';
  if (row.scheduling_issue || ['failed', 'interrupted'].includes(row.last_outcome?.status ?? row.last_status ?? '')) return 'failing';
  return row.enabled ? 'on' : 'off';
};
/** Activity may advance without changing the saved request. Configuration and
 * creation lifetime must still match the result the owner selected. Only the
 * active timing mode counts; older rows can retain unused timing fields. */
export const promptScheduleIdentity = (row: Pick<PromptSchedule, 'schedule_id' | 'session_id' | 'created_at' | 'revision' | 'title' | 'prompt' | 'mode' | 'time_zone' | 'run_at' | 'cron_expression' | 'enabled' | 'model_source_id' | 'notify_on_done'>): string => JSON.stringify([
  row.schedule_id, row.session_id, row.created_at, row.revision, row.title, row.prompt, row.mode, row.time_zone,
  row.mode === 'one_shot' ? row.run_at ?? null : null, row.mode === 'recurring' ? row.cron_expression ?? null : null,
  row.enabled, row.model_source_id ?? null, row.notify_on_done === true,
]);
export interface PromptSelection { id: string; identity?: string }
export type PromptScheduleListCaller = () => Promise<readonly PromptSchedule[]>;
export interface PromptSearchState {
  query: string; rows: readonly PromptSchedule[]; matches: readonly PromptSchedule[]; loaded: boolean; loading: boolean;
  error?: string; unsupported?: boolean;
}
const statuses = new Set(['queued', 'running', 'cancelling', 'finished', 'needs_approval', 'failed', 'interrupted', 'cancelled', 'withdrawn', 'needs_attention']);
const queueStatuses = new Set(['queued', 'running', 'cancelling', 'completed', 'failed', 'interrupted', 'cancelled', 'withdrawn']);
const reasons = new Set(['turn_failed', 'tool_failed', 'outcome_unknown', 'action_held', 'awaiting_execution', 'approval_expired', 'approval_declined']);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300;
const at = (value: unknown) => Number.isSafeInteger(value) && Math.abs(Number(value)) <= 8.64e15;
const outcome = (value: PromptScheduleRunOutcome | null | undefined): boolean => value == null
  || typeof value === 'object' && statuses.has(value.status) && (value.reason === undefined || reasons.has(value.reason))
    && (value.message_id === undefined || id(value.message_id)) && (value.plan_id === undefined || id(value.plan_id));
const validSkipState = (row: PromptSchedule): boolean => {
  const state = row.skip_state; if (state === undefined) return true;
  if (!state || typeof state !== 'object' || Array.isArray(state) || row.mode !== 'recurring'
    || !Number.isSafeInteger(state.revision) || state.revision < 0) return false;
  const next = state.next, skipped = state.skipped;
  if (next !== undefined && (!next || !at(next.run_at) || !row.enabled || next.run_at !== row.next_run_at)) return false;
  return skipped === undefined || !!skipped && id(skipped.skip_id) && at(skipped.run_at) && at(skipped.following_run_at)
    && skipped.following_run_at > skipped.run_at && skipped.following_run_at === row.next_run_at && row.enabled && typeof skipped.undo_available === 'boolean';
};
/** The owner list is complete and bounded by the server's 200-schedule limit.
 * Do not turn malformed or partial replies into a successful empty search. */
export const readPromptSchedules = (input: unknown): PromptSchedule[] => {
  const invalid = (): never => { throw Error('The saved scheduled prompts could not be confirmed. Refresh and try again.'); };
  if (!Array.isArray(input) || input.length > 200) return invalid();
  const seen = new Set<string>();
  for (const row of input as PromptSchedule[]) {
    if (!row || !id(row.schedule_id) || seen.has(row.schedule_id) || !id(row.session_id) || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 160
      || typeof row.prompt !== 'string' || !row.prompt.trim() || row.prompt.length > 32000 || !['one_shot', 'recurring'].includes(row.mode)
      || typeof row.time_zone !== 'string' || row.time_zone.length > 100 || typeof row.enabled !== 'boolean' || !Number.isSafeInteger(row.revision) || row.revision < 1
      || !at(row.created_at) || row.next_run_at !== null && !at(row.next_run_at) || row.last_run_at !== null && !at(row.last_run_at)
      || row.last_turn_id !== null && !id(row.last_turn_id) || row.last_status !== null && !queueStatuses.has(row.last_status)
      || row.mode === 'one_shot' && !at(row.run_at) || row.mode === 'recurring' && (typeof row.cron_expression !== 'string' || !row.cron_expression.trim() || row.cron_expression.length > 120)
      || row.model_source_id !== undefined && row.model_source_id !== null && !isChatModelSourceId(row.model_source_id)
      || row.notify_on_done !== undefined && typeof row.notify_on_done !== 'boolean' || !outcome(row.last_outcome) || !outcome(row.pending_work)
      || row.run_now_available !== undefined && typeof row.run_now_available !== 'boolean'
      || row.bulk_control_available !== undefined && row.bulk_control_available !== true
      || row.bulk_control_available === true && !id(row.run_request_scope)
      || row.run_history_available !== undefined && row.run_history_available !== true
      || row.timed_pause !== undefined && (row.mode !== 'recurring' || row.timed_pause !== null && (row.enabled || !at(row.timed_pause.until_at) || !at(row.timed_pause.first_run_at) || row.timed_pause.first_run_at < row.timed_pause.until_at))
      || !validSkipState(row)
      || row.run_request_scope !== undefined && !id(row.run_request_scope)
      || row.managed_by !== undefined && row.managed_by !== 'agenda'
      || row.pending_approvals != null && (!Number.isSafeInteger(row.pending_approvals.count) || row.pending_approvals.count < 1 || !id(row.pending_approvals.plan_id)
        || row.pending_approvals.message_id !== undefined && !id(row.pending_approvals.message_id))
      || row.scheduling_issue != null && (row.scheduling_issue.code !== 'queue_unconfirmed' || !at(row.scheduling_issue.since_at))) return invalid();
    try { new Intl.DateTimeFormat('en', { timeZone: row.time_zone }).format(0); } catch { return invalid(); }
    seen.add(row.schedule_id);
  }
  return structuredClone((input as PromptSchedule[]).filter(row => row.managed_by === undefined));
};
const empty = (): PromptSearchState => ({ query: '', rows: [], matches: [], loaded: false, loading: false });
/** Fetch once per search visit, filter subsequent queries locally, and read
 * again before navigation. No second persistent index or provider search. */
export const createPromptSearch = (caller: PromptScheduleListCaller | undefined, changed: () => void) => {
  let state = empty(), epoch = 0, selectionEpoch = 0, disposed = false, pending = Promise.resolve();
  const search = (query: string) => {
    selectionEpoch++; state = { ...state, query, matches: state.rows.filter(row => promptMatchesQuery(row, query)) };
  };
  const read = async (query: string) => {
    const mine = ++epoch; search(query); state = { ...state, loading: true, error: undefined, unsupported: false }; changed();
    try {
      const rows = readPromptSchedules(await caller!());
      if (disposed || mine !== epoch) return;
      state = { ...state, rows, matches: rows.filter(row => promptMatchesQuery(row, state.query)), loaded: true, loading: false };
    } catch (failure) {
      if (disposed || mine !== epoch) return;
      const code = classifyRpcError(failure).code;
      state = { ...state, loading: false, error: humanizeRpcError(failure), unsupported: code === 'unknown_method' || code === 'not_configured' };
    }
    changed();
  };
  return {
    state: () => state,
    setQuery: search,
    load(query: string, refresh = false): Promise<void> {
      if (!caller || disposed) return Promise.resolve();
      search(query);
      if (refresh || !state.loaded && !state.loading) pending = read(query);
      else changed();
      return pending;
    },
    async resolve(selected: PromptSchedule): Promise<PromptSchedule | null> {
      if (!caller || disposed) return null;
      const mine = ++selectionEpoch, generation = epoch;
      const rows = readPromptSchedules(await caller());
      if (disposed || mine !== selectionEpoch || generation !== epoch) return null;
      state = { ...state, rows, matches: rows.filter(row => promptMatchesQuery(row, state.query)), loaded: true, loading: false, error: undefined, unsupported: false }; changed();
      const fresh = rows.find(row => row.schedule_id === selected.schedule_id);
      if (!fresh) throw Error('This scheduled prompt was removed. The search results have been refreshed.');
      if (promptScheduleIdentity(fresh) !== promptScheduleIdentity(selected)) throw Error('This scheduled prompt changed. Review its refreshed result before opening it.');
      return fresh;
    },
    snapshot: (): PromptSearchState => structuredClone({ ...state, loading: false }),
    restore(snapshot: PromptSearchState) { epoch++; selectionEpoch++; state = structuredClone({ ...snapshot, loading: false }); },
    reset() { epoch++; selectionEpoch++; state = empty(); },
    whenLoaded: () => pending,
    dispose() { disposed = true; epoch++; selectionEpoch++; },
  };
};
