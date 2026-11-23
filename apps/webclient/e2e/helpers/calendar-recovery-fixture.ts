import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { CalendarEventCreateRequest, CalendarOverlapRequest, CollectionRecord } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createBlobStore } from '../../../../backend/server/src/storage/blob-store.js';
import { createCalendarEventCreationStore } from '../../../../backend/server/src/storage/calendar-event-creations.js';
import { createInstanceStore } from '../../../../backend/server/src/collections/instance-store.js';
import { createCalendarCollection } from '../../../../backend/server/src/collections/calendar/calendar-collection.js';
import { createLocalCalendarProvider, LOCAL_CALENDAR_CAPS } from '../../../../backend/server/src/collections/calendar/local-provider.js';
import { createOwnerCalendarEvent, listCalendarEventDestinations } from '../../../../backend/server/src/collections/calendar/event-create-handler.js';
import { getCalendarEvent } from '../../../../backend/server/src/collections/calendar/local-event-handler.js';
import { readCalendarOverlaps } from '../../../../backend/server/src/collections/calendar/event-overlaps.js';

/** Actual creation handler, calendar mirror and SQLite receipts survive browser
 * reload. Only the calendar provider and transport interruptions are controlled. */
export const installCalendarRecoveryFixture = async (page: Page, other?: (method: string, args: Record<string, unknown>) => unknown | Promise<unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-calendar-recovery-provider-')), db = new Database(':memory:');
  const bus = createWarehouseEventBus(), instances = createInstanceStore({ db });
  const enroll = () => instances.upsert({ platform: 'calendar', slug: 'work', adapter_type: 'gcal', config: {},
    caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: Date.parse('2026-10-31T12:00:00Z') });
  enroll();
  let available = true, inviteSupported = true, listFailure = false, loseReply = false, providerCalls = 0;
  let hold = false, release: (() => void) | undefined;
  let holdOverlap = false, failOverlap = false, releaseOverlap: (() => void) | undefined;
  const overlapRequests: CalendarOverlapRequest[] = [];
  const sources: string[] = [], requests: CalendarEventCreateRequest[] = [];
  const provider = { ...createLocalCalendarProvider({ slug: 'work', readEvent: () => null, now: () => Date.parse('2026-10-31T12:00:00Z') }), kind: 'gcal' as const,
    listWritableCalendars: async () => available ? [{ calendar_id: 'primary', name: 'Work calendar', ...(inviteSupported ? { can_invite: true as const } : {}) }] : [],
    createEvent: async (calendar: string, event: Parameters<ReturnType<typeof createLocalCalendarProvider>['createEvent']>[1], beforeSend?: () => void) => {
      beforeSend?.(); const number = ++providerCalls;
      if (hold) { hold = false; await new Promise<void>(done => { release = done; }); }
      const source_id = `event-${number}`; sources.push(source_id);
      return { description_bytes: Buffer.byteLength(event.description ?? ''), event: { ...event,
        calendar_id: calendar, source_id, ical_uid: `${source_id}@fixture`, summary: event.summary ?? '',
        start_at: event.start_at!, end_at: event.end_at!, timezone: event.timezone!, is_all_day: event.is_all_day!,
        status: 'confirmed' as const, created_at: 1, updated_at: 1 } };
    },
  };
  const collection = createCalendarCollection({ db, slug: 'work', provider, bus, blobs: createBlobStore(join(dir, 'blobs')),
    gate: createStorageGate({ quota: 4 * 1024 * 1024, reservePct: 10, surface: 'collection:calendar:work' }),
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 4 * 1024 * 1024, expansion_past_days: 30, expansion_future_days: 90 }) });
  const deps = { instances, getCollection: (slug: string) => slug === 'work' ? collection : undefined };
  const records = (): CollectionRecord[] => sources.filter(id => collection.table.get(id)).map(source_id => getCalendarEvent(deps, { slug: 'work', source_id }).record);
  const rpc = async (method: string, raw: unknown) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    try {
      const extra = await other?.(method, args);
      if (extra !== undefined) return extra;
      if (method === 'server.timezone.get') return { result: { resolved_zone: 'America/Los_Angeles' } };
      if (method === 'collection.calendar.event.overlaps') {
        overlapRequests.push(structuredClone(raw as CalendarOverlapRequest));
        if (holdOverlap) { holdOverlap = false; await new Promise<void>(done => { releaseOverlap = done; }); }
        if (failOverlap) throw Error('The calendar read was interrupted.');
        return { result: readCalendarOverlaps(deps, raw as CalendarOverlapRequest) };
      }
      if (method === 'collection.calendar.event.destinations') {
        if (listFailure) throw Error('The calendar list was interrupted.');
        return { result: await listCalendarEventDestinations(deps) };
      }
      if (method === 'collection.calendar.event.create') {
        requests.push(structuredClone(raw as CalendarEventCreateRequest));
        const result = await createOwnerCalendarEvent(deps, createCalendarEventCreationStore(db), raw as CalendarEventCreateRequest);
        if (loseReply) { loseReply = false; return { error: { code: 'timeout', message: 'The creation reply was lost.' } }; }
        return { result };
      }
      if (method === 'collection.calendar.event.get') return { result: getCalendarEvent(deps, { slug: 'work', source_id: String(args.source_id) }) };
      if (method === 'collection.listInstances' && (args.platform === undefined || args.platform === 'calendar')) return { result: { instances: instances.list('calendar') } };
      if (method === 'collection.list' && args.platform === 'calendar') {
        const range = args.calendar_window as { from: number; before: number } | undefined, filters = args.filters as { is_all_day?: boolean } | undefined;
        const matched = records().filter(record => (!range || Number(record.hot_fields.start_at) < range.before && Number(record.hot_fields.end_at) > range.from)
          && (filters?.is_all_day === undefined || record.hot_fields.is_all_day === filters.is_all_day));
        const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 100);
        return { result: { records: matched.slice(offset, offset + limit), total: matched.length } };
      }
      if (method === 'collection.get' && args.platform === 'calendar') return { result: { record: records().find(record => record.record_id === args.record_id) ?? null } };
      return undefined;
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  };
  await page.exposeFunction('__calendarRecoveryRpc', rpc);
  await page.addInitScript(() => {
    Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
      (window as unknown as { __calendarRecoveryRpc(method: string, args: unknown): Promise<unknown> }).__calendarRecoveryRpc(method, args) });
  });
  return { rpc, requests, overlapRequests, holdNextOverlap: () => { holdOverlap = true; }, failOverlaps: (value: boolean) => { failOverlap = value; },
    overlapPending: () => releaseOverlap !== undefined, releaseOverlap: () => { const done = releaseOverlap; releaseOverlap = undefined; done?.(); },
    setInvitations: (value: boolean) => { inviteSupported = value; }, providerCalls: () => providerCalls, loseNextReply: () => { loseReply = true; }, holdNextProvider: () => { hold = true; },
    seed: async (input: Partial<Pick<CalendarEventCreateRequest, 'summary' | 'description' | 'location' | 'start_at' | 'end_at' | 'timezone' | 'is_all_day'>> = {}) => {
      const destination = (await listCalendarEventDestinations(deps)).destinations[0]!;
      return createOwnerCalendarEvent(deps, createCalendarEventCreationStore(db), { slug: destination.slug, calendar_id: destination.calendar_id,
        expected_incarnation: destination.incarnation, creation_id: randomUUID(), summary: 'Original planning', description: 'Original notes', location: 'Room 2',
        start_at: Date.parse('2026-10-28T16:00:00Z'), end_at: Date.parse('2026-10-28T17:00:00Z'), timezone: 'America/New_York', is_all_day: false, ...input });
    },
    get: (source_id: string) => getCalendarEvent(deps, { slug: 'work', source_id }),
    pending: () => release !== undefined, release: () => { const done = release; release = undefined; done?.(); },
    setAvailable: (value: boolean) => { available = value; }, failCalendarList: (value: boolean) => { listFailure = value; },
    async dispose() { release?.(); releaseOverlap?.(); await collection.close(); bus.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
};
