/** D-325 §15.2 amendment — the words for a task under Due: its deadline as a person
 *  says it ("Overdue since Apr 1, 2027"), never the stored values the line used to
 *  print ("overdue · 2027-04-01 · pending"). */
import { calendarDayMs, isDateOnlyDue, type Commitment } from '@recued/contracts';

/** A whole day is stored as that day's UTC midnight (`calendarDayMs`), so it is read
 *  in UTC: in any zone west of UTC it would name the day before. An instant is read
 *  in local time. */
export const dueDayText = (ms: number, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', ...(isDateOnlyDue(ms) ? { timeZone: 'UTC' } : {}) }).format(ms);

/** A `YYYY-MM-DD` due day in words; text that names no day is shown as it came. */
export const dueOnText = (day: string, locale?: string): string => {
  const ms = calendarDayMs(day); return ms === null ? day : dueDayText(ms, locale);
};

// Keyed by string: a server newer than this client may send a state it does not know.
const CLOSED: Readonly<Record<string, string>> = { fulfilled: 'Done', cancelled: 'Cancelled', expired: 'Expired' };

const deadline = (status: string, day: string | null): string => {
  switch (status) {
    case 'overdue': return day ? `Overdue since ${day}` : 'Overdue';
    case 'due_soon': return day ? `Due soon, on ${day}` : 'Due soon';
    case 'not_due': return day ? `Due ${day}` : 'Not due yet';
    case 'no_deadline': return 'No deadline';
    // A status this client does not know yet: say it rather than guess.
    default: return `${status.replaceAll('_', ' ')}${day ? ` · ${day}` : ''}`;
  }
};

// Keyed by string: a pack's class may renew by a date field this client does not name.
const RENEWAL_DATES: Readonly<Record<string, string>> = { expires_on: 'New expiry date', renews_on: 'New renewal date', legal_check_on: 'Next legal check date' };

/** §15.7 (2026-10-24) — what Due asks an open renewal for: the date that replaces its own. */
export const renewalDateWords = (field: string): string => RENEWAL_DATES[field] ?? 'New date';

/** The first day a renewal's new date may be: the day after the one it replaces. */
export const dayAfter = (day: string): string | null => {
  const ms = calendarDayMs(day); return ms === null ? null : new Date(ms + 86_400_000).toISOString().slice(0, 10);
};

/** An open task says only its deadline; a closed one adds how it closed. */
export const taskDueWords = (task: Pick<Commitment, 'due_status' | 'promised_for_at' | 'lifecycle_state'>, locale?: string): string => {
  const words = deadline(task.due_status, task.promised_for_at === undefined ? null : dueDayText(task.promised_for_at, locale));
  return task.lifecycle_state === 'pending' ? words : `${words} · ${CLOSED[task.lifecycle_state] ?? task.lifecycle_state.replaceAll('_', ' ')}`;
};
