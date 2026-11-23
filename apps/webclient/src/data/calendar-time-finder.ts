import { DAY_MS, calendarDayMs, eventSpanIn, type CalendarOverlapRequest, type CalendarOverlapResult } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';
import { addCalendarDays, calendarDateIn } from './calendar-agenda.js';
import { calendarWallClockCandidates, calendarWallClockValue } from './calendar-wall-clock.js';
import { calendarOverlapMatches, type CalendarOverlapCaller } from './calendar-overlap-preview.js';

export const CALENDAR_TIME_FIELD = 'data-calendar-time-field';
const OWNER = 'data-calendar-time-owner';
export interface CalendarTimeSettings {
  from: string; through: string; duration: string; workStart: string; workEnd: string; weekdays: boolean;
}
export interface CalendarTimeSlot { start_at: number; end_at: number }
export interface CalendarTimeContext {
  exclude?: CalendarOverlapRequest['exclude'];
  /** An existing event keeps its exact elapsed duration, including seconds. */
  durationMs?: number;
}
const MAX_DAYS = 14, MAX_SLOTS = 6, MINUTE = 60_000;
const clock = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export const calendarTimeDays = (settings: CalendarTimeSettings, exactDurationMs?: number): string[] => {
  const from = calendarDayMs(settings.from), through = calendarDayMs(settings.through);
  if (from === null || through === null || through < from || through - from >= MAX_DAYS * DAY_MS)
    throw new Error('Choose a date range of up to 14 days, with the last date on or after the first.');
  const minutes = Number(settings.duration);
  if (exactDurationMs === undefined ? !settings.duration.trim() || !Number.isInteger(minutes) || minutes < 15 || minutes > 480
    : !Number.isSafeInteger(exactDurationMs) || exactDurationMs <= 0)
    throw new Error('Choose a duration from 15 to 480 whole minutes.');
  if (!clock(settings.workStart) || !clock(settings.workEnd) || settings.workEnd <= settings.workStart)
    throw new Error('Choose working hours that end after they start on the same day.');
  return Array.from({ length: (through - from) / DAY_MS + 1 }, (_, index) => addCalendarDays(settings.from, index))
    .filter(day => !settings.weekdays || ![0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay()));
};
export const calendarTimeWindow = (day: string, settings: CalendarTimeSettings, zone: string): CalendarOverlapRequest => {
  const starts = calendarWallClockCandidates(day + 'T' + settings.workStart, zone);
  const ends = calendarWallClockCandidates(day + 'T' + settings.workEnd, zone);
  if (!starts.length || !ends.length) throw new Error('Working hours fall in a clock change. Choose different hours.');
  return { start_at: starts[0]!, end_at: ends[ends.length - 1]!, is_all_day: false, timezone: zone };
};
/** Only complete bounded windows can yield gaps. Busy spans are merged, including
 * nested events and floating all-day dates on the selected calendar clock. */
export const calendarTimeSlots = (request: CalendarOverlapRequest, result: CalendarOverlapResult, minutes: number, now: number, exactDurationMs?: number): CalendarTimeSlot[] => {
  if ((exactDurationMs === undefined ? !Number.isInteger(minutes) || minutes < 15 || minutes > 480
    : !Number.isSafeInteger(exactDurationMs) || exactDurationMs <= 0) || !Number.isSafeInteger(now))
    throw new Error('Choose a valid duration and current time.');
  if (!calendarOverlapMatches(result, request)) throw new Error('The saved calendar read could not be confirmed.');
  if (result.truncated || !result.sources.some(source => source.status !== 'unavailable')) return [];
  const busy = result.events.map(event => eventSpanIn(event, request.timezone))
    .filter(span => span.start < request.end_at && span.end > request.start_at)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const duration = exactDurationMs ?? minutes * MINUTE, slots: CalendarTimeSlot[] = [];
  let cursor = Math.max(request.start_at, now);
  const gap = (before: number) => {
    let start = Math.ceil(cursor / (15 * MINUTE)) * 15 * MINUTE;
    while (start + duration <= before && slots.length < 3) {
      slots.push({ start_at: start, end_at: start + duration }); start += duration;
    }
  };
  for (const span of busy) {
    gap(Math.min(span.start, request.end_at)); cursor = Math.max(cursor, span.end);
    if (cursor >= request.end_at || slots.length === 3) break;
  }
  if (cursor < request.end_at && slots.length < 3) gap(request.end_at);
  return slots;
};

const calendarFinderDurationLabel = (ms: number): string => {
  const days = Math.floor(ms / DAY_MS), hours = Math.floor(ms % DAY_MS / 3_600_000), minutes = Math.floor(ms % 3_600_000 / MINUTE), seconds = ms % MINUTE / 1000;
  return [[days, 'day'], [hours, 'hour'], [minutes, 'minute'], [seconds, 'second']].filter(([value]) => value)
    .map(([value, unit]) => `${value} ${unit}${value === 1 ? '' : 's'}`).join(' ');
};

export const createCalendarTimeFinder = (deps: {
  call?: CalendarOverlapCaller; actionAttr: string; focusAttr: string; now?: () => number;
  actionPrefix?: 'calendar-create' | 'calendar-event'; title?: string;
  usable(): boolean; choose(slot: CalendarTimeSlot): void;
}) => {
  let settings: CalendarTimeSettings | null = null, zone = '', generation = 0;
  let context: CalendarTimeContext = {};
  let state: 'idle' | 'loading' | 'ready' | 'error' = 'idle', error = '';
  let slots: CalendarTimeSlot[] = [], notices: string[] = [], checkedAt: number | null = null;
  let host: HTMLElement | null = null;
  const now = deps.now ?? Date.now;
  const owns = (target: HTMLElement): boolean => {
    const owner = target.getAttribute(OWNER);
    return owner === null ? settings !== null : owner === (deps.actionPrefix ?? 'calendar-create');
  };
  const retire = () => { generation++; slots = []; notices = []; checkedAt = null; state = 'idle'; error = ''; };
  const stamp = (at: number) => new Intl.DateTimeFormat(undefined, {
    timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    ...(at % MINUTE ? { second: '2-digit' as const } : {}), ...(at % 1000 ? { fractionalSecondDigits: 3 as const } : {}),
  }).format(at);
  const action = (name: string, label: string) => `<button type="button" class="data-button" ${deps.actionAttr}="${deps.actionPrefix ?? 'calendar-create'}-find-${name}" ${deps.focusAttr}="find-${name}">${e(label)}</button>`;
  const results = () => {
    if (state === 'loading') return '<p role="status">Looking for times in saved calendars…</p>';
    if (state === 'error') return `<p role="alert">${e(error)}</p><p>Review the search and choose Find times to try again.</p>`;
    if (state === 'idle') return '<p role="status">Choose Find times to check the selected dates.</p>';
    return `<p role="status">${slots.length ? `${slots.length} suggested ${slots.length === 1 ? 'time' : 'times'}` : context.durationMs === undefined ? 'No times could be suggested in the data checked. Try another date range or shorter duration.'
        : 'No times could be suggested for this event’s full duration in the data checked. Try another date range or wider working hours.'}</p>
      ${notices.length ? `<ul class="calendar-time-notices">${notices.map(notice => `<li>${e(notice)}</li>`).join('')}</ul>` : ''}
      ${slots.length ? `<ul class="calendar-time-options">${slots.map((slot, index) => `<li>${action('pick-' + generation + '-' + index, stamp(slot.start_at) + ' – ' + stamp(slot.end_at))}</li>`).join('')}</ul>` : ''}
      ${checkedAt === null ? '' : `<p class="calendar-agenda-muted">Saved data checked ${e(stamp(checkedAt))}.</p>`}`;
  };
  const paint = () => { if (host?.isConnected) host.innerHTML = results(); };
  const search = async () => {
    if (!settings || !deps.call || !deps.usable() || state === 'loading') return;
    retire(); const mine = generation, wanted = { ...settings }, selectedZone = zone, started = now();
    const current = () => mine === generation && settings !== null && deps.usable() && zone === selectedZone;
    let days: string[];
    try {
      days = calendarTimeDays(wanted, context.durationMs);
      if (!days.length) throw new Error('This range contains no weekdays. Clear Weekdays only or choose different dates.');
      days = days.filter(day => day >= calendarDateIn(started, selectedZone));
      if (!days.length) throw new Error('Choose a date range that includes today or a future date.');
    }
    catch (cause) { state = 'error'; error = (cause as Error).message; paint(); return; }
    state = 'loading'; paint();
    const found: CalendarTimeSlot[] = [], warnings = new Set<string>();
    let checked: number | null = null;
    try {
      for (const day of days) {
        if (!current()) return;
        let request: CalendarOverlapRequest;
        try { request = { ...calendarTimeWindow(day, wanted, selectedZone), ...(context.exclude ? { exclude: { ...context.exclude } } : {}) }; }
        catch { warnings.add(day + ': working hours fall in a clock change; choose different hours for this date.'); continue; }
        const reply = await deps.call(request);
        if (!current()) return;
        if (!calendarOverlapMatches(reply, request)) throw new Error('The saved calendar read could not be confirmed.');
        checked = checked === null ? reply.checked_at : Math.min(checked, reply.checked_at);
        for (const source of reply.sources) {
          if (source.status === 'unavailable') warnings.add(source.name + ': could not be checked. Suggested times may overlap events there.');
          else if (source.status === 'stale') warnings.add(source.name + ': sync is incomplete or out of date' +
            (source.last_synced_at === null ? '; no successful sync recorded.' : '; last synced ' + stamp(source.last_synced_at) + '.'));
        }
        if (reply.truncated) warnings.add(day + ': saved events exceed the preview limit. No times are suggested for this date.');
        if (!reply.sources.length || reply.sources.every(source => source.status === 'unavailable'))
          warnings.add(day + ': no saved calendars were available to check.');
        found.push(...calendarTimeSlots(request, reply, Number(wanted.duration), started, context.durationMs).slice(0, MAX_SLOTS - found.length));
        if (found.length === MAX_SLOTS) break;
      }
      if (!current()) return;
      slots = found; notices = [...warnings]; checkedAt = checked; state = 'ready';
    } catch (cause) {
      if (!current()) return;
      state = 'error'; error = classifyRpcError(cause).code === 'unknown_method'
        ? 'Update your Recued server to find times here.' : 'Saved calendars could not be checked. Your event details have been kept.';
    }
    paint();
  };
  return {
    owns,
    open(day: string, selectedZone: string, minutes = 60, options: CalendarTimeContext = {}): void {
      retire(); zone = selectedZone;
      context = { ...(options.exclude ? { exclude: { ...options.exclude } } : {}), ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}) };
      const first = day >= calendarDateIn(now(), zone) ? day : calendarDateIn(now(), zone);
      settings = { from: first, through: addCalendarDays(first, 6), duration: String(minutes), workStart: '09:00', workEnd: '17:00', weekdays: true };
    },
    reset(): void { retire(); settings = null; host = null; context = {}; },
    render(): string {
      if (!settings) return '';
      const field = (key: keyof CalendarTimeSettings, label: string, type: string) =>
        `<label class="calendar-create-field"><span>${label}</span><input form="" class="data-input" type="${type}" ${CALENDAR_TIME_FIELD}="${key}" ${OWNER}="${deps.actionPrefix ?? 'calendar-create'}" ${deps.focusAttr}="find-${key}" value="${e(String(settings![key]))}"${key === 'duration' ? ' min="15" max="480" step="1"' : ''}></label>`;
      return `<section class="calendar-time-finder" aria-label="${e(deps.title ?? 'Find a time')}"><div class="calendar-create-actions"><h4>${e(deps.title ?? 'Find a time')}</h4>${action('close', 'Close time finder')}</div>
        <p>Times in ${e(zone)}. Suggestions use events saved on this server; connected calendars may have newer changes. Check guests’ availability before inviting them.</p>
        <div class="calendar-time-settings">${context.durationMs === undefined ? field('duration', 'Duration (minutes)', 'number') : `<p class="calendar-time-duration">Duration: ${e(calendarFinderDurationLabel(context.durationMs))}. The full event duration is kept.</p>`}${field('from', 'From date', 'date')}${field('through', 'Through date', 'date')}${field('workStart', 'Working day starts', 'time')}${field('workEnd', 'Working day ends', 'time')}</div>
        <label class="calendar-create-all-day"><input type="checkbox" ${CALENDAR_TIME_FIELD}="weekdays" ${OWNER}="${deps.actionPrefix ?? 'calendar-create'}" ${deps.focusAttr}="find-weekdays"${settings.weekdays ? ' checked' : ''}> Weekdays only</label>
        <div class="calendar-create-actions">${action('search', 'Find times')}</div>
        <div class="calendar-time-results" data-calendar-time-results role="region" aria-label="Suggested times" tabindex="0">${results()}</div></section>`;
    },
    mount(root: ParentNode): void { host = root.querySelector?.<HTMLElement>('[data-calendar-time-results]') ?? null; },
    input(target: HTMLElement): boolean {
      const key = target.getAttribute(CALENDAR_TIME_FIELD);
      if (!key || !owns(target)) return false;
      if (!settings || !deps.usable()) return true;
      if (key === 'duration' && context.durationMs !== undefined) return true;
      if (key === 'weekdays') {
        if (settings.weekdays === (target as HTMLInputElement).checked) return true;
        settings.weekdays = (target as HTMLInputElement).checked;
      } else if (['from', 'through', 'duration', 'workStart', 'workEnd'].includes(key)) {
        const name = key as Exclude<keyof CalendarTimeSettings, 'weekdays'>, value = (target as HTMLInputElement).value;
        if (settings[name] === value) return true;
        settings[name] = value;
      }
      else return true;
      retire(); paint(); return true;
    },
    action(name: string): boolean {
      if (!name.startsWith('find-')) return false;
      if (!settings || !deps.usable()) return true;
      if (name === 'find-search') void search();
      else if (name.startsWith('find-pick-')) {
        const index = slots.findIndex((_slot, index) => name === 'find-pick-' + generation + '-' + index);
        const slot = slots[index];
        if (slot) {
          if (slot.start_at < now()) { retire(); error = 'That suggested time has passed. Choose Find times to check again.'; state = 'error'; paint(); }
          else deps.choose({ ...slot });
        }
      }
      return true;
    },
  };
};

export const CALENDAR_TIME_FINDER_STYLES = `
.calendar-time-finder { display:grid; gap:12px; padding:14px; border:1px solid var(--border); border-radius:8px; min-width:0; }
.calendar-time-finder h4,.calendar-time-finder p { margin:0; }
.calendar-time-finder p { font-size:.875rem; overflow-wrap:anywhere; }
.calendar-time-duration { grid-column:1 / -1; }
.calendar-time-finder .calendar-create-field { display:grid; gap:6px; min-width:0; }
.calendar-time-finder .calendar-create-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.calendar-time-settings { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.calendar-time-results { block-size:18rem; overflow-y:auto; scrollbar-gutter:stable; min-width:0; }
.calendar-time-results > * + * { margin-top:12px; }
.calendar-time-options { display:grid; gap:8px; list-style:none; padding:0; margin:0; }
.calendar-time-options .data-button { width:100%; justify-content:flex-start; text-align:left; white-space:normal; }
.calendar-time-notices { padding-left:20px; font-size:.8125rem; color:var(--fg-muted); overflow-wrap:anywhere; }
@media(max-width:600px) { .calendar-time-settings { grid-template-columns:minmax(0,1fr); } }
`;
