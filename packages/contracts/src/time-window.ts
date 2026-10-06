/** A `core.watch.time` window: when a timer recipe may run (D-115 Phase 6).
 *
 *  ⛔ ONE RULE, TWO READERS. The server's time watcher decides with it whether a
 *  tick runs the recipe (`packages/ingredients/src/watchers/time.ts`), and the
 *  webclient says with it when the recipe really runs and when it runs next
 *  (`packages/ui-shared/src/time-window.ts`). A timer recipe checks every N
 *  minutes but runs only inside its window, so "Runs every 10 minutes" was the
 *  wrong time for 124 shipped recipes (owner, 2026-10-05: "use a real time in
 *  the message"). Two copies of the rule would let the screen promise a run the
 *  watcher refuses.
 *
 *  The window is read on the server's own wall clock: the zone D-269 resolves
 *  (declared, or the host's), the same clock its cron schedules run on. */

/** The window as the gate declares it, already resolved. */
export interface TimeWindow {
  /** 0 or 7 = Sunday, 1 = Monday … 6 = Saturday. Absent: any day. Empty: never. */
  readonly weekdays?: readonly number[];
  /** Hours 0-23 (end may be 24); the range is half-open [start, end) and wraps
   *  midnight when start > end. Absent: from midnight / until midnight. */
  readonly start_hour?: number;
  readonly end_hour?: number;
}

/** A wall clock reading: the day of the week (0 = Sunday), the hour and the
 *  minute. */
export interface WallClock {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** One formatter per zone: building one is the expensive part, and a screen
 *  reads many instants in the same zone. */
const formatters = new Map<string, Intl.DateTimeFormat | null>();
const formatterFor = (timeZone: string): Intl.DateTimeFormat | null => {
  if (!formatters.has(timeZone)) {
    let made: Intl.DateTimeFormat | null = null;
    try {
      made = new Intl.DateTimeFormat('en-US', {
        timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
      });
    } catch {
      // An unknown zone reads as this process's own, as the watcher did before.
    }
    formatters.set(timeZone, made);
  }
  return formatters.get(timeZone) ?? null;
};

/** The day, hour and minute at `epochMs` in `timeZone` (an IANA zone), or in
 *  this process's own zone when none is given or the zone is unknown. */
export const wallClockAt = (epochMs: number, timeZone?: string): WallClock => {
  const formatter = timeZone === undefined ? null : formatterFor(timeZone);
  if (formatter !== null) {
    const parts = formatter.formatToParts(new Date(epochMs));
    const day = WEEKDAY_INDEX[parts.find((part) => part.type === 'weekday')?.value ?? ''];
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (day !== undefined && Number.isInteger(hour) && Number.isInteger(minute)) {
      return { day, hour: hour % 24, minute };
    }
  }
  const date = new Date(epochMs);
  return { day: date.getDay(), hour: date.getHours(), minute: date.getMinutes() };
};

/** Whether the window holds at this wall clock (its day and hour). */
export const isWithinTimeWindow = (window: TimeWindow, at: Pick<WallClock, 'day' | 'hour'>): boolean => {
  if (window.weekdays !== undefined) {
    const sunday = at.day === 0 && window.weekdays.includes(7);
    if (!window.weekdays.includes(at.day) && !sunday) return false;
  }
  if (window.start_hour !== undefined || window.end_hour !== undefined) {
    const start = window.start_hour ?? 0;
    const end = window.end_hour ?? 24;
    if (start === end) return false;
    const inside = start < end
      ? at.hour >= start && at.hour < end
      // Overnight: [start, 24) ∪ [0, end).
      : at.hour >= start || at.hour < end;
    if (!inside) return false;
  }
  return true;
};
