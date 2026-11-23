import { describe, expect, it } from 'vitest';
import { reminderTimePreset, formatReminderTimePreview } from '../../reminders/reminder-time.js';

describe('reminder time presets', () => {
  it('keeps relative durations and precision through a repeated hour and makes the offset explicit', () => {
    const now = Date.parse('2030-11-03T05:30:12.345Z');
    const hour = reminderTimePreset('1-hour', now, 'America/New_York');
    expect(hour).toEqual({ at: now + 3_600_000, value: '2030-11-03T01:30' });
    expect(reminderTimePreset('15-minutes', now, 'America/New_York').at).toBe(now + 900_000);
    expect(formatReminderTimePreview(now, 'America/New_York')).toContain('GMT-4');
    expect(formatReminderTimePreview(hour.at, 'America/New_York')).toContain('GMT-5');
    expect(formatReminderTimePreview(hour.at, 'America/New_York')).toContain('12.345');
  });
  it('chooses tomorrow’s calendar date at 9am in the reminder zone across daylight saving and year changes', () => {
    expect(reminderTimePreset('tomorrow-9', Date.parse('2026-03-07T23:30:00Z'), 'America/New_York'))
      .toEqual({ at: Date.parse('2026-03-08T13:00:00Z'), value: '2026-03-08T09:00' });
    expect(reminderTimePreset('tomorrow-9', Date.parse('2026-12-31T10:00:00Z'), 'Pacific/Auckland'))
      .toEqual({ at: Date.parse('2026-12-31T20:00:00Z'), value: '2027-01-01T09:00' });
  });
  it('does not silently substitute another date when tomorrow is a skipped calendar day', () => {
    expect(() => reminderTimePreset('tomorrow-9', Date.parse('2011-12-29T20:00:00Z'), 'Pacific/Apia'))
      .toThrow('does not exist on this reminder’s clock');
  });
});
