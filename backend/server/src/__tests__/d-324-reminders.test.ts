/** D-324 — a reminder is its own record: set, listed, changed, cancelled, and
 *  rung once by the server's minute service.
 *
 *  ⛔ What these pin, beyond the happy path: a reminder rings ONCE (a second
 *  check sends nothing), a send no channel took leaves it waiting for the next
 *  minute (D-193's rule), a cancel wins over a send that has not happened yet,
 *  and a time that has passed is refused with the time worded — a model that got
 *  the day wrong hears it at once, not when nothing rings. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REMINDER_HISTORY_MS,
  REMINDER_PENDING_MAX,
  defaultQuietHoursPolicy,
  type QuietHoursPolicy,
} from '@recued/contracts';

import { createReminderDelivery, type ReminderMessage } from '../reminders/reminder-delivery.js';
import { makeReminderHandlers } from '../reminders/reminder-rpc-handler.js';
import { ReminderInputError, createReminderDispatchers } from '../reminders/reminder-service.js';
import { ReminderLimitError, createReminderStore, type ReminderStore } from '../storage/reminder-store.js';

const NY = 'America/New_York';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Thursday 15 October 2026, 10:00 in New York (EDT, UTC-4). */
const NOW = Date.UTC(2026, 9, 15, 14, 0);
/** Friday 16 October 2026, 15:00 in New York. */
const FRIDAY_3PM = Date.UTC(2026, 9, 16, 19, 0);

let dir: string;
let db: Database.Database;
let store: ReminderStore;
let clock: number;
let quiet: QuietHoursPolicy;

const reminders = () => createReminderDispatchers({
  store, timeZone: () => NY, quietHours: () => quiet, now: () => clock,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd324-reminders-'));
  db = new Database(join(dir, 'test.db'));
  store = createReminderStore(db);
  clock = NOW;
  quiet = defaultQuietHoursPolicy();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('setting a reminder', () => {
  it('keeps it waiting, with its time worded on the owner’s clock and where it was asked', async () => {
    const out = await reminders().reminderCreate({
      text: '  call   the dentist ', at: FRIDAY_3PM, origin: { channel: 'messenger', vendor: 'email', recipe_id: 'remind-me-of' },
    });
    expect(out).toEqual({
      reminder: expect.objectContaining({ text: 'call the dentist', at: FRIDAY_3PM, state: 'pending', delivered_at: null }),
      when: 'Friday 16 October at 3:00 PM',
      confirmation: 'Friday 16 October at 3:00 PM',
    });
    expect(store.get(out.reminder.reminder_id)).toMatchObject({
      time_zone: NY,
      origin: { channel: 'messenger', vendor: 'email', recipe_id: 'remind-me-of' },
      attempts: 0,
    });
  });

  it('refuses a time that has passed, saying which time it read', async () => {
    const yesterday = NOW - 25 * HOUR;
    await expect(reminders().reminderCreate({ text: 'call the dentist', at: yesterday }))
      .rejects.toThrow('That time has passed: Wednesday 14 October at 9:00 AM. Pick a time still to come.');
    expect(store.countPending()).toBe(0);
  });

  it('sets one a moment ago, the time a model took to call it: it rings at the next check', async () => {
    const out = await reminders().reminderCreate({ text: 'stretch', at: NOW - MINUTE });
    expect(out.reminder.state).toBe('pending');
  });

  it('refuses no words and too many words', async () => {
    await expect(reminders().reminderCreate({ text: '   ', at: FRIDAY_3PM })).rejects.toBeInstanceOf(ReminderInputError);
    await expect(reminders().reminderCreate({ text: 'x'.repeat(501), at: FRIDAY_3PM }))
      .rejects.toThrow('A reminder is at most 500 characters; this one is 501.');
  });

  it('stops at the cap, and a cancel frees a place', async () => {
    for (let i = 0; i < REMINDER_PENDING_MAX; i += 1) {
      store.create({ text: `r${i}`, at: FRIDAY_3PM + i, time_zone: NY, origin: {} }, NOW);
    }
    await expect(reminders().reminderCreate({ text: 'one more', at: FRIDAY_3PM }))
      .rejects.toBeInstanceOf(ReminderLimitError);
    const [first] = store.listPending(1);
    store.cancel(first!.reminder_id, NOW);
    await expect(reminders().reminderCreate({ text: 'one more', at: FRIDAY_3PM })).resolves.toBeDefined();
  });

  it('says so at once when its time falls in quiet hours, and when it will come (P1)', async () => {
    quiet = { ...quiet, enabled: true, from_minute: 22 * 60, to_minute: 7 * 60 };
    const late = Date.UTC(2026, 9, 17, 3, 0); // Friday 23:00 in New York
    const out = await reminders().reminderCreate({ text: 'take the bins out', at: late });
    expect(out.quiet_hours_note).toBe("That's in your quiet hours, so it will come Saturday 17 October at 7:00 AM.");
    expect(out.confirmation).toBe(
      "Friday 16 October at 11:00 PM. That's in your quiet hours, so it will come Saturday 17 October at 7:00 AM.",
    );
    // Outside the window, no note.
    expect((await reminders().reminderCreate({ text: 'call', at: FRIDAY_3PM })).quiet_hours_note).toBeUndefined();
  });
});

describe('listing, changing and cancelling', () => {
  it('lists the waiting ones soonest first, and the rung ones on request', async () => {
    const later = await reminders().reminderCreate({ text: 'later', at: FRIDAY_3PM + HOUR });
    const sooner = await reminders().reminderCreate({ text: 'sooner', at: FRIDAY_3PM });
    const rung = await reminders().reminderCreate({ text: 'rung', at: NOW + MINUTE });
    store.markDelivered(rung.reminder.reminder_id, NOW + MINUTE, ['in_app']);

    const list = await reminders().reminderList({});
    expect(list.reminders.map((r) => r.text)).toEqual(['sooner', 'later']);
    expect(list.count).toBe(2);
    expect(list).not.toHaveProperty('delivered');
    expect(list.reminders[0]).toMatchObject({ reminder_id: sooner.reminder.reminder_id, when: 'Friday 16 October at 3:00 PM' });
    expect(later.reminder.state).toBe('pending');

    const withHistory = await reminders().reminderList({ include_delivered: true });
    expect(withHistory.delivered?.map((r) => [r.text, r.state])).toEqual([['rung', 'delivered']]);
  });

  it('moves a waiting one, and its tries start afresh', async () => {
    const { reminder } = await reminders().reminderCreate({ text: 'call', at: NOW });
    store.recordAttempt(reminder.reminder_id, NOW);
    const out = await reminders().reminderUpdate({ reminder_id: reminder.reminder_id, at: FRIDAY_3PM, text: 'call mum' });
    expect(out).toMatchObject({
      updated: true, when: 'Friday 16 October at 3:00 PM', message: 'Changed: Friday 16 October at 3:00 PM.',
      reminder: { text: 'call mum', at: FRIDAY_3PM },
    });
    expect(store.get(reminder.reminder_id)).toMatchObject({ attempts: 0 });
    await expect(reminders().reminderUpdate({ reminder_id: reminder.reminder_id, at: NOW - 2 * HOUR }))
      .rejects.toThrow('That time has passed');
  });

  it('changes and cancels nothing that has rung, and says why', async () => {
    const { reminder } = await reminders().reminderCreate({ text: 'call', at: NOW + MINUTE });
    store.markDelivered(reminder.reminder_id, NOW + MINUTE, ['in_app']);
    expect(await reminders().reminderUpdate({ reminder_id: reminder.reminder_id, text: 'other' })).toMatchObject({
      updated: false, reason: 'not_pending', message: 'Not changed: that reminder has already rung.',
    });
    expect(await reminders().reminderCancel({ reminder_id: reminder.reminder_id })).toMatchObject({
      cancelled: false, reason: 'not_pending', message: 'Not cancelled: that reminder has already rung.',
    });
    expect(store.get(reminder.reminder_id)).toMatchObject({ text: 'call', state: 'delivered' });
    expect(await reminders().reminderCancel({ reminder_id: 'rem_nope' })).toMatchObject({
      cancelled: false, reason: 'not_found',
    });
  });

  it('cancels a waiting one, once', async () => {
    const { reminder } = await reminders().reminderCreate({ text: 'call', at: FRIDAY_3PM });
    expect(await reminders().reminderCancel({ reminder_id: reminder.reminder_id })).toMatchObject({
      cancelled: true, message: 'Cancelled: it will not ring.', reminder: { state: 'cancelled' },
    });
    expect(await reminders().reminderCancel({ reminder_id: reminder.reminder_id })).toMatchObject({
      cancelled: false, message: 'That reminder was already cancelled.',
    });
  });
});

describe('ringing', () => {
  const sent: ReminderMessage[] = [];
  let channels: () => readonly string[];
  let sealed = false;
  let isQuiet = false;
  const delivery = () => createReminderDelivery({
    store,
    send: async (message) => {
      sent.push(message);
      return { delivered_to: channels() };
    },
    isQuiet: () => isQuiet,
    isVaultUnlocked: () => !sealed,
    now: () => clock,
  });
  beforeEach(() => {
    sent.length = 0;
    channels = () => ['in_app'];
    sealed = false;
    isQuiet = false;
  });

  it('rings once, at its time, and the next check sends nothing', async () => {
    const { reminder } = await reminders().reminderCreate({ text: 'call the dentist', at: NOW + 30 * MINUTE });
    expect(await delivery().tick()).toMatchObject({ due: 0, delivered: 0 });
    clock = NOW + 30 * MINUTE;
    expect(await delivery().tick()).toMatchObject({ due: 1, delivered: 1 });
    expect(sent).toEqual([{ title: 'Reminder', text: 'call the dentist', ui_link_url: '#data/reminder' }]);
    expect(store.get(reminder.reminder_id)).toMatchObject({
      state: 'delivered', delivered_at: clock, delivered_to: ['in_app'], attempts: 1,
    });
    clock += MINUTE;
    expect(await delivery().tick()).toMatchObject({ due: 0, delivered: 0 });
    expect(sent).toHaveLength(1);
  });

  it('stays waiting when no channel took it, and the next minute tries again', async () => {
    const { reminder } = await reminders().reminderCreate({ text: 'call', at: NOW });
    channels = () => [];
    expect(await delivery().tick()).toMatchObject({ due: 1, delivered: 0, failed: 1 });
    expect(store.get(reminder.reminder_id)).toMatchObject({ state: 'pending', attempts: 1 });
    channels = () => ['slack'];
    clock += MINUTE;
    expect(await delivery().tick()).toMatchObject({ delivered: 1 });
    expect(store.get(reminder.reminder_id)).toMatchObject({ state: 'delivered', delivered_to: ['slack'], attempts: 2 });
  });

  it('stays waiting when the send throws', async () => {
    const throwing = createReminderDelivery({
      store, send: async () => { throw new Error('bus down'); }, isQuiet: () => false, now: () => clock,
    });
    await reminders().reminderCreate({ text: 'call', at: NOW });
    expect(await throwing.tick()).toMatchObject({ failed: 1 });
    expect(store.countPending()).toBe(1);
  });

  it('says which time it was for when it rings late: the server was off (P5)', async () => {
    await reminders().reminderCreate({ text: 'call the dentist', at: FRIDAY_3PM });
    clock = FRIDAY_3PM + 40 * MINUTE;
    await delivery().tick();
    expect(sent.map((m) => m.text)).toEqual(['For 3:00 PM: call the dentist']);
  });

  it('holds in quiet hours, and rings when the window ends (P1)', async () => {
    await reminders().reminderCreate({ text: 'bins', at: NOW });
    isQuiet = true;
    expect(await delivery().tick()).toMatchObject({ due: 1, held: 1, delivered: 0 });
    expect(sent).toHaveLength(0);
    isQuiet = false;
    clock = NOW + 9 * HOUR;
    expect(await delivery().tick()).toMatchObject({ delivered: 1 });
    expect(sent.map((m) => m.text)).toEqual(['For 10:00 AM: bins']);
  });

  it('holds while the vault is sealed', async () => {
    await reminders().reminderCreate({ text: 'bins', at: NOW });
    sealed = true;
    expect(await delivery().tick()).toMatchObject({ held: 1, delivered: 0 });
    sealed = false;
    expect(await delivery().tick()).toMatchObject({ delivered: 1 });
  });

  it('never rings one cancelled before its time, nor one cancelled while another was sending', async () => {
    const a = await reminders().reminderCreate({ text: 'a', at: NOW });
    const b = await reminders().reminderCreate({ text: 'b', at: NOW + 1 });
    const c = await reminders().reminderCreate({ text: 'c', at: NOW + 2 });
    store.cancel(c.reminder.reminder_id, NOW);
    clock = NOW + MINUTE;
    const cancelling = createReminderDelivery({
      store,
      send: async (message) => {
        sent.push(message);
        // The owner cancels b while a is going out.
        store.cancel(b.reminder.reminder_id, clock);
        return { delivered_to: ['in_app'] };
      },
      isQuiet: () => false,
      now: () => clock,
    });
    await cancelling.tick();
    expect(sent.map((m) => m.text)).toEqual(['a']);
    expect(store.get(a.reminder.reminder_id)?.state).toBe('delivered');
    expect(store.get(b.reminder.reminder_id)?.state).toBe('cancelled');
  });

  it('runs one check at a time: a check while one is sending sends nothing', async () => {
    await reminders().reminderCreate({ text: 'once', at: NOW });
    let release!: () => void;
    const slow = createReminderDelivery({
      store,
      send: async (message) => {
        sent.push(message);
        await new Promise<void>((resolve) => { release = resolve; });
        return { delivered_to: ['in_app'] };
      },
      isQuiet: () => false,
      now: () => clock,
    });
    const first = slow.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await slow.tick()).toMatchObject({ due: 0, delivered: 0 });
    release();
    expect(await first).toMatchObject({ delivered: 1 });
    expect(sent).toHaveLength(1);
  });

  it('keeps history 30 days, then drops it', async () => {
    const { reminder } = await reminders().reminderCreate({ text: 'old', at: NOW });
    await delivery().tick();
    clock = NOW + REMINDER_HISTORY_MS - MINUTE;
    expect(await delivery().tick()).toMatchObject({ pruned: 0 });
    expect(store.get(reminder.reminder_id)).not.toBeNull();
    clock = NOW + REMINDER_HISTORY_MS + MINUTE;
    expect(await delivery().tick()).toMatchObject({ pruned: 1 });
    expect(store.get(reminder.reminder_id)).toBeNull();
  });
});

describe('the Data → Reminders rpc', () => {
  const client = { instance_id: 'webclient-1', client_kind: 'webclient' } as never;
  const handlers = () => makeReminderHandlers({ dispatchers: reminders() })!.handlers;

  it('lists, moves and cancels, answering as the ops do', async () => {
    const { reminder } = await reminders().reminderCreate({ text: 'call', at: FRIDAY_3PM });
    expect(await handlers()['reminder.list']({}, client)).toMatchObject({
      count: 1, reminders: [{ reminder_id: reminder.reminder_id, when: 'Friday 16 October at 3:00 PM', time_zone: NY }],
    });
    expect(await handlers()['reminder.update']({ reminder_id: reminder.reminder_id, at: FRIDAY_3PM + HOUR }, client))
      .toMatchObject({ updated: true, message: 'Changed: Friday 16 October at 4:00 PM.' });
    expect(await handlers()['reminder.cancel']({ reminder_id: reminder.reminder_id }, client))
      .toMatchObject({ cancelled: true, message: 'Cancelled: it will not ring.' });
    expect(await handlers()['reminder.list']({ include_delivered: true }, client)).toMatchObject({
      count: 0, reminders: [], delivered: [{ reminder_id: reminder.reminder_id, state: 'cancelled' }],
    });
  });

  it('refuses a passed time as the owner’s own refusal, and a call that changes nothing', async () => {
    const { reminder } = await reminders().reminderCreate({ text: 'call', at: FRIDAY_3PM });
    await expect(handlers()['reminder.update']({ reminder_id: reminder.reminder_id, at: NOW - 5 * HOUR }, client))
      .rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('That time has passed') });
    await expect(handlers()['reminder.update']({ reminder_id: reminder.reminder_id }, client))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(handlers()['reminder.cancel']({} as never, client)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('answers the owner’s webclient only: not a Bridge, the CLI or MCP', async () => {
    for (const other of [{ instance_id: 'bridge-1', client_kind: 'bridge' }, { client_kind: 'webclient' }, {}]) {
      await expect(handlers()['reminder.list']({}, other as never)).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(handlers()['reminder.cancel']({ reminder_id: 'rem_1' }, other as never)).rejects.toMatchObject({ code: 'unauthorized' });
    }
  });

  it('is not offered when the server has no store', () => {
    expect(makeReminderHandlers(undefined)).toBeUndefined();
  });
});

