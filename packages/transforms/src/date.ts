import type { TransformFn, DateUnit } from './types.js';
import { toRecentMs } from '@recued/contracts';

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
  if (p.require_offset === true && (typeof raw !== 'string' || !hasTimezoneOffset(raw))) {
    return null;
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

export const date_format: TransformFn = (p) => {
  if (isNonDateValue(p.date)) return null;
  const d = new Date(p.date as string);
  if (isNaN(d.getTime())) return null;
  const fmt = String(p.format ?? 'YYYY-MM-DD');
  const pad = (n: number) => String(n).padStart(2, '0');
  return fmt
    .replace('YYYY', String(d.getFullYear()))
    .replace('MMM', MONTHS[d.getMonth()])
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()))
    .replace('HH', pad(d.getHours()))
    .replace('mm', pad(d.getMinutes()))
    .replace('ss', pad(d.getSeconds()));
};

export const DATE_PERIODS = [
  'today', 'yesterday',
  'this_week', 'last_week',
  'this_month', 'last_month',
  'this_quarter', 'last_quarter',
  'this_year', 'last_year',
  'last_7_days', 'last_30_days', 'last_90_days',
  'next_7_days', 'next_30_days',
] as const;
export type DatePeriod = typeof DATE_PERIODS[number];

/** Named time windows → `{ start, end }` ISO strings. Computed off `ctx.now()`
 *  so scheduled/replayed runs are deterministic.
 *
 *  Weeks use ISO convention (Monday start). All bounds are inclusive and
 *  snapped to day boundaries in UTC — use the output directly with CRM API
 *  date filters (`closed_at >= start AND closed_at <= end`). For "today"
 *  and sliding windows, `end` is 23:59:59.999 so equality filters on the
 *  last day still match.
 *
 *  Returns `null` for unknown period names — the validator's enum catches
 *  this at publish time, but a defensive null lets recipes chain
 *  `skip_when: "{{step.period}} is_null"` if ever needed. */
export const date_period: TransformFn = (p, ctx) => {
  const period = String(p.period);
  const now = ctx.now();

  const startOfDay = (d: Date) => { const r = new Date(d); r.setUTCHours(0, 0, 0, 0); return r; };
  const endOfDay = (d: Date) => { const r = new Date(d); r.setUTCHours(23, 59, 59, 999); return r; };
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DIVISORS.days);
  // ISO week: Monday = 0. JS getUTCDay(): Sun=0..Sat=6 → shift to Mon=0..Sun=6.
  const startOfWeek = (d: Date) => startOfDay(addDays(d, -((d.getUTCDay() + 6) % 7)));
  const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const endOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  const startOfQuarter = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
  const endOfQuarter = (d: Date) => {
    const q = Math.floor(d.getUTCMonth() / 3);
    return new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0, 23, 59, 59, 999));
  };

  let start: Date, end: Date;
  switch (period) {
    case 'today':         start = startOfDay(now); end = endOfDay(now); break;
    case 'yesterday':     start = startOfDay(addDays(now, -1)); end = endOfDay(addDays(now, -1)); break;
    case 'this_week':     start = startOfWeek(now); end = endOfDay(addDays(startOfWeek(now), 6)); break;
    case 'last_week': {
      const sow = startOfWeek(addDays(now, -7));
      start = sow; end = endOfDay(addDays(sow, 6));
      break;
    }
    case 'this_month':    start = startOfMonth(now); end = endOfMonth(now); break;
    case 'last_month': {
      const lm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      start = lm; end = endOfMonth(lm);
      break;
    }
    case 'this_quarter':  start = startOfQuarter(now); end = endOfQuarter(now); break;
    case 'last_quarter': {
      const lq = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
      start = startOfQuarter(lq); end = endOfQuarter(lq);
      break;
    }
    case 'this_year':
      start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      end = new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
      break;
    case 'last_year':
      start = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
      end = new Date(Date.UTC(now.getUTCFullYear() - 1, 11, 31, 23, 59, 59, 999));
      break;
    case 'last_7_days':   start = startOfDay(addDays(now, -6));  end = endOfDay(now); break;
    case 'last_30_days':  start = startOfDay(addDays(now, -29)); end = endOfDay(now); break;
    case 'last_90_days':  start = startOfDay(addDays(now, -89)); end = endOfDay(now); break;
    case 'next_7_days':   start = startOfDay(now); end = endOfDay(addDays(now, 6)); break;
    case 'next_30_days':  start = startOfDay(now); end = endOfDay(addDays(now, 29)); break;
    default: return null;
  }
  return { start: start.toISOString(), end: end.toISOString() };
};
