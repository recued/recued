/** D-324 — a reminder is its own record: "tell me at T", rung once, then over.
 *
 *  ⛔ NOT A TASK. D-193 kept reminders as `data.task` rows, and the task-ness cost
 *  the owner three ways (D-324 §2): D-269 reminded them about it as a deadline
 *  ("due soon" a day early, "overdue" after it rang), it sat in Tasks and Today
 *  as open work forever, and its "delivered" mark was a task write a background
 *  run had to ask about. Work with progress stays a task with a due date; a point
 *  in time is this.
 *
 *  The wording helpers live here so the server's confirmation, the delivered
 *  notification and the webclient's list say a time the same way: the day in
 *  words and the time on the owner's clock, never UTC (D-324 P8). */

/** `pending` waits for its time; `delivered` reached at least one channel;
 *  `cancelled` was withdrawn by the owner before it rang. */
export const REMINDER_STATES = ['pending', 'delivered', 'cancelled'] as const;
export type ReminderState = (typeof REMINDER_STATES)[number];

const REMINDER_STATE_SET: ReadonlySet<string> = new Set(REMINDER_STATES);
export const isReminderState = (value: unknown): value is ReminderState =>
  typeof value === 'string' && REMINDER_STATE_SET.has(value);

/** Where a reminder was asked. Engine-stamped from the run, never from a step's
 *  own args: a recipe cannot say it was set somewhere it was not. */
export interface ReminderOrigin {
  /** The run's channel (`chat`, `messenger`, `mcp`, `manual`, `reactive`, …). */
  channel?: string;
  /** The messenger or mailbox kind, when there is one (`email`, `slack`, …). */
  vendor?: string;
  /** The recipe whose step set it. */
  recipe_id?: string;
}

export interface Reminder {
  reminder_id: string;
  /** What to say, in the owner's words. */
  text: string;
  /** The instant it rings, epoch ms. */
  at: number;
  /** The owner's zone when it was set, so its time is worded back on the clock
   *  it was asked on. `null` when no zone resolved (UTC is used). */
  time_zone: string | null;
  origin: ReminderOrigin;
  /** Built-in clock service correlation. Ordinary reminder ops cannot supply
   * this; the managed ask owns delivery instead of the generic minute sender. */
  clock?: { occurrence_id: string; point_key: string; ask_id: string };
  state: ReminderState;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  /** The channels that took it. */
  delivered_to: string[];
  /** Sends tried, the one that got through included. */
  attempts: number;
}

/** A reminder as the `core.reminder.*` ops answer with it: its time worded on
 *  the owner's clock beside the instant, so a model repeating it converts
 *  nothing. */
export interface ReminderView {
  reminder_id: string;
  text: string;
  /** Epoch ms. */
  at: number;
  /** On the owner's clock: "Friday 16 October at 3:00 PM". */
  when: string;
  state: ReminderState;
  delivered_at: number | null;
  /** The clock `when` is worded on, so a screen changing the time edits it on
   *  the same clock. `null` ⇒ UTC. */
  time_zone: string | null;
}

/** Why a reminder was not changed or cancelled. */
export type ReminderChangeReason = 'not_found' | 'not_pending';

/** `core.reminder.list` and `reminder.list` answer with this. */
export interface ReminderListResult {
  /** Still to ring, soonest first. */
  reminders: ReminderView[];
  /** How many wait in all. */
  count: number;
  /** Rung or cancelled in the last 30 days, most recent first — on request. */
  delivered?: ReminderView[];
}

/** `core.reminder.update` and `reminder.update` answer with this. */
export interface ReminderUpdateResult {
  updated: boolean;
  reason?: ReminderChangeReason;
  reminder?: ReminderView;
  when?: string;
  quiet_hours_note?: string;
  /** What happened, in a line for the owner. */
  message: string;
}

/** `core.reminder.cancel` and `reminder.cancel` answer with this. */
export interface ReminderCancelResult {
  cancelled: boolean;
  reason?: ReminderChangeReason;
  reminder?: ReminderView;
  /** What happened, in a line for the owner. */
  message: string;
}

/** ⛔ The most reminders that may wait at once (D-324 P6). Creating one is `read`
 *  tier, the tier of `core.notification.send`, so a recipe running on its own
 *  can set one without asking; the cap is what bounds a runaway recipe. */
export const REMINDER_PENDING_MAX = 200;

/** The longest reminder text. A reminder is a line, not a document. */
export const REMINDER_TEXT_MAX = 500;

/** How long a delivered or cancelled reminder is kept, for "did I set that?"
 *  (D-324 P3). Pruned after. */
export const REMINDER_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

/** A reminder rung this much after its time says which time it was for
 *  (D-324 P5): the server was off, or quiet hours held it. */
export const REMINDER_LATE_MS = 5 * 60 * 1000;

/** How far in the past a new reminder's time may be and still be set: the time
 *  a model took to call the tool. It rings at the next check. */
export const REMINDER_PAST_GRACE_MS = 2 * 60 * 1000;

/** The link a delivered reminder carries: the upcoming list. */
export const REMINDER_LIST_LINK = '#data/reminder';

const zoneOrUtc = (timeZone: string | null | undefined): string => {
  if (typeof timeZone === 'string' && timeZone.length > 0) {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone }).format(0);
      return timeZone;
    } catch {
      // An unknown zone words the time in UTC rather than throwing.
    }
  }
  return 'UTC';
};

const dayParts = (at: number, timeZone: string): { weekday: string; day: string; month: string; year: string } => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone,
  }).formatToParts(new Date(at));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { weekday: part('weekday'), day: part('day'), month: part('month'), year: part('year') };
};

/** "3:00 PM" on the owner's clock. */
export const formatReminderTime = (at: number, timeZone: string | null | undefined): string =>
  new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: zoneOrUtc(timeZone),
  }).format(new Date(at)).replace(/[  ]/gu, ' ');

/** "Friday 16 October at 3:00 PM", with the year when it is not this year's.
 *  `now` decides "this year", on the same clock. */
export const formatReminderWhen = (
  at: number,
  timeZone: string | null | undefined,
  now: number,
): string => {
  const zone = zoneOrUtc(timeZone);
  const day = dayParts(at, zone);
  const year = day.year !== dayParts(now, zone).year ? ` ${day.year}` : '';
  return `${day.weekday} ${day.day} ${day.month}${year} at ${formatReminderTime(at, zone)}`;
};

/** The text a reminder rings with. On time it is the owner's own words; late, it
 *  says which time it was for (D-324 P5): "For 3:00 PM: meeting", or with the day
 *  when that was another day. */
export const reminderDeliveryText = (
  reminder: Pick<Reminder, 'text' | 'at' | 'time_zone'>,
  now: number,
): string => {
  if (now - reminder.at <= REMINDER_LATE_MS) return reminder.text;
  const zone = zoneOrUtc(reminder.time_zone);
  const sameDay = (() => {
    const a = dayParts(reminder.at, zone);
    const b = dayParts(now, zone);
    return a.year === b.year && a.month === b.month && a.day === b.day;
  })();
  const when = sameDay ? formatReminderTime(reminder.at, zone) : formatReminderWhen(reminder.at, zone, now);
  return `For ${when}: ${reminder.text}`;
};
