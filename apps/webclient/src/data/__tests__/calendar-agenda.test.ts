import { describe, expect, it, vi } from 'vitest';
import type { CollectionInstanceRow, CollectionRecord } from '@recued/contracts';
import { AGENDA_FIELD, AGENDA_SOURCE, calendarAgendaEvent, calendarAgendaWindow, calendarDateIn, calendarMonthWindow, calendarAgendaPreferences, shiftCalendarMonth, createCalendarAgenda } from '../calendar-agenda.js';
import type { DataCollectionListCaller } from '../bootstrap-data-route.js';

const NOW = Date.parse('2026-11-01T15:00:00Z');
const source = (slug: string): CollectionInstanceRow => ({
  platform: 'calendar', slug, adapter_type: slug === 'local' ? 'local' : 'gcal',
  auth_state: 'healthy', last_synced_at: NOW,
  caps: { read: 'yes', list_calendars: 'yes', create_event: 'no', update_event: 'no', delete_event: 'no',
    rsvp: 'no', search: 'local', watch: 'none', auth: 'none', recurrence: 'client' },
});
const record = (id: string, start: string, end: string, allDay = false): CollectionRecord => ({
  record_id: id, source_id: id, received_at: NOW, modified_at: NOW, size_bytes: 0,
  hot_fields: { summary: id, start_at: Date.parse(start), end_at: Date.parse(end), is_all_day: allDay, status: 'confirmed' },
});
const timed = (id = 'meeting') => record(id, '2026-11-01T17:00:00Z', '2026-11-01T18:00:00Z');
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const field = (value: string, slug?: string, checked = true): HTMLElement => ({
  value, checked, getAttribute: (name: string) => name === AGENDA_FIELD ? slug ? 'source' : 'date'
    : name === AGENDA_SOURCE ? slug ?? null : null,
} as unknown as HTMLElement);
const searchField = (value: string): HTMLElement => ({ value, getAttribute: (name: string) => name === AGENDA_FIELD ? 'search' : null } as unknown as HTMLElement);

describe('Calendar agenda', () => {
  it('offers only the explicit current nonempty query to global search without changing the local filter or reading again', async () => {
    const onSearchEverywhere = vi.fn(), list = vi.fn<DataCollectionListCaller>(async args => ({ records: args.filters?.is_all_day ? [] : [timed()] }));
    const view = createCalendarAgenda({ list, onSearchEverywhere, listInstances: async () => ({ instances: [source('work')] }),
      actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC' });
    await view.refresh(); const reads = list.mock.calls.length;
    view.handleAction('calendar-agenda-search-everywhere', field('')); expect(onSearchEverywhere).not.toHaveBeenCalled();
    view.handleInput(searchField('first fragment')); view.handleInput(searchField('  Café & <renewal>  '));
    expect(onSearchEverywhere).not.toHaveBeenCalled(); view.handleAction('calendar-agenda-search-everywhere', field(''));
    expect(onSearchEverywhere).toHaveBeenCalledExactlyOnceWith('Café & <renewal>');
    expect(view.snapshot().query).toBe('  Café & <renewal>  '); expect(list).toHaveBeenCalledTimes(reads);
    view.handleInput(searchField('   ')); view.handleAction('calendar-agenda-search-everywhere', field(''));
    expect(onSearchEverywhere).toHaveBeenCalledOnce(); view.dispose();
  });

  it('searches literal titles and locations in the loaded range without new reads or dropping source identities', async () => {
    const matching = { ...timed('same-id'), hot_fields: { ...timed().hot_fields, summary: 'Cafe\u0301 planning', location: 'Room [A.*]' } };
    const hiddenOnly = { ...timed('Café-only-in-id'), hot_fields: { ...timed().hot_fields, summary: 'Other event', description: 'Café' } };
    const list = vi.fn<DataCollectionListCaller>(async args => ({ records: args.filters?.is_all_day ? [] : [matching, hiddenOnly] }));
    const view = createCalendarAgenda({ list, listInstances: async () => ({ instances: [source('work'), source('local')] }),
      actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC' });
    await view.refresh(); const reads = list.mock.calls.length;
    view.handleInput(searchField(' CAFÉ   planning '));
    expect(view.snapshot().matches.map(event => [event.slug, event.record.record_id])).toEqual([['local', 'same-id'], ['work', 'same-id']]);
    expect(view.snapshot().events).toHaveLength(4);
    view.handleInput(searchField('[a.*]')); expect(view.snapshot().matches).toHaveLength(2);
    view.handleInput(searchField('^$')); expect(view.snapshot().matches).toEqual([]);
    view.handleAction('calendar-agenda-clear-search', field('')); expect(view.snapshot().matches).toHaveLength(4);
    expect(view.takeFocus()).toBe('search'); expect(list).toHaveBeenCalledTimes(reads); view.dispose();
  });

  it('keeps the query and explicit source selection in the same paired owner across remounts', async () => {
    const owner = {}, continuity = calendarAgendaPreferences(owner);
    const deps = { list: (async args => ({ records: args.filters?.is_all_day ? [] : [timed()] })) as DataCollectionListCaller,
      listInstances: async () => ({ instances: [source('work'), source('local')] }),
      actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC', continuity };
    const first = createCalendarAgenda(deps); await first.refresh();
    first.handleInput(searchField('meeting')); first.handleChange(field('', 'work', false)); first.dispose();
    const restored = createCalendarAgenda(deps); await restored.refresh();
    expect(restored.snapshot().query).toBe('meeting'); expect([...restored.snapshot().selected]).toEqual(['local']);
    expect(restored.snapshot().matches.map(event => event.slug)).toEqual(['local']);
    const another = createCalendarAgenda({ ...deps, continuity: calendarAgendaPreferences({}) }); await another.refresh();
    expect(another.snapshot().query).toBe(''); expect(another.snapshot().matches).toHaveLength(2);
    restored.dispose(); another.dispose();
  });

  it('keeps zero search results qualified while calendars load or fail and updates matches after a source edit', async () => {
    const slow = deferred<Awaited<ReturnType<DataCollectionListCaller>>>();
    const view = createCalendarAgenda({ listInstances: async () => ({ instances: [source('work'), source('slow')] }),
      list: async args => args.slug === 'slow' ? slow.promise : { records: args.filters?.is_all_day ? [] : [timed()] },
      actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC' });
    const pending = view.refresh(); await vi.waitFor(() => expect(view.snapshot().events).toHaveLength(1));
    view.handleInput(searchField('Acme')); expect(view.render()).toContain('Results may be incomplete.');
    expect(view.render()).not.toContain('No matching saved events in this week.');
    slow.reject(new Error('Calendar unavailable')); await pending;
    expect(view.render()).toContain('Calendar unavailable'); expect(view.render()).toContain('Results may be incomplete.');
    view.replace('work', { ...timed(), hot_fields: { ...timed().hot_fields, summary: 'Acme briefing' } });
    expect(view.snapshot().matches.map(event => event.title)).toEqual(['Acme briefing']);
    view.remove('work', 'meeting'); expect(view.snapshot().matches).toEqual([]); view.dispose();
  });

  it('reveals a newly created event without carrying an earlier search into its destination', async () => {
    const continuity = calendarAgendaPreferences({}); continuity.query = 'An earlier filter';
    const view = createCalendarAgenda({ listInstances: async () => ({ instances: [source('work')] }),
      list: async args => ({ records: args.filters?.is_all_day ? [] : [timed()] }),
      actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC', continuity });
    await view.refresh(); expect(view.snapshot().matches).toEqual([]);
    view.showDay('2026-11-01', 'work');
    expect(view.snapshot().query).toBe(''); expect(continuity.query).toBe('');
    expect(view.snapshot().matches.map(event => event.record.record_id)).toEqual(['meeting']); view.dispose();
  });

  it('counts an all-day match once across several days and never resurrects a cleared or composing query', async () => {
    vi.useFakeTimers();
    try {
      const render = vi.fn(), continuity = calendarAgendaPreferences({});
      const view = createCalendarAgenda({ listInstances: async () => ({ instances: [source('work')] }),
        list: async args => ({ records: args.filters?.is_all_day ? [record('Retreat', '2026-11-01T00:00:00Z', '2026-11-04T00:00:00Z', true)] : [] }),
        actionAttr: 'data-action', render, now: () => NOW, timeZone: 'UTC', continuity });
      await view.refresh(); const input = searchField('Retreat');
      view.handleComposition({ type: 'compositionstart', target: input } as unknown as Event); render.mockClear();
      view.handleInput(input); vi.advanceTimersByTime(1000); expect(render).not.toHaveBeenCalled();
      expect(view.handleKeyDown({ target: input, key: 'Escape', isComposing: true } as unknown as KeyboardEvent)).toBe(false);
      expect(view.snapshot().matches).toHaveLength(1);
      view.handleComposition({ type: 'compositionend', target: input } as unknown as Event); expect(render).toHaveBeenCalledOnce();
      expect(view.render()).toContain('1 matching saved event in this week.');
      view.handleInput(searchField('missing')); view.handleAction('calendar-agenda-clear-search', field('')); vi.advanceTimersByTime(1000);
      expect(view.snapshot().query).toBe(''); expect(continuity.query).toBe(''); expect(view.snapshot().matches).toHaveLength(1); view.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('builds complete civil months across DST and clamps month navigation at leap days and year boundaries', () => {
    const november = calendarMonthWindow('2026-11-18', 'America/Los_Angeles');
    expect(november.days).toHaveLength(30);
    expect(november.from).toBe(Date.parse('2026-11-01T07:00:00Z'));
    expect(november.before).toBe(Date.parse('2026-12-01T08:00:00Z'));
    expect(november.before - november.from).toBe((30 * 24 + 1) * 3_600_000);
    expect(november.dateFrom).toBe(Date.parse('2026-11-01T00:00:00Z'));
    expect(november.dateBefore).toBe(Date.parse('2026-12-01T00:00:00Z'));
    const march = calendarMonthWindow('2026-03-08', 'America/Los_Angeles');
    expect(march.before - march.from).toBe((31 * 24 - 1) * 3_600_000);
    expect(calendarMonthWindow('2028-02-29', 'UTC').days).toHaveLength(29);
    expect(shiftCalendarMonth('2028-01-31', 1)).toBe('2028-02-29');
    expect(shiftCalendarMonth('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftCalendarMonth('2026-12-31', 1)).toBe('2027-01-31');
    expect(shiftCalendarMonth('2026-01-31', -1)).toBe('2025-12-31');
    expect(() => calendarMonthWindow('2026-02-30', 'UTC')).toThrow();
  });

  it('uses the first real instant of a day when midnight is skipped or repeated', () => {
    const month = calendarMonthWindow('2018-11-04', 'America/Sao_Paulo');
    const day = month.days.find(day => day.day === '2018-11-04')!;
    expect(day.from).toBe(Date.parse('2018-11-04T03:00:00Z'));
    expect(day.before - day.from).toBe(23 * 3_600_000);
    const holiday = calendarAgendaEvent('local', record('holiday', '2018-11-04T00:00:00Z', '2018-11-05T00:00:00Z', true), 'America/Sao_Paulo')!;
    expect(month.days.filter(day => holiday.start < day.before && holiday.end > day.from).map(day => day.day)).toEqual(['2018-11-04']);
    const repeated = calendarMonthWindow('2021-10-29', 'Asia/Amman').days.find(day => day.day === '2021-10-29')!;
    expect(repeated.from).toBe(Date.parse('2021-10-28T21:00:00Z'));
    expect(repeated.before - repeated.from).toBe(25 * 3_600_000);
  });

  it('loads the full month with separate timed and all-day bounds, then selects a day without another read', async () => {
    const list = vi.fn<DataCollectionListCaller>(async args => ({ records: args.filters?.is_all_day
      ? [record('retreat', '2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z', true)] : [timed()] }));
    const view = createCalendarAgenda({ list, listInstances: async () => ({ instances: [source('work')] }),
      actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'America/Los_Angeles' });
    await view.refresh(); view.handleAction('calendar-agenda-view-month', field('')); await view.whenLoaded();
    const requests = list.mock.calls.slice(-2).map(([args]) => args);
    expect(requests.map(request => request.calendar_window)).toEqual([
      { from: Date.parse('2026-11-01T07:00:00Z'), before: Date.parse('2026-12-01T08:00:00Z') },
      { from: Date.parse('2026-11-01T00:00:00Z'), before: Date.parse('2026-12-01T00:00:00Z') },
    ]);
    const reads = list.mock.calls.length;
    view.handleChange(field('2026-11-02'));
    expect(view.snapshot().selectedDay).toBe('2026-11-02'); expect(list).toHaveBeenCalledTimes(reads);
    expect(view.snapshot().events.find(event => event.title === 'retreat')?.allDay).toBe(true);
    expect(view.isToday()).toBe(false); // A saved Today agenda must not claim to save a month view.
    view.handleAction('calendar-agenda-view-agenda', field('')); await view.whenLoaded();
    expect(view.snapshot().window.days).toHaveLength(7); expect(view.snapshot().window.day).toBe('2026-11-02');
    view.dispose();
  });

  it('retires a late month response after navigation to another month', async () => {
    const slow = deferred<Awaited<ReturnType<DataCollectionListCaller>>>(); let hold = true;
    const view = createCalendarAgenda({ listInstances: async () => ({ instances: [source('work')] }),
      list: async args => {
        if (hold) { hold = false; return slow.promise; }
        return { records: args.filters?.is_all_day ? [] : [record('december', '2026-12-02T17:00:00Z', '2026-12-02T18:00:00Z')] };
      }, actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC', continuity: { view: 'month' } });
    const old = view.refresh(); await vi.waitFor(() => expect(hold).toBe(false));
    view.handleAction('calendar-agenda-next', field('')); await view.whenLoaded();
    slow.resolve({ records: [timed('old-month')] }); await old;
    expect(view.snapshot().window.day).toBe('2026-12-01');
    expect(view.snapshot().events.map(event => event.title)).toEqual(['december']);
    expect(view.snapshot().loading).toBe(false); view.dispose();
  });

  it('keeps view, day and selected calendars across mounts within one server without storing events', async () => {
    const owner = {}, saved = calendarAgendaPreferences(owner);
    const deps = { listInstances: async () => ({ instances: [source('work'), source('local')] }),
      list: async (args: Parameters<DataCollectionListCaller>[0]) => ({ records: args.filters?.is_all_day ? [] : [timed()] }), actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC' };
    const first = createCalendarAgenda({ ...deps, continuity: saved }); await first.refresh();
    first.handleAction('calendar-agenda-view-month', field('')); await first.whenLoaded();
    expect(first.snapshot().events).toHaveLength(2);
    first.handleChange(field('2026-11-20')); first.handleChange(field('', 'work', false)); first.dispose();
    const restored = createCalendarAgenda({ ...deps, continuity: calendarAgendaPreferences(owner) });
    expect(restored.snapshot().view).toBe('month'); expect(restored.snapshot().selectedDay).toBe('2026-11-20');
    expect([...restored.snapshot().selected]).toEqual(['local']); expect(restored.snapshot().events).toEqual([]);
    const other = createCalendarAgenda({ ...deps, continuity: calendarAgendaPreferences({}) });
    expect(other.snapshot().view).toBe('agenda'); expect(other.snapshot().selectedDay).toBe('2026-11-01');
    restored.dispose(); other.dispose();
  });

  it('uses calendar days across DST and preserves all-day and overnight spans', () => {
    const window = calendarAgendaWindow('2026-11-01', 'America/New_York');
    expect(window.before - window.from).toBe((7 * 24 + 1) * 60 * 60 * 1000);
    expect(window.days[0]!.before - window.days[0]!.from).toBe(25 * 60 * 60 * 1000);
    const holiday = calendarAgendaEvent('work', record('holiday', '2026-11-01T00:00:00Z', '2026-11-04T00:00:00Z', true), 'America/New_York')!;
    expect(calendarDateIn(holiday.start, 'America/New_York')).toBe('2026-11-01');
    expect(window.days.filter(day => holiday.start < day.before && holiday.end > day.from).map(day => day.day))
      .toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    const overnight = calendarAgendaEvent('work', record('overnight', '2026-11-02T04:00:00Z', '2026-11-02T07:00:00Z'), 'America/New_York')!;
    expect(window.days.filter(day => overnight.start < day.before && overnight.end > day.from).map(day => day.day))
      .toEqual(['2026-11-01', '2026-11-02']);
    expect(() => calendarAgendaWindow('2026-02-30', 'America/New_York')).toThrow();
  });

  it('pages both event encodings inside the chosen window and keeps equal record IDs from separate calendars', async () => {
    const rows = Array.from({ length: 103 }, (_, index) => timed('meeting-' + index));
    const holiday = record('holiday', '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z', true);
    const list = vi.fn<DataCollectionListCaller>(async args => ({
      records: args.slug === 'local' ? args.filters?.is_all_day ? [] : [rows[0]!]
        : args.filters?.is_all_day ? [holiday] : rows.slice(args.offset ?? 0, (args.offset ?? 0) + args.limit!),
    }));
    const view = createCalendarAgenda({ list, listInstances: async () => ({ instances: [source('work'), source('local')] }),
      actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'America/New_York' });
    await view.refresh();
    expect(view.snapshot().events).toHaveLength(105);
    expect(view.snapshot().events.filter(event => event.record.record_id === 'meeting-0')).toHaveLength(2);
    const requests = list.mock.calls.map(([args]) => args);
    expect(requests.filter(args => args.slug === 'work' && !args.filters?.is_all_day).map(args => args.offset)).toEqual([0, 100]);
    expect(requests.find(args => args.slug === 'work' && !args.filters?.is_all_day)?.calendar_window)
      .toEqual({ from: Date.parse('2026-11-01T04:00:00Z'), before: Date.parse('2026-11-08T05:00:00Z') });
    expect(requests.find(args => args.slug === 'work' && args.filters?.is_all_day)?.calendar_window)
      .toEqual({ from: Date.parse('2026-11-01T00:00:00Z'), before: Date.parse('2026-11-08T00:00:00Z') });
    view.dispose();
  });

  it('shows ready calendars while another read is pending and keeps them when it fails', async () => {
    const slow = deferred<Awaited<ReturnType<DataCollectionListCaller>>>();
    const view = createCalendarAgenda({
      listInstances: async () => ({ instances: [source('local'), source('slow')] }),
      list: async args => args.slug === 'slow' ? slow.promise : { records: args.filters?.is_all_day ? [] : [timed()] },
      actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC',
    });
    const pending = view.refresh();
    await vi.waitFor(() => expect(view.snapshot().events).toHaveLength(1));
    expect(view.snapshot().sources.find(value => value.instance.slug === 'slow')?.loading).toBe(true);
    slow.reject(new Error('Calendar unavailable'));
    await pending;
    expect(view.snapshot().events.map(event => event.title)).toEqual(['meeting']);
    expect(view.snapshot().sources.find(value => value.instance.slug === 'slow')?.error).toContain('Calendar unavailable');
    view.dispose();
  });

  it('drops an earlier week reply and preserves the current date and loading state', async () => {
    const slow = deferred<Awaited<ReturnType<DataCollectionListCaller>>>();
    let hold = true;
    const view = createCalendarAgenda({
      listInstances: async () => ({ instances: [source('work')] }),
      list: async args => {
        if (hold) { hold = false; return slow.promise; }
        return { records: args.filters?.is_all_day ? [] : [record('next-week', '2026-11-08T17:00:00Z', '2026-11-08T18:00:00Z')] };
      }, actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC',
    });
    const old = view.refresh();
    await vi.waitFor(() => expect(hold).toBe(false));
    view.handleAction('calendar-agenda-next', field(''));
    await view.whenLoaded();
    expect(view.snapshot().window.day).toBe('2026-11-08');
    slow.resolve({ records: [timed('old-week')] });
    await old;
    expect(view.snapshot().events.map(event => event.title)).toEqual(['next-week']);
    expect(view.snapshot().loading).toBe(false);
    view.dispose();
  });

  it('filters the loaded sources without new reads and retains an explicit empty selection', async () => {
    const list = vi.fn<DataCollectionListCaller>(async args => ({ records: args.filters?.is_all_day ? [] : [timed()] }));
    const view = createCalendarAgenda({ list, listInstances: async () => ({ instances: [source('work'), source('local')] }),
      actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC' });
    await view.refresh();
    const reads = list.mock.calls.length;
    view.handleChange(field('', 'work', false));
    expect(view.snapshot().events.map(event => event.slug)).toEqual(['local']);
    expect(view.selectedSource()).toBe('local');
    view.handleChange(field('', 'local', false));
    expect(view.snapshot().events).toHaveLength(0);
    expect(view.selectedSource()).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(reads);
    view.handleAction('calendar-agenda-all', field(''));
    expect(view.snapshot().events).toHaveLength(2);
    view.dispose();
  });

  it('keeps a partial page available while a failed calendar is retried and detects repeated pages', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => timed('event-' + index));
    const retry = deferred<Awaited<ReturnType<DataCollectionListCaller>>>();
    let retrying = false;
    const list = vi.fn<DataCollectionListCaller>(async args => {
      if (args.filters?.is_all_day) return { records: [] };
      if (retrying) return retry.promise;
      return { records: rows }; // A broken page repeats its first hundred rows.
    });
    const view = createCalendarAgenda({ list, listInstances: async () => ({ instances: [source('work')] }),
      actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC' });
    await view.refresh();
    expect(view.snapshot().events).toHaveLength(100);
    expect(view.snapshot().sources[0]!.error).toContain('repeated');
    retrying = true;
    view.handleAction('calendar-agenda-retry', field('', 'work'));
    expect(view.snapshot().events).toHaveLength(100);
    expect(view.snapshot().sources[0]!.loading).toBe(true);
    retry.resolve({ records: [timed('confirmed')] });
    await view.whenLoaded();
    expect(view.snapshot().sources[0]!.loading).toBe(false);
    expect(view.snapshot().events.map(event => event.title)).toEqual(['confirmed']);
    expect(view.snapshot().sources[0]!.error).toBeUndefined();
    view.dispose();
  });

  it('keeps confirmed events visible when a manual refresh cannot reload the calendar list', async () => {
    const roster = deferred<{ instances: CollectionInstanceRow[] }>();
    let refreshing = false;
    const view = createCalendarAgenda({
      listInstances: () => refreshing ? roster.promise : Promise.resolve({ instances: [source('work')] }),
      list: async args => ({ records: args.filters?.is_all_day ? [] : [timed()] }),
      actionAttr: 'data-action', render: vi.fn(), now: () => NOW, timeZone: 'UTC',
    });
    await view.refresh();
    refreshing = true;
    view.handleAction('calendar-agenda-refresh', field(''));
    expect(view.snapshot().events.map(event => event.title)).toEqual(['meeting']);
    roster.reject(new Error('Calendar list unavailable'));
    await view.whenLoaded();
    expect(view.snapshot().events.map(event => event.title)).toEqual(['meeting']);
    expect(view.snapshot().error).toContain('Calendar list unavailable');
    view.dispose();
  });
});
