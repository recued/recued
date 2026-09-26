/** A date with no time is the day it names, in both formatters.
 *
 *  `new Date('2026-08-01')` is midnight UTC, so a `:date` hint on it showed
 *  Jul 31 to anyone west of UTC (the month-end drive, 2026-09-24). The same
 *  vocabulary is read by two formatters (see `format-hint-epoch-number.test.ts`):
 *  the renderer's `formatValue` for a render section, and `formatHint` here for
 *  a hint inside a transform param, which runs in the SERVER's zone. Both are
 *  fixed; this pins the second. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatHint } from '../resolve.js';

describe('formatHint — a date with no time, west of UTC', () => {
  const zone = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
  afterAll(() => {
    vi.useRealTimers();
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('the zone is west of UTC here, so the old reading was a day early', () => {
    expect(new Date('2026-08-01').getDate()).toBe(31);
  });

  it('⛔ :date shows 2026-08-01 as Aug 1', () => {
    expect(formatHint('2026-08-01', 'date')).toMatch(/Aug 1, 2026/);
  });

  it('⛔ :relative counts it from today\'s calendar day', () => {
    vi.useFakeTimers();
    // 20:00 on Sep 25 in California is 03:00 on Sep 26 in UTC.
    vi.setSystemTime(new Date('2026-09-26T03:00:00Z'));
    expect(formatHint('2026-09-25', 'relative')).toBe('today');
    expect(formatHint('2026-09-24', 'relative')).toBe('yesterday');
    expect(formatHint('2026-09-27', 'relative')).toBe('in 2 days');
    vi.useRealTimers();
  });

  it('an instant keeps its zone', () => {
    expect(formatHint('2026-08-01T00:00:00Z', 'date')).toMatch(/Jul 31, 2026/);
  });
});
