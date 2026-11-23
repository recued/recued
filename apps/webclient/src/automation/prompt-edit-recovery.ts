import type { PromptSchedule, PromptScheduleUpdate } from '@recued/contracts';
import { reminderWallClockValue } from '../reminders/reminder-time.js';
import { promptDraftTiming, type PromptDraftValues, type PromptEditOriginal } from './prompt-draft-recovery.js';
import { promptScheduleIdentity } from './prompt-search.js';
import { PROMPT_WEEKDAY_NAMES, readPromptRepeat } from './prompt-repeat.js';

export type PromptEditField = 'title' | 'prompt' | 'timing' | 'model' | 'notify';
export const PROMPT_EDIT_FIELDS: Record<PromptEditField, string> = { title: 'Title', prompt: 'Request', timing: 'Timing and timezone', model: 'Model', notify: 'Notifications' };
export interface PromptEditComparison {
  original: PromptEditOriginal; current: PromptSchedule; values: PromptDraftValues;
  rows: Array<{ key: PromptEditField; label: string; saved: string; mine: string; mineChanged: boolean; savedChanged: boolean; conflict: boolean }>;
  choices: Partial<Record<PromptEditField, 'saved' | 'mine'>>;
}
export const samePromptLifetime = (a: PromptEditOriginal, b: PromptEditOriginal) => a.schedule_id === b.schedule_id
  && a.session_id === b.session_id && a.created_at === b.created_at && a.mode === b.mode;
/** A confirmed state is evidence about the saved settings, not who wrote them.
 * Only the next revision with the same lifetime and activation state can
 * confirm an interrupted update. Retry always keeps the original CAS target. */
export const checkPromptEdit = (original: PromptEditOriginal, current: PromptSchedule | undefined, request?: PromptScheduleUpdate): 'missing' | 'replaced' | 'unchanged' | 'matches' | 'changed' => {
  if (!current) return 'missing';
  if (current.managed_by !== undefined || !samePromptLifetime(original, current)) return 'replaced';
  if (request && current.revision === original.revision + 1) {
    const expected: PromptEditOriginal = { ...original, revision: current.revision,
      ...(request.title !== undefined ? { title: request.title } : {}), ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      ...(request.time_zone !== undefined ? { time_zone: request.time_zone } : {}),
      ...(request.run_at !== undefined ? { run_at: Date.parse(request.run_at) } : {}),
      ...(request.cron_expression !== undefined ? { cron_expression: request.cron_expression } : {}),
      ...(request.model_source_id !== undefined ? { model_source_id: request.model_source_id } : {}),
      ...(request.notify_on_done !== undefined ? { notify_on_done: request.notify_on_done } : {}) };
    if (promptScheduleIdentity(expected) === promptScheduleIdentity(current)) return 'matches';
  }
  return promptScheduleIdentity(original) === promptScheduleIdentity(current) ? 'unchanged' : 'changed';
};
const timing = (row: PromptEditOriginal): string => (row.mode === 'one_shot' ? new Date(row.run_at!).toISOString() : row.cron_expression!) + ' · ' + row.time_zone;
const savedFields = (row: PromptEditOriginal): Record<PromptEditField, string> => ({ title: row.title, prompt: row.prompt, timing: timing(row),
  model: row.model_source_id || 'Chat default', notify: row.notify_on_done ? 'Notify when done' : 'No completion notification' });
const mineFields = (values: PromptDraftValues): Record<PromptEditField, string> => {
  let when: string;
  try { const value = promptDraftTiming(values); when = (value.mode === 'one_shot' ? value.run_at! : value.cron_expression!) + ' · ' + value.time_zone; }
  catch {
    const cadence = values.frequency === 'monthly' ? 'Monthly day ' + (values.monthDay || '?')
      : values.frequency === 'selected_days' ? (values.selectedWeekdays?.map(day => PROMPT_WEEKDAY_NAMES[Number(day)]).join(', ') || 'No weekdays selected')
      : values.frequency === 'custom' ? values.cron : values.frequency;
    when = 'Timing needs review: ' + (values.mode === 'one_shot' ? values.time + ' · ' + values.oneOffZone : cadence + ' · ' + values.clock + ' · ' + values.timezone);
  }
  return { title: values.title.trim(), prompt: values.prompt.trim(), timing: when, model: values.model || 'Chat default', notify: values.notify ? 'Notify when done' : 'No completion notification' };
};
export const comparePromptEdits = (original: PromptEditOriginal, values: PromptDraftValues, current: PromptSchedule): PromptEditComparison => {
  const before = savedFields(original), saved = savedFields(current), mine = mineFields(values);
  const rows = (Object.keys(PROMPT_EDIT_FIELDS) as PromptEditField[]).flatMap(key => {
    const unconfirmed = key === 'model' && current.model_source_id === undefined && !!values.model
      || key === 'notify' && current.notify_on_done === undefined && values.notify;
    const mineChanged = unconfirmed || mine[key] !== before[key], savedChanged = unconfirmed || saved[key] !== before[key];
    return mineChanged || savedChanged ? [{ key, label: PROMPT_EDIT_FIELDS[key], saved: unconfirmed ? 'Not confirmed by this server' : saved[key], mine: mine[key], mineChanged, savedChanged,
      conflict: unconfirmed || mineChanged && savedChanged && mine[key] !== saved[key] }] : [];
  });
  return { original: structuredClone(original), current: structuredClone(current), values: structuredClone(values), rows, choices: {} };
};
export const unresolvedPromptEdits = (comparison: PromptEditComparison) => comparison.rows.filter(row => row.conflict && !comparison.choices[row.key]).length;
/** Keep changes in different fields together. Timing and timezone are one
 * choice, so a repeated-hour instant is never silently reinterpreted. */
export const mergePromptEdits = (comparison: PromptEditComparison): PromptDraftValues | null => {
  if (unresolvedPromptEdits(comparison)) return null;
  const { current, values } = comparison, { updateRequest: _request, ...editable } = values;
  const result: PromptDraftValues = { ...editable, request: null, title: current.title, prompt: current.prompt,
    model: current.model_source_id ?? '', notify: current.notify_on_done === true };
  if (current.mode === 'one_shot') Object.assign(result, { oneOffZone: current.time_zone, time: reminderWallClockValue(current.run_at!, current.time_zone), chosenAt: current.run_at! });
  else {
    const repeat = readPromptRepeat(current.cron_expression!);
    Object.assign(result, { ...repeat, timezone: current.time_zone, cron: current.cron_expression!,
      ...(repeat.frequency === 'custom' ? { clock: values.clock, weekday: values.weekday, selectedWeekdays: values.selectedWeekdays, monthDay: values.monthDay } : {}) });
  }
  for (const row of comparison.rows) {
    const mine = row.mineChanged && (!row.savedChanged || row.conflict && comparison.choices[row.key] === 'mine');
    if (!mine) continue;
    if (row.key === 'title' || row.key === 'prompt' || row.key === 'model' || row.key === 'notify') { (result as unknown as Record<string, unknown>)[row.key] = values[row.key]; continue; }
    const when = promptDraftTiming(values);
    if (current.mode === 'one_shot') {
      const at = Date.parse(when.run_at!);
      Object.assign(result, { oneOffZone: current.time_zone, chosenAt: at, time: reminderWallClockValue(at, current.time_zone) });
    } else Object.assign(result, { frequency: values.frequency, clock: values.clock, weekday: values.weekday, cron: values.cron, timezone: values.timezone,
      selectedWeekdays: values.selectedWeekdays, monthDay: values.monthDay });
  }
  return result;
};
