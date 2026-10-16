/** D-324 §6 — D-193's reminder tasks become reminders, once, at server start.
 *
 *  ⛔ What this pins: a waiting reminder task on Recued's own tasks is copied
 *  and its task closed (not deleted); one already rung is only closed; one in a
 *  vendor's tasks is left as it was and named once; nothing else is touched; and
 *  a second start repeats none of it. A copied reminder whose time passed while
 *  no notifier ran rings at the next check, saying which time it was for. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECUED_BUILTIN_SOURCE_ID, WORK_ENTITY_KINDS } from '@recued/contracts';

import { createReminderDelivery } from '../reminders/reminder-delivery.js';
import { moveReminderTasks } from '../reminders/reminder-task-move.js';
import { createReminderStore, type ReminderStore } from '../storage/reminder-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';

const NY = 'America/New_York';
const HOUR = 3_600_000;
/** Thursday 15 October 2026, 10:00 in New York. */
const NOW = Date.UTC(2026, 9, 15, 14, 0);

let dir: string;
let db: Database.Database;
let work: WorkEntityStore;
let reminders: ReminderStore;
const activities: Array<{ action: string; detail: string }> = [];

const reminderTask = (over: Record<string, unknown>) => work.writeTask({
  source_id: RECUED_BUILTIN_SOURCE_ID('task'), title: 'Reminder: Call the dentist', body: 'Call the dentist',
  due_at: NOW + 2 * HOUR, state: 'reminder_pending', source_extension_blob: { kind: 'recued_reminder' }, ...over,
} as never, NOW - 24 * HOUR);

const move = () => moveReminderTasks({
  workEntityStore: work, store: reminders, timeZone: () => NY, now: () => NOW,
  logActivity: async (entry) => { activities.push({ action: entry.action, detail: entry.detail }); },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd324-task-move-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  work = createWorkEntityStore(db);
  for (const kind of WORK_ENTITY_KINDS) {
    work.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind, source_kind: 'builtin', source_label: 'Recued built-in',
      write_capable: true, registered_at: NOW,
    });
  }
  work.registerSource({
    id: 'asana.home.task', top_tier_kind: 'task', source_kind: 'connection', source_label: 'Asana (home)',
    write_capable: true, registered_at: NOW,
  });
  reminders = createReminderStore(db);
  activities.length = 0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-324 §6 — moving the reminder tasks', () => {
  it('copies a waiting one and closes its task, closes a rung one, and leaves a vendor’s alone', async () => {
    const waiting = reminderTask({});
    const missed = reminderTask({ title: 'Reminder: Pay rent', body: '', due_at: NOW - 3 * 24 * HOUR });
    const rung = reminderTask({ title: 'Reminder: Stretch', body: 'Stretch', state: 'reminder_fired' });
    const vendor = reminderTask({ source_id: 'asana.home.task', title: 'Reminder: Renew passport' });
    const plain = work.writeTask({ source_id: RECUED_BUILTIN_SOURCE_ID('task'), title: 'Write the report', due_at: NOW } as never, NOW);
    const done = reminderTask({ title: 'Reminder: Old', done: true });

    expect(await move()).toEqual({ moved: 2, closed: 1, left_in_vendor: ['Reminder: Renew passport'] });

    const pending = reminders.listPending(10);
    expect(pending.map((r) => [r.text, r.at])).toEqual([
      ['Pay rent', NOW - 3 * 24 * HOUR],
      ['Call the dentist', NOW + 2 * HOUR],
    ]);
    expect(pending.every((r) => r.time_zone === NY && r.origin.recipe_id === 'remind-me-of')).toBe(true);

    // Closed, not deleted, and out of the old watcher's reach.
    expect(work.readTask(waiting.id)).toMatchObject({ done: true, state: 'reminder_moved', completed_at: NOW, title: waiting.title });
    expect(work.readTask(missed.id)).toMatchObject({ done: true, state: 'reminder_moved' });
    expect(work.readTask(rung.id)).toMatchObject({ done: true, state: 'reminder_fired' });
    // ⛔ Untouched: a vendor's task, an ordinary task, one already done.
    expect(work.readTask(vendor.id)).toMatchObject({ done: false, state: 'reminder_pending' });
    expect(work.readTask(plain.id)).toEqual(plain);
    expect(work.readTask(done.id)).toEqual(done);

    expect(activities).toEqual([{
      action: 'reminders_moved', detail: 'moved=2 closed=1 left_in_vendor=1: "Reminder: Renew passport"',
    }]);
  });

  it('repeats nothing on the next start', async () => {
    reminderTask({});
    reminderTask({ source_id: 'asana.home.task', title: 'Reminder: Renew passport' });
    await move();
    activities.length = 0;
    expect(await move()).toEqual({ moved: 0, closed: 0, left_in_vendor: [] });
    expect(reminders.countPending()).toBe(1);
    expect(activities).toEqual([]);
  });

  it('finishes a move a start stopped halfway: copied, not yet closed', async () => {
    const task = reminderTask({});
    reminders.create({ text: 'Call the dentist', at: task.due_at!, time_zone: NY, origin: {}, from_task_id: task.id }, NOW);
    expect(await move()).toMatchObject({ moved: 1 });
    expect(reminders.countPending()).toBe(1);
    expect(work.readTask(task.id)).toMatchObject({ done: true, state: 'reminder_moved' });
  });

  it('logs nothing when there was nothing to move', async () => {
    work.writeTask({ source_id: RECUED_BUILTIN_SOURCE_ID('task'), title: 'Write the report' } as never, NOW);
    expect(await move()).toEqual({ moved: 0, closed: 0, left_in_vendor: [] });
    expect(activities).toEqual([]);
  });

  it('a moved reminder whose time passed while no notifier ran rings at the next check, saying when it was for', async () => {
    reminderTask({ title: 'Reminder: Pay rent', body: 'Pay rent', due_at: Date.UTC(2026, 9, 12, 13, 0) });
    await move();
    const sent: string[] = [];
    const delivery = createReminderDelivery({
      store: reminders,
      send: async (message) => { sent.push(message.text); return { delivered_to: ['in_app'] }; },
      isQuiet: () => false,
      now: () => NOW,
    });
    await delivery.tick();
    expect(sent).toEqual(['For Monday 12 October at 9:00 AM: Pay rent']);
  });
});
