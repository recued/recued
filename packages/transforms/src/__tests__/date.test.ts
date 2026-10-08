import { describe, it, expect } from 'vitest';
import { date_diff, date_format, date_add, date_parse, is_past, is_future, date_period } from '../date.js';
import { ctx } from './helpers.js';

// now = 2026-04-08T12:00:00Z
const c = ctx();

describe('date_diff', () => {
  it('calculates days', () => {
    expect(date_diff({ from: '2026-04-01T00:00:00Z', to: '2026-04-08T00:00:00Z', unit: 'days' }, c)).toBe(7);
  });
  it('calculates hours', () => {
    expect(date_diff({ from: '2026-04-08T10:00:00Z', to: '2026-04-08T12:00:00Z', unit: 'hours' }, c)).toBe(2);
  });
  it('uses now', () => {
    expect(date_diff({ from: '2026-04-07T12:00:00Z', to: 'now', unit: 'days' }, c)).toBe(1);
  });
  it('returns null for invalid date', () => {
    expect(date_diff({ from: 'invalid', to: 'now', unit: 'days' }, c)).toBeNull();
  });
});

describe('date_add', () => {
  it('adds days', () => {
    const r = date_add({ date: '2026-04-08T12:00:00Z', amount: 3, unit: 'days' }, c) as string;
    expect(r).toContain('2026-04-11');
  });
  it('subtracts with negative amount', () => {
    const r = date_add({ date: '2026-04-08T12:00:00Z', amount: -2, unit: 'days' }, c) as string;
    expect(r).toContain('2026-04-06');
  });
});

describe('date_parse', () => {
  it('parses valid ISO input into a number', () => {
    const parsed = date_parse({ input: '2026-04-08T00:00:00.000Z' }, c);
    expect(typeof parsed).toBe('number');
    expect(parsed).toBe(Date.UTC(2026, 3, 8));
  });

  it('returns null for invalid', () => expect(date_parse({ input: 'not-a-date' }, c)).toBeNull());

  it('returns null (not the 1970 epoch) for a nullish / empty input', () => {
    // `new Date(null)` is epoch 0 — an absent date must come back null so it is
    // never stamped 1970-01-01 downstream (e.g. an unstated task due_date).
    expect(date_parse({ input: null }, c)).toBeNull();
    expect(date_parse({ input: undefined }, c)).toBeNull();
    expect(date_parse({ input: '' }, c)).toBeNull();
  });

  describe("time_zone (D-315 slice 7 — a wall clock in the owner's zone, not the server's)", () => {
    it('a day, or a time with no offset, is read in the zone named — on either side of UTC', () => {
      expect(date_parse({ input: '2026-10-20T00:00:00', time_zone: 'America/Los_Angeles' }, c)).toBe(Date.UTC(2026, 9, 20, 7));
      expect(date_parse({ input: '2026-10-20', time_zone: 'America/Los_Angeles' }, c)).toBe(Date.UTC(2026, 9, 20, 7));
      expect(date_parse({ input: '2026-10-20T00:00:00', time_zone: 'Pacific/Auckland' }, c)).toBe(Date.UTC(2026, 9, 19, 11));
    });

    it('a value with its own offset keeps it', () => {
      expect(date_parse({ input: '2026-10-20T09:00:00Z', time_zone: 'Asia/Tokyo' }, c)).toBe(Date.UTC(2026, 9, 20, 9));
      expect(date_parse({ input: '2026-10-20T09:00:00-04:00', time_zone: 'Asia/Tokyo' }, c)).toBe(Date.UTC(2026, 9, 20, 13));
    });

    it('an unknown zone, or a wall clock that is not one, is null — never read in another zone', () => {
      expect(date_parse({ input: '2026-10-20T00:00:00', time_zone: 'Mars/Olympus' }, c)).toBeNull();
      expect(date_parse({ input: 'next Tuesday', time_zone: 'America/Los_Angeles' }, c)).toBeNull();
    });

    it('an empty zone — a run with no server — reads as before', () => {
      expect(date_parse({ input: '2026-04-08T00:00:00.000Z', time_zone: '' }, c)).toBe(Date.UTC(2026, 3, 8));
    });
  });

  describe('require_offset (D-193 — reject an ambiguous offset-less instant)', () => {
    it('accepts a Z (UTC) datetime', () => {
      expect(date_parse({ input: '2026-07-04T15:00:00Z', require_offset: true }, c))
        .toBe(Date.UTC(2026, 6, 4, 15));
    });
    it('accepts an ±HH:MM offset', () => {
      expect(date_parse({ input: '2026-07-04T15:00:00-07:00', require_offset: true }, c))
        .toBe(Date.UTC(2026, 6, 4, 22));
    });
    it('accepts an ±HHMM (colon-less) offset', () => {
      expect(date_parse({ input: '2026-07-04T15:00:00+0530', require_offset: true }, c))
        .toBe(Date.UTC(2026, 6, 4, 9, 30));
    });
    it('rejects an offset-less datetime (would parse as server-local)', () => {
      expect(date_parse({ input: '2026-07-04T15:00:00', require_offset: true }, c)).toBeNull();
    });
    it('rejects a date-only value', () => {
      expect(date_parse({ input: '2026-07-04', require_offset: true }, c)).toBeNull();
    });
    it('stays lenient by default (offset-less parses when require_offset is unset)', () => {
      expect(typeof date_parse({ input: '2026-07-04T15:00:00' }, c)).toBe('number');
    });
  });

  it('feeds parsed unix-ms into date_format', () => {
    const parsed = date_parse({ input: '2026-04-08T12:00:00.000Z' }, c);
    expect(date_format({ date: parsed, format: 'YYYY-MM-DD' }, c)).toBe('2026-04-08');
  });

  it('feeds parsed unix-ms into date_diff', () => {
    const parsed = date_parse({ input: '2026-04-08T00:00:00.000Z' }, c);
    expect(date_diff({ from: parsed, to: '2026-04-10T00:00:00.000Z', unit: 'days' }, c)).toBe(2);
  });

  it('returns zero for the unix epoch', () => {
    expect(date_parse({ input: '1970-01-01T00:00:00.000Z' }, c)).toBe(0);
  });

  it('passes through unix-ms number input', () => {
    const ms = Date.UTC(2026, 3, 8, 12);
    expect(date_parse({ input: ms }, c)).toBe(ms);
  });
});

describe('date_format', () => {
  it('formats YYYY-MM-DD', () => {
    expect(date_format({ date: '2026-04-08T12:00:00Z', format: 'YYYY-MM-DD' }, c)).toBe('2026-04-08');
  });
  it('formats MMM DD, YYYY', () => {
    expect(date_format({ date: '2026-04-08T12:00:00Z', format: 'MMM DD, YYYY' }, c)).toBe('Apr 08, 2026');
  });
  it('returns null for invalid', () => expect(date_format({ date: 'bad', format: 'YYYY' }, c)).toBeNull());
});

describe('is_past', () => {
  it('true for past date', () => expect(is_past({ date: '2026-04-01T00:00:00Z' }, c)).toBe(true));
  it('false for future date', () => expect(is_past({ date: '2026-05-01T00:00:00Z' }, c)).toBe(false));
  it('null for invalid', () => expect(is_past({ date: 'bad' }, c)).toBeNull());
});

describe('is_future', () => {
  it('true for future date', () => expect(is_future({ date: '2026-05-01T00:00:00Z' }, c)).toBe(true));
  it('false for past date', () => expect(is_future({ date: '2026-04-01T00:00:00Z' }, c)).toBe(false));
});

// now = 2026-04-08T12:00:00Z (Wednesday; Q2; week of Mon Apr 6 – Sun Apr 12)
describe('date_period', () => {
  const r = (period: string) => date_period({ period }, c) as { start: string; end: string };

  it('today snaps to UTC day bounds', () => {
    const { start, end } = r('today');
    expect(start).toBe('2026-04-08T00:00:00.000Z');
    expect(end).toBe('2026-04-08T23:59:59.999Z');
  });

  it('yesterday', () => {
    const { start, end } = r('yesterday');
    expect(start).toBe('2026-04-07T00:00:00.000Z');
    expect(end).toBe('2026-04-07T23:59:59.999Z');
  });

  it('this_week starts Monday (ISO)', () => {
    const { start, end } = r('this_week');
    expect(start).toBe('2026-04-06T00:00:00.000Z'); // Mon Apr 6
    expect(end).toBe('2026-04-12T23:59:59.999Z');   // Sun Apr 12
  });

  it('last_week', () => {
    const { start, end } = r('last_week');
    expect(start).toBe('2026-03-30T00:00:00.000Z');
    expect(end).toBe('2026-04-05T23:59:59.999Z');
  });

  it('this_month', () => {
    const { start, end } = r('this_month');
    expect(start).toBe('2026-04-01T00:00:00.000Z');
    expect(end).toBe('2026-04-30T23:59:59.999Z');
  });

  it('last_month handles year boundary correctly', () => {
    const { start, end } = r('last_month');
    expect(start).toBe('2026-03-01T00:00:00.000Z');
    expect(end).toBe('2026-03-31T23:59:59.999Z');
  });

  it('this_quarter (Apr→Jun)', () => {
    const { start, end } = r('this_quarter');
    expect(start).toBe('2026-04-01T00:00:00.000Z');
    expect(end).toBe('2026-06-30T23:59:59.999Z');
  });

  it('last_quarter (Jan→Mar)', () => {
    const { start, end } = r('last_quarter');
    expect(start).toBe('2026-01-01T00:00:00.000Z');
    expect(end).toBe('2026-03-31T23:59:59.999Z');
  });

  it('this_year', () => {
    const { start, end } = r('this_year');
    expect(start).toBe('2026-01-01T00:00:00.000Z');
    expect(end).toBe('2026-12-31T23:59:59.999Z');
  });

  it('last_year', () => {
    const { start, end } = r('last_year');
    expect(start).toBe('2025-01-01T00:00:00.000Z');
    expect(end).toBe('2025-12-31T23:59:59.999Z');
  });

  it('last_7_days is inclusive of today', () => {
    const { start, end } = r('last_7_days');
    expect(start).toBe('2026-04-02T00:00:00.000Z');
    expect(end).toBe('2026-04-08T23:59:59.999Z');
  });

  it('last_30_days', () => {
    const { start, end } = r('last_30_days');
    expect(start).toBe('2026-03-10T00:00:00.000Z');
    expect(end).toBe('2026-04-08T23:59:59.999Z');
  });

  it('last_90_days', () => {
    const { start } = r('last_90_days');
    expect(start).toBe('2026-01-09T00:00:00.000Z');
  });

  it('next_7_days starts today', () => {
    const { start, end } = r('next_7_days');
    expect(start).toBe('2026-04-08T00:00:00.000Z');
    expect(end).toBe('2026-04-14T23:59:59.999Z');
  });

  it('next_30_days', () => {
    const { start, end } = r('next_30_days');
    expect(start).toBe('2026-04-08T00:00:00.000Z');
    expect(end).toBe('2026-05-07T23:59:59.999Z');
  });

  it('returns null for unknown period', () => {
    expect(date_period({ period: 'not-a-period' }, c)).toBeNull();
  });
});
