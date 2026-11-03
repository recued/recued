import { expect, it, vi } from 'vitest';
import { CALENDAR_EVENT_EDIT_LIMITS, type CalendarEventSnapshot, type CalendarEventUpdateRequest, type CalendarEventDeleteRequest } from '@recued/contracts';
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
  const onSaved = vi.fn(); const render = vi.fn(); const onRemoved = vi.fn();
  const surface = createCalendarEventSurface({ callers: { get: async () => snapshot(), ...callers },
    actionAttr: 'data-action', render, onSaved, onRemoved });
  return { surface, render, onSaved, onRemoved };
};
const open = (surface: ReturnType<typeof createCalendarEventSurface>) => surface.open({ slug: 'local', source_id: 'event' }, 'cal:local:event');

it('honors provider field restrictions while retaining the original calendar, rich notes and unsupported time zone', async () => {
  const value = snapshot(); value.provider_verified = true; value.editable_fields = ['summary'];
  value.event.timezone = 'Pacific Standard Time'; value.edit_notice = 'Edit rich notes in Outlook.';
  value.event.location = 'a'.repeat(CALENDAR_EVENT_EDIT_LIMITS.location + 1);
  const update = vi.fn(async (request: CalendarEventUpdateRequest) => ({ ...value, resource_version: 'v2', event: { ...value.event, ...request.patch } }));
  const { surface } = setup({ get: async () => value, update }); await open(surface);
  expect(surface.isEditable()).toBe(true);
  surface.handleAction('calendar-event-edit');
  surface.handleInput(input('description', 'Must not flatten rich notes'));
  surface.handleInput(input('start', '2026-10-30T09:00'));
  surface.handleInput(input('summary', 'Updated title'));
  surface.handleAction('calendar-event-save');
  await vi.waitFor(() => expect(surface.isEditing()).toBe(false));
  expect(update.mock.calls[0]?.[0]).toMatchObject({ slug: 'local', source_id: 'event', patch: { summary: 'Updated title' } });
  expect(update.mock.calls[0]?.[0].patch).toEqual({ summary: 'Updated title' });
});

it('requires a live check after a remote save fails and never confirms from a cached event', async () => {
  const before = snapshot(); before.provider_verified = true;
  before.editable_fields = ['summary', 'description', 'location', 'start_at', 'end_at'];
  let saved = before, live = true;
  const update = vi.fn(async (request: CalendarEventUpdateRequest) => {
    saved = { ...before, resource_version: 'v2', event: { ...before.event, ...request.patch } };
    throw { code: 'timeout', message: 'Reply lost' };
  });
  const { surface, onSaved } = setup({ get: async () => live ? saved : { ...before, provider_verified: undefined,
    editable: false, refresh_error: 'The calendar could not be refreshed.' }, update });
  await open(surface); surface.handleAction('calendar-event-edit'); surface.handleInput(input('summary', 'Remote update'));
  surface.handleAction('calendar-event-save');
  await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false));
  surface.handleAction('calendar-event-save'); expect(update).toHaveBeenCalledTimes(1);
  live = false; surface.handleAction('calendar-event-check');
  await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false));
  expect(surface.isEditing()).toBe(true); expect(onSaved).not.toHaveBeenCalled();
  surface.handleAction('calendar-event-save'); expect(update).toHaveBeenCalledTimes(1);
  live = true; surface.handleAction('calendar-event-check');
  await vi.waitFor(() => expect(surface.isEditing()).toBe(false));
  expect(onSaved).toHaveBeenCalledWith(saved); expect(update).toHaveBeenCalledTimes(1);
});

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

it('stands aside on a server with no event read, so the listed fields and Reschedule show without an alert', async () => {
  const older = Object.assign(new Error('Unknown rpc method: collection.calendar.event.get'), { code: 'unknown_method' });
  const { surface } = setup({ get: async () => { throw older; } });
  await open(surface);
  expect(surface.render()).toBe('');
  // The Data route offers Reschedule exactly when the surface is neither loading, editable nor editing.
  expect([surface.isLoading(), surface.isEditable(), surface.isEditing(), surface.hasSnapshot()]).toEqual([false, false, false, false]);
  // Any other failure is still shown, with a retry.
  const failing = setup({ get: async () => { throw new Error('Server unreachable'); } });
  await open(failing.surface);
  expect(failing.surface.render()).toContain('Retry event details');
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

const localSnapshot = (): CalendarEventSnapshot => ({ ...snapshot(), deletable: true });
const deleted = (request: CalendarEventDeleteRequest) => ({ slug: request.slug, source_id: request.source_id,
  incarnation: request.expected_incarnation, deleted: true as const });
const checked = (value: CalendarEventSnapshot | null) => ({ slug: 'local', source_id: 'event', incarnation: 'calendar-1', snapshot: value });

it('requires a fresh review and sends one version-bound deletion while navigation waits', async () => {
  let finish!: (value: ReturnType<typeof deleted>) => void;
  const remove = vi.fn((_request: CalendarEventDeleteRequest) => new Promise<ReturnType<typeof deleted>>(resolve => { finish = resolve; }));
  const { surface, onRemoved } = setup({ get: async () => localSnapshot(), delete: remove, checkDeletion: async () => checked(null) });
  await open(surface);
  surface.handleAction('calendar-event-delete-confirm'); expect(remove).not.toHaveBeenCalled();
  surface.handleAction('calendar-event-delete-open'); surface.handleAction('calendar-event-delete-cancel');
  surface.handleAction('calendar-event-delete-confirm'); expect(remove).not.toHaveBeenCalled();
  surface.handleAction('calendar-event-delete-open'); surface.handleAction('calendar-event-delete-confirm');
  surface.handleAction('calendar-event-delete-confirm');
  expect(remove).toHaveBeenCalledExactlyOnceWith({ slug: 'local', source_id: 'event', expected_incarnation: 'calendar-1', expected_version: 'v1' });
  expect(surface.hasInFlightWork()).toBe(true);
  expect(surface.beforeLeave(vi.fn())).toBe(false);
  finish(deleted(remove.mock.calls[0]![0]));
  await vi.waitFor(() => expect(onRemoved).toHaveBeenCalledExactlyOnceWith('cal:local:event', true));
  expect(surface.hasInFlightWork()).toBe(false);
});

it('checks an interrupted deletion without sending it again, retaining a failed check', async () => {
  const remove = vi.fn(async (_request: CalendarEventDeleteRequest) => { throw { code: 'timeout', message: 'Reply lost' }; });
  const check = vi.fn().mockRejectedValueOnce(new Error('Calendar unavailable')).mockResolvedValueOnce(checked(null));
  const { surface, onRemoved } = setup({ get: async () => localSnapshot(), delete: remove, checkDeletion: check });
  await open(surface); surface.handleAction('calendar-event-delete-open'); surface.handleAction('calendar-event-delete-confirm');
  await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false));
  surface.handleAction('calendar-event-delete-confirm');
  expect(remove).toHaveBeenCalledTimes(1); expect(onRemoved).not.toHaveBeenCalled();
  surface.handleAction('calendar-event-delete-check');
  await vi.waitFor(() => expect(surface.render()).toContain('Calendar unavailable'));
  surface.handleAction('calendar-event-delete-confirm'); expect(remove).toHaveBeenCalledTimes(1);
  surface.handleAction('calendar-event-delete-check');
  await vi.waitFor(() => expect(onRemoved).toHaveBeenCalledExactlyOnceWith('cal:local:event', true));
  expect(check.mock.calls).toEqual([[{ slug: 'local', source_id: 'event', expected_incarnation: 'calendar-1' }],
    [{ slug: 'local', source_id: 'event', expected_incarnation: 'calendar-1' }]]);
  expect(remove).toHaveBeenCalledTimes(1);
});

it('refreshes a changed event after a failed deletion and requires another review of its new version', async () => {
  const current = localSnapshot(); current.resource_version = 'v2'; current.event.summary = 'Newer saved details';
  const remove = vi.fn().mockRejectedValueOnce({ code: 'resource_changed', message: 'Event changed' })
    .mockImplementationOnce(async (request: CalendarEventDeleteRequest) => deleted(request));
  const { surface, onSaved, onRemoved } = setup({ get: async () => localSnapshot(), delete: remove, checkDeletion: async () => checked(current) });
  await open(surface); surface.handleAction('calendar-event-delete-open'); surface.handleAction('calendar-event-delete-confirm');
  await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false));
  surface.handleAction('calendar-event-delete-check');
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(current));
  surface.handleAction('calendar-event-delete-confirm'); expect(remove).toHaveBeenCalledTimes(1);
  expect(surface.render()).toContain('Newer saved details');
  surface.handleAction('calendar-event-delete-open'); surface.handleAction('calendar-event-delete-confirm');
  await vi.waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
  expect(remove.mock.calls[1]![0]).toMatchObject({ expected_version: 'v2', expected_incarnation: 'calendar-1' });
});

it('refuses an unbound deletion reply and never treats another calendar as proof of absence', async () => {
  const remove = vi.fn(async (request: CalendarEventDeleteRequest) => ({ ...deleted(request), source_id: 'other-event' }));
  const { surface, onRemoved } = setup({ get: async () => localSnapshot(), delete: remove,
    checkDeletion: async () => ({ ...checked(null), incarnation: 'replacement-calendar' }) });
  await open(surface); surface.handleAction('calendar-event-delete-open'); surface.handleAction('calendar-event-delete-confirm');
  await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false));
  expect(onRemoved).not.toHaveBeenCalled();
  surface.handleAction('calendar-event-delete-check');
  await vi.waitFor(() => expect(surface.render()).toContain('could not confirm the event'));
  surface.handleAction('calendar-event-delete-confirm');
  expect(remove).toHaveBeenCalledTimes(1); expect(onRemoved).not.toHaveBeenCalled();
});

it('keeps old-server and recurring events out of deletion even if its action is invoked directly', async () => {
  const remove = vi.fn(async (request: CalendarEventDeleteRequest) => deleted(request));
  for (const value of [snapshot(), { ...localSnapshot(), event: { ...snapshot().event, is_recurring: true } }]) {
    const { surface } = setup({ get: async () => value, delete: remove, checkDeletion: async () => checked(null) });
    await open(surface); surface.handleAction('calendar-event-delete-open'); surface.handleAction('calendar-event-delete-confirm');
    expect(surface.isDeleting()).toBe(false); surface.dispose();
  }
  expect(remove).not.toHaveBeenCalled();
});

// D-336 (spec §58) — a connected calendar's event is deleted here too. The server says so with
// `provider_delete`, never `deletable`, and words what the delete does; an older client, which
// reads only `deletable`, keeps offering no delete for it.
it('offers a connected event\'s delete in the server\'s words, and none without them', async () => {
  const remote = (): CalendarEventSnapshot => ({ ...snapshot(), event: { ...snapshot().event, calendar_id: 'team', calendar_name: 'Team' },
    provider_verified: true,
    provider_delete: { notice: 'This deletes the event from your Outlook calendar. Outlook sends its guests a cancellation.' } });
  const remove = vi.fn(async (request: CalendarEventDeleteRequest) => deleted(request));
  const { surface, onRemoved } = setup({ get: async () => remote(), delete: remove, checkDeletion: async () => checked(null) });
  await open(surface);
  expect(surface.render()).toContain('calendar-event-delete-open');
  surface.handleAction('calendar-event-delete-open');
  const review = surface.render();
  expect(review).toContain('This deletes the event from your Outlook calendar. Outlook sends its guests a cancellation.');
  expect(review).not.toContain('Guests will not be notified');
  surface.handleAction('calendar-event-delete-confirm');
  expect(remove).toHaveBeenCalledExactlyOnceWith({ slug: 'local', source_id: 'event', expected_incarnation: 'calendar-1', expected_version: 'v1' });
  await vi.waitFor(() => expect(onRemoved).toHaveBeenCalledExactlyOnceWith('cal:local:event', true));
  surface.dispose();
  const plain = setup({ get: async () => ({ ...remote(), provider_delete: undefined }), delete: remove, checkDeletion: async () => checked(null) });
  await open(plain.surface);
  expect(plain.surface.render()).not.toContain('calendar-event-delete-open');
  plain.surface.handleAction('calendar-event-delete-open'); plain.surface.handleAction('calendar-event-delete-confirm');
  expect(remove).toHaveBeenCalledTimes(1);
});

it('ignores a deletion response after disposal', async () => {
  let finish!: (value: ReturnType<typeof deleted>) => void;
  const remove = vi.fn((_request: CalendarEventDeleteRequest) => new Promise<ReturnType<typeof deleted>>(resolve => { finish = resolve; }));
  const { surface, onRemoved } = setup({ get: async () => localSnapshot(), delete: remove, checkDeletion: async () => checked(null) });
  await open(surface); surface.handleAction('calendar-event-delete-open'); surface.handleAction('calendar-event-delete-confirm');
  surface.dispose(); finish(deleted(remove.mock.calls[0]![0]));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(onRemoved).not.toHaveBeenCalled(); expect(surface.render()).toBe('');
});

it('retires an older deletion check when another event opens', async () => {
  let finish!: (value: ReturnType<typeof checked>) => void;
  const { surface, onRemoved } = setup({
    get: async ref => {
      const value = localSnapshot();
      if (ref.source_id === 'event-2') {
        value.event = { ...value.event, source_id: 'event-2', record_id: 'cal:local:event-2', summary: 'Another event' };
        value.record = { ...value.record, source_id: 'event-2', record_id: 'cal:local:event-2' };
      }
      return value;
    },
    delete: async () => { throw { code: 'timeout', message: 'Reply lost' }; },
    checkDeletion: () => new Promise<ReturnType<typeof checked>>(resolve => { finish = resolve; }),
  });
  await open(surface); surface.handleAction('calendar-event-delete-open'); surface.handleAction('calendar-event-delete-confirm');
  await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false));
  surface.handleAction('calendar-event-delete-check');
  expect(surface.beforeLeave(vi.fn())).toBe(true);
  await surface.open({ slug: 'local', source_id: 'event-2' }, 'cal:local:event-2');
  finish(checked(null)); await new Promise(resolve => setTimeout(resolve, 0));
  expect(onRemoved).not.toHaveBeenCalled(); expect(surface.render()).toContain('Another event');
  expect(surface.isDeleting()).toBe(false);
});
