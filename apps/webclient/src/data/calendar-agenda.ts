import {
  eventSpanIn, zonedWallClockToEpochMs,
  type CollectionInstanceRow, type CollectionRecord, type CollectionSourceFreshness,
} from '@recued/contracts';
import { e, stampZone, renderActionIcon } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import type { DataCollectionListCaller, DataCollectionListInstancesCaller } from './bootstrap-data-route.js';
import { COLLECTION_OPEN_RECORD_ACTION, COLLECTION_RECORD_ID_ATTR } from './collection-explorer.js';
import { CALENDAR_MONTH_STYLES, MONTH_DAY_ATTR, renderCalendarMonth } from './calendar-month.js';

export const AGENDA_FOCUS = 'data-calendar-agenda-focus';
export const AGENDA_SOURCE = 'data-calendar-agenda-source';
export const AGENDA_FIELD = 'data-calendar-agenda-field';
export const AGENDA_ACTION = 'calendar-agenda-';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const searchText = (text: string): string => text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();

const validInstant = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
const validDay = (day: string): boolean => {
  if (day.length !== 10) return false;
  const date = new Date(day + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
};
export const calendarDateIn = (at: number, zone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(at));
  const part = (type: string) => parts.find(value => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};
/** A day starts at its first real instant. Interpreting 00:00 alone can land
 * before the date during a midnight clock change, or pick its second midnight. */
const calendarDayStart = (day: string, zone: string): number | null => {
  const guess = zonedWallClockToEpochMs(day, zone);
  if (guess === null) return null;
  if (calendarDateIn(guess, zone) === day && calendarDateIn(guess - 1, zone) < day) return guess;
  let low = Date.parse(day + 'T00:00:00Z') - 2 * 86_400_000;
  let high = low + 4 * 86_400_000;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (calendarDateIn(middle, zone) < day) low = middle + 1; else high = middle;
  }
  return calendarDateIn(low, zone) === day ? low : null;
};
export const addCalendarDays = (day: string, amount: number): string => {
  if (!validDay(day)) throw new Error('Choose a valid date.');
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + amount);
  if (!Number.isFinite(date.getTime())) throw new Error('Choose a valid date.');
  const next = date.toISOString().slice(0, 10);
  if (!validDay(next)) throw new Error('Choose a date within the supported calendar range.');
  return next;
};
export interface AgendaDay { day: string; from: number; before: number }
export interface AgendaWindow {
  day: string; from: number; before: number; dateFrom: number; dateBefore: number; days: AgendaDay[];
}
/** Calendar-day arithmetic, including weeks containing a change of clocks. */
export const calendarAgendaWindow = (day: string, zone: string, days = 7): AgendaWindow => {
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error('Choose a valid calendar range.');
  const boundaries = Array.from({ length: days + 1 }, (_, index) => {
    const date = addCalendarDays(day, index);
    const at = calendarDayStart(date, zone);
    if (at === null) throw new Error('That date is not available in your time zone.');
    return { date, at };
  });
  return { day, from: boundaries[0]!.at, before: boundaries[days]!.at,
    dateFrom: Date.parse(day + 'T00:00:00Z'), dateBefore: Date.parse(boundaries[days]!.date + 'T00:00:00Z'),
    days: boundaries.slice(0, days).map((value, index) => ({ day: value.date, from: value.at, before: boundaries[index + 1]!.at })),
  };
};

export const shiftCalendarMonth = (day: string, amount: number): string => {
  if (!validDay(day) || !Number.isInteger(amount)) throw new Error('Choose a valid date.');
  const first = new Date(day.slice(0, 7) + '-01T00:00:00Z');
  first.setUTCMonth(first.getUTCMonth() + amount);
  if (!Number.isFinite(first.getTime()) || !validDay(first.toISOString().slice(0, 10))) throw new Error('Choose a date within the supported calendar range.');
  const end = new Date(first); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  const result = first.toISOString().slice(0, 7) + '-' + String(Math.min(Number(day.slice(8)), end.getUTCDate())).padStart(2, '0');
  if (!validDay(result)) throw new Error('Choose a date within the supported calendar range.');
  return result;
};
export const calendarMonthWindow = (day: string, zone: string): AgendaWindow => {
  if (!validDay(day)) throw new Error('Choose a valid date.');
  const first = day.slice(0, 7) + '-01', next = shiftCalendarMonth(first, 1);
  const days = (Date.parse(next + 'T00:00:00Z') - Date.parse(first + 'T00:00:00Z')) / 86_400_000;
  return calendarAgendaWindow(first, zone, days);
};

export interface CalendarAgendaPreferences {
  view?: 'agenda' | 'month';
  day?: string;
  sources?: string[] | null;
  query?: string;
  returnTo?: { key: string; scrollTop: number; hash: string; sourcesOpen: boolean };
}
const preferences = new WeakMap<object, CalendarAgendaPreferences>();
/** Navigation preferences belong to one paired bootstrap, without event data. */
export const calendarAgendaPreferences = (owner: object): CalendarAgendaPreferences => {
  let saved = preferences.get(owner);
  if (!saved) { saved = {}; preferences.set(owner, saved); }
  return saved;
};

export interface AgendaEvent {
  key: string; slug: string; record: CollectionRecord; title: string;
  start: number; end: number; allDay: boolean; location?: string;
}
export const calendarAgendaEvent = (slug: string, record: CollectionRecord, zone: string): AgendaEvent | null => {
  const hot = record.hot_fields;
  if (!validInstant(hot.start_at) || !validInstant(hot.end_at) || hot.end_at <= hot.start_at
    || hot.status === 'cancelled' || typeof record.record_id !== 'string' || !record.record_id) return null;
  const allDay = hot.is_all_day === true || hot.is_all_day === 1;
  const start = allDay ? calendarDayStart(new Date(hot.start_at).toISOString().slice(0, 10), zone) : hot.start_at;
  const end = allDay ? calendarDayStart(new Date(hot.end_at).toISOString().slice(0, 10), zone) : hot.end_at;
  if (start === null || end === null || end <= start) return null;
  const span = allDay ? { start, end } : eventSpanIn({ start_at: hot.start_at, end_at: hot.end_at, is_all_day: false }, zone);
  return { key: JSON.stringify([slug, record.record_id]), slug, record,
    title: typeof hot.summary === 'string' && hot.summary.trim() ? hot.summary : 'Untitled event',
    start: span.start, end: span.end, allDay,
    ...(typeof hot.location === 'string' && hot.location.trim() ? { location: hot.location } : {}),
  };
};
export const agendaRowKey = (day: string, slug: string, id: string): string => JSON.stringify([day, slug, id]);
const sourceLabel = (source: CollectionInstanceRow): string =>
  source.adapter_type === 'local' ? 'On this server' : source.slug;
export interface AgendaSource {
  instance: CollectionInstanceRow; records: CollectionRecord[]; loading: boolean;
  loaded: boolean; error?: string; freshness?: CollectionSourceFreshness;
}
export interface AgendaSnapshot {
  window: AgendaWindow; zone: string; sources: readonly AgendaSource[]; events: readonly AgendaEvent[];
  view: 'agenda' | 'month'; selectedDay: string;
  query: string; matches: readonly AgendaEvent[];
  selected: ReadonlySet<string>; loading: boolean; loaded: boolean; error?: string; dateError?: string;
}
export interface CalendarAgenda {
  render(): string;
  snapshot(): AgendaSnapshot;
  refresh(options?: { silent?: boolean; sourcesOnly?: boolean }): Promise<void>;
  whenLoaded(): Promise<void>;
  selectSource(slug: string | null): void;
  showDay(day: string, slug: string): void;
  selectedSource(): string | null | undefined;
  isToday(): boolean;
  record(slug: string, id: string): CollectionRecord | undefined;
  replace(slug: string, record: CollectionRecord): void;
  remove(slug: string, id: string): void;
  handleAction(action: string, target: HTMLElement): boolean;
  handleInput(target: HTMLElement): boolean;
  handleChange(target: HTMLElement): boolean;
  handleKeyDown(event: KeyboardEvent): boolean;
  handleComposition(event: Event): void;
  isComposing(): boolean;
  takeFocus(): string | null;
  isBusy(): boolean;
  cancel(): void;
  dispose(): void;
}
export const createCalendarAgenda = (deps: {
  listInstances?: DataCollectionListInstancesCaller; list?: DataCollectionListCaller;
  actionAttr: string; render(): void; onSources?(sources: CollectionInstanceRow[]): void;
  onViewChange?(): void; now?: () => number; timeZone?: string; initialSource?: string | null;
  newEventButton?(): string;
  createForm?(): string;
  onSearchEverywhere?(query: string): void;
  continuity?: CalendarAgendaPreferences;
}): CalendarAgenda => {
  const now = deps.now ?? Date.now;
  const zone = deps.timeZone ?? stampZone();
  let view: 'agenda' | 'month' = deps.continuity?.view === 'month' ? 'month' : 'agenda';
  let selectedDay = deps.continuity?.day ?? calendarDateIn(now(), zone);
  let window: AgendaWindow;
  try { window = view === 'month' ? calendarMonthWindow(selectedDay, zone) : calendarAgendaWindow(selectedDay, zone); }
  catch { view = 'agenda'; selectedDay = calendarDateIn(now(), zone); window = calendarAgendaWindow(selectedDay, zone); }
  let dateInput = selectedDay, pendingFocus: string | null = null;
  let query = (deps.continuity?.query ?? '').slice(0, 512), composing = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let sources: AgendaSource[] = [];
  let selection: Set<string> | null = deps.initialSource !== undefined
    ? deps.initialSource === null ? null : new Set([deps.initialSource])
    : deps.continuity?.sources ? new Set(deps.continuity.sources) : null;
  let loading = false, loaded = false, disposed = false, generation = 0;
  let error: string | undefined, dateError: string | undefined;
  let pending: Promise<void> | null = null;
  const retries = new Set<Promise<void>>();
  let queued = false;
  const currentSelection = () => selection ?? new Set(sources.map(source => source.instance.slug));
  const remember = () => {
    if (deps.continuity) Object.assign(deps.continuity, { view, day: selectedDay, query, sources: selection ? [...selection] : null });
  };
  const events = (): AgendaEvent[] => sources.flatMap(source =>
    currentSelection().has(source.instance.slug) ? source.records.flatMap(record => {
      const event = calendarAgendaEvent(source.instance.slug, record, zone);
      return event && event.start < window.before && event.end > window.from ? [event] : [];
    }) : []).sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  const matchingEvents = (): AgendaEvent[] => {
    const needle = searchText(query);
    return events().filter(event => !needle || searchText(event.title).includes(needle) || searchText(event.location ?? '').includes(needle));
  };
  const paint = () => { if (!disposed) deps.render(); };
  const cancel = () => {
    clearTimeout(searchTimer); searchTimer = undefined; composing = false;
    generation += 1; pending = null; queued = false; loading = false;
    retries.clear();
    sources = sources.map(source => ({ ...source, loading: false }));
  };
  const readSource = async (source: AgendaSource, range: AgendaWindow, current: () => boolean): Promise<void> => {
    source.loading = true;
    const rows = new Map<string, CollectionRecord>();
    let pages = 0;
    try {
      if (!deps.list) throw new Error('Recued cannot read calendar events here.');
      // All-day values name dates at UTC midnight; timed events name instants.
      for (const allDay of [false, true]) {
        const seen = new Set<string>();
        let offset = 0;
        while (current()) {
          if (pages++ >= MAX_PAGES) throw new Error('Only part of this calendar could be loaded. Too many events were returned.');
          const result = await deps.list({ platform: 'calendar', slug: source.instance.slug, limit: PAGE_SIZE, offset,
            filters: { is_all_day: allDay },
            calendar_window: { from: allDay ? range.dateFrom : range.from, before: allDay ? range.dateBefore : range.before },
          });
          if (!current()) return;
          if (!Array.isArray(result.records)) throw new Error('The calendar response could not be confirmed.');
          source.freshness = result.source_freshness;
          for (const record of result.records) {
            if (typeof record.record_id !== 'string' || !record.record_id || seen.has(record.record_id))
              throw new Error('This calendar repeated an event while loading. Reload it to try again.');
            seen.add(record.record_id);
            rows.set(record.record_id, record);
          }
          source.records = [...rows.values()];
          offset += result.records.length;
          if (result.records.length < PAGE_SIZE) break;
        }
      }
      if (current()) { source.loaded = true; source.error = undefined; }
    } catch (cause) {
      if (current()) source.error = humanizeRpcError(cause);
    } finally {
      if (current()) { source.loading = false; paint(); }
    }
  };
  const refresh = (options: { silent?: boolean; sourcesOnly?: boolean } = {}): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pending) { queued = queued || !options.sourcesOnly; return pending; }
    const mine = ++generation, range = window;
    retries.clear();
    const current = () => !disposed && mine === generation;
    loading = true; error = undefined;
    if (!options.silent) sources = sources.map(source => ({ ...source, records: [], loading: true, loaded: false, error: undefined }));
    paint();
    const work = async () => {
      try {
        if (!deps.listInstances) throw new Error('Recued cannot list your calendars here.');
        const response = await deps.listInstances();
        if (!current()) return;
        if (!Array.isArray(response.instances)) throw new Error('The calendar list could not be confirmed.');
        const previous = new Map(sources.map(source => [source.instance.slug, source]));
        sources = response.instances.filter(instance => instance.platform === 'calendar').map(instance => ({
          instance, records: options.silent ? previous.get(instance.slug)?.records ?? [] : [],
          loading: !options.sourcesOnly, loaded: false,
          ...(previous.get(instance.slug)?.freshness ? { freshness: previous.get(instance.slug)!.freshness } : {}),
        }));
        loaded = true;
        deps.onSources?.(sources.map(source => source.instance));
        paint();
        if (!options.sourcesOnly) {
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
            while (current()) {
              const source = sources[next++];
              if (!source) return;
              await readSource(source, range, current);
            }
          }));
        }
      } catch (cause) {
        if (current()) error = humanizeRpcError(cause);
      } finally {
        if (current()) {
          loading = false; pending = null; paint();
          if (queued) { queued = false; void refresh({ silent: true }); }
        }
      }
    };
    pending = Promise.resolve().then(work);
    return pending;
  };
  const chooseDay = (day: string, nextView = view, focusDay = false) => {
    dateInput = day;
    try {
      const next = nextView === 'month' ? calendarMonthWindow(day, zone) : calendarAgendaWindow(day, zone);
      const sameRange = window.from === next.from && window.before === next.before;
      view = nextView; selectedDay = day; window = next; dateError = undefined;
      if (focusDay) pendingFocus = 'day:' + day;
      remember();
      if (sameRange) { deps.onViewChange?.(); paint(); return; }
      cancel();
      sources = sources.map(source => ({ ...source, records: [], loading: true, loaded: false, error: undefined }));
      deps.onViewChange?.(); void refresh();
    } catch (cause) { dateError = humanizeRpcError(cause); paint(); }
  };
  const selectedSource = (): string | null | undefined => {
    if (selection === null) return null;
    if (selection.size === 1) return [...selection][0];
    if (sources.length > 0 && sources.every(source => selection!.has(source.instance.slug))) return null;
    return undefined;
  };
  const renderSource = (source: AgendaSource): string => {
    const slug = source.instance.slug, selected = currentSelection().has(slug), fresh = source.freshness;
    const status = source.loading ? 'Loading…' : source.error ? 'Could not load'
      : source.instance.adapter_type === 'local' ? 'Local'
      : !fresh ? 'Sync status unknown' : fresh.degraded ? 'Needs attention' : fresh.pending > 0 ? 'Catching up'
      : fresh.last_success_at === null ? 'Not synced yet' : fresh.stale ? 'Out of date' : 'Synced';
    const synced = fresh && fresh.last_success_at !== null ? new Date(fresh.last_success_at).toLocaleString() : null;
    return `<div class="calendar-agenda-source"><label><input type="checkbox" ${AGENDA_FIELD}="source"
      ${AGENDA_SOURCE}="${e(slug)}" ${AGENDA_FOCUS}="${e('source:' + slug)}"${selected ? ' checked' : ''}>
      <span>${e(sourceLabel(source.instance))}</span></label><span class="calendar-agenda-muted">${e(status)}
      ${synced ? ` · Last synced ${e(synced)}` : ''}</span></div>`;
  };
  const dateLabel = (value: number, options?: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, { timeZone: zone, calendar: 'gregory', ...options }).format(new Date(value));
  const timeLabel = (value: number) => dateLabel(value, { hour: 'numeric', minute: '2-digit' });
  const renderEvent = (event: AgendaEvent, day: AgendaDay): string => {
    const continues = event.start < day.from;
    const after = event.end >= day.before;
    const span = event.allDay ? 'All day' : continues
      ? `Continues · until ${after ? dateLabel(event.end, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : timeLabel(event.end)}`
      : `${timeLabel(event.start)}–${after ? dateLabel(event.end, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : timeLabel(event.end)}`;
    const source = sources.find(source => source.instance.slug === event.slug)!;
    return `<li><button type="button" class="calendar-agenda-event" ${deps.actionAttr}="${COLLECTION_OPEN_RECORD_ACTION}"
      ${COLLECTION_RECORD_ID_ATTR}="${e(event.record.record_id)}" ${AGENDA_SOURCE}="${e(event.slug)}"
      ${AGENDA_FOCUS}="${e(agendaRowKey(day.day, event.slug, event.record.record_id))}">
      <span class="calendar-agenda-time">${e(span)}</span><span class="calendar-agenda-event-copy">
        <strong>${e(event.title)}</strong><span class="calendar-agenda-muted">${e(sourceLabel(source.instance))}
        ${event.location ? ` · ${e(event.location)}` : ''}${event.allDay && continues ? ' · Continues' : ''}</span>
      </span></button></li>`;
  };
  const render = (): string => {
    const matches = matchingEvents(), selected = currentSelection(), searching = Boolean(searchText(query));
    const visible = sources.filter(source => selected.has(source.instance.slug));
    const missing = [...selected].filter(slug => !sources.some(source => source.instance.slug === slug));
    const incomplete = error !== undefined || missing.length > 0 || visible.some(source => source.error !== undefined || source.loading || !source.loaded);
    const waiting = loading || visible.some(source => source.loading);
    const button = (action: string, label: string, icon?: 'chevron-left' | 'chevron-right' | 'close') => `<button type="button" class="data-button${icon ? ' calendar-agenda-icon-button' : ''}"
      ${deps.actionAttr}="${AGENDA_ACTION + action}" ${AGENDA_FOCUS}="${action}"${icon ? ` aria-label="${e(label)}" title="${e(label)}"` : ''}>${icon ? renderActionIcon(icon) : e(label)}</button>`;
    const heading = view === 'month' ? dateLabel(window.from, { month: 'long', year: 'numeric' })
      : `${dateLabel(window.from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${dateLabel(window.days[6]!.from, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    const scope = view === 'month' ? 'month' : 'week';
    const searchStatus = !searching ? `Search event titles and locations in this ${scope}.`
      : loaded && !visible.length ? 'Select a calendar to search its events.'
      : `${matches.length} matching saved event${matches.length === 1 ? '' : 's'} in this ${scope}${!loaded || incomplete || waiting ? ' so far. Results may be incomplete.' : '.'}`;
    const renderDays = (days: readonly AgendaDay[], selectedDayOnly = false) => days.map(day => {
      const rows = matches.filter(event => event.start < day.before && event.end > day.from)
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.key.localeCompare(b.key));
      return `<section class="calendar-agenda-day"${selectedDayOnly ? ' data-calendar-month-selection' : ''} aria-label="${e(dateLabel(day.from, { weekday: 'long', month: 'long', day: 'numeric' }))}">
        <h3${selectedDayOnly || searching ? ` tabindex="-1" ${AGENDA_FOCUS}="${selectedDayOnly ? 'selected-day' : 'search-day:' + day.day}"` : ''}>${e(dateLabel(day.from, { weekday: 'long', month: 'short', day: 'numeric' }))}</h3>
        ${selectedDayOnly ? button('back-to-month', 'Back to month') : ''}
        ${rows.length ? `<ul>${rows.map(event => renderEvent(event, day)).join('')}</ul>`
          : `<p class="calendar-agenda-muted">${incomplete || waiting ? 'Events may still be missing.' : 'No saved events.'}</p>`}</section>`;
    }).join('');
    let content: string;
    if (!loaded) content = error ? '' : '<p role="status">Loading calendars…</p>';
    else if (!sources.length) content = error ? '' : '<p>No calendars connected yet. <a class="data-button" href="#connections">Connect a calendar</a></p>';
    else if (!visible.length) content = '<p>Select a calendar to see its events.</p>';
    else if (!matches.length) content = waiting ? '<p role="status">Loading events…</p>'
      : incomplete ? '<p>Calendar results are incomplete. Check your calendars and try again.</p>'
      : searching ? `<p>No matching saved events in this ${scope}.</p>` : '<p>No saved events in this date range.</p>';
    else content = renderDays(searching ? window.days.filter(day => matches.some(event => event.start < day.before && event.end > day.from)) : window.days);
    if (view === 'month') {
      const month = renderCalendarMonth({ window, selectedDay, today: calendarDateIn(now(), zone), events: matches,
        searching,
        complete: loaded && visible.length > 0 && !incomplete && !waiting,
        actionAttr: deps.actionAttr, actionPrefix: AGENDA_ACTION, focusAttr: AGENDA_FOCUS, sourceAttr: AGENDA_SOURCE,
        sourceLabels: new Map(sources.map(source => [source.instance.slug, sourceLabel(source.instance)])), dateLabel, timeLabel,
      });
      content = searching ? content + month : month + (loaded && sources.length && visible.length
        ? renderDays(window.days.filter(day => day.day === selectedDay), true) : content);
    }
    return `<section class="calendar-agenda" data-calendar-agenda aria-label="Calendar agenda">
      <div class="calendar-agenda-heading"><div class="calendar-agenda-title"><h2>Calendar</h2><p class="calendar-agenda-range">${e(heading)}</p></div>
        <div class="calendar-agenda-controls calendar-agenda-actions">${deps.newEventButton?.() ?? ''}<button type="button" class="data-button" ${deps.actionAttr}="${AGENDA_ACTION}refresh" ${AGENDA_FOCUS}="refresh"
          ${loading ? 'aria-disabled="true" aria-busy="true"' : ''}>${loading ? 'Refreshing…' : 'Refresh'}</button></div></div>
      ${deps.createForm?.() ?? ''}
      <div class="calendar-agenda-toolbar">
      <div class="calendar-agenda-controls calendar-agenda-view" role="group" aria-label="Calendar view">
        ${(['agenda', 'month'] as const).map(mode => `<button type="button" class="data-button" data-calendar-view="${mode}"
          ${deps.actionAttr}="${AGENDA_ACTION}view-${mode}" ${AGENDA_FOCUS}="view-${mode}" aria-pressed="${view === mode}">${mode === 'month' ? 'Month' : 'Agenda'}</button>`).join('')}
      </div>
      <div class="calendar-agenda-controls calendar-agenda-dates" role="group" aria-label="Agenda dates">
        <div class="calendar-agenda-stepper">${button('previous', view === 'month' ? 'Previous month' : 'Previous week', 'chevron-left')}${button('today', 'Today')}${button('next', view === 'month' ? 'Next month' : 'Next week', 'chevron-right')}</div>
        <label>${view === 'month' ? 'Selected date' : 'Starting'} <input class="data-input" type="date" aria-label="${view === 'month' ? 'Selected date' : 'Agenda start date'}" ${AGENDA_FIELD}="date"
          ${AGENDA_FOCUS}="date" value="${e(dateInput)}"${dateError ? ' aria-invalid="true"' : ''}></label>
      </div>
      </div>
      <div class="calendar-agenda-search"><div class="calendar-agenda-search-field"><label>Search this ${scope}
        <input class="data-input" type="search" aria-label="Search this ${scope}" aria-describedby="calendar-search-status" placeholder="Title or location"
          ${AGENDA_FIELD}="search" ${AGENDA_FOCUS}="search" value="${e(query)}" maxlength="512" autocomplete="off" spellcheck="false"></label>
        ${query ? button('clear-search', 'Clear search', 'close') : ''}</div>
        ${deps.onSearchEverywhere ? `<div class="calendar-agenda-search-actions"><button type="button" class="data-button" ${deps.actionAttr}="${AGENDA_ACTION}search-everywhere" ${AGENDA_FOCUS}="search-everywhere"
          aria-label="${e(query.trim() ? `Search everywhere for ${query.trim()}` : 'Search everywhere')}"${query.trim() ? '' : ' disabled'}>Search everywhere</button></div>` : ''}
        <p class="calendar-agenda-muted" id="calendar-search-status" role="status" aria-live="polite" aria-atomic="true">${e(searchStatus)}</p>
      </div>
      <p class="calendar-agenda-muted calendar-agenda-zone">Times shown in ${e(zone)}. All-day events keep their calendar dates.</p>
      ${dateError ? `<p role="alert">${e(dateError)}</p>` : ''}
      ${error ? `<p role="alert">${e(error)}</p>` : ''}
      ${missing.map(slug => `<p role="alert">Calendar ${e(slug)} is no longer available. Choose another calendar.</p>`).join('')}
      ${waiting && matches.length ? '<p role="status">Loading more calendars…</p>' : ''}
      ${visible.some(source => source.error) && matches.length ? '<p role="status">Some calendars could not be loaded. Events shown may be incomplete.</p>' : ''}
      ${sources.length ? `<details data-calendar-agenda-sources><summary ${AGENDA_FOCUS}="sources">Calendars (${visible.length} of ${sources.length})</summary>
        <div class="calendar-agenda-source-controls">${button('all', 'Show all calendars')}</div>
        ${sources.map(renderSource).join('')}</details>` : ''}
      ${visible.filter(source => source.error).map(source => `<p role="alert">${e(sourceLabel(source.instance))}: ${e(source.error!)}
        <button type="button" class="data-button" ${deps.actionAttr}="${AGENDA_ACTION}retry" ${AGENDA_SOURCE}="${e(source.instance.slug)}"
          ${AGENDA_FOCUS}="${e('retry:' + source.instance.slug)}"${source.loading ? ' aria-disabled="true" aria-busy="true"' : ''}>${source.loading ? 'Reloading…' : 'Reload calendar'}</button></p>`).join('')}
      ${content}
    </section>`;
  };
  return {
    render,
    snapshot: () => ({ window, zone, view, selectedDay, query, matches: matchingEvents(), sources, events: events(), selected: currentSelection(), loading, loaded,
      ...(error ? { error } : {}), ...(dateError ? { dateError } : {}) }),
    refresh,
    whenLoaded: async () => {
      while (pending || retries.size > 0) {
        await Promise.all([...(pending ? [pending] : []), ...retries]);
      }
    },
    selectSource: slug => { selection = slug === null ? null : new Set([slug]); remember(); },
    selectedSource,
    isToday: () => view === 'agenda' && window.day === calendarDateIn(now(), zone),
    record: (slug, id) => currentSelection().has(slug) ? events().find(event => event.slug === slug && event.record.record_id === id)?.record : undefined,
    showDay: (day, slug) => {
      // Reveal the newly created event even when the previous view had a text filter.
      clearTimeout(searchTimer); searchTimer = undefined; query = '';
      selection = new Set([slug]); chooseDay(day);
    },
    replace: (slug, record) => {
      const source = sources.find(source => source.instance.slug === slug);
      if (source) source.records = [...source.records.filter(row => row.record_id !== record.record_id), record];
    },
    remove: (slug, id) => { const source = sources.find(source => source.instance.slug === slug); if (source) source.records = source.records.filter(record => record.record_id !== id); },
    isBusy: () => loading || sources.some(source => source.loading),
    handleAction: (action, target) => {
      if (!action.startsWith(AGENDA_ACTION)) return false;
      const name = action.slice(AGENDA_ACTION.length);
      if (name === 'search-everywhere') {
        if (query.trim()) deps.onSearchEverywhere?.(query.trim());
      } else if (name === 'clear-search') {
        clearTimeout(searchTimer); searchTimer = undefined; query = ''; remember(); pendingFocus = 'search'; deps.onViewChange?.(); paint();
      } else if (name === 'previous' || name === 'next') {
        try { chooseDay(view === 'month' ? shiftCalendarMonth(selectedDay, name === 'previous' ? -1 : 1)
          : addCalendarDays(window.day, name === 'previous' ? -7 : 7)); }
        catch (cause) { dateError = humanizeRpcError(cause); paint(); }
      } else if (name === 'today') chooseDay(calendarDateIn(now(), zone));
      else if (name === 'view-agenda' || name === 'view-month') {
        target.focus?.({ preventScroll: true }); chooseDay(selectedDay, name === 'view-month' ? 'month' : 'agenda');
      } else if (name === 'day') {
        const day = target.getAttribute(MONTH_DAY_ATTR);
        if (view === 'month' && day) {
          const targetDay = window.days.find(value => value.day === day);
          const hasMatch = targetDay && matchingEvents().some(event => event.start < targetDay.before && event.end > targetDay.from);
          pendingFocus = !searchText(query) ? 'selected-day' : hasMatch ? 'search-day:' + day : 'day:' + day;
          chooseDay(day);
        }
      } else if (name === 'back-to-month' && view === 'month') { pendingFocus = 'day:' + selectedDay; paint(); }
      else if (name === 'all') { selection = null; remember(); deps.onViewChange?.(); paint(); }
      else if (name === 'refresh') { if (!loading) void refresh({ silent: true }); }
      else if (name === 'retry' && !loading) {
        const source = sources.find(source => source.instance.slug === target.getAttribute(AGENDA_SOURCE));
        if (source && !source.loading) {
          const mine = generation;
          const retry = readSource(source, window, () => !disposed && mine === generation);
          retries.add(retry);
          void retry.finally(() => retries.delete(retry));
          paint();
        }
      }
      return true;
    },
    handleInput: target => {
      if (target.getAttribute(AGENDA_FIELD) === 'search') {
        query = (target as HTMLInputElement).value.slice(0, 512); remember();
        clearTimeout(searchTimer);
        if (!composing) searchTimer = setTimeout(() => { searchTimer = undefined; deps.onViewChange?.(); paint(); }, 150);
        return true;
      }
      if (target.getAttribute(AGENDA_FIELD) !== 'date') return false;
      dateInput = (target as HTMLInputElement).value;
      return true;
    },
    handleChange: target => {
      const field = target.getAttribute(AGENDA_FIELD);
      if (field === 'date') { chooseDay((target as HTMLInputElement).value); return true; }
      if (field === 'source') {
        const slug = target.getAttribute(AGENDA_SOURCE);
        if (slug && sources.some(source => source.instance.slug === slug)) {
          selection = new Set(currentSelection());
          if ((target as HTMLInputElement).checked) selection.add(slug); else selection.delete(slug);
          remember();
          deps.onViewChange?.(); paint();
        }
        return true;
      }
      return false;
    },
    handleKeyDown: event => {
      if ((event.target as HTMLElement | null)?.getAttribute?.(AGENDA_FIELD) === 'search') {
        if (event.isComposing || composing) return false;
        if (event.key === 'Escape' && query) {
          event.preventDefault(); event.stopPropagation(); clearTimeout(searchTimer); searchTimer = undefined;
          query = ''; remember(); pendingFocus = 'search'; deps.onViewChange?.(); paint(); return true;
        }
        return false;
      }
      const day = (event.target as HTMLElement | null)?.getAttribute?.(MONTH_DAY_ATTR);
      if (view !== 'month' || !day || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return false;
      const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key];
      if (offset === undefined && !['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return false;
      event.preventDefault(); event.stopPropagation();
      try {
        const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
        const next = event.key === 'PageUp' || event.key === 'PageDown' ? shiftCalendarMonth(day, event.key === 'PageUp' ? -1 : 1)
          : addCalendarDays(day, event.key === 'Home' ? -weekday : event.key === 'End' ? 6 - weekday : offset!);
        chooseDay(next, 'month', true);
      } catch (cause) { dateError = humanizeRpcError(cause); paint(); }
      return true;
    },
    handleComposition: event => {
      const target = event.target as HTMLInputElement | null;
      if (target?.getAttribute?.(AGENDA_FIELD) !== 'search') return;
      composing = event.type === 'compositionstart'; clearTimeout(searchTimer); searchTimer = undefined;
      if (!composing) { query = target.value.slice(0, 512); remember(); deps.onViewChange?.(); paint(); }
    },
    isComposing: () => composing,
    takeFocus: () => { const next = pendingFocus; pendingFocus = null; return next; },
    cancel,
    dispose: () => { disposed = true; cancel(); },
  };
};

export const CALENDAR_AGENDA_STYLES = `
${CALENDAR_MONTH_STYLES}
.calendar-agenda { display:flex; flex-direction:column; gap:12px; min-width:0; }
.calendar-agenda-heading,.calendar-agenda-controls { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.calendar-agenda-heading { justify-content:space-between; gap:12px; }
.calendar-agenda-title { flex:1 1 8.5rem; min-width:0; }
.calendar-agenda-heading h2 { font-size:20px; font-weight:600; line-height:1.2; }
.calendar-agenda-actions { justify-content:flex-end; }
.calendar-agenda h2,.calendar-agenda h3,.calendar-agenda p { margin:0; }
.calendar-agenda-range { margin-top:4px!important; font-size:12px; font-weight:500; color:var(--fg-muted); }
.calendar-agenda-toolbar { display:flex; flex-wrap:wrap; align-items:end; gap:12px; min-width:0; }
.calendar-agenda-view { padding:3px; border:1px solid var(--border); border-radius:var(--wc-radius,9px); background:var(--surface-sunk); gap:4px; }
.calendar-agenda .calendar-agenda-view > .data-button[data-calendar-view] { background:transparent; border-color:transparent; color:var(--fg-muted); }
.calendar-agenda .calendar-agenda-view > .data-button[data-calendar-view]:hover { background:var(--surface); }
.calendar-agenda .calendar-agenda-view > .data-button[data-calendar-view][aria-pressed="true"] { background:var(--surface); border-color:var(--border); color:var(--fg); }
.calendar-agenda-dates { flex:1 1 29rem; min-width:0; justify-content:flex-end; align-items:end; }
.calendar-agenda-stepper { display:flex; align-items:center; gap:4px; }
.calendar-agenda :is(.calendar-agenda-stepper,.calendar-agenda-search-field) .data-button.calendar-agenda-icon-button { flex:none; width:var(--wc-control-h,44px); min-width:var(--wc-control-h,44px); padding:0; }
.calendar-agenda-dates label { display:grid; flex:1 1 10rem; gap:4px; min-width:0; max-width:12.5rem; font-size:12px; color:var(--fg-muted); }
.calendar-agenda-dates input { box-sizing:border-box; width:100%; min-width:0; min-height:var(--wc-control-h,44px); }
.calendar-agenda-search { display:flex; flex-wrap:wrap; align-items:end; gap:8px; }
.calendar-agenda-search-field { position:relative; flex:1 1 10rem; min-width:0; }
.calendar-agenda-search label { display:grid; gap:4px; min-width:0; font-size:12px; color:var(--fg-muted); }
.calendar-agenda-search input { width:100%; box-sizing:border-box; min-width:0; min-height:var(--wc-control-h,44px); }
.calendar-agenda .calendar-agenda-search-field .data-input[type="search"] { padding-inline-end:calc(var(--wc-control-h,44px) + 4px); }
.calendar-agenda-search-field input::-webkit-search-cancel-button { appearance:none; -webkit-appearance:none; }
.calendar-agenda .calendar-agenda-search-field .data-button.calendar-agenda-icon-button { position:absolute; inset-inline-end:0; bottom:0; z-index:1; border:0; background:transparent; }
.calendar-agenda-search-actions { display:flex; flex-wrap:wrap; gap:8px; max-width:100%; }
.calendar-agenda-search button { min-height:var(--wc-control-h,44px); }
.calendar-agenda-search p { flex-basis:100%; font-size:12px; line-height:1.45; }
.calendar-agenda .calendar-agenda-zone { font-size:12px; line-height:1.45; }
.calendar-agenda-muted { color:var(--fg-muted); font-size:.875rem; overflow-wrap:anywhere; }
.calendar-agenda-day { border-top:1px solid var(--border); padding-top:1rem; }
.calendar-agenda-day h3 { font-size:1rem; margin-bottom:.65rem; }
.calendar-agenda-day ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.5rem; }
.calendar-agenda-event { display:grid; grid-template-columns:minmax(7rem,11rem) minmax(0,1fr); gap:1rem;
  width:100%; text-align:left; background:var(--surface); color:var(--fg); border:1px solid var(--border);
  border-radius:.6rem; padding:.85rem; font:inherit; cursor:pointer; overflow-wrap:anywhere; }
.calendar-agenda-event:hover { border-color:var(--accent); }
.calendar-agenda-event:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.calendar-agenda-event-copy { display:flex; flex-direction:column; gap:.3rem; min-width:0; }
.calendar-agenda-time { font-size:.875rem; }
.calendar-agenda details { border-top:1px solid var(--border); padding-top:1rem; }
.calendar-agenda summary { cursor:pointer; font-weight:600; }
.calendar-agenda-source { padding:.6rem 0; display:flex; flex-direction:column; gap:.3rem; }
.calendar-agenda-source label { display:flex; flex-direction:row; align-items:center; gap:.6rem; min-height:2.75rem; }
.calendar-agenda-source-controls { padding-top:.75rem; }
@media(max-width:600px) {
  .calendar-agenda-event { grid-template-columns:minmax(0,1fr); gap:.4rem; }
}
@media(max-width:380px) {
  .calendar-agenda-dates { justify-content:flex-start; }
  .calendar-agenda-dates label { flex-basis:100%; max-width:none; }
  .calendar-agenda-search-field { flex-basis:100%; }
  .calendar-agenda-search-actions { width:100%; justify-content:flex-end; }
}
`;
