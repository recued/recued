/** D-269 — the reminders themselves, for all four anchored kinds.
 *
 *  ⛔⛔⛔ TASK AND COMMITMENT JOINED THIS SWEEP BECAUSE THEY WERE A NO-OP. They
 *  had an emitter — `emit()` in the due-status sweep — but an emitter onto the
 *  WAREHOUSE BUS, and a bus event only becomes something a person sees if a
 *  recipe subscribes. Measured across the whole corpus: **`data.work.task.item.
 *  due_soon` has ZERO subscribers in 2311 recipes and zero in the engine** (the
 *  only occurrences in the tree are in a test file), and `commitment` has
 *  exactly one — `commitment-deadline-radar`, which shipped inside the
 *  `daily-ops` pack and was therefore absent until an owner installed it.
 *  ⛔ RETIRED from that pack once this sweep landed (REV 13): a member that also
 *  notifies means anyone with Daily Ops is told twice about the same promise.
 *  The recipe still exists and is individually installable — turn `commitment`
 *  off in Settings → Reminders if you prefer its richer card.
 *
 *  ⇒ **A task you created in Recued, with a due date you set, told you nothing.**
 *  The per-kind policy could be set to `enabled: true, 1 day before` and it
 *  governed an event with nobody on the other end — a control over silence. The
 *  two kinds Recued ITSELF creates were the two with no way to reach you, which
 *  is the exact inversion of the point: a reminder for an entity that only
 *  exists here cannot be somebody else's job.
 *
 *  🔑 THE BUS EMISSION IS UNTOUCHED. It is not the delivery and never was — it
 *  says *"this row changed state"*, for automation. This sweep says *"you should
 *  know"*, for a person. A recipe that turns the first into the second is doing
 *  the substrate's work with its own parallel copy of the policy vocabulary;
 *  `commitment-deadline-radar` carries four mute knobs of its own for exactly
 *  the axes D-269 now owns.
 *
 *  Originally built for the two kinds that had no emitter at all: bookings
 *  and calendar events.
 *
 *  ⛔⛔ AND THIS IS WHERE THE TENSION D-269 RECORDED RESOLVES. The due-status
 *  sweep gates a WAREHOUSE EVENT, and a warehouse event is what drives RECIPES —
 *  so in principle quiet hours there can delay WORK, which the design says it
 *  must never do. (Measured: the only corpus recipe on `due_soon`/`overdue` just
 *  notifies, so today it does not. But "today" is a corpus fact, not a
 *  guarantee.)
 *
 *  🔑 THIS SWEEP CALLS `notify` DIRECTLY, so the policy gates a **DELIVERY** —
 *  the thing quiet hours is defined to suppress — rather than a trigger that
 *  might do anything. ⇒ **Booking and calendar are the shape the other two
 *  should migrate to**, not the exception to them. Written here because the next
 *  person will otherwise read the asymmetry as an oversight and "fix" it by
 *  making these emit events too.
 *
 *  ⚠ QUIET HOURS HOLDS EVERY KIND (REV 15). The per-kind `respects_quiet_hours`
 *  stance is retired: it made one window mean four things and mixed "what am I
 *  told about" into "when may I be disturbed". The cost is real and named at the
 *  hold site — a slot starting inside the window loses its reminder — and it is
 *  the honest meaning of a Do Not Disturb the owner sets themselves.
 *
 *  Spec: internal design notes D-269 REV 2 Q2/Q4 + step 4's recorded tension. */

import type { Booking, Commitment, Task } from '@recued/contracts';
import {
  classifyCommitmentDueStatus,
  classifyTaskDueWindow,
} from './work-entity-due-status-sweep.js';

/** Which kinds this sweep delivers for. ⚠ The two WORK kinds are told twice
 *  over a row's life — once approaching, once past — because "due tomorrow" and
 *  "now overdue" are different facts about the same anchor. The two CALENDAR
 *  kinds are told once: a slot that has started is not news. */
export type ReminderKind = 'booking' | 'calendar' | 'task' | 'commitment';

/** The second telling, for work kinds only. `undefined` ⇒ the kind has one. */
export type ReminderState = 'due_soon' | 'overdue';

/** One anchored row this sweep can remind about. */
interface Candidate {
  kind: ReminderKind;
  id: string;
  title: string;
  anchor_at: number;
  state?: ReminderState;
}

/** ⛔⛔ THE MARK IS KEYED ON THE ANCHOR, NOT JUST THE ID, AND THAT IS THE WHOLE
 *  CORRECTNESS OF THE DEDUP. A booking moved from 14:00 to 17:00 is a NEW
 *  reminder the owner needs; keyed on the id alone the reschedule would be
 *  silently swallowed by the mark from the original slot. Keying on the anchor
 *  means a change re-arms by construction — the same rule the D-120 reactive
 *  cursors had to learn: one mark per item, keyed so a change cannot be
 *  mistaken for a repeat.
 *
 *  ⚠ AND THE STATE, WHERE THERE IS ONE. A task told "due tomorrow" must still be
 *  able to say "overdue" the next day — keyed on the anchor alone the second
 *  telling would be swallowed by the first, and the expiry, which is the moment
 *  the owner actually named, would be the one thing never said. Absent for
 *  booking / calendar so their keys are byte-identical to before. */
export const reminderMarkKey = (
  c: Pick<Candidate, 'kind' | 'id' | 'anchor_at' | 'state'>,
): string =>
  c.state === undefined
    ? `${c.kind}:${c.id}:${c.anchor_at}`
    : `${c.kind}:${c.id}:${c.anchor_at}:${c.state}`;

export interface ReminderLedger {
  has(key: string): boolean;
  set(key: string, anchor_at: number): void;
  /** Drop marks whose anchor is far enough past that no reminder can be owed. */
  prune(before: number): void;
}

export interface ReminderSweepDeps {
  /** Bookings with a slot. */
  listBookings?: () => Booking[];
  /** Calendar events starting inside a window. ⚠ The sweep asks for a BOUNDED
   *  range rather than everything: an unbounded read over a synced calendar is
   *  the kind of query that is fine on a test fixture and ruinous on a real
   *  account. */
  listCalendar?: (from: number, to: number) => Array<{
    record_id: string; summary: string; start_at: number; status?: string;
  }>;
  /** Tasks with a due date. ⚠ Same bounded-read posture as the calendar: the
   *  caller pages, this sweep does not ask for everything. */
  listTasks?: () => Task[];
  /** Commitments with a promised-for instant. */
  listCommitments?: () => Commitment[];
  policy: (kind: ReminderKind) => {
    enabled: boolean;
    offset_ms: number;
  };
  /** D-269 — is the owner's window active right now?
   *
   *  ⛔ TAKES NO KIND. Quiet hours is a MASTER SILENCER: one fact about the
   *  person, not a per-row stance. It took a kind until REV 15, which let each
   *  row mean something different by the same window and put a
   *  notification-policy question ("do I want this at all, and how early?")
   *  inside the quiet-hours concern. What you are told about lives in the kind
   *  policy; WHEN you may be disturbed lives here, once, for everything. */
  isQuiet?: (at: number) => boolean;
  ledger: ReminderLedger;
  /** The delivery. ⛔ A NOTIFICATION, not an event — see the header. */
  notify: (message: { title: string; text: string }) => void;
  now?: () => number;
}

export interface ReminderSweepResult {
  bookings_visited: number;
  calendar_visited: number;
  tasks_visited: number;
  commitments_visited: number;
  reminded: number;
  /** Held by quiet hours this cycle (only possible for a kind the owner set to
   *  respect it — both default to exempt). */
  held: number;
}

/** ⚠ A reminder is owed when the anchor is inside `[now, now + offset]`. NOT
 *  simply "anchor - offset <= now": that is true forever after the boundary, so
 *  a past event would qualify eternally and the ledger would be the only thing
 *  standing between the owner and a reminder for last year's dentist. The upper
 *  bound is the horizon; the LOWER bound is now, and it is what makes a missed
 *  window stay missed instead of arriving late. */
const isOwed = (anchor_at: number, now: number, offset_ms: number): boolean =>
  anchor_at >= now && anchor_at <= now + offset_ms;

/** ⛔⛔ THE WORK KINDS NEED A DIFFERENT PREDICATE, AND THE DIFFERENCE IS THE
 *  WHOLE REASON THEY GET TWO TELLINGS. `isOwed` above refuses a past anchor,
 *  which is right for a slot you travel to and WRONG for a deadline: "overdue"
 *  is the moment the owner named when they said *task expires*.
 *
 *  ⚠ SO THE PAST SIDE IS BOUNDED BY THE SAME OFFSET. Without the bound a task
 *  overdue since last year stays owed forever, and the only thing standing
 *  between the owner and a reminder about it is a ledger row — which `prune`
 *  deletes by anchor, so the mark would expire and the reminder would return.
 *  Bounded, "not owed" and "already told" agree, and the ledger is a
 *  convenience rather than the sole defence.
 *
 *  🔑 The forward half DEFERS to the shared classifier rather than restating
 *  `anchor - offset <= now`: the due-status sweep decides what "due soon" means
 *  and two copies of that arithmetic is one copy too many. */
const workOwedState = (
  classified: 'no_deadline' | 'not_due' | 'due_soon' | 'overdue',
  anchor_at: number,
  now: number,
  offset_ms: number,
): ReminderState | null => {
  if (classified === 'due_soon') return 'due_soon';
  if (classified === 'overdue' && now - anchor_at <= offset_ms) return 'overdue';
  return null;
};

/** ⚠ The title carries the STANCE — approaching or past — because the body is
 *  the row's own text and an owner scanning a lock screen reads the first line.
 *  "Task overdue" and "Task due soon" are the same row and opposite news. */
const reminderTitle = (c: Candidate): string => {
  switch (c.kind) {
    case 'booking': return 'Booking coming up';
    case 'calendar': return 'Starting soon';
    case 'task': return c.state === 'overdue' ? 'Task overdue' : 'Task due soon';
    case 'commitment':
      return c.state === 'overdue' ? 'Promise overdue' : 'Promise coming due';
  }
};

export const runReminderSweep = (deps: ReminderSweepDeps): ReminderSweepResult => {
  const now = deps.now?.() ?? Date.now();
  const result: ReminderSweepResult = {
    bookings_visited: 0, calendar_visited: 0,
    tasks_visited: 0, commitments_visited: 0,
    reminded: 0, held: 0,
  };

  const candidates: Candidate[] = [];

  const bookingPolicy = deps.policy('booking');
  if (deps.listBookings && bookingPolicy.enabled) {
    for (const b of deps.listBookings()) {
      // ⛔ A cancelled or finished booking is not a reminder. `no_show` and
      // `completed` are past by definition; `cancelled` is the case a replayed
      // queue would have got wrong and a recomputing sweep gets right for free.
      if (b.lifecycle_state === 'cancelled'
        || b.lifecycle_state === 'completed'
        || b.lifecycle_state === 'no_show') continue;
      if (b.slot_start_at === undefined) continue;
      result.bookings_visited += 1;
      if (!isOwed(b.slot_start_at, now, bookingPolicy.offset_ms)) continue;
      candidates.push({
        kind: 'booking', id: b.id, title: b.title, anchor_at: b.slot_start_at,
      });
    }
  }

  const calendarPolicy = deps.policy('calendar');
  if (deps.listCalendar && calendarPolicy.enabled) {
    for (const e of deps.listCalendar(now, now + calendarPolicy.offset_ms)) {
      // ⚠ A cancelled event still sits in the local mirror until the next sync
      // prunes it; reminding about one is the same defect as reminding about a
      // cancelled booking.
      if (e.status === 'cancelled') continue;
      result.calendar_visited += 1;
      if (!isOwed(e.start_at, now, calendarPolicy.offset_ms)) continue;
      candidates.push({
        kind: 'calendar', id: e.record_id, title: e.summary, anchor_at: e.start_at,
      });
    }
  }

  const taskPolicy = deps.policy('task');
  if (deps.listTasks && taskPolicy.enabled) {
    for (const t of deps.listTasks()) {
      // ⛔ A finished task is not a deadline. `done` is checked by the shared
      // classifier too, but skipping here keeps `tasks_visited` meaning "rows
      // that could have been reminded about".
      if (t.done || t.due_at === undefined) continue;
      result.tasks_visited += 1;
      const state = workOwedState(
        classifyTaskDueWindow(t, now, taskPolicy.offset_ms),
        t.due_at, now, taskPolicy.offset_ms,
      );
      if (state === null) continue;
      candidates.push({
        kind: 'task', id: t.id, title: t.title, anchor_at: t.due_at, state,
      });
    }
  }

  const commitmentPolicy = deps.policy('commitment');
  if (deps.listCommitments && commitmentPolicy.enabled) {
    for (const c of deps.listCommitments()) {
      // ⚠ Only a PENDING promise is owed a reminder — the same gate the
      // due-status sweep applies before it transitions a row. A kept or
      // released commitment with a past date is history, not a deadline.
      if (c.lifecycle_state !== 'pending') continue;
      if (c.promised_for_at === undefined) continue;
      result.commitments_visited += 1;
      const state = workOwedState(
        classifyCommitmentDueStatus(c, now, commitmentPolicy.offset_ms),
        c.promised_for_at, now, commitmentPolicy.offset_ms,
      );
      if (state === null) continue;
      candidates.push({
        kind: 'commitment', id: c.id, title: c.statement,
        anchor_at: c.promised_for_at, state,
      });
    }
  }

  for (const c of candidates) {
    const key = reminderMarkKey(c);
    if (deps.ledger.has(key)) continue;

    if (deps.isQuiet?.(now) ?? false) {
      // ⛔ HELD, AND THE MARK IS NOT SET. The reminder is deferred, not dropped:
      // the next sweep after the window sees the same row still owed and sends
      // it then. Setting the mark here would turn a hold into a loss — the same
      // distinction the task ledger draws in the due-status sweep.
      //
      // ⚠⚠ AND THIS NOW REACHES EVERY KIND, INCLUDING A BOOKING THAT STARTS
      // INSIDE THE WINDOW. That is what a master silencer means and it is the
      // owner's call: a 07:00 flight whose 2-hour reminder falls at 05:00 inside
      // a 22:00–08:00 window is NOT delivered before the flight. The release
      // digest still reports it as passed. Set the window to end earlier, or
      // switch quiet hours off, if that trade is wrong for you.
      result.held += 1;
      continue;
    }

    const when = new Date(c.anchor_at).toISOString();
    deps.notify({ title: reminderTitle(c), text: `${c.title} — ${when}` });
    deps.ledger.set(key, c.anchor_at);
    result.reminded += 1;
  }

  // ⚠ Pruned against the LONGEST horizon any kind can have, not a constant: a
  // mark must outlive its own reminder window or a row still inside the horizon
  // would be reminded about twice.
  const horizon = Math.max(
    bookingPolicy.offset_ms, calendarPolicy.offset_ms,
    taskPolicy.offset_ms, commitmentPolicy.offset_ms,
  );
  deps.ledger.prune(now - horizon);
  return result;
};
