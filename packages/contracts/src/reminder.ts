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

/** A saved record lifetime, not a URL or permission to change the record. */
export interface ReminderRecordReference {
  kind: 'task' | 'commitment';
  id: string;
  source_id: string;
  source_record_id: string | null;
  created_at: number;
}
export const readReminderRecordReference = (value: unknown): ReminderRecordReference | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(v);
  if (row.kind !== 'task' && row.kind !== 'commitment' || !id(row.id) || !id(row.source_id)
    || row.source_record_id !== null && !id(row.source_record_id) || !Number.isSafeInteger(row.created_at) || (row.created_at as number) < 0) return;
  return { kind: row.kind, id: row.id, source_id: row.source_id, source_record_id: row.source_record_id as string | null, created_at: row.created_at as number };
};
export const sameReminderRecordReference = (first: ReminderRecordReference, second: ReminderRecordReference): boolean =>
  first.kind === second.kind && first.id === second.id && first.source_id === second.source_id
    && first.source_record_id === second.source_record_id && first.created_at === second.created_at;
/** Exact retained email in one enrollment of a mailbox. */
export interface ReminderMailReference {
  slug: string;
  record_id: string;
  source_id: string;
  received_at: number;
  incarnation: string;
}
export const readReminderMailReference = (value: unknown): ReminderMailReference | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const id = (v: unknown, limit: number): v is string => typeof v === 'string' && !!v.trim()
    && v.length <= limit && !/[\u0000-\u001f\u007f]/u.test(v);
  if (!id(row.slug, 256) || !id(row.record_id, 4096) || !id(row.source_id, 4096) || !id(row.incarnation, 256)
    || !Number.isSafeInteger(row.received_at) || (row.received_at as number) < 0 || (row.received_at as number) > 8.64e15) return;
  return { slug: row.slug, record_id: row.record_id, source_id: row.source_id,
    received_at: row.received_at as number, incarnation: row.incarnation };
};
export const sameReminderMailReference = (a: ReminderMailReference, b: ReminderMailReference): boolean =>
  a.slug === b.slug && a.record_id === b.record_id && a.source_id === b.source_id
    && a.received_at === b.received_at && a.incarnation === b.incarnation;
export const reminderMailReference = (slug: string, record: Pick<import('./collections.js').CollectionRecord,
  'record_id' | 'source_id' | 'received_at'>, incarnation: string | null | undefined): ReminderMailReference | undefined =>
  readReminderMailReference({ slug, record_id: record.record_id, source_id: record.source_id, received_at: record.received_at, incarnation });
export interface ReminderCreateRequest {
  text: string;
  at: number;
  creation_id: string;
  record_ref?: ReminderRecordReference;
  mail_ref?: ReminderMailReference;
}

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
  record_ref?: ReminderRecordReference;
  mail_ref?: ReminderMailReference;
  /** What to say, in the owner's words. */
  text: string;
  /** The instant it rings, epoch ms. */
  at: number;
  /** The owner's zone when it was set, so its time is worded back on the clock
   * it was asked on. Legacy rows may have null; their display uses the declared
   * server zone. */
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
  record_ref?: ReminderRecordReference;
  mail_ref?: ReminderMailReference;
  text: string;
  /** Epoch ms. */
  at: number;
  /** On the owner's clock: "Friday 16 October at 3:00 PM". */
  when: string;
  state: ReminderState;
  delivered_at: number | null;
  /** The resolved clock used by `when`, including the declared-zone fallback
   * for legacy stored reminders. Older servers may return null (UTC). */
  time_zone: string | null;
  /** The Yours clock owns this reminder's wording and schedule. */
  managed_by?: 'clock';
}

/** Why a reminder was not changed or cancelled. */
export type ReminderChangeReason = 'not_found' | 'not_pending';

export type ReminderSearchStatus = ReminderState | 'all';

/** Stable ascending position by scheduled instant, then reminder ID. */
export interface ReminderListCursor {
  at: number;
  reminder_id: string;
}

/** Search and date bounds apply before paging. Date bounds name instants. */
export interface ReminderListPageInput {
  query?: string;
  /** Match the exact saved record lifetime before counting and paging. */
  record_ref?: ReminderRecordReference;
  mail_ref?: ReminderMailReference;
  /** Retained delivered/cancelled rows only. Requires state 'all'. */
  history_only?: true;
  /** Explicit shared search scope. Omitted preserves the waiting-list contract. */
  state?: ReminderSearchStatus;
  from?: number;
  before?: number;
  cursor?: ReminderListCursor;
}

export interface ReminderListRequest {
  include_delivered?: boolean;
  limit?: number;
  /** Opt in to paging. Without an explicit state, only waiting reminders. */
  page?: ReminderListPageInput;
}

/** `core.reminder.list` and `reminder.list` answer with this. */
export interface ReminderListResult {
  /** The paired owner can create reminders with verified saved-record links. */
  record_links_supported?: true;
  mail_links_supported?: true;
  /** Scheduled time ascending. Still to ring unless page.state opts into history. */
  reminders: ReminderView[];
  /** How many wait in all. */
  count: number;
  /** Rung or cancelled in the last 30 days, most recent first — on request. */
  delivered?: ReminderView[];
  page?: {
    matched_count: number;
    next_cursor: ReminderListCursor | null;
    /** Confirms that the server searched this scope, including retained history.
     * Older servers omit it; clients must not call those results history search. */
    state?: ReminderSearchStatus;
    /** Acknowledges exact record filtering; older servers omit it. */
    record_ref?: ReminderRecordReference;
    mail_ref?: ReminderMailReference;
    history_only?: true;
  };
}

/** Exact retained reminder, independent of the waiting list's filters and pages. */
export interface ReminderGetResult {
  /** Null when the reminder is absent or its history has been pruned. */
  reminder: ReminderView | null;
}

/** The same creation receipt for a model-set reminder and an Automation alarm. */
export interface ReminderCreateResult {
  reminder: ReminderView;
  when: string;
  quiet_hours_note?: string;
  /** The chosen time and any quiet-hours delay, ready to show to the owner. */
  confirmation: string;
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

/** Legacy notification destination; still accepted for reminders already sent. */
export const REMINDER_LIST_LINK = '#data/reminder';

/** Reminder IDs are opaque, bounded tokens (the store generates rem_<uuid>). */
export const reminderDetailLink = (reminderId: string): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(reminderId)) throw new Error('Invalid reminder ID');
  return `${REMINDER_LIST_LINK}/${reminderId}`;
};

/** A narrow notification allowlist as well as the list/detail route parser. */
export const parseReminderLink = (link: unknown): { reminder_id: string | null } | null => {
  if (typeof link !== 'string') return null;
  const match = /^#data\/reminder(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(link);
  return match ? { reminder_id: match[1] ?? null } : null;
};

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

/** "3:00 PM" when `at` falls on `now`'s day on that clock, else
 *  "Friday 16 October at 3:00 PM": the day only when it is not today. */
export const formatReminderAt = (
  at: number,
  timeZone: string | null | undefined,
  now: number,
): string => {
  const zone = zoneOrUtc(timeZone);
  const a = dayParts(at, zone);
  const b = dayParts(now, zone);
  const sameDay = a.year === b.year && a.month === b.month && a.day === b.day;
  return sameDay ? formatReminderTime(at, zone) : formatReminderWhen(at, zone, now);
};

/** "Monday 28 September": the day a date-only due names (`due-day.ts`). That day
 *  is its UTC date, which no zone moves; only "this year" is the owner's clock's,
 *  as in `formatReminderWhen`. */
export const formatReminderDay = (
  day: number,
  timeZone: string | null | undefined,
  now: number,
): string => {
  const parts = dayParts(day, 'UTC');
  const year = parts.year !== dayParts(now, zoneOrUtc(timeZone)).year ? ` ${parts.year}` : '';
  return `${parts.weekday} ${parts.day} ${parts.month}${year}`;
};

/** The text a reminder rings with. On time it is the owner's own words; late, it
 *  says which time it was for (D-324 P5): "For 3:00 PM: meeting", or with the day
 *  when that was another day. */
export const reminderDeliveryText = (
  reminder: Pick<Reminder, 'text' | 'at' | 'time_zone'>,
  now: number,
): string => {
  if (now - reminder.at <= REMINDER_LATE_MS) return reminder.text;
  return `For ${formatReminderAt(reminder.at, reminder.time_zone, now)}: ${reminder.text}`;
};
