import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CalendarAdapterError, type CalendarEventUpdateRequest, type CalendarEventCreateRequest } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createBlobStore } from '../../../storage/blob-store.js';
import { createInstanceStore } from '../../instance-store.js';
import { createCalendarCollection, type CalendarCollection } from '../calendar-collection.js';
import { createLocalCalendarProvider, LOCAL_CALENDAR_CAPS } from '../local-provider.js';
import type { CalendarProvider, ProviderEventEditContext, ProviderEventPayload } from '../provider.js';
import { getOwnerCalendarEvent } from '../invitation-handler.js';
import { checkOwnerCalendarEventDeletion, deleteOwnerCalendarEvent, updateOwnerCalendarEvent } from '../remote-event-handler.js';
import { createOwnerCalendarEvent, listCalendarEventDestinations } from '../event-create-handler.js';
import { createCalendarEventCreationStore } from '../../../storage/calendar-event-creations.js';

const NOW = Date.parse('2026-10-30T16:00:00Z');
const ref = { slug: 'work', source_id: 'event-1' };
let db: Database.Database, dir: string, collection: CalendarCollection, provider: CalendarProvider;
let instances: ReturnType<typeof createInstanceStore>, remote: ProviderEventPayload;
let context: Omit<ProviderEventEditContext, 'payload'>;
/** The calendar has deleted the event: it answers a read with "not found". */
let removed = false;
const deps = () => ({ instances, getCollection: (slug: string) => slug === 'work' ? collection : undefined });
const request = async (patch: CalendarEventUpdateRequest['patch'] = { summary: 'Customer review' }): Promise<CalendarEventUpdateRequest> => {
  const view = await getOwnerCalendarEvent(deps(), ref);
  return { ...ref, expected_version: view.resource_version, expected_incarnation: view.incarnation!, patch };
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'calendar-remote-edit-')); db = new Database(':memory:');
  instances = createInstanceStore({ db });
  instances.upsert({ platform: 'calendar', slug: 'work', adapter_type: 'gcal', config: {}, caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: NOW });
  remote = { etag: '"e1"', description_bytes: 6, event: { source_id: 'event-1', ical_uid: 'meeting@example.com', calendar_id: 'team', calendar_name: 'Team',
    summary: 'Planning', description: 'Agenda', location: 'Room 2', start_at: NOW, end_at: NOW + 3_600_000,
    timezone: 'America/Los_Angeles', is_all_day: false, status: 'confirmed', created_at: NOW - 1, updated_at: NOW,
    organizer: { email: 'me@example.com' }, attendees: [{ email: 'guest@example.com', response_status: 'accepted' }],
    conference_url: 'https://meeting.example.com/original', reminders: [{ method: 'popup', minutes: 15 }] } };
  context = { editable_fields: ['summary', 'description', 'location', 'start_at', 'end_at'], edit_notice: 'Changes are saved to Team.' };
  removed = false;
  provider = { ...createLocalCalendarProvider({ slug: 'work', now: () => NOW, readEvent: () => null }), kind: 'gcal', accountEmail: 'me@example.com',
    readEventForEdit: vi.fn(async () => {
      if (removed) throw new CalendarAdapterError('event_not_found', 'Gone');
      return { ...context, payload: structuredClone(remote) };
    }),
    deleteEvent: vi.fn(async input => {
      input.before_send?.();
      if (input.expected_etag !== remote.etag) throw new CalendarAdapterError('version_conflict', 'Changed');
      removed = true;
    }),
    updateEvent: vi.fn(async input => {
      input.before_send?.();
      if (input.expected_etag !== remote.etag) throw new CalendarAdapterError('version_conflict', 'Changed');
      remote = { ...remote, etag: '"e2"', event: { ...remote.event, ...input.patch, updated_at: NOW + 1 } };
      return structuredClone(remote);
    }),
  };
  collection = createCalendarCollection({ db, slug: 'work', provider, bus: createWarehouseEventBus(), blobs: createBlobStore(join(dir, 'blobs')),
    gate: createStorageGate({ quota: 1024 * 1024, reservePct: 10, surface: 'collection:calendar:work' }),
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024, expansion_past_days: 30, expansion_future_days: 90 }) });
  await collection.applyVerifiedUpsert(remote);
});
afterEach(async () => { await collection?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }); });

it('writes only supported fields to the original calendar and preserves event, guest and conference identity', async () => {
  const create = vi.spyOn(provider, 'createEvent'), remove = vi.spyOn(provider, 'deleteEvent');
  const original = structuredClone(remote.event), input = await request({ summary: 'Customer review', end_at: NOW + 5_400_000 });
  const saved = await updateOwnerCalendarEvent(deps(), input);
  expect(saved).toMatchObject({ editable: true, provider_verified: true, event: { source_id: 'event-1', calendar_id: 'team', summary: 'Customer review', end_at: input.patch.end_at } });
  expect(provider.updateEvent).toHaveBeenCalledWith(expect.objectContaining({ calendar_id: 'team', source_id: 'event-1', expected_etag: '"e1"', notify_attendees: true,
    patch: { summary: 'Customer review', end_at: NOW + 5_400_000, timezone: original.timezone, is_all_day: false } }));
  expect(collection.table.get('event-1')?.event).toMatchObject({ ical_uid: original.ical_uid, organizer: original.organizer,
    attendees: original.attendees, conference_url: original.conference_url, reminders: original.reminders });
  expect(create).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});

it('refuses calendar switching and fields the live provider cannot preserve', async () => {
  const input = await request();
  for (const patch of [{ calendar_id: 'local' }, { slug: 'local' }, { attendees: [] }, { is_all_day: true }, { recurrence_rule: 'FREQ=DAILY' }]) {
    await expect(updateOwnerCalendarEvent(deps(), { ...input, patch: { ...input.patch, ...patch } })).rejects.toMatchObject({ code: 'invalid_args' });
  }
  context.editable_fields = ['summary', 'location', 'start_at', 'end_at'];
  await expect(updateOwnerCalendarEvent(deps(), { ...input, patch: { description: 'Flattened notes' } })).rejects.toMatchObject({ code: 'forbidden' });
  expect(provider.updateEvent).not.toHaveBeenCalled(); expect(remote.event.calendar_id).toBe('team');
});

it('uses current connection and event permissions rather than a previous writable view', async () => {
  const input = await request();
  context.read_only_reason = 'The organizer has locked this event.'; context.editable_fields = [];
  expect((await getOwnerCalendarEvent(deps(), ref)).editable).toBe(false);
  await expect(updateOwnerCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'forbidden' });
  delete context.read_only_reason; context.editable_fields = ['summary'];
  instances.updateCaps('calendar', 'work', { ...LOCAL_CALENDAR_CAPS, update_event: 'no' });
  await expect(updateOwnerCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'forbidden' });
  instances.updateCaps('calendar', 'work', LOCAL_CALENDAR_CAPS); instances.updateAuthState('calendar', 'work', { auth_state: 'expired' });
  await expect(updateOwnerCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'forbidden' });
  expect(provider.updateEvent).not.toHaveBeenCalled();
});

it('refreshes a provider change into the mirror and rejects the stale draft without overwriting it', async () => {
  const input = await request(); remote.event.summary = 'Changed elsewhere'; remote.etag = '"new"';
  await expect(updateOwnerCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'resource_changed' });
  expect(collection.table.get('event-1')?.event.summary).toBe('Changed elsewhere');
  expect(provider.updateEvent).not.toHaveBeenCalled();
});

it('returns plain owner copy when the provider rejects a version changed after the fresh read', async () => {
  const input = await request();
  vi.mocked(provider.updateEvent).mockImplementationOnce(async args => {
    args.before_send?.();
    remote = { ...remote, etag: '"new"', event: { ...remote.event, summary: 'Changed elsewhere' } };
    throw new CalendarAdapterError('version_conflict', 'HTTP 412 Precondition Failed: provider version mismatch');
  });
  await expect(updateOwnerCalendarEvent(deps(), input)).rejects.toMatchObject({
    code: 'resource_conflict', status: 409,
    message: 'This event changed in its calendar. Check the saved event before trying again.',
  });
  expect(provider.updateEvent).toHaveBeenCalledTimes(1);
  expect(collection.table.get(ref.source_id)?.event.summary).toBe('Planning');
  expect((await getOwnerCalendarEvent(deps(), ref)).event.summary).toBe('Changed elsewhere');
});

it('recovers a lost remote acknowledgement as a read without resending the update', async () => {
  const input = await request();
  const update = provider.updateEvent;
  vi.mocked(provider.updateEvent).mockImplementationOnce(async args => {
    args.before_send?.(); remote = { ...remote, etag: '"e2"', event: { ...remote.event, ...args.patch, updated_at: NOW + 1 } };
    throw new CalendarAdapterError('io_error', 'Acknowledgement lost');
  });
  await expect(updateOwnerCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'upstream_error' });
  expect(collection.table.get('event-1')?.event.summary).toBe('Planning');
  const checked = await getOwnerCalendarEvent(deps(), ref);
  expect(checked).toMatchObject({ provider_verified: true, event: { summary: 'Customer review', calendar_id: 'team' } });
  const recovered = await updateOwnerCalendarEvent(deps(), input);
  expect(recovered.event.summary).toBe('Customer review'); expect(update).toHaveBeenCalledTimes(1);
});

it('blocks concurrent edits and rechecks permission at the provider handoff', async () => {
  const input = await request();
  let sent = false;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(provider.updateEvent).mockImplementationOnce(async args => {
    entered(); await new Promise<void>(resolve => { release = resolve; }); args.before_send!(); sent = true; return remote;
  });
  const saving = updateOwnerCalendarEvent(deps(), input); await started;
  await expect(updateOwnerCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'conflict' });
  instances.updateCaps('calendar', 'work', { ...LOCAL_CALENDAR_CAPS, update_event: 'no' }); release();
  await expect(saving).rejects.toMatchObject({ code: 'forbidden' });
  expect(sent).toBe(false);
  expect(collection.table.get('event-1')?.event.summary).toBe('Planning'); expect(provider.updateEvent).toHaveBeenCalledTimes(1);
});

it('fences a replacement connection and rejects cached confirmation after a provider read fails', async () => {
  const input = await request();
  vi.mocked(provider.readEventForEdit!).mockRejectedValueOnce(new CalendarAdapterError('io_error', 'Offline'));
  await expect(updateOwnerCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'upstream_error' });
  const prior = instances.get('calendar', 'work')!; instances.delete('calendar', 'work'); instances.upsert(prior);
  await expect(updateOwnerCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'resource_changed' });
  expect(provider.updateEvent).not.toHaveBeenCalled();
});

const meeting = (): CalendarEventCreateRequest => ({ slug: 'work', calendar_id: 'team',
  expected_incarnation: instances.getIncarnation!('calendar', 'work')!,
  creation_id: '7865c879-d028-4093-bbd3-107986e7841d', summary: 'New meeting', description: 'Agenda', location: 'Room 2',
  start_at: NOW, end_at: NOW + 3_600_000, timezone: 'America/Los_Angeles', is_all_day: false,
  guests: [{ email: 'Ada@Example.com', display_name: 'Ada' }, { email: 'ada@example.com' }], send_invitations: true });
const invitationPayload = (event: Parameters<CalendarProvider['createEvent']>[1]): ProviderEventPayload => ({
  event: { ...remote.event, source_id: 'created-meeting', ical_uid: 'created-meeting@example.com',
    summary: event.summary, description: event.description, location: event.location,
    start_at: event.start_at, end_at: event.end_at, timezone: event.timezone, is_all_day: event.is_all_day,
    attendees: event.attendees }, description_bytes: Buffer.byteLength(event.description ?? ''),
});

it('creates only the reviewed guests once and recovers a completed invitation without sending again', async () => {
  provider.listWritableCalendars = vi.fn(async () => [{ calendar_id: 'team', name: 'Team', can_invite: true as const }]);
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const write = vi.spyOn(provider, 'createEvent').mockImplementation(async (_calendar, event, beforeSend) => {
    await held; beforeSend?.(); return invitationPayload(event);
  });
  const input = meeting(), store = createCalendarEventCreationStore(db);
  expect((await listCalendarEventDestinations(deps())).destinations[0]?.can_invite).toBe(true);
  const first = createOwnerCalendarEvent(deps(), store, input);
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  await expect(createOwnerCalendarEvent(deps(), store, input)).rejects.toMatchObject({ code: 'outcome_unknown' });
  release(); const saved = await first;
  expect(write.mock.calls[0]?.[1]).toMatchObject({ send_invitations: true,
    attendees: [{ email: 'ada@example.com', display_name: 'Ada', response_status: 'needs_action' }] });
  expect(saved.invitations_requested).toBe(true);
  expect(saved.snapshot.event.attendees).toEqual([{ email: 'ada@example.com', display_name: 'Ada', response_status: 'needs_action' }]);
  provider.listWritableCalendars = vi.fn(async () => []);
  expect(await createOwnerCalendarEvent(deps(), createCalendarEventCreationStore(db), input)).toEqual(saved);
  await expect(createOwnerCalendarEvent(deps(), store, { ...input, guests: [{ email: 'different@example.com' }] }))
    .rejects.toMatchObject({ code: 'conflict' });
  expect(write).toHaveBeenCalledTimes(1);
});

it('rechecks invitation capability before claiming a save and refuses unreviewed recipients', async () => {
  const write = vi.spyOn(provider, 'createEvent');
  provider.listWritableCalendars = vi.fn(async () => [{ calendar_id: 'team', name: 'Team', can_invite: true as const }]);
  expect((await listCalendarEventDestinations(deps())).destinations[0]?.can_invite).toBe(true);
  provider.listWritableCalendars = vi.fn(async () => [{ calendar_id: 'team', name: 'Team' }]);
  const input = meeting(), store = createCalendarEventCreationStore(db);
  await expect(createOwnerCalendarEvent(deps(), store, input)).rejects.toMatchObject({ code: 'forbidden' });
  expect(store.get(input.creation_id)).toBeUndefined();
  provider.listWritableCalendars = vi.fn(async () => [{ calendar_id: 'team', name: 'Team', can_invite: true as const }]);
  await expect(createOwnerCalendarEvent(deps(), store, { ...input, send_invitations: undefined })).rejects.toMatchObject({ code: 'invalid_args' });
  await expect(createOwnerCalendarEvent(deps(), store, { ...input, guests: [{ email: 'ada@example.com, hidden@example.com' }] }))
    .rejects.toMatchObject({ code: 'invalid_args' });
  await expect(createOwnerCalendarEvent(deps(), store, { ...input, guests: [{ email: 'ada@example.com\r\nBcc: hidden@example.com' }] }))
    .rejects.toMatchObject({ code: 'invalid_args' });
  await expect(createOwnerCalendarEvent(deps(), store, { ...input, guests: [{ email: 'ada@example.com;' }] }))
    .rejects.toMatchObject({ code: 'invalid_args' });
  expect(store.get(input.creation_id)).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});

it('keeps an invitation save uncertain when the provider did not acknowledge the reviewed guests', async () => {
  provider.listWritableCalendars = vi.fn(async () => [{ calendar_id: 'team', name: 'Team', can_invite: true as const }]);
  const write = vi.spyOn(provider, 'createEvent').mockImplementation(async (_calendar, event, beforeSend) => {
    beforeSend?.(); const payload = invitationPayload(event); delete payload.event.attendees; return payload;
  });
  const input = meeting(), store = createCalendarEventCreationStore(db);
  await expect(createOwnerCalendarEvent(deps(), store, input)).rejects.toMatchObject({ code: 'outcome_unknown' });
  const reopened = new Database(db.serialize());
  try { await expect(createOwnerCalendarEvent(deps(), createCalendarEventCreationStore(reopened), input)).rejects.toMatchObject({ code: 'outcome_unknown' }); }
  finally { reopened.close(); }
  expect(write).toHaveBeenCalledTimes(1);
});

// D-336 (spec §58) — Data → Calendar's Delete was local-only: nothing in it could delete a Google,
// Outlook or CalDAV event.
const deletion = async () => {
  const view = await getOwnerCalendarEvent(deps(), ref);
  return { ...ref, expected_version: view.resource_version, expected_incarnation: view.incarnation! };
};

it('deletes an event the owner organizes from its connected calendar, the reviewed version, telling its guests', async () => {
  const view = await getOwnerCalendarEvent(deps(), ref);
  expect(view).toMatchObject({ provider_verified: true,
    provider_delete: { notice: 'This deletes the event from your Google calendar and emails its guests that it is cancelled.' } });
  expect(view.deletable).toBeUndefined();
  const input = { ...ref, expected_version: view.resource_version, expected_incarnation: view.incarnation! };
  expect(await deleteOwnerCalendarEvent(deps(), input)).toEqual({ ...ref, incarnation: input.expected_incarnation, deleted: true });
  expect(provider.deleteEvent).toHaveBeenCalledExactlyOnceWith({ calendar_id: 'team', source_id: 'event-1', scope: 'this_instance',
    expected_etag: '"e1"', notify_attendees: true, before_send: expect.any(Function) });
  expect(collection.table.get('event-1')).toBeNull();
  expect(await checkOwnerCalendarEventDeletion(deps(), input)).toEqual({ ...ref, incarnation: input.expected_incarnation, snapshot: null });
});

it('says what a delete does: Google emails guests unless it was told not to, Outlook tells them itself', async () => {
  const notice = async () => (await getOwnerCalendarEvent(deps(), ref)).provider_delete?.notice;
  context.notify_attendees = false;
  expect(await notice()).toBe('This deletes the event from your Google calendar.');
  delete context.notify_attendees;
  const reconnect = (kind: 'graph' | 'caldav') => {
    Object.defineProperty(collection.provider, 'kind', { value: kind });
    instances.upsert({ platform: 'calendar', slug: 'work', adapter_type: kind, config: {}, caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: NOW });
  };
  reconnect('graph');
  expect(await notice()).toBe('This deletes the event from your Outlook calendar. Outlook sends its guests a cancellation.');
  remote.event.attendees = [];
  expect(await notice()).toBe('This deletes the event from your Outlook calendar.');
  reconnect('caldav');
  expect(await notice()).toBe('This deletes the event from your calendar server.');
});

it('offers no delete for an invitation, a recurring or locked event, or a connection that may not delete', async () => {
  remote.event.organizer = { email: 'boss@example.com' };
  expect((await getOwnerCalendarEvent(deps(), ref)).provider_delete).toBeUndefined();
  await expect(deleteOwnerCalendarEvent(deps(), await deletion())).rejects.toMatchObject({ code: 'forbidden' });
  remote.event.organizer = { email: 'me@example.com' }; remote.event.recurrence_rule = 'FREQ=WEEKLY';
  expect((await getOwnerCalendarEvent(deps(), ref)).provider_delete).toBeUndefined();
  delete remote.event.recurrence_rule; context.read_only_reason = 'Google has locked this event’s details.';
  expect((await getOwnerCalendarEvent(deps(), ref)).provider_delete).toBeUndefined();
  delete context.read_only_reason;
  expect((await getOwnerCalendarEvent(deps(), ref)).provider_delete).toBeDefined();
  instances.updateCaps('calendar', 'work', { ...LOCAL_CALENDAR_CAPS, delete_event: 'no' });
  expect((await getOwnerCalendarEvent(deps(), ref)).provider_delete).toBeUndefined();
  await expect(deleteOwnerCalendarEvent(deps(), await deletion())).rejects.toMatchObject({ code: 'forbidden' });
  expect(provider.deleteEvent).not.toHaveBeenCalled();
});

it('refuses a version changed since the review, in Recued or in the calendar', async () => {
  const input = await deletion(); remote.event.summary = 'Changed elsewhere'; remote.etag = '"new"';
  await expect(deleteOwnerCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'resource_changed' });
  expect(provider.deleteEvent).not.toHaveBeenCalled();
  expect(collection.table.get('event-1')?.event.summary).toBe('Changed elsewhere');
  vi.mocked(provider.deleteEvent).mockImplementationOnce(async args => {
    args.before_send?.(); throw new CalendarAdapterError('version_conflict', 'HTTP 412 Precondition Failed');
  });
  await expect(deleteOwnerCalendarEvent(deps(), await deletion()))
    .rejects.toMatchObject({ code: 'resource_conflict', status: 409, message: 'This event changed in its calendar.' });
  expect(collection.table.get('event-1')?.event.summary).toBe('Changed elsewhere');
});

it('rechecks the connection at the provider handoff, and blocks a second delete while one is in flight', async () => {
  const input = await deletion();
  let sent = false, release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(provider.deleteEvent).mockImplementationOnce(async args => {
    entered(); await new Promise<void>(resolve => { release = resolve; }); args.before_send!(); sent = true;
  });
  const deleting = deleteOwnerCalendarEvent(deps(), input); await started;
  await expect(deleteOwnerCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'conflict' });
  instances.updateCaps('calendar', 'work', { ...LOCAL_CALENDAR_CAPS, delete_event: 'no' }); release();
  await expect(deleting).rejects.toMatchObject({ code: 'forbidden' });
  expect(sent).toBe(false); expect(collection.table.get('event-1')).not.toBeNull();
});

it('recovers a lost acknowledgement by a check, never by a second delete', async () => {
  const input = await deletion();
  vi.mocked(provider.deleteEvent).mockImplementationOnce(async args => {
    args.before_send?.(); removed = true; throw new CalendarAdapterError('io_error', 'Acknowledgement lost');
  });
  await expect(deleteOwnerCalendarEvent(deps(), input))
    .rejects.toMatchObject({ code: 'upstream_error', message: 'The calendar could not confirm the deletion.' });
  expect(collection.table.get('event-1')).not.toBeNull();
  expect(await checkOwnerCalendarEventDeletion(deps(), input)).toEqual({ ...ref, incarnation: input.expected_incarnation, snapshot: null });
  expect(collection.table.get('event-1')).toBeNull();
  expect(provider.deleteEvent).toHaveBeenCalledTimes(1);
});

it('a check proves nothing from a calendar it cannot read, and counts a Google event read back as cancelled as gone', async () => {
  const input = await deletion();
  vi.mocked(provider.readEventForEdit!).mockRejectedValueOnce(new CalendarAdapterError('io_error', 'Offline'));
  await expect(checkOwnerCalendarEventDeletion(deps(), input)).rejects.toMatchObject({ code: 'upstream_error' });
  vi.mocked(provider.readEventForEdit!).mockRejectedValueOnce(new CalendarAdapterError('calendar_not_found', 'No calendar'));
  await expect(checkOwnerCalendarEventDeletion(deps(), input)).rejects.toMatchObject({ code: 'upstream_error' });
  expect((await checkOwnerCalendarEventDeletion(deps(), input)).snapshot).toMatchObject({ provider_verified: true, event: { source_id: 'event-1' } });
  remote.event.status = 'cancelled';
  expect((await checkOwnerCalendarEventDeletion(deps(), input)).snapshot).toBeNull();
  expect(collection.table.get('event-1')).toBeNull();
  const prior = instances.get('calendar', 'work')!; instances.delete('calendar', 'work'); instances.upsert(prior);
  await expect(checkOwnerCalendarEventDeletion(deps(), input)).rejects.toMatchObject({ code: 'resource_changed' });
  expect(provider.deleteEvent).not.toHaveBeenCalled();
});
