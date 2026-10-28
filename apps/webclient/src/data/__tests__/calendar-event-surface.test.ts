import { expect, it, vi } from 'vitest';
import type { CalendarEventSnapshot, CalendarEventUpdateRequest } from '@recued/contracts';
import { calendarEventDraft, calendarEventPatch, calendarWallClockCandidates, calendarWallClockValue,
  createCalendarEventSurface, CALENDAR_EVENT_FIELD } from '../calendar-event-surface.js';

const snapshot = (): CalendarEventSnapshot => ({
  event: { record_id: 'cal:local:event', source_id: 'event', calendar_id: 'local', summary: 'Planning',
    updated_at: 1_700_000_000_000, description: 'Original\r\nnotes', location: 'Room 2', start_at: Date.parse('2026-10-28T16:00:12.345Z'),
    end_at: Date.parse('2026-10-28T17:00:12.345Z'), timezone: 'America/Los_Angeles', is_all_day: false,
    status: 'confirmed', is_recurring: false },
  record: { record_id: 'cal:local:event', source_id: 'event', received_at: 1_700_000_000_000, modified_at: 1_700_000_000_000,
    size_bytes: 14, hot_fields: { summary: 'Planning' }, body_inline: 'Original\r\nnotes' },
  resource_version: 'v1', incarnation: 'calendar-1', editable: true,
});
const input = (field: string, value: string): HTMLElement => ({ getAttribute: (key: string) => key === CALENDAR_EVENT_FIELD ? field : null, value }) as unknown as HTMLElement;
const setup = (callers: Parameters<typeof createCalendarEventSurface>[0]['callers'] = {}) => {
  const onSaved = vi.fn(); const render = vi.fn();
  const surface = createCalendarEventSurface({ callers: { get: async () => snapshot(), ...callers },
    actionAttr: 'data-action', render, onSaved });
  return { surface, render, onSaved };
};
const open = (surface: ReturnType<typeof createCalendarEventSurface>) => surface.open({ slug: 'local', source_id: 'event' }, 'cal:local:event');

it('preserves imported precision and normalized text when only another field changes', () => {
  const event = snapshot().event; event.summary = 'Planning\r\nmeeting';
  const draft = calendarEventDraft(event);
  expect(draft.start).toBe('2026-10-28T09:00');
  expect(calendarEventPatch(event, draft)).toEqual({ patch: {} });
  draft.location = '';
  expect(calendarEventPatch(event, draft)).toEqual({ patch: { location: '' } });
  draft.description = '';
  expect(calendarEventPatch(event, draft)).toEqual({ patch: { description: '', location: '' } });
});

it('rejects nonexistent times and requires an explicit reading of a repeated hour', () => {
  const event = snapshot().event;
  const draft = calendarEventDraft(event);
  draft.start = '2026-03-08T02:30'; draft.startChoice = '';
  expect(calendarEventPatch(event, draft).error).toMatch(/daylight saving gap/);
  expect(calendarWallClockCandidates('2026-02-30T10:00', event.timezone)).toEqual([]);
  draft.start = '2026-11-01T01:30';
  draft.end = '2026-11-01T03:00'; draft.endChoice = '';
  expect(calendarEventPatch(event, draft).error).toMatch(/repeated start/);
  expect(calendarWallClockCandidates(draft.start, event.timezone)).toEqual([
    Date.parse('2026-11-01T08:30:00Z'), Date.parse('2026-11-01T09:30:00Z'),
  ]);
  draft.startChoice = String(Date.parse('2026-11-01T09:30:00Z'));
  expect(calendarEventPatch(event, draft)).toEqual({ patch: {
    start_at: Date.parse('2026-11-01T09:30:00Z'), end_at: Date.parse('2026-11-01T11:00:00Z'),
  } });
  expect(calendarWallClockValue(Date.parse('2026-10-28T12:00:00Z'), 'Asia/Kathmandu')).toBe('2026-10-28T17:45');
});

it('preserves an unchanged later DST reading and all-day inclusive dates across a clock change', () => {
  const event = snapshot().event;
  event.start_at = Date.parse('2026-11-01T09:30:15.123Z'); event.end_at = event.start_at + 3_600_000;
  const unchanged = calendarEventDraft(event); unchanged.summary = 'Later meeting';
  expect(calendarEventPatch(event, unchanged)).toEqual({ patch: { summary: 'Later meeting' } });
  event.is_all_day = true; event.start_at = Date.parse('2026-10-31T00:00:00Z'); event.end_at = Date.parse('2026-11-03T00:00:00Z');
  const draft = calendarEventDraft(event);
  expect(draft).toMatchObject({ start: '2026-10-31', end: '2026-11-02' });
  draft.start = '2026-11-01'; draft.end = '2026-11-04';
  expect(calendarEventPatch(event, draft)).toEqual({ patch: {
    start_at: Date.parse('2026-11-01T00:00:00Z'), end_at: Date.parse('2026-11-05T00:00:00Z'),
  } });
  draft.end = '2026-10-31';
  expect(calendarEventPatch(event, draft).error).toMatch(/last day/);
});

it('keeps a failed draft, prevents duplicate saves and confirms a retry before retiring the editor', async () => {
  let fail: (err: Error) => void = () => {};
  const update = vi.fn<(args: CalendarEventUpdateRequest) => Promise<CalendarEventSnapshot>>()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
    .mockImplementationOnce(async args => ({ ...snapshot(), resource_version: 'v2', event: { ...snapshot().event, ...args.patch } }));
  const { surface, onSaved } = setup({ update }); await open(surface);
  surface.handleAction('calendar-event-edit'); surface.handleInput(input('summary', 'Revised planning'));
  surface.handleAction('calendar-event-save'); surface.handleAction('calendar-event-save');
  expect(update).toHaveBeenCalledTimes(1); expect(surface.hasInFlightWork()).toBe(true);
  expect(surface.beforeLeave(vi.fn())).toBe(false);
  fail(new Error('Save interrupted.'));
  await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false));
  expect(surface.hasUnsavedChanges()).toBe(true); expect(surface.render()).toContain('Revised planning');
  expect(onSaved).not.toHaveBeenCalled();
  surface.handleAction('calendar-event-save');
  await vi.waitFor(() => expect(surface.isEditing()).toBe(false));
  expect(update.mock.calls[1]?.[0]).toMatchObject({ expected_version: 'v1', expected_incarnation: 'calendar-1', patch: { summary: 'Revised planning' } });
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it('checks canonical state after an unconfirmed save without sending the mutation again', async () => {
  let saved = snapshot();
  const update = vi.fn(async (args: CalendarEventUpdateRequest) => {
    saved = { ...snapshot(), resource_version: 'v2', event: { ...snapshot().event, ...args.patch } };
    throw new Error('Reply lost after persistence.');
  });
  const { surface, onSaved } = setup({ get: async () => structuredClone(saved), update }); await open(surface);
  surface.handleAction('calendar-event-edit'); surface.handleInput(input('description', 'Updated notes'));
  surface.handleAction('calendar-event-save');
  await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false));
  expect(surface.isEditing()).toBe(true);
  surface.handleAction('calendar-event-check');
  await vi.waitFor(() => expect(surface.isEditing()).toBe(false));
  expect(update).toHaveBeenCalledTimes(1); expect(onSaved).toHaveBeenCalledTimes(1);
});

it('keeps the draft when a save or check returns a different event or replacement calendar', async () => {
  const changed = { ...snapshot().event, summary: 'My draft' };
  for (const wrong of [
    { ...snapshot(), incarnation: 'replacement', event: changed },
    { ...snapshot(), event: { ...changed, record_id: 'different-record' } },
    { ...snapshot(), event: { ...changed, end_at: changed.end_at + 3_600_000 } },
  ]) {
    const { surface, onSaved } = setup({ update: async () => wrong, get: vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(wrong) });
    await open(surface); surface.handleAction('calendar-event-edit'); surface.handleInput(input('summary', 'My draft'));
    surface.handleAction('calendar-event-save');
    await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false));
    expect(surface.isEditing()).toBe(true);
    surface.handleAction('calendar-event-check');
    await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false));
    expect(surface.hasUnsavedChanges()).toBe(true); expect(onSaved).not.toHaveBeenCalled();
  }
});

it('guards internal navigation, keeps drafts on Escape, and discards only after confirmation', async () => {
  const { surface } = setup({ update: async () => snapshot() }); await open(surface);
  surface.handleAction('calendar-event-edit'); surface.handleInput(input('summary', 'Unsaved title'));
  const leave = vi.fn(); expect(surface.beforeLeave(leave)).toBe(false);
  expect(surface.render()).toContain('Discard event changes?');
  surface.escape(); expect(leave).not.toHaveBeenCalled(); expect(surface.hasUnsavedChanges()).toBe(true);
  surface.beforeLeave(leave); surface.handleAction('calendar-event-discard');
  expect(leave).toHaveBeenCalledTimes(1); expect(surface.hasUnsavedChanges()).toBe(false);
});

it('ignores a late read after a different event is opened or the surface is disposed', async () => {
  let resolve: (value: CalendarEventSnapshot) => void = () => {};
  const get = vi.fn().mockImplementationOnce(() => new Promise<CalendarEventSnapshot>(done => { resolve = done; }))
    .mockResolvedValueOnce({ ...snapshot(), record: { ...snapshot().record, record_id: 'other-record', source_id: 'other' },
      event: { ...snapshot().event, record_id: 'other-record', source_id: 'other', summary: 'Other event' } });
  const { surface } = setup({ get }); const old = open(surface);
  await surface.open({ slug: 'local', source_id: 'other' }, 'other-record');
  resolve(snapshot()); await old;
  expect(surface.render()).toContain('Other event'); expect(surface.render()).not.toContain('Planning');
  surface.dispose(); expect(surface.render()).toBe('');
});


it('normalizes duration rounding instead of showing 60 seconds or a zero-length positive event', async () => {
  const value = snapshot(); value.event.end_at = value.event.start_at + 119_900;
  const { surface } = setup({ get: async () => structuredClone(value) });
  await open(surface); expect(surface.render()).toContain('2 minutes');
  value.event.end_at = value.event.start_at + 100;
  await open(surface); expect(surface.render()).toContain('Less than a second');
});


it('keeps event details readable when the browser cannot interpret the event clock', async () => {
  const value = snapshot(); value.event.timezone = 'Unknown/Zone';
  const { surface } = setup({ get: async () => structuredClone(value), update: async () => value });
  await open(surface);
  expect(surface.isEditable()).toBe(false);
  surface.handleAction('calendar-event-edit');
  expect(surface.isEditing()).toBe(false);
  expect(surface.render()).toContain('event time zone unavailable');
});
