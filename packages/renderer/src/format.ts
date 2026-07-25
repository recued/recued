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
    if (format === 'date' || format === 'relative') {
      const ms = toRecentMs(value);
      if (ms !== null) {
        return format === 'date' ? formatDate(new Date(ms).toISOString())
          : formatRelative(new Date(ms).toISOString());
      }
    }
    return String(value);
  }
  if (typeof value === 'string') {
    if (format === 'date') return formatDate(value);
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

export const formatDate = (s: string): string => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
};

export const formatRelative = (s: string, now: number = Date.now()): string => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const diffMs = now - d.getTime();
  const days = Math.floor(Math.abs(diffMs) / (24 * 60 * 60 * 1000));
  if (days === 0) return 'today';
  const suffix = diffMs > 0 ? 'ago' : 'from now';
  if (days === 1) return `1 day ${suffix}`;
  if (days < 30) return `${days} days ${suffix}`;
  if (days < 365) return `${Math.floor(days / 30)} months ${suffix}`;
  return `${Math.floor(days / 365)} years ${suffix}`;
};
