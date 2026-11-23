import { expect, it, vi } from 'vitest';
import type { CalendarOverlapRequest, CalendarOverlapResult } from '@recued/contracts';
import { CALENDAR_TIME_FIELD, calendarTimeDays, calendarTimeSlots, calendarTimeWindow, createCalendarTimeFinder, type CalendarTimeSettings } from '../calendar-time-finder.js';

const settings = (patch: Partial<CalendarTimeSettings> = {}): CalendarTimeSettings => ({
  from: '2026-11-02', through: '2026-11-08', duration: '60', workStart: '09:00', workEnd: '17:00', weekdays: true, ...patch,
});
const now = Date.parse('2026-10-31T12:00:00Z');
const reply = (request: CalendarOverlapRequest, events: CalendarOverlapResult['events'] = []): CalendarOverlapResult => ({
  ...request, checked_at: now, events, truncated: false, sources: [{ slug: 'local', name: 'On this server', status: 'local', last_synced_at: null }],
});
const event = (start: string, end: string, is_all_day = false) => ({
  start_at: Date.parse(start), end_at: Date.parse(end), is_all_day, summary: 'Saved event', calendars: ['On this server'],
});
const input = (key: string, value: string | boolean) => ({
  getAttribute: (attr: string) => attr === CALENDAR_TIME_FIELD ? key : null, value, checked: value,
}) as unknown as HTMLElement;
const pick = (html: string) => /data-action="calendar-create-(find-pick-[^"]+)"/.exec(html)![1]!;
const setup = (call: (request: CalendarOverlapRequest) => Promise<CalendarOverlapResult> = async request => reply(request)) => {
  const choose = vi.fn(); let usable = true;
  const finder = createCalendarTimeFinder({ call, actionAttr: 'data-action', focusAttr: 'data-focus', now: () => now, usable: () => usable, choose });
  finder.open('2026-11-02', 'America/Los_Angeles');
  return { finder, choose, lock: () => { usable = false; } };
};

it('merges nested and touching busy spans, ignores outside events and only offers complete future intervals', () => {
  const request = calendarTimeWindow('2026-11-02', settings(), 'America/Los_Angeles');
  const result = reply(request, [
    event('2026-11-02T17:00Z', '2026-11-02T18:30Z'), event('2026-11-02T17:30Z', '2026-11-02T18:00Z'),
    event('2026-11-02T18:30Z', '2026-11-02T19:00Z'), event('2026-11-02T20:00Z', '2026-11-02T21:00Z'),
    event('2026-11-02T10:00Z', '2026-11-02T11:00Z'),
  ]);
  expect(calendarTimeSlots(request, result, 60, now)).toEqual([
    { start_at: Date.parse('2026-11-02T19:00Z'), end_at: Date.parse('2026-11-02T20:00Z') },
    { start_at: Date.parse('2026-11-02T21:00Z'), end_at: Date.parse('2026-11-02T22:00Z') },
    { start_at: Date.parse('2026-11-02T22:00Z'), end_at: Date.parse('2026-11-02T23:00Z') },
  ]);
  expect(calendarTimeSlots(request, reply(request), 60, Date.parse('2026-11-02T17:07Z'))[0]!.start_at).toBe(Date.parse('2026-11-02T17:15Z'));
  expect(calendarTimeSlots(request, { ...result, truncated: true }, 60, now)).toEqual([]);
  expect(() => calendarTimeSlots(request, { ...result, timezone: 'UTC' }, 60, now)).toThrow(/confirmed/);
  expect(() => calendarTimeSlots(request, result, 0, now)).toThrow(/duration/);
});

it('uses real elapsed minutes across clock changes and blocks floating all-day dates on the selected zone', () => {
  const spring = calendarTimeWindow('2026-03-08', settings({ workStart: '01:00', workEnd: '04:00' }), 'America/Los_Angeles');
  const slots = calendarTimeSlots(spring, reply(spring), 30, 0);
  expect(slots.map(slot => slot.end_at - slot.start_at)).toEqual([1_800_000, 1_800_000, 1_800_000]);
  expect(slots[1]).toEqual({ start_at: Date.parse('2026-03-08T09:30Z'), end_at: Date.parse('2026-03-08T10:00Z') });
  const fall = calendarTimeWindow('2026-11-01', settings({ workStart: '01:00', workEnd: '02:00' }), 'America/Los_Angeles');
  expect(fall.end_at - fall.start_at).toBe(2 * 3_600_000);
  expect(calendarTimeSlots(fall, reply(fall, [event('2026-11-01T00:00Z', '2026-11-02T00:00Z', true)]), 30, now)).toEqual([]);
  expect(() => calendarTimeWindow('2026-03-08', settings({ workStart: '02:30' }), 'America/Los_Angeles')).toThrow(/clock change/);
});

it('bounds the date range and validates duration, working hours and weekday selection', async () => {
  expect(calendarTimeDays(settings())).toHaveLength(5);
  expect(calendarTimeDays(settings({ through: '2026-11-02' }))).toEqual(['2026-11-02']);
  expect(calendarTimeDays(settings({ through: '2026-11-15', weekdays: false }))).toHaveLength(14);
  for (const patch of [{ through: '2026-11-16' }, { through: '2026-11-01' }, { from: '2026-02-30' }, { duration: '14' }, { duration: '30.5' }, { duration: '481' }, { workEnd: '08:00' }])
    expect(() => calendarTimeDays(settings(patch))).toThrow();
  const call = vi.fn(async (request: CalendarOverlapRequest) => reply(request)), { finder } = setup(call);
  finder.input(input('from', '2026-10-31')); finder.input(input('through', '2026-11-01')); finder.action('find-search');
  expect(finder.render()).toContain('contains no weekdays'); expect(call).not.toHaveBeenCalled();
  finder.input(input('from', '2025-11-03')); finder.input(input('through', '2025-11-04')); finder.action('find-search');
  expect(finder.render()).toContain('today or a future date'); expect(call).not.toHaveBeenCalled();
});

it('searches explicitly, bounds suggestions and applies only a current option', async () => {
  const call = vi.fn(async (request: CalendarOverlapRequest) => reply(request)), { finder, choose } = setup(call);
  expect(call).not.toHaveBeenCalled(); finder.action('find-search');
  await vi.waitFor(() => expect(finder.render()).toContain('6 suggested times'));
  expect(call).toHaveBeenCalledTimes(2); expect(choose).not.toHaveBeenCalled();
  const old = pick(finder.render()); finder.input(input('duration', '30')); finder.action(old);
  expect(choose).not.toHaveBeenCalled(); finder.action('find-search');
  await vi.waitFor(() => expect(finder.render()).toContain('6 suggested times'));
  finder.action(pick(finder.render())); expect(choose).toHaveBeenCalledOnce();
  expect(choose.mock.calls[0]![0].end_at - choose.mock.calls[0]![0].start_at).toBe(30 * 60_000);
});

it('explains stale and missing calendars, skips truncated dates and never treats absent data as an empty calendar', async () => {
  let reads = 0;
  const { finder } = setup(async request => {
    const value = reply(request); reads++;
    value.sources.push({ slug: 'work', name: 'Work <team>', status: 'stale', last_synced_at: now });
    value.sources.push({ slug: 'lost', name: 'Lost', status: 'unavailable', last_synced_at: null });
    if (reads === 1) value.truncated = true;
    return value;
  });
  finder.action('find-search'); await vi.waitFor(() => expect(finder.render()).toContain('6 suggested times'));
  expect(finder.render()).toContain('No times are suggested for this date');
  expect(finder.render()).toContain('Work &lt;team&gt;: sync is incomplete'); expect(finder.render()).toContain('Lost: could not be checked');
  const empty = setup(async request => ({ ...reply(request), sources: [] })).finder;
  empty.action('find-search'); await vi.waitFor(() => expect(empty.render()).toContain('No times could be suggested'));
  expect(empty.render()).toContain('no saved calendars were available');
});

it('retires old reads after settings change or closure, allows a new search and respects a locked draft', async () => {
  let release!: (value: CalendarOverlapResult) => void, held!: CalendarOverlapRequest;
  const call = vi.fn<(request: CalendarOverlapRequest) => Promise<CalendarOverlapResult>>()
    .mockImplementationOnce(request => { held = request; return new Promise(done => { release = done; }); })
    .mockImplementation(async request => reply(request));
  const { finder, choose, lock } = setup(call); finder.action('find-search');
  finder.input(input('duration', '30')); finder.action('find-search');
  await vi.waitFor(() => expect(finder.render()).toContain('6 suggested times'));
  const current = pick(finder.render()); release({ ...reply(held), truncated: true }); await Promise.resolve();
  expect(finder.render()).toContain('6 suggested times');
  lock(); finder.action(current); expect(choose).not.toHaveBeenCalled();
  finder.reset(); finder.action(current); expect(finder.render()).toBe('');
});

it('keeps an unchanged blur from cancelling a search, and offers an explicit retry after a failed or unsupported read', async () => {
  let release!: (value: CalendarOverlapResult) => void, held!: CalendarOverlapRequest;
  const { finder } = setup(request => { held = request; return new Promise(done => { release = done; }); });
  finder.action('find-search'); finder.input(input('duration', '60')); release(reply(held));
  await Promise.resolve(); expect(finder.render()).toContain('Looking for times');
  finder.reset(); release(reply(held)); await Promise.resolve(); expect(finder.render()).toBe('');
  let failed = true;
  const retry = setup(async request => { if (failed) throw { code: 'unknown_method' }; return reply(request); }).finder;
  retry.action('find-search'); await vi.waitFor(() => expect(retry.render()).toContain('Update your Recued server'));
  failed = false; retry.action('find-search'); await vi.waitFor(() => expect(retry.render()).toContain('6 suggested times'));
});

it('keeps an existing event’s exact duration and pins its exclusion across searches', async () => {
  const call = vi.fn(async (request: CalendarOverlapRequest) => reply(request)), choose = vi.fn();
  const finder = createCalendarTimeFinder({ call, choose, usable: () => true, now: () => now,
    actionAttr: 'data-action', focusAttr: 'data-focus', actionPrefix: 'calendar-event', title: 'Find another time' });
  const exclusion = { slug: 'local', source_id: 'original', expected_incarnation: 'calendar-1' };
  finder.open('2026-11-02', 'America/Los_Angeles', 60, { exclude: exclusion, durationMs: 90_015 });
  exclusion.source_id = 'Changed outside the finder';
  finder.input(input('duration', '120')); finder.action('find-search');
  await vi.waitFor(() => expect(finder.render()).toContain('6 suggested times'));
  expect(call.mock.calls.every(([request]) => request.exclude?.source_id === 'original')).toBe(true);
  const option = /data-action="(calendar-event-find-pick-[^"]+)"/.exec(finder.render())![1]!;
  finder.action(option.slice('calendar-event-'.length));
  expect(choose.mock.calls[0]![0].end_at - choose.mock.calls[0]![0].start_at).toBe(90_015);
  finder.reset(); finder.action(option.slice('calendar-event-'.length)); expect(choose).toHaveBeenCalledTimes(1);
});

it('routes inputs to their own finder even when both create and edit state exist', () => {
  const create = setup().finder;
  const edit = createCalendarTimeFinder({ choose: vi.fn(), usable: () => true, actionAttr: 'data-action', focusAttr: 'data-focus', actionPrefix: 'calendar-event', now: () => now });
  edit.open('2026-11-02', 'America/Los_Angeles', 60, { durationMs: 60_000 });
  const target = { getAttribute: (key: string) => key === CALENDAR_TIME_FIELD ? 'from' : key === 'data-calendar-time-owner' ? 'calendar-event' : null, value: '2026-11-05' } as unknown as HTMLElement;
  expect(create.input(target)).toBe(false); expect(edit.input(target)).toBe(true);
  expect(create.render()).toContain('value="2026-11-02"'); expect(edit.render()).toContain('value="2026-11-05"');
});

it('does not shorten an event whose full duration does not fit the chosen working day', () => {
  const request = calendarTimeWindow('2026-11-02', settings(), 'America/Los_Angeles');
  expect(calendarTimeSlots(request, reply(request), 60, now, 9 * 3_600_000)).toEqual([]);
  expect(calendarTimeSlots(request, reply(request), 60, now, 14 * 60_000)[0]!.end_at - request.start_at).toBe(14 * 60_000);
});
