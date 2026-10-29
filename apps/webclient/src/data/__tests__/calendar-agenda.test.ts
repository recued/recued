import { describe, expect, it, vi } from 'vitest';
import type { CollectionInstanceRow, CollectionRecord } from '@recued/contracts';
import { AGENDA_FIELD, AGENDA_SOURCE, calendarAgendaEvent, calendarAgendaWindow, calendarDateIn, createCalendarAgenda } from '../calendar-agenda.js';
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

describe('Calendar agenda', () => {
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
