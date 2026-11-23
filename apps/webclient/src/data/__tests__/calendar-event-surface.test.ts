import { expect, it, vi } from 'vitest';
import { CALENDAR_EVENT_EDIT_LIMITS, type CalendarEventSnapshot, type CalendarEventUpdateRequest, type CalendarEventDeleteRequest } from '@recued/contracts';
import { calendarEventDraft, calendarEventPatch, calendarWallClockCandidates, calendarWallClockValue,
  createCalendarEventSurface, CALENDAR_EVENT_FIELD, type CalendarEventOccasionChange } from '../calendar-event-surface.js';

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

it('retires a clipboard result when another calendar event opens and allows the new event to copy', async () => {
  const pending: { text: string; resolve: () => void; reject: () => void }[] = [];
  const document = { defaultView: { navigator: { clipboard: { writeText: (text: string) => new Promise<void>((resolve, reject) => {
    pending.push({ text, resolve, reject: () => reject(new Error('Denied')) });
  }) } } } } as unknown as Document;
  const surface = createCalendarEventSurface({ document, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn(),
    callers: { get: async ref => {
      const value = snapshot();
      return { ...value, event: { ...value.event, source_id: ref.source_id, record_id: `cal:${ref.slug}:${ref.source_id}`, summary: ref.slug },
        record: { ...value.record, source_id: ref.source_id, record_id: `cal:${ref.slug}:${ref.source_id}` } };
    } } });
  await open(surface); surface.handleAction('calendar-event-copy');
  expect(pending[0]?.text).toMatch(/^local\n/);
  await surface.open({ slug: 'work', source_id: 'event' }, 'cal:work:event');
  pending[0]!.reject(); await Promise.resolve(); await Promise.resolve();
  expect(surface.render()).not.toContain('Could not copy.');
  surface.handleAction('calendar-event-copy');
  expect(pending[1]?.text).toMatch(/^work\n/);
  pending[1]!.resolve();
  await vi.waitFor(() => expect(surface.render()).toContain('Event details copied.'));
});

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

const findInput = (field: string, value: string | boolean) => ({
  getAttribute: (key: string) => key === 'data-calendar-time-field' ? field : key === 'data-calendar-time-owner' ? 'calendar-event' : null,
  value, checked: value,
}) as unknown as HTMLElement;
const selectedTimeAction = (surface: ReturnType<typeof createCalendarEventSurface>) =>
  /data-action="(calendar-event-find-pick-[^"]+)"/.exec(surface.render())![1]!;
const findReply = (request: import('@recued/contracts').CalendarOverlapRequest) => ({
  ...request, checked_at: Date.parse('2026-10-28T12:00:00Z'), events: [], truncated: false,
  sources: [{ slug: 'local', name: 'On this server', status: 'local' as const, last_synced_at: null }],
});

it('finds an exact-duration replacement on the event clock, keeps other edits and writes only on Save', async () => {
  const before = snapshot(); before.event.end_at += 12_567;
  const overlaps = vi.fn(async (request: import('@recued/contracts').CalendarOverlapRequest) => findReply(request));
  const update = vi.fn(async (request: CalendarEventUpdateRequest) => ({ ...before, resource_version: 'v2', event: { ...before.event, ...request.patch } }));
  const surface = createCalendarEventSurface({ callers: { get: async () => before, update, overlaps }, actionAttr: 'data-action',
    render: vi.fn(), onSaved: vi.fn(), now: () => Date.parse('2026-10-28T12:00:00Z') });
  await open(surface); surface.handleAction('calendar-event-edit'); surface.handleInput(input('summary', 'Reviewed title'));
  surface.handleInput(input('description', 'My unsaved notes')); surface.handleAction('calendar-event-find-open'); surface.handleAction('calendar-event-find-search');
  await vi.waitFor(() => expect(surface.render()).toContain('6 suggested times'));
  expect(overlaps.mock.calls.every(([request]) => request.timezone === before.event.timezone
    && request.exclude?.source_id === 'event' && request.exclude.expected_incarnation === 'calendar-1')).toBe(true);
  expect(update).not.toHaveBeenCalled(); surface.handleAction(selectedTimeAction(surface)); expect(update).not.toHaveBeenCalled();
  surface.handleAction('calendar-event-save'); await vi.waitFor(() => expect(surface.isEditing()).toBe(false));
  expect(update.mock.calls[0]![0]).toMatchObject({ slug: 'local', source_id: 'event', expected_version: 'v1', expected_incarnation: 'calendar-1',
    patch: { summary: 'Reviewed title', description: 'My unsaved notes', start_at: Date.parse('2026-10-28T16:00:00Z'), end_at: Date.parse('2026-10-28T17:00:12.567Z') } });
  surface.dispose();
});

it('does not offer a time finder for all-day events, missing incarnations, or restricted time fields', async () => {
  const base = snapshot();
  for (const value of [{ ...base, event: { ...base.event, is_all_day: true } }, { ...base, incarnation: null },
    { ...base, editable_fields: ['summary', 'start_at'] as const }, { ...base, editable_fields: ['summary', 'end_at'] as const }]) {
    const { surface } = setup({ get: async () => value as CalendarEventSnapshot, update: vi.fn(async () => base), overlaps: async request => findReply(request) });
    await open(surface); surface.handleAction('calendar-event-edit'); surface.handleAction('calendar-event-find-open');
    expect(surface.render()).not.toContain('Find another time'); surface.dispose();
  }
});

it('keeps the chosen second reading of a repeated hour and an event’s fractional duration', async () => {
  const before = snapshot(); before.event.start_at = Date.parse('2026-11-01T08:15:00Z'); before.event.end_at = Date.parse('2026-11-01T08:45:12.345Z');
  const update = vi.fn(async (request: CalendarEventUpdateRequest) => ({ ...before, event: { ...before.event, ...request.patch } }));
  const surface = createCalendarEventSurface({ callers: { get: async () => before, update, overlaps: async request => findReply(request) },
    actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn(), now: () => Date.parse('2026-11-01T08:50:00Z') });
  await open(surface); surface.handleAction('calendar-event-edit'); surface.handleAction('calendar-event-find-open');
  for (const [key, value] of [['from', '2026-11-01'], ['through', '2026-11-01'], ['workStart', '01:00'], ['workEnd', '03:00'], ['weekdays', false]] as const) surface.handleInput(findInput(key, value));
  surface.handleAction('calendar-event-find-search'); await vi.waitFor(() => expect(surface.render()).toContain('suggested time'));
  surface.handleAction(selectedTimeAction(surface)); surface.handleAction('calendar-event-save');
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]![0].patch).toEqual({ start_at: Date.parse('2026-11-01T09:00:00Z'), end_at: Date.parse('2026-11-01T09:30:12.345Z') }); surface.dispose();
});

it('retires a time search after manual time edits and ignores its old choice without changing the draft', async () => {
  const before = snapshot(); let hold = false, release: (() => void) | undefined;
  const overlaps = async (request: import('@recued/contracts').CalendarOverlapRequest) => { if (hold) { hold = false; await new Promise<void>(done => { release = done; }); } return findReply(request); };
  const update = vi.fn(async (request: CalendarEventUpdateRequest) => ({ ...before, event: { ...before.event, ...request.patch } }));
  const surface = createCalendarEventSurface({ callers: { get: async () => before, update, overlaps }, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn(), now: () => Date.parse('2026-10-28T12:00:00Z') });
  await open(surface); surface.handleAction('calendar-event-edit'); surface.handleAction('calendar-event-find-open'); surface.handleAction('calendar-event-find-search');
  await vi.waitFor(() => expect(surface.render()).toContain('6 suggested times')); const oldChoice = selectedTimeAction(surface);
  surface.handleAction('calendar-event-find-close'); hold = true; surface.handleAction('calendar-event-find-open'); surface.handleAction('calendar-event-find-search');
  expect(release).toBeDefined(); surface.handleInput(input('end', '2026-10-28T11:00')); release!(); await Promise.resolve();
  surface.handleAction(oldChoice); surface.handleAction('calendar-event-save'); await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]![0].patch).toEqual({ end_at: Date.parse('2026-10-28T18:00:00Z') }); surface.dispose();
});

const recoveryMemory = () => {
  const rows = new Map<string, string>(); let fail = false;
  return { fail: (value: boolean) => { fail = value; }, storage: { getItem: (key: string) => { if (fail) throw Error('Unavailable'); return rows.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (fail) throw Error('Full'); rows.set(key, value); }, removeItem: (key: string) => { if (fail) throw Error('Full'); rows.delete(key); } } };
};
const recoverySetup = async () => {
  const { createCalendarEditRecoveryStore } = await import('../calendar-edit-recovery.js');
  const memory = recoveryMemory(), now = () => Date.parse('2026-10-28T12:00Z');
  return { memory, now, store: createCalendarEditRecoveryStore({ scope: 'pair-a', storage: memory.storage, now }) };
};
const recoveryAction = (store: Awaited<ReturnType<typeof recoverySetup>>['store'], operation = 'resume') => {
  const row = store.list()[0]!; return `calendar-event-recovery-${operation}-${row.id}-${row.revision}`;
};

it('flushes and restores incomplete edits with exact repeated-hour choices, then saves against a fresh original version', async () => {
  const { store, now } = await recoverySetup(), before = snapshot(); before.event.start_at = Date.parse('2026-11-01T08:15Z'); before.event.end_at = Date.parse('2026-11-01T08:45:12.345Z');
  const update = vi.fn(async (request: CalendarEventUpdateRequest) => ({ ...before, resource_version: 'v2', event: { ...before.event, ...request.patch } }));
  const make = () => createCalendarEventSurface({ callers: { get: async () => before, update }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
  const first = make(); await open(first); first.handleAction('calendar-event-edit'); first.handleInput(input('summary', 'Kept planning'));
  first.handleInput(input('start', '2026-11-01T01:00')); first.handleInput(input('startChoice', String(Date.parse('2026-11-01T09:00Z'))));
  first.handleInput(input('end', '2026-11-01T01:30:12.345')); first.handleInput(input('endChoice', String(Date.parse('2026-11-01T09:30:12.345Z'))));
  first.dispose(); expect(store.list()).toHaveLength(1);
  const restored = make(); await open(restored); expect(restored.isEditing()).toBe(false); restored.handleAction(recoveryAction(store));
  await vi.waitFor(() => expect(restored.isEditing()).toBe(true)); expect(update).not.toHaveBeenCalled();
  expect(restored.render()).toContain('Kept planning'); restored.handleAction('calendar-event-save'); await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]![0]).toMatchObject({ expected_version: 'v1', expected_incarnation: 'calendar-1',
    patch: { summary: 'Kept planning', start_at: Date.parse('2026-11-01T09:00Z'), end_at: Date.parse('2026-11-01T09:30:12.345Z') } });
  await vi.waitFor(() => expect(store.list()).toEqual([])); restored.dispose();
});

it('keeps copies for review when the original event, connection, or field capability changes', async () => {
  const { store, now } = await recoverySetup(), before = snapshot();
  const first = createCalendarEventSurface({ callers: { get: async () => before, update: vi.fn() }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
  await open(first); first.handleAction('calendar-event-edit'); first.handleInput(input('summary', 'Kept edit')); first.dispose();
  const update = vi.fn();
  for (const value of [{ ...before, resource_version: 'v2', event: { ...before.event, summary: 'Changed elsewhere' } },
    { ...before, incarnation: 'replacement' }, { ...before, provider_verified: true as const, editable_fields: ['description'] as Array<keyof CalendarEventUpdateRequest['patch']> }]) {
    const surface = createCalendarEventSurface({ callers: { get: async () => value, update }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
    await open(surface); surface.handleAction(recoveryAction(store)); await vi.waitFor(() => expect(surface.render()).toMatch(value.resource_version === 'v2' ? /Compare event edits/ : /was replaced|no longer be edited/));
    if (value.resource_version === 'v2') expect(surface.render()).toContain('Changed elsewhere');
    surface.handleAction('calendar-event-save'); expect(surface.isEditing()).toBe(false); expect(store.list()).toHaveLength(1); surface.dispose();
  }
  expect(update).not.toHaveBeenCalled();
});

it('checks an uncertain save after reopening without resubmitting, requiring a live provider read', async () => {
  const { store, now } = await recoverySetup(), before = snapshot(); before.provider_verified = true; before.editable_fields = ['summary', 'description', 'location', 'start_at', 'end_at'];
  let saved = before, live = true;
  const update = vi.fn(async (request: CalendarEventUpdateRequest) => { saved = { ...before, resource_version: 'v2', event: { ...before.event, ...request.patch } }; throw { code: 'timeout' }; });
  const make = () => createCalendarEventSurface({ callers: { get: async () => live ? saved : { ...saved, provider_verified: undefined, editable: false, refresh_error: 'Read interrupted' }, update }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
  const first = make(); await open(first); first.handleAction('calendar-event-edit'); first.handleInput(input('summary', 'Saved through interrupted reply')); first.handleAction('calendar-event-save');
  await vi.waitFor(() => expect(store.list()[0]?.status).toBe('unknown')); first.dispose();
  live = false; const restored = make(); await open(restored); restored.handleAction(recoveryAction(store)); await vi.waitFor(() => expect(restored.render()).toContain('could not verify'));
  expect(store.list()).toHaveLength(1); live = true; restored.handleAction(recoveryAction(store)); await vi.waitFor(() => expect(store.list()).toEqual([]));
  expect(update).toHaveBeenCalledTimes(1); expect(restored.render()).toContain('No changes were sent again'); restored.dispose();
});

it('keeps a pending save locked when its old values are still visible, including after checking in the current editor', async () => {
  const { store, now } = await recoverySetup(), before = snapshot(), update = vi.fn(async () => { throw { code: 'timeout' }; });
  const make = () => createCalendarEventSurface({ callers: { get: async () => before, update }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
  const first = make(); await open(first); first.handleAction('calendar-event-edit'); first.handleInput(input('summary', 'Uncertain title')); first.handleAction('calendar-event-save');
  await vi.waitFor(() => expect(store.list()[0]?.status).toBe('unknown')); first.handleAction('calendar-event-check'); await vi.waitFor(() => expect(first.hasInFlightWork()).toBe(false));
  first.handleAction('calendar-event-save'); expect(update).toHaveBeenCalledTimes(1); first.dispose();
  const restored = make(); await open(restored); restored.handleAction(recoveryAction(store)); await vi.waitFor(() => expect(restored.render()).toContain('earlier save is not confirmed'));
  expect(restored.render()).not.toContain('Compare event edits');
  restored.handleAction('calendar-event-save'); expect(update).toHaveBeenCalledTimes(1); expect(store.list()).toHaveLength(1); restored.dispose();
});

it('fences a recovery read after another event opens and refuses to dispatch when the recovery checkpoint fails', async () => {
  const { store, now, memory } = await recoverySetup(), before = snapshot(), update = vi.fn(async () => before);
  const first = createCalendarEventSurface({ callers: { get: async () => before, update }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
  await open(first); first.handleAction('calendar-event-edit'); first.handleInput(input('summary', 'Keep this')); memory.fail(true); first.handleAction('calendar-event-save'); expect(update).not.toHaveBeenCalled();
  expect(first.render()).toContain('could not be kept before saving'); memory.fail(false); first.dispose();
  let release!: (value: CalendarEventSnapshot) => void, hold = false;
  const surface = createCalendarEventSurface({ callers: { update, get: async ref => { if (hold && ref.source_id === 'event') { hold = false; return new Promise<CalendarEventSnapshot>(done => { release = done; }); }
    return { ...before, event: { ...before.event, source_id: ref.source_id, record_id: `cal:local:${ref.source_id}` }, record: { ...before.record, source_id: ref.source_id, record_id: `cal:local:${ref.source_id}` } }; } },
    recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
  await open(surface); hold = true; surface.handleAction(recoveryAction(store)); expect(release).toBeDefined();
  await surface.open({ slug: 'local', source_id: 'other' }, 'cal:local:other'); release(before); await Promise.resolve();
  expect(surface.isEditing()).toBe(false); expect(store.list()).toHaveLength(1); expect(update).not.toHaveBeenCalled(); surface.dispose();
});

it('keeps the exact latest edit before following the original pending navigation, and ignores a replay', async () => {
  const { store, now } = await recoverySetup(), before = snapshot(), update = vi.fn();
  const surface = createCalendarEventSurface({ callers: { get: async () => before, update }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
  await open(surface); surface.handleAction('calendar-event-edit'); surface.handleInput(input('summary', 'Keep this latest title')); surface.handleInput(input('end', '2026-10-28T10:30:12.567'));
  const leave = vi.fn(() => { expect(store.list()[0]?.values.draft.summary).toBe('Keep this latest title'); }), another = vi.fn();
  expect(surface.beforeLeave(leave)).toBe(false); expect(surface.beforeLeave(another)).toBe(false); expect(surface.render()).toContain('Keep edits for later');
  surface.handleAction('calendar-event-later'); expect(leave).toHaveBeenCalledTimes(1); expect(another).not.toHaveBeenCalled(); expect(surface.isEditing()).toBe(false);
  expect(store.list()[0]?.values.draft.end).toBe('2026-10-28T10:30:12.567'); expect(update).not.toHaveBeenCalled();
  surface.handleAction('calendar-event-later'); expect(leave).toHaveBeenCalledTimes(1); surface.dispose(); expect(store.list()).toHaveLength(1);
});

it('keeps the navigation prompt and draft after a failed checkpoint and resumes only after a confirmed retry', async () => {
  const { store, now, memory } = await recoverySetup(), before = snapshot(), leave = vi.fn(), update = vi.fn();
  const surface = createCalendarEventSurface({ callers: { get: async () => before, update }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
  await open(surface); surface.handleAction('calendar-event-edit'); surface.handleInput(input('description', 'Latest notes')); surface.beforeLeave(leave);
  memory.fail(true); surface.handleAction('calendar-event-later'); expect(leave).not.toHaveBeenCalled(); expect(surface.isEditing()).toBe(true); expect(surface.render()).toContain('latest event edits could not be confirmed');
  memory.fail(false); surface.handleAction('calendar-event-later'); expect(leave).toHaveBeenCalledTimes(1); expect(store.list()[0]?.values.draft.description).toBe('Latest notes'); expect(update).not.toHaveBeenCalled(); surface.dispose();
});

it('keeps recovery copies when cancelling the editor or reloading saved values instead of invoking discard cleanup', async () => {
  for (const action of ['cancel', 'reload'] as const) {
    const { store, now } = await recoverySetup(), before = snapshot(), get = vi.fn(async () => before), update = vi.fn();
    const surface = createCalendarEventSurface({ callers: { get, update }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
    await open(surface); surface.handleAction('calendar-event-edit'); surface.handleInput(input('summary', 'Kept on ' + action)); surface.handleAction('calendar-event-' + action);
    surface.handleAction('calendar-event-later'); await vi.waitFor(() => expect(surface.hasInFlightWork()).toBe(false)); expect(surface.isEditing()).toBe(false);
    expect(store.list()).toHaveLength(1); expect(store.list()[0]?.values.draft.summary).toBe('Kept on ' + action); expect(get).toHaveBeenCalledTimes(action === 'reload' ? 2 : 1); expect(update).not.toHaveBeenCalled(); surface.dispose();
  }
});

it('keeps the unknown save request when leaving and never resends it', async () => {
  const { store, now } = await recoverySetup(), before = snapshot(), update = vi.fn(async () => { throw { code: 'timeout' }; }), leave = vi.fn();
  const surface = createCalendarEventSurface({ callers: { get: async () => before, update }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
  await open(surface); surface.handleAction('calendar-event-edit'); surface.handleInput(input('summary', 'Uncertain save')); surface.handleAction('calendar-event-save');
  await vi.waitFor(() => expect(store.list()[0]?.status).toBe('unknown')); const kept = store.list()[0]; surface.beforeLeave(leave); surface.handleAction('calendar-event-later');
  expect(leave).toHaveBeenCalledTimes(1); expect(store.list()).toEqual([kept]); expect(update).toHaveBeenCalledTimes(1); surface.dispose();
});

it('includes the third choice in keyboard traversal, preserves the outer focus trap, and stays absent without recovery', async () => {
  const { store, now } = await recoverySetup(), before = snapshot();
  const surface = createCalendarEventSurface({ callers: { get: async () => before, update: vi.fn() }, recovery: store, now, actionAttr: 'data-action', render: vi.fn(), onSaved: vi.fn() });
  await open(surface); surface.handleAction('calendar-event-edit'); surface.handleInput(input('summary', 'Dirty')); surface.beforeLeave(vi.fn());
  const keep = { focus: vi.fn() }, later = { focus: vi.fn() }, discard = { focus: vi.fn() };
  const root = { querySelector: (selector: string) => selector.includes('"later"') ? later : selector.includes('"discard"') ? discard : selector.includes('"keep"') ? keep : null } as unknown as HTMLElement;
  const key = (target: unknown, shiftKey = false) => ({ key: 'Tab', target, shiftKey, preventDefault: vi.fn() }) as unknown as KeyboardEvent;
  const middle = key(later); expect(surface.guardKeyDown(middle, root)).toBe(true); expect(middle.preventDefault).toHaveBeenCalledOnce(); expect(discard.focus).toHaveBeenCalledOnce();
  const forward = key(discard); surface.guardKeyDown(forward, root); expect(forward.preventDefault).toHaveBeenCalledOnce(); expect(keep.focus).toHaveBeenCalledOnce();
  const backward = key(keep, true); surface.guardKeyDown(backward, root); expect(backward.preventDefault).toHaveBeenCalledOnce(); expect(discard.focus).toHaveBeenCalledTimes(2); surface.dispose();
  const plain = setup({ update: vi.fn() }); await open(plain.surface); plain.surface.handleAction('calendar-event-edit'); plain.surface.handleInput(input('summary', 'Dirty'));
  const leave = vi.fn(); plain.surface.beforeLeave(leave); expect(plain.surface.render()).not.toContain('Keep edits for later'); plain.surface.handleAction('calendar-event-later'); expect(leave).not.toHaveBeenCalled(); expect(plain.surface.isEditing()).toBe(true); plain.surface.dispose();
});

// D-407 slice 5 (§4.1, Q4, Q5) — the Occasion tick, from the calendar side.
const withOccasion = (occasion: CalendarEventSnapshot['occasion']): CalendarEventSnapshot => ({ ...snapshot(), ...(occasion ? { occasion } : {}) });
const ticked = (html: string, what: string): boolean => new RegExp(`data-calendar-event-occasion="${what}"[^>]* checked`).test(html);

it('D-407 slice 5 — ticking Occasion offers a new one, Private to start; made, the event is read again', async () => {
  let block: CalendarEventSnapshot['occasion'] = { waiting: [] };
  const occasion = vi.fn(async (change: CalendarEventOccasionChange) => {
    block = { owner: { occasion_id: 'occ-1', title: 'Planning', private: 'private' in change && change.private }, waiting: [] };
    return { message: 'Occasion made around this event, Private.' };
  });
  const { surface } = setup({ get: async () => withOccasion(block), occasion });
  await open(surface);
  expect(surface.render()).toContain('data-calendar-event-occasion="tick"');
  expect(ticked(surface.render(), 'tick')).toBe(false);
  expect(surface.render()).not.toContain('Make it an occasion');
  surface.handleAction('calendar-event-occasion-tick');
  expect(ticked(surface.render(), 'tick')).toBe(true);
  expect(ticked(surface.render(), 'private')).toBe(true);
  expect(surface.render()).not.toContain('Which occasion is this?');
  surface.handleAction('calendar-event-occasion-make');
  await vi.waitFor(() => expect(surface.render()).toContain('Occasion: Planning'));
  expect(occasion).toHaveBeenCalledWith({ action: 'occasion.adopt_event', slug: 'local', source_id: 'event', private: true });
  expect(surface.render()).toContain('Occasion made around this event, Private.');
  // Cancelled before it is made, nothing is sent.
  block = { waiting: [] }; await open(surface);
  surface.handleAction('calendar-event-occasion-tick'); surface.handleAction('calendar-event-occasion-cancel');
  expect(surface.render()).not.toContain('Make it an occasion');
  expect(occasion).toHaveBeenCalledTimes(1);
});

it('D-407 slice 5 — with occasions waiting, it asks which: the match chosen first with its privacy, a new one Private', async () => {
  const block = { waiting: [{ occasion_id: 'occ-lee', title: 'Dr. Lee', private: false, match: true as const },
    { occasion_id: 'occ-dent', title: 'Dentist', private: true }] };
  const occasion = vi.fn(async () => ({ message: 'This event is Dentist\'s next one.' }));
  const { surface } = setup({ get: async () => withOccasion(block), occasion });
  await open(surface);
  surface.handleAction('calendar-event-occasion-tick');
  const html = surface.render();
  expect(html).toContain('Which occasion is this?');
  expect(html).toContain('Dr. Lee: its next one (its organizer or place matches)');
  expect(ticked(html, 'which-occ-lee')).toBe(true);
  expect(ticked(html, 'which-new')).toBe(false);
  // The match is Shown by name, and Private follows it; a new occasion starts Private.
  expect(ticked(html, 'private')).toBe(false);
  surface.handleAction('calendar-event-occasion-which-new');
  expect(ticked(surface.render(), 'private')).toBe(true);
  surface.handleAction('calendar-event-occasion-which-occ-dent');
  expect(ticked(surface.render(), 'which-occ-dent')).toBe(true);
  surface.handleAction('calendar-event-occasion-make');
  await vi.waitFor(() => expect(occasion).toHaveBeenCalledTimes(1));
  expect(occasion).toHaveBeenCalledWith({ action: 'occasion.adopt_event', slug: 'local', source_id: 'event', occasion_id: 'occ-dent', private: true });
  // None matching: a new occasion is chosen first.
  const { surface: plain } = setup({ get: async () => withOccasion({ waiting: [{ occasion_id: 'occ-dent', title: 'Dentist', private: true }] }) });
  await open(plain); plain.handleAction('calendar-event-occasion-tick');
  expect(ticked(plain.render(), 'which-new')).toBe(true);
});

it('D-407 slice 5 — held: Private changes its privacy, unticking lets the event go; an occasion\'s own event is changed in Yours', async () => {
  let block: CalendarEventSnapshot['occasion'] = { owner: { occasion_id: 'occ-1', title: 'Dr. Lee', private: true }, waiting: [] };
  const occasion = vi.fn(async () => ({ message: 'Done.' }));
  const { surface } = setup({ get: async () => withOccasion(block), occasion });
  await open(surface);
  expect(ticked(surface.render(), 'tick')).toBe(true);
  expect(ticked(surface.render(), 'private')).toBe(true);
  surface.handleAction('calendar-event-occasion-private');
  await vi.waitFor(() => expect(occasion).toHaveBeenCalledTimes(1));
  expect(occasion).toHaveBeenLastCalledWith({ action: 'occasion.adopt_event', slug: 'local', source_id: 'event', occasion_id: 'occ-1', private: false });
  await vi.waitFor(() => expect(surface.render()).toContain('Done.'));
  surface.handleAction('calendar-event-occasion-tick');
  await vi.waitFor(() => expect(occasion).toHaveBeenCalledTimes(2));
  expect(occasion).toHaveBeenLastCalledWith({ action: 'occasion.release_event', slug: 'local', source_id: 'event' });
  block = { owner: { occasion_id: 'occ-2', title: 'Haircut', private: false, written_by_occasion: true }, waiting: [] };
  await open(surface);
  expect(surface.render()).toContain('This is the event of the occasion Haircut, which Recued writes. Change it in Yours.');
  expect(surface.render()).not.toContain('data-calendar-event-occasion="tick"');
  surface.handleAction('calendar-event-occasion-tick');
  expect(occasion).toHaveBeenCalledTimes(2);
});

it('D-407 slice 5 — no tick where the server sends no block: an older server, or an event no occasion may hold', async () => {
  const { surface } = setup({ get: async () => withOccasion(undefined), occasion: vi.fn() }); await open(surface);
  expect(surface.render()).not.toContain('calendar-event-occasion');
  expect(surface.handleAction('calendar-event-occasion-tick')).toBe(true);
});

it('D-407 slice 5 — a refused change is said, the choice kept open to try again', async () => {
  const occasion = vi.fn(async () => { throw new Error('That event belongs to Dr. Lee already'); });
  const { surface } = setup({ get: async () => withOccasion({ waiting: [] }), occasion });
  await open(surface);
  surface.handleAction('calendar-event-occasion-tick'); surface.handleAction('calendar-event-occasion-make');
  await vi.waitFor(() => expect(surface.render()).toMatch(/calendar-event-occasion[\s\S]*role="alert"/));
  expect(surface.render()).toContain('Make it an occasion');
  expect(surface.render()).not.toMatch(/occasion-make"[^>]* disabled/);
});
