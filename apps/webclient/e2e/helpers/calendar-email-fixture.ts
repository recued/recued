import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createStorageGate } from '@recued/storage-gate';
import type { CanonicalEvent, MailConversationItem } from '@recued/contracts';
import { createInstanceStore } from '../../../../backend/server/src/collections/instance-store.js';
import { createCalendarCollection, snapshotToCollectionRecord, type CalendarCollection } from '../../../../backend/server/src/collections/calendar/calendar-collection.js';
import { createLocalCalendarProvider, LOCAL_CALENDAR_CAPS } from '../../../../backend/server/src/collections/calendar/local-provider.js';
import { getCalendarEvent, updateCalendarEvent } from '../../../../backend/server/src/collections/calendar/local-event-handler.js';
import { readCalendarMailLinks } from '../../../../backend/server/src/collections/calendar/linked-mail-reader.js';
import { createBlobStore } from '../../../../backend/server/src/storage/blob-store.js';
import { installTaskNoteSourceFixture } from './task-note-source-fixture.js';
import { HARNESS_URL } from './full-app.js';
import { serializeSourceRecordAddress } from '../../src/shell/route.js';

/** Real retained calendar rows, index, event reads and edits, plus the existing
 * controlled Mail transport and native work-entity incoming-link handler. */
export const installCalendarEmailFixture = async (page: Page) => {
  const now = Date.parse('2026-10-31T18:00:00Z'), db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'recued-calendar-email-e2e-')), instances = createInstanceStore({ db });
  const bus = createWarehouseEventBus(), collections = new Map<string, CalendarCollection>();
  const eventId = 'event/shared?二.)', mutations: string[] = [], reads: string[] = [];
  let holdDisplayRead = false;
  let mailHistory = false;
  const enroll = (slug: string) => instances.upsert({ platform: 'calendar', slug, adapter_type: 'local', config: {},
    caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: null });
  for (const slug of ['work', 'home']) {
    enroll(slug);
    const provider = createLocalCalendarProvider({ slug, now: () => now + 1000,
      readEvent: id => collections.get(slug)?.table.get(id)?.event ?? null });
    collections.set(slug, createCalendarCollection({ db, slug, provider, bus, blobs: createBlobStore(join(dir, slug)),
      gate: createStorageGate({ quota: 8 * 1024 * 1024, reservePct: 10, surface: 'collection:calendar:' + slug }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 8 * 1024 * 1024, expansion_past_days: 30, expansion_future_days: 90 }) }));
  }
  const deps = { instances, getCollection: (slug: string) => collections.get(slug), now: () => now + 1000 };
  const stack = { instances, listLive: () => [...collections.values()] };
  const f = await installTaskNoteSourceFixture(page, {
    calendarSources: {
      get(slug, id) { const row = collections.get(slug)?.table.getByRecordId(id); return row ? snapshotToCollectionRecord(row) : null; },
      incarnation: slug => instances.getIncarnation!('calendar', slug),
      linkedMail: (target, limit, offset) => readCalendarMailLinks(stack, target, limit, offset, now),
    },
    caller: (method, args) => {
      const slug = String(args.slug ?? '');
      if (mailHistory && method === 'collection.mail.conversation.get') {
        const anchor: MailConversationItem = { record_id: f.source('mail', slug).recordId, source_id: 'same-provider-message', received_at: now, modified_at: now,
          from: 'riley@example.test', to: ['owner@example.test'], subject: 'Exact work email', snippet: 'Exact work email body.',
          is_read: true, is_flagged: false, has_attachments: false, direction: 'inbound', folder: 'INBOX', size_bytes: 20 };
        const older = Boolean(args.before), count = older ? 30 : 9;
        const messages = Array.from({ length: count }, (_, index) => ({ ...anchor, record_id: (older ? 'older-' : 'recent-') + index,
          source_id: 'provider-' + (older ? 'older-' : 'recent-') + index,
          received_at: now - (older ? index + 10 : index + 1) * 1000, subject: 'Earlier message ' + index }));
        return { result: { slug, anchor, messages: [anchor, ...messages], thread_id: 'same-provider-thread', incarnation: slug + '-mail-1',
          mailbox_address: 'owner@example.test', ...(!older ? { next_before: { received_at: now - 9000, record_id: 'recent-8' } } : {}) } };
      }
      if (method === 'collection.listInstances') return { result: { instances: [
        ...['work', 'home'].map(slug => ({ platform: 'mail', slug, adapter_type: 'gmail', auth_state: 'healthy', caps: {}, last_synced_at: now })),
        ...instances.list('calendar'),
      ] } };
      if (method === 'collection.get' && args.platform === 'calendar') {
        const row = collections.get(slug)?.table.getByRecordId(String(args.record_id));
        return { result: { record: row ? snapshotToCollectionRecord(row) : null } };
      }
      if (method === 'collection.list' && args.platform === 'calendar') return { result: {
        records: collections.get(slug)?.table.listSnapshots({ limit: 100 }).map(snapshotToCollectionRecord) ?? [],
      } };
      if (method === 'collection.calendar.event.get') {
        reads.push(slug + ':' + String(args.source_id));
        if (holdDisplayRead) { holdDisplayRead = false; f.hold('collection.calendar.event.get', ''); }
        try { return { result: getCalendarEvent(deps, { slug, source_id: String(args.source_id) }) }; }
        catch (cause) { return { error: { code: 'not_found', message: cause instanceof Error ? cause.message : String(cause) } }; }
      }
      if (method === 'collection.calendar.event.update') {
        mutations.push(method); return updateCalendarEvent(deps, args as never).then(result => ({ result }));
      }
      return undefined;
    },
  });
  const mailUrl = (slug = 'work') => HARNESS_URL + serializeSourceRecordAddress(f.source('mail', slug));
  const seed = async (slug = 'work', source_id = eventId, patch: Partial<CanonicalEvent> = {}) => {
    const event: CanonicalEvent = { source_id, calendar_id: slug, calendar_name: slug === 'work' ? 'Planning' : 'Personal',
      ical_uid: source_id + '@local', summary: slug === 'work' ? 'Planning from email' : 'Other mailbox meeting',
      description: 'Original email: ' + mailUrl(slug), location: 'Meeting room 2',
      start_at: Date.parse('2026-11-01T09:30:12.345Z'), end_at: Date.parse('2026-11-01T10:30:12.345Z'),
      timezone: 'America/Los_Angeles', is_all_day: false, status: 'confirmed', created_at: now, updated_at: now, ...patch };
    await collections.get(slug)!.applyVerifiedUpsert({ event, description_bytes: Buffer.byteLength(event.description ?? '') });
    return getCalendarEvent(deps, { slug, source_id });
  };
  await seed(); await seed('home');
  return { ...f, mailUrl, seed, eventId, mutations, reads,
    holdEventDisplay: () => { holdDisplayRead = true; },
    showMailHistory: () => { mailHistory = true; },
    event: (slug = 'work', id = eventId) => getCalendarEvent(deps, { slug, source_id: id }),
    eventHash: (slug = 'work', id = eventId) => serializeSourceRecordAddress({ tab: 'calendar', collectionSlug: slug,
      recordId: collections.get(slug)!.table.get(id)!.record_id }),
    replaceCalendar: (slug = 'work') => { instances.delete('calendar', slug); enroll(slug); },
    removeEvent: (slug = 'work', id = eventId) => collections.get(slug)!.table.delete(id),
    async dispose() { f.dispose(); for (const collection of collections.values()) await collection.close(); bus.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
};
