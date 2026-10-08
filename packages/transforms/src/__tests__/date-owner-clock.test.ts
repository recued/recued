/** Dates on the owner's clock (2026-10-07).
 *
 *  `date_period` reckoned UTC days and `date_format` printed the server
 *  process's time, so for an owner in Los Angeles a morning brief's "today"
 *  began at 5 pm the day before, and an all-day event — stored as the UTC
 *  midnight of its day — showed as a clock time on the wrong day. Each takes a
 *  `time_zone` now, and `event_when` says when an event happens, all-day or
 *  not, in one step a `map` can apply to every row. */

import { describe, expect, it } from 'vitest';

import { date_format, date_period, event_when } from '../date.js';
import { getTransform } from '../index.js';
import type { TransformContext } from '../types.js';
import { ctx } from './helpers.js';

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';
const at = (iso: string): number => Date.parse(iso);
const nowAt = (iso: string): TransformContext => ctx({ now: () => new Date(iso), getTransform });
const period = (p: Record<string, unknown>, c: TransformContext) => date_period(p, c) as { start: string; end: string } | null;

describe('date_format — time_zone', () => {
  it('prints the instant on the clock of the zone it names', () => {
    expect(date_format({ date: '2026-10-07T16:00:00Z', format: 'YYYY-MM-DD HH:mm', time_zone: LA }, ctx())).toBe('2026-10-07 09:00');
    expect(date_format({ date: at('2026-10-07T16:00:00Z'), format: 'YYYY-MM-DD HH:mm', time_zone: TOKYO }, ctx())).toBe('2026-10-08 01:00');
  });

  it('follows the change of clocks', () => {
    expect(date_format({ date: '2026-03-08T09:30:00Z', format: 'HH:mm', time_zone: LA }, ctx())).toBe('01:30');
    expect(date_format({ date: '2026-03-08T10:30:00Z', format: 'HH:mm', time_zone: LA }, ctx())).toBe('03:30');
  });

  it('a zone left empty is no zone; an unknown zone is refused', () => {
    const plain = date_format({ date: '2026-10-07T16:00:00Z', format: 'YYYY-MM-DD HH:mm' }, ctx());
    expect(date_format({ date: '2026-10-07T16:00:00Z', format: 'YYYY-MM-DD HH:mm', time_zone: '' }, ctx())).toBe(plain);
    expect(date_format({ date: '2026-10-07T16:00:00Z', format: 'HH:mm', time_zone: 'Pacific Standard Time' }, ctx())).toBeNull();
  });

  it('a date with no time is that day on every clock, as the renderer shows it', () => {
    expect(date_format({ date: '2026-10-07', format: 'YYYY-MM-DD', time_zone: LA }, ctx())).toBe('2026-10-07');
    expect(date_format({ date: '2026-10-07', format: 'MMM DD, YYYY HH:mm', time_zone: TOKYO }, ctx())).toBe('Oct 07, 2026 00:00');
    expect(date_format({ date: '2026-10-07', format: 'YYYY-MM-DD' }, ctx())).toBe('2026-10-07');
    // Strict: Date.parse reads 30 February as 2 March.
    expect(date_format({ date: '2026-02-30', format: 'YYYY-MM-DD' }, ctx())).toBeNull();
  });
});

describe('date_period — time_zone', () => {
  it("today is the owner's day: in Los Angeles at 8 pm, not tomorrow's UTC day", () => {
    const evening = nowAt('2026-10-08T03:00:00Z'); // 7 Oct, 20:00 PDT
    expect(period({ period: 'today', time_zone: LA }, evening)).toEqual({
      start: '2026-10-07T07:00:00.000Z', end: '2026-10-08T06:59:59.999Z',
    });
    // ⛔ The bug, pinned: without a zone "today" is 8 October, from 5 pm on the 7th.
    expect(period({ period: 'today' }, evening)!.start).toBe('2026-10-08T00:00:00.000Z');
  });

  it('east of UTC the day begins the evening before in UTC', () => {
    expect(period({ period: 'today', time_zone: TOKYO }, nowAt('2026-10-07T20:00:00Z'))).toEqual({
      start: '2026-10-07T15:00:00.000Z', end: '2026-10-08T14:59:59.999Z',
    });
  });

  it('a day across a change of clocks is 23 or 25 hours long', () => {
    const spring = period({ period: 'today', time_zone: LA }, nowAt('2026-03-08T20:00:00Z'))!;
    expect(spring).toEqual({ start: '2026-03-08T08:00:00.000Z', end: '2026-03-09T06:59:59.999Z' });
    const fall = period({ period: 'today', time_zone: LA }, nowAt('2026-11-01T20:00:00Z'))!;
    expect(fall).toEqual({ start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T07:59:59.999Z' });
  });

  it('tomorrow and yesterday are the days either side, on either clock', () => {
    const evening = nowAt('2026-10-08T03:00:00Z');
    expect(period({ period: 'tomorrow', time_zone: LA }, evening)).toEqual({
      start: '2026-10-08T07:00:00.000Z', end: '2026-10-09T06:59:59.999Z',
    });
    expect(period({ period: 'yesterday', time_zone: LA }, evening)!.start).toBe('2026-10-06T07:00:00.000Z');
    expect(period({ period: 'tomorrow' }, ctx())).toEqual({
      start: '2026-04-09T00:00:00.000Z', end: '2026-04-09T23:59:59.999Z',
    });
  });

  it("weeks and months are the owner's too", () => {
    // Sunday 4 October, 22:00 PDT — already Monday in UTC.
    const sundayNight = nowAt('2026-10-05T05:00:00Z');
    expect(period({ period: 'this_week', time_zone: LA }, sundayNight)).toEqual({
      start: '2026-09-28T07:00:00.000Z', end: '2026-10-05T06:59:59.999Z',
    });
    expect(period({ period: 'this_week' }, sundayNight)!.start).toBe('2026-10-05T00:00:00.000Z');
    // 31 October, 22:00 PDT; clocks go back the next morning.
    expect(period({ period: 'this_month', time_zone: LA }, nowAt('2026-11-01T05:00:00Z'))).toEqual({
      start: '2026-10-01T07:00:00.000Z', end: '2026-11-01T06:59:59.999Z',
    });
  });

  it('date: the period around that instant instead of now', () => {
    expect(period({ period: 'today', date: '2026-12-24T08:00:00Z', time_zone: LA }, ctx())).toEqual({
      start: '2026-12-24T08:00:00.000Z', end: '2026-12-25T07:59:59.999Z',
    });
    expect(period({ period: 'today', date: at('2026-12-24T07:59:00Z'), time_zone: LA }, ctx())!.start)
      .toBe('2026-12-23T08:00:00.000Z');
    expect(period({ period: 'today', date: 'now' }, ctx())!.start).toBe('2026-04-08T00:00:00.000Z');
  });

  it('a date named but missing, or an unknown zone, is null — never now, never UTC', () => {
    expect(period({ period: 'today', date: null }, ctx())).toBeNull();
    expect(period({ period: 'today', date: undefined }, ctx())).toBeNull();
    expect(period({ period: 'today', time_zone: 'Mars/Olympus' }, ctx())).toBeNull();
  });
});

describe('event_when', () => {
  const when = (event: unknown, time_zone?: string) => event_when({ event, ...(time_zone === undefined ? {} : { time_zone }) }, ctx()) as Record<string, unknown> | null;

  it('a timed event: its instants, its day and times on the owner clock', () => {
    const start_at = at('2026-10-15T17:00:00Z');
    const end_at = at('2026-10-15T18:00:00Z');
    expect(when({ start_at, end_at, is_all_day: false }, LA)).toEqual({
      start: start_at, end: end_at, day: '2026-10-15', time: '10:00',
      date_time: '2026-10-15 10:00', text: '2026-10-15 10:00–11:00',
    });
  });

  it('an event across local midnight names both days', () => {
    const w = when({ start_at: at('2026-10-15T14:00:00Z'), end_at: at('2026-10-15T16:00:00Z'), is_all_day: false }, TOKYO)!;
    expect(w.day).toBe('2026-10-15');
    expect(w.text).toBe('2026-10-15 23:00 – 2026-10-16 01:00');
  });

  it('an all-day event is its days, from local midnight to local midnight', () => {
    const holiday = { start_at: at('2026-12-24T00:00:00Z'), end_at: at('2026-12-25T00:00:00Z'), is_all_day: true };
    expect(when(holiday, LA)).toEqual({
      start: at('2026-12-24T08:00:00Z'), end: at('2026-12-25T08:00:00Z'), day: '2026-12-24',
      time: 'All day', date_time: '2026-12-24, all day', text: '2026-12-24, all day',
    });
    expect(when(holiday, TOKYO)!.start).toBe(at('2026-12-23T15:00:00Z'));
    // ⛔ What a recipe printed for it before: a clock time, on the day before.
    expect(date_format({ date: holiday.start_at, format: 'YYYY-MM-DD HH:mm', time_zone: LA }, ctx())).toBe('2026-12-23 16:00');
  });

  it('a multi-day all-day event names its first and last day', () => {
    const offsite = { start_at: at('2026-12-24T00:00:00Z'), end_at: at('2026-12-26T00:00:00Z'), is_all_day: true };
    const w = when(offsite, LA)!;
    expect(w.date_time).toBe('2026-12-24 – 2026-12-25, all day');
    expect(w.end).toBe(at('2026-12-26T08:00:00Z'));
  });

  it('reads the shapes events arrive in: a stored 1, numeric text, a missing end', () => {
    expect(when({ start_at: at('2026-12-24T00:00:00Z'), end_at: at('2026-12-25T00:00:00Z'), is_all_day: 1 }, LA)!.time).toBe('All day');
    expect(when({ start_at: String(at('2026-10-15T17:00:00Z')), is_all_day: false }, LA)!.text).toBe('2026-10-15 10:00');
  });

  it('part: one of them alone, for a table cell', () => {
    const holiday = { start_at: at('2026-12-24T00:00:00Z'), end_at: at('2026-12-25T00:00:00Z'), is_all_day: true };
    expect(event_when({ event: holiday, time_zone: LA, part: 'time' }, ctx())).toBe('All day');
    expect(event_when({ event: holiday, time_zone: LA, part: 'start' }, ctx())).toBe(at('2026-12-24T08:00:00Z'));
    expect(event_when({ event: holiday, time_zone: LA, part: 'summary' }, ctx())).toBeNull();
  });

  it('is null with no start, for a value that is not an event, or in an unknown zone', () => {
    expect(when({ end_at: 5, is_all_day: false }, LA)).toBeNull();
    expect(when('2026-10-15', LA)).toBeNull();
    expect(when([{ start_at: 5 }], LA)).toBeNull();
    expect(when({ start_at: 5, end_at: 6, is_all_day: false }, 'Nowhere/Land')).toBeNull();
  });
});

describe('map apply — a target that reads the whole row', () => {
  const map = getTransform('map')!;
  const rows = [
    { summary: 'Standup', start_at: at('2026-10-15T17:00:00Z'), end_at: at('2026-10-15T17:15:00Z'), is_all_day: false },
    { summary: 'Holiday', start_at: at('2026-10-15T00:00:00Z'), end_at: at('2026-10-16T00:00:00Z'), is_all_day: true },
  ];

  it('with no field, each row is handed over whole, and keeps its own fields', () => {
    const out = map({ array: rows, apply: 'event_when', time_zone: LA, output_field: 'when' }, nowAt('2026-10-15T12:00:00Z')) as Array<{ summary: string; when: { time: string } }>;
    expect(out.map((row) => [row.summary, row.when.time])).toEqual([['Standup', '10:00'], ['Holiday', 'All day']]);
    const cells = map({ array: rows, apply: 'event_when', part: 'time', time_zone: LA, output_field: 'starts_text' }, nowAt('2026-10-15T12:00:00Z')) as Array<{ starts_text: string }>;
    expect(cells.map((row) => row.starts_text)).toEqual(['10:00', 'All day']);
  });

  it('with a field, the value at that field, as before', () => {
    const out = map({ array: rows, apply: 'date_format', field: 'start_at', format: 'HH:mm', time_zone: LA, output_field: 'starts' }, ctx({ getTransform })) as Array<{ starts: string }>;
    expect(out.map((row) => row.starts)).toEqual(['10:00', '17:00']);
  });
});
