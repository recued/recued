/** An all-day calendar event's times are days (2026-10-07). */

import { describe, expect, it } from 'vitest';

import { allDayEventDays, eventSpanIn, isAllDaySpanNormal, normalizeAllDaySpan } from '../calendar-days.js';

const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const at = (iso: string): number => Date.parse(iso);
const DAY = 86_400_000;

describe('allDayEventDays', () => {
  it('names the first and the last day; the stored end is the day after', () => {
    expect(allDayEventDays({ start_at: day('2026-12-24'), end_at: day('2026-12-25') })).toEqual({ first: '2026-12-24', last: '2026-12-24' });
    expect(allDayEventDays({ start_at: day('2026-12-24'), end_at: day('2026-12-26') })).toEqual({ first: '2026-12-24', last: '2026-12-25' });
  });

  it('reads the days whatever zone the reader is in — they are not instants', () => {
    // 2026-12-24T00:00Z is 23 Dec, 16:00 in Los Angeles; the day is still the 24th.
    expect(allDayEventDays({ start_at: day('2026-12-24'), end_at: day('2026-12-25') }).first).toBe('2026-12-24');
  });
});

describe('eventSpanIn', () => {
  const holiday = { start_at: day('2026-12-24'), end_at: day('2026-12-26'), is_all_day: true };

  it('spans an all-day event from the local midnight of its first day to the one after its last', () => {
    expect(eventSpanIn(holiday, 'America/Los_Angeles')).toEqual({ start: at('2026-12-24T08:00:00Z'), end: at('2026-12-26T08:00:00Z') });
    expect(eventSpanIn(holiday, 'Asia/Tokyo')).toEqual({ start: at('2026-12-23T15:00:00Z'), end: at('2026-12-25T15:00:00Z') });
  });

  it('keeps a day 23 hours long across the spring change of clocks', () => {
    const span = eventSpanIn({ start_at: day('2026-03-08'), end_at: day('2026-03-09'), is_all_day: true }, 'America/Los_Angeles');
    expect(span.end - span.start).toBe(23 * 3_600_000);
  });

  it('leaves a timed event at its instants, and reads an unknown zone as UTC', () => {
    expect(eventSpanIn({ start_at: 5, end_at: 9, is_all_day: false }, 'America/Los_Angeles')).toEqual({ start: 5, end: 9 });
    expect(eventSpanIn(holiday, 'Not/AZone')).toEqual({ start: day('2026-12-24'), end: day('2026-12-26') });
    expect(eventSpanIn(holiday, undefined)).toEqual({ start: day('2026-12-24'), end: day('2026-12-26') });
  });
});

describe('normalizeAllDaySpan', () => {
  it('keeps UTC midnights — the stored encoding — whatever the zone', () => {
    expect(normalizeAllDaySpan(day('2026-12-24'), day('2026-12-26'), 'America/Los_Angeles'))
      .toEqual({ start_at: day('2026-12-24'), end_at: day('2026-12-26') });
  });

  it("reads a writer's local midnights as the days they are there, east and west of UTC", () => {
    // An intake form in Los Angeles: 24 Dec 00:00 PST is 08:00 UTC.
    expect(normalizeAllDaySpan(at('2026-12-24T08:00:00Z'), at('2026-12-26T08:00:00Z'), 'America/Los_Angeles'))
      .toEqual({ start_at: day('2026-12-24'), end_at: day('2026-12-26') });
    // In Tokyo the same days begin on the 23rd and 25th in UTC.
    expect(normalizeAllDaySpan(at('2026-12-23T15:00:00Z'), at('2026-12-25T15:00:00Z'), 'Asia/Tokyo'))
      .toEqual({ start_at: day('2026-12-24'), end_at: day('2026-12-26') });
  });

  it('counts a local day across either change of clocks as one day', () => {
    // 8 Mar 2026 has 23 hours in Los Angeles; 1 Nov 2026 has 25.
    expect(normalizeAllDaySpan(at('2026-03-08T08:00:00Z'), at('2026-03-09T07:00:00Z'), 'America/Los_Angeles'))
      .toEqual({ start_at: day('2026-03-08'), end_at: day('2026-03-09') });
    expect(normalizeAllDaySpan(at('2026-11-01T07:00:00Z'), at('2026-11-02T08:00:00Z'), 'America/Los_Angeles'))
      .toEqual({ start_at: day('2026-11-01'), end_at: day('2026-11-02') });
  });

  it('takes a time picked for the event as its day, as many days long as before', () => {
    // Picked at 15:00 in Los Angeles, the length kept in 24-hour steps: one day,
    // even though the end lands at 15:00 the next day.
    expect(normalizeAllDaySpan(at('2026-12-26T23:00:00Z'), at('2026-12-27T23:00:00Z'), 'America/Los_Angeles'))
      .toEqual({ start_at: day('2026-12-26'), end_at: day('2026-12-27') });
    // From a local midnight to 23:59 on the last day: that day counts.
    expect(normalizeAllDaySpan(at('2026-12-24T08:00:00Z'), at('2026-12-26T07:59:00Z'), 'America/Los_Angeles'))
      .toEqual({ start_at: day('2026-12-24'), end_at: day('2026-12-26') });
  });

  it('never stores less than one day', () => {
    expect(normalizeAllDaySpan(day('2026-12-24'), day('2026-12-24'), 'UTC'))
      .toEqual({ start_at: day('2026-12-24'), end_at: day('2026-12-25') });
    expect(normalizeAllDaySpan(day('2026-12-24'), day('2026-12-20'), 'UTC').end_at).toBe(day('2026-12-25'));
  });

  it('reads a zone the platform does not know as UTC', () => {
    expect(normalizeAllDaySpan(at('2026-12-24T08:00:00Z'), at('2026-12-25T08:00:00Z'), 'Pacific Standard Time'))
      .toEqual({ start_at: day('2026-12-24'), end_at: day('2026-12-25') });
  });
});

describe('isAllDaySpanNormal', () => {
  it('is true only for UTC midnights a day or more apart', () => {
    expect(isAllDaySpanNormal({ start_at: day('2026-12-24'), end_at: day('2026-12-25') })).toBe(true);
    expect(isAllDaySpanNormal({ start_at: at('2026-12-24T08:00:00Z'), end_at: day('2026-12-25') })).toBe(false);
    expect(isAllDaySpanNormal({ start_at: day('2026-12-24'), end_at: day('2026-12-24') })).toBe(false);
  });
});
