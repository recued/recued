import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defaultQuietHoursPolicy, reminderMailReference, REMINDER_HISTORY_MS,
  type CollectionRecord, type ReminderMailReference } from '@recued/contracts';
import { createInstanceStore } from '../collections/instance-store.js';
import { createCollectionTable } from '../collections/table.js';
import { wireReminderDispatchers } from '../composition/bin/wire-reminders.js';
import { makeReminderHandlers } from '../reminders/reminder-rpc-handler.js';
import { createReminderStore, ensureReminderSchema } from '../storage/reminder-store.js';
import { getMailMessage } from '../collections/mail/message-read.js';

const NOW = Date.parse('2026-11-21T18:00:00Z'), client = { instance_id: 'mail-reminder-owner', client_kind: 'webclient' } as never;
let db: Database.Database, clock: number, instances: ReturnType<typeof createInstanceStore>;
let store: ReturnType<typeof createReminderStore>, tables: Map<string, ReturnType<typeof createCollectionTable>>;
const row: CollectionRecord = { record_id: 'same-id', source_id: 'uid-1@INBOX', received_at: NOW - 1000,
  modified_at: NOW, size_bytes: 12, hot_fields: { subject: 'Quote', from: 'sender@example.test' }, body_inline: 'Original email' };
const enroll = (slug: string) => instances.upsert({ platform: 'mail', slug, adapter_type: 'imap', config: {},
  caps: { read: 'yes', write: 'no', delete: 'no', watch: 'none', mirror: 'optional', auth: 'none', path_style: 'posix' },
  auth_state: 'healthy', last_synced_at: null });
const reference = (slug = 'work'): ReminderMailReference =>
  reminderMailReference(slug, tables.get(slug)!.get(row.record_id)!, instances.getIncarnation!('mail', slug))!;
const rpc = () => makeReminderHandlers({ dispatchers: wireReminderDispatchers({ db, now: () => clock,
  serverTimeZoneStore: { read: () => ({ mode: 'fixed', zone: 'America/Los_Angeles', updated_at: NOW }) },
  quietHoursStore: { read: defaultQuietHoursPolicy } }) })!.handlers;
const request = (mail_ref = reference(), creation_id = 'once') => ({ text: 'Follow up: Quote', at: NOW + 3600_000, creation_id, mail_ref });
beforeEach(() => {
  db = new Database(':memory:'); clock = NOW; instances = createInstanceStore({ db }); store = createReminderStore(db); tables = new Map();
  for (const slug of ['work', 'personal']) {
    enroll(slug); const table = createCollectionTable({ db, platform: 'mail', slug }); table.upsert(row); tables.set(slug, table);
  }
});
afterEach(() => db.close());

it('persists exact mailbox links through edits, cancellation and store restart without changing the email', async () => {
  const before = tables.get('work')!.get(row.record_id), mail_ref = reference(), handlers = rpc();
  const created = await handlers['reminder.create'](request(mail_ref), client);
  expect(created.reminder.mail_ref).toEqual(mail_ref);
  await handlers['reminder.update']({ reminder_id: created.reminder.reminder_id, text: 'Call about Quote', at: NOW + 7200_000 }, client);
  await handlers['reminder.cancel']({ reminder_id: created.reminder.reminder_id }, client);
  store = createReminderStore(db);
  expect(store.get(created.reminder.reminder_id)).toMatchObject({ mail_ref, state: 'cancelled', text: 'Call about Quote' });
  expect((await handlers['reminder.get']({ reminder_id: created.reminder.reminder_id }, client)).reminder?.mail_ref).toEqual(mail_ref);
  expect(tables.get('work')!.get(row.record_id)).toEqual(before);
});

it('filters exact email lifetimes before count and cursor paging, including terminal retention and delivered output', async () => {
  const mail_ref = reference(), seed = (ref = mail_ref) => store.create({ text: 'Quote follow up', at: NOW + 3600_000, origin: {}, time_zone: 'UTC', mail_ref: ref }, NOW);
  const ids = Array.from({ length: 23 }, () => seed().reminder_id).sort();
  for (const other of [reference('personal'), { ...mail_ref, incarnation: 'replacement' }, { ...mail_ref, source_id: 'reused-uid' },
    { ...mail_ref, received_at: mail_ref.received_at + 1 }]) seed(other);
  const cancelled = seed(), delivered = seed(), expired = seed(), other = seed(reference('personal'));
  store.cancel(cancelled.reminder_id, NOW); store.markDelivered(delivered.reminder_id, NOW, ['in_app']);
  store.cancel(expired.reminder_id, NOW - REMINDER_HISTORY_MS - 1); store.cancel(other.reminder_id, NOW);
  const first = await rpc()['reminder.list']({ limit: 20, page: { mail_ref, state: 'pending' }, include_delivered: true }, client);
  expect(first).toMatchObject({ mail_links_supported: true, page: { mail_ref, matched_count: 23 } });
  expect(first.reminders.map(row => row.reminder_id)).toEqual(ids.slice(0, 20));
  expect(first.delivered?.map(row => row.reminder_id).sort()).toEqual([cancelled.reminder_id, delivered.reminder_id].sort());
  const last = await rpc()['reminder.list']({ limit: 20, page: { mail_ref, state: 'pending', cursor: first.page!.next_cursor! } }, client);
  expect(last.page).toMatchObject({ matched_count: 23, next_cursor: null }); expect(last.reminders.map(row => row.reminder_id)).toEqual(ids.slice(20));
  const history = await rpc()['reminder.list']({ page: { mail_ref, state: 'all', history_only: true } }, client);
  expect(history.page).toMatchObject({ mail_ref, history_only: true, matched_count: 2 });
  expect(history.reminders.map(row => row.reminder_id).sort()).toEqual([cancelled.reminder_id, delivered.reminder_id].sort());
});

it('rejects new creation for replaced mailboxes and messages while reconciling lost replies after source removal', async () => {
  const handlers = rpc(), args = request(), first = await handlers['reminder.create'](args, client);
  tables.get('work')!.delete(row.record_id); clock = NOW + 86400_000;
  expect((await handlers['reminder.create'](args, client)).reminder.reminder_id).toBe(first.reminder.reminder_id);
  store.cancel(first.reminder.reminder_id, clock);
  expect((await handlers['reminder.create'](args, client)).reminder.state).toBe('cancelled');
  await expect(handlers['reminder.create']({ ...args, creation_id: 'new' }, client)).rejects.toMatchObject({ code: 'bad_request' });
  tables.get('work')!.upsert({ ...row, received_at: NOW + 1 });
  clock = NOW;
  await expect(handlers['reminder.create']({ ...args, creation_id: 'reused-id' }, client)).rejects.toMatchObject({ code: 'bad_request' });
  tables.get('work')!.upsert(row); instances.delete('mail', 'work'); enroll('work');
  await expect(handlers['reminder.create']({ ...args, creation_id: 're-enrolled' }, client)).rejects.toMatchObject({ code: 'bad_request' });
  await expect(handlers['reminder.create']({ ...args, mail_ref: reference('personal') }, client)).rejects.toMatchObject({ code: 'conflict' });
  expect(store.countPending()).toBe(0);
});

it('rejects malformed, dual and unpaired email bindings at the owner boundary', async () => {
  const handlers = rpc(), args = request(), record_ref = { kind: 'task', id: 'one', source_id: 'recued.task', source_record_id: null, created_at: NOW };
  for (const mail_ref of [null, {}, { ...args.mail_ref, slug: '' }, { ...args.mail_ref, incarnation: '' }, { ...args.mail_ref, received_at: NaN }]) {
    await expect(handlers['reminder.create']({ ...args, mail_ref } as never, client)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handlers['reminder.list']({ page: { state: 'pending', mail_ref } } as never, client)).rejects.toMatchObject({ code: 'bad_request' });
  }
  await expect(handlers['reminder.create']({ ...args, record_ref } as never, client)).rejects.toMatchObject({ code: 'bad_request' });
  await expect(handlers['reminder.list']({ page: { mail_ref: args.mail_ref, record_ref } } as never, client)).rejects.toMatchObject({ code: 'bad_request' });
  await expect(handlers['reminder.create'](args, { client_kind: 'webclient' } as never)).rejects.toMatchObject({ code: 'unauthorized' });
  expect(store.countPending()).toBe(0);
});

it('resumes email-index migration and leaves malformed legacy JSON unlinked', () => {
  const mail_ref = reference(), original = store.create({ text: 'Legacy email', at: NOW + 3600_000, time_zone: 'UTC', origin: {}, mail_ref }, NOW);
  const corrupt = store.create({ text: 'Broken reference', at: NOW + 3600_000, time_zone: 'UTC', origin: {} }, NOW);
  db.prepare('UPDATE reminders SET mail_ref_json=?,mail_ref_key=NULL WHERE reminder_id=?')
    .run(JSON.stringify({ incarnation: mail_ref.incarnation, received_at: mail_ref.received_at, source_id: mail_ref.source_id, record_id: mail_ref.record_id, slug: mail_ref.slug }), original.reminder_id);
  db.prepare('UPDATE reminders SET mail_ref_json=? WHERE reminder_id=?').run('{invalid', corrupt.reminder_id);
  db.exec('DROP INDEX reminders_mail_state_at; ALTER TABLE reminders DROP COLUMN mail_ref_key');
  ensureReminderSchema(db); store = createReminderStore(db);
  expect(store.pagePending({ mail_ref, limit: 20 }).reminders.map(row => row.reminder_id)).toEqual([original.reminder_id]);
  expect(store.get(corrupt.reminder_id)?.mail_ref).toBeUndefined();
});

it('returns a saved reference on message reads and refuses replacement before reading any provider body', async () => {
  const fetch = () => { throw new Error('A provider body must not be read'); };
  const collection = { get: (id: string) => tables.get('work')!.get(id), accountEmail: 'owner@example.test', provider: { fetchMessage: fetch } };
  const deps = { getCollection: () => collection, getIncarnation: () => instances.getIncarnation!('mail', 'work'), listMailInstances: async () => ({ instances: [] }) };
  const read = await getMailMessage(deps, { slug: 'work', record_id: row.record_id });
  expect(read.reminder_ref).toEqual(reference());
  tables.get('work')!.upsert({ ...row, source_id: 'replacement' });
  await expect(getMailMessage(deps, { slug: 'work', record_id: row.record_id, expected_reminder_ref: read.reminder_ref }))
    .rejects.toMatchObject({ code: 'resource_changed' });
});
