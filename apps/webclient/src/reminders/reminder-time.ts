import { zonedWallClockToEpochMs } from '@recued/contracts';

export const REMINDER_TIME_PRESETS = [
  { key: '15-minutes', label: 'In 15 minutes' },
  { key: '1-hour', label: 'In 1 hour' },
  { key: 'tomorrow-9', label: 'Tomorrow at 9am' },
] as const;
export type ReminderTimePreset = typeof REMINDER_TIME_PRESETS[number]['key'];

/** `YYYY-MM-DDTHH:mm` on `zone`'s wall clock, for a `datetime-local` field. */
export const reminderWallClockValue = (at: number, zone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
};

/** Relative choices keep their exact instant through a repeated or skipped
 * hour. Tomorrow is a calendar date on the reminder's clock, not +24 hours. */
export const reminderTimePreset = (preset: ReminderTimePreset, now: number, zone: string): { at: number; value: string } => {
  let at: number;
  if (preset === 'tomorrow-9') {
    const today = reminderWallClockValue(now, zone).slice(0, 10);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const value = `${tomorrow}T09:00`;
    const resolved = zonedWallClockToEpochMs(value, zone);
    if (resolved === null || reminderWallClockValue(resolved, zone) !== value)
      throw new Error('Tomorrow at 9am does not exist on this reminder’s clock. Choose another time.');
    at = resolved;
  } else at = now + (preset === '15-minutes' ? 15 : 60) * 60_000;
  return { at, value: reminderWallClockValue(at, zone) };
};

/** Include the year and offset so a preview distinguishes both repeated hours.
 * Keep seconds and fractions when the selected instant contains them. */
export const formatReminderTimePreview = (at: number, zone: string): string => new Intl.DateTimeFormat('en-US', {
  timeZone: zone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  ...(at % 60_000 ? { second: '2-digit' as const } : {}),
  ...(at % 1000 ? { fractionalSecondDigits: 3 as const } : {}), timeZoneName: 'shortOffset',
}).format(new Date(at)).replace(/[  ]/gu, ' ');

