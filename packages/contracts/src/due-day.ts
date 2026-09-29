/** A due that names a DAY, not an instant.
 *
 *  Every first-party writer of a date-only due — a model answering "by Friday",
 *  `date_parse` over `2026-09-28`, Compose's date field, a vendor's `due_on` —
 *  stores it as UTC midnight of that date. Read as an instant, "due Monday"
 *  became Sunday 17:00 in Pacific time: the Today view, the Tasks filter and
 *  the due sweep all called it overdue on Sunday evening, while the Tasks list
 *  (UTC date) said Monday. Found on a live Meeting Secretary drive.
 *
 *  🔑 THE RULE, in one place so every reader applies the same one: a due at an
 *  exact multiple of a day (UTC midnight) names that UTC calendar date D. In the
 *  zone it is judged in, it is due for the whole of D — from D's local midnight
 *  until the next one — and overdue only once D has ended. Any other value is an
 *  instant, judged as before. (Matches D-139: "overdue ONLY after
 *  end-of-day in user's TZ".)
 *
 *  ⚠ The one collision: a TIMED due that lands exactly on 00:00 UTC (17:00 in
 *  Pacific daylight time, 02:00 in Central European summer time) reads as a
 *  day. A writer of timed dues avoids it with {@link timedDueMs}. */

import { zonedWallClockToEpochMs } from './zoned-wall-clock.js';

export const DAY_MS = 86_400_000;

/** Does this due name a whole day rather than an instant? */
export const isDateOnlyDue = (ms: number): boolean =>
  Number.isFinite(ms) && ms % DAY_MS === 0;

/** The date-only encoding of a `YYYY-MM-DD` calendar day — UTC midnight, how
 *  a day is stored — or `null` when the text is not a day that exists.
 *  ⚠ STRICT ON PURPOSE: `Date.parse('2026-02-30')` is 2 March, so a day typed
 *  or extracted wrong would be stored as a different one without a word. */
export const calendarDayMs = (text: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text ? ms : null;
};

/** `YYYY-MM-DD` of a date-only due; `null` for an instant. */
export const dueDayIso = (ms: number): string | null =>
  isDateOnlyDue(ms) ? new Date(ms).toISOString().slice(0, 10) : null;

/** When a due starts and stops counting, in `timeZone`.
 *
 *  A date-only due spans its day there: `start` is D's local midnight, `end`
 *  the next one (23 or 25 hours apart across a clock change). An instant is a
 *  point: `start === end === ms`. An unknown zone falls back to UTC, which is
 *  where a date-only due's day already is. */
export const dueSpan = (
  ms: number,
  timeZone: string | undefined,
): { readonly start: number; readonly end: number } => {
  const day = dueDayIso(ms);
  if (day === null) return { start: ms, end: ms };
  const nextDay = new Date(ms + DAY_MS).toISOString().slice(0, 10);
  const start = timeZone === undefined ? null : zonedWallClockToEpochMs(day, timeZone);
  const end = timeZone === undefined ? null : zonedWallClockToEpochMs(nextDay, timeZone);
  return start === null || end === null ? { start: ms, end: ms + DAY_MS } : { start, end };
};

/** Has this due passed? Instants at the instant; days once the day is over. */
export const isDuePast = (ms: number, now: number, timeZone: string | undefined): boolean =>
  now >= dueSpan(ms, timeZone).end;

/** The UTC-midnight encoding of the calendar date `instant` falls on in
 *  `timeZone` — the date-only due that means "that day" there. */
export const localDayAsDateOnly = (instant: number, timeZone: string | undefined): number => {
  const utcDay = Math.floor(instant / DAY_MS) * DAY_MS;
  if (timeZone !== undefined) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(instant));
      const read = (type: string): number =>
        Number(parts.find((part) => part.type === type)?.value);
      const day = Date.UTC(read('year'), read('month') - 1, read('day'));
      // ⛔ A zone moves a date by at most a day, so anything further from the
      // UTC day is a misread. Intl writes a year before 1 AD without its sign
      // (the earliest Date, 271,821 BC, reads "271822"), so an open range's
      // far-past bound came back in the far FUTURE and every day-due fell
      // outside it — live, Today listed no task due as a day. (`Date.UTC` also
      // reads years 1–99 as 1900–1999.)
      if (Number.isFinite(day) && Math.abs(day - utcDay) <= DAY_MS) return day;
    } catch {
      // Unknown zone: fall through to UTC.
    }
  }
  return utcDay;
};

/** A TIMED due that happens to land on 00:00 UTC would read as a whole day;
 *  one millisecond later it cannot. Invisible at any precision a person sets. */
export const timedDueMs = (ms: number): number => (isDateOnlyDue(ms) ? ms + 1 : ms);
