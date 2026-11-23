import { zonedWallClockToEpochMs } from './zoned-wall-clock.js';

/** Saved date settings contain civil dates and a named clock, never a cached
 * result window. Relative choices are resolved anew when a view is opened. */
export type ReminderSearchDates = { range: 'today' | 'week'; time_zone: string }
  | { range: 'custom'; time_zone: string; from: string; through: string };
export interface ReminderSearchDateWindow { from: number; before: number; first: string; through: string }
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && value >= '0100-01-01' && value < '9999-12-31' && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const addDays = (value: string, amount: number) => new Date(Date.parse(value + 'T00:00:00Z') + amount * 86400000).toISOString().slice(0, 10);
const day = (at: number, zone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value.padStart(type === 'year' ? 4 : 2, '0')).join('-');
};
export const parseReminderSearchDates = (input: unknown): ReminderSearchDates | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>, custom = value.range === 'custom';
  if (typeof value.range !== 'string' || !['today', 'week', 'custom'].includes(value.range)
    || Object.keys(value).some(key => !(custom ? ['range', 'time_zone', 'from', 'through'] : ['range', 'time_zone']).includes(key))
    || typeof value.time_zone !== 'string' || !value.time_zone || value.time_zone.length > 100
    || custom && (!date(value.from) || !date(value.through) || value.from > value.through)) return null;
  try {
    const time_zone = new Intl.DateTimeFormat('en', { timeZone: value.time_zone }).resolvedOptions().timeZone;
    return custom ? { range: 'custom', time_zone, from: value.from as string, through: value.through as string }
      : { range: value.range as 'today' | 'week', time_zone };
  } catch { return null; }
};
export const resolveReminderSearchDates = (filter: ReminderSearchDates, now: number): ReminderSearchDateWindow => {
  const valid = parseReminderSearchDates(filter);
  if (!valid) throw Error('Choose valid reminder dates and a time zone.');
  const first = valid.range === 'custom' ? valid.from : day(now, valid.time_zone);
  const through = valid.range === 'custom' ? valid.through : addDays(first, valid.range === 'week' ? 6 : 0);
  const following = addDays(through, 1), from = zonedWallClockToEpochMs(first, valid.time_zone), before = zonedWallClockToEpochMs(following, valid.time_zone);
  if (!date(first) || !date(through) || from === null || before === null || from >= before
    || day(from, valid.time_zone) !== first || day(before, valid.time_zone) !== following)
    throw Error('These dates cannot be resolved in this time zone. Choose another date range.');
  return { from, before, first, through };
};
