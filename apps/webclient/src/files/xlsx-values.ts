/** OOXML strings escape control characters, and escape a literal escape's
 * underscore. One pass preserves that literal rather than decoding it twice. */
export const xlsxString = (value: string): string => value.replace(/_x([\da-f]{4})_/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));

const builtinFormats = new Map<number, string>([
  [0, 'General'], [1, '0'], [2, '0.00'], [3, '#,##0'], [4, '#,##0.00'], [9, '0%'], [10, '0.00%'],
  [14, 'mm-dd-yy'], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'], [18, 'h:mm AM/PM'], [19, 'h:mm:ss AM/PM'],
  [20, 'h:mm'], [21, 'h:mm:ss'], [22, 'm/d/yy h:mm'], [45, 'mm:ss'], [46, '[h]:mm:ss'], [47, 'mmss.0'],
]);
// Supported numeric tokens have only 44 combinations of grouping, precision
// and percent display. Reuse their immutable formatters across worksheet cells.
const numberFormats = new Map<string, Intl.NumberFormat>();
export const xlsxBuiltinFormat = (id: number): string => builtinFormats.get(id) ?? 'unsupported';

/** Strip display-only literals without treating their semicolons as sections.
 * Conditional and multi-section formats need a fuller formatter; leave their
 * stored value alone rather than choosing a section that changes its meaning. */
const formatTokens = (format: string): string | undefined => {
  let tokens = '', quoted = false;
  for (let index = 0; index < format.length; index++) {
    const char = format[index]!;
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (['\\', '_', '*'].includes(char)) { if (++index >= format.length) return; continue; }
    if (char === ';') return;
    if (char === '[') {
      const end = format.indexOf(']', index + 1);
      if (end === -1) return;
      const tag = format.slice(index + 1, end);
      if (/^(?:h{1,2}|m{1,2}|s{1,2})$/i.test(tag)) tokens += `[${tag}]`;
      else if (!/^(?:Black|Blue|Cyan|Green|Magenta|Red|White|Yellow|Color\d+|\$-[\w-]+)$/i.test(tag)) return;
      index = end; continue;
    }
    tokens += char;
  }
  return quoted ? undefined : tokens.trim();
};

/** Common display formats only. Dates use an unambiguous, zone-free ISO date;
 * unsupported formats retain the original number instead of guessing. */
export const formatXlsxNumber = (raw: string, format: string, date1904: boolean): string => {
  const value = Number(raw);
  if (!Number.isFinite(value) || !format || format === 'General' || format === 'unsupported') return raw;
  const tokens = formatTokens(format);
  if (!tokens) return raw;
  const elapsed = /\[([hms])\1?\]/i.exec(tokens)?.[1]?.toLowerCase();
  const time = /[hs]/i.test(tokens) || elapsed !== undefined, date = /[yd]/i.test(tokens) || /m/i.test(tokens) && !time;
  if (date || time) {
    const dateTokens = tokens.replace(/AM\/PM|A\/P|\[[hms]+\]/gi, '');
    if (/[^\symdhs/:.,\-]/i.test(dateTokens)) return raw;
    const lastDay = date1904 ? 2_957_003 : 2_958_465;
    if (value < 0 || value >= lastDay + 1) return raw;
    const seconds = Math.round(value * 86400), day = date && !time ? Math.floor(value) : Math.floor(seconds / 86400), part = seconds % 86400;
    if (day > lastDay) return raw;
    const pad = (n: number) => String(n).padStart(2, '0');
    if (!date && elapsed === 's') return String(seconds);
    if (!date && elapsed === 'm') return `${Math.floor(seconds / 60)}${/s/i.test(tokens) ? `:${pad(part % 60)}` : ''}`;
    const clock = elapsed === 'h' ? `${Math.floor(seconds / 3600)}${/m/i.test(tokens) ? `:${pad(Math.floor(part / 60) % 60)}` : ''}${/s/i.test(tokens) ? `:${pad(part % 60)}` : ''}`
      : `${pad(Math.floor(part / 3600))}:${pad(Math.floor(part / 60) % 60)}${/s/i.test(tokens) ? `:${pad(part % 60)}` : ''}`;
    if (!date) return clock;
    // Excel's 1900 date system retains the fictional 1900-02-29 at serial 60.
    const text = !date1904 && day === 60 ? '1900-02-29'
      : new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31)
        + (day - (!date1904 && day > 60 ? 1 : 0)) * 86400000).toISOString().slice(0, 10);
    return time ? `${text} ${clock}` : text;
  }
  if (/^(?:#,##)?0(?:\.0{1,10})?%?$/.test(tokens) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
    let formatter = numberFormats.get(tokens);
    if (!formatter) {
      const decimals = /\.(0+)/.exec(tokens)?.[1]?.length ?? 0;
      formatter = new Intl.NumberFormat('en-US', { useGrouping: tokens.includes(','), minimumFractionDigits: decimals,
        maximumFractionDigits: decimals, style: tokens.endsWith('%') ? 'percent' : 'decimal' });
      numberFormats.set(tokens, formatter);
    }
    return formatter.format(value);
  }
  return raw;
};
