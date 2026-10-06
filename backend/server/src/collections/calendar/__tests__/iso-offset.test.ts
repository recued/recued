import { describe, expect, it } from 'vitest';

import { formatIsoWithOffset } from '../iso-offset.js';

describe('formatIsoWithOffset', () => {
  it('renders an America/New_York event with a -04:00 offset in summer', () => {
    // 2026-07-01T16:00:00Z → 12:00 in NY DST
    const ms = new Date('2026-07-01T16:00:00Z').getTime();
    expect(formatIsoWithOffset(ms, 'America/New_York')).toBe(
      '2026-07-01T12:00:00-04:00',
    );
  });

  it('renders a UTC event with a Z offset', () => {
    const ms = new Date('2026-04-23T15:00:00Z').getTime();
    expect(formatIsoWithOffset(ms, 'UTC')).toBe('2026-04-23T15:00:00Z');
  });

  it('falls back to UTC for unknown timezones instead of throwing', () => {
    const ms = new Date('2026-04-23T15:00:00Z').getTime();
    expect(formatIsoWithOffset(ms, 'Not/A_Real_Zone')).toBe(
      '2026-04-23T15:00:00Z',
    );
  });
});
