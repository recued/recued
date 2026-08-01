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
