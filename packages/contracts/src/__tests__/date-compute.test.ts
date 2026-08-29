import { describe, expect, it } from 'vitest';

import {
  addDays, addMonths, diffDays, parseCalendarDate, formatCalendarDate,
} from '../date-compute.js';

/** ⛔⛔ THE TABLE IS THE POINT. This is the one intervention from the bench-276/278
 *  work whose correctness does NOT need a live A/B — `2026-12-31 minus 90 days`
 *  has exactly one answer. What it needs instead is the cases, including the
 *  three a live model actually got wrong. */
describe('date arithmetic the models got wrong', () => {
  // Bench 278: notice must be given at least 90 days before the lease end.
  it('90 days before 2026-12-31 is 2026-10-02', () => {
    expect(addDays('2026-12-31', -90)).toBe('2026-10-02');
  });

  // ⛔ THE THREE OBSERVED WRONG ANSWERS, pinned so a regression reproduces the
  // model's mistake rather than merely failing. All three came from models that
  // had read the clause correctly and then miscounted across month boundaries.
  it.each(['2026-11-01', '2026-09-29', '2026-10-01'])(
    'and is NOT %s (an answer a live model gave)',
    (wrong) => { expect(addDays('2026-12-31', -90)).not.toBe(wrong); },
  );

  it('30 days before 2026-12-31 is 2026-12-01 — the superseded figure', () => {
    expect(addDays('2026-12-31', -30)).toBe('2026-12-01');
  });

  it('round-trips: the difference reproduces the offset', () => {
    expect(diffDays('2026-10-02', '2026-12-31')).toBe(90);
    expect(diffDays('2026-12-31', '2026-10-02')).toBe(-90);
  });
});

describe('the boundaries arithmetic gets wrong', () => {
  it('crosses a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
    expect(diffDays('2028-02-01', '2028-03-01')).toBe(29);
  });

  it('crosses a non-leap February', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(diffDays('2026-02-01', '2026-03-01')).toBe(28);
  });

  it('crosses a year boundary in both directions', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('clamps a month add to the last valid day rather than rolling over', () => {
    // ⛔ 31 Jan + 1 month has no 31 February to land on. Clamping is the
    // contract convention; rolling into March is defensible and WRONG here, and
    // a silent choice between them is a wrong date nobody can see.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');   // leap year
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
  });

  it('adding zero is identity, and adding then subtracting returns', () => {
    expect(addDays('2026-06-15', 0)).toBe('2026-06-15');
    expect(addDays(addDays('2026-06-15', 137)!, -137)).toBe('2026-06-15');
  });
});

describe('it refuses a date it cannot mean', () => {
  // ⛔ `Date.UTC(2026, 1, 30)` SILENTLY YIELDS 2 MARCH. A caller who typed
  // 2026-02-30 has a bug, and answering about a different day is how that bug
  // reaches a user as a confident wrong deadline.
  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31'])(
    'rejects %s rather than rolling it',
    (bad) => { expect(parseCalendarDate(bad)).toBeNull(); },
  );

  it.each(['31/12/2026', '2026-12-31T00:00:00Z', 'December 31 2026', '', '2026-1-1'])(
    'rejects the non-ISO form %s',
    (bad) => { expect(parseCalendarDate(bad)).toBeNull(); },
  );

  it('propagates the refusal instead of guessing', () => {
    expect(addDays('2026-02-30', 1)).toBeNull();
    expect(addDays('2026-12-31', 1.5)).toBeNull();
    expect(diffDays('2026-12-31', 'nope')).toBeNull();
  });

  it('formats back to a padded ISO day', () => {
    expect(formatCalendarDate(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01-05');
  });
});
