import { toRecentMs } from '@recued/contracts';

/** Value formatting for display. Takes a raw value + optional format
 *  hint (`currency`, `percent`, `number`, `date`, `relative`), returns
 *  a plain string. Never returns HTML — callers must `escapeHtml` the
 *  result before interpolation.
 *
 *  The hint comes from the recipe schema's `{{ref:format}}` syntax.
 *  Pure references (no hint) return a reasonable default for each
 *  type: `—` for null/undefined, `yes/no` for boolean, JSON for
 *  objects, `N items` for arrays.
 */

export const formatValue = (value: unknown, format?: string): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    if (format === 'currency') return formatCurrency(value);
    if (format === 'percent') return `${(value * 100).toFixed(1)}%`;
    if (format === 'number') return value.toLocaleString();
    // A date hint on an epoch NUMBER used to fall through to String(value) and
    // print the raw integer — `1751328000000` where a date belonged, at
    // success:true, invisible to every gate (12 recipes shipped that way).
    // `toRecentMs` decides ms-vs-seconds from disjoint bounded ranges, so this
    // never guesses; a number outside both ranges is NOT a recent timestamp and
    // falls through to the pre-existing String(value) — ZERO regression, this
    // can only improve a value that renders as a bare integer today.
    if (format === 'date' || format === 'datetime' || format === 'relative') {
      const ms = toRecentMs(value);
      if (ms !== null) {
        const iso = new Date(ms).toISOString();
        if (format === 'date') return formatDate(iso);
        if (format === 'datetime') return formatDateTime(iso);
        return formatRelative(iso);
      }
    }
    return String(value);
  }
  if (typeof value === 'string') {
    if (format === 'date') return formatDate(value);
    if (format === 'datetime') return formatDateTime(value);
    if (format === 'relative') return formatRelative(value);
    return value;
  }
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  return String(value);
};

export const formatCurrency = (n: number): string => {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
};

/** A date with no time, `2026-08-01`, names a calendar DAY, not an instant.
 *  `new Date('2026-08-01')` reads it as midnight UTC, and showing that in the
 *  viewer's zone put every such date a day early west of UTC: Jul 31 for
 *  2026-08-01 (the month-end drive, 2026-09-24). Shown in UTC, it stays the
 *  day it names in every zone. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const isDateOnly = (s: string): boolean => DATE_ONLY.test(s.trim());

/** Today in the viewer's zone, as the midnight UTC a date-only value parses
 *  to, so the two compare as calendar days. */
const todayAsDateOnly = (now: number): number => {
  const today = new Date(now);
  return Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
};

export const formatDate = (s: string): string => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    ...(isDateOnly(s) ? { timeZone: 'UTC' } : {}),
  });
};

/** Day AND time. `formatDate` is day-only by design and every shipped `table`
 *  column with `format: "date"` depends on that, so a datetime needs its own
 *  hint rather than a change to the shared one.
 *
 *  ⛔ Found live: a Cal.com booking rendered "Aug 3, 2026" through the date
 *  path, dropping 16:00 — the single fact a person reading an appointment needs
 *  most. A fixture cannot catch this; it renders exactly as wrongly and looks
 *  fine. */
export const formatDateTime = (s: string): string => {
  // A date with no time has no time to show: a midnight would be invented.
  if (isDateOnly(s)) return formatDate(s);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

export const formatRelative = (s: string, now: number = Date.now()): string => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  // A calendar day is counted from the viewer's today, not from this instant.
  const diffMs = (isDateOnly(s) ? todayAsDateOnly(now) : now) - d.getTime();
  const days = Math.floor(Math.abs(diffMs) / (24 * 60 * 60 * 1000));
  if (days === 0) return 'today';
  const suffix = diffMs > 0 ? 'ago' : 'from now';
  if (days === 1) return `1 day ${suffix}`;
  if (days < 30) return `${days} days ${suffix}`;
  if (days < 365) return `${Math.floor(days / 30)} months ${suffix}`;
  return `${Math.floor(days / 365)} years ${suffix}`;
};
