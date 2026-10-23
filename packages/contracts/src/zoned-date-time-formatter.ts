/** Reuse Intl setup for fixed options while formatting every instant afresh.
 * Each caller retains at most 32 zones. An omitted runtime zone stays uncached
 * because its meaning follows the host timezone. Invalid zones still throw. */
export const createZonedDateTimeFormatter = (options: Intl.DateTimeFormatOptions) => {
  const fixed = { ...options };
  const formatters = new Map<string, Intl.DateTimeFormat>();
  let constructor: typeof Intl.DateTimeFormat | undefined;
  return (timeZone: string): Intl.DateTimeFormat => {
    const current = Intl.DateTimeFormat;
    if (current !== constructor) { formatters.clear(); constructor = current; }
    if (typeof timeZone !== 'string') return new current('en-US', { ...fixed, timeZone });
    const cached = formatters.get(timeZone);
    if (cached) {
      formatters.delete(timeZone); formatters.set(timeZone, cached);
      return cached;
    }
    const formatter = new current('en-US', { ...fixed, timeZone });
    if (formatters.size === 32) formatters.delete(formatters.keys().next().value!);
    formatters.set(timeZone, formatter);
    return formatter;
  };
};
