import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { savedWorkAddress, type CanonicalEvent, type CollectionRecord } from '@recued/contracts';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { readCalendarMailLinks } from '../collections/calendar/linked-mail-reader.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { handleWorkEntityLinkedFrom } from '../work-entity-linked-from.js';

let db: Database.Database;
const now = 1_700_000_000_000;
const url = 'https://app.test/client/#data/mail/record/work/message%2F%E4%BA%8C%3F';
const target = savedWorkAddress(url)!;
const event = (source_id: string, description = url, updated_at = now): CanonicalEvent => ({
  source_id, calendar_id: 'primary', calendar_name: 'Planning', ical_uid: source_id, summary: source_id, description,
  start_at: now, end_at: now + 3_600_000, timezone: 'America/Los_Angeles', is_all_day: false, status: 'confirmed', created_at: now, updated_at,
});
const put = (table: ReturnType<typeof createCalendarTable>, id: string, description = url, patch: Partial<CanonicalEvent> = {}) => {
  const value = { ...event(id, description), ...patch }, bytes = Buffer.byteLength(description);
  table.upsert({ event: value, size_bytes: bytes, ...(bytes > 65536 ? { blob_hash: 'a'.repeat(64) } : { body_inline: description }), now });
};
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => { db.close(); });

it('indexes explicit account-qualified links, full descriptions and distinct occurrences without title or participant guesses', () => {
  const table = createCalendarTable({ db, slug: 'planning' });
  put(table, 'exact', 'Original email: <' + url + '>\n' + url);
  put(table, 'relative', '#data/mail/record/work/message%2F%E4%BA%8C%3F', { status: 'cancelled' });
  put(table, 'large', 'Context '.repeat(40000) + '\nOriginal email: ' + url);
  put(table, 'other-mailbox', url.replace('/work/', '/home/'));
  put(table, 'other-deployment', url.replace('/client/', '/other/'));
  put(table, 'other-origin', url.replace('app.test', 'external.test'));
  put(table, 'same-title', 'message/二? From owner@example.test');
  expect(table.listMailLinks(target, 20).map(row => row.source_id).sort()).toEqual(['exact', 'large', 'relative']);
  expect(table.listMailLinks(target, 20).find(row => row.source_id === 'relative')!.event.status).toBe('cancelled');
});

it('keeps link changes atomic with row writes, rollback, deletion and retention', () => {
  const table = createCalendarTable({ db, slug: 'planning' }); put(table, 'one');
  expect(() => db.transaction(() => { put(table, 'one', 'Link removed.'); throw new Error('rollback'); })()).toThrow('rollback');
  expect(table.listMailLinks(target, 10).map(row => row.source_id)).toEqual(['one']);
  put(table, 'one', 'Link removed.'); expect(table.listMailLinks(target, 10)).toEqual([]);
  put(table, 'one'); table.delete('one'); expect(table.listMailLinks(target, 10)).toEqual([]);
  put(table, 'old'); put(table, 'new', url, { updated_at: now + 1 });
  table.pruneOlderThan(now + 1); expect(table.listMailLinks(target, 10).map(row => row.source_id)).toEqual(['new']);
  table.dropSchema();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE ?").all(table.tableName + '_mail_links%')).toEqual([]);
});

it('backfills existing calendar descriptions once on upgrade and preserves their row versions', () => {
  const table = createCalendarTable({ db, slug: 'planning' }); put(table, 'old');
  const before = table.get('old')!;
  db.exec(`DROP TRIGGER ${table.tableName}_mail_links_delete; DROP TABLE ${table.tableName}_mail_links;`);
  const reopened = createCalendarTable({ db, slug: 'planning' });
  expect(reopened.listMailLinks(target, 10).map(row => row.source_id)).toEqual(['old']);
  expect(reopened.get('old')).toEqual(before);
  db.exec(`DELETE FROM ${table.tableName}_mail_links`);
  expect(createCalendarTable({ db, slug: 'planning' }).listMailLinks(target, 10)).toEqual([]);
});

it('pages filtered calendar links across accounts independently of task links, and refuses retired email identities', () => {
  const tables = ['a', 'b'].map(slug => ({ slug, table: createCalendarTable({ db, slug }),
    health: () => ({ state: 'active', last_success_at: now }) }));
  for (const collection of tables) for (let i = 0; i < 12; i++) {
    put(collection.table, 'event-' + i, url, { updated_at: now + i, status: i === 11 ? 'cancelled' : 'confirmed' });
    put(collection.table, 'wrong-' + i, url.replace('/work/', '/home/'), { updated_at: now + 100 + i });
  }
  const instances = ['a', 'b', 'unavailable'].map(slug => ({ slug, adapter_type: 'local', auth_state: 'healthy', last_synced_at: now, backfill_complete: true }));
  const stack = { instances: { list: () => instances, getIncarnation: (_: string, slug: string) => slug + '-1' }, listLive: () => tables };
  ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), resolver = createWorkEntityResolver(store);
  store.registerSource({ id: 'recued.note', top_tier_kind: 'note', source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  store.writeNote({ id: 'incoming', source_id: 'recued.note', title: 'Incoming', body: url }, now);
  let incarnation = 'work-1';
  const record: CollectionRecord = { record_id: target.id, source_id: 'provider-mail', received_at: now, modified_at: now, size_bytes: 10, hot_fields: {} };
  const source_identity = { source_id: record.source_id, received_at: now, incarnation };
  let reads = 0;
  const deps = { store, resolver, sourceRecords: { get: () => record, getIncarnation: () => incarnation,
    linkedCalendar: (address: typeof target, limit: number, offset: number) => { reads++; return readCalendarMailLinks(stack as never, address, limit, offset, now); } } };
  const read = (calendar_offset = 0) => handleWorkEntityLinkedFrom(deps, { url, source_identity, limit: 10, calendar_offset });
  const first = read(), second = read(10), third = read(20);
  expect(first.items.map(row => row.id)).toEqual(['incoming']); expect(second.items).toEqual(first.items);
  expect([first, second, third].map(page => page.calendar!.items.length)).toEqual([10, 10, 4]);
  expect([first, second, third].map(page => page.calendar!.more)).toEqual([true, true, false]);
  const rows = [first, second, third].flatMap(page => page.calendar!.items);
  expect(new Set(rows.map(row => row.slug + ':' + row.record_id)).size).toBe(24);
  expect(rows.slice(0, 2).map(row => [row.slug, row.title, row.status])).toEqual([['a', 'event-11', 'cancelled'], ['b', 'event-11', 'cancelled']]);
  expect(first.calendar!.unavailable_sources).toEqual(['unavailable']);
  incarnation = 'work-2'; expect(() => read()).toThrow('source changed'); expect(reads).toBe(3);
  expect(() => read(-1)).toThrow('valid calendar-link page');
});
