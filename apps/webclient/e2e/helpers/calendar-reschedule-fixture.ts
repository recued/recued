import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { CalendarEventRef, CalendarEventUpdateRequest, CalendarOverlapRequest, CanonicalEvent } from '@recued/contracts';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createBlobStore } from '../../../../backend/server/src/storage/blob-store.js';
import { createInstanceStore } from '../../../../backend/server/src/collections/instance-store.js';
import { createCalendarCollection, type CalendarCollection } from '../../../../backend/server/src/collections/calendar/calendar-collection.js';
import { createLocalCalendarProvider, LOCAL_CALENDAR_CAPS } from '../../../../backend/server/src/collections/calendar/local-provider.js';
import { getCalendarEvent, updateCalendarEvent } from '../../../../backend/server/src/collections/calendar/local-event-handler.js';
import { readCalendarOverlaps } from '../../../../backend/server/src/collections/calendar/event-overlaps.js';

/** Saved calendar reads and version-guarded writes use the real SQLite handlers.
 * Only connection state and transport interruptions are controlled. */
export const installCalendarRescheduleFixture = async (page: Page, now = Date.parse('2026-10-28T12:00Z')) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-calendar-reschedule-')), db = new Database(':memory:');
  const instances = createInstanceStore({ db }), bus = createWarehouseEventBus(), collections = new Map<string, CalendarCollection>();
  const deps = { instances, getCollection: (slug: string) => collections.get(slug), now: () => now };
  const enroll = (slug: string, remote = false) => instances.upsert({ platform: 'calendar', slug, adapter_type: remote ? 'gcal' : 'local',
    config: {}, caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: remote ? now : null });
  for (const slug of ['local', 'work']) {
    enroll(slug, slug === 'work');
    const provider = createLocalCalendarProvider({ slug, readEvent: id => collections.get(slug)?.table.get(id)?.event ?? null, now: () => now });
    collections.set(slug, createCalendarCollection({ db, slug, provider, bus, blobs: createBlobStore(join(dir, slug)),
      gate: createStorageGate({ quota: 4_000_000, reservePct: 10, surface: `collection:calendar:${slug}` }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 4_000_000, expansion_past_days: 30, expansion_future_days: 90 }) }));
  }
  enroll('missing', true);
  const ref: CalendarEventRef = { slug: 'local', source_id: 'event-1' };
  const base: CanonicalEvent = { source_id: ref.source_id, ical_uid: 'planning@fixture', calendar_id: 'local', summary: 'Customer planning',
    description: 'Original notes', location: 'Room 2', start_at: Date.parse('2026-10-28T16:00Z'), end_at: Date.parse('2026-10-28T17:00:12.567Z'),
    timezone: 'America/Los_Angeles', is_all_day: false, status: 'confirmed', created_at: now - 1000, updated_at: now };
  const seed = (slug: string, source_id: string, patch: Partial<CanonicalEvent> = {}) => {
    const event = { ...base, calendar_id: slug, source_id, ...patch };
    return collections.get(slug)!.applyVerifiedUpsert({ event, description_bytes: Buffer.byteLength(event.description ?? '') });
  };
  await seed('local', ref.source_id); await seed('work', 'duplicate-copy');
  await seed('local', 'busy', { ical_uid: 'busy@fixture', summary: 'Busy morning', start_at: Date.parse('2026-10-28T17:15Z'), end_at: Date.parse('2026-10-28T18:00Z') });
  let eventReadsCompleted = 0;
  let holdRead = false, releaseRead: (() => void) | undefined;
  let holdSave = false, releaseSave: (() => void) | undefined, readAvailable = true;
  let hold = false, release: (() => void) | undefined, fail = false, completed = 0, loseReply = false;
  const reads: CalendarOverlapRequest[] = [], writes: CalendarEventUpdateRequest[] = [];
  const rpc = async (method: string, raw: unknown) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    try {
      if (method === 'server.timezone.get') return { result: { resolved_zone: 'America/Los_Angeles' } };
      if (method === 'collection.calendar.event.overlaps') {
        const request = raw as CalendarOverlapRequest; reads.push(structuredClone(request));
        // Automatic edit previews must not consume the finder-day interruption.
        if (hold && request.end_at - request.start_at >= 4 * 3_600_000) { hold = false; await new Promise<void>(done => { release = done; }); }
        if (fail) throw Error('Calendar read interrupted');
        const result = readCalendarOverlaps(deps, request); completed++; return { result };
      }
      if (method === 'collection.calendar.event.get') { if (holdRead) { holdRead = false; await new Promise<void>(done => { releaseRead = done; }); } if (!readAvailable) throw Error('Calendar is unavailable'); const result = getCalendarEvent(deps, args as unknown as CalendarEventRef); eventReadsCompleted++; return { result }; }
      if (method === 'collection.calendar.event.update') {
        writes.push(structuredClone(raw as CalendarEventUpdateRequest));
        if (holdSave) { holdSave = false; await new Promise<void>(done => { releaseSave = done; }); }
        const result = await updateCalendarEvent(deps, raw as CalendarEventUpdateRequest);
        if (loseReply) { loseReply = false; return { error: { code: 'timeout', message: 'The save reply was lost.' } }; }
        return { result };
      }
      if (method === 'collection.listInstances' && (args.platform === undefined || args.platform === 'calendar')) return { result: { instances: instances.list('calendar') } };
      if (method === 'collection.list' && args.platform === 'calendar') {
        const range = args.calendar_window as { from: number; before: number } | undefined;
        const filters = args.filters as { is_all_day?: boolean } | undefined;
        const records = [getCalendarEvent(deps, ref).record].filter(record => (!range || Number(record.hot_fields.start_at) < range.before && Number(record.hot_fields.end_at) > range.from)
          && (filters?.is_all_day === undefined || record.hot_fields.is_all_day === filters.is_all_day));
        return { result: { records: records.slice(Number(args.offset ?? 0), Number(args.offset ?? 0) + Number(args.limit ?? 100)), total: records.length } };
      }
      if (method === 'collection.get' && args.platform === 'calendar') return { result: { record: getCalendarEvent(deps, ref).record } };
      return undefined;
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  };
  await page.exposeFunction('__calendarRescheduleRpc', rpc);
  await page.addInitScript(() => {
    Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
      (window as unknown as { __calendarRescheduleRpc(method: string, args: unknown): Promise<unknown> }).__calendarRescheduleRpc(method, args) });
  });
  return { reads, writes, seed, get: () => getCalendarEvent(deps, ref), completed: () => completed,
    holdNext: () => { hold = true; }, pending: () => release !== undefined,
    release: () => { const done = release; release = undefined; done?.(); }, fail: (value: boolean) => { fail = value; },
    loseNextReply: () => { loseReply = true; }, setReadAvailable: (value: boolean) => { readAvailable = value; },
    completedEventReads: () => eventReadsCompleted,
    holdNextRead: () => { holdRead = true; }, readPending: () => releaseRead !== undefined, releaseRead: () => { const done = releaseRead; releaseRead = undefined; done?.(); },
    holdNextSave: () => { holdSave = true; }, savePending: () => releaseSave !== undefined,
    releaseSave: () => { const done = releaseSave; releaseSave = undefined; done?.(); },
    replaceCalendar: () => { instances.delete('calendar', 'local'); enroll('local'); },
    changeSavedTitle: async () => seed('local', ref.source_id, { ...getCalendarEvent(deps, ref).event, summary: 'Changed elsewhere', updated_at: now + 1000 }),
    async dispose() { releaseRead?.(); releaseSave?.(); release?.(); for (const collection of collections.values()) await collection.close(); bus.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
};
