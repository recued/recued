/** D-324 — a reminder's time, said the same way everywhere: the day in words and
 *  the time on the owner's clock, never UTC (P8). */

import { describe, expect, it } from 'vitest';

import {
  REMINDER_LATE_MS,
  formatReminderAt,
  formatReminderDay,
  formatReminderTime,
  formatReminderWhen,
  reminderDeliveryText,
} from '../reminder.js';

const NY = 'America/New_York';
/** Thursday 15 October 2026, 10:00 in New York (EDT, UTC-4). */
const NOW = Date.UTC(2026, 9, 15, 14, 0);
/** Friday 16 October 2026, 15:00 in New York. */
const FRIDAY_3PM = Date.UTC(2026, 9, 16, 19, 0);

describe('formatReminderWhen', () => {
  it('says the day in words and the time on the owner’s clock', () => {
    expect(formatReminderWhen(FRIDAY_3PM, NY, NOW)).toBe('Friday 16 October at 3:00 PM');
    expect(formatReminderTime(FRIDAY_3PM, NY)).toBe('3:00 PM');
    // The same instant on another clock is another day and time.
    expect(formatReminderWhen(FRIDAY_3PM, 'Asia/Tokyo', NOW)).toBe('Saturday 17 October at 4:00 AM');
  });

  it('adds the year only when it is not this year’s, on the same clock', () => {
    expect(formatReminderWhen(Date.UTC(2027, 0, 4, 14, 30), NY, NOW)).toBe('Monday 4 January 2027 at 9:30 AM');
    // New Year's Eve evening in New York is already next year in UTC.
    const eve = Date.UTC(2027, 0, 1, 3, 0);
    expect(formatReminderWhen(eve, NY, Date.UTC(2026, 11, 31, 12, 0))).toBe('Thursday 31 December at 10:00 PM');
  });

  it('keeps the wall clock across a change of the clocks', () => {
    // The US leaves summer time on 1 November 2026.
    expect(formatReminderWhen(Date.UTC(2026, 10, 2, 14, 0), NY, NOW)).toBe('Monday 2 November at 9:00 AM');
  });

  it('words midnight and noon as people say them', () => {
    expect(formatReminderTime(Date.UTC(2026, 9, 16, 4, 0), NY)).toBe('12:00 AM');
    expect(formatReminderTime(Date.UTC(2026, 9, 16, 16, 0), NY)).toBe('12:00 PM');
  });

  it('reads a zone it does not know as UTC rather than throwing', () => {
    expect(formatReminderWhen(FRIDAY_3PM, 'Mars/Olympus', NOW)).toBe('Friday 16 October at 7:00 PM');
    expect(formatReminderWhen(FRIDAY_3PM, null, NOW)).toBe('Friday 16 October at 7:00 PM');
  });
});

describe('formatReminderAt', () => {
  it('says only the time on the day it is, and the day too on another', () => {
    expect(formatReminderAt(Date.UTC(2026, 9, 15, 22, 0), NY, NOW)).toBe('6:00 PM');
    expect(formatReminderAt(FRIDAY_3PM, NY, NOW)).toBe('Friday 16 October at 3:00 PM');
  });

  it('judges "today" on the owner’s clock, not in UTC', () => {
    // 9:00 PM on Thursday in New York is already Friday in UTC.
    expect(formatReminderAt(Date.UTC(2026, 9, 16, 1, 0), NY, NOW)).toBe('9:00 PM');
  });
});

describe('formatReminderDay', () => {
  /** A date-only due: Monday 28 September 2026, stored at its UTC midnight. */
  const MONDAY = Date.UTC(2026, 8, 28);

  it('names the day the due names, on any clock', () => {
    expect(formatReminderDay(MONDAY, NY, NOW)).toBe('Monday 28 September');
    // Read as an instant, that UTC midnight is Sunday evening in Los Angeles.
    expect(formatReminderDay(MONDAY, 'America/Los_Angeles', NOW)).toBe('Monday 28 September');
    expect(formatReminderDay(MONDAY, 'Asia/Tokyo', NOW)).toBe('Monday 28 September');
  });

  it('adds the year only when it is not this year’s on the owner’s clock', () => {
    expect(formatReminderDay(Date.UTC(2027, 0, 4), NY, NOW)).toBe('Monday 4 January 2027');
    // On New Year's Eve evening in New York it is already next year in UTC.
    expect(formatReminderDay(Date.UTC(2027, 0, 1), NY, Date.UTC(2027, 0, 1, 3, 0))).toBe('Friday 1 January 2027');
    expect(formatReminderDay(Date.UTC(2027, 0, 1), null, Date.UTC(2027, 0, 1, 3, 0))).toBe('Friday 1 January');
  });
});

describe('reminderDeliveryText', () => {
  const reminder = { text: 'call the dentist', at: FRIDAY_3PM, time_zone: NY };

  it('is the owner’s own words when it rings on time', () => {
    expect(reminderDeliveryText(reminder, FRIDAY_3PM + 30_000)).toBe('call the dentist');
    expect(reminderDeliveryText(reminder, FRIDAY_3PM + REMINDER_LATE_MS)).toBe('call the dentist');
  });

  it('says which time it was for when it rings late (P5)', () => {
    expect(reminderDeliveryText(reminder, FRIDAY_3PM + REMINDER_LATE_MS + 1)).toBe('For 3:00 PM: call the dentist');
    // Another day: the day too.
    expect(reminderDeliveryText(reminder, FRIDAY_3PM + 20 * 3_600_000))
      .toBe('For Friday 16 October at 3:00 PM: call the dentist');
  });
});
