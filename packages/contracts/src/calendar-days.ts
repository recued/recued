/** An ALL-DAY calendar event's times are DAYS (2026-10-07).
 *
 *  ⛔ Every calendar adapter stores an all-day event the way a date-only due is
 *  stored (`due-day.ts`): `start_at` is the UTC midnight of its first day and
 *  `end_at` the UTC midnight of the day after its last — exclusive, as iCalendar
 *  and Google write it — whatever its `timezone` says. Read as an instant, a
 *  24 December holiday is 23 December, 16:00 in Los Angeles: Data → Calendar
 *  listed it a day early, the Today view dropped an Outlook all-day event once
 *  UTC midnight passed, and a reminder "a day before" fired at 4 pm two days
 *  before.
 *
 *  🔑 THE RULE, in one place so every reader applies the same one: an all-day
 *  event covers the calendar days from `start_at`'s UTC date to the day before
 *  `end_at`'s. On a local clock it runs from the local midnight of its first
 *  day to the local midnight after its last. Writers are held to the encoding
 *  where every write passes (`normalizeAllDaySpan`, at the calendar
 *  dispatcher), so a reader can rely on it. */

import { DAY_MS, localDayAsDateOnly } from './due-day.js';
import { zonedWallClockToEpochMs } from './zoned-wall-clock.js';

const isoDay = (dayMs: number): string => new Date(dayMs).toISOString().slice(0, 10);

/** Is this value a stored day — a UTC midnight? */
const isDay = (ms: number): boolean => Number.isFinite(ms) && ms % DAY_MS === 0;

/** The instant a stored day begins in `timeZone`: its local midnight. A zone
 *  the platform does not know reads as UTC, where the day already is. */
const localMidnight = (dayMs: number, timeZone: string | undefined): number =>
  timeZone === undefined ? dayMs : zonedWallClockToEpochMs(isoDay(dayMs), timeZone) ?? dayMs;

/** The days an all-day event covers: its first and its last (inclusive), as
 *  `YYYY-MM-DD`. A one-day event's first and last are the same day. */
export const allDayEventDays = (
  event: { readonly start_at: number; readonly end_at: number },
): { readonly first: string; readonly last: string } => {
  const first = Math.floor(event.start_at / DAY_MS) * DAY_MS;
  const after = Math.ceil(event.end_at / DAY_MS) * DAY_MS;
  return { first: isoDay(first), last: isoDay(Math.max(first, after - DAY_MS)) };
};

/** When an event starts and ends on a local clock: an all-day event from the
 *  local midnight of its first day to the one after its last, a timed event at
 *  its own instants. For anything that sets an event against the time it is
 *  somewhere — a "today" window, an overlap, a reminder "an hour before". */
export const eventSpanIn = (
  event: { readonly start_at: number; readonly end_at: number; readonly is_all_day: boolean },
  timeZone: string | undefined,
): { readonly start: number; readonly end: number } => {
  if (!event.is_all_day) return { start: event.start_at, end: event.end_at };
  const { first, last } = allDayEventDays(event);
  return {
    start: localMidnight(Date.parse(`${first}T00:00:00Z`), timeZone),
    end: localMidnight(Date.parse(`${last}T00:00:00Z`) + DAY_MS, timeZone),
  };
};

/** The stored encoding of an all-day event, from whatever a writer sent. UTC
 *  midnights already are one. Otherwise the event starts on the day its start
 *  falls on in `timeZone` — an intake form or a model writes the local midnight
 *  there — and lasts as many days as its length rounds to: a local day across a
 *  change of clocks is 23 or 25 hours, a time picked for the event keeps its
 *  24-hour multiples, and an end at 23:59 of the last day counts that day.
 *  Never less than one day. */
export const normalizeAllDaySpan = (
  start_at: number,
  end_at: number,
  timeZone: string | undefined,
): { readonly start_at: number; readonly end_at: number } => {
  if (isDay(start_at) && isDay(end_at) && end_at > start_at) return { start_at, end_at };
  const start = isDay(start_at) ? start_at : localDayAsDateOnly(start_at, timeZone);
  const days = Math.max(1, Math.round((end_at - start_at) / DAY_MS));
  return { start_at: start, end_at: start + days * DAY_MS };
};

/** Is this all-day event already in its stored encoding? */
export const isAllDaySpanNormal = (event: { readonly start_at: number; readonly end_at: number }): boolean =>
  isDay(event.start_at) && isDay(event.end_at) && event.end_at > event.start_at;
