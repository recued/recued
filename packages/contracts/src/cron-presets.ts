/** Cron preset catalog + display formatters.
 *
 *  Lives in contracts (not `@recued/scheduler`) because these are
 *  pure display-layer pieces every SURFACE needs — the webclient's
 *  per-recipe schedule picker, the extension options page, the
 *  Automation governance view — while `@recued/scheduler` is engine
 *  code the D-148 P12 role boundary bans from clients (apps/webclient
 *  renders and asks; the server runs). `@recued/scheduler` re-exports
 *  these for its existing engine-side consumers.
 */

/** Presets for common cron expressions, grouped by frequency. */
export const CRON_PRESETS: Array<{ label: string; expression: string; group: string }> = [
  // Minutes
  { label: 'Every 5 minutes', expression: '*/5 * * * *', group: 'Frequent' },
  { label: 'Every 10 minutes', expression: '*/10 * * * *', group: 'Frequent' },
  { label: 'Every 15 minutes', expression: '*/15 * * * *', group: 'Frequent' },
  { label: 'Every 30 minutes', expression: '*/30 * * * *', group: 'Frequent' },
  // Hours
  { label: 'Every hour', expression: '0 * * * *', group: 'Hourly' },
  { label: 'Every 2 hours', expression: '0 */2 * * *', group: 'Hourly' },
  { label: 'Every 4 hours', expression: '0 */4 * * *', group: 'Hourly' },
  { label: 'Every 6 hours', expression: '0 */6 * * *', group: 'Hourly' },
  // Daily
  { label: 'Daily at 7:00 AM', expression: '0 7 * * *', group: 'Daily' },
  { label: 'Daily at 8:00 AM', expression: '0 8 * * *', group: 'Daily' },
  { label: 'Daily at 9:00 AM', expression: '0 9 * * *', group: 'Daily' },
  { label: 'Daily at 12:00 PM', expression: '0 12 * * *', group: 'Daily' },
  { label: 'Daily at 5:00 PM', expression: '0 17 * * *', group: 'Daily' },
  { label: 'Daily at 9:00 PM', expression: '0 21 * * *', group: 'Daily' },
  // Twice daily
  { label: 'Twice daily (9 AM & 5 PM)', expression: '0 9,17 * * *', group: 'Daily' },
  { label: 'Twice daily (8 AM & 6 PM)', expression: '0 8,18 * * *', group: 'Daily' },
  // Weekdays
  { label: 'Weekdays at 8:00 AM', expression: '0 8 * * 1-5', group: 'Weekdays' },
  { label: 'Weekdays at 9:00 AM', expression: '0 9 * * 1-5', group: 'Weekdays' },
  { label: 'Weekdays at 5:00 PM', expression: '0 17 * * 1-5', group: 'Weekdays' },
  { label: 'Weekdays 9 AM & 5 PM', expression: '0 9,17 * * 1-5', group: 'Weekdays' },
  // Weekly
  { label: 'Weekly Monday 9:00 AM', expression: '0 9 * * 1', group: 'Weekly' },
  { label: 'Weekly Friday 5:00 PM', expression: '0 17 * * 5', group: 'Weekly' },
  { label: 'Weekends Saturday 10:00 AM', expression: '0 10 * * 6', group: 'Weekly' },
  // Monthly
  //
  // ⛔ There is no "last day" or "last weekday" preset, and one must not be
  // added: `cronMatchesAt` implements standard 5-field cron (`*`, `*/n`,
  // ranges, comma lists) with no `L` / `LW` / `#` extensions, so neither is
  // expressible. This slot previously held `Last weekday 5:00 PM` carrying
  // `0 17 * * 5` — byte-identical to `Weekly Friday 5:00 PM` above, so it
  // fired every Friday. `describeCron` matches presets by expression and
  // returns the FIRST hit, so anyone who picked it was already shown
  // "Weekly Friday 5:00 PM"; the label was the only thing claiming monthly.
  // 28 is the last day-of-month that exists in every month, February
  // included — a higher number silently skips the short ones.
  { label: '1st of month at 9:00 AM', expression: '0 9 1 * *', group: 'Monthly' },
  { label: '15th of month at 9:00 AM', expression: '0 9 15 * *', group: 'Monthly' },
  { label: '28th of month at 5:00 PM', expression: '0 17 28 * *', group: 'Monthly' },
];

/** Build a cron expression from interval picker selections. */
export const buildCronFromInterval = (
  interval: 'daily' | 'weekly' | 'biweekly' | 'monthly',
  day: string,
  hour: string,
  minute: string,
): string => {
  const m = minute || '0';
  const h = hour || '9';
  switch (interval) {
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly':
      return `${m} ${h} * * ${day || '1'}`;
    case 'biweekly':
      // Cron doesn't support biweekly natively — use 1st and 3rd week via day-of-month
      return `${m} ${h} 1-7,15-21 * ${day || '1'}`;
    case 'monthly':
      return `${m} ${h} ${day || '1'} * *`;
  }
};

const DAY_NAMES: Record<string, string> = {
  '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday',
  '4': 'Thursday', '5': 'Friday', '6': 'Saturday', '7': 'Sunday',
};

const formatTime12 = (hour: number, min: string): string => {
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const m = min.padStart(2, '0');
  return `${h12}:${m} ${ampm}`;
};

/** English ordinal for a day-of-month. The teens are the exception that a
 *  bare `n % 10` lookup gets wrong — 11/12/13 take "th", not "st"/"nd"/"rd"
 *  — and every month reaches them. */
const ordinal = (n: number): string => {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

const describeDow = (dow: string): string => {
  if (dow === '*') return 'Daily';
  if (dow === '1-5') return 'Weekdays';
  if (dow === '0,6' || dow === '6,0') return 'Weekends';
  if (DAY_NAMES[dow]) return DAY_NAMES[dow];
  return `Days ${dow}`;
};

/** Human-readable label for a cron expression. */
export const describeCron = (expr: string): string => {
  const preset = CRON_PRESETS.find((p) => p.expression === expr);
  if (preset) return preset.label;

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  // Step patterns: */N
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*') {
    return `Every ${min.slice(2)} minutes`;
  }
  if (min === '0' && hour.startsWith('*/') && dom === '*' && mon === '*') {
    return `Every ${hour.slice(2)} hours`;
  }

  // Fixed time patterns
  if (mon === '*') {
    // A day-of-month field is not always a bare number — `buildCronFromInterval`
    // emits `1-7,15-21` for biweekly — so the ordinal applies only when it IS
    // one. Anything else is named as the day set it is.
    const domPart = dom === '*' ? ''
      : /^\d+$/.test(dom) ? `${ordinal(Number(dom))} of month `
      : `days ${dom} of month `;
    // "15th of month Daily" contradicts itself: a day-of-month already says how
    // often this fires, so the `*` day-of-week adds nothing. A REAL day-of-week
    // alongside one still matters and is kept.
    const dowPart = dom !== '*' && dow === '*' ? '' : `${describeDow(dow)} `;

    // Single hour: "30 7 * * *" → "Daily at 7:30 AM"
    if (/^\d+$/.test(hour) && /^\d+$/.test(min)) {
      const h = parseInt(hour, 10);
      const time = formatTime12(h, min.padStart(2, '0'));
      return `${domPart}${dowPart}at ${time}`;
    }

    // Multiple hours: "0 9,17 * * *" → "Daily at 9:00 AM & 5:00 PM"
    if (/^\d+(,\d+)+$/.test(hour) && /^\d+$/.test(min)) {
      const hours = hour.split(',').map((h) => formatTime12(parseInt(h, 10), min));
      return `${domPart}${dowPart}at ${hours.join(' & ')}`;
    }
  }

  return expr;
};
