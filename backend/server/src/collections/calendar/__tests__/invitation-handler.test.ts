import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CalendarAdapterError, type CanonicalEvent, type CalendarEventRespondRequest } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createBlobStore } from '../../../storage/blob-store.js';
import { createInstanceStore } from '../../instance-store.js';
import { createCalendarCollection, type CalendarCollection } from '../calendar-collection.js';
import { createLocalCalendarProvider, LOCAL_CALENDAR_CAPS } from '../local-provider.js';
import type { CalendarProvider, ProviderEventPayload } from '../provider.js';
import { getOwnerCalendarEvent, respondToCalendarEvent } from '../invitation-handler.js';

const NOW = Date.parse('2026-10-28T16:00:00Z');
const ref = { slug: 'work', source_id: 'invitation' };
let db: Database.Database;
let dir: string;
let collection: CalendarCollection;
let provider: CalendarProvider;
let instances: ReturnType<typeof createInstanceStore>;
let remote: ProviderEventPayload;
let notificationSupported: boolean;
const deps = () => ({ instances, getCollection: (slug: string) => slug === ref.slug ? collection : undefined });
const updateInstance = (patch: Partial<Parameters<typeof instances.upsert>[0]>) =>
  instances.upsert({ ...instances.get('calendar', ref.slug)!, ...patch, platform: 'calendar', slug: ref.slug });
const request = async (response: CalendarEventRespondRequest['response'] = 'accepted'): Promise<CalendarEventRespondRequest> => {
  const view = await getOwnerCalendarEvent(deps(), ref);
  return { ...ref, response, expected_version: view.resource_version, expected_incarnation: view.incarnation! };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'calendar-rsvp-'));
  db = new Database(':memory:');
  instances = createInstanceStore({ db });
  instances.upsert({ platform: 'calendar', slug: ref.slug, adapter_type: 'gcal', config: {},
    caps: { ...LOCAL_CALENDAR_CAPS, rsvp: 'yes' }, auth_state: 'healthy', last_synced_at: NOW });
  const event: CanonicalEvent = {
    source_id: ref.source_id, ical_uid: 'meeting@example.com', calendar_id: 'primary',
    summary: 'Planning', description: 'Agenda', start_at: NOW, end_at: NOW + 3_600_000,
    timezone: 'America/Los_Angeles', is_all_day: false, status: 'confirmed', created_at: NOW, updated_at: NOW,
    organizer: { email: 'host@example.com', display_name: 'Host' },
    attendees: [{ email: 'me@example.com', is_self: true, response_status: 'needs_action' }],
  };
  remote = { event, etag: 'e1', description_bytes: 6 }; notificationSupported = true;
  provider = {
    ...createLocalCalendarProvider({ slug: ref.slug, now: () => NOW, readEvent: () => null }), kind: 'gcal', accountEmail: 'me@example.com',
    readInvitation: vi.fn(async () => ({ payload: structuredClone(remote), notification_supported: notificationSupported })),
    rsvpEvent: vi.fn(async input => {
      input.before_send?.();
      remote = { ...remote, etag: 'e2', event: { ...remote.event, updated_at: NOW + 1,
        attendees: [{ email: 'me@example.com', is_self: true, response_status: input.response }] } };
      return structuredClone(remote);
    }),
  };
  collection = createCalendarCollection({ db, slug: ref.slug, provider, bus: createWarehouseEventBus(),
    blobs: createBlobStore(join(dir, 'blobs')),
    gate: createStorageGate({ quota: 1024 * 1024, reservePct: 10, surface: 'collection:calendar:work' }),
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024,
      expansion_past_days: 30, expansion_future_days: 90 }),
  });
  await collection.applyVerifiedUpsert(remote);
});
afterEach(async () => { await collection?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }); });

it('reads the live invitation and responds as the connected attendee without sending the same response twice', async () => {
  const input = await request();
  const result = await respondToCalendarEvent(deps(), input);
  expect(result).toMatchObject({ removed: false, snapshot: { provider_verified: true, editable: false, invitation: {
    organizer: { email: 'host@example.com' }, attendee_email: 'me@example.com', response: 'accepted', can_respond: true, scope: 'event',
  } } });
  expect(provider.rsvpEvent).toHaveBeenCalledWith(expect.objectContaining({
    source_id: ref.source_id, calendar_id: 'primary', self_email: 'me@example.com', response: 'accepted', expected_etag: 'e1',
  }));
  expect(collection.table.get(ref.source_id)?.event.attendees?.[0].response_status).toBe('accepted');
  await respondToCalendarEvent(deps(), await request());
  expect(provider.rsvpEvent).toHaveBeenCalledTimes(1);
});

it('keeps the saved event readable when its provider is unavailable without certifying a cached response', async () => {
  vi.mocked(provider.readInvitation!).mockRejectedValueOnce(new CalendarAdapterError('io_error', 'Calendar offline'));
  const cached = await getOwnerCalendarEvent(deps(), ref);
  expect(cached.event).toMatchObject({ summary: 'Planning', start_at: NOW });
  expect(cached).toMatchObject({ invitation: { can_respond: false, response: 'needs_action' },
    refresh_error: 'The calendar could not be refreshed. Showing the last synced details.' });
  expect(cached.provider_verified).toBeUndefined();
  const fresh = await getOwnerCalendarEvent(deps(), ref);
  expect(fresh.provider_verified).toBe(true);
  expect(fresh.invitation?.can_respond).toBe(true);
  expect(provider.rsvpEvent).not.toHaveBeenCalled();
});

it('rejects stale views and refreshes changed provider details before any response', async () => {
  const input = await request();
  await expect(respondToCalendarEvent(deps(), { ...input, expected_incarnation: 'retired' })).rejects.toMatchObject({ code: 'resource_changed' });
  await expect(respondToCalendarEvent(deps(), { ...input, expected_version: 'old' })).rejects.toMatchObject({ code: 'resource_changed' });
  remote.event.summary = 'Changed by organizer'; remote.etag = 'changed';
  await expect(respondToCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'resource_changed' });
  expect(collection.table.get(ref.source_id)?.event.summary).toBe('Changed by organizer');
  expect(provider.rsvpEvent).not.toHaveBeenCalled();
});

it('enforces calendar capabilities and native-write policy on direct owner requests', async () => {
  const input = await request();
  for (const patch of [
    { caps: { ...LOCAL_CALENDAR_CAPS, rsvp: 'no' as const } },
    { caps: { ...LOCAL_CALENDAR_CAPS, rsvp: 'yes' as const }, auth_state: 'expired' as const },
    { auth_state: 'healthy' as const, config: { native_write_enabled: false } },
  ]) {
    updateInstance(patch);
    expect((await getOwnerCalendarEvent(deps(), ref)).invitation?.can_respond).toBe(false);
    await expect(respondToCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'forbidden' });
  }
  expect(provider.rsvpEvent).not.toHaveBeenCalled();
});

it('refuses local calendars and unverified scheduling providers even when they advertise RSVP', async () => {
  const input = await request();
  for (const kind of ['local', 'caldav'] as const) {
    Object.defineProperty(provider, 'kind', { value: kind, configurable: true });
    updateInstance({ adapter_type: kind });
    const view = await getOwnerCalendarEvent(deps(), ref);
    expect(view.invitation?.can_respond).not.toBe(true);
    await expect(respondToCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'forbidden' });
  }
  expect(provider.rsvpEvent).not.toHaveBeenCalled();
});

it('refuses non-invitations, organizer copies, cancelled invitations and non-propagating private copies', async () => {
  const original = structuredClone(remote);
  const cases: Array<() => void> = [
    () => { remote.event.attendees = [{ email: 'someone@example.com', response_status: 'needs_action' }]; },
    () => { remote.event.organizer = { email: 'me@example.com' }; },
    () => { remote.event.attendees = [{ email: 'shared-calendar-owner@example.com', is_self: true, response_status: 'needs_action' }]; },
    () => { remote.event.status = 'cancelled'; },
    () => { notificationSupported = false; },
  ];
  for (const change of cases) {
    remote = structuredClone(original); notificationSupported = true; change();
    await collection.applyVerifiedUpsert(remote);
    const input = await request();
    await expect(respondToCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'forbidden' });
  }
  expect(provider.rsvpEvent).not.toHaveBeenCalled();
});

it('prevents concurrent responses and stops when the connection is replaced during a provider read', async () => {
  const input = await request();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(provider.readInvitation!).mockImplementationOnce(async () => {
    started(); await new Promise<void>(resolve => { release = resolve; });
    return { payload: structuredClone(remote), notification_supported: true };
  });
  const pending = respondToCalendarEvent(deps(), input);
  await entered;
  await expect(respondToCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'conflict' });
  const prior = instances.get('calendar', ref.slug)!;
  instances.delete('calendar', ref.slug); instances.upsert(prior);
  release();
  await expect(pending).rejects.toMatchObject({ code: 'resource_changed' });
  expect(provider.rsvpEvent).not.toHaveBeenCalled();
});

it('keeps an uncertain write out of the mirror and checks provider state without resending', async () => {
  const input = await request('tentative');
  vi.mocked(provider.rsvpEvent).mockImplementationOnce(async () => {
    remote.event.attendees = [{ email: 'me@example.com', is_self: true, response_status: 'tentative' }];
    remote.etag = 'maybe';
    throw new CalendarAdapterError('io_error', 'Reply lost after handoff');
  });
  await expect(respondToCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'upstream_error' });
  expect(collection.table.get(ref.source_id)?.event.attendees?.[0].response_status).toBe('needs_action');
  updateInstance({ auth_state: 'expired' });
  const cached = await getOwnerCalendarEvent(deps(), ref);
  expect(cached.provider_verified).toBeUndefined();
  expect(cached.invitation).toMatchObject({ response: 'needs_action', can_respond: false });
  updateInstance({ auth_state: 'healthy' });
  const checked = await getOwnerCalendarEvent(deps(), ref);
  expect(checked.provider_verified).toBe(true);
  expect(checked.invitation?.response).toBe('tentative');
  await respondToCalendarEvent(deps(), await request('tentative'));
  expect(provider.rsvpEvent).toHaveBeenCalledTimes(1);
});

it('rechecks write permission at provider handoff and fences a replacement after submission', async () => {
  const input = await request();
  vi.mocked(provider.rsvpEvent).mockImplementationOnce(async args => {
    updateInstance({ config: { native_write_enabled: false } });
    args.before_send!();
    throw new Error('A disabled calendar must never reach submission.');
  });
  await expect(respondToCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'forbidden' });
  expect(collection.table.get(ref.source_id)?.event.attendees?.[0].response_status).toBe('needs_action');
  updateInstance({ config: {} });
  vi.mocked(provider.rsvpEvent).mockImplementationOnce(async args => {
    args.before_send!();
    const prior = instances.get('calendar', ref.slug)!;
    instances.delete('calendar', ref.slug); instances.upsert(prior);
    return { ...remote, event: { ...remote.event,
      attendees: [{ email: 'me@example.com', is_self: true, response_status: 'accepted' }] } };
  });
  await expect(respondToCalendarEvent(deps(), input)).rejects.toMatchObject({ code: 'resource_changed' });
  expect(collection.table.get(ref.source_id)?.event.attendees?.[0].response_status).toBe('needs_action');
});

it('removes a declined provider copy only after an acknowledged response', async () => {
  const input = await request('declined');
  vi.mocked(provider.rsvpEvent).mockResolvedValueOnce({ removed: true, source_id: ref.source_id, response_status: 'declined' });
  expect(await respondToCalendarEvent(deps(), input)).toEqual({ removed: true, source_id: ref.source_id, response: 'declined' });
  expect(collection.table.get(ref.source_id)).toBeNull();
});
