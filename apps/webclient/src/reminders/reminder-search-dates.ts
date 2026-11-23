import { parseReminderSearchDates, resolveReminderSearchDates, type ReminderSearchDates, type ReminderSearchDateWindow } from '@recued/contracts';
import { e, stampZone } from '@recued/ui-shared';
import { reminderWallClockValue } from './reminder-time.js';

export const REMINDER_DATE_FIELD = 'data-search-reminder-date-field';
export const REMINDER_DATE_FOCUS = 'data-search-reminder-date-focus';
export const REMINDER_DATE_FORM = 'data-search-reminder-dates';
export const CLEAR_REMINDER_DATES = 'universal-search-clear-reminder-dates';
export interface ReminderDateSearchState {
  applied?: ReminderSearchDates;
  window?: ReminderSearchDateWindow;
  draft: { range: 'all' | ReminderSearchDates['range']; from: string; through: string };
  error?: string; readError?: string;
}
/** Keep one resolved window while paging or visiting a result. Only saved
 * settings are durable; a new mount resolves relative settings again. */
export const createReminderDateSearch = (options: { initial?: ReminderSearchDates; zone?: () => string | undefined; now?: () => number }) => {
  const now = options.now ?? Date.now, zone = () => state.applied?.time_zone ?? stampZone(options.zone?.());
  const today = reminderWallClockValue(now(), options.initial?.time_zone ?? stampZone(options.zone?.())).slice(0, 10);
  let state: ReminderDateSearchState = { applied: options.initial,
    draft: { range: options.initial?.range ?? 'all', from: options.initial?.range === 'custom' ? options.initial.from : today,
      through: options.initial?.range === 'custom' ? options.initial.through : today } };
  if (state.applied) try { state.window = resolveReminderSearchDates(state.applied, now()); }
  catch (error) { state.readError = error instanceof Error ? error.message : 'The reminder dates could not be confirmed.'; }
  return {
    view: () => ({ ...structuredClone(state), zone: zone() }),
    definition: () => state.applied ? { ...state.applied } : undefined,
    bounds: () => state.readError ? null : state.window ? { from: state.window.from, before: state.window.before } : {},
    setField(field: string, value: string): boolean {
      if (field === 'range' && ['all', 'today', 'week', 'custom'].includes(value)) state.draft.range = value as typeof state.draft.range;
      else if (field === 'from' || field === 'through') state.draft[field] = value;
      else return false;
      return true;
    },
    apply(): boolean {
      if (state.draft.range === 'all') { state = { draft: { ...state.draft }, applied: undefined }; return true; }
      const filter = parseReminderSearchDates({ range: state.draft.range, time_zone: zone(),
        ...(state.draft.range === 'custom' ? { from: state.draft.from, through: state.draft.through } : {}) });
      try {
        if (!filter) throw Error('Choose valid dates with the last day on or after the first.');
        const window = resolveReminderSearchDates(filter, now());
        state = { draft: { ...state.draft }, applied: filter, window }; return true;
      } catch (error) { state.error = error instanceof Error ? error.message : 'The reminder dates could not be applied.'; return false; }
    },
    snapshot: () => structuredClone(state),
    restore(snapshot: ReminderDateSearchState) { state = structuredClone(snapshot); },
  };
};
export const renderReminderDateSearch = (state: ReminderDateSearchState & { zone: string }, actionAttr: string, disabled = false): string => {
  const focus = (key: string) => `${REMINDER_DATE_FOCUS}="${key}"`;
  return `<form class="rq-reminder-dates" ${REMINDER_DATE_FORM} aria-label="Filter reminder dates">
    <fieldset class="rq-reminder-date-controls"${disabled ? ' disabled' : ''}>
    <div class="rq-type-controls"><label for="rq-reminder-dates">Reminder dates</label><select id="rq-reminder-dates" ${REMINDER_DATE_FIELD}="range" ${focus('range')}>
    ${([['all', 'All dates'], ['today', 'Today'], ['week', 'Next 7 days'], ['custom', 'Choose dates']] as const).map(([key, label]) => `<option value="${key}"${state.draft.range === key ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
    ${state.draft.range === 'custom' ? `<div class="rq-reminder-date-fields"><label>From <input type="date" ${REMINDER_DATE_FIELD}="from" ${focus('from')} value="${e(state.draft.from)}"></label>
      <label>Through <input type="date" ${REMINDER_DATE_FIELD}="through" ${focus('through')} value="${e(state.draft.through)}"></label></div>` : ''}
    <div class="rq-reminder-date-actions"><button type="submit" class="rq-retry" ${focus('apply')}>Apply reminder dates</button>
    ${state.applied ? `<button type="button" class="rq-retry" ${e(actionAttr)}="${CLEAR_REMINDER_DATES}" ${focus('clear')}>Clear reminder dates</button>` : ''}</div></fieldset>
    <p class="rq-subtle">Applied dates: ${state.window ? `${e(state.window.first)} through ${e(state.window.through)}` : state.applied ? 'Unavailable' : 'All dates'}. Dates use ${e(state.zone)} and match the scheduled time.</p>
    ${state.error ? `<p class="rq-error" role="alert" tabindex="-1" ${focus('error')}>${e(state.error)}</p>` : ''}
  </form>`;
};
