import { expect, it } from 'vitest';
import { parseReminderSearchDates, resolveReminderSearchDates, type ReminderSearchDates } from '../reminder-search-dates.js';
import { parseSavedDataViewDefinition, sameSavedDataViewDefinition } from '../saved-data-views.js';

it('decodes only known date settings and preserves old search definitions', () => {
  const dates = { range: 'custom', time_zone: 'America/New_York', from: '2028-02-29', through: '2028-03-01' } as const;
  expect(parseReminderSearchDates(dates)).toEqual(dates);
  for (const bad of [{ ...dates, from: '2027-02-29' }, { ...dates, through: '2028-02-28' }, { ...dates, time_zone: 'Not/A_Zone' },
    { range: 'week', time_zone: 'UTC', from: '2026-11-01' }, { range: 'all', time_zone: 'UTC' }])expect(parseReminderSearchDates(bad)).toBeNull();
  expect(parseSavedDataViewDefinition({ tab: 'search', query: 'clinic', result_type: 'reminder' })).toEqual({ tab: 'search', query: 'clinic', result_type: 'reminder' });
  expect(parseSavedDataViewDefinition({ tab: 'search', query: 'clinic', reminder_dates: { ...dates, extra: true } })).toBeNull();
});

it('retains relative settings in a saved view and includes them in update equality', () => {
  const dates = { range: 'week', time_zone: 'America/New_York' } as const;
  const saved = { tab: 'search', query: '', result_type: 'reminder', reminder_state: 'pending', reminder_dates: dates } as const;
  expect(parseSavedDataViewDefinition(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  expect(sameSavedDataViewDefinition(saved, { ...saved, reminder_dates: { ...dates, range: 'today' } })).toBe(false);
  expect(sameSavedDataViewDefinition(saved, { ...saved, reminder_dates: { ...dates, time_zone: 'Asia/Tokyo' } })).toBe(false);
  expect(sameSavedDataViewDefinition(saved, { ...saved })).toBe(true);
});

it('resolves Today in its named clock across the 23-hour and 25-hour New York days', () => {
  const filter: ReminderSearchDates = { range: 'today', time_zone: 'America/New_York' };
  const spring = resolveReminderSearchDates(filter, Date.parse('2026-03-08T16:00Z'));
  expect(spring).toEqual({ first: '2026-03-08', through: '2026-03-08', from: Date.parse('2026-03-08T05:00Z'), before: Date.parse('2026-03-09T04:00Z') });
  const fall = resolveReminderSearchDates(filter, Date.parse('2026-11-01T15:00Z'));
  expect(fall.before - fall.from).toBe(25 * 3600000);expect(fall.from).toBe(Date.parse('2026-11-01T04:00Z'));expect(fall.before).toBe(Date.parse('2026-11-02T05:00Z'));
});

it('uses seven calendar dates, includes the last custom day, and resolves relative settings anew', () => {
  const filter: ReminderSearchDates = { range: 'week', time_zone: 'America/New_York' };
  const first = resolveReminderSearchDates(filter, Date.parse('2026-11-01T15:00Z'));
  expect(first).toMatchObject({ first: '2026-11-01', through: '2026-11-07', before: Date.parse('2026-11-08T05:00Z') });
  expect(resolveReminderSearchDates(filter, Date.parse('2026-11-02T15:00Z'))).toMatchObject({ first: '2026-11-02', through: '2026-11-08' });
  expect(resolveReminderSearchDates({ range: 'custom', time_zone: 'Asia/Tokyo', from: '2026-11-01', through: '2026-11-01' }, 0))
    .toEqual({ first: '2026-11-01', through: '2026-11-01', from: Date.parse('2026-10-31T15:00Z'), before: Date.parse('2026-11-01T15:00Z') });
});

it('refuses a civil day skipped by a zone rather than silently searching another day', () => {
  expect(() => resolveReminderSearchDates({ range: 'custom', time_zone: 'Pacific/Apia', from: '2011-12-30', through: '2011-12-30' }, 0)).toThrow('cannot be resolved');
});
