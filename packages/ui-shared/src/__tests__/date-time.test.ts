import { describe, expect, it } from 'vitest';

import { formatClientDateTime } from '../date-time.js';

describe('formatClientDateTime', () => {
  const instant = '2026-07-18T16:00:46.800Z';
  const options = {
    locale: 'en-US',
    timeZone: 'America/Los_Angeles',
  } as const;

  it('renders a friendly instant in the requested client time zone', () => {
    const expected = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
      timeZone: 'America/Los_Angeles',
    }).format(new Date(instant));

    expect(formatClientDateTime(instant, options)).toBe(expected);
    expect(formatClientDateTime(instant, options)).not.toContain('T16:00:46.800Z');
  });

  it('supports quieter displays and explicit empty/invalid copy', () => {
    const quietExpected = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Los_Angeles',
    }).format(new Date(instant));

    expect(formatClientDateTime(new Date(instant), {
      ...options,
      includeSeconds: false,
      includeTimeZone: false,
    })).toBe(quietExpected);
    expect(formatClientDateTime(null, { emptyText: 'Never' })).toBe('Never');
    expect(formatClientDateTime('not-a-date', { invalidText: 'Unknown' })).toBe('Unknown');
  });
});
