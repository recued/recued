/** D-269 follow-on — task and commitment get a reminder that REACHES SOMEBODY.
 *
 *  ⛔⛔⛔ WHAT WAS ACTUALLY WRONG: THEY HAD AN EMITTER AND NO RECEIVER. The
 *  due-status sweep called `emit()` on the warehouse bus at every due-window
 *  crossing, and a bus event becomes something a person sees only if a recipe
 *  subscribes. Measured across the corpus: `data.work.task.item.due_soon` has
 *  **ZERO subscribers in 2311 recipes** and zero in the engine — the only
 *  occurrences in the whole tree are inside a test file — and `commitment` has
 *  exactly one, inside the `daily-ops` pack, absent until an owner installed it
 *  — and retired from that pack once this landed, since the substrate now tells
 *  every owner and a pack member that also notifies says it twice (REV 13).
 *
 *  ⇒ **A task created in Recued, with a due date set in Recued, told nobody.**
 *  The per-kind policy offered `enabled: true, 1 day before` over an event with
 *  nothing on the other end: a control over silence. Every layer was green,
 *  because every layer did its job — the job just stopped one hop short of a
 *  person. ⚠ "It emits" and "you are told" are different claims and the tests
 *  below assert the second one.
 *
 *  🔑 A GREEN SUITE COULD NOT HAVE CAUGHT IT. Nothing was broken; something was
 *  ABSENT, and absence has no failing assertion unless you go looking for the
 *  receiver. The test that would have caught it is the first one here — drive
 *  the sweep, assert a NOTIFICATION, not an event. */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RECUED_BUILTIN_SOURCE_ID, type QuietHoursDigest } from '@recued/contracts';
import {
  runReminderSweep,
  type ReminderKind,
  type ReminderSweepDeps,
} from '../work-entity-reminder-sweep.js';
import { createReminderLedgerStore } from '../storage/reminder-ledger-store.js';
import { createQuietHoursStore } from '../storage/quiet-hours-store.js';
import { createTaskEmissionLedger, runDueStatusSweep } from '../work-entity-due-status-sweep.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const task = (over: Record<string, unknown> = {}) => ({
  id: 't-1', title: 'File the return', done: false, due_at: NOW + 6 * HOUR, ...over,
} as never);
const commitment = (over: Record<string, unknown> = {}) => ({
  id: 'c-1', statement: 'send the deck', lifecycle_state: 'pending',
  promised_for_at: NOW + 6 * HOUR, ...over,
} as never);

const deps = (over: Partial<ReminderSweepDeps> = {}): ReminderSweepDeps => ({
  policy: () => ({ enabled: true, offset_ms: DAY, respects_quiet_hours: true }),
  ledger: createReminderLedgerStore(new Database(':memory:')),
  notify: () => {},
  now: () => NOW,
  ...over,
});

/** Collects what the owner would actually receive. */
const sink = (): { sent: Array<{ title: string; text: string }>; notify: (m: { title: string; text: string }) => void } => {
  const sent: Array<{ title: string; text: string }> = [];
  return { sent, notify: (m) => { sent.push(m); } };
};

describe('D-269 — the no-op is closed: a Recued-native deadline reaches the owner', () => {
  it('⛔⛔ a TASK due inside the horizon produces a NOTIFICATION', () => {
    // THE regression test for the whole finding. Before this, the same fixture
    // produced a bus event and silence.
    const s = sink();
    const r = runReminderSweep(deps({ listTasks: () => [task()], notify: s.notify }));
    expect(r.tasks_visited).toBe(1);
    expect(r.reminded).toBe(1);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.title).toBe('Task due soon');
    expect(s.sent[0]!.text).toContain('File the return');
  });

  it('⛔ a COMMITMENT likewise, and only while it is PENDING', () => {
    const s = sink();
    expect(runReminderSweep(deps({
      listCommitments: () => [commitment()], notify: s.notify,
    })).reminded).toBe(1);
    expect(s.sent[0]!.title).toBe('Promise coming due');

    // A kept promise with a past date is history, not a deadline.
    const s2 = sink();
    expect(runReminderSweep(deps({
      listCommitments: () => [commitment({ lifecycle_state: 'kept' })], notify: s2.notify,
    })).reminded).toBe(0);
  });

  it('⚠ a DONE task is not a deadline', () => {
    const s = sink();
    const r = runReminderSweep(deps({
      listTasks: () => [task({ done: true })], notify: s.notify,
    }));
    expect(r.tasks_visited).toBe(0);
    expect(s.sent).toEqual([]);
  });

  it('⛔ the per-kind switch is honoured — off means the list is never even read', () => {
    let read = 0;
    const s = sink();
    runReminderSweep(deps({
      listTasks: () => { read += 1; return [task()]; },
      policy: (k: ReminderKind) => ({
        enabled: k !== 'task', offset_ms: DAY, respects_quiet_hours: true,
      }),
      notify: s.notify,
    }));
    expect(read).toBe(0);
    expect(s.sent).toEqual([]);
  });
});

describe('D-269 — two tellings, because approaching and expired are different news', () => {
  it('⛔⛔ told once approaching and ONCE MORE when it expires', () => {
    // The owner named expiry specifically ("task expires"). Keyed on the anchor
    // alone the second telling is swallowed by the first, and the moment they
    // actually asked about is the one thing never said.
    const ledger = createReminderLedgerStore(new Database(':memory:'));
    const s = sink();
    const at = (t: number) => runReminderSweep(deps({
      listTasks: () => [task()], ledger, notify: s.notify, now: () => t,
    }));
    at(NOW);                    // due_soon  (anchor is NOW + 6h)
    at(NOW + 3 * HOUR);         // still due_soon — already told
    at(NOW + 7 * HOUR);         // past the anchor ⇒ overdue
    expect(s.sent.map((m) => m.title)).toEqual(['Task due soon', 'Task overdue']);
  });

  it('⛔ NOT eternal — an overdue row stops being owed after one offset', () => {
    // Without the bound a task overdue since last year stays owed forever, and
    // the only thing between the owner and a reminder about it is a ledger row
    // that `prune` deletes by anchor. Bounded, "not owed" and "already told"
    // agree and the ledger is a convenience rather than the sole defence.
    const s = sink();
    const r = runReminderSweep(deps({
      listTasks: () => [task({ due_at: NOW - DAY - HOUR })], notify: s.notify,
    }));
    expect(r.tasks_visited).toBe(1);
    expect(s.sent).toEqual([]);
  });
});

describe('D-269 — the ledger is persisted, and that is a different claim', () => {
  it('⛔⛔ a RESTART does not re-tell', () => {
    // The bus dedup absorbs a repeated event; a person has no such absorber, and
    // a reminder that repeats itself is the one people switch off. Same db,
    // fresh store object — which is what a restart looks like from here.
    const db = new Database(':memory:');
    const s = sink();
    const run = () => runReminderSweep(deps({
      listTasks: () => [task()], ledger: createReminderLedgerStore(db), notify: s.notify,
    }));
    run();
    run();
    expect(s.sent).toHaveLength(1);
  });

  it('⛔ moving the deadline RE-ARMS, because the key carries the anchor', () => {
    const db = new Database(':memory:');
    const s = sink();
    const run = (due: number) => runReminderSweep(deps({
      listTasks: () => [task({ due_at: due })],
      ledger: createReminderLedgerStore(db), notify: s.notify,
    }));
    run(NOW + 6 * HOUR);
    run(NOW + 6 * HOUR);            // unchanged ⇒ silent
    run(NOW + 9 * HOUR);            // rescheduled ⇒ news again
    expect(s.sent).toHaveLength(2);
  });
});

describe('D-269 — quiet hours DEFERS a work reminder rather than dropping it', () => {
  it('⛔ held leaves NO mark, so the next sweep after the window delivers', () => {
    const ledger = createReminderLedgerStore(new Database(':memory:'));
    const s = sink();
    const run = (quiet: boolean) => runReminderSweep(deps({
      listTasks: () => [task()], ledger, notify: s.notify,
      isQuiet: () => quiet,
    }));
    expect(run(true).held).toBe(1);
    expect(s.sent).toEqual([]);
    expect(run(false).reminded).toBe(1);
    expect(s.sent).toHaveLength(1);
  });

  it('⛔⛔ REV 15 — no kind can opt out; the signature no longer takes one', () => {
    // `isQuiet` lost its `kind` parameter, so there is no longer a code path that
    // could reintroduce a per-kind exemption — a compile error, not a runtime
    // one, which is the strongest form this can take. Behaviourally: the same
    // window that holds a task holds a booking.
    const s2 = sink();
    const r = runReminderSweep(deps({
      listTasks: () => [task()], notify: s2.notify, isQuiet: () => true,
      policy: () => ({ enabled: true, offset_ms: DAY }),
    }));
    expect(r.held).toBe(1);
    expect(s2.sent).toEqual([]);
  });
});

describe('D-269 — the release card and the per-item reminders are EXCLUSIVE', () => {
  /** ⛔⛔ DRIVEN THROUGH THE SHARED LEDGER, NOT BY COMPARING TWO KEY STRINGS.
   *  Two independently-written key builders that "obviously" agree is exactly
   *  how a dedup silently stops deduping: each half reads as correct and only
   *  the PAIR is wrong. So these run the REAL sweeps against one ledger and
   *  assert the owner is told once — which is false the moment the keys drift. */
  const NIGHT = Date.parse('2026-06-15T18:00:00Z');
  const MORNING = Date.parse('2026-06-16T02:00:00Z');

  const build = () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureWorkEntitySchema(db);
    const store = createWorkEntityStore(db);
    for (const kind of ['task', 'commitment'] as const) {
      store.registerSource({
        id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind, source_kind: 'builtin',
        source_label: `Recued ${kind}`, write_capable: true, registered_at: NIGHT,
      });
    }
    store.writeTask({
      id: 't-9', source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'ship it', done: false, due_at: MORNING + HOUR,
    }, NIGHT - 1000);
    return {
      store,
      quiet: createQuietHoursStore(new Database(':memory:')),
      ledger: createReminderLedgerStore(new Database(':memory:')),
    };
  };

  const card = (ctx: ReturnType<typeof build>, at: number, quiet: boolean, out: QuietHoursDigest[]) =>
    runDueStatusSweep({
      store: ctx.store,
      taskEmissionLedger: createTaskEmissionLedger(),
      policy: () => ({ enabled: true, offset_ms: DAY, respects_quiet_hours: true }),
      isQuiet: () => quiet,
      wasQuiet: () => ctx.quiet.readLastActiveAt(),
      markQuiet: (v) => ctx.quiet.writeLastActiveAt(v),
      onReleased: (d) => { out.push(d); },
      reminderLedger: ctx.ledger,
      now: () => at,
    });

  const items = (ctx: ReturnType<typeof build>, at: number, s: ReturnType<typeof sink>) =>
    runReminderSweep(deps({
      listTasks: () => ctx.store.listTasks({ sync_states: ['live'] }),
      ledger: ctx.ledger, notify: s.notify, now: () => at,
    }));

  it('⛔⛔ card FIRST ⇒ the per-item reminder stays quiet', () => {
    const ctx = build();
    const out: QuietHoursDigest[] = [];
    card(ctx, NIGHT, true, out);
    card(ctx, MORNING, false, out);              // release edge → the card
    expect(out).toHaveLength(1);
    expect(out[0]!.still_ahead.map((i) => i.id)).toEqual(['t-9']);

    const s = sink();
    expect(items(ctx, MORNING, s).reminded).toBe(0);
    expect(s.sent).toEqual([]);
  });

  it('⛔⛔ reminders FIRST ⇒ the card comes out empty and is not sent', () => {
    // Order-independent on purpose: housekeeping promises no order between two
    // tasks, and a correctness argument resting on one has a scheduling change
    // underneath it.
    const ctx = build();
    const out: QuietHoursDigest[] = [];
    card(ctx, NIGHT, true, out);

    const s = sink();
    expect(items(ctx, MORNING, s).reminded).toBe(1);

    card(ctx, MORNING, false, out);
    expect(out).toHaveLength(0);                 // nothing left to say
  });
});

describe('a deadline stored at UTC midnight is a DAY — judged in the owner\'s zone', () => {
  // Found live: "due Monday" (Monday's UTC midnight) read overdue on Sunday
  // evening in Pacific time — to the sweep, the reminders and the digest alike.
  const MONDAY = Date.UTC(2026, 8, 28);
  const SUNDAY_EVENING = Date.parse('2026-09-27T20:00:00-07:00');
  const TUESDAY_JUST_AFTER = Date.parse('2026-09-29T00:05:00-07:00');
  const pacific = { timeZone: () => 'America/Los_Angeles' };

  it('⛔ is due soon on the evening before, not overdue — and overdue once Monday is over there', () => {
    const early = sink();
    runReminderSweep(deps({
      ...pacific, now: () => SUNDAY_EVENING, notify: early.notify,
      listTasks: () => [task({ due_at: MONDAY })],
    }));
    expect(early.sent.map((m) => m.title)).toEqual(['Task due soon']);
    // The day is named — not its UTC-midnight instant read as a time.
    expect(early.sent[0]!.text).toBe('File the return — 2026-09-28');

    const late = sink();
    runReminderSweep(deps({
      ...pacific, now: () => TUESDAY_JUST_AFTER, notify: late.notify,
      listCommitments: () => [commitment({ promised_for_at: MONDAY })],
    }));
    expect(late.sent.map((m) => m.title)).toEqual(['Promise overdue']);
  });

  it('the due-status sweep keeps a Monday promise `due_soon` all through Monday in the owner\'s zone', () => {
    const db = new Database(':memory:');
    ensureWorkEntitySchema(db);
    const store = createWorkEntityStore(db);
    store.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID('commitment'), top_tier_kind: 'commitment', source_kind: 'builtin',
      source_label: 'Recued', write_capable: true,
    });
    store.writeCommitment({
      id: 'c-monday', direction: 'outbound', statement: 'send the deck', derivation: 'user_declared',
      source_id: RECUED_BUILTIN_SOURCE_ID('commitment'), created_at: 1, promised_at: 1,
      lifecycle_state: 'pending', due_status: 'not_due', expiry_policy: 'escalate_overdue',
      state_changed_at: 1, promised_for_at: MONDAY,
    } as never, 1);
    const status = () => store.readCommitment('c-monday')?.due_status;
    const sweepAt = (now: number) => runDueStatusSweep({
      store, now: () => now, taskEmissionLedger: createTaskEmissionLedger(), ...pacific,
    });

    sweepAt(SUNDAY_EVENING);
    expect(status()).toBe('due_soon');
    sweepAt(Date.parse('2026-09-28T23:30:00-07:00'));
    expect(status()).toBe('due_soon');
    sweepAt(TUESDAY_JUST_AFTER);
    expect(status()).toBe('overdue');
  });
});
