/** An instant as ISO 8601 in a given IANA zone, with its offset
 *  ("2026-04-23T15:00:00-04:00"). Moved out of the calendar watcher when it
 *  was retired (2026-10-05); chat tools say a schedule's next run with it. */

/** Format a unix-ms instant as an ISO 8601 string in the event's own
 *  IANA timezone (e.g. "2026-04-23T15:00:00-04:00"). Uses
 *  `Intl.DateTimeFormat` with `timeZoneName: 'longOffset'` to extract
 *  the offset, then composes the final string so we keep seconds +
 *  offset precision without pulling in a formatting library. */
export const formatIsoWithOffset = (unix_ms: number, timezone: string): string => {
  if (!Number.isFinite(unix_ms)) return '';
  const d = new Date(unix_ms);
  let tz = timezone;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    }).formatToParts(d);
  } catch {
    // Unknown IANA name — fall back to UTC so we still return a
    // parseable string instead of throwing into the caller.
    tz = 'UTC';
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    }).formatToParts(d);
  }
  const pick = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  let hour = pick('hour');
  // Safari sometimes returns "24" for midnight; normalize to "00".
  if (hour === '24') hour = '00';
  const minute = pick('minute');
  const second = pick('second');
  const raw = pick('timeZoneName'); // "GMT-04:00", "GMT", "GMT+05:30"
  let offset = 'Z';
  if (raw !== '' && raw !== 'GMT') {
    const sign = raw.includes('-') ? '-' : '+';
    const m = raw.match(/(\d{1,2}):?(\d{2})?/);
    if (m) {
      const h = m[1].padStart(2, '0');
      const mm = (m[2] ?? '00').padStart(2, '0');
      // +00:00 collapses to "Z" per ISO 8601 convention.
      offset = (sign === '+' && h === '00' && mm === '00') ? 'Z' : `${sign}${h}:${mm}`;
    }
  }
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
};
