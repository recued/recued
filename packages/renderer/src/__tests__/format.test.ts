import { describe, it, expect } from 'vitest';
import {
  formatValue,
  formatCurrency,
  formatDate,
  formatRelative,
} from '../format.js';

describe('formatValue', () => {
  it('renders null and undefined as em-dash', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(undefined)).toBe('—');
  });

  it('renders booleans as yes/no', () => {
    expect(formatValue(true)).toBe('yes');
    expect(formatValue(false)).toBe('no');
  });

  it('applies numeric format hints', () => {
    expect(formatValue(50_000, 'currency')).toBe('$50.0K');
    expect(formatValue(2_500_000, 'currency')).toBe('$2.5M');
    expect(formatValue(0.85, 'percent')).toBe('85.0%');
    expect(formatValue(1_234_567, 'number')).toMatch(/1[,.]234[,.]567/);
  });

  it('applies string-date format hints', () => {
    expect(formatValue('2026-01-15T12:00:00Z', 'date')).toMatch(/2026/);
    expect(formatValue('not-a-date', 'date')).toBe('not-a-date');
  });

  it('summarises arrays as "N items"', () => {
    expect(formatValue([1, 2, 3])).toBe('3 items');
    expect(formatValue([])).toBe('0 items');
  });

  it('serialises objects to JSON with a safe fallback', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatValue(cyclic)).toBe('[object]');
  });

  it('returns raw strings unchanged when no hint applies', () => {
    expect(formatValue('hello')).toBe('hello');
  });
});

describe('formatCurrency', () => {
  it('uses $ prefix, K/M scaling', () => {
    expect(formatCurrency(999)).toBe('$999.00');
    expect(formatCurrency(1_500)).toBe('$1.5K');
    expect(formatCurrency(3_200_000)).toBe('$3.2M');
  });

  it('returns em-dash for non-finite values', () => {
    expect(formatCurrency(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatCurrency(Number.NaN)).toBe('—');
  });
});

describe('formatDate', () => {
  it('returns original string when unparseable', () => {
    expect(formatDate('definitely not a date')).toBe('definitely not a date');
  });

  it('formats ISO dates', () => {
    const out = formatDate('2026-04-21T00:00:00Z');
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/Apr/);
  });
});

describe('formatRelative', () => {
  it('honors explicit `now` for deterministic output', () => {
    const now = new Date('2026-04-21T12:00:00Z').getTime();
    expect(formatRelative('2026-04-20T12:00:00Z', now)).toBe('1 day ago');
    expect(formatRelative('2026-04-22T12:00:00Z', now)).toBe('1 day from now');
    expect(formatRelative('2026-04-21T06:00:00Z', now)).toBe('today');
  });

  it('buckets months and years', () => {
    const now = new Date('2026-04-21T12:00:00Z').getTime();
    expect(formatRelative('2026-01-21T12:00:00Z', now)).toMatch(/months ago/);
    expect(formatRelative('2024-04-21T12:00:00Z', now)).toMatch(/years ago/);
  });

  it('returns original string for unparseable input', () => {
    expect(formatRelative('nope')).toBe('nope');
  });
});

describe('formatValue — epoch NUMBERS with a date hint (the 12-recipe bug)', () => {
  // Before: the number branch had no date case, so an epoch fell through to
  // String(value) and the owner saw `1751328000000` at success:true.
  it('formats a warehouse unix-ms epoch instead of printing the integer', () => {
    const out = formatValue(1783935122879, 'date');
    expect(out).not.toBe('1783935122879');
    expect(out).toMatch(/2026/);
  });

  it('formats a Stripe unix-SECONDS epoch (x1000, not 1970)', () => {
    const out = formatValue(1780825854, 'date');
    expect(out).not.toBe('1780825854');
    expect(out).toMatch(/2026/);
    expect(out).not.toMatch(/1970/);
  });

  it('handles :relative on an epoch too', () => {
    expect(formatValue(1783935122879, 'relative')).not.toBe('1783935122879');
  });

  // ZERO REGRESSION: a number that is NOT a recent timestamp keeps the exact
  // pre-existing behaviour (String(value)) — this can only improve a value that
  // renders as a bare integer today, never change one that already worked.
  it('leaves a non-timestamp number exactly as before', () => {
    expect(formatValue(1200, 'date')).toBe('1200');
    expect(formatValue(0, 'date')).toBe('0');
    expect(formatValue(86_400_000, 'date')).toBe('86400000');
  });

  it('does not touch the other number hints', () => {
    expect(formatValue(1783935122879, 'number')).toBe((1783935122879).toLocaleString());
    expect(formatValue(0.5, 'percent')).toBe('50.0%');
  });

  it('still formats an ISO string date (unchanged)', () => {
    expect(formatValue('2026-07-01', 'date')).toMatch(/2026|Jun 30/);
  });
});
