/** Values accepted by the shared human-facing client date/time formatter. */
export type ClientDateTimeValue = number | string | Date | null | undefined;

export interface ClientDateTimeOptions {
  /** Browser locale by default. Primarily exposed for deterministic tests. */
  locale?: string | string[];
  /** Browser time zone by default. Primarily exposed for deterministic tests. */
  timeZone?: string;
  /** Logs benefit from seconds; calmer surfaces may opt out. Defaults to true. */
  includeSeconds?: boolean;
  /** Make the viewer's zone explicit. Defaults to true. */
  includeTimeZone?: boolean;
  /** Copy for null / undefined values. */
  emptyText?: string;
  /** Copy for values that cannot be parsed as an instant. */
  invalidText?: string;
}

/**
 * Format an instant for the viewer, using their browser locale and time zone.
 *
 * This is deliberately for visible UI copy. Machine values (RPC payloads,
 * `<time datetime>`, date inputs, persisted state) should remain canonical ISO.
 */
export const formatClientDateTime = (
  value: ClientDateTimeValue,
  options: ClientDateTimeOptions = {},
): string => {
  if (value === null || value === undefined) return options.emptyText ?? '—';

  const date = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === 'number'
      ? new Date(value)
      : new Date(value);
  if (Number.isNaN(date.getTime())) return options.invalidText ?? 'Unknown time';

  const formatOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(options.includeSeconds === false ? {} : { second: '2-digit' }),
    ...(options.includeTimeZone === false ? {} : { timeZoneName: 'short' }),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  };

  try {
    return new Intl.DateTimeFormat(options.locale, formatOptions).format(date);
  } catch {
    // Minimal-ICU browsers still get a readable local value. This also avoids
    // letting a display-only formatter make a route fail to render.
    try {
      return date.toLocaleString();
    } catch {
      return options.invalidText ?? 'Unknown time';
    }
  }
};

/** D-266 — how late a schedule's CURRENT occurrence is, in ms, or null
 *  when it is not late (or cannot be told).
 *
 *  🔑 `next_run_at` IS THE EXPECTED SLOT, WHICH IS WHY THIS NEEDS NO
 *  ENGINE CODE AND NO NEW WIRE FIELD. The server sets it at every fire
 *  to the first cron match strictly after that fire, and touches it
 *  nowhere else — driven through a whole miss lifecycle: a 30-day
 *  outage, an `Ask me` tick, and an answered skip all leave it pointing
 *  at the slot that was missed; only a real fire moves it past `now`.
 *  So "late" is simply a slot in the past.
 *
 *  ⛔ DO NOT COMPUTE THIS AS `now - (last_run_at + one interval)`. There
 *  is no honest single interval: driven, a weekday cron (`0 8 * * 1-5`)
 *  that ran Friday and is checked Monday 08:29 is **29 minutes** late by
 *  the cron and **2909 minutes** late by "+1 day", because one day past
 *  Friday is a Saturday the schedule never runs on. Sampling the
 *  interval from two run times is worse still — that pair spans any
 *  outage. The cron already answered this at fire time; read its answer.
 *
 *  ⚠ Returns null for a PAUSED schedule's caller to decide on: a paused
 *  schedule keeps its `next_run_at`, and calling it "late" would blame
 *  the owner for a pause they chose. Callers pass `enabled` explicitly
 *  rather than having that read off a timestamp. */
export const scheduleLatenessMs = (
  nextRunAt: number | null | undefined,
  now: number,
  enabled: boolean,
): number | null => {
  if (!enabled || typeof nextRunAt !== 'number' || !Number.isFinite(nextRunAt)) {
    return null;
  }
  const late = now - nextRunAt;
  return late > 0 ? late : null;
};

/** "29 min late" / "3 h late" / "2 d late" — coarse on purpose: the
 *  owner is judging whether a schedule is drifting or broken, and
 *  seconds never change that answer. */
export const formatLateness = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min late`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h late`;
  return `${Math.floor(hours / 24)} d late`;
};
