/** A due at UTC midnight names a DAY — due for all of it, overdue once it ends,
 *  in the zone it is judged in. Found live: "due Monday" read overdue on Sunday
 *  evening in Pacific time. Zones are explicit, so this holds on any machine. */

import { describe, expect, it } from 'vitest';

import {
  DAY_MS,
  calendarDayMs,
  dueDayIso,
  dueSpan,
  isDateOnlyDue,
  isDuePast,
  localDayAsDateOnly,
  timedDueMs,
} from '../due-day.js';

const MONDAY = Date.UTC(2026, 8, 28); // 2026-09-28, stored as a day
const LA = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';

describe('a due at UTC midnight is a day', () => {
  it('knows a day from an instant', () => {
    expect(isDateOnlyDue(MONDAY)).toBe(true);
    expect(dueDayIso(MONDAY)).toBe('2026-09-28');
    expect(isDateOnlyDue(MONDAY + 1)).toBe(false);
    expect(dueDayIso(Date.parse('2026-09-28T17:30:00-07:00'))).toBeNull();
  });

  it('spans the whole of its day in the zone it is judged in', () => {
    expect(dueSpan(MONDAY, LA)).toEqual({
      start: Date.parse('2026-09-28T00:00:00-07:00'),
      end: Date.parse('2026-09-29T00:00:00-07:00'),
    });
    expect(dueSpan(MONDAY, BERLIN)).toEqual({
      start: Date.parse('2026-09-28T00:00:00+02:00'),
      end: Date.parse('2026-09-29T00:00:00+02:00'),
    });
    // No zone: its day in UTC.
    expect(dueSpan(MONDAY, undefined)).toEqual({ start: MONDAY, end: MONDAY + DAY_MS });
  });

  it('⛔ is not overdue on the evening before, west of UTC — the live bug', () => {
    const sundayEvening = Date.parse('2026-09-27T20:00:00-07:00'); // already Monday in UTC
    expect(sundayEvening).toBeGreaterThan(MONDAY);
    expect(isDuePast(MONDAY, sundayEvening, LA)).toBe(false);
    // …nor all through Monday there, and it is the moment Monday is over.
    expect(isDuePast(MONDAY, Date.parse('2026-09-28T23:59:00-07:00'), LA)).toBe(false);
    expect(isDuePast(MONDAY, Date.parse('2026-09-29T00:00:00-07:00'), LA)).toBe(true);
  });

  it('a day with a clock change is 25 hours long', () => {
    // Europe goes back an hour on 2026-10-25.
    const { start, end } = dueSpan(Date.UTC(2026, 9, 25), BERLIN);
    expect(end - start).toBe(25 * 60 * 60 * 1000);
  });

  it('an instant is a point, judged as before', () => {
    const at = Date.parse('2026-09-28T17:30:00-07:00');
    expect(dueSpan(at, LA)).toEqual({ start: at, end: at });
    expect(isDuePast(at, at - 1, LA)).toBe(false);
    expect(isDuePast(at, at, LA)).toBe(true);
  });

  it('an unknown zone falls back to the day in UTC rather than throwing', () => {
    expect(dueSpan(MONDAY, 'Not/AZone')).toEqual({ start: MONDAY, end: MONDAY + DAY_MS });
  });

  it('names the local day an instant falls on, as a day', () => {
    const sundayEvening = Date.parse('2026-09-27T20:00:00-07:00');
    expect(localDayAsDateOnly(sundayEvening, LA)).toBe(Date.UTC(2026, 8, 27));
    expect(localDayAsDateOnly(sundayEvening, 'UTC')).toBe(Date.UTC(2026, 8, 28));
    expect(localDayAsDateOnly(sundayEvening, undefined)).toBe(Date.UTC(2026, 8, 28));
  });

  it('⛔ keeps an open range\'s far-past bound in the past — the Today view\'s "since forever"', () => {
    // Intl drops the sign of a year before 1 AD: the earliest Date read as the
    // year 271822, so every day-due fell outside Today's range (found live).
    for (const zone of [LA, BERLIN, 'UTC', undefined]) {
      expect(localDayAsDateOnly(-8.64e15, zone)).toBe(-8.64e15);
    }
    // Years 1–99 are not read as the 1900s either, and the far-future bound stays put.
    const yearFifty = new Date(Date.UTC(2000, 5, 1, 12));
    yearFifty.setUTCFullYear(50);
    expect(Math.abs(localDayAsDateOnly(yearFifty.getTime(), LA) - yearFifty.getTime()))
      .toBeLessThan(DAY_MS);
    expect(localDayAsDateOnly(8.64e15, LA)).toBe(8.64e15 - DAY_MS);
  });

  it('keeps a timed due that lands on 00:00 UTC from reading as a day', () => {
    const fivePm = Date.parse('2026-09-27T17:00:00-07:00'); // exactly 00:00 UTC
    expect(isDateOnlyDue(fivePm)).toBe(true);
    expect(isDateOnlyDue(timedDueMs(fivePm))).toBe(false);
    expect(timedDueMs(fivePm + 60_000)).toBe(fivePm + 60_000);
  });
});

describe('a `YYYY-MM-DD` day, read as the day it names', () => {
  it('is stored as UTC midnight — the date-only encoding every reader above agrees on', () => {
    expect(calendarDayMs('2026-09-28')).toBe(MONDAY);
    expect(isDateOnlyDue(calendarDayMs('2026-09-28')!)).toBe(true);
    expect(dueDayIso(calendarDayMs('2024-02-29')!)).toBe('2024-02-29');
  });

  it('⛔ refuses a day that does not exist instead of rolling it into the next month', () => {
    // `Date.parse('2026-02-30')` is 2 March.
    expect(Number.isNaN(Date.parse('2026-02-30'))).toBe(false);
    expect(calendarDayMs('2026-02-30')).toBeNull();
    expect(calendarDayMs('2026-04-31')).toBeNull();
    expect(calendarDayMs('2025-02-29')).toBeNull();
    expect(calendarDayMs('2026-13-01')).toBeNull();
  });

  it('is a day and nothing else — no time, no zone, no loose spelling', () => {
    expect(calendarDayMs('2026-09-28T00:00:00Z')).toBeNull();
    expect(calendarDayMs('2026-9-28')).toBeNull();
    expect(calendarDayMs(' 2026-09-28')).toBeNull();
    expect(calendarDayMs('')).toBeNull();
  });
});
