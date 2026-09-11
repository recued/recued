import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_VIEW_FILTERS, parseTaskListFilter, parseTaskViewFilters,
  resolveTaskListFilter,
} from '../task-data-view.js';
import { parseSavedDataViewDefinition, sameSavedDataViewDefinition } from '../saved-data-views.js';

const originalZone = process.env.TZ;
afterEach(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

describe('relative task view dates', () => {
  it.each([
    ['2026-03-08T12:00:00-07:00', '2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z'],
    ['2026-11-01T12:00:00-08:00', '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z'],
  ])('uses local calendar boundaries through daylight saving at %s', (now, start, end) => {
    process.env.TZ = 'America/Los_Angeles';
    expect(resolveTaskListFilter({ ...DEFAULT_TASK_VIEW_FILTERS, due: 'today' }, Date.parse(now)).due)
      .toEqual({ kind: 'range', from: Date.parse(start), before: Date.parse(end) });
  });

  it('includes today in seven calendar days and resolves again tomorrow', () => {
    process.env.TZ = 'America/Los_Angeles';
    const filters = { ...DEFAULT_TASK_VIEW_FILTERS, due: 'next_7_days' as const };
    expect(resolveTaskListFilter(filters, Date.parse('2026-03-07T12:00:00-08:00')).due)
      .toEqual({ kind: 'range', from: Date.parse('2026-03-07T08:00:00Z'), before: Date.parse('2026-03-14T07:00:00Z') });
    expect(resolveTaskListFilter(filters, Date.parse('2026-03-08T12:00:00-07:00')).due)
      .toEqual({ kind: 'range', from: Date.parse('2026-03-08T08:00:00Z'), before: Date.parse('2026-03-15T07:00:00Z') });
  });

  it('uses the actual instant for overdue, including a task due earlier today', () => {
    expect(resolveTaskListFilter({ completion: 'all', due: 'overdue', sort: 'due_asc' }, 1000))
      .toEqual({ completion: 'all', sort: 'due_asc', due: { kind: 'overdue', before: 1000 } });
  });
});

describe('task filter compatibility and validation', () => {
  const legacy = { tab: 'task', query: 'Call', source_id: null, booking_lifecycle: 'all' } as const;
  it('keeps old views readable and canonicalizes explicit defaults to the old shape', () => {
    expect(parseSavedDataViewDefinition(legacy)).toEqual(legacy);
    const explicit = { ...legacy, task_filters: DEFAULT_TASK_VIEW_FILTERS };
    expect(parseSavedDataViewDefinition(explicit)).toEqual(legacy);
    expect(sameSavedDataViewDefinition(legacy, explicit)).toBe(true);
  });
  it('retains nondefault settings and rejects unsupported filters without broadening', () => {
    const current = { ...legacy, task_filters: { completion: 'open', due: 'overdue', sort: 'due_asc' } };
    expect(parseSavedDataViewDefinition(current)).toEqual(current);
    expect(parseSavedDataViewDefinition({ ...current, tab: 'note' })).toBeNull();
    expect(parseSavedDataViewDefinition({ ...legacy, task_filters: { completion: 'open' } })).toBeNull();
    expect(parseTaskViewFilters({ ...DEFAULT_TASK_VIEW_FILTERS, due: 'next_year' })).toBeNull();
  });
  it.each([
    { kind: 'range', from: 2, before: 1 }, { kind: 'range', from: 1, before: Infinity },
    { kind: 'range', from: 1.5, before: 2 }, { kind: 'overdue', before: 'now' },
    { kind: 'all', before: 10 }, { kind: 'range', from: 0, before: 1, sql: '1=1' },
  ])('rejects malformed RPC date windows %j', (due) => {
    expect(parseTaskListFilter({ completion: 'all', sort: 'default', due })).toBeNull();
  });
});
