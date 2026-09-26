/** D-115 Phase 6 — time-watcher handler.
 *
 *  Pure predicate. Fires when `now` falls inside an optional weekday
 *  set + optional start/end hour range in the runtime's local TZ.
 *
 *  Conventions:
 *    - `weekdays`: subset of {0..7}; 0 = Sunday, and 7 = Sunday too. The
 *      two numberings people use (JavaScript's 0=Sun..6=Sat and ISO 8601's
 *      1=Mon..7=Sun) agree on 1..6 and differ only on Sunday, so accepting
 *      both is unambiguous. 10 shipped recipes tell the owner "1=Mon..7=Sun",
 *      and two defaulted to a 7 that was refused, tripping on their first run.
 *      Empty array ⇒ never matches (empty set semantics).
 *    - `start_hour` / `end_hour`: integers in [0, 24]. 24 is accepted
 *      for the end-bound convenience. Range is half-open [start, end).
 *    - Overnight window: when `start_hour > end_hour` the range wraps
 *      midnight ([start_hour, 24) ∪ [0, end_hour)). Business-hours
 *      authors get 9→17, night-shift authors get 20→8.
 *    - Equal start + end ⇒ zero-length window ⇒ never matches.
 *
 *  No cursor, no state — every tick is a fresh evaluation. Cheap
 *  enough to run unconditionally in a trigger_steps chain as the
 *  "only during business hours" AND-gate.
 *
 *  Lives in `@recued/ingredients` (not `backend/server/`) so both the
 *  server's watcher dispatcher and the extension's runtime watcher
 *  dispatcher can share one source of truth — D-115 Phase 6D. */

import { IngredientError } from '../types.js';

export interface TimeWatcherArgs {
  weekdays?: ReadonlyArray<number>;
  start_hour?: number;
  end_hour?: number;
}

export interface TimeWatcherOutput {
  should_run: boolean;
  [field: string]: unknown;
}

const isInteger = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v);

const validateWeekday = (d: unknown): d is number =>
  isInteger(d) && d >= 0 && d <= 7;

const validateHour = (h: unknown, allow24: boolean): h is number =>
  isInteger(h) && h >= 0 && h <= (allow24 ? 24 : 23);

const validate = (args: TimeWatcherArgs): void => {
  if (args.weekdays !== undefined) {
    if (!Array.isArray(args.weekdays)) {
      throw new IngredientError(
        'TRANSFORM_INVALID_INPUT',
        'time-watcher: weekdays must be an array of integers in [0,7] (0 or 7 = Sunday)',
        { got: args.weekdays },
      );
    }
    for (const d of args.weekdays) {
      if (!validateWeekday(d)) {
        throw new IngredientError(
          'TRANSFORM_INVALID_INPUT',
          'time-watcher: weekday must be an integer in [0,7] (0 or 7 = Sunday)',
          { got: d },
        );
      }
    }
  }
  if (args.start_hour !== undefined && !validateHour(args.start_hour, false)) {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'time-watcher: start_hour must be an integer in [0,23]',
      { got: args.start_hour },
    );
  }
  if (args.end_hour !== undefined && !validateHour(args.end_hour, true)) {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'time-watcher: end_hour must be an integer in [0,24]',
      { got: args.end_hour },
    );
  }
};

const hourInWindow = (hour: number, start: number, end: number): boolean => {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  // Overnight wrap.
  return hour >= start || hour < end;
};

export const evaluateTimeWatcher = (
  args: TimeWatcherArgs,
  now: Date = new Date(),
): TimeWatcherOutput => {
  validate(args);

  if (args.weekdays !== undefined) {
    const day = now.getDay();
    const sunday = day === 0 && args.weekdays.includes(7);
    if (!args.weekdays.includes(day) && !sunday) return { should_run: false };
  }

  const startSet = args.start_hour !== undefined;
  const endSet = args.end_hour !== undefined;
  if (startSet || endSet) {
    const hour = now.getHours();
    const start = args.start_hour ?? 0;
    const end = args.end_hour ?? 24;
    if (!hourInWindow(hour, start, end)) return { should_run: false };
  }

  return { should_run: true };
};
