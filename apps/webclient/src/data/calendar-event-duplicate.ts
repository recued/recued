import { allDayEventDays, calendarDayMs, DAY_MS, CALENDAR_EVENT_EDIT_LIMITS,
  type CalendarEventRef, type CalendarEventSnapshot } from '@recued/contracts';
import { readSelectedCalendarEventContext, selectedCalendarEventContext, type SelectedCalendarEventContext } from '../calendar/event-context.js';
import { calendarWallClockCandidates, calendarWallClockValue } from './calendar-event-surface.js';
import type { CalendarCreateDraft } from './calendar-create-surface.js';

/** Only the source address and span accompany recovery, never provider IDs,
 * invitation responses or a second copy of the source body. */
export interface CalendarDuplicateOrigin {
  context: SelectedCalendarEventContext;
  spanMs: number;
  allDay: boolean;
  keepDuration: boolean;
}
export interface CalendarDuplicateSeed {
  origin: CalendarDuplicateOrigin;
  summary: string;
  description: string;
  location: string;
  zone: string;
}
export const readCalendarDuplicateOrigin = (value: unknown): CalendarDuplicateOrigin | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>, context = readSelectedCalendarEventContext(row.context);
  if (!context || Object.keys(row).some(key => !['context', 'spanMs', 'allDay', 'keepDuration'].includes(key))
    || typeof row.spanMs !== 'number' || !Number.isSafeInteger(row.spanMs) || row.spanMs <= 0 || row.spanMs > 8.64e15
    || typeof row.allDay !== 'boolean' || row.allDay && row.spanMs % DAY_MS !== 0 || typeof row.keepDuration !== 'boolean') return null;
  return { context, spanMs: row.spanMs, allDay: row.allDay, keepDuration: row.keepDuration };
};

export const calendarDuplicateSeed = (ref: CalendarEventRef, snapshot: CalendarEventSnapshot): CalendarDuplicateSeed => {
  const context = selectedCalendarEventContext(ref, snapshot), event = snapshot.event;
  if (!context) throw new Error('This event could not be confirmed. Reopen it from Calendar.');
  if (snapshot.refresh_error) throw new Error('The original event could not be refreshed. Review its saved details before copying.');
  if (event.description_truncated) throw new Error('The original event’s full notes are unavailable. Refresh it before copying.');
  const origin = readCalendarDuplicateOrigin({ context, spanMs: event.end_at - event.start_at, allDay: event.is_all_day, keepDuration: true });
  if (!origin || !Number.isSafeInteger(event.start_at) || !Number.isSafeInteger(event.end_at)
    || Math.abs(event.start_at) > 8.64e15 || Math.abs(event.end_at) > 8.64e15
    || event.is_all_day && !allDayEventDays(event)) throw new Error('The original event’s time span could not be confirmed.');
  try { new Intl.DateTimeFormat('en', { timeZone: event.timezone }); }
  catch { throw new Error('The original event’s time zone is unavailable.'); }
  const summary = event.summary.replace(/[\r\n]+/g, ' ');
  const fields = { summary: summary.trim() ? summary : 'Untitled event',
    description: event.description.replace(/\r\n?/g, '\n'), location: event.location.replace(/[\r\n]+/g, ' ') };
  for (const key of ['summary', 'description', 'location'] as const)
    if (new TextEncoder().encode(fields[key]).length > CALENDAR_EVENT_EDIT_LIMITS[key])
      throw new Error('The original event’s details exceed this form’s limits. Start a new event and copy the details you need.');
  return { origin, ...fields, zone: event.timezone };
};

export const calendarDuplicateSpanLabel = (origin: CalendarDuplicateOrigin): string => {
  if (origin.allDay) { const days = origin.spanMs / DAY_MS; return `${days} ${days === 1 ? 'day' : 'days'}`; }
  const hours = Math.floor(origin.spanMs / 3_600_000), minutes = Math.floor(origin.spanMs % 3_600_000 / 60_000), seconds = origin.spanMs % 60_000 / 1000;
  return [hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '', minutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : '',
    seconds ? `${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : ''].filter(Boolean).join(' ');
};

/** Shift the end only while the owner keeps the original span. Timed copies
 * preserve elapsed duration through DST, including seconds and milliseconds. */
export const calendarDuplicateEnd = (draft: CalendarCreateDraft, zone: string, origin: CalendarDuplicateOrigin): { end: string; endChoice: string } | null => {
  if (!origin.keepDuration || draft.allDay !== origin.allDay) return null;
  try {
    if (draft.allDay) {
      const start = calendarDayMs(draft.start);
      if (start === null) return null;
      const end = new Date(start + origin.spanMs - DAY_MS).toISOString().slice(0, 10);
      return calendarDayMs(end) === null ? null : { end, endChoice: '' };
    }
    const candidates = calendarWallClockCandidates(draft.start, zone);
    const start = candidates.length === 1 ? candidates[0]! : candidates.find(at => String(at) === draft.startChoice);
    if (start === undefined) return null;
    const at = start + origin.spanMs;
    const precision = at % 1000 ? 'millisecond' : at % 60_000 ? 'second' : 'minute';
    const end = calendarWallClockValue(at, zone, precision);
    return end ? { end, endChoice: String(at) } : null;
  } catch { return null; }
};
