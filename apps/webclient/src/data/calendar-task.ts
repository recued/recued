import { TASK_TITLE_MAX, type CalendarEventRef, type CalendarEventSnapshot } from '@recued/contracts';
import { calendarEventContextHref, selectedCalendarEventContext } from '../calendar/event-context.js';
import { calendarEventCopyText } from './calendar-event-actions.js';

const bounded = (value: string, limit: number): string => {
  let result = '';
  for (const character of value) { if (result.length + character.length > limit) break; result += character; }
  return result;
};

/** Quote the selected occurrence and retain its calendar-qualified address.
 * Provider UIDs are never guessed into canonical task relationships. */
export const calendarTaskValues = (ref: CalendarEventRef, snapshot: CalendarEventSnapshot, clientUrl: string): Record<string, unknown> => {
  const context = selectedCalendarEventContext(ref, snapshot);
  if (!context) throw new Error('This calendar event could not be confirmed. Refresh it before creating a task.');
  const event = snapshot.event, url = new URL(clientUrl);
  url.search = ''; url.username = ''; url.password = ''; url.hash = calendarEventContextHref(context);
  const notes = event.description.trim(), excerpt = bounded(notes, 600);
  const details = calendarEventCopyText({ ...event, summary: bounded(event.summary.trim(), TASK_TITLE_MAX),
    location: bounded(event.location, 300), conference_url: undefined });
  return { title: bounded(event.summary.trim() || 'Follow up on calendar event', TASK_TITLE_MAX), done: false, due_at: null,
    body: [`Calendar: ${bounded(context.calendarName, 256)}`, `Event: ${url.href}`, '', details,
      ...(snapshot.refresh_error ? ['', 'These are the last saved event details. Refresh the event to check them.'] : []),
      ...(notes ? ['', event.description_truncated || excerpt.length < notes.length ? 'Event notes (partial):' : 'Event notes:', excerpt] : [])].join('\n') };
};
