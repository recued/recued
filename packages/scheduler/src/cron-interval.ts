import { zoneOffsetMsAt } from '@recued/contracts';
/** Cron interval computation and validation.
 *
 *  `MIN_CRON_INTERVAL_MS` is the floor for scheduled recipe execution
 *  (5 minutes for hosted Pro). Self-hosters can lower this constant
 *  for shorter intervals.
 *
 *  `cronIntervalMs` computes the minimum gap between consecutive
 *  firings by simulating two `nextCronMatch` calls from a fixed epoch.
 */

/** Minimum allowed cron interval (5 minutes). Self-hosters can lower
 *  this for their builds — it is a single constant to change. */
export const MIN_CRON_INTERVAL_MS = 5 * 60 * 1000;

// ── Cron field matching (reusable from SW inline logic) ─────

/** Check if a single cron field matches a value. */
const cronFieldMatches = (field: string, value: number): boolean => {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return step > 0 && value % step === 0;
  }
  for (const segment of field.split(',')) {
    if (segment.includes('-')) {
      const [lo, hi] = segment.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(segment, 10) === value) return true;
    }
  }
  return false;
};

/** D-269 — the zone a cron expression is READ IN.
 *
 *  ⛔⛔ WITHOUT THIS, `0 9 * * *` MEANT "9am WHEREVER THE PROCESS HAPPENS TO
 *  BE". `Date#getHours()` and friends read the host `TZ`, so the same schedule
 *  resolved to three different instants on three machines — probed:
 *
 *    TZ=UTC                  '0 9 * * *' → 2026-06-15T09:00:00Z
 *    TZ=Asia/Hong_Kong       '0 9 * * *' → 2026-06-15T01:00:00Z
 *    TZ=America/Los_Angeles  '0 9 * * *' → 2026-06-15T16:00:00Z
 *
 *  🔑 AND UNLIKE THE CHAT CLOCK, NO CLIENT CAN SUPPLY IT PER CALL — a cron
 *  fires with nobody connected, by definition. It can only come from the zone
 *  the OWNER declared for the server (D-269 step 1).
 *
 *  ⚠ Absent ⇒ host-local, exactly as before. That keeps every existing caller
 *  and test meaning what it meant; the production callers pass a zone. */
const zoneLocalFields = (instant: number, timeZone: string | undefined): number[] => {
  if (timeZone === undefined) {
    const d = new Date(instant);
    return [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  }
  // Shift the instant by the zone's offset and read it back with UTC getters:
  // the shifted clock IS the zone's wall clock. Exact, and far cheaper than
  // formatting six fields.
  const shifted = new Date(instant + zoneOffsetMsAt(instant, timeZone));
  return [
    shifted.getUTCMinutes(), shifted.getUTCHours(), shifted.getUTCDate(),
    shifted.getUTCMonth() + 1, shifted.getUTCDay(),
  ];
};

/** Check if a 5-field cron expression matches a given timestamp.
 *  ⚠ `timeZone` absent ⇒ host-local (the pre-D-269 reading). */
export const cronMatchesAt = (
  parts: string[],
  d: Date,
  timeZone?: string,
): boolean => {
  const fields = zoneLocalFields(d.getTime(), timeZone);
  return parts.every((part, i) => cronFieldMatches(part, fields[i]));
};

/** Find the next minute (inclusive) that matches the cron expression,
 *  scanning forward from `startMs`. Returns the timestamp in ms, or
 *  null if no match is found within `maxMinutes` (default 527040 =
 *  366 days — covers all cron patterns including leap years). */
export const nextCronMatch = (
  parts: string[],
  startMs: number,
  maxMinutes = 527_040,
  /** D-269 — the zone the expression is read in. Absent ⇒ host-local. */
  timeZone?: string,
): number | null => {
  // Align to the start of the current minute
  const d = new Date(startMs);
  d.setSeconds(0, 0);
  let ms = d.getTime();

  // ⛔⛔ THE OFFSET MUST BE CACHED, AND A NAIVE PER-DAY CACHE IS WRONG. Measured:
  // one `zoneOffsetMsAt` per scanned minute is **63 SECONDS** over the 527,040
  // iterations this scan allows (patterns like `0 0 29 2 *` reach it), because
  // the offset comes from `Intl` formatting. But caching one offset per UTC day
  // is STALE ACROSS THE TRANSITION DAY ITSELF — the shift lands mid-day, and a
  // 02:30 cron then matched an instant that reads 03:30 locally. My first
  // version did exactly that and a DST test caught it.
  //
  // ⇒ Cache per day, but first ASK WHETHER THE DAY IS UNIFORM: sample the
  // offset at the day's start, middle and end. Agreement means one offset for
  // the whole day (every day but two a year); disagreement drops to per-minute
  // for that day alone — 1,440 calls, exact, and rare enough to cost nothing.
  // A full-year scan is then ~3,600 Intl calls instead of 527,040.
  //
  // ⚠ Three samples cannot PROVE uniformity — a zone shifting twice within one
  // UTC day would fool them. No zone in the tz database does that, and the
  // failure mode if one ever did is bounded: a wrong offset for part of one
  // day, not a wrong rule.
  const DAY_MS = 86_400_000;
  let cachedDay = Number.NaN;
  let dayOffset = 0;
  let dayUniform = false;

  const offsetAt = (at: number, zone: string): number => {
    const day = Math.floor(at / DAY_MS);
    if (day !== cachedDay) {
      const base = day * DAY_MS;
      const a = zoneOffsetMsAt(base, zone);
      const b = zoneOffsetMsAt(base + DAY_MS / 2, zone);
      const c = zoneOffsetMsAt(base + DAY_MS - 60_000, zone);
      cachedDay = day;
      dayUniform = a === b && b === c;
      dayOffset = a;
    }
    return dayUniform ? dayOffset : zoneOffsetMsAt(at, zone);
  };

  for (let i = 0; i < maxMinutes; i++) {
    let fields: number[];
    if (timeZone === undefined) {
      const at = new Date(ms);
      fields = [at.getMinutes(), at.getHours(), at.getDate(), at.getMonth() + 1, at.getDay()];
    } else {
      const shifted = new Date(ms + offsetAt(ms, timeZone));
      fields = [
        shifted.getUTCMinutes(), shifted.getUTCHours(), shifted.getUTCDate(),
        shifted.getUTCMonth() + 1, shifted.getUTCDay(),
      ];
    }
    if (parts.every((part, f) => cronFieldMatches(part, fields[f]))) return ms;
    ms += 60_000; // advance one minute
  }
  return null;
};

/** Compute the minimum interval (in ms) between consecutive firings
 *  of a cron expression. Uses a fixed epoch to avoid calendar-edge
 *  issues. Returns `Infinity` if the expression never fires. */
export const cronIntervalMs = (expr: string): number => {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return Infinity;

  // Start from 2026-01-01T00:00:00Z (Thursday, a normal non-leap year)
  const epoch = Date.UTC(2026, 0, 1, 0, 0, 0);

  const t1 = nextCronMatch(parts, epoch);
  if (t1 === null) return Infinity;

  // Find next match AFTER t1 (start from t1 + 1 minute)
  const t2 = nextCronMatch(parts, t1 + 60_000);
  if (t2 === null) return Infinity;

  return t2 - t1;
};

/** Format the next firing time of a cron expression as a readable
 *  string relative to `now`. Uses local time for consistency with
 *  `cronMatchesAt`. Returns null when the cron is malformed or never
 *  fires — callers hide the preview in that case.
 *
 *  Formats (local time):
 *    Same calendar day: "Today at 6:00 PM"
 *    Next calendar day: "Tomorrow at 9:00 AM"
 *    2-6 days later:    "Friday at 5:00 PM"
 *    7+ days:           "Dec 25 at 9:00 AM"
 *
 *  The choice of "calendar day" vs "within 24 hours" matters: a
 *  preview that says "Tomorrow" but refers to 1:00 AM 5 hours away
 *  is clearer than "in 5 hours" when the user is setting up daily
 *  recurring schedules. */
export const formatNextFire = (expr: string, now: number = Date.now()): string | null => {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const next = nextCronMatch(parts, now);
  if (next === null) return null;

  const nowDate = new Date(now);
  const nextDate = new Date(next);

  // Same calendar day by local time?
  const sameDay = (
    nowDate.getFullYear() === nextDate.getFullYear() &&
    nowDate.getMonth() === nextDate.getMonth() &&
    nowDate.getDate() === nextDate.getDate()
  );

  // "Tomorrow" = next calendar day
  const tomorrow = new Date(nowDate);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = (
    tomorrow.getFullYear() === nextDate.getFullYear() &&
    tomorrow.getMonth() === nextDate.getMonth() &&
    tomorrow.getDate() === nextDate.getDate()
  );

  const h24 = nextDate.getHours();
  const m = nextDate.getMinutes();
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  const time = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;

  if (sameDay) return `Today at ${time}`;
  if (isTomorrow) return `Tomorrow at ${time}`;

  // Within 2-6 days → weekday name
  const daysAway = Math.floor((nextDate.getTime() - nowDate.getTime()) / 86_400_000);
  if (daysAway < 7) {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `${weekdays[nextDate.getDay()]} at ${time}`;
  }

  // Distant → "Mmm DD at H:MM AM/PM"
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[nextDate.getMonth()]} ${nextDate.getDate()} at ${time}`;
};

/** Validate a cron expression against the minimum interval floor.
 *  Returns `{ valid: true }` if the interval is at or above the floor,
 *  or `{ valid: false, error }` with a human-readable message. */
export const validateCronInterval = (
  expr: string,
  floor = MIN_CRON_INTERVAL_MS,
): { valid: boolean; intervalMs: number; error?: string } => {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, intervalMs: 0, error: 'Invalid cron expression — expected 5 fields (minute hour dom month dow)' };
  }

  const interval = cronIntervalMs(expr);
  if (interval === Infinity) {
    return { valid: false, intervalMs: Infinity, error: 'Cron expression never fires' };
  }

  if (interval < floor) {
    const floorMin = Math.round(floor / 60_000);
    const actualMin = Math.round(interval / 60_000);
    return {
      valid: false,
      intervalMs: interval,
      error: `Interval too short: ${actualMin} minute${actualMin !== 1 ? 's' : ''} (minimum is ${floorMin} minutes)`,
    };
  }

  return { valid: true, intervalMs: interval };
};
