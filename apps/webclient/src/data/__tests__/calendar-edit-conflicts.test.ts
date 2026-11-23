import { expect, it } from 'vitest';
import type { CalendarEventSnapshot } from '@recued/contracts';
import { calendarEventDraft, calendarEventPatch } from '../calendar-event-draft.js';
import { calendarWallClockValue } from '../calendar-wall-clock.js';
import { calendarEditOriginal, type CalendarEditEntry } from '../calendar-edit-recovery.js';
import { compareCalendarEdits, mergeCalendarEdits, unresolvedCalendarConflicts } from '../calendar-edit-conflicts.js';

const now = Date.parse('2026-10-28T12:00Z');
const snapshot = (): CalendarEventSnapshot => ({ incarnation: 'local-1', resource_version: 'v1', editable: true,
  event: { source_id: 'event', record_id: 'cal:local:event', calendar_id: 'local', summary: 'Planning', description: 'Original\r\nnotes', location: 'Room 2',
    start_at: Date.parse('2026-10-28T16:00:12.345Z'), end_at: Date.parse('2026-10-28T17:00:12.345Z'), timezone: 'America/Los_Angeles', is_all_day: false, status: 'confirmed', is_recurring: false, updated_at: now },
  record: { source_id: 'event', record_id: 'cal:local:event', hot_fields: {}, received_at: now, modified_at: now, size_bytes: 0 } });
const kept = (before: CalendarEventSnapshot): CalendarEditEntry => ({ id: 'ced_' + crypto.randomUUID(), revision: 1, updatedAt: now, sourceId: 'local', status: 'editing',
  original: calendarEditOriginal('local', before), values: { draft: calendarEventDraft(before.event), calendarName: 'Local', request: null } });

it('carries independent edits over the latest saved interval without changing its exact instants or provider text', () => {
  const before = snapshot(), entry = kept(before); entry.values.draft.description = 'My notes';
  const current = { ...before, resource_version: 'v2', event: { ...before.event, start_at: before.event.start_at + 3600_000, end_at: before.event.end_at + 3600_000 } };
  const comparison = compareCalendarEdits(entry, current); expect(unresolvedCalendarConflicts(comparison)).toEqual([]);
  const merged = mergeCalendarEdits(comparison)!;
  expect(calendarEventPatch(current.event, merged).patch).toEqual({ description: 'My notes' });
  expect(merged.startChoice).toBe(String(current.event.start_at)); expect(merged.endChoice).toBe(String(current.event.end_at));
  expect(entry.values.draft.description).toBe('My notes'); expect(entry.original.resource_version).toBe('v1');
});

it('requires a choice for each conflicting field and retains saved changes the owner did not edit', () => {
  const before = snapshot(), entry = kept(before); entry.values.draft.summary = 'My title'; entry.values.draft.location = 'My room';
  const current = { ...before, resource_version: 'v2', event: { ...before.event, summary: 'Saved title', description: 'Saved notes', location: 'Saved room' } };
  const comparison = compareCalendarEdits(entry, current); expect(unresolvedCalendarConflicts(comparison).map(row => row.key)).toEqual(['summary', 'location']);
  expect(mergeCalendarEdits(comparison)).toBeNull(); comparison.choices.summary = 'mine'; expect(mergeCalendarEdits(comparison)).toBeNull(); comparison.choices.location = 'saved';
  expect(calendarEventPatch(current.event, mergeCalendarEdits(comparison)!).patch).toEqual({ summary: 'My title' });
  expect(mergeCalendarEdits(comparison)!.description).toBe('Saved notes'); expect(mergeCalendarEdits(comparison)!.location).toBe('Saved room');
});

it('treats the full interval as one conflict and preserves both repeated-hour epochs and fractional seconds when reapplying', () => {
  const before = snapshot(); before.event.start_at = Date.parse('2026-11-01T08:15:12.345Z'); before.event.end_at = Date.parse('2026-11-01T08:45:12.345Z');
  const entry = kept(before), end = Date.parse('2026-11-01T09:30:12.567Z');
  entry.values.draft.end = calendarWallClockValue(end, before.event.timezone, 'millisecond'); entry.values.draft.endChoice = String(end);
  const current = { ...before, resource_version: 'v2', event: { ...before.event, start_at: Date.parse('2026-11-01T09:15:45.678Z'), end_at: Date.parse('2026-11-01T09:45:45.678Z') } };
  const comparison = compareCalendarEdits(entry, current); expect(unresolvedCalendarConflicts(comparison).map(row => row.key)).toEqual(['when']);
  comparison.choices.when = 'mine'; const merged = mergeCalendarEdits(comparison)!;
  expect(calendarEventPatch(current.event, merged).patch).toEqual({ start_at: before.event.start_at, end_at: end });
  expect(merged.startChoice).toBe(String(before.event.start_at)); expect(merged.start).toBe('2026-11-01T01:15:12.345');
  comparison.choices.when = 'saved'; expect(calendarEventPatch(current.event, mergeCalendarEdits(comparison)!).patch).toEqual({});
});

it('recognizes matching edits and normalized line breaks without inventing conflicts or writes', () => {
  const before = snapshot(), entry = kept(before); entry.values.draft.summary = 'Same title';
  const current = { ...before, resource_version: 'v2', event: { ...before.event, summary: 'Same title', description: 'Original\nnotes' } };
  const comparison = compareCalendarEdits(entry, current); expect(comparison.rows).toHaveLength(1); expect(comparison.rows[0]).toMatchObject({ key: 'summary', conflict: false, mineChanged: true, savedChanged: true });
  expect(calendarEventPatch(current.event, mergeCalendarEdits(comparison)!).patch).toEqual({});
});

it('retains incomplete input for correction while keeping the original precision of an untouched endpoint', () => {
  const before = snapshot(), entry = kept(before); entry.values.draft.summary = ''; entry.values.draft.end = ''; entry.values.draft.endChoice = '';
  const current = { ...before, resource_version: 'v2', event: { ...before.event, description: 'Saved notes' } };
  const comparison = compareCalendarEdits(entry, current), merged = mergeCalendarEdits(comparison)!;
  expect(merged).toMatchObject({ summary: '', end: '', endChoice: '', start: '2026-10-28T09:00:12.345', startChoice: String(before.event.start_at), description: 'Saved notes' });
  expect(calendarEventPatch(current.event, merged).error).toBe('Enter an event title.');
});

it('reapplies all-day dates as a complete inclusive span', () => {
  const before = snapshot(); before.event.is_all_day = true; before.event.start_at = Date.parse('2026-10-28T00:00Z'); before.event.end_at = Date.parse('2026-10-30T00:00Z');
  const entry = kept(before); entry.values.draft.end = '2026-10-31';
  const current = { ...before, resource_version: 'v2', event: { ...before.event, start_at: Date.parse('2026-10-29T00:00Z'), end_at: Date.parse('2026-10-31T00:00Z') } };
  const comparison = compareCalendarEdits(entry, current); comparison.choices.when = 'mine';
  expect(calendarEventPatch(current.event, mergeCalendarEdits(comparison)!).patch).toEqual({ start_at: Date.parse('2026-10-28T00:00Z'), end_at: Date.parse('2026-11-01T00:00Z') });
});
