import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CalendarAdapterError, type CalendarEventUpdateRequest } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createBlobStore } from '../../../storage/blob-store.js';
import { createInstanceStore } from '../../instance-store.js';
import { createCalendarCollection, type CalendarCollection } from '../calendar-collection.js';
import { createLocalCalendarProvider, LOCAL_CALENDAR_CAPS } from '../local-provider.js';
import type { CalendarProvider, ProviderEventEditContext, ProviderEventPayload } from '../provider.js';
import { getOwnerCalendarEvent } from '../invitation-handler.js';
import { updateOwnerCalendarEvent } from '../remote-event-handler.js';

const NOW = Date.parse('2026-10-30T16:00:00Z');
const ref = { slug: 'work', source_id: 'event-1' };
let db: Database.Database, dir: string, collection: CalendarCollection, provider: CalendarProvider;
let instances: ReturnType<typeof createInstanceStore>, remote: ProviderEventPayload;
let context: Omit<ProviderEventEditContext, 'payload'>;
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
  provider = { ...createLocalCalendarProvider({ slug: 'work', now: () => NOW, readEvent: () => null }), kind: 'gcal', accountEmail: 'me@example.com',
    readEventForEdit: vi.fn(async () => ({ ...context, payload: structuredClone(remote) })),
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
