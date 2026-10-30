import {
  CALENDAR_EVENT_EDIT_LIMITS, DAY_MS, calendarDayMs,
  type CalendarEventDestination, type CalendarEventDestinations,
  type CalendarEventCreateRequest, type CalendarEventCreateResult,
} from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { calendarWallClockCandidates, calendarWallClockValue } from './calendar-event-surface.js';

export const CALENDAR_CREATE_ACTION = 'calendar-create-';
export const CALENDAR_CREATE_FIELD = 'data-calendar-create-field';
const FOCUS = 'data-calendar-create-focus';
export interface CalendarCreateCallers {
  destinations?: () => Promise<CalendarEventDestinations>;
  create?: (input: CalendarEventCreateRequest) => Promise<CalendarEventCreateResult>;
}
export interface CalendarCreateDraft {
  destination: string; summary: string; description: string; location: string;
  start: string; end: string; allDay: boolean; startChoice: string; endChoice: string;
}
const destinationKey = (destination: CalendarEventDestination) => JSON.stringify([destination.slug, destination.calendar_id]);
export const calendarCreateTimes = (draft: CalendarCreateDraft, zone: string): { start_at: number; end_at: number } => {
  const read = (key: 'start' | 'end'): number => {
    if (draft.allDay) {
      const at = calendarDayMs(draft[key]);
      if (at === null) throw new Error('Choose valid start and end dates.');
      return at + (key === 'end' ? DAY_MS : 0);
    }
    const candidates = calendarWallClockCandidates(draft[key], zone);
    if (!candidates.length) throw new Error(`Choose a valid ${key} time in ${zone}. That time may fall in a daylight saving gap.`);
    if (candidates.length === 1) return candidates[0]!;
    const choice = Number(draft[`${key}Choice`]);
    if (!draft[`${key}Choice`] || !candidates.includes(choice)) throw new Error(`Choose which repeated ${key} time you mean.`);
    return choice;
  };
  const start_at = read('start'), end_at = read('end');
  if (end_at <= start_at) throw new Error(draft.allDay ? 'The last day must be on or after the first day.' : 'The end must be after the start.');
  return { start_at, end_at };
};

export const createCalendarCreateSurface = (deps: {
  callers: CalendarCreateCallers; actionAttr: string; render(): void;
  context(): { day: string; zone: string; preferredSlug?: string | null };
  onCreated(result: CalendarEventCreateResult): void;
  now?: () => number;
}) => {
  let draft: CalendarCreateDraft | null = null, initial = '';
  let zone = '', creationId = '', error = '', loading = false, saving = false, disposed = false;
  let destinations: CalendarEventDestinations = { destinations: [], unavailable: [] };
  let pending: CalendarEventCreateRequest | null = null;
  let needsCheck = false, generation = 0;
  let leave: (() => void) | null = null;
  let focus: string | null = null;
  const available = () => Boolean(deps.callers.destinations && deps.callers.create);
  const dirty = () => Boolean(draft && (needsCheck || JSON.stringify(draft) !== initial));
  const paint = (key?: string) => { if (key) focus = key; deps.render(); };
  const reset = () => { generation++; draft = null; pending = null; error = ''; leave = null; needsCheck = false; loading = false; };
  const load = async () => {
    if (!draft || loading || saving || needsCheck || !deps.callers.destinations) return;
    const mine = ++generation, preferred = deps.context().preferredSlug;
    loading = true; error = ''; paint();
    try {
      const result = await deps.callers.destinations();
      if (disposed || mine !== generation || !draft) return;
      if (!Array.isArray(result?.destinations) || !Array.isArray(result.unavailable)) throw new Error('The calendar list could not be confirmed.');
      destinations = result;
      const before = draft.destination;
      if (!result.destinations.some(value => destinationKey(value) === draft!.destination)) {
        // Losing access to the selected destination must not silently move a
        // draft onto another calendar, including the local calendar.
        const selected = before ? undefined : preferred ? result.destinations.find(value => value.slug === preferred)
          : result.destinations.find(value => value.provider === 'local') ?? result.destinations[0];
        draft.destination = selected ? destinationKey(selected) : '';
      }
      // Loading a sensible destination is not an unsaved owner edit.
      if (initial) {
        const baseline: CalendarCreateDraft = JSON.parse(initial);
        if (baseline.destination === before) initial = JSON.stringify({ ...baseline, destination: draft.destination });
      }
    } catch (cause) {
      if (!disposed && mine === generation) error = classifyRpcError(cause).code === 'unknown_method'
        ? 'Update your Recued server to create events here.' : humanizeRpcError(cause);
    } finally { if (!disposed && mine === generation) { loading = false; paint(); } }
  };
  const beforeLeave = (resume: () => void): boolean => {
    if (saving) { paint('save'); return false; }
    if (!draft) return true;
    if (!dirty()) { reset(); return true; }
    leave = resume; paint('keep'); return false;
  };
  const open = () => {
    if (!available() || disposed) return;
    if (draft) { paint('summary'); return; }
    const context = deps.context(); zone = context.zone;
    const nextHour = Math.ceil(((deps.now ?? Date.now)() + 1) / 3_600_000) * 3_600_000;
    const next = calendarWallClockValue(nextHour, zone);
    const start = next.slice(0, 10) === context.day ? next : `${context.day}T09:00`;
    const end = start === next ? calendarWallClockValue(nextHour + 3_600_000, zone) : `${context.day}T10:00`;
    creationId = crypto.randomUUID(); destinations = { destinations: [], unavailable: [] };
    draft = { destination: '', summary: '', description: '', location: '', start, end,
      allDay: false, startChoice: '', endChoice: '' };
    initial = JSON.stringify(draft);
    error = ''; needsCheck = false; pending = null; paint('summary'); void load();
  };
  const save = async () => {
    if (!draft || loading || saving || !deps.callers.create) return;
    if (!needsCheck) {
      const destination = destinations.destinations.find(value => destinationKey(value) === draft!.destination);
      try {
        if (!destination) throw new Error('Choose a writable calendar.');
        if (!draft.summary.trim()) { focus = 'summary'; throw new Error('Enter an event title.'); }
        for (const key of ['summary', 'description', 'location'] as const) {
          if (new TextEncoder().encode(draft[key]).length > CALENDAR_EVENT_EDIT_LIMITS[key]) throw new Error(`${key === 'summary' ? 'Title' : key === 'description' ? 'Notes' : 'Location'} is too long.`);
        }
        pending = { slug: destination.slug, calendar_id: destination.calendar_id,
          expected_incarnation: destination.incarnation, creation_id: creationId,
          summary: draft.summary.trim(), description: draft.description, location: draft.location,
          ...calendarCreateTimes(draft, zone), timezone: zone, is_all_day: draft.allDay };
      } catch (cause) { error = humanizeRpcError(cause); paint(); return; }
    }
    if (!pending) return;
    const request = pending, mine = generation;
    saving = true; error = ''; paint('save');
    try {
      const result = await deps.callers.create(request);
      if (disposed || mine !== generation) return;
      const event = result?.snapshot?.event;
      if (result.slug !== request.slug || result.snapshot.incarnation !== request.expected_incarnation
        || !event?.source_id || event.calendar_id !== request.calendar_id || !result.snapshot.record?.record_id
        || result.snapshot.record.source_id !== event.source_id || result.snapshot.record.record_id !== event.record_id
        || event.summary !== request.summary || event.description !== request.description || event.location !== request.location
        || event.start_at !== request.start_at || event.end_at !== request.end_at || event.is_all_day !== request.is_all_day || event.is_recurring) {
        throw new Error('The saved event could not be confirmed.');
      }
      saving = false; reset(); deps.onCreated(result);
    } catch (cause) {
      if (disposed || mine !== generation) return;
      const code = classifyRpcError(cause).code;
      const refused = !needsCheck && code !== null && ['invalid_args', 'forbidden', 'unauthorized', 'resource_changed', 'not_configured', 'unknown_method'].includes(code);
      needsCheck = !refused;
      if (refused) pending = null;
      error = code === 'unknown_method' ? 'Update your Recued server to create events here.' : needsCheck
        ? 'The save could not be confirmed. Check this save, or check the selected calendar before creating another event. Your details have been kept.' : humanizeRpcError(cause);
    } finally { if (!disposed && mine === generation) { saving = false; paint(); } }
  };
  const button = (name: string, label: string, primary = false) => `<button type="${name === 'save' ? 'submit' : 'button'}" class="data-button${primary ? ' data-button--primary' : ''}" ${name === 'save' ? '' : `${deps.actionAttr}="${CALENDAR_CREATE_ACTION}${name}"`} ${FOCUS}="${name}"${saving ? ' aria-disabled="true" aria-busy="true"' : ''}>${e(label)}</button>`;
  const field = (key: string, label: string, control: string) => `<label class="calendar-create-field"><span id="calendar-create-label-${key}">${e(label)}</span>${control}</label>`;
  const attr = (key: string) => `${CALENDAR_CREATE_FIELD}="${key}" ${FOCUS}="${key}"${key === 'allDay' ? '' : ` aria-labelledby="calendar-create-label-${key}"`}`;
  const repeatedTime = (key: 'start' | 'end') => {
    if (!draft || draft.allDay) return '';
    const candidates = calendarWallClockCandidates(draft[key], zone);
    return candidates.length > 1 ? field(`${key}Choice`, `Which ${key} time?`, `<select class="data-input" ${attr(`${key}Choice`)}><option value="">Choose a time</option>${candidates.map((at, index) => `<option value="${at}"${draft![`${key}Choice`] === String(at) ? ' selected' : ''}>${index === 0 ? 'First' : 'Second'} ${e(new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at))}</option>`).join('')}</select>`) : '';
  };
  const render = (): string => {
    if (!draft) return '';
    const provider = { local: 'On this server', gcal: 'Google Calendar', graph: 'Outlook', caldav: 'CalDAV' };
    return `<form class="calendar-create" role="region" aria-label="New event" data-calendar-create-form>
      <div class="calendar-create-heading"><div><h3>New event</h3><p class="calendar-agenda-muted">One-off event · Times in ${e(zone)}</p></div></div>
      ${loading ? '<p role="status">Loading writable calendars…</p>' : ''}
      ${error ? `<p role="alert">${e(error)}</p>` : ''}
      ${destinations.unavailable.length ? `<details><summary>Some calendars are unavailable</summary><ul>${destinations.unavailable.map(value => `<li>${e(value.slug)}: ${e(value.reason)}</li>`).join('')}</ul></details>` : ''}
      <fieldset${saving || needsCheck ? ' disabled' : ''} class="calendar-create-fields">
        ${field('destination', 'Calendar', `<select class="data-input" ${attr('destination')}${loading ? ' disabled' : ''}><option value="">Choose a calendar</option>${destinations.destinations.map(value => `<option value="${e(destinationKey(value))}"${draft!.destination === destinationKey(value) ? ' selected' : ''}>${e(value.name)}${value.provider === 'local' ? '' : ` · ${e(value.slug)} · ${provider[value.provider]}`}</option>`).join('')}</select>`)}
        ${!loading && !destinations.destinations.length ? '<p class="calendar-agenda-muted">No writable calendars are available. Check your connections or reload calendars.</p>' : ''}
        ${field('summary', 'Title', `<input type="text" class="data-input" ${attr('summary')} maxlength="${CALENDAR_EVENT_EDIT_LIMITS.summary}" value="${e(draft.summary)}" required>`)}
        <label class="calendar-create-all-day"><input type="checkbox" ${attr('allDay')}${draft.allDay ? ' checked' : ''}> All day</label>
        <div class="calendar-create-times">${field('start', draft.allDay ? 'First day' : 'Starts', `<input type="${draft.allDay ? 'date' : 'datetime-local'}" class="data-input" ${attr('start')} value="${e(draft.start)}" required>`)}
          ${field('end', draft.allDay ? 'Last day (inclusive)' : 'Ends', `<input type="${draft.allDay ? 'date' : 'datetime-local'}" class="data-input" ${attr('end')} value="${e(draft.end)}" required>`)}</div>
        ${repeatedTime('start')}${repeatedTime('end')}
        ${field('location', 'Location (optional)', `<input type="text" class="data-input" ${attr('location')} maxlength="${CALENDAR_EVENT_EDIT_LIMITS.location}" value="${e(draft.location)}">`)}
        ${field('description', 'Notes (optional)', `<textarea class="data-input" ${attr('description')} rows="3" maxlength="${CALENDAR_EVENT_EDIT_LIMITS.description}">${e(draft.description)}</textarea>`)}
      </fieldset>
      <div class="calendar-create-actions">${button('save', saving ? 'Saving…' : needsCheck ? 'Check save' : 'Create event', true)}${button('cancel', 'Cancel')}${!needsCheck ? button('reload', 'Reload calendars') : ''}</div>
      ${leave ? `<div class="calendar-create-discard" role="group" aria-label="Unsaved event"><p>${needsCheck ? 'This event may already exist in your calendar. Check it before creating another.' : 'Discard this unsaved event draft?'}</p><div class="calendar-create-actions">${button('keep', 'Keep editing')}${button('discard', 'Discard draft')}</div></div>` : ''}
    </form>`;
  };
  return {
    available, render, open, beforeLeave,
    isOpen: () => draft !== null,
    hasUnsavedChanges: dirty,
    hasInFlightWork: () => saving,
    handleSubmit: (event: Event): void => {
      if (!(event.target as HTMLElement | null)?.hasAttribute?.('data-calendar-create-form')) return;
      event.preventDefault(); void save();
    },
    handleAction: (action: string): boolean => {
      if (!action.startsWith(CALENDAR_CREATE_ACTION)) return false;
      const name = action.slice(CALENDAR_CREATE_ACTION.length);
      if (name === 'new') open();
      else if (name === 'save') void save();
      else if (name === 'reload') void load();
      else if (name === 'keep') { leave = null; paint('summary'); }
      else if (name === 'discard' && !saving) { const resume = leave; reset(); paint(); resume?.(); }
      else if (name === 'cancel' && beforeLeave(() => { reset(); paint('new'); })) { reset(); paint('new'); }
      return true;
    },
    handleInput: (target: HTMLElement, change = false): boolean => {
      const key = target.getAttribute(CALENDAR_CREATE_FIELD) as keyof CalendarCreateDraft | null;
      if (!key || !draft || !(key in draft)) return false;
      if (saving || needsCheck) return true;
      if (key === 'allDay') {
        const allDay = (target as HTMLInputElement).checked;
        if (allDay !== draft.allDay) {
          draft.allDay = allDay;
          draft.start = allDay ? draft.start.slice(0, 10) : `${draft.start}T09:00`;
          draft.end = allDay ? draft.end.slice(0, 10) : `${draft.end}T10:00`;
          draft.startChoice = draft.endChoice = '';
          paint('allDay');
        }
      } else {
        const value = (target as HTMLInputElement).value;
        if (draft[key] !== value) {
          draft[key] = value;
          if (key === 'start' || key === 'end') draft[`${key}Choice`] = '';
          if (pending) { pending = null; creationId = crypto.randomUUID(); }
        }
        // Text and date fields also fire change while focus is moving to the
        // next field. Replacing that next control here would lose its input.
        if (change && (key === 'destination' || key === 'startChoice' || key === 'endChoice')) paint(key);
      }
      return true;
    },
    captureFocus: (element: Element | null | undefined) => {
      const key = element?.getAttribute?.(FOCUS);
      if (!key) return null;
      const control = element as HTMLInputElement;
      return { key, start: control.selectionStart, end: control.selectionEnd };
    },
    restoreFocus: (root: ParentNode, previous: { key: string; start?: number | null; end?: number | null } | null) => {
      const explicit = focus, key = explicit ?? previous?.key; focus = null;
      const target = key ? root.querySelector<HTMLElement>(`[${FOCUS}="${key}"]`) : null;
      target?.focus({ preventScroll: true });
      if (!explicit && target && previous?.start != null && previous.end != null) {
        try { (target as HTMLInputElement).setSelectionRange(previous.start, previous.end); } catch { /* Native date and select controls have no text selection. */ }
      }
    },
    dispose: () => { disposed = true; reset(); },
  };
};

export const CALENDAR_CREATE_STYLES = `
.calendar-create { border:1px solid var(--border); border-radius:10px; padding:20px; display:grid; gap:16px; max-width:760px; background:var(--surface); min-width:0; }
.calendar-create h3 { margin:0 0 5px; font-size:1.15rem; }
.calendar-create-fields { display:grid; gap:14px; border:0; margin:0; padding:0; min-width:0; }
.calendar-create-field { display:grid; gap:6px; min-width:0; font-size:14px; }
.calendar-create-field .data-input { width:100%; min-width:0; box-sizing:border-box; }
.calendar-create-times { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
.calendar-create-all-day,.calendar-create-actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.calendar-create-discard { border-top:1px solid var(--border); padding-top:14px; display:grid; gap:12px; }
@media(max-width:600px) { .calendar-create { padding:16px; } .calendar-create-times { grid-template-columns:minmax(0,1fr); } .calendar-create-actions .data-button { min-height:42px; } }
`;
