import { createContactStore } from '../storage/contact-store.js';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { handleWorkEntityLinkedFrom } from '../work-entity-linked-from.js';
import { makeWorkEntityCrudHandlers } from '../work-entity-crud-handler.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWarehouseEventBus } from '@recued/warehouse-events';

let db: Database.Database, store: WorkEntityStore;
const now = 1_700_000_000_000, url = 'https://app.test/client/#data/task/target%2F%E4%BA%8C%3F';
const request = (patch = {}) => handleWorkEntityLinkedFrom({ store, resolver: createWorkEntityResolver(store) }, { url, ...patch });
const note = (id: string, body = url, patch = {}) => store.writeNote({ id, source_id: 'recued.note', title: id, body, ...patch }, now);
beforeEach(() => {
  db = new Database(':memory:'); ensureWorkEntitySchema(db); store = createWorkEntityStore(db);
  for (const kind of ['task', 'note'] as const) store.registerSource({ id: 'recued.' + kind, top_tier_kind: kind,
    source_kind: 'builtin', source_label: kind, write_capable: true, registered_at: now });
  store.writeTask({ id: 'target/二?', source_id: 'recued.task', title: 'Target', done: false }, now);
});
afterEach(() => db.close());

it('returns both saved kinds with link context, identity, one row per source and exact deployment matching', () => {
  note('note', 'irrelevant '.repeat(80) + 'Near this link: ' + url + '\n#data/task/target%2F%E4%BA%8C%3F');
  store.writeTask({ id: 'source', source_id: 'recued.task', title: 'Source task', body: url, done: true }, now + 1);
  for (const [id, body] of Object.entries({ otherHost: url.replace('app.test', 'other.test'), otherPath: url.replace('/client/', '/else/'),
    otherKind: url.replace('/task/', '/note/'), prefix: url + 'suffix', credentials: url.replace('app.test', 'u:p@app.test'), query: url.replace('#', '?private=1#') })) note(id, body);
  const result = request();
  expect(result.items.map(item => [item.kind, item.id])).toEqual([['task', 'source'], ['note', 'note']]);
  expect(result.items[1]).toMatchObject({ title: 'note', created_at: now, source_id: 'recued.note', stale: false, pending_write: false });
  expect(result.items[1]!.excerpt).toContain('Near this link:'); expect(result.items[1]!.excerpt.length).toBeLessThanOrEqual(202);
  expect(result.more).toBe(false);
});

it('updates and removes references atomically for writes, raw SQL, tombstones, hard deletes and rollback', () => {
  note('note'); expect(request().items.map(row => row.id)).toEqual(['note']);
  note('note', 'No link'); expect(request().items).toEqual([]);
  db.prepare('UPDATE data_note SET body = ? WHERE id = ?').run(url, 'note'); expect(request().items).toHaveLength(1);
  expect(() => db.transaction(() => { note('note', 'Removed'); throw new Error('rollback'); })()).toThrow('rollback');
  expect(request().items).toHaveLength(1);
  store.deleteNote('note', { tombstone: true, now }); expect(request().items).toEqual([]);
  note('note', url); db.prepare("UPDATE data_note SET deleted_at = NULL, sync_state = 'live' WHERE id = ?").run('note'); expect(request().items).toHaveLength(1);
  store.deleteNote('note', { tombstone: false }); expect(request().items).toEqual([]);
  expect(db.prepare('SELECT 1 FROM work_entity_body_link WHERE owner_id = ?').get('note')).toBeUndefined();
});

it('backfills existing saved bodies once across repeated schema and store setup', () => {
  // Model an upgrade: existing data predates the new derived table/triggers.
  for (const kind of ['task', 'note']) for (const action of ['insert', 'update', 'delete']) db.exec(`DROP TRIGGER trg_data_${kind}_body_link_${action}`);
  db.exec('DROP TABLE work_entity_body_link; DROP TABLE work_entity_body_link_version'); note('old');
  ensureWorkEntitySchema(db); store = createWorkEntityStore(db); expect(request().items.map(row => row.id)).toEqual(['old']);
  db.exec('DELETE FROM work_entity_body_link'); ensureWorkEntitySchema(db); expect(request().items).toEqual([]);
  note('old', url); expect(request().items).toHaveLength(1);
});

it('filters current visibility and read-through residue before paging, while retaining stale and pending hints', () => {
  for (const id of ['gone', 'provider', 'stale']) store.registerSource({ id, top_tier_kind: 'note', source_kind: 'builtin', source_label: id,
    write_capable: false, registered_at: now, ...(id === 'provider' ? { sync_posture: 'read_through' as const } : {}) });
  note('gone', url, { source_id: 'gone' }); store.unregisterSource('gone');
  note('provider', url, { source_id: 'provider' }); note('orphan', url, { sync_state: 'orphaned' }); note('deleted'); db.prepare('UPDATE data_note SET deleted_at = ? WHERE id = ?').run(now, 'deleted');
  note('stale', url, { source_id: 'stale', sync_state: 'stale_unreachable' }); note('visible');
  db.prepare('UPDATE data_note SET pending_write_blob = ? WHERE id = ?').run(JSON.stringify({ staged_at: now, operation: 'update', dirty_fields: ['body'], state: 'awaiting_verify' }), 'visible');
  const result = request({ limit: 1 }); expect(result.items[0]!.id).toBe('stale'); expect(result.items[0]!.stale).toBe(true);
  expect(result.more).toBe(true); expect(result.provider_only_sources).toEqual(['provider']);
  expect(request({ limit: 1, offset: 1 }).items[0]).toMatchObject({ id: 'visible', pending_write: true });
  expect(request({ limit: 1, offset: 2 }).items).toEqual([]);
});

it('paginates in deterministic order, excludes self-links and refuses invalid targets or requests', () => {
  for (let index = 0; index < 13; index++) note('note-' + String(index).padStart(2, '0'));
  const target = store.readTask('target/二?')!; store.writeTask({ ...target, body: url }, now);
  expect(request().items).toHaveLength(10); expect(request().more).toBe(true);
  expect(request({ offset: 10 }).items.map(row => row.id)).toEqual(['note-10', 'note-11', 'note-12']);
  for (const patch of [{ url: '#data/task/target' }, { url: url + '/extra' }, { limit: 0 }, { limit: 51 }, { offset: -1 }, { offset: 0.5 }]) expect(() => request(patch)).toThrow();
  store.deleteTask(target.id, { tombstone: true }); expect(() => request()).toThrow('no longer available');
});

it('gates the new RPC before accessing saved bodies', async () => {
  const resolver = createWorkEntityResolver(store), bus = createWarehouseEventBus();
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers: createWorkEntityDispatchers({ store, resolver, bus }) })!;
  await expect(handlers.handlers['work_entity.linked_from']({ url }, { registered: false } as never)).rejects.toThrow();
  bus.dispose();
});

const contactsFixture = () => {
  const contacts = createContactStore(db);
  const survivor = contacts.upsertManual({ email: 'riley@example.test', name: 'Riley' }, now);
  const other = contacts.upsertManual({ email: 'other@example.test', name: 'Riley' }, now + 1);
  const deps = { store, resolver: createWorkEntityResolver(store), contactDisplay: contacts };
  const read = (patch = {}) => handleWorkEntityLinkedFrom(deps, {
    url: 'https://app.test/client/#data/contact/' + survivor.contact_id,
    contact_identity: { id: survivor.contact_id!, created_at: survivor.created_at }, ...patch,
  });
  return { contacts, survivor, other, read };
};

it('finds exact contact links across the saved warehouse, including email aliases, with distinct paging and no name inference', () => {
  const { contacts, survivor, other, read } = contactsFixture();
  const alias = contacts.upsertContactAlias({ contact_id: survivor.contact_id!, kind: 'email_alias', alias_pattern: 'second@example.test', source: 'manual' }, now);
  note('contact-id', '#data/contact/' + survivor.contact_id);
  note('alias', 'https://app.test/client/#data/contact/SECOND%40EXAMPLE.TEST');
  note('duplicate', '#data/contact/' + survivor.contact_id + ' #data/contact/second%40example.test');
  note('same-name', 'Riley'); note('different-contact', '#data/contact/' + other.contact_id);
  note('external-contact', 'https://external.test/client/#data/contact/' + survivor.contact_id);
  note('other-path', 'https://app.test/other/#data/contact/' + survivor.contact_id);
  const pages = [0, 1, 2].map(offset => read({ limit: 1, offset }));
  expect(pages.map(page => page.items[0]!.id)).toEqual(['alias', 'contact-id', 'duplicate']);
  expect(pages.map(page => page.more)).toEqual([true, true, false]);
  expect(pages[0]!.contact_target).toMatchObject({ id: survivor.contact_id, created_at: survivor.created_at,
    reference_ids: expect.arrayContaining([survivor.contact_id, survivor.email, 'second@example.test']) });
  contacts.deleteContactAlias(alias.id);
  expect(read().items.map(row => row.id)).toEqual(['contact-id', 'duplicate']);
});

it('re-resolves merges, transitive groups and splits without rewriting saved links or reindexing', () => {
  const { contacts, survivor, other, read } = contactsFixture();
  const third = contacts.upsertManual({ email: 'third@example.test', name: 'Third' }, now + 2);
  note('old-id', '#data/contact/' + other.contact_id); note('old-email', '#data/contact/OTHER%40example.test');
  note('third-id', '#data/contact/' + third.contact_id);
  expect(read().items).toEqual([]);
  contacts.setMergedInto([other], survivor.email, now + 10); contacts.setMergedInto([third], other.email, now + 11);
  expect(read().items.map(row => row.id)).toEqual(['old-email', 'old-id', 'third-id']);
  const oldBody = store.readNote('old-id')!.body;
  contacts.setMergedInto([other], null, now + 12);
  expect(read().items).toEqual([]); expect(store.readNote('old-id')!.body).toBe(oldBody);
});

it('refuses stale or removed contact identities and unwired lookups instead of claiming an empty result', () => {
  const { contacts, survivor, read } = contactsFixture();
  note('contact-id', '#data/contact/' + survivor.contact_id);
  expect(() => read({ contact_identity: { id: survivor.contact_id!, created_at: survivor.created_at + 1 } })).toThrow('contact changed');
  expect(() => read({ contact_identity: undefined })).toThrow('contact changed');
  expect(() => request({ url: 'https://app.test/client/#data/contact/' + survivor.contact_id })).toThrow('cannot be read');
  const next = contacts.upsertManual({ email: 'next@example.test' }, now + 20); contacts.setMergedInto([survivor], next.email, now + 21);
  expect(() => read()).toThrow('contact changed');
});

it('upgrades the text-link index from v1 and only backfills contact links once', () => {
  const { survivor, read } = contactsFixture(); note('old-contact-link', '#data/contact/' + survivor.contact_id);
  db.exec("DELETE FROM work_entity_body_link WHERE target_kind = 'contact'; DELETE FROM work_entity_body_link_version; INSERT INTO work_entity_body_link_version VALUES (1)");
  expect(read().items).toEqual([]); ensureWorkEntitySchema(db);
  expect(read().items.map(row => row.id)).toEqual(['old-contact-link']);
  db.exec("DELETE FROM work_entity_body_link WHERE target_kind = 'contact'"); ensureWorkEntitySchema(db); expect(read().items).toEqual([]);
});

for (const kind of ['mail', 'calendar'] as const) it('indexes exact ' + kind + ' records across accounts and guards target replacement', () => {
  const row = { record_id: 'same/id?', source_id: 'provider-record', received_at: now, modified_at: now, size_bytes: 1, hot_fields: {} };
  let incarnation = 'connection-one', live = true;
  const deps = { store, resolver: createWorkEntityResolver(store), sourceRecords: {
    get: (platform: string, slug: string, id: string) => live && platform === kind && slug === 'work' && id === row.record_id ? row : null,
    getIncarnation: () => incarnation,
  } };
  const sourceUrl = 'https://app.test/client/#data/' + kind + '/record/work/same%2Fid%3F';
  const args = { url: sourceUrl, source_identity: { source_id: row.source_id, received_at: now, incarnation } };
  note('target', sourceUrl); note('hash', '#data/' + kind + '/record/work/same%2Fid%3F');
  for (const [id, body] of Object.entries({ account: sourceUrl.replace('/work/', '/home/'), otherId: sourceUrl + 'suffix', client: sourceUrl.replace('app.test', 'other.test'), kind: sourceUrl.replace('/' + kind + '/', kind === 'mail' ? '/calendar/' : '/mail/') })) note(id, body);
  const result = handleWorkEntityLinkedFrom(deps, args);
  expect(result.items.map(row => row.id)).toEqual(['hash', 'target']); expect(result.source_target).toEqual(args.source_identity);
  note('target', 'Removed'); expect(handleWorkEntityLinkedFrom(deps, args).items.map(row => row.id)).toEqual(['hash']);
  // Upgrade a pre-source-link index, then prove an ordinary boot does not scan again.
  db.exec('DELETE FROM work_entity_body_link; DELETE FROM work_entity_body_link_version; INSERT INTO work_entity_body_link_version VALUES (2)');
  ensureWorkEntitySchema(db); expect(handleWorkEntityLinkedFrom(deps, args).items.map(row => row.id)).toEqual(['hash']);
  db.exec('DELETE FROM work_entity_body_link'); ensureWorkEntitySchema(db); expect(handleWorkEntityLinkedFrom(deps, args).items).toEqual([]);
  incarnation = 'connection-two'; expect(() => handleWorkEntityLinkedFrom(deps, args)).toThrow('source changed');
  incarnation = 'connection-one'; row.received_at++; expect(() => handleWorkEntityLinkedFrom(deps, args)).toThrow('source changed');
  live = false; expect(() => handleWorkEntityLinkedFrom(deps, args)).toThrow('no longer available');
  expect(() => handleWorkEntityLinkedFrom({ store, resolver: deps.resolver }, args)).toThrow('cannot be read');
});
