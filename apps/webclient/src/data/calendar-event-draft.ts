import { allDayEventDays, calendarDayMs, DAY_MS, CALENDAR_EVENT_EDIT_LIMITS, type CalendarEventDetails, type CalendarEventPatch } from '@recued/contracts';
import { calendarWallClockCandidates, calendarWallClockValue } from './calendar-wall-clock.js';

export type Field = 'summary' | 'description' | 'location' | 'start' | 'end' | 'startChoice' | 'endChoice';
export type CalendarEventDraft = Record<Field, string>;

export const calendarEventDraft = (event: CalendarEventDetails): CalendarEventDraft => {
  const days = event.is_all_day ? allDayEventDays(event) : null;
  return {
    // Native single-line inputs remove line breaks; preserve the original on
    // save when the owner has not changed their displayed value.
    summary: event.summary.replace(/[\r\n]/g, ''), location: event.location.replace(/[\r\n]/g, ''),
    description: event.description.replace(/\r\n?/g, '\n'),
    start: days?.first ?? calendarWallClockValue(event.start_at, event.timezone),
    end: days?.last ?? calendarWallClockValue(event.end_at, event.timezone),
    startChoice: String(event.start_at), endChoice: String(event.end_at),
  };
};

export const calendarEventPatch = (
  event: CalendarEventDetails, draft: CalendarEventDraft,
): { patch?: CalendarEventPatch; error?: string } => {
  const initial = calendarEventDraft(event);
  if (!draft.summary.trim()) return { error: 'Enter an event title.' };
  const patch: CalendarEventPatch = {};
  for (const key of ['summary', 'description', 'location'] as const) {
    // Unedited provider fields can exceed this form's write limits. Keeping
    // them intact must not prevent an edit to another supported field.
    if (draft[key] === initial[key]) continue;
    if (new TextEncoder().encode(draft[key]).length > CALENDAR_EVENT_EDIT_LIMITS[key]) {
      return { error: `${key === 'summary' ? 'Title' : key === 'description' ? 'Description' : 'Location'} is too long.` };
    }
    patch[key] = draft[key];
  }
  const readTime = (key: 'start' | 'end'): number | string => {
    const old = key === 'start' ? event.start_at : event.end_at;
    // Avoid dropping imported seconds/milliseconds, or changing the reading of
    // an unchanged ambiguous time, when only the title or description changes.
    if (draft[key] === initial[key] && (!draft[`${key}Choice`] || draft[`${key}Choice`] === String(old))) return old;
    if (event.is_all_day) {
      const day = calendarDayMs(draft[key]);
      return day === null ? 'Choose valid start and end dates.' : day + (key === 'end' ? DAY_MS : 0);
    }
    const candidates = calendarWallClockCandidates(draft[key], event.timezone);
    if (candidates.length === 0) return `Choose a valid ${key} time in ${event.timezone}. That time may fall in a daylight saving gap.`;
    if (candidates.length === 1) return candidates[0]!;
    const chosen = Number(draft[`${key}Choice`]);
    return draft[`${key}Choice`] !== '' && candidates.includes(chosen) ? chosen : `Choose which repeated ${key} time you mean.`;
  };
  const start = readTime('start'); const end = readTime('end');
  if (typeof start === 'string') return { error: start };
  if (typeof end === 'string') return { error: end };
  if (end <= start) return { error: event.is_all_day ? 'The last day must be on or after the first day.' : 'The end must be after the start.' };
  if (start !== event.start_at) patch.start_at = start;
  if (end !== event.end_at) patch.end_at = end;
  return { patch };
};

