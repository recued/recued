/** D-269 — the booking / calendar reminder emitters, and the delivery path that
 *  resolves the tension step 4 recorded.
 *
 *  ⛔⛔ WHY THESE TWO DELIVER DIFFERENTLY FROM TASK/COMMITMENT. The due-status
 *  sweep gates a WAREHOUSE EVENT, and a warehouse event drives RECIPES — so in
 *  principle quiet hours there can delay WORK, which the design says it must
 *  never do. This sweep calls `notify` directly, so the policy gates a
 *  DELIVERY: the thing quiet hours is actually defined to suppress. ⇒ **These
 *  two are the shape the other two should migrate to, not the exception.**
 *
 *  🏁 AND THEY DID — see `d-269-work-kind-reminders.test.ts`. The prediction was
 *  right for a reason worse than style: task and commitment were not merely a
 *  different shape, they were a NO-OP. Their bus events had zero subscribers in
 *  the corpus, so the owner was told nothing at all. ⚠ This file still covers
 *  booking/calendar specifically; the four-kind behaviour is next door.
 *
 *  🔑 AND THE DEDUP KEY CARRIES THE ANCHOR, which is the whole correctness of
 *  the thing: a booking moved from 14:00 to 17:00 is a NEW reminder, and a mark
 *  keyed on the id alone would swallow it. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  reminderMarkKey,
  runReminderSweep,
  type ReminderSweepDeps,
} from '../work-entity-reminder-sweep.js';
import { createReminderLedgerStore } from '../storage/reminder-ledger-store.js';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const booking = (over: Record<string, unknown> = {}) => ({
  id: 'b-1', title: 'Dentist', lifecycle_state: 'confirmed',
  slot_start_at: NOW + HOUR, ...over,
} as never);

const deps = (over: Partial<ReminderSweepDeps> = {}): ReminderSweepDeps => ({
  listBookings: () => [booking()],
  policy: () => ({ enabled: true, offset_ms: 2 * HOUR, respects_quiet_hours: false }),
  ledger: createReminderLedgerStore(new Database(':memory:')),
  notify: () => {},
  now: () => NOW,
  ...over,
});

describe('D-269 — a reminder is OWED inside [now, now + offset]', () => {
  it('⛔ the LOWER bound is now, so a past slot never qualifies', () => {
    // Not simply `anchor - offset <= now`: that is true forever after the
    // boundary, so last year's dentist would qualify eternally and the ledger
    // would be the only thing standing between the owner and a reminder for it.
    const sent: string[] = [];
    runReminderSweep(deps({
      listBookings: () => [booking({ slot_start_at: NOW - HOUR })],
      notify: (m) => { sent.push(m.text); },
    }));
    expect(sent).toEqual([]);
  });

  it('the upper bound is the horizon', () => {
    const sent: string[] = [];
    const run = (slot: number, offset: number): void => {
      runReminderSweep(deps({
        listBookings: () => [booking({ slot_start_at: slot })],
        policy: () => ({ enabled: true, offset_ms: offset, respects_quiet_hours: false }),
        notify: (m) => { sent.push(m.text); },
      }));
    };
    run(NOW + 5 * HOUR, 2 * HOUR);   // beyond the horizon
    expect(sent).toEqual([]);
    run(NOW + HOUR, 2 * HOUR);       // inside it
    expect(sent).toHaveLength(1);
  });

  it('⛔ a CANCELLED booking is never reminded about', () => {
    // The case a replayed queue gets wrong and a recomputing sweep gets right
    // for free — the same property step 4 relies on.
    const sent: string[] = [];
    for (const state of ['cancelled', 'completed', 'no_show']) {
      runReminderSweep(deps({
        listBookings: () => [booking({ lifecycle_state: state })],
        notify: (m) => { sent.push(m.text); },
      }));
    }
    expect(sent).toEqual([]);
  });

  it('⚠ a kind with no policy row is OFF, not defaulted on', () => {
    // These two had no emitter before D-269, so "absent" must mean the
    // pre-D-269 behaviour: silence. Defaulting them on would ship a feature
    // nobody asked for to every upgrading server.
    const sent: string[] = [];
    runReminderSweep(deps({
      policy: () => ({ enabled: false, offset_ms: 0, respects_quiet_hours: false }),
      notify: (m) => { sent.push(m.text); },
    }));
    expect(sent).toEqual([]);
  });
});

describe('an ALL-DAY event is not "starting soon" (2026-10-07)', () => {
  it('reminds of a timed calendar event, and never of an all-day one', () => {
    // An all-day event is stored at the UTC midnight of its day
    // (`calendar-days.ts`): inside the window, it was "starting soon" at 4 pm
    // the day before in Los Angeles, naming "…T00:00:00.000Z".
    const sent: string[] = [];
    const day = Date.parse('2026-06-16T00:00:00Z'); // 12 hours ahead of NOW
    const result = runReminderSweep(deps({
      listBookings: () => [],
      policy: () => ({ enabled: true, offset_ms: 13 * HOUR, respects_quiet_hours: false }),
      listCalendar: () => [
        { record_id: 'holiday', summary: 'Holiday', start_at: day, is_all_day: true },
        { record_id: 'call', summary: 'Call', start_at: NOW + HOUR, is_all_day: false },
      ],
      notify: (m) => { sent.push(`${m.title}: ${m.text}`); },
    }));
    expect(sent).toEqual([expect.stringMatching(/^Starting soon: Call — /)]);
    expect(result.calendar_visited).toBe(1);
  });
});

describe('D-269 — ⛔⛔ the dedup key carries the ANCHOR', () => {
  it('reminds once, not every cycle', () => {
    const sent: string[] = [];
    const d = deps({ notify: (m) => { sent.push(m.text); } });
    runReminderSweep(d);
    runReminderSweep(d);
    runReminderSweep(d);
    expect(sent).toHaveLength(1);
  });

  it('🔑 but a RESCHEDULED booking re-arms — the mark was for the old slot', () => {
    // Keyed on the id alone, moving a meeting would silently cost its reminder.
    // This is the D-120 reactive-cursor lesson: one mark per item, keyed so a
    // change cannot be mistaken for a repeat.
    const sent: string[] = [];
    const ledger = createReminderLedgerStore(new Database(':memory:'));
    let slot = NOW + HOUR;
    const d = deps({
      ledger,
      listBookings: () => [booking({ slot_start_at: slot })],
      notify: (m) => { sent.push(m.text); },
    });
    runReminderSweep(d);
    expect(sent).toHaveLength(1);

    slot = NOW + 90 * 60 * 1000;   // moved
    runReminderSweep(d);
    expect(sent).toHaveLength(2);

    expect(reminderMarkKey({ kind: 'booking', id: 'b-1', anchor_at: 1 }))
      .not.toBe(reminderMarkKey({ kind: 'booking', id: 'b-1', anchor_at: 2 }));
  });

  it('⛔ the ledger is PERSISTED — a notification has no bus dedup to absorb a repeat', () => {
    // The due-status sweep can afford an in-process Map: a re-emit after a
    // restart is absorbed by the warehouse bus's 60s window and recipe-side
    // dedup. A notification has no such absorber, so a restart would simply ping
    // the owner twice.
    const db = new Database(':memory:');
    const sent: string[] = [];
    runReminderSweep(deps({
      ledger: createReminderLedgerStore(db), notify: (m) => { sent.push(m.text); },
    }));
    // A fresh store over the SAME db is the restart.
    runReminderSweep(deps({
      ledger: createReminderLedgerStore(db), notify: (m) => { sent.push(m.text); },
    }));
    expect(sent).toHaveLength(1);
  });

  it('⚠ pruning is by ANCHOR, so a mark outlives its own reminder window', () => {
    // Pruning on send-age would drop the mark for an event still to come and
    // remind about it twice.
    const db = new Database(':memory:');
    const ledger = createReminderLedgerStore(db);
    ledger.set(reminderMarkKey({ kind: 'booking', id: 'old', anchor_at: NOW - 10 * HOUR }), NOW - 10 * HOUR);
    ledger.set(reminderMarkKey({ kind: 'booking', id: 'soon', anchor_at: NOW + HOUR }), NOW + HOUR);
    ledger.prune(NOW - 2 * HOUR);
    expect(ledger.has(reminderMarkKey({ kind: 'booking', id: 'old', anchor_at: NOW - 10 * HOUR }))).toBe(false);
    expect(ledger.has(reminderMarkKey({ kind: 'booking', id: 'soon', anchor_at: NOW + HOUR }))).toBe(true);
  });
});

describe('D-269 — quiet hours gates a DELIVERY here, and defers rather than drops', () => {
  it('⛔ a kind that RESPECTS the window is held, and the mark is NOT set', () => {
    // Setting the mark would turn a hold into a loss — the same distinction the
    // task ledger draws in the due-status sweep.
    const sent: string[] = [];
    const ledger = createReminderLedgerStore(new Database(':memory:'));
    const base = deps({
      ledger,
      policy: () => ({ enabled: true, offset_ms: 2 * HOUR, respects_quiet_hours: true }),
      notify: (m) => { sent.push(m.text); },
    });
    const held = runReminderSweep({ ...base, isQuiet: () => true });
    expect(held.held).toBe(1);
    expect(sent).toEqual([]);

    // After the window: the same row is still owed, and arrives.
    runReminderSweep({ ...base, isQuiet: () => false });
    expect(sent).toHaveLength(1);
  });

  it('⛔⛔ REV 15 — the window holds a BOOKING too, and that cost is real', () => {
    // This replaces a test asserting the opposite. Booking and calendar defaulted
    // to `respects_quiet_hours: false` on the argument that a slot starting inside
    // the window is gone by morning. The argument is true; it is just not about
    // quiet hours. "Do I want to be told about upcoming bookings, and how early"
    // is NOTIFICATION POLICY. "When may I be disturbed" is this window, once, for
    // everything — a master silencer that exempts a row is not one.
    //
    // ⚠ SO THE LOSS IS NAMED RATHER THAN DESIGNED AROUND: a 07:00 slot whose
    // 2-hour reminder lands at 05:00 inside a 22:00–08:00 window is not delivered
    // before it. The owner sets the window; this is what setting it means.
    const sent: string[] = [];
    const r = runReminderSweep(deps({
      listBookings: () => [booking()],
      isQuiet: () => true,
      notify: (m) => { sent.push(m.text); },
    }));
    expect(r.held).toBe(1);
    expect(sent).toEqual([]);
  });
});

describe('D-269 — the sweep is wired to a NOTIFY, not an event', () => {
  it('⛔ the registration requires a notify sink — the FORWARD, not the wiring', () => {
    // ⚠ What survives here is only the forward through `start-post-listener-
    // runtime.ts`, which a text grep genuinely catches (a deleted forward reds
    // it) and nothing else covers — the composition drive starts BELOW that
    // layer. The wiring itself — that `notifyReminder` reaches the sweep and a
    // real row reaches the sink — is driven in
    // `d-269-reminder-composition-drive.test.ts`, where rewiring `listTasks` to
    // an empty list reds. That mutation left THIS test green.
    const top = readFileSync(
      join(process.cwd(), 'backend/server/src/serve/start-post-listener-runtime.ts'),
      'utf8',
    );
    expect(top).toContain('notifyReminder');
  });
});
