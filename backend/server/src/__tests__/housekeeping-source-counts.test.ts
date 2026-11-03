import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectionTableName, createCollectionTable, setCollectionReaderExclusion } from '../collections/table.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { countHousekeepingSourceRecords } from '../housekeeping/source-counts.js';
import { createContactStore } from '../storage/contact-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => { db.close(); });

describe('Housekeeping source population previews', () => {
  it.each(['mail', 'file'] as const)('counts only registered %s data, without reading records or FTS shadows', (platform) => {
    const live = createCollectionTable({ db, platform, slug: 'live' });
    const removed = createCollectionTable({ db, platform, slug: 'removed' });
    const record = { record_id: 'one', source_id: 'provider-one', received_at: 1, modified_at: 1, hot_fields: {}, body_inline: 'Do not hydrate this body', size_bytes: 24 };
    live.upsert(record);
    live.upsert({ ...record, record_id: 'two' });
    removed.upsert(record);
    const registry = { list: () => [{ platform, slug: 'live' }] };
    db.pragma('query_only = ON');
    expect(countHousekeepingSourceRecords(db, registry, platform)).toBe(2);
    expect(countHousekeepingSourceRecords(db, registry, `data.${platform}`)).toBe(2);
  });

  it('counts production calendar snapshots, including cancelled events the walker still visits', () => {
    const table = createCalendarTable({ db, slug: 'calendar' });
    for (const status of ['confirmed', 'cancelled'] as const) {
      table.upsert({
        event: { source_id: status, ical_uid: status, calendar_id: 'primary', summary: status,
          start_at: 1, end_at: 2, timezone: 'UTC', is_all_day: false, status, created_at: 1, updated_at: 1 },
        size_bytes: 0, now: 1,
      });
    }
    const registry = { list: () => [{ platform: 'calendar' as const, slug: 'calendar' }] };
    db.pragma('query_only = ON');
    expect(countHousekeepingSourceRecords(db, registry, 'data.calendar')).toBe(2);
    expect(countHousekeepingSourceRecords(db, registry, 'calendar')).toBe(table.listSnapshots({ limit: 100 }).length);
  });

  it('preserves both whole-mailbox and row-level owner exclusions', () => {
    const mail = createCollectionTable({ db, platform: 'mail', slug: 'owner' });
    const chat = createCollectionTable({ db, platform: 'mail', slug: 'chat' });
    const record = { record_id: 'one', source_id: 'provider-one', received_at: 1, modified_at: 1, hot_fields: { chat: false }, body_inline: 'private', size_bytes: 7 };
    mail.upsert(record);
    mail.upsert({ ...record, record_id: 'conversation', hot_fields: { chat: true } });
    chat.upsert(record);
    setCollectionReaderExclusion(db, {
      tables: (_platform, table) => table === chat.tableName,
      rows: { mail: "json_extract(hot_fields, '$.chat') = 0" },
    });
    const registry = { list: () => [{ platform: 'mail' as const, slug: 'owner' }, { platform: 'mail' as const, slug: 'chat' }] };
    const before = db.prepare('SELECT total_changes() AS n').get();
    expect(countHousekeepingSourceRecords(db, registry, 'mail')).toBe(1);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('distinguishes empty sources from unsupported, missing and partially uncountable sources', () => {
    const registry = { list: () => [{ platform: 'mail' as const, slug: 'live' }] };
    expect(countHousekeepingSourceRecords(db, undefined, 'mail')).toBeUndefined();
    expect(countHousekeepingSourceRecords(db, registry, 'mail')).toBeUndefined();
    expect(countHousekeepingSourceRecords(db, registry, 'contact')).toBeUndefined();
    expect(countHousekeepingSourceRecords(db, registry, 'enrichment.summary')).toBeUndefined();
    expect(countHousekeepingSourceRecords(db, registry, 'calendar')).toBe(0);
    createCollectionTable({ db, platform: 'mail', slug: 'live' });
    expect(countHousekeepingSourceRecords(db, registry, 'mail')).toBe(0);
    const partial = { list: () => [...registry.list(), { platform: 'mail' as const, slug: 'unavailable' }] };
    expect(countHousekeepingSourceRecords(db, partial, 'mail')).toBeUndefined();
    // Broken metadata must not turn into an apparently empty run.
    db.exec(`DROP TABLE "${collectionTableName('mail', 'live')}"`);
    expect(countHousekeepingSourceRecords(db, registry, 'mail')).toBeUndefined();
  });

  it('matches the contact walker, including merged-away rows', () => {
    const contacts = createContactStore(db);
    contacts.observe({ email: 'a@example.com', source: 'email_from', event_at: 1 });
    contacts.observe({ email: 'b@example.com', source: 'email_from', event_at: 1 });
    db.prepare('UPDATE contacts SET merged_into = ? WHERE email = ?').run('a@example.com', 'b@example.com');
    expect(countHousekeepingSourceRecords(db, undefined, 'data.contact')).toBe(contacts.walkByEmail('', 100).length);
    expect(countHousekeepingSourceRecords(db, undefined, 'contact')).toBe(2);
  });

  it('matches the work walkers across live, unreachable, orphaned and deleted records', () => {
    ensureWorkEntitySchema(db);
    const work = createWorkEntityStore(db);
    for (const kind of ['note', 'task', 'project', 'asset'] as const) {
      work.registerSource({ id: `fixture.${kind}`, top_tier_kind: kind, source_kind: 'builtin', source_label: kind, write_capable: true });
    }
    for (const id of ['live', 'stale', 'orphaned', 'tombstone']) {
      work.writeNote({ id, source_id: 'fixture.note', body: id }, 1);
      work.writeTask({ id, source_id: 'fixture.task', title: id }, 1);
      work.writeProject({ id, source_id: 'fixture.project', title: id }, 1);
      work.writeAsset({ id, source_id: 'fixture.asset', name: id, source: { kind: 'owner', ref: id } }, 1);
    }
    for (const scope of ['note', 'task', 'project', 'asset']) {
      db.exec(`UPDATE data_${scope} SET sync_state = 'stale_unreachable' WHERE id = 'stale';
        UPDATE data_${scope} SET sync_state = 'orphaned' WHERE id = 'orphaned';
        UPDATE data_${scope} SET sync_state = 'tombstoned', deleted_at = 2 WHERE id = 'tombstone'`);
    }
    const walked = { note: work.walkByNoteId('', 100), task: work.walkByTaskId('', 100), project: work.walkByProjectId('', 100), asset: work.walkByAssetId('', 100) };
    db.pragma('query_only = ON');
    for (const scope of ['note', 'task', 'project', 'asset'] as const) {
      expect(countHousekeepingSourceRecords(db, undefined, `data.${scope}`)).toBe(2);
      expect(countHousekeepingSourceRecords(db, undefined, scope)).toBe(walked[scope].length);
    }
  });
});
