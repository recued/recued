import type { TransformFn, DateUnit } from './types.js';
import {
  allDayEventDays,
  calendarDayMs,
  DAY_MS,
  localDayAsDateOnly,
  toRecentMs,
  zonedWallClockToEpochMs,
  zoneOffsetMsAt,
} from '@recued/contracts';

const DIVISORS: Record<DateUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/** Values that are NOT a date but which `new Date()` turns into a VALID one.
 *
 *  ⛔⛔ `new Date(null)` IS EPOCH 0, NOT AN INVALID DATE — so an `isNaN` guard
 *  passes it straight through and an absent date is silently stamped 1970.
 *  `date_parse` already documents this at length ("an AI-extracted `due_date`
 *  that is null when unstated ... written downstream (task `due_at` etc)") and
 *  guards it. `toDate` and `date_format` did not, so the same absent date was
 *  refused by one transform and rendered as 1970 by its two siblings.
 *
 *  ⚠ BOOLEANS BELONG HERE TOO, and `date_parse`'s own guard missed them:
 *  `new Date(true)` is `1970-01-01T00:00:00.001Z`, so `date_parse(true)`
 *  returned `1`. A boolean is never a date under any reading.
 *
 *  ⚠ `undefined`, `''`, `[]` and `{}` already fall out as Invalid Date and need
 *  no guard — which is the trap: a MISSING field is safe while an explicit
 *  `null` (a vendor JSON null, a SQL NULL) is not, so the failure never shows up
 *  in authoring and appears in production.
 *
 *  ⚠ NUMERIC `0` IS DELIBERATELY NOT HERE. `date_parse(0)` returns `0` today,
 *  treating it as a representable epoch; whether "0 is not a date" is a separate
 *  call from "null is not a date", and making it here would change one
 *  transform's contract under cover of fixing another's. Same for a unix-SECONDS
 *  number, which `new Date()` reads as 1970 while `toRecentMs` normalises — a
 *  real divergence, and a separate one. */
const isNonDateValue = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || typeof v === 'boolean';

const toDate = (v: unknown, ctx: { now: () => Date }): Date | null => {
  if (v === 'now') return ctx.now();
  if (isNonDateValue(v)) return null;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d;
};

/** Normalise a RECENT epoch — unix-ms or unix-SECONDS — to unix-ms, for the
 *  non-render path (feeding date_diff / a comparison / a write). The renderer
 *  does this itself for `:date` / `:relative`, so reach for this only when the
 *  normalised NUMBER is what you need.
 *
 *  Shares ONE decider with the renderer (`toRecentMs`, contracts) so the two can
 *  never drift. Returns **null** — never a guess — when the value is not a
 *  recent timestamp: epoch 0 and 1970-01-02 refuse rather than launder the
 *  `new Date(null)` footgun into a plausible 1972. Gate with `is_null`.
 *
 *  ⚠ It cannot tell you the value IS a timestamp: a duration in ms shares the
 *  numeric range of a 2001–2096 seconds epoch (`window_ms: 2592000000` → 2052).
 *  That assertion is yours. See contracts/recent-date.ts. */
export const to_recent_date: TransformFn = (p) => toRecentMs(p.input);

/** The ms-per-unit for a `unit` the caller may have supplied dynamically, or
 *  null when it is not one of the four.
 *
 *  ⛔ `DIVISORS[bad]` IS `undefined`, AND UNDEFINED POISONS THE ARITHMETIC.
 *  `date_diff` divided by it and returned **NaN**; `date_add` multiplied by it
 *  and threw **`RangeError: Invalid time value`** out of `.toISOString()`. Six
 *  hostile inputs threw and three silently returned the unchanged date — while
 *  every other transform in this file returns null and tells the author to
 *  "Gate with `is_null`". `date_period` states the policy outright: the
 *  validator's enum catches a bad name at publish time, "but a defensive null
 *  lets recipes chain `skip_when`". These two had neither half. */
const divisorFor = (unit: unknown): number | null => {
  if (typeof unit !== 'string') return null;
  const ms = DIVISORS[unit as DateUnit];
  return typeof ms === 'number' ? ms : null;
};

/** A finite number from a value a template may have produced.
 *
 *  ⚠ STRINGS MUST WORK: 37 shipped steps pass `"amount": "{{config.…}}"`, and
 *  a resolved template is a string. ⚠ AND `null` / `''` / `[]` MUST NOT: each
 *  coerces through `Number()` to a valid **0**, so an UNSET config silently
 *  produced "the same date" as though it had worked — the numeric twin of the
 *  `new Date(null)` → 1970 footgun guarded above. An intentional no-op is
 *  `"amount": 0`, which 231 shipped steps already write explicitly. */
const finiteNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export const date_diff: TransformFn = (p, ctx) => {
  const from = toDate(p.from, ctx);
  const to = toDate(p.to, ctx);
  const per = divisorFor(p.unit);
  if (!from || !to || per === null) return null;
  return Math.floor((to.getTime() - from.getTime()) / per);
};

export const date_add: TransformFn = (p, ctx) => {
  const d = toDate(p.date, ctx);
  const per = divisorFor(p.unit);
  const amount = finiteNumber(p.amount);
  if (!d || per === null || amount === null) return null;
  const next = new Date(d.getTime() + amount * per);
  // ⚠ The product can still overflow the Date range (`amount: 1e308`), which
  //   yields an Invalid Date that throws only at `.toISOString()`.
  return Number.isNaN(next.getTime()) ? null : next.toISOString();
};

/** Parses a date input (ISO string, unix-ms number, or any value the
 *  JS `Date` constructor accepts) into unix-ms. Returns null when the
 *  input is unparseable. Matches `Date.parse()` semantics — the
 *  returned ms is the canonical numeric form callers want when
 *  feeding warehouse range filters (`calendar-list.since/until`) or
 *  date-typed work-entity fields (`commitment.promised_for_at`,
 *  `task.due_at`). Downstream transforms that accept either ms or
 *  ISO (`date_format`, `date_diff`, `date_add`, `is_past`,
 *  `is_future`) continue to consume the result transparently. */
/** Detects an explicit timezone designator on an ISO-8601-ish datetime: a
 *  trailing `Z` (UTC) or a `±HH:MM` / `±HHMM` offset. A bare date
 *  (`2026-07-04`) or an offset-less datetime (`2026-07-04T15:00:00`) has
 *  none — `new Date()` parses the latter as SERVER-local, so `require_offset`
 *  callers reject it rather than silently anchoring to the wrong zone. */
const hasTimezoneOffset = (raw: string): boolean =>
  /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim());

/** D-193 — an ABSOLUTE instant a model supplied (a reminder's, a schedule's), as
 *  Unix ms; `null` when it carries no explicit offset or does not parse. One rule
 *  for `date_parse`'s `require_offset` and chat's `recipe.schedule`, so the two
 *  can never disagree about which times they accept. */
export const parseInstantWithOffset = (raw: unknown): number | null => {
  if (isNonDateValue(raw) || typeof raw !== 'string' || !hasTimezoneOffset(raw)) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.getTime();
};

export const date_parse: TransformFn = (p) => {
  // A nullish / empty input is "no date", NOT the Unix epoch. `new Date(null)`
  // coerces to epoch 0 — a VALID date — so without this guard an absent date
  // (e.g. an AI-extracted `due_date` that is null when unstated) would be
  // silently stamped 1970-01-01 and written downstream (task `due_at` etc).
  // `''`/`undefined` already fall out as Invalid below; the `null` case is the
  // footgun this closes.
  if (isNonDateValue(p.input)) return null;
  const raw = p.input as string;
  // D-193 `require_offset` — for an ABSOLUTE instant (an LLM filling a
  // reminder / schedule arg) the string MUST carry an explicit timezone
  // offset; an offset-less value is ambiguous (parsed as server-local), so
  // fail closed to null rather than schedule the wrong instant. Opt-in — the
  // default stays lenient for the many callers parsing already-anchored data.
  if (p.require_offset === true) return parseInstantWithOffset(raw);
  // D-315 slice 7 — a WALL CLOCK (a day, or a time with no offset) read in the
  // zone the recipe names, usually `{{context.server.time_zone}}`, the owner's.
  // Without it `new Date()` reads the SERVER PROCESS's clock: on a server in UTC
  // a date-only stay was booked from the evening before, west of UTC. A value
  // that carries its own offset keeps it. An unknown zone, or a wall clock that
  // is not one, is null — never read in some other zone instead.
  const zone = typeof p.time_zone === 'string' ? p.time_zone.trim() : '';
  if (zone.length > 0 && typeof raw === 'string' && !hasTimezoneOffset(raw)) {
    return zonedWallClockToEpochMs(raw, zone);
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.getTime();
};

export const is_past: TransformFn = (p, ctx) => {
  const d = toDate(p.date, ctx);
  return d ? d.getTime() < ctx.now().getTime() : null;
};

export const is_future: TransformFn = (p, ctx) => {
  const d = toDate(p.date, ctx);
  return d ? d.getTime() > ctx.now().getTime() : null;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The zone a step names in `time_zone`: `''` when it names none, `null` when
 *  it names one the platform does not know — a typo, or a Windows name such as
 *  "Pacific Standard Time". An unknown zone is refused, never replaced by
 *  another clock, as `date_parse` refuses it. */
const zoneParam = (v: unknown): string | null => {
  const zone = typeof v === 'string' ? v.trim() : '';
  if (zone === '') return '';
  return zonedWallClockToEpochMs('2000-01-01', zone) === null ? null : zone;
};

interface WallClock {
  readonly year: number; readonly month: number; readonly day: number;
  readonly hour: number; readonly minute: number; readonly second: number;
}

const utcWallClock = (ms: number): WallClock => {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  };
};

/** The wall clock an instant shows in `zone` — or, when the step names no zone,
 *  on the server process's clock, which is all these transforms read before
 *  they took one (UTC on most servers). */
const wallClockAt = (ms: number, zone: string): WallClock => {
  if (zone !== '') return utcWallClock(ms + zoneOffsetMsAt(ms, zone));
  const d = new Date(ms);
  return {
    year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
    hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
  };
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

const formatWallClock = (c: WallClock, fmt: string): string =>
  fmt
    .replace('YYYY', String(c.year))
    .replace('MMM', MONTHS[c.month - 1])
    .replace('MM', pad2(c.month))
    .replace('DD', pad2(c.day))
    .replace('HH', pad2(c.hour))
    .replace('mm', pad2(c.minute))
    .replace('ss', pad2(c.second));

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

/** 2026-10-07 — `time_zone` formats the instant on the owner's clock. Without
 *  one, `HH:mm` was the server PROCESS's time: on a server in UTC every event a
 *  brief listed was hours off for anyone west or east of it. A date with no
 *  time (`2026-10-07`) names a DAY, not an instant, and is that day in every
 *  zone (as the renderer shows it); `new Date()` read it as UTC midnight and
 *  printed the day before west of UTC. */
export const date_format: TransformFn = (p) => {
  if (isNonDateValue(p.date)) return null;
  const zone = zoneParam(p.time_zone);
  if (zone === null) return null;
  const fmt = String(p.format ?? 'YYYY-MM-DD');
  if (typeof p.date === 'string' && DATE_ONLY.test(p.date.trim())) {
    const day = calendarDayMs(p.date.trim());
    return day === null ? null : formatWallClock(utcWallClock(day), fmt);
  }
  const d = new Date(p.date as string);
  if (isNaN(d.getTime())) return null;
  return formatWallClock(wallClockAt(d.getTime(), zone), fmt);
};

export const DATE_PERIODS = [
  'today', 'yesterday', 'tomorrow',
  'this_week', 'last_week',
  'this_month', 'last_month',
  'this_quarter', 'last_quarter',
  'this_year', 'last_year',
  'last_7_days', 'last_30_days', 'last_90_days',
  'next_7_days', 'next_30_days',
] as const;
export type DatePeriod = typeof DATE_PERIODS[number];

const isoDay = (dayMs: number): string => new Date(dayMs).toISOString().slice(0, 10);

/** Named time windows → `{ start, end }` ISO strings. Computed off `ctx.now()`
 *  so scheduled/replayed runs are deterministic — or off `date`, when the step
 *  names one: `today` is then the day that instant falls on.
 *
 *  Weeks use ISO convention (Monday start). All bounds are inclusive and
 *  snapped to day boundaries — use the output directly with CRM API date
 *  filters (`closed_at >= start AND closed_at <= end`). `end` is the last
 *  millisecond of the last day (23:59:59.999) so equality filters on the last
 *  day still match.
 *
 *  🔑 2026-10-07 — `time_zone` makes the days the owner's: `today` runs from
 *  their local midnight to the next, 23 or 25 hours across a change of clocks.
 *  Without one the days are UTC days, and for an owner in Los Angeles "today"
 *  began at 5 pm the day before: a morning brief listed last evening's events
 *  and missed tonight's. An unknown zone is `null`.
 *
 *  Returns `null` for unknown period names — the validator's enum catches
 *  this at publish time, but a defensive null lets recipes chain
 *  `skip_when: "{{step.period}} is_null"` if ever needed. */
export const date_period: TransformFn = (p, ctx) => {
  const period = String(p.period);
  const zone = zoneParam(p.time_zone);
  if (zone === null) return null;
  // A `date` the step names but that is no date is refused, never read as now.
  const at = Object.prototype.hasOwnProperty.call(p, 'date') ? toDate(p.date, ctx) : ctx.now();
  if (at === null) return null;

  // Days are computed as calendar dates (the UTC midnight that encodes each),
  // then turned into instants on the clock the step names.
  const today = zone === ''
    ? Math.floor(at.getTime() / DAY_MS) * DAY_MS
    : localDayAsDateOnly(at.getTime(), zone);
  const t = new Date(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const days = (n: number): number => today + n * DAY_MS;
  // ISO week: Monday = 0. getUTCDay(): Sun=0..Sat=6 → shift to Mon=0..Sun=6.
  const monday = days(-((t.getUTCDay() + 6) % 7));
  const quarter = Math.floor(m / 3) * 3;

  let first: number, last: number;
  switch (period) {
    case 'today':         first = today; last = today; break;
    case 'yesterday':     first = days(-1); last = days(-1); break;
    case 'tomorrow':      first = days(1); last = days(1); break;
    case 'this_week':     first = monday; last = monday + 6 * DAY_MS; break;
    case 'last_week':     first = monday - 7 * DAY_MS; last = monday - DAY_MS; break;
    case 'this_month':    first = Date.UTC(y, m, 1); last = Date.UTC(y, m + 1, 0); break;
    case 'last_month':    first = Date.UTC(y, m - 1, 1); last = Date.UTC(y, m, 0); break;
    case 'this_quarter':  first = Date.UTC(y, quarter, 1); last = Date.UTC(y, quarter + 3, 0); break;
    case 'last_quarter':  first = Date.UTC(y, quarter - 3, 1); last = Date.UTC(y, quarter, 0); break;
    case 'this_year':     first = Date.UTC(y, 0, 1); last = Date.UTC(y, 11, 31); break;
    case 'last_year':     first = Date.UTC(y - 1, 0, 1); last = Date.UTC(y - 1, 11, 31); break;
    case 'last_7_days':   first = days(-6); last = today; break;
    case 'last_30_days':  first = days(-29); last = today; break;
    case 'last_90_days':  first = days(-89); last = today; break;
    case 'next_7_days':   first = today; last = days(6); break;
    case 'next_30_days':  first = today; last = days(29); break;
    default: return null;
  }
  const midnight = (day: number): number =>
    zone === '' ? day : zonedWallClockToEpochMs(isoDay(day), zone) ?? day;
  return {
    start: new Date(midnight(first)).toISOString(),
    end: new Date(midnight(last + DAY_MS) - 1).toISOString(),
  };
};

/** A number, a numeric string or a date string, as Unix ms; `null` otherwise. */
const instantOf = (v: unknown): number | null => {
  const n = finiteNumber(v);
  if (n !== null) return n;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

const ymd = (c: WallClock): string => `${c.year}-${pad2(c.month)}-${pad2(c.day)}`;
const hm = (c: WallClock): string => `${pad2(c.hour)}:${pad2(c.minute)}`;

/** WHEN A CALENDAR EVENT HAPPENS, ON THE OWNER'S CLOCK (2026-10-07).
 *
 *  ⛔ A recipe that formatted an event's `start_at` itself got two things
 *  wrong. The time was the server process's (`date_format` had no zone), and an
 *  all-day event — stored as the UTC midnight of its day (`calendar-days.ts`) —
 *  showed as "00:00", or "17:00 the day before" west of UTC. `map` cannot
 *  branch per row, so no recipe could tell the two kinds apart.
 *
 *  Takes the event (`start_at`, `end_at`, `is_all_day` — a calendar row, a
 *  `calendar-get` record, a watcher's `hot_fields`) and `time_zone`, usually
 *  `{{context.server.time_zone}}`. Returns:
 *  - `start` / `end` — Unix ms; an all-day event from the local midnight of its
 *    first day to the one after its last, for windows and overlaps;
 *  - `day` — the local day it starts on, `YYYY-MM-DD` (an all-day event: its first);
 *  - `time` — `10:00`, or `All day`: the start in a list of one day;
 *  - `date_time` — `2026-10-15 10:00`, or `2026-12-24, all day` /
 *    `2026-12-24 – 2026-12-26, all day`;
 *  - `text` — `2026-10-15 10:00–11:00` (`… 23:00 – 2026-10-16 01:00` across
 *    midnight), or as `date_time` for an all-day event.
 *
 *  `part` names one of those to return alone: a `map` writes `part: "time"`
 *  to `output_field: "starts_text"` and the table column stays a plain field
 *  (a column may also read the path, `when.time`).
 *
 *  `null` when the event has no start, or the zone is unknown. With no zone,
 *  times are on the server process's clock, as `date_format`'s are. In `map`,
 *  `apply: "event_when"` with no `field` hands it each whole row. */
export const EVENT_WHEN_PARTS = ['start', 'end', 'day', 'time', 'date_time', 'text'] as const;

export const event_when: TransformFn = (p) => {
  const when = eventWhen(p);
  if (when === null || p.part === undefined) return when;
  return (EVENT_WHEN_PARTS as readonly unknown[]).includes(p.part) ? when[p.part as typeof EVENT_WHEN_PARTS[number]] : null;
};

const eventWhen = (p: Record<string, unknown>): {
  start: number; end: number; day: string; time: string; date_time: string; text: string;
} | null => {
  const event = p.event;
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
  const e = event as Record<string, unknown>;
  const start_at = instantOf(e.start_at);
  if (start_at === null) return null;
  const end_at = instantOf(e.end_at) ?? start_at;
  const zone = zoneParam(p.time_zone);
  if (zone === null) return null;

  if (e.is_all_day === true || e.is_all_day === 1 || e.is_all_day === 'true') {
    const { first, last } = allDayEventDays({ start_at, end_at });
    const midnight = (day: string): number => {
      if (zone !== '') return zonedWallClockToEpochMs(day, zone) ?? Date.parse(`${day}T00:00:00Z`);
      const [yy, mm, dd] = day.split('-').map(Number);
      return new Date(yy!, mm! - 1, dd!).getTime();
    };
    const days = first === last ? first : `${first} – ${last}`;
    return {
      start: midnight(first),
      end: midnight(isoDay(Date.parse(`${last}T00:00:00Z`) + DAY_MS)),
      day: first,
      time: 'All day',
      date_time: `${days}, all day`,
      text: `${days}, all day`,
    };
  }

  const starts = wallClockAt(start_at, zone);
  const ends = wallClockAt(end_at, zone);
  const day = ymd(starts);
  const date_time = `${day} ${hm(starts)}`;
  const text = end_at <= start_at ? date_time
    : ymd(ends) === day ? `${date_time}–${hm(ends)}`
      : `${date_time} – ${ymd(ends)} ${hm(ends)}`;
  return { start: start_at, end: end_at, day, time: hm(starts), date_time, text };
};
