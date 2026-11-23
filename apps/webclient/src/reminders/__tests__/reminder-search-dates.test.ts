import { expect, it } from 'vitest';
import { createReminderDateSearch, renderReminderDateSearch } from '../reminder-search-dates.js';

it('applies date drafts explicitly and keeps the previous window when a new draft is invalid', () => {
  const dates = createReminderDateSearch({ now: () => Date.parse('2026-11-01T15:00Z'), zone: () => 'America/New_York' });
  expect(dates.bounds()).toEqual({});dates.setField('range', 'today');expect(dates.definition()).toBeUndefined();expect(dates.apply()).toBe(true);
  const before = dates.bounds();dates.setField('range', 'custom');dates.setField('from', '2026-11-03');dates.setField('through', '2026-11-02');
  expect(dates.apply()).toBe(false);expect(dates.bounds()).toEqual(before);expect(dates.definition()?.range).toBe('today');
  expect(renderReminderDateSearch(dates.view(), 'data-action')).toContain('2026-11-01 through 2026-11-01');
});

it('restores the same paging window and unapplied draft, but reopens saved relative settings on a new day', () => {
  let now = Date.parse('2026-11-01T15:00Z');
  const dates = createReminderDateSearch({ initial: { range: 'today', time_zone: 'America/New_York' }, now: () => now, zone: () => 'Asia/Tokyo' });
  const before = dates.bounds();dates.setField('range', 'custom');dates.setField('from', '2026-11-04');const snapshot = dates.snapshot();now += 86400000;
  const returned = createReminderDateSearch({ now: () => now });returned.restore(snapshot);snapshot.draft.from = '2026-11-09';
  expect(returned.bounds()).toEqual(before);expect(returned.view().draft.from).toBe('2026-11-04');expect(returned.view().zone).toBe('America/New_York');
  const reopened = createReminderDateSearch({ initial: dates.definition(), now: () => now });
  expect(reopened.view().window?.first).toBe('2026-11-02');expect(reopened.bounds()).not.toEqual(before);
});

it('keeps an unresolvable saved filter unavailable until the owner explicitly clears it', () => {
  const dates = createReminderDateSearch({ initial: { range: 'custom', time_zone: 'Pacific/Apia', from: '2011-12-30', through: '2011-12-30' } });
  expect(dates.bounds()).toBeNull();expect(dates.view().readError).toContain('cannot be resolved');
  expect(dates.definition()?.range).toBe('custom');dates.setField('range', 'all');expect(dates.apply()).toBe(true);expect(dates.bounds()).toEqual({});expect(dates.definition()).toBeUndefined();
});
