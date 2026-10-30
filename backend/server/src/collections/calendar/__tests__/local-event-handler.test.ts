import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type CanonicalEvent, type CalendarEventUpdateRequest, type CalendarEventCreateRequest } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createBlobStore } from '../../../storage/blob-store.js';
import { createInstanceStore } from '../../instance-store.js';
import { createCollectionRegistry } from '../../registry.js';
import { makeCollectionHandlers } from '../../collection-handler.js';
import type { WsClient } from '../../../ws-server.js';
import { createCalendarCollection, type CalendarCollection } from '../calendar-collection.js';
import { createLocalCalendarProvider, LOCAL_CALENDAR_CAPS } from '../local-provider.js';
import { getCalendarEvent, updateCalendarEvent } from '../local-event-handler.js';
import { createOwnerCalendarEvent, listCalendarEventDestinations } from '../event-create-handler.js';
import { createCalendarEventCreationStore } from '../../../storage/calendar-event-creations.js';

const NOW = Date.parse('2026-10-28T16:00:00Z');
const ref = { slug: 'local', source_id: 'event-1' };
let db: Database.Database;
let dir: string;
let collection: CalendarCollection;
let instances: ReturnType<typeof createInstanceStore>;
let events: unknown[];
const deps = () => ({ instances, getCollection: (slug: string) => slug === 'local' ? collection : undefined, now: () => NOW + 10_000 });
const base: CanonicalEvent = {
  source_id: ref.source_id, ical_uid: 'event-1@local.recued', calendar_id: 'local',
  summary: 'Planning', description: 'Bring the agenda', location: 'Room 2',
  start_at: NOW, end_at: NOW + 3_600_000, timezone: 'America/Los_Angeles',
  is_all_day: false, status: 'confirmed', created_at: NOW - 1_000, updated_at: NOW,
};
const seed = async (patch: Partial<CanonicalEvent> = {}) => collection.applyVerifiedUpsert({
  event: { ...base, ...patch }, description_bytes: Buffer.byteLength(patch.description ?? base.description!),
});
const request = (patch: CalendarEventUpdateRequest['patch']): CalendarEventUpdateRequest => {
  const view = getCalendarEvent(deps(), ref);
  return { ...ref, patch, expected_version: view.resource_version, expected_incarnation: view.incarnation! };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'calendar-editor-'));
  db = new Database(':memory:');
  instances = createInstanceStore({ db });
  instances.upsert({ platform: 'calendar', slug: 'local', adapter_type: 'local', config: {},
    caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: null });
  const provider = createLocalCalendarProvider({ slug: 'local', now: () => NOW + 10_000,
    readEvent: id => collection.table.get(id)?.event ?? null });
  const bus = createWarehouseEventBus(); events = [];
  bus.subscribe('**', event => { events.push(event); });
  collection = createCalendarCollection({ db, slug: 'local', provider, bus,
    blobs: createBlobStore(join(dir, 'blobs')),
    gate: createStorageGate({ quota: 1024 * 1024, reservePct: 10, surface: 'collection:calendar:local' }),
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024,
      expansion_past_days: 30, expansion_future_days: 90 }),
  });
  await seed(); events.length = 0;
});
afterEach(async () => { await collection?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }); });

it('saves through the local dispatcher and publishes the canonical change without changing identity', async () => {
  const input = request({ summary: 'Customer planning', location: '', description: 'New notes', end_at: NOW + 5_400_000 });
  const saved = await updateCalendarEvent(deps(), input);
  expect(saved.event).toMatchObject({ summary: 'Customer planning', location: '', description: 'New notes',
    start_at: NOW, end_at: NOW + 5_400_000, timezone: base.timezone, is_all_day: false });
  expect(saved.resource_version).not.toBe(input.expected_version);
  expect(collection.table.get(ref.source_id)?.event).toMatchObject({ source_id: base.source_id, ical_uid: base.ical_uid,
    calendar_id: base.calendar_id, created_at: base.created_at, updated_at: NOW + 10_000 });
  expect(events).toHaveLength(1);
  await expect(updateCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'resource_changed' });
  expect(events).toHaveLength(1);
});

it('reads the full stored description across the blob boundary and can explicitly clear it', async () => {
  const text = 'Calendar notes. '.repeat(6000);
  await seed({ description: text });
  expect(collection.table.get(ref.source_id)?.blob_hash).toBeTruthy();
  const view = getCalendarEvent(deps(), ref);
  expect(view.event.description).toBe(text);
  expect(view.record.blob_hash).toBe(collection.table.get(ref.source_id)?.blob_hash);
  expect(view.record.body_inline).toBeUndefined();
  const saved = await updateCalendarEvent(deps(), request({ description: '' }));
  expect(saved.event.description).toBe('');
  expect(saved.record.blob_hash).toBeUndefined();
  expect(saved.record.body_inline).toBeUndefined();
  expect(saved.record.size_bytes).toBe(0);
  expect(collection.table.get(ref.source_id)?.blob_hash).toBeNull();
});

it('uses exclusive UTC day boundaries for multi-day all-day events', async () => {
  const start = Date.parse('2026-11-01T00:00:00Z');
  await seed({ is_all_day: true, timezone: 'Unknown/Zone', start_at: start, end_at: start + 2 * 86_400_000 });
  const input = request({ start_at: start + 86_400_000, end_at: start + 4 * 86_400_000 });
  await expect(updateCalendarEvent(deps(), { ...input, patch: { start_at: start + 3_600_000 } })).rejects.toMatchObject({ code: 'invalid_args' });
  const saved = await updateCalendarEvent(deps(), input);
  expect(saved.event).toMatchObject({ start_at: start + 86_400_000, end_at: start + 4 * 86_400_000, is_all_day: true, timezone: 'Unknown/Zone' });
});

it('rejects a concurrent update between preparation and commit', async () => {
  const input = request({ summary: 'Old draft' });
  const original = collection.provider.updateEvent.bind(collection.provider);
  vi.spyOn(collection.provider, 'updateEvent').mockImplementationOnce(async args => {
    const payload = await original(args);
    await seed({ summary: 'A newer edit' });
    return payload;
  });
  await expect(updateCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'resource_conflict' });
  expect(getCalendarEvent(deps(), ref).event.summary).toBe('A newer edit');
});

it('rejects a replacement calendar even when its event identity and version still match', async () => {
  const input = request({ summary: 'Draft for old calendar' });
  const original = collection.provider.updateEvent.bind(collection.provider);
  vi.spyOn(collection.provider, 'updateEvent').mockImplementationOnce(async args => {
    const payload = await original(args);
    instances.delete('calendar', 'local');
    instances.upsert({ platform: 'calendar', slug: 'local', adapter_type: 'local', config: {},
      caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: null });
    return payload;
  });
  await expect(updateCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'resource_conflict' });
  expect(collection.table.get(ref.source_id)?.event.summary).toBe('Planning');
});

it('keeps unsupported events and unavailable calendars out of the owner editor', async () => {
  const input = request({ summary: 'Not allowed' });
  for (const patch of [{ timezone: 'Unknown/Zone' }, { recurrence_rule: 'FREQ=DAILY' }, { recurring_event_id: 'series' }, { status: 'cancelled' as const }]) {
    await seed(patch);
    expect(getCalendarEvent(deps(), ref).editable).toBe(false);
    await expect(updateCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'forbidden' });
  }
  await seed();
  instances.updateAuthState('calendar', 'local', { auth_state: 'degraded' });
  await expect(updateCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'forbidden' });
  instances.updateAuthState('calendar', 'local', { auth_state: 'healthy' });
  const remote = { ...collection, provider: { ...collection.provider, kind: 'gcal' as const } };
  const connected = { ...deps(), getCollection: () => remote };
  expect(getCalendarEvent(connected, ref).read_only_reason).toMatch(/connected calendar/);
  await expect(updateCalendarEvent(connected, input)).rejects.toMatchObject({ code: 'forbidden' });
});

it('rejects unexpected fields, invalid spans and oversized UTF-8 text before provider work', async () => {
  const update = vi.spyOn(collection.provider, 'updateEvent');
  for (const patch of [{ status: 'cancelled' }, { summary: ' ' }, { end_at: NOW }, { start_at: NaN },
    { description: '💡'.repeat(70_000) }, { source_id: 'other-event' }]) {
    await expect(updateCalendarEvent(deps(), request(patch as CalendarEventUpdateRequest['patch']))).rejects.toMatchObject({ code: 'invalid_args' });
  }
  expect(update).not.toHaveBeenCalled();
});

it('requires a paired owner for calendar event RPCs before reading or writing any calendar', async () => {
  const registry = createCollectionRegistry(); registry.register(collection);
  const slice = makeCollectionHandlers({ registry })!;
  const client = { instance_id: null } as WsClient;
  await expect(slice.handlers['collection.calendar.event.get'](ref, client)).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(slice.handlers['collection.calendar.event.destinations'](undefined, client)).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(slice.handlers['collection.calendar.event.create']({} as CalendarEventCreateRequest, client)).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(slice.handlers['collection.calendar.event.update'](request({ summary: 'No' }), client)).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(slice.handlers['collection.calendar.event.respond']({ ...ref, response: 'accepted', expected_version: 'v1', expected_incarnation: 'i1' }, client)).rejects.toMatchObject({ code: 'unauthorized' });
});

const newEvent = (): CalendarEventCreateRequest => ({ slug: 'local', calendar_id: 'local',
  expected_incarnation: instances.getIncarnation!('calendar', 'local')!,
  creation_id: '7865c879-d028-4093-bbd3-107986e7841d', summary: 'New planning', description: 'Agenda notes', location: 'Room 3',
  start_at: NOW, end_at: NOW + 3_600_000, timezone: 'America/Los_Angeles', is_all_day: false });

it('creates a canonical event once and recovers the same save through another receipt-store handle', async () => {
  const input = newEvent(), write = vi.spyOn(collection.provider, 'createEvent');
  const store = createCalendarEventCreationStore(db);
  const result = await createOwnerCalendarEvent(deps(), store, input);
  expect(result.snapshot.event).toMatchObject({ summary: input.summary, calendar_id: 'local', location: 'Room 3',
    description: 'Agenda notes', start_at: NOW, end_at: input.end_at, is_all_day: false });
  expect(collection.table.get(result.snapshot.event.source_id)?.event.summary).toBe(input.summary);
  expect(events).toHaveLength(1);
  const reloaded = createCalendarEventCreationStore(db);
  expect(await createOwnerCalendarEvent(deps(), reloaded, input)).toEqual(result);
  expect(write).toHaveBeenCalledTimes(1);
  await expect(createOwnerCalendarEvent(deps(), store, { ...input, summary: 'Different draft' })).rejects.toMatchObject({ code: 'conflict' });
  expect(write).toHaveBeenCalledTimes(1);
});

it('keeps an uncertain create claimed across retries and concurrent submissions', async () => {
  const input = newEvent(), store = createCalendarEventCreationStore(db);
  let fail!: (reason: Error) => void;
  const write = vi.spyOn(collection.provider, 'createEvent').mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const first = createOwnerCalendarEvent(deps(), store, input);
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  await expect(createOwnerCalendarEvent(deps(), store, input)).rejects.toMatchObject({ code: 'outcome_unknown' });
  fail(new Error('Provider response lost.'));
  await expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });
  const reopenedDb = new Database(db.serialize());
  try {
    await expect(createOwnerCalendarEvent(deps(), createCalendarEventCreationStore(reopenedDb), input)).rejects.toMatchObject({ code: 'outcome_unknown' });
  } finally { reopenedDb.close(); }
  expect(write).toHaveBeenCalledTimes(1);
  expect(events).toHaveLength(0);
});

it('refuses unwritable destinations, changed connections and invalid dates before a create', async () => {
  const store = createCalendarEventCreationStore(db), input = newEvent();
  const write = vi.spyOn(collection.provider, 'createEvent');
  for (const patch of [{ summary: ' ' }, { end_at: NOW }, { start_at: NaN }, { is_all_day: true },
    { timezone: 'Invalid/Zone' }, { description: '💡'.repeat(70_000) }]) {
    await expect(createOwnerCalendarEvent(deps(), store, { ...input, ...patch })).rejects.toMatchObject({ code: 'invalid_args' });
  }
  await expect(createOwnerCalendarEvent(deps(), store, { ...input, calendar_id: 'not-this-calendar' })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(createOwnerCalendarEvent(deps(), store, { ...input, expected_incarnation: 'old' })).rejects.toMatchObject({ code: 'resource_changed' });
  instances.updateAuthState('calendar', 'local', { auth_state: 'expired' });
  await expect(createOwnerCalendarEvent(deps(), store, input)).rejects.toMatchObject({ code: 'forbidden' });
  expect(write).not.toHaveBeenCalled();
  expect(store.get(input.creation_id)).toBeUndefined();
});

it('lists live writable calendars and fences a connection replaced while its destinations load', async () => {
  expect(await listCalendarEventDestinations(deps())).toMatchObject({ destinations: [{ slug: 'local', calendar_id: 'local', name: 'On this server' }], unavailable: [] });
  vi.spyOn(collection.provider, 'listWritableCalendars').mockImplementationOnce(async () => {
    instances.delete('calendar', 'local');
    instances.upsert({ platform: 'calendar', slug: 'local', adapter_type: 'local', config: {}, caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: null });
    return [{ calendar_id: 'local', name: 'Old calendar' }];
  });
  const result = await listCalendarEventDestinations(deps());
  expect(result.destinations).toEqual([]);
  expect(result.unavailable).toMatchObject([{ slug: 'local' }]);
});

it('honors disabled native writes even with stale writable caps, including at provider handoff', async () => {
  const store = createCalendarEventCreationStore(db), input = newEvent();
  const disable = () => instances.upsert({ ...instances.get('calendar', 'local')!, config: { native_write_enabled: false } });
  const write = vi.spyOn(collection.provider, 'createEvent');
  disable();
  expect((await listCalendarEventDestinations(deps())).destinations).toEqual([]);
  await expect(createOwnerCalendarEvent(deps(), store, input)).rejects.toMatchObject({ code: 'forbidden' });
  expect(store.get(input.creation_id)).toBeUndefined(); expect(write).not.toHaveBeenCalled();
  instances.upsert({ ...instances.get('calendar', 'local')!, config: {} });
  let sent = false;
  write.mockImplementationOnce(async (_id, _event, beforeSend) => {
    disable(); beforeSend!(); sent = true; throw new Error('Must not send after writes are disabled.');
  });
  await expect(createOwnerCalendarEvent(deps(), store, input)).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(sent).toBe(false); expect(events).toHaveLength(0);
});

it('does not mirror or resend a create whose provider response names another calendar', async () => {
  const store = createCalendarEventCreationStore(db), input = newEvent();
  const original = collection.provider.createEvent.bind(collection.provider);
  const write = vi.spyOn(collection.provider, 'createEvent').mockImplementationOnce(async (...args) => {
    const payload = await original(...args);
    return { ...payload, event: { ...payload.event, calendar_id: 'another-calendar' } };
  });
  await expect(createOwnerCalendarEvent(deps(), store, input)).rejects.toMatchObject({ code: 'outcome_unknown' });
  await expect(createOwnerCalendarEvent(deps(), store, input)).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(write).toHaveBeenCalledTimes(1); expect(events).toHaveLength(0);
  expect(collection.table.list({})).toHaveLength(1);
});

it('rechecks the calendar binding at provider handoff and leaves a replacement warehouse untouched', async () => {
  const store = createCalendarEventCreationStore(db), input = newEvent();
  let sent = false;
  vi.spyOn(collection.provider, 'createEvent').mockImplementationOnce(async (_id, _event, beforeSend) => {
    instances.delete('calendar', 'local');
    instances.upsert({ platform: 'calendar', slug: 'local', adapter_type: 'local', config: {}, caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: null });
    beforeSend!();
    sent = true;
    throw new Error('Must not reach the provider.');
  });
  await expect(createOwnerCalendarEvent(deps(), store, input)).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(sent).toBe(false); expect(events).toHaveLength(0);
});
