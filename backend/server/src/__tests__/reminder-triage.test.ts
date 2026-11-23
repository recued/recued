import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defaultQuietHoursPolicy, type ReminderTriageApplyRequest, type QuietHoursPolicy } from '@recued/contracts';
import { createReminderStore } from '../storage/reminder-store.js';
import { createReminderDispatchers } from '../reminders/reminder-service.js';
import { makeReminderHandlers } from '../reminders/reminder-rpc-handler.js';
import { createReminderDelivery } from '../reminders/reminder-delivery.js';
import { reminderRevision } from '../reminders/reminder-revision.js';

const NOW = Date.parse('2026-11-01T04:30:00Z'), zone = 'America/New_York';
let dir: string, db: Database.Database, store: ReturnType<typeof createReminderStore>;
let clock: number, quiet: QuietHoursPolicy, currentZone: string;
const owner = { instance_id: 'owner', client_kind: 'webclient' } as never;
const service = () => createReminderDispatchers({ store, now: () => clock, timeZone: () => currentZone, quietHours: () => quiet });
const handlers = () => makeReminderHandlers({ dispatchers: service() })!.handlers;
const seed = (text: string, otherZone = zone) => store.create({ text, at: NOW + 3_600_000, time_zone: otherZone, origin: {} }, NOW);
const reviewed = async (ids: string[], at?: number): Promise<ReminderTriageApplyRequest> => {
  const out = await handlers()['reminder.triage.preview']({ reminder_ids: ids,
    action: at === undefined ? { kind: 'cancel' } : { kind: 'move', at, time_zone: currentZone } }, owner);
  return { request_id: 'review-1', action: out.action, items: out.items.filter(i => i.review_token)
    .map(i => ({ reminder_id: i.reminder_id, review_token: i.review_token! })) };
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reminder-triage-')); db = new Database(join(dir, 'test.db')); store = createReminderStore(db);
  clock = NOW; currentZone = zone; quiet = { ...defaultQuietHoursPolicy(), enabled: true, from_minute: 22 * 60, to_minute: 7 * 60 };
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

it('reviews the owner quiet-hours delay across DST, independent of the reminder and browser clocks, without writing', async () => {
  const r = seed('Call Tokyo', 'Asia/Tokyo'), at = Date.parse('2026-11-01T05:30:00Z');
  const before = store.get(r.reminder_id);
  const out = await handlers()['reminder.triage.preview']({ reminder_ids: [r.reminder_id], action: { kind: 'move', at, time_zone: zone } }, owner);
  expect(out.items[0]).toMatchObject({ review_token: expect.stringMatching(/^[a-f0-9]{64}$/),
    delivery_not_before: Date.parse('2026-11-01T12:00:00Z'), message: expect.stringContaining('Asia/Tokyo') });
  expect(out.items[0]?.message).toContain('7:00 AM (America/New_York)');
  expect(store.get(r.reminder_id)).toEqual(before);
  const request = await reviewed([r.reminder_id], at);
  expect((await handlers()['reminder.triage.apply'](request, owner)).items[0]?.status).toBe('applied');
  expect(store.get(r.reminder_id)).toMatchObject({ at, time_zone: 'Asia/Tokyo', text: 'Call Tokyo' });
});

it('refuses managed, finished and missing rows in review and in a forged apply', async () => {
  const finished = seed('Rang'); store.markDelivered(finished.reminder_id, NOW, ['in_app']);
  const managed = store.ensureClock({ text: 'Clock', at: NOW + 60_000, time_zone: zone, origin: {},
    clock: { occurrence_id: 'occ', point_key: 'p', ask_id: 'ask' } }, NOW);
  const out = await handlers()['reminder.triage.preview']({ reminder_ids: [finished.reminder_id, managed.reminder_id, 'missing'], action: { kind: 'cancel' } }, owner);
  expect(out.items.every(i => !i.review_token)).toBe(true);
  expect(out.items.map(i => i.message)).toEqual([expect.stringContaining('already rung'), expect.stringContaining('Yours'), expect.stringContaining('no longer available')]);
  const result = await handlers()['reminder.triage.apply']({ request_id: 'forged', action: { kind: 'cancel' },
    items: [{ reminder_id: managed.reminder_id, review_token: 'a'.repeat(64) }] }, owner);
  expect(result.items[0]?.status).toBe('needs_review'); expect(store.get(managed.reminder_id)?.state).toBe('pending');
});

it('does not overwrite edits, delivery or replacement after review, including edits in the same millisecond', async () => {
  const a = seed('Original'), b = seed('Will ring'), c = seed('Replaced');
  const request = await reviewed([a.reminder_id, b.reminder_id, c.reminder_id], NOW + 86_400_000);
  store.update(a.reminder_id, { text: 'New words' }, NOW); store.markDelivered(b.reminder_id, NOW, ['in_app']);
  db.prepare('UPDATE reminders SET created_at=created_at+1 WHERE reminder_id=?').run(c.reminder_id);
  const result = await handlers()['reminder.triage.apply'](request, owner);
  expect(result.items.map(i => i.status)).toEqual(['needs_review', 'needs_review', 'needs_review']);
  expect(store.get(a.reminder_id)).toMatchObject({ text: 'New words', at: a.at });
  expect(store.get(b.reminder_id)?.state).toBe('delivered'); expect(store.get(c.reminder_id)?.at).toBe(c.at);
});

it('checks the reviewed revision inside the SQLite write lock after a second connection changes it', () => {
  const r = seed('Before'), revision = reminderRevision(r), second = new Database(join(dir, 'test.db'));
  try {
    const other = createReminderStore(second); other.update(r.reminder_id, { text: 'Another connection' }, NOW);
    expect(store.applyReviewed({ request_id: 'atomic', reminder_id: r.reminder_id, fingerprint: 'f', expected_revision: revision, at: NOW + 86_400_000 }, NOW).applied).toBe(false);
    expect(store.get(r.reminder_id)).toMatchObject({ text: 'Another connection', at: r.at });
  } finally { second.close(); }
});

it('requires another review when quiet hours, the declared zone or the chosen future time change', async () => {
  const r = seed('Review settings'), request = await reviewed([r.reminder_id], NOW + 60_000);
  quiet = { ...quiet, to_minute: 8 * 60 };
  expect((await handlers()['reminder.triage.apply'](request, owner)).items[0]?.status).toBe('needs_review');
  quiet = { ...quiet, to_minute: 7 * 60 }; currentZone = 'Europe/London';
  expect((await handlers()['reminder.triage.apply'](request, owner)).items[0]?.status).toBe('needs_review');
  currentZone = zone; clock = NOW + 60_001;
  expect((await handlers()['reminder.triage.apply'](request, owner)).items[0]?.status).toBe('needs_review');
  expect(store.get(r.reminder_id)?.at).toBe(r.at);
});

it('commits individual successes and retries only the failed item without reapplying successes', async () => {
  const a = seed('Success'), b = seed('Failure'), request = await reviewed([a.reminder_id, b.reminder_id], NOW + 86_400_000);
  db.exec(`CREATE TRIGGER refuse_one BEFORE UPDATE ON reminders WHEN OLD.reminder_id='${b.reminder_id}' BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
  const result = await handlers()['reminder.triage.apply'](request, owner);
  expect(result.items.map(i => i.status)).toEqual(['applied', 'failed']);
  expect(store.get(a.reminder_id)?.at).toBe(NOW + 86_400_000); expect(store.get(b.reminder_id)?.at).toBe(b.at);
  store.update(a.reminder_id, { at: NOW + 2 * 86_400_000 }, NOW); db.exec('DROP TRIGGER refuse_one');
  expect((await handlers()['reminder.triage.apply']({ ...request, items: [request.items[1]!] }, owner)).items[0]?.status).toBe('applied');
  expect(store.get(a.reminder_id)?.at).toBe(NOW + 2 * 86_400_000);
});

it('replays lost acknowledgements after restart and pruning without resurrecting or changing a reminder again', async () => {
  const r = seed('Safe retry'), request = await reviewed([r.reminder_id], NOW + 86_400_000);
  expect((await handlers()['reminder.triage.apply'](request, owner)).items[0]?.status).toBe('applied');
  store.update(r.reminder_id, { at: NOW + 2 * 86_400_000 }, NOW);
  db.close(); db = new Database(join(dir, 'test.db')); store = createReminderStore(db);
  clock = NOW + 3 * 86_400_000;
  expect((await handlers()['reminder.triage.apply'](request, owner)).items[0]).toMatchObject({ status: 'applied', replayed: true, reminder: { at: NOW + 2 * 86_400_000 } });
  store.cancel(r.reminder_id, NOW); store.prune(NOW + 1);
  expect((await handlers()['reminder.triage.apply'](request, owner)).items[0]).toMatchObject({ status: 'applied', replayed: true });
  expect(store.get(r.reminder_id)).toBeNull();
  expect((await handlers()['reminder.triage.apply']({ ...request, action: { kind: 'cancel' } }, owner)).items[0]?.status).toBe('needs_review');
});

it('cancels only reviewed pending personal reminders and preserves their saved record links on moves', async () => {
  const r = store.create({ text: 'Linked', at: NOW + 60_000, time_zone: zone, origin: { channel: 'manual' },
    record_ref: { kind: 'commitment', id: 'c', source_id: 's', source_record_id: null, created_at: NOW } }, NOW);
  const move = await reviewed([r.reminder_id], NOW + 86_400_000);
  await handlers()['reminder.triage.apply'](move, owner);
  expect(store.get(r.reminder_id)?.record_ref).toEqual(r.record_ref);
  const cancel = { ...await reviewed([r.reminder_id]), request_id: 'cancel-2' };
  expect((await handlers()['reminder.triage.apply'](cancel, owner)).items[0]).toMatchObject({ status: 'applied', reminder: { state: 'cancelled' } });
  expect((await handlers()['reminder.triage.apply'](cancel, owner)).items[0]).toMatchObject({ status: 'applied', replayed: true });
});

it('bounds and validates selections, times and review tokens, and keeps both RPCs owner-only', async () => {
  const rpc = handlers(), good = { reminder_ids: ['rem-1'], action: { kind: 'cancel' as const } };
  for (const other of [{}, { instance_id: 'bridge', client_kind: 'bridge' }, { client_kind: 'webclient' }]) {
    await expect(rpc['reminder.triage.preview'](good, other as never)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(rpc['reminder.triage.apply']({} as never, other as never)).rejects.toMatchObject({ code: 'unauthorized' });
  }
  for (const raw of [{ ...good, reminder_ids: [] }, { ...good, reminder_ids: ['x', 'x'] },
    { ...good, reminder_ids: Array.from({ length: 201 }, (_, i) => `r${i}`) },
    { ...good, action: { kind: 'move', at: NOW - 1, time_zone: zone } },
    { ...good, action: { kind: 'move', at: 1e20, time_zone: zone } }])
    await expect(rpc['reminder.triage.preview'](raw as never, owner)).rejects.toMatchObject({ code: 'bad_request' });
  await expect(rpc['reminder.triage.apply']({ request_id: 'x', action: { kind: 'cancel' }, items: [{ reminder_id: 'x', review_token: '' }] }, owner)).rejects.toMatchObject({ code: 'bad_request' });
});

it('skips a queued delivery snapshot after bulk move while a preceding send waits', async () => {
  const a = seed('First'), b = seed('Move before sending');
  clock = a.at;
  let release: (() => void) | undefined;
  const sent: string[] = [];
  const delivery = createReminderDelivery({ store, now: () => clock, isQuiet: () => false,
    send: async message => {
      sent.push(message.text);
      if (sent.length === 1) await new Promise<void>(done => { release = done; });
      return { delivered_to: ['in_app'] };
    },
  });
  // SQLite sorts equal instants by ID. Give the queued row a later due instant.
  store.update(a.reminder_id, { at: clock - 1 }, NOW);
  const tick = delivery.tick();
  expect(sent).toEqual(['First']);
  const request = await reviewed([b.reminder_id], clock + 86_400_000);
  expect((await handlers()['reminder.triage.apply'](request, owner)).items[0]?.status).toBe('applied');
  release!(); await tick;
  expect(sent).toEqual(['First']); expect(store.get(b.reminder_id)).toMatchObject({ state: 'pending', attempts: 0, at: clock + 86_400_000 });
  clock += 86_400_000; await delivery.tick();
  expect(sent).toEqual(['First', 'Move before sending']);
  expect(store.get(b.reminder_id)?.state).toBe('delivered'); await delivery.stop();
});
