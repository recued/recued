/** A work-entity date is epoch ms — converted at the dispatcher, enforced at
 *  the store, repaired once where it was already stored as text.
 *
 *  ⛔⛔ WHY. The store took text for a commitment's `promised_for_at`, a
 *  project's `target_completion_at` and a booking's slot. Text reads as `NaN`
 *  to every sweep, so a promise dated that way never came due, never reminded
 *  and never escalated — while every list rendered it correctly, because
 *  `new Date(text)` parses. The first-run seed stored ISO strings; a federated
 *  project stored the run dialog's zone-less clock. Everything here runs
 *  against the real store in SQLite. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RECUED_BUILTIN_SOURCE_ID } from '@recued/contracts';

import { createDataRepairLedger } from '../storage/data-repair-ledger.js';
import {
  WORK_ENTITY_TEXT_DATES_REPAIR_ID,
  createWorkEntityStore,
  ensureWorkEntitySchema,
  storedTextDateMs,
  unambiguousDateMs,
  type WorkEntityStore,
  type WorkEntityTextDatesSummary,
} from '../storage/work-entity-store.js';
import {
  noticeWorkEntityTextDatesRepairAtBoot,
  workEntityTextDatesNotice,
} from '../work-entity-date-repair-notice.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const DAY = Date.UTC(2026, 9, 1); // 2026-10-01, stored as a day
const AT = Date.parse('2026-10-01T09:30:00+02:00');

let db: Database.Database;
let store: WorkEntityStore;

const open = (): void => {
  db = new Database(':memory:');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  let clock = Date.parse('2026-09-29T12:00:00.000Z');
  for (const kind of ['project', 'task', 'commitment', 'booking'] as const) {
    store.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind, source_kind: 'builtin',
      source_label: `Recued built-in (${kind})`, write_capable: true, registered_at: clock++,
    });
  }
};

afterEach(() => db.close());

describe('the dispatcher converts a date a caller sends', () => {
  let dispatchers: ReturnType<typeof createWorkEntityDispatchers>;
  beforeEach(() => {
    open();
    let clock = Date.parse('2026-09-29T12:00:00.000Z');
    dispatchers = createWorkEntityDispatchers({
      store, resolver: createWorkEntityResolver(store), now: () => clock++,
    });
  });

  const promise = (promised_for_at: unknown) => dispatchers.commitmentCreate!({
    direction: 'outbound', statement: 'Send the quote', derivation: 'user_declared',
    promised_for_at: promised_for_at as number,
  });

  it.each([
    ['epoch ms', AT, AT],
    ['epoch ms as digits', String(AT), AT],
    ['a day, as UTC midnight', '2026-10-01', DAY],
    ['a time with its offset', '2026-10-01T09:30:00+02:00', AT],
    ['a time in UTC', '2026-10-01T07:30Z', AT],
  ])('%s', async (_label, sent, stored) => {
    const { commitment } = await promise(sent);
    expect(store.readCommitment(commitment.id)?.promised_for_at).toBe(stored);
  });

  it('⛔ refuses a time with no zone rather than guessing whose clock it was', async () => {
    await expect(promise('2026-10-01T09:30')).rejects.toThrow(/has no time zone/u);
    await expect(promise('2026-10-01 09:30:00')).rejects.toThrow(/has no time zone/u);
  });

  it('refuses text that names no date — including a day that does not exist', async () => {
    await expect(promise('next friday')).rejects.toThrow(/'next friday' is not a date/u);
    // `Date.parse` would store 2 March.
    await expect(promise('2026-02-30')).rejects.toThrow(/is not a date/u);
    await expect(promise(true)).rejects.toThrow(/must be a date, got boolean/u);
    await expect(promise(Number.NaN)).rejects.toThrow(/must be a finite number/u);
  });

  it('a blank is no date at all; null clears one on an update', async () => {
    const { commitment } = await promise('  ');
    expect(store.readCommitment(commitment.id)?.promised_for_at).toBeUndefined();
    const { project } = await dispatchers.projectCreate!({ title: 'Launch', target_completion_at: '2026-10-01' as never });
    expect(store.readProject(project.id)?.target_completion_at).toBe(DAY);
    // An update that leaves it out keeps it…
    await dispatchers.projectUpdate!({ id: project.id, title: 'Launch v2', target_completion_at: '' as never });
    expect(store.readProject(project.id)?.target_completion_at).toBe(DAY);
    // …and null clears it.
    await dispatchers.projectUpdate!({ id: project.id, target_completion_at: null as never });
    expect(store.readProject(project.id)?.target_completion_at).toBeUndefined();
  });

  it('a task\'s due date is removed with `clear_due_at`; its `null` keeps the date', async () => {
    // A task's `null` means "not given": recipes surface it for an unset input,
    // and reading it as "remove" once wiped fields by accident.
    const { task } = await dispatchers.taskCreate!({ title: 'Call back', due_at: DAY });
    await dispatchers.taskUpdate!({ id: task.id, title: 'Call back soon', due_at: null as never });
    expect(store.readTask(task.id)).toMatchObject({ title: 'Call back soon', due_at: DAY });
    await expect(dispatchers.taskUpdate!({ id: task.id, due_at: AT, clear_due_at: true }))
      .rejects.toThrow(/send due_at or clear_due_at, not both/u);
    await dispatchers.taskUpdate!({ id: task.id, clear_due_at: true });
    expect(store.readTask(task.id)?.due_at).toBeUndefined();
    expect(store.readTask(task.id)?.title).toBe('Call back soon');
  });

  it('converts every date on every write that takes one', async () => {
    const { task } = await dispatchers.taskCreate!({ title: 'Call back', due_at: '2026-10-01' as never });
    expect(store.readTask(task.id)?.due_at).toBe(DAY);
    await dispatchers.taskUpdate!({ id: task.id, due_at: '2026-10-01T09:30:00+02:00' as never });
    expect(store.readTask(task.id)?.due_at).toBe(AT);
    await dispatchers.taskMarkDone!({ id: task.id, completed_at: '2026-10-01T07:30:00Z' as never });
    expect(store.readTask(task.id)?.completed_at).toBe(AT);

    const { commitment } = await dispatchers.commitmentCreate!({
      direction: 'inbound', statement: 'They send the brief', derivation: 'user_declared',
      promised_at: '2026-09-28' as never, promised_for_at: '2026-10-01' as never,
    });
    expect(store.readCommitment(commitment.id)).toMatchObject({
      promised_at: Date.UTC(2026, 8, 28), promised_for_at: DAY,
    });
    await dispatchers.commitmentUpdate!({ id: commitment.id, promised_for_at: String(AT) as never });
    expect(store.readCommitment(commitment.id)?.promised_for_at).toBe(AT);

    const { booking } = await dispatchers.bookingCreate!({
      title: 'Fitting', slot_start_at: '2026-10-01T09:30:00+02:00' as never, slot_end_at: '2026-10-01T10:30:00+02:00' as never,
    });
    expect(store.readBooking(booking.id)).toMatchObject({ slot_start_at: AT, slot_end_at: AT + 3_600_000 });
    await dispatchers.bookingUpdate!({
      id: booking.id, slot_start_at: String(AT + 60_000) as never, slot_end_at: String(AT + 3_660_000) as never,
    });
    expect(store.readBooking(booking.id)).toMatchObject({ slot_start_at: AT + 60_000, slot_end_at: AT + 3_660_000 });
  });
});

describe('the store keeps numbers only', () => {
  beforeEach(open);

  it.each([
    ['commitment promised_for_at', () => store.writeCommitment({
      direction: 'outbound', statement: 'x', derivation: 'user_declared',
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'), promised_for_at: '2026-10-01' as never,
    })],
    ['commitment promised_at', () => store.writeCommitment({
      direction: 'outbound', statement: 'x', derivation: 'user_declared',
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'), promised_at: '2026-10-01' as never,
    })],
    ['project target_completion_at', () => store.writeProject({
      title: 'x', source_id: RECUED_BUILTIN_SOURCE_ID('project'), target_completion_at: '2026-10-01T09:30' as never,
    })],
    ['booking slot', () => store.writeBooking({
      title: 'x', source_id: RECUED_BUILTIN_SOURCE_ID('booking'),
      slot_start_at: '2026-10-01T09:30:00Z' as never, slot_end_at: AT + 3_600_000,
    })],
  ])('⛔ refuses text for a %s', (_label, write) => {
    expect(write).toThrow(/must be a finite number/u);
  });

  it('takes a number, and null for no date', () => {
    const project = store.writeProject({
      title: 'x', source_id: RECUED_BUILTIN_SOURCE_ID('project'), target_completion_at: DAY,
    });
    expect(store.readProject(project.id)?.target_completion_at).toBe(DAY);
    const cleared = store.writeProject({
      id: project.id, title: 'x', source_id: RECUED_BUILTIN_SOURCE_ID('project'), target_completion_at: null as never,
    });
    expect(cleared.target_completion_at).toBeUndefined();
  });
});

describe('reading text that was already stored', () => {
  it('names exactly one instant, or none', () => {
    expect(unambiguousDateMs(String(AT))).toBe(AT);
    expect(unambiguousDateMs('2026-10-01')).toBe(DAY);
    expect(unambiguousDateMs('2026-10-01T09:30:00+0200')).toBe(AT);
    expect(unambiguousDateMs(' 2026-10-01 ')).toBe(DAY);
    expect(unambiguousDateMs('2026-10-01T09:30')).toBeNull();
    expect(unambiguousDateMs('2026-02-30')).toBeNull();
    expect(unambiguousDateMs('2026-02-30T09:30:00Z')).toBeNull();
    expect(unambiguousDateMs('1790839800')).toBeNull(); // seconds, not ms
    expect(unambiguousDateMs('Friday')).toBeNull();
  });

  it('a zone-less time on a DAY field is the day it named', () => {
    expect(storedTextDateMs('2026-10-01T23:30', true)).toBe(DAY);
    expect(storedTextDateMs('2026-02-30T09:30', true)).toBeNull();
  });

  it('a zone-less time on an INSTANT field is read in the server\'s zone, as `date_parse` read it', () => {
    expect(storedTextDateMs('2026-10-01T09:30', false)).toBe(new Date(2026, 9, 1, 9, 30).getTime());
    expect(storedTextDateMs('2026-10-01 09:30', false)).toBe(new Date(2026, 9, 1, 9, 30).getTime());
  });
});

describe('the repair, once per server', () => {
  const CREATED = Date.parse('2026-09-01T00:00:00.000Z');

  /** A server from before the rule: text in the date columns, and no ledger
   *  row — the state an upgraded server's first open finds. */
  const upgradedServer = (): void => {
    open();
    const project = store.writeProject({ title: 'Launch', source_id: RECUED_BUILTIN_SOURCE_ID('project') });
    const promiseDay = store.writeCommitment({
      direction: 'outbound', statement: 'Send the quote', derivation: 'user_declared',
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'), created_at: CREATED,
    });
    const promiseJunk = store.writeCommitment({
      direction: 'inbound', statement: 'They pay', derivation: 'user_declared',
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'), created_at: CREATED,
    });
    const booking = store.writeBooking({ title: 'Fitting', source_id: RECUED_BUILTIN_SOURCE_ID('booking') });
    // Written as SQL: the store would refuse all of these now.
    db.prepare('UPDATE data_project SET target_completion_at = ? WHERE id = ?').run('2026-10-01T09:30', project.id);
    db.prepare('UPDATE data_commitment SET promised_for_at = ?, promised_at = ? WHERE id = ?')
      .run('2026-10-01T00:00:00.000Z', '2026-09-20', promiseDay.id);
    db.prepare('UPDATE data_commitment SET promised_for_at = ?, promised_at = ? WHERE id = ?')
      .run('end of the month', 'yesterday', promiseJunk.id);
    db.prepare('UPDATE data_booking SET slot_start_at = ?, slot_end_at = ? WHERE id = ?')
      // (Digits would not do: the INTEGER column's affinity stores them as a number.)
      .run('2026-10-01T09:30:00+02:00', '2026-10-01T08:30:00Z', booking.id);
    db.prepare('DELETE FROM data_repairs WHERE repair_id = ?').run(WORK_ENTITY_TEXT_DATES_REPAIR_ID);
    ids = { project: project.id, promiseDay: promiseDay.id, promiseJunk: promiseJunk.id, booking: booking.id };
  };
  let ids: Record<'project' | 'promiseDay' | 'promiseJunk' | 'booking', string>;

  const summary = (): WorkEntityTextDatesSummary =>
    createDataRepairLedger(db).get(WORK_ENTITY_TEXT_DATES_REPAIR_ID)!.summary as WorkEntityTextDatesSummary;

  it('a new server records it with nothing to fix', () => {
    open();
    expect(summary()).toEqual({ fixed: [], cleared: [] });
  });

  it('⛔ converts each text date on the next open, so a promise can come due', () => {
    upgradedServer();
    ensureWorkEntitySchema(db);
    expect(store.readProject(ids.project)?.target_completion_at).toBe(DAY);
    expect(store.readCommitment(ids.promiseDay)).toMatchObject({
      promised_for_at: DAY, promised_at: Date.UTC(2026, 8, 20),
    });
    expect(store.readBooking(ids.booking)).toMatchObject({ slot_start_at: AT, slot_end_at: AT + 3_600_000 });
    expect(db.prepare(`SELECT count(*) AS n FROM data_commitment WHERE typeof(promised_for_at) = 'text'`).get())
      .toEqual({ n: 0 });
  });

  it('clears text that names no date — a promise keeps a `promised_at`, its creation — and keeps what it held', () => {
    upgradedServer();
    ensureWorkEntitySchema(db);
    expect(store.readCommitment(ids.promiseJunk)).toMatchObject({ promised_at: CREATED });
    expect(store.readCommitment(ids.promiseJunk)?.promised_for_at).toBeUndefined();
    expect(summary().cleared).toEqual(expect.arrayContaining([
      { kind: 'commitment', id: ids.promiseJunk, field: 'promised_for_at', was: 'end of the month', now: null },
      { kind: 'commitment', id: ids.promiseJunk, field: 'promised_at', was: 'yesterday', now: CREATED },
    ]));
    expect(summary().fixed).toHaveLength(5);
  });

  it('runs once: text written after it is left for the store to refuse, not repaired again', () => {
    upgradedServer();
    ensureWorkEntitySchema(db);
    const first = summary();
    db.prepare('UPDATE data_project SET target_completion_at = ? WHERE id = ?').run('2027-01-01', ids.project);
    ensureWorkEntitySchema(db);
    expect(summary()).toEqual(first);
    expect(db.prepare('SELECT target_completion_at AS v FROM data_project WHERE id = ?').get(ids.project))
      .toEqual({ v: '2027-01-01' });
  });

  it('a record that held text can be edited again once repaired', async () => {
    upgradedServer();
    const dispatchers = createWorkEntityDispatchers({
      store, resolver: createWorkEntityResolver(store), now: () => Date.now(),
    });
    // Before the repair, the update carries the stored text into a refused write.
    await expect(dispatchers.projectUpdate!({ id: ids.project, title: 'Renamed' }))
      .rejects.toThrow(/must be a finite number/u);
    ensureWorkEntitySchema(db);
    await dispatchers.projectUpdate!({ id: ids.project, title: 'Renamed' });
    expect(store.readProject(ids.project)).toMatchObject({ title: 'Renamed', target_completion_at: DAY });
  });
});

describe('the owner is told once, at boot', () => {
  const deps = () => {
    const logActivity = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    return {
      ledger: createDataRepairLedger(db),
      auditLog: { logActivity },
      notifier: { notify },
      now: () => 42,
      logActivity,
      notify,
    };
  };

  it('says nothing when nothing was repaired, and does not ask again', async () => {
    open();
    const d = deps();
    expect(await noticeWorkEntityTextDatesRepairAtBoot(d)).toEqual({ noticed: false, fixed: 0, cleared: 0 });
    expect(d.logActivity).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.ledger.get(WORK_ENTITY_TEXT_DATES_REPAIR_ID)?.noticed_at).toBe(42);
  });

  it('keeps a history row under a fixed id, then pushes — once', async () => {
    open();
    db.prepare('DELETE FROM data_repairs').run();
    createDataRepairLedger(db).record({
      repair_id: WORK_ENTITY_TEXT_DATES_REPAIR_ID,
      applied_at: 7,
      summary: {
        fixed: [{ kind: 'commitment', id: 'c1', field: 'promised_for_at', was: '2026-10-01', now: DAY }],
        cleared: [],
      } satisfies WorkEntityTextDatesSummary,
    });
    const d = deps();
    expect(await noticeWorkEntityTextDatesRepairAtBoot(d)).toEqual({ noticed: true, fixed: 1, cleared: 0 });
    expect(d.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      activity_id: `data-repair:${WORK_ENTITY_TEXT_DATES_REPAIR_ID}`,
      timestamp: 7,
      action: 'notification_fired',
    }));
    expect(d.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: '1 date saved as text was fixed' }),
      undefined,
      { persisted_activity_id: `data-repair:${WORK_ENTITY_TEXT_DATES_REPAIR_ID}` },
    );
    expect(await noticeWorkEntityTextDatesRepairAtBoot(deps())).toEqual({ noticed: false, fixed: 0, cleared: 0 });
  });

  it('a failed push is not a failed notice — the history row is the record', async () => {
    open();
    db.prepare('DELETE FROM data_repairs').run();
    createDataRepairLedger(db).record({
      repair_id: WORK_ENTITY_TEXT_DATES_REPAIR_ID, applied_at: 7,
      summary: { fixed: [{ kind: 'project', id: 'p1', field: 'target_completion_at', was: '2026-10-01', now: DAY }], cleared: [] },
    });
    const d = deps();
    d.notify.mockRejectedValueOnce(new Error('offline'));
    expect(await noticeWorkEntityTextDatesRepairAtBoot(d)).toMatchObject({ noticed: true });
    expect(d.ledger.get(WORK_ENTITY_TEXT_DATES_REPAIR_ID)?.noticed_at).toBe(42);
  });

  it('a boot that dies before the history row is written tells the owner at the next one', async () => {
    open();
    db.prepare('DELETE FROM data_repairs').run();
    createDataRepairLedger(db).record({
      repair_id: WORK_ENTITY_TEXT_DATES_REPAIR_ID, applied_at: 7,
      summary: { fixed: [{ kind: 'project', id: 'p1', field: 'target_completion_at', was: '2026-10-01', now: DAY }], cleared: [] },
    });
    const dying = deps();
    dying.logActivity.mockRejectedValueOnce(new Error('disk full'));
    await expect(noticeWorkEntityTextDatesRepairAtBoot(dying)).rejects.toThrow(/disk full/u);
    expect(dying.notify).not.toHaveBeenCalled();
    const next = deps();
    expect(await noticeWorkEntityTextDatesRepairAtBoot(next)).toMatchObject({ noticed: true });
    expect(next.notify).toHaveBeenCalledTimes(1);
  });

  it('names what it fixed, warns a promise may now be overdue, and lists what it removed', () => {
    const message = workEntityTextDatesNotice({
      fixed: [
        { kind: 'commitment', id: 'c1', field: 'promised_for_at', was: '2026-10-01', now: DAY },
        { kind: 'commitment', id: 'c2', field: 'promised_for_at', was: '2026-10-02', now: DAY + 86_400_000 },
        { kind: 'project', id: 'p1', field: 'target_completion_at', was: '2026-10-01T09:30', now: DAY },
      ],
      cleared: [{ kind: 'commitment', id: 'c3', field: 'promised_for_at', was: 'end of the month', now: null }],
    })!;
    expect(message.title).toBe('4 dates saved as text were repaired');
    expect(message.text).toContain('2 promise dates, 1 project target date');
    expect(message.text).toContain('never showed as due or overdue');
    expect(message.text).toContain('may now show as overdue');
    expect(message.text).toContain('• promise date on commitment c3: “end of the month”');
    expect(workEntityTextDatesNotice({ fixed: [], cleared: [] })).toBeNull();
  });

  it('lists at most 25 removed values, and counts the rest', () => {
    const cleared = Array.from({ length: 27 }, (_, i) => (
      { kind: 'project' as const, id: `p${i}`, field: 'target_completion_at', was: 'soon', now: null }
    ));
    const text = workEntityTextDatesNotice({ fixed: [], cleared })!.text;
    expect(text.match(/^• project target date/gmu)).toHaveLength(25);
    expect(text).toContain('…and 2 more');
    expect(text).not.toContain('may now show as overdue');
  });
});
