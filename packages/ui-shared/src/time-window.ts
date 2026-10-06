/** When a timer recipe REALLY runs (2026-10-05).
 *
 *  A timer recipe checks every N minutes, and 124 shipped ones run only when
 *  their `core.watch.time` gate says so: "weekdays from 8 to 10" checked every
 *  hour runs twice each weekday morning. Saying "Runs every hour" for it was the
 *  wrong time (owner: "is a wrong time use a real time in the message"), and so
 *  was showing the next CHECK as its next run, hours before the window opens.
 *
 *  Pure: the window is read from the recipe's gate with the values the dish
 *  runs with, and judged with the same rule the server's watcher uses
 *  (`isWithinTimeWindow`, contracts) on the server's own clock. */

import { isWithinTimeWindow, wallClockAt, type TimeWindow } from '@recued/contracts';

import {
  GATE_ARG_UNREADABLE,
  gateArgValue,
  gateStepsOf,
  joinWords,
  type TimeWindowSource,
} from './timer-gate-args.js';
import { timerEventClauses } from './timer-events.js';

export type { TimeWindowSource };

/** An interval in words, as "every …" says it: "15 minutes", "hour", "2 days". */
export const intervalInWords = (ms: number): string => {
  const unit = (n: number, one: string): string => (n === 1 ? one : `${n} ${one}s`);
  if (ms < 60_000) return unit(Math.max(1, Math.round(ms / 1000)), 'second');
  if (ms < 3_600_000) return unit(Math.round(ms / 60_000), 'minute');
  if (ms < 86_400_000) return unit(Math.round(ms / 3_600_000), 'hour');
  return unit(Math.round(ms / 86_400_000), 'day');
};

/** What a recipe's time gate says, once its values are read. */
export type RecipeTimeWindow =
  /** No time gate: the timer's interval is when it runs. */
  | { readonly kind: 'none' }
  | { readonly kind: 'window'; readonly window: TimeWindow }
  /** A value the screen cannot read: worked out at run time, or not one the
   *  watcher accepts (the run would be refused). */
  | { readonly kind: 'unreadable' };

const isHour = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

/** The recipe's time window, read with the settings the dish runs with (its
 *  own, over the recipe's defaults). No overlay: the recipe's defaults. */
export const recipeTimeWindow = (
  recipe: TimeWindowSource,
  overlay?: Readonly<Record<string, unknown>>,
): RecipeTimeWindow => {
  const gate = gateStepsOf(recipe).find((step) => step.kind === 'time');
  if (gate === undefined) return { kind: 'none' };
  const weekdays = gateArgValue(gate.args.weekdays, recipe, overlay);
  const start = gateArgValue(gate.args.start_hour, recipe, overlay);
  const end = gateArgValue(gate.args.end_hour, recipe, overlay);
  if (weekdays === GATE_ARG_UNREADABLE || start === GATE_ARG_UNREADABLE || end === GATE_ARG_UNREADABLE) {
    return { kind: 'unreadable' };
  }
  // A missing value is dropped before the watcher sees it: "any day", "any hour".
  const window: { weekdays?: number[]; start_hour?: number; end_hour?: number } = {};
  if (weekdays !== undefined && weekdays !== null) {
    if (!Array.isArray(weekdays) || !weekdays.every((day) => isHour(day, 7))) return { kind: 'unreadable' };
    window.weekdays = [...weekdays] as number[];
  }
  if (start !== undefined && start !== null) {
    if (!isHour(start, 23)) return { kind: 'unreadable' };
    window.start_hour = start;
  }
  if (end !== undefined && end !== null) {
    if (!isHour(end, 24)) return { kind: 'unreadable' };
    window.end_hour = end;
  }
  return { kind: 'window', window };
};

const DAY_PLURALS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** "on weekdays", "on Mondays and Thursdays"; '' for every day; null for none. */
const daysPhrase = (weekdays: readonly number[] | undefined): string | null => {
  if (weekdays === undefined) return '';
  const days = new Set(weekdays.map((day) => (day === 7 ? 0 : day)));
  if (days.size === 0) return null;
  if (days.size === 7) return '';
  const only = (...want: number[]): boolean => days.size === want.length && want.every((day) => days.has(day));
  if (only(1, 2, 3, 4, 5)) return 'on weekdays';
  if (only(0, 6)) return 'on weekends';
  return `on ${joinWords([1, 2, 3, 4, 5, 6, 0].filter((day) => days.has(day)).map((day) => DAY_PLURALS[day]!))}`;
};

const meridiem = (hour: number): 'AM' | 'PM' | null =>
  hour === 0 || hour === 24 ? null : hour < 12 ? 'AM' : 'PM';

const clock = (hour: number, withMeridiem = true): string => {
  if (hour === 0 || hour === 24) return 'midnight';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return withMeridiem ? `${h12}:00 ${meridiem(hour)}` : `${h12}:00`;
};

/** "from 8:00 to 10:00 AM", "between 5:00 PM and midnight". */
const hoursPhrase = (start: number, end: number, words: readonly [string, string]): string => {
  const sameHalf = meridiem(start) !== null && meridiem(start) === meridiem(end);
  return `${words[0]} ${clock(start, !sameHalf)} ${words[1]} ${clock(end)}`;
};

/** When the recipe really runs, as a clause: "runs every 10 minutes from 8:00
 *  to 9:00 AM on weekdays", "runs once between 8:00 and 9:00 AM on weekdays",
 *  "never runs: its time window is empty". */
export const timeWindowRunsPhrase = (intervalMs: number, window: TimeWindow): string => {
  const days = daysPhrase(window.weekdays);
  const hasHours = window.start_hour !== undefined || window.end_hour !== undefined;
  const start = window.start_hour ?? 0;
  const end = window.end_hour ?? 24;
  if (days === null || (hasHours && start === end)) return 'never runs: its time window is empty';
  const widthMs = (hasHours ? (start < end ? end - start : 24 - start + end) : 24) * 3_600_000;
  const onDays = days === '' ? '' : ` ${days}`;
  if (intervalMs < widthMs) {
    const span = hasHours ? ` ${hoursPhrase(start, end, ['from', 'to'])}` : '';
    return `runs every ${intervalInWords(intervalMs)}${span}${onDays}`;
  }
  // A check at most once per window: it runs once in it, or (a longer interval)
  // not on every day the window opens.
  const once = intervalMs === widthMs ? 'once' : 'at most once';
  if (!hasHours) return `runs ${once} a day${onDays}`;
  return `runs ${once} ${hoursPhrase(start, end, ['between', 'and'])}${onDays}`;
};

/** When a timer whose next check is `nextCheckMs` really runs next: the first
 *  check from then on that falls inside the window, read on the server's clock
 *  (`timeZone`; this browser's when unknown). `null` when the window never
 *  opens within the next eight days. */
export const nextRunInTimeWindow = (
  nextCheckMs: number,
  intervalMs: number,
  window: TimeWindow,
  timeZone?: string,
): number | null => {
  if (!Number.isFinite(nextCheckMs)) return null;
  const step = intervalMs > 0 ? intervalMs : 0;
  const limit = nextCheckMs + 8 * 86_400_000;
  let at = nextCheckMs;
  // At most one jump per closed hour, and one step per check inside an open one.
  for (let guard = 0; at <= limit && guard < 10_000; guard += 1) {
    const now = wallClockAt(at, timeZone);
    if (isWithinTimeWindow(window, now)) return at;
    if (step === 0) return null;
    // Every check until the next hour on the server's clock sees the same day
    // and hour, so skip them: to the first check at or after that hour.
    const nextHour = at - (now.minute * 60_000 + (at % 60_000)) + 3_600_000;
    at += Math.max(1, Math.ceil((nextHour - at) / step)) * step;
  }
  return null;
};

/** When a timer recipe really runs, as a clause: "runs every 10 minutes from
 *  8:00 to 9:00 AM on weekdays", "runs 30 minutes before each calendar event
 *  starts, checking every 5 minutes", "runs when an email labelled “urgent”
 *  arrives, checking every minute". Read with the dish's own settings
 *  (`overlay`; absent: the recipe's defaults). */
export const timerRunsPhrase = (
  recipe: TimeWindowSource,
  intervalMs: number,
  overlay?: Readonly<Record<string, unknown>>,
): string => {
  const every = intervalInWords(intervalMs);
  const gate = recipeTimeWindow(recipe, overlay);
  const clock = gate.kind === 'window' ? timeWindowRunsPhrase(intervalMs, gate.window)
    : gate.kind === 'unreadable' ? `checks every ${every} and runs within its set hours`
      : `runs every ${every}`;
  const events = timerEventClauses(recipe, overlay);
  if (events.length === 0 || clock.startsWith('never runs')) return clock;
  // A check finds what the gates wait for: how often it looks is when it
  // notices, so it follows the event.
  const checking = gate.kind === 'window' ? clock.replace(/^runs /, '')
    : gate.kind === 'unreadable' ? `every ${every} within its set hours`
      : `every ${every}`;
  return `runs ${events.join(' and ')}, checking ${checking}`;
};

/** Whether the timer waits for data: its next run is not known in advance. */
export const timerWaitsForData = (
  recipe: TimeWindowSource,
  overlay?: Readonly<Record<string, unknown>>,
): boolean => timerEventClauses(recipe, overlay).length > 0;

/** A timer's next CHECK that can run it: its next check, moved to the first one
 *  inside its window. `recipe` absent (the screen does not know it): the next
 *  check. */
export const timerNextCheck = (
  timer: { readonly next_run_at: number | null; readonly interval_ms: number },
  recipe: TimeWindowSource | undefined,
  overlay?: Readonly<Record<string, unknown>>,
  timeZone?: string,
): number | null => {
  if (timer.next_run_at === null) return null;
  if (recipe === undefined) return timer.next_run_at;
  const gate = recipeTimeWindow(recipe, overlay);
  return gate.kind === 'window'
    ? nextRunInTimeWindow(timer.next_run_at, timer.interval_ms, gate.window, timeZone)
    : timer.next_run_at;
};

/** A timer's next REAL run: its first check inside its window. `null` when it
 *  waits for data (a meeting, an email, a page): what it runs on is not known
 *  in advance, so no time is its next run. `recipe` absent: the next check. */
export const timerNextRun = (
  timer: { readonly next_run_at: number | null; readonly interval_ms: number },
  recipe: TimeWindowSource | undefined,
  overlay?: Readonly<Record<string, unknown>>,
  timeZone?: string,
): number | null =>
  recipe !== undefined && timerWaitsForData(recipe, overlay)
    ? null
    : timerNextCheck(timer, recipe, overlay, timeZone);
