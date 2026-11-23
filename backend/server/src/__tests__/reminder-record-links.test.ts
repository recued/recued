import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defaultQuietHoursPolicy, REMINDER_HISTORY_MS, type ReminderRecordReference, type WorkEntity } from '@recued/contracts';
import { wireReminderDispatchers } from '../composition/bin/wire-reminders.js';
import { makeReminderHandlers } from '../reminders/reminder-rpc-handler.js';
import { createReminderDispatchers } from '../reminders/reminder-service.js';
import { createReminderStore, ensureReminderSchema } from '../storage/reminder-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';

const NOW = Date.parse('2026-11-21T18:00:00Z'), client = { instance_id: 'record-reminder-owner', client_kind: 'webclient' } as never;
let dir: string, db: Database.Database, clock: number;
let work: ReturnType<typeof createWorkEntityStore>, reminders: ReturnType<typeof createReminderStore>;
const service = () => wireReminderDispatchers({ db, now: () => clock,
  serverTimeZoneStore: { read: () => ({ mode: 'fixed', zone: 'America/Los_Angeles', updated_at: NOW }) },
  quietHoursStore: { read: defaultQuietHoursPolicy },
});
const rpc = () => makeReminderHandlers({ dispatchers: service() })!.handlers;
const ref = (row: WorkEntity): ReminderRecordReference => {
  if (row._kind !== 'task' && row._kind !== 'commitment') throw new Error('Wrong fixture kind');
  return { kind: row._kind, id: row.id, source_id: row.source_id, source_record_id: row.source_record_id ?? null, created_at: row.created_at };
};
const request = (record_ref = ref(work.readByKind('task', 'task-one')!)) => ({ text: 'Follow up', at: NOW + 3600_000, creation_id: 'create-once', record_ref });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reminder-record-links-'));
  db = new Database(join(dir, 'test.db')); ensureWorkEntitySchema(db);
  work = createWorkEntityStore(db); reminders = createReminderStore(db); clock = NOW;
  for (const kind of ['task', 'commitment'] as const) work.registerSource({ id: 'recued.' + kind, top_tier_kind: kind,
    source_kind: 'builtin', source_label: 'Recued', write_capable: false, registered_at: NOW });
  work.writeTask({ id: 'task-one', source_id: 'recued.task', title: 'Read-only task', done: false, due_at: NOW + 86400_000 }, NOW);
  work.writeCommitment({ id: 'promise-one', source_id: 'recued.commitment', statement: 'Send proposal',
    direction: 'outbound', derivation: 'user_declared', promised_at: NOW, promised_for_at: NOW + 2 * 86400_000 }, NOW);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

it('retains exact task and commitment identities across restart, edits and history without changing either source', async () => {
  const before = [work.readByKind('task', 'task-one'), work.readByKind('commitment', 'promise-one')];
  for (const row of before) {
    const record_ref = ref(row!), handlers = rpc();
    const { reminder } = await handlers['reminder.create']({ ...request(record_ref), creation_id: record_ref.kind }, client);
    expect(reminder.record_ref).toEqual(record_ref);
    await handlers['reminder.update']({ reminder_id: reminder.reminder_id, text: 'Different wording', at: NOW + 7200_000 }, client);
    if (record_ref.kind === 'task') await handlers['reminder.cancel']({ reminder_id: reminder.reminder_id }, client);
    else reminders.markDelivered(reminder.reminder_id, NOW + 7200_000, ['in_app']);
  }
  db.close(); db = new Database(join(dir, 'test.db'));
  work = createWorkEntityStore(db); reminders = createReminderStore(db);
  const history = await rpc()['reminder.list']({ page: { state: 'all' } }, client);
  expect(history.record_links_supported).toBe(true);
  expect(history.reminders.map(row => [row.state, row.record_ref?.kind]).sort()).toEqual([['cancelled', 'task'], ['delivered', 'commitment']]);
  for (const row of history.reminders)
    expect((await rpc()['reminder.get']({ reminder_id: row.reminder_id }, client)).reminder?.record_ref).toEqual(row.record_ref);
  expect([work.readByKind('task', 'task-one'), work.readByKind('commitment', 'promise-one')]).toEqual(before);
});

it('reconciles a lost reply after source removal and time passage, retaining terminal receipts without rearming', async () => {
  const args = request(), handlers = rpc(), original = await handlers['reminder.create'](args, client);
  work.deleteTask('task-one', { tombstone: false }); clock = NOW + 2 * 86400_000;
  expect((await handlers['reminder.create'](args, client)).reminder.reminder_id).toBe(original.reminder.reminder_id);
  reminders.cancel(original.reminder.reminder_id, clock);
  expect((await handlers['reminder.create'](args, client)).reminder.state).toBe('cancelled');
  reminders.prune(clock + REMINDER_HISTORY_MS + 1);
  await expect(handlers['reminder.create'](args, client)).rejects.toMatchObject({ code: 'conflict' });
  expect(reminders.countPending()).toBe(0);
});

it('includes the binding in creation identity while preserving legacy unbound receipts and owner scoping', async () => {
  const handlers = rpc(), args = request();
  await handlers['reminder.create'](args, client);
  await expect(handlers['reminder.create']({ ...args, record_ref: ref(work.readByKind('commitment', 'promise-one')!) }, client))
    .rejects.toMatchObject({ code: 'conflict' });
  await expect(handlers['reminder.create']({ ...args, record_ref: undefined }, client)).rejects.toMatchObject({ code: 'conflict' });
  const plain = { text: 'Plain reminder', at: args.at, creation_id: 'plain' };
  const first = await handlers['reminder.create'](plain, client);
  expect((await handlers['reminder.create'](plain, client)).reminder.reminder_id).toBe(first.reminder.reminder_id);
  const other = await handlers['reminder.create'](plain, { instance_id: 'other-owner', client_kind: 'webclient' } as never);
  expect(other.reminder.reminder_id).not.toBe(first.reminder.reminder_id);
});

it('rejects unpaired callers and malformed or mismatched saved lifetimes without creating a reminder', async () => {
  const handlers = rpc(), args = request();
  for (const who of [{ client_kind: 'webclient' }, { instance_id: 'bridge', client_kind: 'bridge' }])
    await expect(handlers['reminder.create'](args, who as never)).rejects.toMatchObject({ code: 'unauthorized' });
  for (const record_ref of [null, {}, { ...args.record_ref, kind: 'project' }, { ...args.record_ref, created_at: NaN },
    { ...args.record_ref, source_id: 'other' }, { ...args.record_ref, source_record_id: 'replacement' }, { ...args.record_ref, created_at: NOW + 1 }]) {
    await expect(handlers['reminder.create']({ ...args, record_ref } as never, client)).rejects.toMatchObject({ code: 'bad_request' });
  }
  expect(reminders.countPending()).toBe(0);
});

it('refuses deleted, orphaned, stale and pending records and read-through residue, even when their IDs still exist', async () => {
  const saved = work.readByKind('task', 'task-one')!, args = request();
  for (const patch of [{ deleted_at: NOW }, { sync_state: 'orphaned' }, { sync_state: 'stale_unreachable' },
    { sync_state: 'tombstoned' }, { pending_write: { staged_at: NOW, operation: 'update', dirty_fields: ['title'], state: 'pending' } }] as const) {
    const dispatch = createReminderDispatchers({ store: reminders, timeZone: () => 'UTC', quietHours: defaultQuietHoursPolicy,
      now: () => NOW, readRecord: () => ({ ...saved, ...patch }) as WorkEntity });
    await expect(dispatch.reminderCreate(args)).rejects.toThrow();
  }
  work.registerSource({ ...work.listSources().find(row => row.id === saved.source_id)!, sync_posture: 'read_through' });
  await expect(rpc()['reminder.create'](args, client)).rejects.toMatchObject({ code: 'bad_request' });
  expect(reminders.countPending()).toBe(0);
});

it('does not advertise binding support without a saved-record reader and refuses a bound create there', async () => {
  const dispatch = createReminderDispatchers({ store: reminders, timeZone: () => 'UTC', now: () => NOW, quietHours: defaultQuietHoursPolicy });
  expect((await dispatch.reminderList({})).record_links_supported).toBeUndefined();
  await expect(dispatch.reminderCreate(request())).rejects.toThrow();
});

it('filters the full saved identity before counting and paging, including a removed source record', async () => {
  const record_ref = request().record_ref;
  const seed = (reference?: ReminderRecordReference, at = NOW + 3600_000) =>
    reminders.create({ text: 'Follow up', at, time_zone: 'UTC', origin: {}, ...(reference ? { record_ref: reference } : {}) }, NOW);
  const expected = Array.from({ length: 25 }, () => seed(record_ref).reminder_id).sort();
  for (const other of [undefined, { ...record_ref, kind: 'commitment' as const }, { ...record_ref, id: 'other' },
    { ...record_ref, source_id: 'vendor' }, { ...record_ref, source_record_id: 'replacement' }, { ...record_ref, created_at: NOW + 1 }])
    seed(other, NOW + 1);
  work.deleteTask('task-one', { tombstone: false });
  const first = await rpc()['reminder.list']({ limit: 20, page: { state: 'pending', record_ref } }, client);
  expect(first.page).toMatchObject({ record_ref, matched_count: 25 });
  expect(first.reminders.map(row => row.reminder_id)).toEqual(expected.slice(0, 20));
  const second = await rpc()['reminder.list']({ limit: 20, page: { state: 'pending', record_ref, cursor: first.page!.next_cursor! } }, client);
  expect(second.page).toMatchObject({ record_ref, matched_count: 25, next_cursor: null });
  expect(second.reminders.map(row => row.reminder_id)).toEqual(expected.slice(20));
  expect((await rpc()['reminder.list']({}, client)).count).toBe(31);
});

it('scopes recent terminal history and the legacy delivered field without including pending or expired rows', async () => {
  const record_ref = request().record_ref;
  const seed = (reference = record_ref) =>
    reminders.create({ text: 'History', at: NOW + 3600_000, time_zone: 'UTC', origin: {}, record_ref: reference }, NOW);
  const waiting = seed(), cancelled = seed(), delivered = seed(), expired = seed(), unrelated = seed({ ...record_ref, created_at: NOW + 1 });
  reminders.cancel(cancelled.reminder_id, NOW);
  reminders.markDelivered(delivered.reminder_id, NOW, ['in_app']);
  reminders.cancel(expired.reminder_id, NOW - REMINDER_HISTORY_MS - 1);
  reminders.cancel(unrelated.reminder_id, NOW);
  const history = await rpc()['reminder.list']({ page: { state: 'all', history_only: true, record_ref } }, client);
  expect(history.page).toMatchObject({ record_ref, history_only: true, matched_count: 2, next_cursor: null });
  expect(history.reminders.map(row => row.reminder_id).sort()).toEqual([cancelled.reminder_id, delivered.reminder_id].sort());
  const both = await rpc()['reminder.list']({ include_delivered: true, page: { state: 'pending', record_ref } }, client);
  expect(both.reminders.map(row => row.reminder_id)).toEqual([waiting.reminder_id]);
  expect(both.delivered?.map(row => row.reminder_id).sort()).toEqual([cancelled.reminder_id, delivered.reminder_id].sort());
});

it('upgrades existing reference JSON and resumes a partial backfill across restart without linking corrupt rows', () => {
  const record_ref = request().record_ref;
  const first = reminders.create({ text: 'Legacy', at: NOW + 3600_000, time_zone: 'UTC', origin: {}, record_ref }, NOW);
  const corrupt = reminders.create({ text: 'Corrupt old reference', at: NOW + 3600_000, time_zone: 'UTC', origin: {} }, NOW);
  db.prepare('UPDATE reminders SET record_ref_json=? WHERE reminder_id=?').run(JSON.stringify({
    created_at: record_ref.created_at, source_record_id: null, source_id: record_ref.source_id, id: record_ref.id, kind: record_ref.kind,
  }), first.reminder_id);
  db.prepare('UPDATE reminders SET record_ref_json=? WHERE reminder_id=?').run('{invalid', corrupt.reminder_id);
  db.exec('DROP INDEX reminders_record_state_at; ALTER TABLE reminders DROP COLUMN record_ref_key');
  ensureReminderSchema(db);
  // An upgrade that already added the column can resume the remaining rows.
  db.prepare('UPDATE reminders SET record_ref_key=NULL WHERE reminder_id=?').run(first.reminder_id);
  db.close(); db = new Database(join(dir, 'test.db')); reminders = createReminderStore(db);
  expect(reminders.pagePending({ record_ref, limit: 20 }).reminders.map(row => row.reminder_id)).toEqual([first.reminder_id]);
  reminders.update(first.reminder_id, { at: NOW + 7200_000 }, NOW);
  reminders.cancel(first.reminder_id, NOW);
  expect(reminders.pageSearch({ record_ref, state: 'all', history_only: true, history_since: NOW - REMINDER_HISTORY_MS, limit: 20 })
    .reminders.map(row => row.reminder_id)).toEqual([first.reminder_id]);
  expect(reminders.get(corrupt.reminder_id)?.record_ref).toBeUndefined();
});

it('rejects malformed record-list scopes and terminal-history flags at the paired RPC boundary', async () => {
  const handlers = rpc(), record_ref = request().record_ref;
  for (const page of [{ record_ref: null }, { record_ref: {} }, { record_ref: { ...record_ref, kind: 'note' } },
    { record_ref: { ...record_ref, created_at: NaN } }, { history_only: false }, { history_only: true },
    { state: 'pending', history_only: true }])
    await expect(handlers['reminder.list']({ page } as never, client)).rejects.toMatchObject({ code: 'bad_request' });
  await expect(handlers['reminder.list']({ page: { record_ref, state: 'all' } }, { client_kind: 'webclient' } as never))
    .rejects.toMatchObject({ code: 'unauthorized' });
});
