import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMINDER_HISTORY_MS, defaultQuietHoursPolicy, type ReminderState } from '@recued/contracts';
import { createReminderStore } from '../storage/reminder-store.js';
import { createReminderDispatchers } from '../reminders/reminder-service.js';
import { makeReminderHandlers } from '../reminders/reminder-rpc-handler.js';

const NOW = Date.parse('2026-11-01T15:00:00Z'), DAY = 86_400_000;
const client = { instance_id: 'reminder-search-owner', client_kind: 'webclient' } as never;
let db: Database.Database, store: ReturnType<typeof createReminderStore>;
let rpc: NonNullable<ReturnType<typeof makeReminderHandlers>>['handlers']['reminder.list'];
beforeEach(() => {
  db = new Database(':memory:'); store = createReminderStore(db);
  rpc = makeReminderHandlers({ dispatchers: createReminderDispatchers({ store, now: () => NOW,
    timeZone: () => 'America/New_York', quietHours: defaultQuietHoursPolicy }) })!.handlers['reminder.list'];
});
afterEach(() => db.close());
const seed = (text: string, state: ReminderState, at = NOW - DAY, finished = NOW, zone = 'Asia/Tokyo') => {
  const row = store.create({ text, at, time_zone: zone, origin: {} }, NOW);
  if (state === 'delivered') store.markDelivered(row.reminder_id, finished, ['in_app']);
  if (state === 'cancelled') store.cancel(row.reminder_id, finished);
  return row.reminder_id;
};

describe('shared reminder search', () => {
  it('searches each status and retained history without writing or changing legacy waiting lists', async () => {
    const pending = seed('Clinic follow up', 'pending', NOW + DAY);
    const rang = seed('Clinic results', 'delivered'), cancelled = seed('Clinic appointment', 'cancelled');
    const boundary = seed('Clinic boundary', 'cancelled', NOW - 40 * DAY, NOW - REMINDER_HISTORY_MS);
    const expired = seed('Clinic expired', 'delivered', NOW - 40 * DAY, NOW - REMINDER_HISTORY_MS - 1);
    const managed = store.ensureClock({ text: 'Clinic managed', at: NOW + DAY, time_zone: 'Pacific/Auckland', origin: {},
      clock: { occurrence_id: 'o', point_key: 'p', ask_id: 'a' } }, NOW);
    const before = db.prepare('SELECT * FROM reminders ORDER BY reminder_id').all();
    const all = await rpc({ page: { query: 'clinic', state: 'all' } }, client);
    expect(all.page).toMatchObject({ state: 'all', matched_count: 5, next_cursor: null });
    expect(new Set(all.reminders.map(row => row.reminder_id))).toEqual(new Set([pending, rang, cancelled, boundary, managed.reminder_id]));
    expect(all.reminders.find(row => row.reminder_id === rang)).toMatchObject({ state: 'delivered', time_zone: 'Asia/Tokyo' });
    expect(all.reminders.find(row => row.reminder_id === managed.reminder_id)).toMatchObject({ managed_by: 'clock', time_zone: 'Pacific/Auckland' });
    for (const state of ['pending', 'delivered', 'cancelled'] as const) {
      const out = await rpc({ page: { query: 'clinic', state } }, client);
      expect(out.page?.state).toBe(state); expect(out.reminders.every(row => row.state === state)).toBe(true);
      expect(out.page?.matched_count).toBe(state === 'delivered' ? 1 : 2);
    }
    const legacy = await rpc({ page: {}, include_delivered: true }, client);
    expect(legacy.page?.state).toBeUndefined(); expect(legacy.reminders).toHaveLength(2);
    expect(legacy.reminders.every(row => row.state === 'pending')).toBe(true);
    expect(store.get(expired)).not.toBeNull();
    expect(db.prepare('SELECT * FROM reminders ORDER BY reminder_id').all()).toEqual(before);
  });

  it('finds history beyond the first page with stable ties and literal Unicode/date filters before paging', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 65; i++) ids.push(seed('École %_ invoice ' + i, 'delivered'));
    for (let i = 0; i < 25; i++) seed('Unrelated earlier history ' + i, 'cancelled', NOW - 2 * DAY);
    seed('École %_ outside the dates', 'delivered', NOW - 3 * DAY);
    seed('École %_ expired', 'delivered', NOW - DAY, NOW - REMINDER_HISTORY_MS - 1);
    seed('Ecole XX invoice', 'delivered');
    const found: string[] = [];
    let cursor: { at: number; reminder_id: string } | null = null;
    for (let page = 0; page < 4; page++) {
      const out = await rpc({ limit: 31, page: { state: 'delivered', query: 'E\u0301COLE %_', from: NOW - DAY, before: NOW,
        ...(cursor ? { cursor } : {}) } }, client);
      expect(out.page).toMatchObject({ state: 'delivered', matched_count: 65 });
      found.push(...out.reminders.map(row => row.reminder_id)); cursor = out.page!.next_cursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull(); expect(found).toEqual(ids.sort()); expect(new Set(found).size).toBe(65);
  });

  it('uses delivery time for delivery retention and update time for cancellation retention', async () => {
    const rang = seed('Retained clinic', 'delivered', NOW - 90 * DAY, NOW - DAY);
    const cancelled = seed('Retained clinic', 'cancelled', NOW - 90 * DAY, NOW - DAY);
    seed('Expired clinic', 'cancelled', NOW - DAY, NOW - REMINDER_HISTORY_MS - 1);
    const out = await rpc({ page: { state: 'all', query: 'clinic' } }, client);
    expect(new Set(out.reminders.map(row => row.reminder_id))).toEqual(new Set([rang, cancelled]));
  });

  it('refuses malformed scopes and keeps history searches owner-only', async () => {
    for (const page of [{ state: 'lost' }, { state: null }, { state: ['pending'] }, { state: 'all', query: 'x'.repeat(201) },
      { state: 'all', from: NOW, before: NOW }, { state: 'all', cursor: { at: NOW, reminder_id: '' } }]) {
      await expect(rpc({ page } as never, client)).rejects.toMatchObject({ code: 'bad_request' });
    }
    await expect(rpc({ page: { state: 'all' } }, { instance_id: 'bridge', client_kind: 'bridge' } as never))
      .rejects.toMatchObject({ code: 'unauthorized' });
  });
});
